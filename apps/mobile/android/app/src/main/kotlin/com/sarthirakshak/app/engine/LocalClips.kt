package com.sarthirakshak.app.engine

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Audio clips kept on this phone (encrypted, key in the Keystore) so the user can listen to them in
 * the app, also when the upload failed. Each clip is `clips/<id>.enc` with `clips/<id>.json` beside
 * it. Deleted after [KEEP_DAYS] like on the server.
 */
object LocalClips {
    const val KEEP_DAYS = 30

    fun dir(context: Context) = File(context.filesDir, "clips").apply { mkdirs() }

    fun file(context: Context, id: String) = File(dir(context), "$id.enc")

    private fun meta(context: Context, id: String) = File(dir(context), "$id.json")

    fun save(context: Context, id: String, sosId: String, recordedAt: Long, seconds: Int) {
        meta(context, id).writeText(
            JSONObject()
                .put("id", id)
                .put("sosId", sosId)
                .put("recordedAt", recordedAt)
                .put("seconds", seconds)
                .put("uploaded", false)
                .toString(),
        )
    }

    fun setUploaded(context: Context, id: String, uploaded: Boolean) {
        val m = meta(context, id)
        if (!m.exists()) return
        try {
            m.writeText(JSONObject(m.readText()).put("uploaded", uploaded).toString())
        } catch (e: Exception) {
            // keep the old state
        }
    }

    /** Newest first; only clips whose file is still there. */
    fun list(context: Context, sosId: String? = null): List<JSONObject> =
        (dir(context).listFiles { f -> f.name.endsWith(".json") } ?: emptyArray())
            .mapNotNull { f -> try { JSONObject(f.readText()) } catch (e: Exception) { null } }
            .filter { file(context, it.optString("id")).exists() }
            .filter { sosId == null || it.optString("sosId") == sosId }
            .sortedByDescending { it.optLong("recordedAt") }

    fun cleanup(context: Context) {
        val cutoff = System.currentTimeMillis() - KEEP_DAYS * 24L * 3600_000L
        for (m in list(context)) {
            if (m.optLong("recordedAt") < cutoff) {
                file(context, m.optString("id")).delete()
                meta(context, m.optString("id")).delete()
            }
        }
    }
}
