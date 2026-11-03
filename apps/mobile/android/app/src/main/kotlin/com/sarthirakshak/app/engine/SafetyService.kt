package com.sarthirakshak.app.engine

import android.Manifest
import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/**
 * The safety engine: a foreground service that keeps working with the screen off, the app closed
 * or no internet. During an SOS it acts first on the phone (location, audio, SIM SMS), then tells
 * the server; during a journey it tracks and runs the check-ins. Everything for the server goes
 * through the [Outbox], so nothing is lost offline.
 */
class SafetyService : Service() {
    private lateinit var store: Store
    private lateinit var outbox: Outbox
    private lateinit var api: Api
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private lateinit var fused: FusedLocationProviderClient
    private lateinit var audio: AudioClips
    private var wakeLock: PowerManager.WakeLock? = null

    private var watch: JourneyWatch? = null
    private var lastFix: Location? = null
    private var online = true
    private var locationOff = false
    private var trackingIntervalMs = 0L
    private var flushing = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Alerts.channels(this)
        store = Store(this)
        outbox = Outbox(this)
        api = Api(store)
        thread = HandlerThread("safety-engine").apply { start() }
        handler = Handler(thread.looper)
        fused = LocationServices.getFusedLocationProviderClient(this)
        LocalClips.cleanup(this)
        audio = AudioClips(this) { clipId, file, recordedAt, seconds ->
            val sosId = store.sos?.optString("sosId") ?: return@AudioClips
            // Kept on the phone so the user can listen to it in the app (also if the upload fails).
            LocalClips.save(this, clipId, sosId, recordedAt, seconds)
            outbox.add("clip", JSONObject().apply {
                put("sosId", sosId)
                put("clipId", clipId)
                put("path", file.absolutePath)
                put("recordedAt", recordedAt)
                put("seconds", seconds)
            })
            handler.post { flush() }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        goForeground()
        val action = intent?.action ?: ACTION_RESUME
        val extras = intent?.extras
        handler.post {
            try {
                when (action) {
                    ACTION_START_SOS -> startSos(extras?.getString("args") ?: "{}")
                    ACTION_END_SOS -> endSos(extras?.getString("sosId"))
                    ACTION_START_JOURNEY -> startJourney(extras?.getString("args") ?: "{}")
                    ACTION_STOP_JOURNEY -> stopJourney()
                    ACTION_CHECKIN_ANSWER -> checkinAnswered(extras?.getString("args") ?: "{}")
                    else -> resume()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Engine action $action failed", e)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        fused.removeLocationUpdates(locationCallback)
        audio.stop()
        Alerts.stopAlarm()
        wakeLock?.let { if (it.isHeld) it.release() }
        thread.quitSafely()
        super.onDestroy()
    }

    // ---- SOS --------------------------------------------------------------------------------------

    private fun startSos(argsJson: String) {
        val args = JSONObject(argsJson)
        val sosId = args.getString("sosId")
        if (store.sos != null) {
            emitState()
            return // never a second SOS
        }
        val sos = JSONObject().apply {
            put("sosId", sosId)
            put("trigger", args.optString("trigger", "button"))
            put("startedAt", args.optLong("startedAt", System.currentTimeMillis()))
            if (!args.isNull("journeyId") && args.optString("journeyId").isNotEmpty()) put("journeyId", args.getString("journeyId"))
            put("sentToServer", false)
            put("simSmsSentTo", JSONArray())
            put("simDone", false)
        }
        store.sos = sos
        outbox.add("sos_start", JSONObject().put("sosId", sosId))
        acquireWakeLock()
        goForeground()
        startTracking()
        if (batteryPct() >= 5) audio.start()
        // If the recorder refused at once, try again shortly (the microphone part of the
        // foreground service can take a moment); the heartbeat keeps retrying after that.
        handler.postDelayed({
            if (store.sos?.optString("sosId") == sosId && !audio.recording && audio.allowed()) {
                goForeground()
                audio.start()
                emitState()
            }
        }, 3_000L)
        updateNotification()
        flush()
        // No answer from the server in time → SMS from the phone's own SIM.
        val waitS = args.optInt("simFallbackSeconds", 10)
        handler.postDelayed({ simFallback(sosId) }, waitS * 1000L)
        scheduleTicks()
        emitState()
    }

    private fun endSos(sosId: String?) {
        val sos = store.sos ?: return emitState()
        if (sosId != null && sos.optString("sosId") != sosId) return
        audio.stop()
        outbox.add("sos_end", JSONObject().put("sosId", sos.getString("sosId")))
        store.sos = null
        releaseWakeLock()
        if (store.journey == null) stopTracking() else startTracking()
        updateNotification()
        flush()
        emitState()
        stopIfIdle()
    }

    private fun simFallback(sosId: String) {
        val sos = store.sos ?: return
        if (sos.optString("sosId") != sosId || sos.optBoolean("sentToServer") || sos.optBoolean("simDone")) return
        val fix = lastFix
        val where = if (fix != null) "Last location: https://maps.google.com/?q=${"%.6f".format(Locale.US, fix.latitude)},${"%.6f".format(Locale.US, fix.longitude)}"
        else "Location not available."
        val text = "SOS from ${store.userName}. $where Call 112 if needed. - Sarthi Rakshak"
        val guardians = store.guardians
        val reached = JSONArray()
        val numbers = ArrayList<String>()
        for (i in 0 until guardians.length()) {
            val g = guardians.getJSONObject(i)
            if (g.optString("status") == "declined") continue
            val phone = g.optString("phone").takeIf { it.isNotEmpty() } ?: continue
            numbers.add(phone)
            if (SimSms.allowed(this) && SimSms.send(this, phone, text)) reached.put(g.getString("id"))
        }
        if (!SimSms.allowed(this) && numbers.isNotEmpty()) Alerts.sendSmsYourself(this, numbers, text)
        sos.put("simSmsSentTo", reached)
        sos.put("simDone", true)
        store.sos = sos
        emitState()
    }

    // ---- Journey ----------------------------------------------------------------------------------

    private fun startJourney(argsJson: String) {
        val cfg = JSONObject(argsJson).apply {
            put("pausedUntil", 0L)
            put("quiet", JSONObject())
        }
        store.journey = cfg
        watch = JourneyWatch(cfg)
        startTracking()
        scheduleTicks()
        updateNotification()
        emitState()
    }

    private fun stopJourney() {
        store.journey = null
        watch = null
        Alerts.clearCheckin(this)
        if (store.sos == null) stopTracking()
        updateNotification()
        emitState()
        stopIfIdle()
    }

    private fun maybeCheckin(fix: Location) {
        val j = store.journey ?: return
        if (store.sos != null) return // no check-ins during an SOS
        val w = watch ?: JourneyWatch(j).also { watch = it }
        val reason = w.onPoint(fix.time, fix.latitude, fix.longitude) ?: return
        val now = System.currentTimeMillis()
        if (j.optLong("pausedUntil") > now) return
        if (j.optString("pendingCheckinId").isNotEmpty()) return
        if (j.optJSONObject("quiet")?.optLong(reason, 0L) ?: 0L > now) return

        val checkinId = UUID.randomUUID().toString()
        val journeyId = j.getString("journeyId")
        j.put("pendingCheckinId", checkinId)
        j.put("pendingReason", reason)
        store.journey = j
        outbox.add("checkin", JSONObject().apply {
            put("journeyId", journeyId)
            put("id", checkinId)
            put("reason", reason)
        })
        flush()
        val extras = mapOf("checkinId" to checkinId, "reason" to reason, "journeyId" to journeyId)
        Alerts.checkin(this, reason, extras)
        EngineBus.emit("checkin", extras)
        // After the reply time the server alerts the guardians; stop the alarm then.
        val waitMs = (j.optDouble("replyWaitMinutes", 2.0) * 60_000).toLong()
        handler.postDelayed({
            val cur = store.journey
            if (cur != null && cur.optString("pendingCheckinId") == checkinId) {
                cur.remove("pendingCheckinId")
                cur.remove("pendingReason")
                store.journey = cur
                Alerts.clearCheckin(this)
            }
        }, waitMs)
    }

    private fun checkinAnswered(argsJson: String) {
        val a = JSONObject(argsJson)
        Alerts.clearCheckin(this)
        val j = store.journey ?: return
        val now = System.currentTimeMillis()
        when (a.optString("answer")) {
            "fine" -> j.getJSONObject("quiet").put(a.optString("reason"), now + 5 * 60_000L)
            "traffic_pause" -> j.put("pausedUntil", now + a.optInt("pauseMinutes", 10) * 60_000L)
        }
        j.remove("pendingCheckinId")
        j.remove("pendingReason")
        store.journey = j
        emitState()
    }

    // ---- Location ---------------------------------------------------------------------------------

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            for (fix in result.locations) onFix(fix)
        }
    }

    private fun onFix(fix: Location) {
        lastFix = fix
        val sos = store.sos
        val journey = store.journey
        if (sos == null && journey == null) return
        outbox.add("point", JSONObject().apply {
            put("clientPointId", UUID.randomUUID().toString())
            sos?.let { put("sosId", it.getString("sosId")) }
            journey?.let { put("journeyId", it.getString("journeyId")) }
            put("lat", fix.latitude)
            put("lng", fix.longitude)
            if (fix.hasAccuracy()) put("accuracyM", fix.accuracy.toDouble().coerceIn(0.0, 100_000.0))
            put("batteryPct", batteryPct())
            put("network", network())
            put("recordedAt", iso(fix.time))
        })
        maybeCheckin(fix)
        if (batteryPct() < 5) audio.stop()
        // Battery under 15 %: location every 15 s instead of every few seconds.
        val wanted = intervalMs()
        if (wanted != trackingIntervalMs) startTracking()
        emitState()
    }

    @SuppressLint("MissingPermission")
    private fun startTracking() {
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        locationOff = !fine && !coarse
        if (locationOff) return
        fused.removeLocationUpdates(locationCallback)
        trackingIntervalMs = intervalMs()
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, trackingIntervalMs)
            .setMinUpdateIntervalMillis(trackingIntervalMs / 2)
            .setWaitForAccurateLocation(false)
            .build()
        fused.requestLocationUpdates(request, locationCallback, thread.looper)
    }

