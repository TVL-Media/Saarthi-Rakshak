package com.sarthirakshak.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.ContactsContract
import android.provider.Settings
import com.sarthirakshak.app.engine.Alerts
import com.sarthirakshak.app.engine.Crypto
import com.sarthirakshak.app.engine.EngineBus
import com.sarthirakshak.app.engine.SafetyService
import com.sarthirakshak.app.engine.Store
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** Hosts the Flutter screens and the bridge (MethodChannel "sarthi/engine") to the safety engine. */
class MainActivity : FlutterActivity() {
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
        val action = intent?.getStringExtra(EXTRA_ACTION) ?: return
        val data = HashMap<String, Any?>()
        data["action"] = action
        intent.getStringExtra(EXTRA_TRIGGER)?.let { data["trigger"] = it }
        for (key in listOf("checkinId", "reason", "journeyId")) intent.getStringExtra(key)?.let { data[key] = it }
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
                        result.success(null)
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
                    "stopRingtone" -> {
                        ringtone?.stop()
                        ringtone = null
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
                    else -> result.notImplemented()
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
    private fun playEncrypted(bytes: ByteArray) {
        stopPlayback()
        val file = File(cacheDir, "play.m4a")
        file.writeBytes(Crypto.decrypt(Crypto.AUDIO_KEY, bytes))
        player = MediaPlayer().apply {
            setDataSource(file.absolutePath)
            setOnCompletionListener { stopPlayback() }
            prepare()
            start()
        }
    }

    private fun stopPlayback() {
        player?.release()
        player = null
        File(cacheDir, "play.m4a").delete()
    }

    override fun onDestroy() {
        stopPlayback()
        ringtone?.stop()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_ACTION = "sarthi_action"
        const val EXTRA_TRIGGER = "sarthi_trigger"
        private const val PICK_CONTACT = 4711
    }
}
