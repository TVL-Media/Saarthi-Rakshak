package com.sarthirakshak.app.engine

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Small settings the engine needs even when the app screens are closed (session, guardians, mode). */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("sarthi_engine", Context.MODE_PRIVATE)

    var apiUrl: String?
        get() = prefs.getString("apiUrl", null)
        set(v) = prefs.edit().putString("apiUrl", v).apply()

    /** Session token, encrypted with a Keystore key. */
    var token: String?
        get() = prefs.getString("tokenEnc", null)?.let {
            try {
                String(Crypto.decrypt(Crypto.SESSION_KEY, Base64.decode(it, Base64.NO_WRAP)))
            } catch (e: Exception) {
                null
            }
        }
        set(v) {
            val enc = v?.let { Base64.encodeToString(Crypto.encrypt(Crypto.SESSION_KEY, it.toByteArray()), Base64.NO_WRAP) }
            prefs.edit().putString("tokenEnc", enc).apply()
        }

    var userName: String
        get() = prefs.getString("userName", null) ?: "Someone"
        set(v) = prefs.edit().putString("userName", v).apply()

    /** Guardians (id, name, phone, status) for SIM SMS without internet. */
    var guardians: JSONArray
        get() = JSONArray(prefs.getString("guardians", "[]"))
        set(v) = prefs.edit().putString("guardians", v.toString()).apply()

    /** The running SOS (null when none). */
    var sos: JSONObject?
        get() = prefs.getString("sos", null)?.let { JSONObject(it) }
        set(v) = prefs.edit().putString("sos", v?.toString()).apply()

    /** The running journey and its check rules (null when none). */
    var journey: JSONObject?
        get() = prefs.getString("journey", null)?.let { JSONObject(it) }
        set(v) = prefs.edit().putString("journey", v?.toString()).apply()

    // ---- Phase 2 ----

    /** still / walking / vehicle / unknown (activity recognition). */
    var activity: String
        get() = prefs.getString("activity", "unknown") ?: "unknown"
        set(v) = prefs.edit().putString("activity", v).apply()

    /**
     * Full-day location (feature 8): {enabled, pausedUntil, batteryPausePct}. Kept here so it
     * restarts by itself after the phone restarts (feature 9).
     */
    var daily: JSONObject
        get() = JSONObject(prefs.getString("daily", "{}") ?: "{}")
        set(v) = prefs.edit().putString("daily", v.toString()).apply()

    val dailyOn: Boolean get() = daily.optBoolean("enabled", false)

    /**
     * SOS triggers (features 1, 2, 4, 5, 6) and thresholds:
     * {shakeMode, voiceOn, voicePhrase, voiceLang, driveMode, fallOn, quietCountdown,
     *  journeySosButton, shakeG, crashG, fallG, countdownSeconds}
     */
    var triggers: JSONObject
        get() = JSONObject(prefs.getString("triggers", "{}") ?: "{}")
        set(v) = prefs.edit().putString("triggers", v.toString()).apply()

    fun clearSession() {
        prefs.edit().remove("tokenEnc").remove("guardians").remove("userName").remove("daily").remove("triggers").apply()
    }
}

/**
 * Everything waiting to go to the server, in order (SOS start first, then points, clips, end).
 * Kept in SQLite so nothing is lost when the phone is offline, the app is closed or restarts.
 */
class Outbox(context: Context) : SQLiteOpenHelper(context, "sarthi_outbox.db", null, 1) {
    data class Item(val id: Long, val kind: String, val body: JSONObject)

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    @Synchronized
    fun add(kind: String, body: JSONObject): Long =
        writableDatabase.insert("outbox", null, ContentValues().apply {
            put("kind", kind)
            put("body", body.toString())
            put("created", System.currentTimeMillis())
        })

    @Synchronized
    fun update(id: Long, body: JSONObject) {
        writableDatabase.update("outbox", ContentValues().apply { put("body", body.toString()) }, "id = ?", arrayOf(id.toString()))
    }

    @Synchronized
    fun remove(ids: List<Long>) {
        if (ids.isEmpty()) return
        writableDatabase.delete("outbox", "id IN (${ids.joinToString(",")})", null)
    }

    @Synchronized
    fun peek(limit: Int = 200): List<Item> {
        val out = ArrayList<Item>()
        readableDatabase.rawQuery("SELECT id, kind, body FROM outbox ORDER BY id LIMIT $limit", null).use { c ->
            while (c.moveToNext()) out.add(Item(c.getLong(0), c.getString(1), JSONObject(c.getString(2))))
        }
        return out
    }

    /** Items sent strictly in order (everything except audio clips). */
    @Synchronized
    fun peekOrdered(limit: Int = 200): List<Item> = query("SELECT id, kind, body FROM outbox WHERE kind NOT IN ('clip', 'daily') ORDER BY id LIMIT $limit")

    /** Full-day points: sent in batches, never ahead of (or blocking) an SOS or journey. */
    fun peekDaily(limit: Int = 500): List<Item> = query("SELECT id, kind, body FROM outbox WHERE kind = 'daily' ORDER BY id LIMIT $limit")

    fun countDaily(): Int =
        readableDatabase.rawQuery("SELECT COUNT(*) FROM outbox WHERE kind = 'daily'", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    /** Full-day points older than 7 days are not kept on the phone. */
    fun pruneDaily(olderThanMs: Long) {
        writableDatabase.delete("outbox", "kind = 'daily' AND created < ?", arrayOf(olderThanMs.toString()))
    }

    fun clearDaily() {
        writableDatabase.delete("outbox", "kind = 'daily'", null)
    }

    /** Audio clips: sent on their own, so a failed upload never holds up locations or "I'm safe". */
    @Synchronized
    fun peekClips(limit: Int = 20): List<Item> = query("SELECT id, kind, body FROM outbox WHERE kind = 'clip' ORDER BY id LIMIT $limit")

    private fun query(sql: String): List<Item> {
        val out = ArrayList<Item>()
        readableDatabase.rawQuery(sql, null).use { c ->
            while (c.moveToNext()) out.add(Item(c.getLong(0), c.getString(1), JSONObject(c.getString(2))))
        }
        return out
    }

    @Synchronized
    fun count(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM outbox", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    /** Waiting items that are not audio clips (clips retry slowly and never keep the engine awake). */
    @Synchronized
    fun countOrdered(): Int =
        readableDatabase.rawQuery("SELECT COUNT(*) FROM outbox WHERE kind NOT IN ('clip', 'daily')", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    @Synchronized
    fun clear() {
        writableDatabase.delete("outbox", null, null)
    }
}