    private fun stopTracking() {
        fused.removeLocationUpdates(locationCallback)
        trackingIntervalMs = 0
    }

    private fun intervalMs(): Long = when {
        batteryPct() < 15 -> 15_000L
        store.sos != null -> 4_000L
        else -> 7_000L
    }

    // ---- Sending ----------------------------------------------------------------------------------

    private fun scheduleTicks() {
        handler.removeCallbacks(flushTick)
        handler.removeCallbacks(heartbeatTick)
        handler.postDelayed(flushTick, FLUSH_MS)
        handler.postDelayed(heartbeatTick, HEARTBEAT_MS)
    }

    private val flushTick = object : Runnable {
        override fun run() {
            flush()
            if (store.sos != null || store.journey != null || outbox.countOrdered() > 0) handler.postDelayed(this, FLUSH_MS)
            else stopIfIdle()
        }
    }

    private val heartbeatTick = object : Runnable {
        override fun run() {
            val sos = store.sos
            val journey = store.journey
            if (sos == null && journey == null) return
            // Audio did not start (or the permission was given later): try again, with the
            // microphone added to the foreground service first.
            if (sos != null && !audio.recording && audio.allowed() && batteryPct() >= 5) {
                goForeground()
                audio.start()
                emitState()
            }
            try {
                api.call("POST", "/v1/heartbeat", JSONObject().apply {
                    put("batteryPct", batteryPct())
                    put("network", network())
                    if (sos != null && sos.optBoolean("sentToServer")) put("sosId", sos.getString("sosId"))
                    journey?.let { put("journeyId", it.getString("journeyId")) }
                })
            } catch (e: IOException) {
                online = false
            }
            handler.postDelayed(this, HEARTBEAT_MS)
        }
    }

