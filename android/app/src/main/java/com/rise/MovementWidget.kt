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

class MovementWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == "com.rise.WIDGET_UPDATE") {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val appWidgetIds = appWidgetManager.getAppWidgetIds(android.content.ComponentName(context, MovementWidget::class.java))
            onUpdate(context, appWidgetManager, appWidgetIds)
        }
    }

    companion object {
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_habit_sensor)
            views.setTextViewText(R.id.habit_title, "IMMEDIATE RISE")
            views.setImageViewResource(R.id.app_logo, R.drawable.widget_icon_movement)
            views.setImageViewResource(R.id.habit_empty_icon, R.drawable.widget_icon_movement)

            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val sensorDataStr = sharedPref.getString("sensorData", "{}") ?: "{}"
            
            try {
                val sensorData = JSONObject(sensorDataStr)
                val habitData = sensorData.optJSONObject("movement")
                
                if (habitData != null && habitData.optBoolean("exists", false)) {
                    val progress = habitData.optDouble("progress", 0.0)
                    val goal = habitData.optDouble("goal", 50.0)
                    val habitId = habitData.optString("id", "")
                    val isCompleted = habitData.optBoolean("isCompleted", false) || (progress >= goal && goal > 0)

                    views.setViewVisibility(R.id.habit_content, View.VISIBLE)
                    views.setViewVisibility(R.id.habit_empty_container, View.GONE)
                    
                    views.setTextViewText(R.id.sensor_value, progress.toInt().toString())
                    views.setTextViewText(R.id.sensor_unit, "STEPS TO RISE")
                    
                    views.setTextViewText(R.id.habit_goal_text, "GOAL: ${goal.toInt()}")
                    views.setProgressBar(R.id.habit_progress, goal.toInt(), progress.toInt(), false)

                    if (isCompleted) {
                        views.setTextViewText(R.id.habit_status_badge, "COMPLETED ✓")
                        views.setTextColor(R.id.habit_status_badge, 0xFF4ADE80.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_completed_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_completed_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_completed_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "✓ RISE COMPLETE")
                    } else {
                        views.setTextViewText(R.id.habit_status_badge, "IN PROGRESS")
                        views.setTextColor(R.id.habit_status_badge, 0xFFD71921.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_movement_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_movement_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_movement_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "⚡ RISE NOW ✓")
                    }
                    
                    val detailIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$habitId/habit")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_content, PendingIntent.getActivity(context, 400 + appWidgetId, detailIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

                    val toggleIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://habit-action/toggle/$habitId")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_action_btn, PendingIntent.getActivity(context, 402 + appWidgetId, toggleIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                } else {
                    views.setViewVisibility(R.id.habit_content, View.GONE)
                    views.setViewVisibility(R.id.habit_empty_container, View.VISIBLE)
                    views.setTextViewText(R.id.habit_empty_btn, "+ LINK RISE")
                    
                    val intent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://add-sensor-habit/immediate_rise")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_empty_container, PendingIntent.getActivity(context, 401 + appWidgetId, intent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                }
            } catch (e: Exception) { Log.e("MovementWidget", "Error", e) }
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
