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
        val context = reactApplicationContext
        val appWidgetManager = AppWidgetManager.getInstance(context)
        
        // Notify main list widget
        val mainIds = appWidgetManager.getAppWidgetIds(ComponentName(context, RiseWidget::class.java))
        if (mainIds.isNotEmpty()) {
            appWidgetManager.notifyAppWidgetViewDataChanged(mainIds, R.id.widget_list)
        }

        // Send broad broadcast to all widget providers
        val updateIntent = Intent("com.rise.WIDGET_UPDATE").apply {
            setPackage(context.packageName)
        }
        context.sendBroadcast(updateIntent)
        
        Log.d("WidgetBridge", "Sent WIDGET_UPDATE broadcast")
    }
}
