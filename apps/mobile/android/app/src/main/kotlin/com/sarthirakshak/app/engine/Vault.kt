package com.sarthirakshak.app.engine

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Evidence vault encryption (features 12, 13, 18). No backdoor:
 * - The vault key (random, 256-bit) is kept on the phone wrapped by an Android Keystore key that
 *   only works for 2 minutes after fingerprint, face or phone PIN. Adding a fingerprint does not
 *   cancel it; removing the phone lock does (then the recovery phrase restores it).
 * - Each file has its own random key; files are encrypted in 1 MB chunks (AES-256-GCM), so even a
 *   200 MB video never has to fit in memory.
 * - The server only ever receives encrypted files and keys it cannot open.
 */
object Vault {
    private const val WRAP_KEY = "sarthi_vault_wrap_v1"
    private const val PREFS = "sarthi_vault"
    private const val CHUNK = 1024 * 1024
    private val MAGIC = byteArrayOf('S'.code.toByte(), 'R'.code.toByte(), 'V'.code.toByte(), '1'.code.toByte())
    private val random = SecureRandom()

    class AuthNeeded : Exception("Unlock with fingerprint, face or phone PIN")

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun wrapKey(create: Boolean): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(WRAP_KEY, null) as SecretKey?)?.let { return it }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(WRAP_KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(120, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            spec.setUserAuthenticationValidityDurationSeconds(120)
        }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(spec.build())
        return gen.generateKey()
    }

    /** A vault key is stored on this phone. */
    fun exists(context: Context) = prefs(context).getString("wrapped", null) != null

    /** Stores the vault key (new vault, or restored with the recovery phrase). Needs a recent unlock. */
    fun store(context: Context, rawKeyB64: String) {
        val raw = Base64.decode(rawKeyB64, Base64.NO_WRAP)
        require(raw.size == 32) { "A vault key is 32 bytes" }
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, wrapKey(create = true))
            val wrapped = cipher.iv + cipher.doFinal(raw)
            prefs(context).edit().putString("wrapped", Base64.encodeToString(wrapped, Base64.NO_WRAP)).apply()
        } catch (e: UserNotAuthenticatedException) {
            throw AuthNeeded()
        }
    }

    /** The vault key (base64), if the user unlocked in the last 2 minutes. */
    fun unlock(context: Context): String? {
        val wrapped = prefs(context).getString("wrapped", null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
        val key = wrapKey(create = false) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, wrapped, 0, 12))
            Base64.encodeToString(cipher.doFinal(wrapped, 12, wrapped.size - 12), Base64.NO_WRAP)
        } catch (e: UserNotAuthenticatedException) {
            throw AuthNeeded()
        } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
            // The phone lock was removed: the vault must be restored with the recovery phrase.
            forget(context)
            null
        }
    }

    /** Removes the vault key from this phone (logout / account deleted). Evidence stays encrypted. */
    fun forget(context: Context) {
        prefs(context).edit().clear().apply()
        try {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(WRAP_KEY)
        } catch (e: Exception) {
            // nothing to delete
        }
    }

    fun newKey(): String = Base64.encodeToString(ByteArray(32).also { random.nextBytes(it) }, Base64.NO_WRAP)

    private fun aes(keyB64: String) = SecretKeySpec(Base64.decode(keyB64, Base64.NO_WRAP), "AES")

    /** Small values (details, file keys): base64(iv + ciphertext + tag). */
    fun encryptBytes(keyB64: String, plain: ByteArray): String {
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, aes(keyB64), GCMParameterSpec(128, iv))
        return Base64.encodeToString(iv + cipher.doFinal(plain), Base64.NO_WRAP)
    }

    fun decryptBytes(keyB64: String, lockedB64: String): ByteArray {
        val data = Base64.decode(lockedB64, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, aes(keyB64), GCMParameterSpec(128, data, 0, 12))
        return cipher.doFinal(data, 12, data.size - 12)
    }

    /** SHA-256 (hex) of a file, read in pieces. */
    fun sha256(file: File): String = sha256(file.inputStream())

    fun sha256(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        input.use { s ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = s.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun chunkNonce(base: ByteArray, index: Int): ByteArray {
        val n = base.copyOf()
        val i = ByteBuffer.allocate(4).putInt(index).array()
        for (k in 0 until 4) n[8 + k] = (n[8 + k].toInt() xor i[k].toInt()).toByte()
        return n
    }

    private fun aad(index: Int, last: Boolean) = ByteBuffer.allocate(5).putInt(index).put(if (last) 1 else 0).array()

    /**
     * Encrypts [input] to [output] with [fileKeyB64] in one pass (the file is read once). Returns
     * the SHA-256 of the original (the tamper-evident fingerprint) and the encrypted size.
     */
    fun encryptFile(input: File, output: File, fileKeyB64: String): Pair<String, Long> {
        val md = MessageDigest.getInstance("SHA-256")
        val base = ByteArray(12).also { random.nextBytes(it) }
        val key = aes(fileKeyB64)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // Two buffers: the chunk being encrypted and the next one (to know which chunk is last).
        var buf = ByteArray(CHUNK)
        var next = ByteArray(CHUNK)
        DataOutputStream(output.outputStream().buffered(256 * 1024)).use { out ->
            out.write(MAGIC)
            out.write(base)
            input.inputStream().use { inp ->
                var n = inp.readNBytesCompat(buf)
                var index = 0
                while (true) {
                    val m = if (n == CHUNK) inp.readNBytesCompat(next) else 0
                    val last = m <= 0
                    md.update(buf, 0, n)
                    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, chunkNonce(base, index)))
                    cipher.updateAAD(aad(index, last))
                    val enc = cipher.doFinal(buf, 0, n)
                    out.writeInt(enc.size)
                    out.write(enc)
                    if (last) break
                    val t = buf
                    buf = next
                    next = t
                    n = m
                    index++
                }
            }
        }
        val fingerprint = md.digest().joinToString("") { "%02x".format(it) }
        return fingerprint to output.length()
    }

    /** Decrypts a file made by [encryptFile]; fails if anything was changed, cut or reordered. */
    fun decryptFile(input: File, output: File, fileKeyB64: String) {
        val key = aes(fileKeyB64)
        val total = input.length()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        DataInputStream(input.inputStream().buffered(256 * 1024)).use { inp ->
            val magic = ByteArray(4).also { inp.readFully(it) }
            require(magic.contentEquals(MAGIC)) { "Not a vault file" }
            val base = ByteArray(12).also { inp.readFully(it) }
            var read = 16L
            output.outputStream().buffered(256 * 1024).use { out ->
                var index = 0
                while (true) {
                    val size = inp.readInt()
                    require(size in 16..(CHUNK + 16)) { "Damaged vault file" }
                    val enc = ByteArray(size).also { inp.readFully(it) }
                    read += 4 + size
                    // Last chunk = the end of the file (counted, not guessed from available()).
                    val last = read >= total
                    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, chunkNonce(base, index)))
                    cipher.updateAAD(aad(index, last))
                    out.write(cipher.doFinal(enc))
                    if (last) break
                    index++
                }
            }
        }
    }

    private fun InputStream.readNBytesCompat(buf: ByteArray): Int {
        var total = 0
        while (total < buf.size) {
            val r = read(buf, total, buf.size - total)
            if (r < 0) break
            total += r
        }
        return total
    }
}
