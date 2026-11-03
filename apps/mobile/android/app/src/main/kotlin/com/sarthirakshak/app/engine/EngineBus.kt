package com.sarthirakshak.app.engine

import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.EventChannel

/** Passes engine events to the Flutter screens when they are open. */
object EngineBus {
    private val main = Handler(Looper.getMainLooper())

    @Volatile
    var sink: EventChannel.EventSink? = null

    /** Opened from the widget, tile or a notification before the screens were ready. */
    @Volatile
    var pendingLaunch: Map<String, Any?>? = null

    /** The newest engine state, for getState(). */
    @Volatile
    var lastState: Map<String, Any?> = mapOf("mode" to "idle")

    fun emit(type: String, data: Map<String, Any?>) {
        if (type == "state") lastState = data
        main.post { sink?.success(mapOf("type" to type, "data" to data)) }
    }
}
