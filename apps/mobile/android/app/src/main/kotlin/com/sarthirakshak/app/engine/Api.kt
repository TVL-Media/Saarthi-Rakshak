package com.sarthirakshak.app.engine

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** Plain HTTP calls to our server, made by the engine itself (works with the app screens closed). */
class Api(private val store: Store) {
    class Reply(val code: Int, val body: String) {
        val ok get() = code in 200..299
        val json: JSONObject get() = if (body.isBlank()) JSONObject() else JSONObject(body)

        /** A problem with this request that sending it again will not fix (drop it). */
        val permanent get() = code in 400..499 && code != 401 && code != 408 && code != 429
    }

    /** Throws IOException when the server can't be reached. */
    fun call(method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 10_000): Reply {
        val base = store.apiUrl ?: throw IOException("No server address")
        val conn = URL(base.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Accept", "application/json")
            store.token?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val stream = if (code >= 400) conn.errorStream else conn.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return Reply(code, text)
        } finally {
            conn.disconnect()
        }
    }

    /** PUT a file to a storage upload link with exactly the given headers. */
    fun put(url: String, headers: Map<String, String>, bytes: ByteArray): Int {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "PUT"
            conn.connectTimeout = 15_000
            conn.readTimeout = 60_000
            conn.doOutput = true
            headers.forEach { (k, v) -> if (!k.equals("Content-Length", true)) conn.setRequestProperty(k, v) }
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }
}
