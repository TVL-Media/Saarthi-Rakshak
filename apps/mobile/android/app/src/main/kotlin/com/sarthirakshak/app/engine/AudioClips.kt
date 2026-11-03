package com.sarthirakshak.app.engine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import java.io.File
import java.util.UUID

/**
 * Records the SOS in 30-second AAC clips. Each finished clip is encrypted on the phone (key in the
 * Keystore, never leaves the phone) and handed over for upload; the plain file is deleted.
 */
class AudioClips(private val context: Context, private val onClip: (clipId: String, file: File, recordedAt: Long, seconds: Int) -> Unit) {
    private var recorder: MediaRecorder? = null
    private var current: File? = null
    private var startedAt = 0L

    val recording get() = recorder != null

    /** When the clip being recorded now started (0 when not recording). */
    val currentSince get() = if (recorder != null) startedAt else 0L

    /** Why the last start failed (shown on the SOS screen); null once recording works. */
    var lastError: String? = null
        private set

    fun allowed() = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Starts recording if allowed and not already recording. Safe to call again (retries). */
    fun start() {
        if (recorder != null || !allowed()) return
        next()
    }

    fun stop() {
        finishCurrent()
    }

    private fun next() {
        // Some phones refuse one setting; try the common one first, then simpler ones.
        for (config in CONFIGS) {
            val file = File(context.cacheDir, "clip-${System.currentTimeMillis()}.m4a")
            val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
            try {
                r.setAudioSource(config.source)
                r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                r.setAudioEncodingBitRate(config.bitRate)
                r.setAudioSamplingRate(config.sampleRate)
                r.setMaxDuration(CLIP_MS)
                r.setOutputFile(file.absolutePath)
                r.setOnInfoListener { _, what, _ ->
                    if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                        finishCurrent()
                        next()
                    }
                }
                r.prepare()
                r.start()
                recorder = r
                current = file
                startedAt = System.currentTimeMillis()
                lastError = null
                return
            } catch (e: Exception) {
                Log.w(TAG, "Recorder setting $config failed", e)
                lastError = e.message ?: e.javaClass.simpleName
                r.release()
                file.delete()
                recorder = null
            }
        }
    }

    private fun finishCurrent() {
        val r = recorder ?: return
        val file = current
        recorder = null
        current = null
        try {
            r.stop()
        } catch (e: Exception) {
            // Too short to save.
        }
        r.release()
        if (file == null || !file.exists() || file.length() == 0L) {
            file?.delete()
            return
        }
        val seconds = ((System.currentTimeMillis() - startedAt) / 1000).toInt().coerceIn(0, 120)
        try {
            val dir = File(context.filesDir, "clips").apply { mkdirs() }
            val id = UUID.randomUUID().toString()
            val enc = File(dir, "$id.enc")
            enc.writeBytes(Crypto.encrypt(Crypto.AUDIO_KEY, file.readBytes()))
            onClip(id, enc, startedAt, seconds)
        } finally {
            file.delete()
        }
    }

    private data class Config(val source: Int, val sampleRate: Int, val bitRate: Int)

    companion object {
        const val CLIP_MS = 30_000
        private const val TAG = "SarthiAudio"
        private val CONFIGS = listOf(
            Config(MediaRecorder.AudioSource.MIC, 44_100, 64_000),
            Config(MediaRecorder.AudioSource.MIC, 22_050, 48_000),
            Config(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16_000, 32_000),
            Config(MediaRecorder.AudioSource.DEFAULT, 16_000, 32_000),
        )
    }
}
