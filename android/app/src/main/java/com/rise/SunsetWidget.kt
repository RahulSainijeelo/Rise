package com.rise

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import android.util.Log

class SunsetWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == "com.rise.WIDGET_UPDATE") {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val appWidgetIds = appWidgetManager.getAppWidgetIds(android.content.ComponentName(context, SunsetWidget::class.java))
            onUpdate(context, appWidgetManager, appWidgetIds)
        }
    }

    companion object {
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_habit_sensor)
            views.setTextViewText(R.id.habit_title, "DIGITAL SUNSET")
            views.setImageViewResource(R.id.app_logo, R.drawable.widget_icon_sunset)
            views.setImageViewResource(R.id.habit_empty_icon, R.drawable.widget_icon_sunset)

            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val sensorDataStr = sharedPref.getString("sensorData", "{}") ?: "{}"
            
            try {
                val sensorData = JSONObject(sensorDataStr)
                val habitData = sensorData.optJSONObject("screen")
                
                if (habitData != null && habitData.optBoolean("exists", false)) {
                    val isCompleted = habitData.optBoolean("isCompleted", false)
                    val habitId = habitData.optString("id", "")

                    views.setViewVisibility(R.id.habit_content, View.VISIBLE)
                    views.setViewVisibility(R.id.habit_empty_container, View.GONE)
                    
                    views.setTextViewText(R.id.sensor_value, if (isCompleted) "DONE" else "ACTIVE")
                    views.setTextViewText(R.id.sensor_unit, "PHONE USAGE")
                    
                    views.setTextViewText(R.id.habit_goal_text, "GOAL: OFF AT SUNSET")
                    views.setProgressBar(R.id.habit_progress, 1, if (isCompleted) 1 else 0, false)

                    if (isCompleted) {
                        views.setTextViewText(R.id.habit_status_badge, "COMPLETED ✓")
                        views.setTextColor(R.id.habit_status_badge, 0xFF4ADE80.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_completed_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_completed_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_completed_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "✓ NIGHT COMPLETED")
                    } else {
                        views.setTextViewText(R.id.habit_status_badge, "IN PROGRESS")
                        views.setTextColor(R.id.habit_status_badge, 0xFFD71921.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_sunset_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_sunset_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_sunset_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "🌙 WIND DOWN ✓")
                    }
                    
                    val detailIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$habitId/habit")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_content, PendingIntent.getActivity(context, 500 + appWidgetId, detailIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

                    val toggleIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://habit-action/toggle/$habitId")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_action_btn, PendingIntent.getActivity(context, 502 + appWidgetId, toggleIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                } else {
                    views.setViewVisibility(R.id.habit_content, View.GONE)
                    views.setViewVisibility(R.id.habit_empty_container, View.VISIBLE)
                    views.setTextViewText(R.id.habit_empty_btn, "+ LINK SUNSET")
                    
                    val intent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://add-sensor-habit/digital_sunset")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_empty_container, PendingIntent.getActivity(context, 501 + appWidgetId, intent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                }
            } catch (e: Exception) { Log.e("SunsetWidget", "Error", e) }
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
