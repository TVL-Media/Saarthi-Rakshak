package com.sarthirakshak.app.engine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService

/**
 * Voice SOS (feature 2): during an active journey the phone listens for the user's own phrase.
 * Everything happens on the phone (Vosk, offline): audio never leaves it and nothing is saved.
 * The recognizer only knows the phrase (a grammar), so other speech is ignored.
 */
object VoiceSos {
    private const val TAG = "SafetyEngine"

    /** Small offline models (downloaded once, when the user turns Voice SOS on). */
    val MODELS = mapOf(
        "en" to "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip",
        "hi" to "https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip",
    )

    private var model: Model? = null
    private var modelLang: String? = null
    private var service: SpeechService? = null

    fun modelDir(context: Context, lang: String) = File(context.filesDir, "vosk-$lang")

    fun hasModel(context: Context, lang: String) = File(modelDir(context, lang), "am").exists() ||
        modelDir(context, lang).listFiles()?.any { File(it, "am").exists() } == true

    fun micAllowed(context: Context) =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Downloads and unpacks the model (about 40 MB). Call on a background thread. */
    fun download(context: Context, lang: String, progress: (Int) -> Unit) {
        val url = MODELS[lang] ?: throw IllegalArgumentException("Unknown language")
        val dir = modelDir(context, lang)
        val tmp = File(context.cacheDir, "vosk-$lang.zip")
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        val total = conn.contentLengthLong.coerceAtLeast(1)
        conn.inputStream.use { input ->
            tmp.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    progress(((done * 100) / total).toInt().coerceIn(0, 99))
                }
            }
        }
        dir.deleteRecursively()
        dir.mkdirs()
        ZipInputStream(tmp.inputStream()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                // Drop the top folder of the zip; refuse paths that leave the folder.
                val name = entry.name.substringAfter('/', "")
                if (name.isEmpty() || name.contains("..")) continue
                val f = File(dir, name)
                if (entry.isDirectory) f.mkdirs() else {
                    f.parentFile?.mkdirs()
                    f.outputStream().use { zip.copyTo(it) }
                }
            }
        }
        tmp.delete()
        progress(100)
    }

    private fun loadModel(context: Context, lang: String): Model {
        if (model != null && modelLang == lang) return model!!
        model?.close()
        model = Model(modelDir(context, lang).absolutePath)
        modelLang = lang
        return model!!
    }

    /** The phrase in lower case, for the grammar and matching. */
    fun normalise(phrase: String) = VoiceMatch.normalise(phrase)

    private fun grammar(phrase: String) = JSONArray().put(normalise(phrase)).put("[unk]").toString()

    /**
     * The phrase words the model knows: Vosk leaves unknown words out of its results, so only
     * these can be heard. All of them must come, in order (see [VoiceMatch]).
     */
    private fun wantedWords(model: Model, phrase: String): List<String> {
        val unknown = unknownWords(model, phrase).toSet()
        return VoiceMatch.words(phrase).filter { it !in unknown }
    }

    /** Restarts the journey listening after a setup test used the microphone (null: none). */
    private var resumeJourney: (() -> Unit)? = null

    /** vosk_model_find_word is in libvosk but not in the Java wrapper: called through JNA. */
    private interface VoskWords : com.sun.jna.Library {
        fun vosk_model_find_word(model: com.sun.jna.Pointer, word: String): Int
    }

    private val voskWords: VoskWords? by lazy {
        try {
            com.sun.jna.Native.load("vosk", VoskWords::class.java)
        } catch (e: Throwable) {
            Log.w(TAG, "vosk_model_find_word not available", e)
            null
        }
    }

    /**
     * Words of the phrase the loaded model does not know (e.g. "sarthi" in the English model).
     * Empty if it cannot be checked.
     */
    private fun unknownWords(model: Model, phrase: String): List<String> {
        val lib = voskWords ?: return emptyList()
        val pointer = model.pointer ?: return emptyList()
        return normalise(phrase).split(' ').filter {
            it.isNotEmpty() && try {
                lib.vosk_model_find_word(pointer, it) < 0
            } catch (e: Throwable) {
                false
            }
        }
    }

    /** Starts listening during a journey. Returns false if the model or microphone is missing. */
    fun start(context: Context, lang: String, phrase: String, onHeard: () -> Unit, onStopped: (String) -> Unit): Boolean {
        stop()
        val ok = listen(context, lang, phrase, onHeard, onStopped)
        // Kept so a setup test (which needs the microphone) can hand it back afterwards.
        if (ok) resumeJourney = { listen(context, lang, phrase, onHeard, onStopped) }
        return ok
    }

    private fun listen(context: Context, lang: String, phrase: String, onHeard: () -> Unit, onStopped: (String) -> Unit): Boolean {
        stopListening()
        if (!micAllowed(context) || !hasModel(context, lang) || phrase.isBlank()) return false
        return try {
            val model = synchronized(this) { loadModel(context, lang) }
            val wanted = wantedWords(model, phrase).ifEmpty { VoiceMatch.words(phrase) }
            val recognizer = Recognizer(model, 16000.0f, grammar(phrase))
            // One SOS per utterance: a phrase seen in a partial result and again in the final
            // result must not open the countdown twice.
            var firedThisUtterance = false
            fun check(hypothesis: String?, endOfUtterance: Boolean) {
                val match = hypothesis != null && VoiceMatch.heard(VoiceMatch.textOf(hypothesis), wanted)
                if (match && !firedThisUtterance) {
                    firedThisUtterance = true
                    onHeard()
                }
                if (endOfUtterance) firedThisUtterance = false
            }
            service = SpeechService(recognizer, 16000.0f).also {
                it.startListening(object : RecognitionListener {
                    // Checked while the user is still speaking: no need to wait for a pause,
                    // which may come late (or never) in a noisy place.
                    override fun onPartialResult(hypothesis: String?) = check(hypothesis, endOfUtterance = false)
                    override fun onResult(hypothesis: String?) = check(hypothesis, endOfUtterance = true)
                    override fun onFinalResult(hypothesis: String?) = check(hypothesis, endOfUtterance = true)
                    override fun onError(exception: Exception?) {
                        Log.w(TAG, "Voice SOS stopped", exception)
                        onStopped("error")
                    }
                    override fun onTimeout() {}
                })
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "Voice SOS could not start", e)
            false
        }
    }

    /** Stops listening for the journey (journey ended, SOS started or Voice SOS turned off). */
    fun stop() {
        resumeJourney = null
        stopListening()
    }

    private fun stopListening() {
        service?.stop()
        service?.shutdown()
        service = null
    }

    /**
     * Loads the voice model ahead of a setup test, so the microphone is on as soon as the screen
     * says "say it now". Call on a background thread. False if the model is missing or damaged.
     */
    fun prepare(context: Context, lang: String): Boolean {
        if (!hasModel(context, lang)) return false
        return try {
            synchronized(this) { loadModel(context, lang) }
            true
        } catch (e: Exception) {
            Log.w(TAG, "Voice model could not load", e)
            false
        }
    }

    val listening get() = service != null

    /**
     * "Test my phrase" / setup: listens up to [seconds] and calls [done] with true when the phrase
     * was heard. Only used while the app screen is open.
     */
    fun test(context: Context, lang: String, phrase: String, seconds: Int, done: (String) -> Unit) {
        val main = android.os.Handler(android.os.Looper.getMainLooper())
        var finished = false
        fun finish(status: String) {
            main.post {
                if (!finished) {
                    finished = true
                    stopListening()
                    // A journey was listening before the test: give it the microphone back.
                    resumeJourney?.let { resume -> resume() }
                    done(status)
                }
            }
        }
        when {
            !micAllowed(context) -> return finish("no_mic")
            !hasModel(context, lang) -> return finish("no_model")
            phrase.isBlank() -> return finish("no_phrase")
        }
        // Loading the model takes a moment: never on the main thread.
        Thread {
            val loaded = try {
                synchronized(this) { loadModel(context, lang) }
            } catch (e: Exception) {
                Log.w(TAG, "Voice model could not load", e)
                return@Thread finish("no_model")
            }
            val unknown = unknownWords(loaded, phrase)
            val words = normalise(phrase).split(' ').filter { it.isNotEmpty() }
            // At least 2 words the model knows, so a single common word never starts an SOS.
            if (unknown.isNotEmpty() && words.size - unknown.size < 2) return@Thread finish("unknown:" + unknown.joinToString(" "))
            main.post {
                if (finished) return@post
                val ok = listen(context, lang, phrase, onHeard = { finish("heard") }, onStopped = { finish("error") })
                if (!ok) finish("error") else main.postDelayed({ finish("not_heard") }, seconds * 1000L)
            }
        }.start()
    }
}
