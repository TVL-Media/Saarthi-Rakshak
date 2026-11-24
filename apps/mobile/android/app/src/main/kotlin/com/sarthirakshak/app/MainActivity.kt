package com.sarthirakshak.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.location.Address
import android.location.Geocoder
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.ContactsContract
import android.provider.Settings
import com.sarthirakshak.app.engine.Alerts
import com.sarthirakshak.app.engine.Crypto
import com.sarthirakshak.app.engine.EngineBus
import com.sarthirakshak.app.engine.FakeCallService
import com.sarthirakshak.app.engine.LocalClips
import com.sarthirakshak.app.engine.Outbox
import com.sarthirakshak.app.engine.SafetyService
import com.sarthirakshak.app.engine.Store
import com.sarthirakshak.app.engine.ShakeLogic
import com.sarthirakshak.app.engine.Vault
import com.sarthirakshak.app.engine.VoiceSos
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.ContentValues
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Environment
import android.os.StatFs
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

/** Hosts the Flutter screens and the bridge (MethodChannel "sarthi/engine") to the safety engine. */
class MainActivity : FlutterFragmentActivity() {
    private var player: MediaPlayer? = null
    private var ringtone: Ringtone? = null

    /** Waiting answer for "pickContact" (the system contact picker; no contacts permission needed). */
    private var pickResult: MethodChannel.Result? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Alerts.channels(this)
        handleIntent(intent)
        // Carry on with an SOS or journey that was running (e.g. after the app was closed).
        if (SafetyService.hasWork(this)) {
            try {
                SafetyService.send(this, SafetyService.ACTION_RESUME)
            } catch (e: Exception) {
                // ignored: started again on the next action
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE) {
            handleShare(intent)
            return
        }
        val action = intent?.getStringExtra(EXTRA_ACTION) ?: return
        val data = HashMap<String, Any?>()
        data["action"] = action
        intent.getStringExtra(EXTRA_TRIGGER)?.let { data["trigger"] = it }
        for (key in listOf("checkinId", "reason", "journeyId", "quiet", "seconds", "heightM", "caller", "answered")) {
            intent.getStringExtra(key)?.let { data[key] = it }
        }
        intent.removeExtra(EXTRA_ACTION)
        if (EngineBus.sink != null) EngineBus.emit("launch", data) else EngineBus.pendingLaunch = data
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val messenger = flutterEngine.dartExecutor.binaryMessenger
        EventChannel(messenger, "sarthi/engine/events").setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
                EngineBus.sink = events
            }

