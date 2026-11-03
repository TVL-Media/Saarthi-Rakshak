package com.sarthirakshak.app.engine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** The phone restarted during an SOS or journey: start the engine again. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!SafetyService.hasWork(context)) return
        try {
            SafetyService.send(context, SafetyService.ACTION_RESUME)
        } catch (e: Exception) {
            // Some Android versions refuse to start location tracking from here; the app resumes it
            // the next time it is opened.
            Log.e("SafetyEngine", "Could not resume after restart", e)
        }
    }
}
