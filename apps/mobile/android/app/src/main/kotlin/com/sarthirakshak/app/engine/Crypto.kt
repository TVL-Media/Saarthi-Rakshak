package com.sarthirakshak.app.engine

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM with keys that live only in this phone's Android Keystore and can never be read out.
 * Used for SOS audio (nobody else, not the server or an admin, can ever play it) and our session
 * token. Output = 12-byte IV followed by the ciphertext.
 */
object Crypto {
    const val AUDIO_KEY = "sarthi_audio_v1"
    const val SESSION_KEY = "sarthi_session_v1"

    private fun key(alias: String): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as SecretKey?)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    /** A key that was invalidated or damaged (restore, lock-screen change, some OEM bugs) is replaced. */
    private fun reset(alias: String) {
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
        } catch (e: Exception) {
            // nothing to delete
        }
    }

    fun encrypt(alias: String, plain: ByteArray): ByteArray {
        fun attempt(): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key(alias))
            return cipher.iv + cipher.doFinal(plain)
        }
        return try {
            attempt()
        } catch (e: Exception) {
            // The session token (not the audio key: old clips would be lost) is safe to re-key.
            if (alias != SESSION_KEY) throw e
            reset(alias)
            attempt()
        }
    }

    fun decrypt(alias: String, data: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(alias), GCMParameterSpec(128, data, 0, 12))
        return cipher.doFinal(data, 12, data.size - 12)
    }
}
