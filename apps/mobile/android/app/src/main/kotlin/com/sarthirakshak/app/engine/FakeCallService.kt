package com.sarthirakshak.app.engine

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.sarthirakshak.app.MainActivity

/**
 * Fake call (frame 17) that still rings after the user leaves the app: waits the chosen delay
 * in a short foreground service (Android freezes or blocks a plain timer in the background), then
 * opens the call screen if the app is on screen, or rings with a full-screen call notification
 * if it is not. Runs only on the phone: nothing is sent or logged.
 */
class FakeCallService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var ringtone: Ringtone? = null
    private var caller = "Mom"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SCHEDULE -> {
                caller = intent.getStringExtra(EXTRA_CALLER) ?: "Mom"
                val delayS = intent.getIntExtra(EXTRA_DELAY, 5).coerceIn(0, 120)
                handler.removeCallbacksAndMessages(null)
                stopRinging()
                startInForeground()
                handler.postDelayed({ ring() }, delayS * 1000L)
            }
            else -> finish() // ACTION_CANCEL, Decline on the notification, or an unknown start
        }
        return START_NOT_STICKY
    }

    private fun startInForeground() {
        Alerts.channels(this)
        val n = Alerts.fakeCallWaiting(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(Alerts.ID_FAKE_CALL, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
        } else {
            startForeground(Alerts.ID_FAKE_CALL, n)
        }
    }

    private fun ring() {
        if (MainActivity.visible) {
            // App on screen: open the call screen directly (it plays its own ringtone).
            val data = mapOf("action" to "fakecall", "caller" to caller)
            if (EngineBus.sink != null) EngineBus.emit("launch", data) else EngineBus.pendingLaunch = data
            finish()
            return
        }
        getSystemService(NotificationManager::class.java).notify(Alerts.ID_FAKE_CALL, Alerts.fakeCallRinging(this, caller))
        ringtone = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))?.apply {
            audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
            play()
        }
        // Like a real call: stop ringing if it is not picked up.
        handler.postDelayed({ finish() }, RING_MS)
    }

    private fun stopRinging() {
        ringtone?.stop()
        ringtone = null
    }

    private fun finish() {
        handler.removeCallbacksAndMessages(null)
        stopRinging()
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).cancel(Alerts.ID_FAKE_CALL)
        stopSelf()
    }

    /** Android 14+: a short service must stop when its time (about 3 minutes) is up. */
    override fun onTimeout(startId: Int) {
        finish()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopRinging()
        super.onDestroy()
    }

    companion object {
        const val ACTION_SCHEDULE = "com.sarthirakshak.app.FAKE_CALL_SCHEDULE"
        const val ACTION_CANCEL = "com.sarthirakshak.app.FAKE_CALL_CANCEL"
        const val EXTRA_CALLER = "caller"
        const val EXTRA_DELAY = "delaySeconds"
        private const val RING_MS = 45_000L

        /** Called from the Fake Call screen while the app is open (a foreground start is allowed). */
        fun schedule(context: Context, caller: String, delaySeconds: Int) {
            val i = Intent(context, FakeCallService::class.java)
                .setAction(ACTION_SCHEDULE)
                .putExtra(EXTRA_CALLER, caller)
                .putExtra(EXTRA_DELAY, delaySeconds)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i) else context.startService(i)
        }

        /** The call screen is open (or the call was declined): stop waiting and ringing. */
        fun cancel(context: Context) {
            context.stopService(Intent(context, FakeCallService::class.java))
            context.getSystemService(NotificationManager::class.java).cancel(Alerts.ID_FAKE_CALL)
        }
    }
}
