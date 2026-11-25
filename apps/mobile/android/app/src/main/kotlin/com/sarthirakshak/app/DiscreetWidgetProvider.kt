package com.sarthirakshak.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.widget.RemoteViews

/**
 * Discreet mode (feature 4): a plain-looking "Quick help" widget. It opens the same SOS countdown
 * (quiet if the user chose that); the app keeps its real name and icon everywhere.
 * The rounded box behind the symbol can be turned off in Discreet mode (symbol and name only).
 */
class DiscreetWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_ACTION, "sos")
            putExtra(MainActivity.EXTRA_TRIGGER, "discreet")
        }
        val pi = PendingIntent.getActivity(context, 11, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val tile = showTile(context)
        for (id in ids) {
            val views = RemoteViews(context.packageName, R.layout.widget_discreet)
            views.setOnClickPendingIntent(R.id.discreet_button, pi)
            if (!tile) {
                // No box: the symbol sits on the wallpaper, in white like the name, so it stays visible.
                views.setInt(R.id.discreet_icon, "setBackgroundResource", 0)
                views.setInt(R.id.discreet_icon, "setColorFilter", Color.WHITE)
            }
            manager.updateAppWidget(id, views)
        }
    }

    companion object {
        private const val PREFS = "sarthi_widget"
        private const val KEY_TILE = "tile"

        /** The rounded box behind the symbol is shown (on unless turned off). */
        fun showTile(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_TILE, true)

        fun setShowTile(context: Context, on: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_TILE, on).apply()
            refresh(context)
        }

        /** Redraws the widgets already on the home screen (after a setting or an app update). */
        fun refresh(context: Context) {
            try {
                val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, DiscreetWidgetProvider::class.java))
                if (ids.isNotEmpty()) {
                    context.sendBroadcast(Intent(context, DiscreetWidgetProvider::class.java)
                        .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids))
                }
            } catch (e: Exception) {
                // ignored: the widget is redrawn the next time the launcher asks
            }
        }
    }
}
