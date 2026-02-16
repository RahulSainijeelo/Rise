package com.rise

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import android.util.Log

class HabitControlWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        
        when (intent.action) {
            "com.rise.WIDGET_UPDATE" -> {
                val appWidgetManager = AppWidgetManager.getInstance(context)
                val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, HabitControlWidget::class.java))
                onUpdate(context, appWidgetManager, ids)
            }
            "com.rise.TOGGLE_HABIT_WIDGET" -> {
                val id = intent.getStringExtra("itemId") ?: return
                
                // Open app to handle toggle
                val mainIntent = Intent(context, MainActivity::class.java).apply {
                    this.action = "com.rise.TOGGLE_HABIT"
                    putExtra("itemId", id)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                context.startActivity(mainIntent)
            }
        }
    }

    companion object {
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.habit_control_widget)
            
            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val historyDataStr = sharedPref.getString("habitHistoryData", "{}") ?: "{}"
            val pinnedHabitId = sharedPref.getString("pinnedHabitId", null)
            
            try {
                val allHistory = JSONObject(historyDataStr)
                val keys = allHistory.keys()
                
                // Use pinned habit if it exists in history, otherwise pick first, or show empty
                val habitId = if (pinnedHabitId != null && allHistory.has(pinnedHabitId)) {
                    pinnedHabitId
                } else if (keys.hasNext()) {
                    keys.next()
                } else {
                    null
                }

                if (habitId == null) {
                    views.setTextViewText(R.id.habit_title, "NO HABITS")
                    views.setTextViewText(R.id.habit_streak_text, "PIN A HABIT FROM APP")
                    views.setViewVisibility(R.id.habit_calendar_grid, View.GONE)
                    views.setViewVisibility(R.id.habit_toggle_btn, View.GONE)
                } else {
                    val habitData = allHistory.getJSONObject(habitId)
                    
                    views.setTextViewText(R.id.habit_title, habitData.optString("title", "HABIT"))
                    views.setTextViewText(R.id.habit_streak_text, "STREAK: ${habitData.optInt("streak", 0)}")
                    
                    views.setViewVisibility(R.id.habit_calendar_grid, View.VISIBLE)
                    views.setViewVisibility(R.id.habit_toggle_btn, View.VISIBLE)

                    // Setup GridView Adapter - Ensure unique data to prevent caching issues
                    val serviceIntent = Intent(context, HabitGridService::class.java).apply {
                        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                        putExtra("habitId", habitId)
                        data = Uri.parse("rise://habit-grid/$habitId/$appWidgetId")
                    }
                    views.setRemoteAdapter(R.id.habit_calendar_grid, serviceIntent)
                    
                    // Toggle button click
                    val toggleIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://habit-toggle/$habitId")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val togglePendingIntent = PendingIntent.getActivity(context, 300 + appWidgetId, toggleIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.habit_toggle_btn, togglePendingIntent)
                    
                    // Interaction - open app
                    val detailIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$habitId/habit")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val detailPendingIntent = PendingIntent.getActivity(context, 301 + appWidgetId, detailIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.habit_title, detailPendingIntent)
                    views.setOnClickPendingIntent(R.id.app_logo, detailPendingIntent)
                }
            } catch (e: Exception) {
                Log.e("HabitControlWidget", "Error updating widget", e)
                views.setTextViewText(R.id.habit_title, "WIDGET ERROR")
            }
            
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
