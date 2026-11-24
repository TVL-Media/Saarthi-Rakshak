package com.sarthirakshak.app.engine

import org.json.JSONObject

/**
 * Voice SOS phrase matching (no Android parts, so it is unit-tested).
 *
 * The recognizer only knows the phrase plus "[unk]" for any other sound. Noise before or after
 * the phrase (traffic, a cough, "umm") comes back as "[unk]" in the same result, e.g.
 * "[unk] please help me now". That is still the phrase: the "[unk]" parts are dropped and the
 * phrase counts as heard when all its words came, in order. Part of the phrase alone never counts.
 */
object VoiceMatch {
    private const val UNK = "[unk]"

    /** The phrase in lower case, without punctuation, single spaces. */
    fun normalise(phrase: String) =
        phrase.trim().lowercase().replace(Regex("[^\\p{L}\\p{M}\\p{N} ]"), "").replace(Regex("\\s+"), " ").trim()

    fun words(phrase: String) = normalise(phrase).split(' ').filter { it.isNotEmpty() }

    /** The text of a Vosk result ("text") or partial result ("partial"). */
    fun textOf(json: String): String = try {
        val o = JSONObject(json)
        o.optString("text", "").ifEmpty { o.optString("partial", "") }
    } catch (e: Exception) {
        ""
    }

    /**
     * True when [heardText] holds all of [wanted] (the phrase words the model knows), in order.
     * [wanted] empty never matches.
     */
    fun heard(heardText: String, wanted: List<String>): Boolean {
        if (wanted.isEmpty()) return false
        val heard = words(heardText.replace(UNK, " "))
        var next = 0
        for (w in heard) {
            if (w == wanted[next]) {
                next++
                if (next == wanted.size) return true
            }
        }
        return false
    }
}
