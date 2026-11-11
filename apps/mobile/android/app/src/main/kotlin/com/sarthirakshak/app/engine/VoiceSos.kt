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
import org.json.JSONObject
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
    fun normalise(phrase: String) = phrase.trim().lowercase().replace(Regex("[^\\p{L}\\p{M}\\p{N} ]"), "").replace(Regex("\\s+"), " ")

    private fun grammar(phrase: String) = JSONArray().put(normalise(phrase)).put("[unk]").toString()

    private fun matches(json: String, phrase: String): Boolean {
        val text = try {
            JSONObject(json).optString("text", JSONObject(json).optString("partial"))
        } catch (e: Exception) {
            ""
        }
        return text.isNotBlank() && normalise(text) == normalise(phrase)
    }

    /** Starts listening (journey only). Returns false if the model or microphone is missing. */
    fun start(context: Context, lang: String, phrase: String, onHeard: () -> Unit, onStopped: (String) -> Unit): Boolean {
        stop()
        if (!micAllowed(context) || !hasModel(context, lang) || phrase.isBlank()) return false
        return try {
            val recognizer = Recognizer(loadModel(context, lang), 16000.0f, grammar(phrase))
            service = SpeechService(recognizer, 16000.0f).also {
                it.startListening(object : RecognitionListener {
                    override fun onPartialResult(hypothesis: String?) {}
                    override fun onResult(hypothesis: String?) {
                        if (hypothesis != null && matches(hypothesis, phrase)) onHeard()
                    }
                    override fun onFinalResult(hypothesis: String?) {
                        if (hypothesis != null && matches(hypothesis, phrase)) onHeard()
                    }
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

    fun stop() {
        service?.stop()
        service?.shutdown()
        service = null
    }

    val listening get() = service != null

    /**
     * "Test my phrase" / setup: listens up to [seconds] and calls [done] with true when the phrase
     * was heard. Only used while the app screen is open.
     */
    fun test(context: Context, lang: String, phrase: String, seconds: Int, done: (Boolean) -> Unit) {
        var finished = false
        val finish = { ok: Boolean ->
            if (!finished) {
                finished = true
                stop()
                done(ok)
            }
        }
        val ok = start(context, lang, phrase, onHeard = { finish(true) }, onStopped = { finish(false) })
        if (!ok) return finish(false)
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ finish(false) }, seconds * 1000L)
    }
}
