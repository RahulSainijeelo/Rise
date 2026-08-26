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

class SilenceWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == "com.rise.WIDGET_UPDATE") {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val appWidgetIds = appWidgetManager.getAppWidgetIds(android.content.ComponentName(context, SilenceWidget::class.java))
            onUpdate(context, appWidgetManager, appWidgetIds)
        }
    }

    companion object {
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_habit_sensor)
            views.setTextViewText(R.id.habit_title, "DEEP SILENCE")
            views.setImageViewResource(R.id.app_logo, R.drawable.widget_icon_silence)
            views.setImageViewResource(R.id.habit_empty_icon, R.drawable.widget_icon_silence)

            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val sensorDataStr = sharedPref.getString("sensorData", "{}") ?: "{}"
            
            try {
                val sensorData = JSONObject(sensorDataStr)
                val habitData = sensorData.optJSONObject("noise")
                
                if (habitData != null && habitData.optBoolean("exists", false)) {
                    val progressSec = habitData.optDouble("progress", 0.0)
                    val goalSec = habitData.optDouble("goal", 3600.0)
                    val habitId = habitData.optString("id", "")
                    val isCompleted = habitData.optBoolean("isCompleted", false) || (progressSec >= goalSec && goalSec > 0)

                    views.setViewVisibility(R.id.habit_content, View.VISIBLE)
                    views.setViewVisibility(R.id.habit_empty_container, View.GONE)
                    
                    val mins = (progressSec / 60).toInt()
                    views.setTextViewText(R.id.sensor_value, mins.toString())
                    views.setTextViewText(R.id.sensor_unit, "MINUTES")
                    
                    views.setTextViewText(R.id.habit_goal_text, "GOAL: ${(goalSec/60).toInt()}M")
                    views.setProgressBar(R.id.habit_progress, goalSec.toInt(), progressSec.toInt(), false)

                    if (isCompleted) {
                        views.setTextViewText(R.id.habit_status_badge, "COMPLETED ✓")
                        views.setTextColor(R.id.habit_status_badge, 0xFF4ADE80.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_completed_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_completed_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_completed_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "✓ SILENCE ACHIEVED")
                    } else {
                        views.setTextViewText(R.id.habit_status_badge, "IN PROGRESS")
                        views.setTextColor(R.id.habit_status_badge, 0xFFD71921.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_silence_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_silence_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_silence_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "▶ +5M SILENCE")
                    }
                    
                    val detailIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$habitId/habit")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_content, PendingIntent.getActivity(context, 300 + appWidgetId, detailIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

                    val actionIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://habit-action/silence-toggle/$habitId")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_action_btn, PendingIntent.getActivity(context, 302 + appWidgetId, actionIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                } else {
                    views.setViewVisibility(R.id.habit_content, View.GONE)
                    views.setViewVisibility(R.id.habit_empty_container, View.VISIBLE)
                    views.setTextViewText(R.id.habit_empty_btn, "+ LINK SILENCE")
                    
                    val intent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://add-sensor-habit/deep_silence")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_empty_container, PendingIntent.getActivity(context, 301 + appWidgetId, intent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                }
            } catch (e: Exception) { Log.e("SilenceWidget", "Error", e) }
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
