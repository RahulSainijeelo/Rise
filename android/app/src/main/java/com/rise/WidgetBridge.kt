package com.rise

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import android.util.Log
import org.json.JSONObject

class WidgetBridge(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private fun sendEvent(eventName: String, params: String) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    @ReactMethod
    fun emitTimerAction(action: String, id: String) {
        val params = JSONObject().apply {
            put("action", action)
            put("id", id)
        }
        sendEvent("onTimerAction", params.toString())
    }

    @ReactMethod
    fun emitHabitAction(action: String, id: String) {
        val params = JSONObject().apply {
            put("action", action)
            put("id", id)
        }
        sendEvent("onHabitAction", params.toString())
    }

    override fun getName(): String {
        return "WidgetBridge"
    }

    @ReactMethod
    fun setWidgetData(data: String) {
        try {
            Log.d("WidgetBridge", "Setting widget data: ${data.take(200)}...")
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString("widgetData", data)
                apply()
            }

            notifyWidgetUpdate()
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error updating widget data", e)
        }
    }

    @ReactMethod
    fun setWidgetLabels(labels: String) {
        try {
            Log.d("WidgetBridge", "Setting widget labels: $labels")
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString("widgetLabels", labels)
                apply()
            }
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error updating widget labels", e)
        }
    }

    @ReactMethod
    fun setWidgetLabel(label: String) {
        try {
            Log.d("WidgetBridge", "Setting selected widget label: $label")
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString("selectedLabel", label)
                apply()
            }
            notifyWidgetUpdate()
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error setting selected label", e)
        }
    }

    @ReactMethod
    fun setSensorData(data: String) {
        try {
            Log.d("WidgetBridge", "Setting sensor data: $data")
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString("sensorData", data)
                apply()
            }
            // Notify all widgets that sensor data changed
            notifyWidgetUpdate()
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error updating sensor data", e)
        }
    }

    @ReactMethod
    fun setTimerData(data: String) {
        try {
            Log.d("WidgetBridge", "Setting timer data: $data")
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString("timerData", data)
                apply()
            }
            notifyWidgetUpdate()
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error updating timer data", e)
        }
    }

    @ReactMethod
    fun setHabitHistoryData(data: String) {
        try {
            Log.d("WidgetBridge", "Setting habit history data: ${data.take(100)}...")
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString("habitHistoryData", data)
                apply()
            }
            notifyWidgetUpdate()
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error updating habit history data", e)
        }
    }

    @ReactMethod
    fun pinHabit(habitId: String, title: String) {
        try {
            Log.d("WidgetBridge", "Pinning habit: $habitId ($title)")
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString("pinnedHabitId", habitId)
                putString("pinnedHabitTitle", title)
                apply()
            }
            notifyWidgetUpdate()
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error pinning habit", e)
        }
    }

    private fun notifyWidgetUpdate() {
        try {
            val context = reactApplicationContext
            val appWidgetManager = AppWidgetManager.getInstance(context)
            
            // 1. Rise main tasks widget
            val mainIds = appWidgetManager.getAppWidgetIds(ComponentName(context, RiseWidget::class.java))
            for (id in mainIds) {
                RiseWidget.updateAppWidget(context, appWidgetManager, id)
            }
            if (mainIds.isNotEmpty()) {
                appWidgetManager.notifyAppWidgetViewDataChanged(mainIds, R.id.widget_list)
            }

            // 2. HabitControlWidget
            val habitIds = appWidgetManager.getAppWidgetIds(ComponentName(context, HabitControlWidget::class.java))
            for (id in habitIds) {
                HabitControlWidget.updateWidget(context, appWidgetManager, id)
            }
            if (habitIds.isNotEmpty()) {
                appWidgetManager.notifyAppWidgetViewDataChanged(habitIds, R.id.habit_calendar_grid)
            }

            // 3. TaskTimerWidget
            val timerIds = appWidgetManager.getAppWidgetIds(ComponentName(context, TaskTimerWidget::class.java))
            for (id in timerIds) {
                TaskTimerWidget.updateWidget(context, appWidgetManager, id)
            }

            // 4. Sensor Widgets
            val stepIds = appWidgetManager.getAppWidgetIds(ComponentName(context, StepWidget::class.java))
            for (id in stepIds) {
                StepWidget.updateWidget(context, appWidgetManager, id)
            }

            val distIds = appWidgetManager.getAppWidgetIds(ComponentName(context, DistanceWidget::class.java))
            for (id in distIds) {
                DistanceWidget.updateWidget(context, appWidgetManager, id)
            }

            val silenceIds = appWidgetManager.getAppWidgetIds(ComponentName(context, SilenceWidget::class.java))
            for (id in silenceIds) {
                SilenceWidget.updateWidget(context, appWidgetManager, id)
            }

            val moveIds = appWidgetManager.getAppWidgetIds(ComponentName(context, MovementWidget::class.java))
            for (id in moveIds) {
                MovementWidget.updateWidget(context, appWidgetManager, id)
            }

            val sunsetIds = appWidgetManager.getAppWidgetIds(ComponentName(context, SunsetWidget::class.java))
            for (id in sunsetIds) {
                SunsetWidget.updateWidget(context, appWidgetManager, id)
            }

            // Broad broadcast as backup
            val updateIntent = Intent("com.rise.WIDGET_UPDATE").apply {
                setPackage(context.packageName)
            }
            context.sendBroadcast(updateIntent)
            
            Log.d("WidgetBridge", "Directly updated all widget instances successfully")
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error in notifyWidgetUpdate", e)
        }
    }
}
