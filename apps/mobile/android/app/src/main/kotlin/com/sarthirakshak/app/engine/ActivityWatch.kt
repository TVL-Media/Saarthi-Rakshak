package com.sarthirakshak.app.engine

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * Battery optimisation (feature 7): Android's activity recognition tells whether the user is
 * still, walking or in a vehicle, so full-day location can take fewer points when still.
 */
object ActivityWatch {
    private const val TAG = "SafetyEngine"

    fun allowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED

    private fun intent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context, 40, Intent(context, ActivityReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )

    @SuppressLint("MissingPermission")
    fun start(context: Context) {
        if (!allowed(context)) return
        try {
            ActivityRecognition.getClient(context).requestActivityUpdates(60_000L, intent(context))
        } catch (e: Exception) {
            Log.w(TAG, "Activity recognition not available", e)
        }
    }

    @SuppressLint("MissingPermission")
    fun stop(context: Context) {
        if (!allowed(context)) return
        try {
            ActivityRecognition.getClient(context).removeActivityUpdates(intent(context))
        } catch (e: Exception) {
            // ignored
        }
    }

    /** still / walking / vehicle / unknown */
    fun current(context: Context): String = Store(context).activity

    fun label(type: Int): String = when (type) {
        DetectedActivity.STILL -> "still"
        DetectedActivity.WALKING, DetectedActivity.ON_FOOT, DetectedActivity.RUNNING -> "walking"
        DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE -> "vehicle"
        else -> "unknown"
    }
}

class ActivityReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ActivityRecognitionResult.hasResult(intent)) return
        val result = ActivityRecognitionResult.extractResult(intent) ?: return
        val best = result.mostProbableActivity
        if (best.confidence < 60) return
        val label = ActivityWatch.label(best.type)
        val store = Store(context)
        if (store.activity == label) return
        store.activity = label
        // Let the engine pick the new location interval.
        if (store.dailyOn) {
            try {
                SafetyService.send(context, SafetyService.ACTION_ACTIVITY)
            } catch (e: Exception) {
                // the next location update picks it up
            }
        }
    }
}
