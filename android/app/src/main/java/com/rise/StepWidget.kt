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

class StepWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == "com.rise.WIDGET_UPDATE") {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val appWidgetIds = appWidgetManager.getAppWidgetIds(android.content.ComponentName(context, StepWidget::class.java))
            onUpdate(context, appWidgetManager, appWidgetIds)
        }
    }

    companion object {
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_habit_sensor)
            views.setTextViewText(R.id.habit_title, "STEP LEGEND")
            views.setImageViewResource(R.id.app_logo, R.drawable.widget_icon_steps)
            views.setImageViewResource(R.id.habit_empty_icon, R.drawable.widget_icon_steps)
            
            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val sensorDataStr = sharedPref.getString("sensorData", "{}") ?: "{}"
            
            try {
                val sensorData = JSONObject(sensorDataStr)
                val stepData = sensorData.optJSONObject("pedometer")
                
                if (stepData != null && stepData.optBoolean("exists", false)) {
                    val progress = stepData.optDouble("progress", 0.0)
                    val goal = stepData.optDouble("goal", 10000.0)
                    val habitId = stepData.optString("id", "")
                    val isCompleted = stepData.optBoolean("isCompleted", false) || (progress >= goal && goal > 0)

                    views.setViewVisibility(R.id.habit_content, View.VISIBLE)
                    views.setViewVisibility(R.id.habit_empty_container, View.GONE)
                    
                    views.setTextViewText(R.id.sensor_value, progress.toInt().toString())
                    views.setTextViewText(R.id.sensor_unit, "STEPS")
                    views.setTextViewText(R.id.habit_goal_text, "GOAL: ${goal.toInt()}")
                    views.setProgressBar(R.id.habit_progress, goal.toInt(), progress.toInt(), false)

                    // Dynamic animations: Completed celebration vs In-progress stepping
                    if (isCompleted) {
                        views.setTextViewText(R.id.habit_status_badge, "COMPLETED ✓")
                        views.setTextColor(R.id.habit_status_badge, 0xFF4ADE80.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_completed_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_completed_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_completed_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "✓ GOAL REACHED")
                    } else {
                        views.setTextViewText(R.id.habit_status_badge, "IN PROGRESS")
                        views.setTextColor(R.id.habit_status_badge, 0xFFD71921.toInt())
                        views.setImageViewResource(R.id.habit_anim_frame1, R.drawable.anim_step_frame1)
                        views.setImageViewResource(R.id.habit_anim_frame2, R.drawable.anim_step_frame2)
                        views.setImageViewResource(R.id.habit_anim_frame3, R.drawable.anim_step_frame3)
                        views.setTextViewText(R.id.habit_action_btn, "+100 STEPS")
                    }

                    // Main card opens Habit Detail
                    val detailIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$habitId/habit")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_content, PendingIntent.getActivity(context, 100 + appWidgetId, detailIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

                    // Action button adds +100 steps
                    val actionIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://habit-action/increment/$habitId/100")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_action_btn, PendingIntent.getActivity(context, 102 + appWidgetId, actionIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                    
                } else {
                    views.setViewVisibility(R.id.habit_content, View.GONE)
                    views.setViewVisibility(R.id.habit_empty_container, View.VISIBLE)
                    views.setTextViewText(R.id.habit_empty_btn, "+ LINK STEPS")
                    
                    val intent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://add-sensor-habit/step_legend")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    views.setOnClickPendingIntent(R.id.habit_empty_container, PendingIntent.getActivity(context, 101 + appWidgetId, intent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                }
            } catch (e: Exception) {
                Log.e("StepWidget", "Error updating widget", e)
            }

            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