    /** Sends what is waiting, in order. Stops at the first network problem (tries again later). */
    private fun flush() {
        if (flushing || store.token == null) return
        flushing = true
        try {
            while (true) {
                val items = outbox.peekOrdered()
                if (items.isEmpty()) {
                    flushClips() // only once everything before them (e.g. the SOS) is on the server
                    break
                }
                val first = items.first()
                val done: List<Long> = when (first.kind) {
                    "sos_start" -> sendSosStart(first)
                    "point" -> sendPoints(items.takeWhile { it.kind == "point" }.take(50))
                    "sos_end" -> simple(first, "POST", "/v1/sos/${first.body.getString("sosId")}/end", JSONObject().put("reason", "safe"))
                    "checkin" -> simple(first, "POST", "/v1/journeys/${first.body.getString("journeyId")}/checkins",
                        JSONObject().put("id", first.body.getString("id")).put("reason", first.body.getString("reason")))
                    else -> listOf(first.id)
                }
                if (done.isEmpty()) break
                outbox.remove(done)
                online = true
            }
        } catch (e: IOException) {
            online = false
        } catch (e: StopFlush) {
            // e.g. session ended; try again later
        } catch (e: Exception) {
            Log.e(TAG, "Flush failed", e)
        } finally {
            flushing = false
            emitState()
        }
    }

    private class StopFlush : Exception()

