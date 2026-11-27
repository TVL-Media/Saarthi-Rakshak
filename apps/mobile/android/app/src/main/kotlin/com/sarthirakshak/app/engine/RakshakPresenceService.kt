package com.sarthirakshak.app.engine

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.sarthirakshak.app.R
import org.json.JSONObject

/**
 * "Available now" for an approved Rakshak: while on, sends the phone's position about every
 * 3 minutes so people nearby see that a Rakshak is close (first name and a rounded position only,
 * on the server). Ends by itself after the set hours, on "Stop", on logout, or when the server says
 * no (not approved any more, switched off, time up). Separate from the SOS safety engine.
 */
class RakshakPresenceService : Service() {
    private lateinit var fused: FusedLocationProviderClient
    private lateinit var store: Store
    private lateinit var api: Api
    private val main = Handler(Looper.getMainLooper())
    private val worker = HandlerThread("rakshak-presence").apply { start() }
    private val net = Handler(worker.looper)
    private var first = true

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let { send(it) }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        store = Store(this)
        api = Api(store)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent.getIntExtra(EXTRA_HOURS, 4).coerceIn(1, 12))
            // Logout: the app already told the server (with the session that is being ended).
            ACTION_STOP_QUIET -> stop(tellServer = false, reason = "logout")
            else -> stop(tellServer = true, reason = "off") // ACTION_STOP, the notification's Stop
        }
        return START_NOT_STICKY
    }

    private fun start(hours: Int) {
        val until = System.currentTimeMillis() + hours * 3_600_000L
        prefs(this).edit().putLong(KEY_UNTIL, until).apply()
        Alerts.channels(this)
        val n = notification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(Alerts.ID_RAKSHAK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(Alerts.ID_RAKSHAK, n)
        }
        first = true
        try {
            val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, INTERVAL_MS)
                .setMinUpdateIntervalMillis(INTERVAL_MS / 2)
                .build()
            fused.removeLocationUpdates(callback)
            fused.requestLocationUpdates(request, callback, worker.looper)
            // A position right away, not after the first 3 minutes.
            fused.lastLocation.addOnSuccessListener { it?.let { loc -> send(loc) } }
        } catch (e: SecurityException) {
            Log.w(TAG, "No location permission", e)
            return stop(tellServer = false, reason = "no_location")
        }
        main.removeCallbacksAndMessages(null)
        main.postDelayed({ stop(tellServer = true, reason = "time_up") }, until - System.currentTimeMillis())
        emit(true, null)
    }

    private fun send(loc: Location) {
        val start = first
        first = false
        net.post {
            val body = JSONObject().put("lat", loc.latitude).put("lng", loc.longitude).put("accuracyM", loc.accuracy.toDouble())
            if (start) body.put("start", true)
            try {
                val reply = api.call("POST", "/v1/rakshak/presence", body)
                // Not approved any more, switched off for everyone, or the time is up: stop.
                if (reply.code == 404 || reply.code == 409 || reply.code == 401) {
                    main.post { stop(tellServer = false, reason = if (reply.code == 409) "refused" else "unavailable") }
                }
            } catch (e: Exception) {
                // No connection: the next position is sent in 3 minutes; the list drops a
                // Rakshak who has been silent for 10 minutes.
                if (start) first = true
            }
        }
    }

    private fun stop(tellServer: Boolean, reason: String) {
        main.removeCallbacksAndMessages(null)
        try {
            fused.removeLocationUpdates(callback)
        } catch (e: Exception) {
            // ignored
        }
        prefs(this).edit().remove(KEY_UNTIL).apply()
        if (tellServer) {
            net.post {
                try {
                    api.call("DELETE", "/v1/rakshak/presence")
                } catch (e: Exception) {
                    // Offline: the server drops a silent Rakshak after 10 minutes anyway.
                }
            }
        }
        emit(false, reason)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        net.postDelayed({ worker.quitSafely() }, 15_000)
        super.onDestroy()
    }

    private fun notification(): Notification {
        val stop = PendingIntent.getService(
            this, 12,
            Intent(this, RakshakPresenceService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, Alerts.CH_PROTECTION) else Notification.Builder(this)
        return b.setSmallIcon(R.drawable.ic_sos)
            .setContentTitle("You're available as a Rakshak")
            .setContentText("People nearby can see a Rakshak is close (first name only).")
            .setOngoing(true)
            .setContentIntent(Alerts.openApp(this))
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun emit(on: Boolean, reason: String?) {
        EngineBus.emit("rakshakAvailable", mapOf("on" to on, "until" to until(this), "reason" to reason))
    }

    companion object {
        private const val TAG = "RakshakPresence"
        const val ACTION_START = "com.sarthirakshak.app.RAKSHAK_AVAILABLE_START"
        const val ACTION_STOP = "com.sarthirakshak.app.RAKSHAK_AVAILABLE_STOP"
        const val ACTION_STOP_QUIET = "com.sarthirakshak.app.RAKSHAK_AVAILABLE_STOP_QUIET"
        const val EXTRA_HOURS = "hours"
        private const val KEY_UNTIL = "until"
        private const val INTERVAL_MS = 3 * 60_000L

        private fun prefs(context: Context) = context.getSharedPreferences("rakshak_presence", Context.MODE_PRIVATE)

        /** When "Available now" ends (epoch ms), or 0 when it is off. */
        fun until(context: Context): Long =
            prefs(context).getLong(KEY_UNTIL, 0L).takeIf { it > System.currentTimeMillis() } ?: 0L

        /** Called while the app is open (a foreground-service start is allowed then). */
        fun start(context: Context, hours: Int) {
            val i = Intent(context, RakshakPresenceService::class.java).setAction(ACTION_START).putExtra(EXTRA_HOURS, hours)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i) else context.startService(i)
        }

        /** Off: stops sharing and tells the server ([tellServer] false on logout: the app did). */
        fun stop(context: Context, tellServer: Boolean = true) {
            if (until(context) == 0L) return
            val action = if (tellServer) ACTION_STOP else ACTION_STOP_QUIET
            try {
                context.startService(Intent(context, RakshakPresenceService::class.java).setAction(action))
            } catch (e: Exception) {
                // Not allowed from the background: the time limit and the server's 10-minute rule end it.
                prefs(context).edit().remove(KEY_UNTIL).apply()
            }
        }
    }
}
