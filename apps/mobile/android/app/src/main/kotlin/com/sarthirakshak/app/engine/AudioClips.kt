package com.sarthirakshak.app.engine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
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

    fun allowed() = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun start() {
        if (recorder != null || !allowed()) return
        next()
    }

    fun stop() {
        finishCurrent()
    }

    private fun next() {
        val file = File(context.cacheDir, "clip-${System.currentTimeMillis()}.m4a")
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(48_000)
            r.setAudioSamplingRate(22_050)
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
        } catch (e: Exception) {
            r.release()
            file.delete()
            recorder = null
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

    companion object {
        const val CLIP_MS = 30_000
    }
}