    private fun check(reply: Api.Reply, what: String): Boolean {
        if (reply.ok) return true
        if (reply.permanent) {
            Log.w(TAG, "$what refused (${reply.code}): ${reply.body.take(200)}")
            return true // drop it: sending it again will not help
        }
        throw StopFlush()
    }

    private fun simple(item: Outbox.Item, method: String, path: String, body: JSONObject): List<Long> {
        check(api.call(method, path, body), item.kind)
        return listOf(item.id)
    }

    private fun sendSosStart(item: Outbox.Item): List<Long> {
        val sos = store.sos
        val sosId = item.body.getString("sosId")
        val stored = if (sos?.optString("sosId") == sosId) sos else null
        val body = JSONObject().apply {
            put("id", sosId)
            put("trigger", stored?.optString("trigger") ?: "button")
            put("startedAt", iso(stored?.optLong("startedAt") ?: System.currentTimeMillis()))
            stored?.optString("journeyId")?.takeIf { it.isNotEmpty() }?.let { put("journeyId", it) }
            lastFix?.let { fix ->
                put("location", JSONObject().apply {
                    put("lat", fix.latitude)
                    put("lng", fix.longitude)
                    if (fix.hasAccuracy()) put("accuracyM", fix.accuracy.toDouble())
                })
            }
            val reached = stored?.optJSONArray("simSmsSentTo")
            if (reached != null && reached.length() > 0) put("simSmsSentTo", reached)
        }
        check(api.call("POST", "/v1/sos", body), "SOS start")
        if (stored != null) {
            stored.put("sentToServer", true)
            store.sos = stored
            updateNotification()
        }
        return listOf(item.id)
    }

    private fun sendPoints(points: List<Outbox.Item>): List<Long> {
        val arr = JSONArray()
        points.forEach { arr.put(it.body) }
        check(api.call("POST", "/v1/locations", JSONObject().put("points", arr)), "locations")
        return points.map { it.id }
    }

    /**
     * Uploads waiting audio clips. A clip that fails waits longer each time (30 s … 10 min) and is
     * given up after a day; it stays on the phone either way. Never stops the other sending.
     */
    private fun flushClips() {
        val now = System.currentTimeMillis()
        for (item in outbox.peekClips()) {
            val b = item.body
            if (b.optLong("nextTryAt") > now) continue
            try {
                outbox.remove(sendClip(item))
                LocalClips.setUploaded(this, b.getString("clipId"), true)
            } catch (e: Exception) {
                val tries = b.optInt("tries") + 1
                if (now - b.optLong("recordedAt", now) > CLIP_GIVE_UP_MS) {
                    Log.w(TAG, "Clip ${b.optString("clipId")} not uploaded after a day; kept on the phone only")
                    outbox.remove(listOf(item.id))
                } else {
                    val wait = (30_000L shl (tries - 1).coerceAtMost(5)).coerceAtMost(600_000L)
                    outbox.update(item.id, b.put("tries", tries).put("nextTryAt", now + wait))
                }
            }
        }
    }

    private fun sendClip(item: Outbox.Item): List<Long> {
        val b = item.body
        val file = File(b.getString("path"))
        if (!file.exists()) return listOf(item.id)
        val sosId = b.getString("sosId")
        val bytes = file.readBytes()
        val link = api.call("POST", "/v1/sos/$sosId/audio-upload", JSONObject().put("clipId", b.getString("clipId")).put("sizeBytes", bytes.size))
        if (!link.ok) {
            check(link, "clip link")
            return listOf(item.id) // refused for good (e.g. a test SOS); the clip stays on the phone
        }
        val l = link.json
        val headers = HashMap<String, String>()
        val h = l.getJSONObject("headers")
        h.keys().forEach { headers[it] = h.getString(it) }
        val put = api.put(l.getString("uploadUrl"), headers, bytes)
        if (put !in 200..299) throw StopFlush()
        val saved = api.call("POST", "/v1/sos/$sosId/audio", JSONObject().apply {
            put("clipId", b.getString("clipId"))
            put("recordedAt", iso(b.getLong("recordedAt")))
            put("durationS", b.getInt("seconds"))
        })
        check(saved, "clip")
        return listOf(item.id) // the encrypted file stays on the phone for listening (LocalClips)
    }

    // ---- Phone state ------------------------------------------------------------------------------

