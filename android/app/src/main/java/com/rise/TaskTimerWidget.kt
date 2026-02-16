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

class TaskTimerWidget : AppWidgetProvider() {
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
                val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, TaskTimerWidget::class.java))
                onUpdate(context, appWidgetManager, ids)
            }
            "com.rise.TIMER_ACTION" -> {
                val action = intent.getStringExtra("timerAction") ?: return
                val id = intent.getStringExtra("itemId") ?: ""
                
                Log.d("TaskTimerWidget", "Action: $action for $id")
                
                // For now, toggle running state in SharedPreferences for immediate UI feedback
                // and notify JS side
                updateTimerInPrefs(context, action)
                
                // Open app to handle logic (Headless task would be better but this is simpler for now)
                val mainIntent = Intent(context, MainActivity::class.java).apply {
                    this.action = "com.rise.TIMER_ACTION"
                    putExtra("timerAction", action)
                    putExtra("itemId", id)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                context.startActivity(mainIntent)
            }
        }
    }

    private fun updateTimerInPrefs(context: Context, action: String) {
        try {
            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val timerDataStr = sharedPref.getString("timerData", null) ?: return
            val timerData = JSONObject(timerDataStr)
            
            when (action) {
                "pause" -> timerData.put("isRunning", false)
                "resume" -> timerData.put("isRunning", true)
                "stop" -> {
                    with(sharedPref.edit()) {
                        remove("timerData")
                        apply()
                    }
                    val appWidgetManager = AppWidgetManager.getInstance(context)
                    val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, TaskTimerWidget::class.java))
                    onUpdate(context, appWidgetManager, ids)
                    return
                }
            }
            
            with(sharedPref.edit()) {
                putString("timerData", timerData.toString())
                apply()
            }
            
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, TaskTimerWidget::class.java))
            onUpdate(context, appWidgetManager, ids)
        } catch (e: Exception) {
            Log.e("TaskTimerWidget", "Error updating timer in prefs", e)
        }
    }

    companion object {
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.task_timer_widget)
            
            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val timerDataStr = sharedPref.getString("timerData", null)
            
            if (timerDataStr == null || timerDataStr == "null") {
                views.setViewVisibility(R.id.timer_content, View.VISIBLE)
                views.setTextViewText(R.id.timer_display, "--:--")
                views.setTextViewText(R.id.timer_task_name, "No Active Task")
                views.setViewVisibility(R.id.timer_play_pause, View.GONE)
                views.setViewVisibility(R.id.timer_stop, View.GONE)
                
                // Logo click opens app
                val intent = Intent(context, MainActivity::class.java)
                val pendingIntent = PendingIntent.getActivity(context, 0, intent, 
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                views.setOnClickPendingIntent(R.id.timer_content, pendingIntent)
            } else {
                try {
                    val timerData = JSONObject(timerDataStr)
                    val title = timerData.optString("title", "Task")
                    val timeLeft = timerData.optInt("timeLeft", 0)
                    val isRunning = timerData.optBoolean("isRunning", false)
                    val id = timerData.optString("id", "")

                    views.setViewVisibility(R.id.timer_play_pause, View.VISIBLE)
                    views.setViewVisibility(R.id.timer_stop, View.VISIBLE)
                    
                    val minutes = timeLeft / 60
                    val seconds = timeLeft % 60
                    views.setTextViewText(R.id.timer_display, String.format("%02d:%02d", minutes, seconds))
                    views.setTextViewText(R.id.timer_task_name, title)
                    
                    views.setTextViewText(R.id.timer_play_pause, if (isRunning) "PAUSE" else "RESUME")
                    
                    // Play/Pause button
                    val action = if (isRunning) "pause" else "resume"
                    val pauseIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://timer-action/$action/$id")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val pausePendingIntent = PendingIntent.getActivity(context, 200, pauseIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.timer_play_pause, pausePendingIntent)
                    
                    // Stop button
                    val stopIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://timer-action/stop/$id")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val stopPendingIntent = PendingIntent.getActivity(context, 201, stopIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.timer_stop, stopPendingIntent)
                    
                    // Display click - open app to details
                    val detailIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$id/${timerData.optString("type", "task")}")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    val detailPendingIntent = PendingIntent.getActivity(context, 202, detailIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.timer_content, detailPendingIntent)
                    
                } catch (e: Exception) {
                    Log.e("TaskTimerWidget", "Errorparsing timer data", e)
                }
            }
            
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
