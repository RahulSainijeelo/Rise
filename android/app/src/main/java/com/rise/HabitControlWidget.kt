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
            
            try {
                val allHistory = JSONObject(historyDataStr)
                val keys = allHistory.keys()
                
                if (!keys.hasNext()) {
                    views.setTextViewText(R.id.habit_title, "NO HABITS")
                    views.setViewVisibility(R.id.habit_calendar_grid, View.GONE)
                    views.setViewVisibility(R.id.habit_toggle_btn, View.GONE)
                } else {
                    // Pick the first habit for now or one that is "starred" (not implemented yet)
                    val firstId = keys.next()
                    val habitData = allHistory.getJSONObject(firstId)
                    
                    views.setTextViewText(R.id.habit_title, habitData.optString("title", "HABIT"))
                    views.setTextViewText(R.id.habit_streak_text, "STREAK: ${habitData.optInt("streak", 0)}")
                    
                    views.setViewVisibility(R.id.habit_calendar_grid, View.VISIBLE)
                    views.setViewVisibility(R.id.habit_toggle_btn, View.VISIBLE)

                    // Setup GridView Adapter
                    val serviceIntent = Intent(context, HabitGridService::class.java).apply {
                        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                        putExtra("habitId", firstId)
                        data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
                    }
                    views.setRemoteAdapter(R.id.habit_calendar_grid, serviceIntent)
                    
                    // Toggle button click
                    val toggleIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://habit-toggle/$firstId")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val togglePendingIntent = PendingIntent.getActivity(context, 300, toggleIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.habit_toggle_btn, togglePendingIntent)
                    
                    // Logo click opens app
                    val intent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$firstId/habit")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    val pendingIntent = PendingIntent.getActivity(context, 301, intent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.app_logo, pendingIntent)
                    views.setOnClickPendingIntent(R.id.habit_title, pendingIntent)
                }
            } catch (e: Exception) {
                Log.e("HabitControlWidget", "Error updating widget", e)
            }
            
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
