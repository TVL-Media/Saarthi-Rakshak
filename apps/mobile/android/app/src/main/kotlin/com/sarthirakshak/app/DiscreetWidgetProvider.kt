package com.sarthirakshak.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * Discreet mode (feature 4): a plain-looking "Quick help" widget. It opens the same SOS countdown
 * (quiet if the user chose that); the app keeps its real name and icon everywhere.
 */
class DiscreetWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_ACTION, "sos")
            putExtra(MainActivity.EXTRA_TRIGGER, "discreet")
        }
        val pi = PendingIntent.getActivity(context, 11, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.widget_discreet)
            views.setOnClickPendingIntent(R.id.discreet_button, pi)
            manager.updateAppWidget(id, views)
        }
    }
}
