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
import org.json.JSONArray
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
                updateTimerInPrefs(context, action)
                
                val mainIntent = Intent(context, MainActivity::class.java).apply {
                    this.action = "com.rise.TIMER_ACTION"
                    putExtra("timerAction", action)
                    putExtra("itemId", id)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                context.startActivity(mainIntent)
            }
            "com.rise.SWITCH_TASK" -> {
                val direction = intent.getIntExtra("direction", 1)
                switchActiveTask(context, direction)
            }
        }
    }

    private fun switchActiveTask(context: Context, direction: Int) {
        try {
            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val dataString = sharedPref.getString("widgetData", "[]") ?: "[]"
            val items = JSONArray(dataString)
            
            // Filter tasks and habits that are timers
            val tasks = mutableListOf<JSONObject>()
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                val type = item.optString("type")
                val habitType = item.optString("habitType")
                if (type == "task" || (type == "habit" && habitType == "timer")) {
                    tasks.add(item)
                }
            }
            
            if (tasks.isEmpty()) return

            val timerDataStr = sharedPref.getString("timerData", null)
            val currentId = if (timerDataStr != null && timerDataStr != "null") {
                JSONObject(timerDataStr).optString("id")
            } else ""

            var nextIndex = 0
            if (currentId.isNotEmpty()) {
                val currentIndex = tasks.indexOfFirst { it.optString("id") == currentId }
                if (currentIndex != -1) {
                    nextIndex = (currentIndex + direction) % tasks.size
                    if (nextIndex < 0) nextIndex = tasks.size - 1
                }
            }

            val nextTask = tasks[nextIndex]
            val newTimerData = JSONObject().apply {
                put("id", nextTask.optString("id"))
                put("title", nextTask.optString("title"))
                put("timeLeft", 0) 
                put("isRunning", false)
                put("type", nextTask.optString("type"))
            }

            with(sharedPref.edit()) {
                putString("timerData", newTimerData.toString())
                apply()
            }

            val appWidgetManager = AppWidgetManager.getInstance(context)
            val ids = appWidgetManager.getAppWidgetIds(ComponentName(context, TaskTimerWidget::class.java))
            onUpdate(context, appWidgetManager, ids)
            
        } catch (e: Exception) {
            Log.e("TaskTimerWidget", "Error switching task", e)
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
                    timerData.put("isRunning", false)
                    timerData.put("timeLeft", 0)
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
            
            // Set up switch intents regardless of data
            val nextIntent = Intent(context, TaskTimerWidget::class.java).apply {
                action = "com.rise.SWITCH_TASK"
                putExtra("direction", 1)
            }
            views.setOnClickPendingIntent(R.id.timer_next, PendingIntent.getBroadcast(context, 300 + appWidgetId, nextIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

            val prevIntent = Intent(context, TaskTimerWidget::class.java).apply {
                action = "com.rise.SWITCH_TASK"
                putExtra("direction", -1)
            }
            views.setOnClickPendingIntent(R.id.timer_prev, PendingIntent.getBroadcast(context, 301 + appWidgetId, prevIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))

            try {
                val timerDataString = if (timerDataStr == null || timerDataStr == "null") null else timerDataStr
                val timerData = if (timerDataString != null) JSONObject(timerDataString) else null
                
                if (timerData == null) {
                    views.setViewVisibility(R.id.timer_content, View.VISIBLE)
                    views.setTextViewText(R.id.timer_display, "--:--")
                    views.setTextViewText(R.id.timer_task_name, "No Active Task")
                    views.setViewVisibility(R.id.timer_play_pause, View.GONE)
                    views.setViewVisibility(R.id.timer_stop, View.GONE)
                    
                    val intent = Intent(context, MainActivity::class.java)
                    val pendingIntent = PendingIntent.getActivity(context, 250 + appWidgetId, intent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.timer_content, pendingIntent)
                } else {
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
                    
                    val action = if (isRunning) "pause" else "resume"
                    val pauseIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://timer-action/$action/$id")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val pausePendingIntent = PendingIntent.getActivity(context, 200 + appWidgetId, pauseIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.timer_play_pause, pausePendingIntent)
                    
                    val stopIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://timer-action/stop/$id")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val stopPendingIntent = PendingIntent.getActivity(context, 201 + appWidgetId, stopIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.timer_stop, stopPendingIntent)
                    
                    val detailIntent = Intent(context, MainActivity::class.java).apply {
                        this.action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$id/${timerData.optString("type", "task")}")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    val detailPendingIntent = PendingIntent.getActivity(context, 202 + appWidgetId, detailIntent, 
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    views.setOnClickPendingIntent(R.id.timer_content, detailPendingIntent)
                    views.setOnClickPendingIntent(R.id.app_logo, detailPendingIntent)
                }
            } catch (e: Exception) {
                Log.e("TaskTimerWidget", "Error in updateWidget", e)
                views.setTextViewText(R.id.timer_display, "ERR")
            }
            
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }
    }
}
