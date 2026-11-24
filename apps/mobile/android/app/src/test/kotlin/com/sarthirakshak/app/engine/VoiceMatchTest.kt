package com.sarthirakshak.app.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceMatchTest {
    private val phrase = VoiceMatch.words("Please help me now!")

    @Test
    fun `the phrase alone is heard`() {
        assertTrue(VoiceMatch.heard("please help me now", phrase))
    }

    @Test
    fun `noise before or after the phrase does not hide it`() {
        // Before the fix any "[unk]" in the result threw the whole try away.
        assertTrue(VoiceMatch.heard("[unk] please help me now", phrase))
        assertTrue(VoiceMatch.heard("please help me now [unk] [unk]", phrase))
        assertTrue(VoiceMatch.heard("[unk] please help [unk] me now", phrase))
    }

    @Test
    fun `part of the phrase never counts`() {
        assertFalse(VoiceMatch.heard("help", phrase))
        assertFalse(VoiceMatch.heard("[unk] help me [unk]", phrase))
        assertFalse(VoiceMatch.heard("please help me", phrase))
    }

    @Test
    fun `the words must come in order`() {
        assertFalse(VoiceMatch.heard("now me help please", phrase))
    }

    @Test
    fun `only noise or nothing is not the phrase`() {
        assertFalse(VoiceMatch.heard("[unk]", phrase))
        assertFalse(VoiceMatch.heard("", phrase))
        assertFalse(VoiceMatch.heard("please help me now", emptyList()))
    }

    @Test
    fun `words the model does not know are left out of what must be heard`() {
        // "sarthi" is not in the English model: Vosk never returns it.
        val known = VoiceMatch.words("sarthi help me").filter { it != "sarthi" }
        assertTrue(VoiceMatch.heard("help me", known))
    }

    @Test
    fun `Hindi phrases match too`() {
        val hi = VoiceMatch.words("मुझे बचाओ अभी")
        assertTrue(VoiceMatch.heard("[unk] मुझे बचाओ अभी", hi))
    }

    @Test
    fun `text is read from final and partial results`() {
        assertEquals("please help", VoiceMatch.textOf("""{"text" : "please help"}"""))
        assertEquals("please help", VoiceMatch.textOf("""{"partial" : "please help"}"""))
        assertEquals("", VoiceMatch.textOf("not json"))
    }
}