    private fun batteryPct(): Int =
        (getSystemService(Context.BATTERY_SERVICE) as BatteryManager).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100)

    private fun network(): String {
        val cm = getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
            else -> "unknown"
        }
    }

    private fun emitState() {
        val sos = store.sos
        val clips = if (sos != null) LocalClips.list(this, sos.optString("sosId")) else emptyList()
        val journey = store.journey
        val fix = lastFix
        val reached = sos?.optJSONArray("simSmsSentTo")
        EngineBus.emit("state", mapOf(
            "mode" to when {
                sos != null && journey != null -> "sos_journey"
                sos != null -> "sos"
                journey != null -> "journey"
                else -> "idle"
            },
            "sosId" to sos?.optString("sosId"),
            "sosSentToServer" to (sos?.optBoolean("sentToServer") ?: false),
            "simSmsSentTo" to (0 until (reached?.length() ?: 0)).map { reached!!.getString(it) },
            "journeyId" to journey?.optString("journeyId"),
            "journeyStatus" to watch?.status,
            "lastLat" to fix?.latitude,
            "lastLng" to fix?.longitude,
            "lastFixAt" to fix?.time,
            "accuracyM" to fix?.accuracy?.toDouble(),
            "batteryPct" to batteryPct(),
            "online" to online,
            "queued" to outbox.countOrdered(),
            "recording" to audio.recording,
            "audioOff" to (sos != null && !audio.allowed()),
            "audioError" to (if (sos != null && !audio.recording) audio.lastError else null),
            // How much was recorded in this SOS: saved clips + the clip being recorded now.
            "audioClips" to clips.size,
            "audioSavedSeconds" to clips.sumOf { it.optInt("seconds") },
            "audioClipSince" to (if (sos != null) audio.currentSince else 0L),
            "locationOff" to locationOff,
        ))
    }

    private fun goForeground() {
        val n = Alerts.service(this, notificationText())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            val sosOn = store.sos != null
            if (sosOn && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            }
            try {
                startForeground(Alerts.ID_SERVICE, n, type)
            } catch (e: Exception) {
                // e.g. started in the background without location permission: keep a plain notification.
                Log.e(TAG, "startForeground with type failed", e)
                startForeground(Alerts.ID_SERVICE, n)
            }
        } else {
            startForeground(Alerts.ID_SERVICE, n)
        }
    }

    private fun updateNotification() = goForeground()

    private fun notificationText(): String = when {
        store.sos != null && store.sos!!.optBoolean("sentToServer") -> "SOS active — your guardians can see your location"
        store.sos != null -> "SOS active — sending…"
        store.journey != null -> "Journey on — your guardians can follow you"
        outbox.countOrdered() > 0 -> "Sending saved updates…"
        else -> "Protection on"
    }

    private fun resume() {
        // After a restart of the service or the phone: carry on with what was running.
        store.journey?.let { watch = JourneyWatch(it) }
        if (store.sos != null) {
            acquireWakeLock()
            if (batteryPct() >= 5) audio.start()
        }
        if (store.sos != null || store.journey != null) {
            startTracking()
            scheduleTicks()
        } else if (outbox.count() > 0) { // also tries waiting clips once
            handler.postDelayed(flushTick, 0)
        }
        updateNotification()
        emitState()
        stopIfIdle()
    }

    private fun stopIfIdle() {
        if (store.sos == null && store.journey == null && outbox.countOrdered() == 0) {
            stopTracking()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        // Keeps the engine running during an SOS; released at the end (and after 4 hours at most).
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sarthi:sos")
            .apply { acquire(4 * 60 * 60 * 1000L) }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    companion object {
        private const val TAG = "SafetyEngine"
        const val ACTION_START_SOS = "sarthi.START_SOS"
        const val ACTION_END_SOS = "sarthi.END_SOS"
        const val ACTION_START_JOURNEY = "sarthi.START_JOURNEY"
        const val ACTION_STOP_JOURNEY = "sarthi.STOP_JOURNEY"
        const val ACTION_CHECKIN_ANSWER = "sarthi.CHECKIN_ANSWER"
        const val ACTION_RESUME = "sarthi.RESUME"
        private const val FLUSH_MS = 5_000L
        private const val HEARTBEAT_MS = 45_000L
        private const val CLIP_GIVE_UP_MS = 24 * 3600_000L

        private val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }

        @Synchronized
        fun iso(ms: Long): String = isoFormat.format(Date(ms))

        fun send(context: Context, action: String, extras: Map<String, String> = emptyMap()) {
            val intent = Intent(context, SafetyService::class.java).setAction(action)
            extras.forEach { (k, v) -> intent.putExtra(k, v) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }

        fun hasWork(context: Context): Boolean {
            val s = Store(context)
            return s.sos != null || s.journey != null
        }
    }
}
