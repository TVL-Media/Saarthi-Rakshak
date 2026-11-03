package com.sarthirakshak.app.engine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.sarthirakshak.app.MainActivity
import com.sarthirakshak.app.R

/** Notifications and the loud check-in alert. */
object Alerts {
    const val CH_PROTECTION = "protection"
    const val CH_CHECKIN = "checkin"
    const val CH_SOS = "sos_sms"
    const val CH_PUSH = "safety_alerts"
    const val ID_SERVICE = 1
    const val ID_CHECKIN = 2
    const val ID_SMS = 3

    private var alarm: Ringtone? = null

    fun channels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_PROTECTION, "Protection on", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_CHECKIN, "Safety check-ins", NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(null, null) // the alert sound is played by the app, louder
        })
        nm.createNotificationChannel(NotificationChannel(CH_SOS, "SOS by SMS", NotificationManager.IMPORTANCE_HIGH))
        // Used by push notifications from the server (Firebase).
        nm.createNotificationChannel(NotificationChannel(CH_PUSH, "Guardian updates", NotificationManager.IMPORTANCE_HIGH))
    }

    fun openApp(context: Context, action: String? = null, extras: Map<String, String> = emptyMap(), requestCode: Int = 0): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            if (action != null) putExtra(MainActivity.EXTRA_ACTION, action)
            extras.forEach { (k, v) -> putExtra(k, v) }
        }
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun service(context: Context, text: String): Notification =
        builder(context, CH_PROTECTION)
            .setSmallIcon(R.drawable.ic_sos)
            .setContentTitle("Sarthi Rakshak")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openApp(context))
            .build()

    fun checkin(context: Context, reason: String, extras: Map<String, String>) {
        val text = when (reason) {
            "off_route" -> "You seem to be off your route. Are you safe?"
            "late" -> "You are later than planned. Are you safe?"
            else -> "You haven't moved for a few minutes. Are you safe?"
        }
        val open = openApp(context, "checkin", extras, requestCode = 2)
        val n = builder(context, CH_CHECKIN)
            .setSmallIcon(R.drawable.ic_sos)
            .setContentTitle("Are you safe?")
            .setContentText(text)
            .setCategory(Notification.CATEGORY_ALARM)
            .setPriority(Notification.PRIORITY_MAX)
            .setFullScreenIntent(open, true)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(ID_CHECKIN, n)
        startAlarm(context)
    }

    fun clearCheckin(context: Context) {
        stopAlarm()
        context.getSystemService(NotificationManager::class.java).cancel(ID_CHECKIN)
    }

    /** No SMS permission: one tap opens the SMS app with the SOS ready to send. */
    fun sendSmsYourself(context: Context, numbers: List<String>, text: String) {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + numbers.joinToString(";"))).apply {
            putExtra("sms_body", text)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pi = PendingIntent.getActivity(context, 3, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = builder(context, CH_SOS)
            .setSmallIcon(R.drawable.ic_sos)
            .setContentTitle("No internet — tap to send your SOS by SMS")
            .setContentText("Your SMS app opens with the message ready.")
            .setPriority(Notification.PRIORITY_MAX)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(ID_SMS, n)
    }

    private fun startAlarm(context: Context) {
        stopAlarm()
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        alarm = RingtoneManager.getRingtone(context, uri)?.apply {
            audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
            play()
        }
        vibrator(context)?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 400), 0))
        appContext = context.applicationContext
    }

    private var appContext: Context? = null

    fun stopAlarm() {
        alarm?.stop()
        alarm = null
        appContext?.let { vibrator(it)?.cancel() }
    }

    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator?
        }

    @Suppress("DEPRECATION")
    private fun builder(context: Context, channel: String): Notification.Builder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, channel) else Notification.Builder(context)
}
