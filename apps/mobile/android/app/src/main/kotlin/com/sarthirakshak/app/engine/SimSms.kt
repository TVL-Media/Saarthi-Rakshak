package com.sarthirakshak.app.engine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager

/** SOS by SMS from the user's own SIM (no internet). Does not go through our server or DLT. */
object SimSms {
    fun allowed(context: Context) =
        context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    /** Returns true if handed to the phone's SMS system. */
    fun send(context: Context, phone: String, text: String): Boolean = try {
        val sms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(SmsManager::class.java)
        } else {
            @Suppress("DEPRECATION")
            SmsManager.getDefault()
        }
        sms.sendMultipartTextMessage(phone, null, sms.divideMessage(text), null, null)
        true
    } catch (e: Exception) {
        false
    }
}