            override fun onCancel(arguments: Any?) {
                EngineBus.sink = null
            }
        })
        MethodChannel(messenger, "sarthi/engine").setMethodCallHandler { call, result ->
            try {
                val store = Store(this)
                when (call.method) {
                    "setSession" -> {
                        store.apiUrl = call.argument<String>("apiUrl")
                        store.token = call.argument<String>("token")
                        store.userName = call.argument<String>("userName") ?: "Someone"
                        result.success(null)
                    }
                    "clearSession" -> {
                        store.clearSession()
                        // Recordings are private: nobody who logs in next on this phone may hear them.
                        LocalClips.dir(this).deleteRecursively()
                        // The vault key leaves this phone too (evidence stays encrypted; the
                        // recovery phrase brings it back).
                        Vault.forget(this)
                        File(cacheDir, "vault").deleteRecursively()
                        File(cacheDir, "shared").deleteRecursively()
                        Outbox(this).clearDaily()
                        result.success(null)
                    }
                    "listClips" -> {
                        val clips = LocalClips.list(this, call.argument<String>("sosId"))
                        result.success(clips.map { c ->
                            mapOf(
                                "id" to c.optString("id"),
                                "sosId" to c.optString("sosId"),
                                "recordedAt" to c.optLong("recordedAt"),
                                "seconds" to c.optInt("seconds"),
                                "uploaded" to c.optBoolean("uploaded"),
                            )
                        })
                    }
                    "playClip" -> {
                        val file = LocalClips.file(this, call.argument<String>("id")!!)
                        if (!file.exists()) {
                            result.error("not_found", "This recording is no longer on the phone.", null)
                        } else {
                            playEncrypted(file.readBytes())
                            result.success(null)
                        }
                    }
                    "exportClip" -> {
                        // An SOS recording, decrypted into the private cache so the vault can
                        // encrypt it with the vault key (the cache copy is deleted right after).
                        val file = LocalClips.file(this, call.argument<String>("id")!!)
                        if (!file.exists()) {
                            result.success(null)
                        } else {
                            val out = File(File(cacheDir, "vault").apply { mkdirs() }, "${call.argument<String>("id")}.m4a")
                            out.writeBytes(Crypto.decrypt(Crypto.AUDIO_KEY, file.readBytes()))
                            result.success(out.absolutePath)
                        }
                    }
                    "cacheGuardians" -> {
                        val list = call.argument<List<Map<String, Any?>>>("guardians") ?: emptyList()
                        store.guardians = JSONArray(list.map { JSONObject(it) })
                        result.success(null)
                    }
                    "startSos" -> {
                        val args = JSONObject(call.arguments as Map<*, *>)
                        SafetyService.send(this, SafetyService.ACTION_START_SOS, mapOf("args" to args.toString()))
                        result.success(null)
                    }
                    "endSos" -> {
                        SafetyService.send(this, SafetyService.ACTION_END_SOS, mapOf("sosId" to (call.argument<String>("sosId") ?: "")))
                        result.success(null)
                    }
                    "startJourney" -> {
                        val args = JSONObject(call.arguments as Map<*, *>)
                        SafetyService.send(this, SafetyService.ACTION_START_JOURNEY, mapOf("args" to args.toString()))
                        result.success(null)
                    }
                    "stopJourney" -> {
                        SafetyService.send(this, SafetyService.ACTION_STOP_JOURNEY)
                        result.success(null)
                    }
                    "checkinAnswered" -> {
                        val args = JSONObject(call.arguments as Map<*, *>)
                        SafetyService.send(this, SafetyService.ACTION_CHECKIN_ANSWER, mapOf("args" to args.toString()))
                        result.success(null)
                    }
                    "previewCheckin" -> {
                        EngineBus.emit("checkin", mapOf("reason" to "stopped", "preview" to true))
                        result.success(null)
                    }
                    "getState" -> result.success(EngineBus.lastState)
                    "resume" -> {
                        // Back from the settings screen: start what is now allowed (audio, location).
                        if (SafetyService.hasWork(this)) SafetyService.send(this, SafetyService.ACTION_RESUME)
                        result.success(null)
                    }
                    "takeLaunchAction" -> {
                        val pending = EngineBus.pendingLaunch
                        EngineBus.pendingLaunch = null
                        result.success(pending)
                    }
                    "deviceInfo" -> result.success(deviceInfo())
                    "batteryOptimisationOff" -> {
                        val pm = getSystemService(PowerManager::class.java)
                        result.success(pm.isIgnoringBatteryOptimizations(packageName))
                    }
                    "askBatteryOptimisationOff" -> {
                        try {
                            @Suppress("BatteryLife")
                            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                        } catch (e: Exception) {
                            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                        }
                        result.success(null)
                    }
                    "playEncrypted" -> {
                        playEncrypted(call.argument<ByteArray>("bytes")!!)
                        result.success(null)
                    }
                    "stopPlayback" -> {
                        stopPlayback()
                        result.success(null)
                    }
                    "startRingtone" -> {
                        ringtone?.stop()
                        ringtone = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))?.apply {
                            audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
                            play()
                        }
                        result.success(null)
                    }
                    "geocodeSearch" -> {
                        val query = call.argument<String>("query") ?: ""
                        geocode(result) { g ->
                            // Within India only (bounding box), best matches first.
                            @Suppress("DEPRECATION")
                            g.getFromLocationName(query, 6, 6.5, 68.0, 37.5, 97.5).orEmpty().map { a -> addressMap(a) }
                        }
                    }
                    "geocodeReverse" -> {
                        val lat = call.argument<Double>("lat")!!
                        val lng = call.argument<Double>("lng")!!
                        geocode(result) { g ->
                            @Suppress("DEPRECATION")
                            g.getFromLocation(lat, lng, 1).orEmpty().firstOrNull()?.let { a -> addressMap(a) }
                        }
                    }
                    "vibrate" -> {
                        vibrate(call.argument<Int>("ms") ?: 400)
                        result.success(null)
                    }
                    "stopRingtone" -> {
                        ringtone?.stop()
                        ringtone = null
                        result.success(null)
                    }
                    "scheduleFakeCall" -> {
                        FakeCallService.schedule(this, call.argument<String>("caller") ?: "Mom", call.argument<Int>("delaySeconds") ?: 5)
                        result.success(null)
                    }
                    "cancelFakeCall" -> {
                        FakeCallService.cancel(this)
                        result.success(null)
                    }
                    "pickContact" -> {
                        pickResult?.success(null) // an older picker that never answered
                        pickResult = result
                        try {
                            @Suppress("DEPRECATION")
                            startActivityForResult(
                                Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI),
                                PICK_CONTACT,
                            )
                        } catch (e: ActivityNotFoundException) {
                            pickResult = null
                            result.success(null)
                        }
                    }
                    else -> if (!phase2(call, result)) result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("engine_error", e.message, null)
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != PICK_CONTACT) return
        val result = pickResult ?: return
        pickResult = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) return result.success(null)
        try {
            // The picker grants read access to this one row only.
            contentResolver.query(
                uri,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER,
                ),
                null,
                null,
                null,
            )?.use { c ->
                if (c.moveToFirst()) {
                    return result.success(mapOf("name" to (c.getString(0) ?: ""), "phone" to (c.getString(1) ?: "")))
                }
            }
            result.success(null)
        } catch (e: Exception) {
            result.success(null)
        }
    }

    /**
     * Android Share → Sarthi Rakshak (feature 15): copies the shared files into the app's private
     * cache so the vault can encrypt them. Nothing is read from other apps by itself.
     */
    private fun handleShare(intent: Intent) {
        val uris = ArrayList<Uri>()
        @Suppress("DEPRECATION")
        if (intent.action == Intent.ACTION_SEND) {
            (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
        } else {
            intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
        }
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val dir = File(cacheDir, "shared").apply { mkdirs() }
        val files = ArrayList<Map<String, Any?>>()
        for (uri in uris.take(20)) {
            try {
                var name = "shared"
                contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) name = c.getString(0) ?: name
                }
                val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(80)
                val out = File(dir, "${System.currentTimeMillis()}-$safe")
                contentResolver.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } }
                files.add(mapOf("path" to out.absolutePath, "name" to name, "mime" to (contentResolver.getType(uri) ?: "application/octet-stream")))
            } catch (e: Exception) {
                // a file that could not be read is skipped
            }
        }
        val data = HashMap<String, Any?>()
        data["action"] = "share"
        data["files"] = files
        if (text != null) data["text"] = text
        intent.action = null
        if (EngineBus.sink != null) EngineBus.emit("launch", data) else EngineBus.pendingLaunch = data
    }

    private fun phase2(call: io.flutter.plugin.common.MethodCall, result: MethodChannel.Result): Boolean {
        val store = Store(this)
        when (call.method) {
            "engineConfig" -> {
                call.argument<String>("triggers")?.let { store.triggers = JSONObject(it) }
                call.argument<String>("daily")?.let { store.daily = JSONObject(it) }
                if (SafetyService.hasWork(this) || store.sos != null || store.journey != null) {
                    SafetyService.send(this, SafetyService.ACTION_CONFIG)
                }
                result.success(null)
            }
            "dailyClear" -> {
                // Location history deleted on the server: drop points still waiting on the phone too.
                Outbox(this).clearDaily()
                result.success(null)
            }
            "voiceHasModel" -> result.success(VoiceSos.hasModel(this, call.argument<String>("lang") ?: "en"))
            "voiceDownload" -> {
                val lang = call.argument<String>("lang") ?: "en"
                Thread {
                    try {
                        VoiceSos.download(this, lang) { p -> runOnUiThread { EngineBus.emit("voiceDownload", mapOf("progress" to p)) } }
                        runOnUiThread { result.success(true) }
                    } catch (e: Exception) {
                        runOnUiThread { result.error("download_failed", "Could not download the voice model. Check your internet.", null) }
                    }
                }.start()
            }
            "voiceTest" -> {
                VoiceSos.test(
                    this,
                    call.argument<String>("lang") ?: "en",
                    call.argument<String>("phrase") ?: "",
                    call.argument<Int>("seconds") ?: 10,
                ) { status -> runOnUiThread { result.success(status) } }
            }
            "practiceShake" -> {
                // "Try a practice shake": listens for up to [seconds]; never starts an SOS.
                val sm = getSystemService(SENSOR_SERVICE) as SensorManager
                val acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
                if (acc == null) {
                    result.success(false)
                } else {
                    val threshold = call.argument<Double>("g") ?: 2.5
                    val logic = ShakeLogic()
                    var done = false
                    val handler = android.os.Handler(android.os.Looper.getMainLooper())
                    lateinit var listener: SensorEventListener
                    val finish = { ok: Boolean ->
                        if (!done) {
                            done = true
                            sm.unregisterListener(listener)
                            result.success(ok)
                        }
                    }
                    listener = object : SensorEventListener {
                        override fun onSensorChanged(e: SensorEvent) {
                            val g = Math.sqrt((e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]).toDouble()) / SensorManager.GRAVITY_EARTH
                            if (logic.onSample(System.currentTimeMillis(), g, threshold)) handler.post { finish(true) }
                        }
                        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
                    }
                    sm.registerListener(listener, acc, SensorManager.SENSOR_DELAY_GAME, handler)
                    handler.postDelayed({ finish(false) }, (call.argument<Int>("seconds") ?: 10) * 1000L)
                }
            }
            "vaultAuth" -> vaultAuth(call.argument<String>("reason") ?: "Mere Saboot", result)
            "vaultExists" -> result.success(Vault.exists(this))
            "vaultNewKey" -> result.success(Vault.newKey())
            "vaultStore" -> {
                try {
                    Vault.store(this, call.argument<String>("key")!!)
                    result.success(null)
                } catch (e: Vault.AuthNeeded) {
                    result.error("auth_needed", e.message, null)
                }
            }
            "vaultUnlock" -> {
                try {
                    result.success(Vault.unlock(this))
                } catch (e: Vault.AuthNeeded) {
                    result.error("auth_needed", e.message, null)
                }
            }
            "vaultForget" -> {
                Vault.forget(this)
                File(cacheDir, "vault").deleteRecursively()
                File(cacheDir, "shared").deleteRecursively()
                result.success(null)
            }
            "vaultEncryptFile" -> Thread {
                try {
                    val (sha, size) = Vault.encryptFile(File(call.argument<String>("input")!!), File(call.argument<String>("output")!!), call.argument<String>("fileKey")!!)
                    runOnUiThread { result.success(mapOf("sha256" to sha, "size" to size)) }
                } catch (e: Exception) {
                    runOnUiThread { result.error("encrypt_failed", e.message, null) }
                }
            }.start()
            "vaultDecryptFile" -> Thread {
                try {
                    Vault.decryptFile(File(call.argument<String>("input")!!), File(call.argument<String>("output")!!), call.argument<String>("fileKey")!!)
                    runOnUiThread { result.success(null) }
                } catch (e: Exception) {
                    runOnUiThread { result.error("decrypt_failed", "This file could not be opened. It may be damaged.", null) }
                }
            }.start()
            "vaultEncrypt" -> result.success(Vault.encryptBytes(call.argument<String>("key")!!, Base64.decode(call.argument<String>("plain")!!, Base64.NO_WRAP)))
            "vaultDecrypt" -> result.success(Base64.encodeToString(Vault.decryptBytes(call.argument<String>("key")!!, call.argument<String>("locked")!!), Base64.NO_WRAP))
            "sha256Bytes" -> result.success(Vault.sha256(Base64.decode(call.argument<String>("data")!!, Base64.NO_WRAP).inputStream()))
            "freeBytes" -> result.success(StatFs(filesDir.absolutePath).availableBytes)
            "pinWidget" -> {
                val mgr = getSystemService(AppWidgetManager::class.java)
                val ok = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && mgr.isRequestPinAppWidgetSupported &&
                    mgr.requestPinAppWidget(ComponentName(this, DiscreetWidgetProvider::class.java), null, null)
                result.success(ok)
            }
            "pinShortcut" -> {
                val sm = getSystemService(ShortcutManager::class.java)
                val ok = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && sm.isRequestPinShortcutSupported &&
                    sm.requestPinShortcut(
                        ShortcutInfo.Builder(this, "quick_help")
                            .setShortLabel("Quick help")
                            .setIcon(Icon.createWithResource(this, R.mipmap.ic_launcher))
                            .setIntent(Intent(this, MainActivity::class.java).apply {
                                action = Intent.ACTION_VIEW
                                putExtra(EXTRA_ACTION, "sos")
                                putExtra(EXTRA_TRIGGER, "discreet")
                            })
                            .build(),
                        null,
                    )
                result.success(ok)
            }
            "playFile" -> {
                stopPlayback()
                player = MediaPlayer().apply {
                    setDataSource(call.argument<String>("path")!!)
                    setOnCompletionListener {
                        stopPlayback()
                        EngineBus.emit("playback", mapOf("playing" to false))
                    }
                    prepare()
                    start()
                }
                result.success(null)
            }
            "openFile" -> {
                val file = File(call.argument<String>("path")!!)
                val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
                val view = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, call.argument<String>("mime") ?: "*/*")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                try {
                    startActivity(view)
                    result.success(true)
                } catch (e: ActivityNotFoundException) {
                    result.success(false)
                }
            }
            "saveToDownloads" -> {
                val file = File(call.argument<String>("path")!!)
                val name = call.argument<String>("name") ?: file.name
                val mime = call.argument<String>("mime") ?: "application/octet-stream"
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                        put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sarthi Rakshak")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    if (uri == null) {
                        result.success(false)
                    } else {
                        contentResolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
                        result.success(true)
                    }
                } else {
                    result.success(false)
                }
            }
            else -> return false
        }
        return true
    }

    private fun deviceInfo(): Map<String, Any?> {
        val info = packageManager.getPackageInfo(packageName, 0)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
        return mapOf(
            "model" to Build.MODEL,
            "manufacturer" to Build.MANUFACTURER,
            "androidVersion" to Build.VERSION.RELEASE,
            "appVersion" to "${info.versionName} ($code)",
        )
    }

    /** Clips are decrypted only here, with the key that never leaves this phone. */
    /**
     * Fingerprint (strong biometric) or phone PIN / pattern / password. Only these unlock the
     * vault key in the Keystore; a "weak" face unlock does not, so it is not offered here.
     * Answers true, false (cancelled) or the error `no_lock` (no screen lock on the phone).
     */
    private fun vaultAuth(reason: String, result: MethodChannel.Result) {
        val keyguard = getSystemService(android.app.KeyguardManager::class.java)
        if (!keyguard.isDeviceSecure) {
            result.error("no_lock", "Set a screen lock (PIN, pattern, fingerprint or face) on this phone first. The vault needs it.", null)
            return
        }
        var answered = false
        fun answer(ok: Boolean) {
            if (!answered) {
                answered = true
                result.success(ok)
            }
        }
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) = answer(true)
            override fun onAuthenticationError(code: Int, message: CharSequence) = answer(false)
        })
        val info = BiometricPrompt.PromptInfo.Builder().setTitle(reason).setSubtitle("Fingerprint or phone screen lock")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            info.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            info.setDeviceCredentialAllowed(true)
        }
        try {
            prompt.authenticate(info.build())
        } catch (e: Exception) {
            Log.w("SafetyEngine", "Vault prompt failed", e)
            answer(false)
        }
    }

    private fun playEncrypted(bytes: ByteArray) {
        stopPlayback()
        val file = File(cacheDir, "play.m4a")
        file.writeBytes(Crypto.decrypt(Crypto.AUDIO_KEY, bytes))
        player = MediaPlayer().apply {
            setDataSource(file.absolutePath)
            setOnCompletionListener {
                stopPlayback()
                EngineBus.emit("playback", mapOf("playing" to false))
            }
            prepare()
            start()
        }
    }

    /**
     * Place names and search with the phone's own geocoder (no Google Maps key needed). Runs off the
     * main thread; answers null / an empty list when the phone has no geocoder or no internet.
     */
    private fun geocode(result: MethodChannel.Result, work: (Geocoder) -> Any?) {
        if (!Geocoder.isPresent()) return result.success(null)
        Thread {
            val answer = try {
                work(Geocoder(this, Locale("en", "IN")))
            } catch (e: Exception) {
                null
            }
            runOnUiThread { result.success(answer) }
        }.start()
    }

    private fun addressMap(a: Address): Map<String, Any?> {
        val area = a.subLocality ?: a.locality ?: a.subAdminArea
        val city = a.locality ?: a.subAdminArea ?: a.adminArea
        val name = a.featureName?.takeIf { it.isNotBlank() && !it.matches(Regex("^[0-9 ,-]+$")) && it != area } ?: area ?: city ?: "Place"
        val line = (0..a.maxAddressLineIndex).mapNotNull { a.getAddressLine(it) }.joinToString(", ")
        return mapOf(
            "name" to name,
            "address" to line,
            "area" to listOfNotNull(area, city.takeIf { it != area }).joinToString(", "),
            "lat" to a.latitude,
            "lng" to a.longitude,
        )
    }

    /** A strong buzz (alarm type, so it works even when touch vibration is off). */
    private fun vibrate(ms: Int) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(VIBRATOR_SERVICE) as Vibrator
        }
        if (!vibrator.hasVibrator()) return
        val effect = VibrationEffect.createOneShot(ms.toLong().coerceIn(50, 2000), VibrationEffect.DEFAULT_AMPLITUDE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            vibrator.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
        }
    }

    private fun stopPlayback() {
        player?.release()
        player = null
        File(cacheDir, "play.m4a").delete()
    }

    override fun onResume() {
        super.onResume()
        visible = true
    }

    override fun onPause() {
        visible = false
        super.onPause()
    }

    override fun onDestroy() {
        stopPlayback()
        ringtone?.stop()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ACTION = "sarthi_action"
        const val EXTRA_TRIGGER = "sarthi_trigger"

        /** The app's screens are on screen (resumed); a fake call then opens directly. */
        @Volatile
        var visible = false
        private const val PICK_CONTACT = 4711
    }
}
