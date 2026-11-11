package com.sarthirakshak.app.engine

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Phase 2 detection on the phone (features 1, 5, 6). Reads the accelerometer only while it is
 * needed (journey, "Always on" shake, drive mode, fall detection). Every detection only starts the
 * normal SOS countdown, so a false one can always be cancelled.
 */
class Detectors(
    private val context: Context,
    private val handler: Handler,
    private val onDetected: (trigger: String, extras: Map<String, String>) -> Unit,
) : SensorEventListener {
    data class Config(
        val shake: Boolean,
        val fall: Boolean,
        val crash: Boolean,
        val shakeG: Double = 2.5,
        val crashG: Double = 4.0,
        val fallG: Double = 3.0,
    ) {
        val any get() = shake || fall || crash
    }

    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private var config = Config(shake = false, fall = false, crash = false)
    private var listening = false

    val shake = ShakeLogic()
    val fall = FallLogic()
    val crash = CrashLogic()

    /** Turns sensors on or off for what is needed now. */
    fun apply(next: Config) {
        config = next
        val want = next.any
        if (want && !listening) {
            val acc = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
            // ~50 readings a second is enough for shakes, falls and impacts.
            listening = sensors.registerListener(this, acc, 20_000, handler)
        } else if (!want && listening) {
            sensors.unregisterListener(this)
            listening = false
        }
    }

    fun stop() = apply(Config(shake = false, fall = false, crash = false))

    /** GPS speed for crash detection (m/s). */
    fun onSpeed(at: Long, metresPerSecond: Float?) = crash.onSpeed(at, metresPerSecond)

    override fun onSensorChanged(e: SensorEvent) {
        val g = sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]) / SensorManager.GRAVITY_EARTH
        val now = System.currentTimeMillis()
        if (config.shake && shake.onSample(now, g.toDouble(), config.shakeG)) onDetected("shake", emptyMap())
        if (config.fall) fall.onSample(now, g.toDouble(), config.fallG)?.let { height ->
            onDetected("fall", mapOf("heightM" to "%.1f".format(java.util.Locale.US, height)))
        }
        if (config.crash && crash.onSample(now, g.toDouble(), config.crashG)) onDetected("crash", emptyMap())
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}

/** 3 strong peaks (each above the threshold, at least 150 ms apart) within 2 seconds. */
class ShakeLogic {
    private val peaks = ArrayDeque<Long>()
    private var above = false
    private var cooldownUntil = 0L

    fun onSample(at: Long, g: Double, threshold: Double): Boolean {
        if (at < cooldownUntil) return false
        if (g >= threshold && !above) {
            above = true
            if (peaks.isEmpty() || at - peaks.last() >= 150) peaks.addLast(at)
            while (peaks.isNotEmpty() && at - peaks.first() > 2_000) peaks.removeFirst()
            if (peaks.size >= 3) {
                peaks.clear()
                cooldownUntil = at + 5_000 // one countdown at a time
                return true
            }
        } else if (g < threshold * 0.7) {
            above = false
        }
        return false
    }
}

/**
 * Free fall (near 0 g for over 0.3 s), then an impact above the threshold within 1 s, then almost
 * no movement for 10 s. Returns the approximate fall height in metres (from the free-fall time).
 */
class FallLogic {
    private var freeFallStart = 0L
    private var freeFallMs = 0L
    private var freeFallEnd = 0L
    private var impactAt = 0L
    private var stillSince = 0L
    private var cooldownUntil = 0L

    fun onSample(at: Long, g: Double, impactG: Double): Double? {
        if (at < cooldownUntil) return null
        when {
            impactAt == 0L && g < 0.35 -> {
                if (freeFallStart == 0L) freeFallStart = at
            }
            impactAt == 0L && freeFallStart != 0L -> {
                val fell = at - freeFallStart
                freeFallStart = 0L
                if (fell >= 300) {
                    freeFallMs = fell
                    freeFallEnd = at
                }
                if (freeFallMs > 0 && g >= impactG) {
                    impactAt = at
                    stillSince = 0L
                }
            }
            // The impact must come within 1 s of the free fall.
            impactAt == 0L && freeFallMs > 0 && at - freeFallEnd > 1_000 -> freeFallMs = 0L
            impactAt == 0L && freeFallMs > 0 && g >= impactG -> {
                impactAt = at
                stillSince = 0L
            }
        }
        if (impactAt != 0L) {
            if (at - impactAt < 1_000) return null // the bounce
            if (abs(g - 1.0) < 0.15) {
                if (stillSince == 0L) stillSince = at
                if (at - stillSince >= 10_000) {
                    val t = freeFallMs / 1000.0
                    reset(at)
                    return 0.5 * 9.81 * t * t
                }
            } else if (at - impactAt > 3_000) {
                reset(at, cooldown = false) // moving again: the person picked the phone up
            } else {
                stillSince = 0L
            }
            if (at - impactAt > 20_000) reset(at, cooldown = false)
        }
        return null
    }

    private fun reset(at: Long, cooldown: Boolean = true) {
        freeFallStart = 0L
        freeFallMs = 0L
        impactAt = 0L
        stillSince = 0L
        if (cooldown) cooldownUntil = at + 30_000
    }
}

/**
 * Drive mode: an impact above the threshold while the vehicle was going over 25 km/h, and the
 * GPS speed falls under 5 km/h within 3 seconds.
 */
class CrashLogic {
    private var lastFastAt = 0L
    private var impactAt = 0L
    private var cooldownUntil = 0L
    private var latestSpeed = -1f
    private var latestSpeedAt = 0L

    fun onSpeed(at: Long, speed: Float?) {
        if (speed == null) return
        latestSpeed = speed
        latestSpeedAt = at
        if (speed >= 25 / 3.6f) lastFastAt = at
    }

    fun onSample(at: Long, g: Double, impactG: Double): Boolean {
        if (at < cooldownUntil) return false
        if (g >= impactG && at - lastFastAt < 5_000) impactAt = at
        if (impactAt != 0L) {
            if (latestSpeedAt > impactAt && latestSpeed in 0f..(5 / 3.6f) && latestSpeedAt - impactAt <= 3_000) {
                impactAt = 0L
                cooldownUntil = at + 60_000
                return true
            }
            if (at - impactAt > 6_000) impactAt = 0L
        }
        return false
    }
}
