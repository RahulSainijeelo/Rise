package com.rise

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import com.facebook.react.bridge.Promise
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

    /**
     * Every habit without a dedicated widget, for the wrapper widget to bind to.
     *
     * A separate blob from sensorData because the shapes differ in kind: sensorData
     * is five fixed slots, this is a list of unknown length that a widget instance
     * picks one entry out of by id.
     */
    @ReactMethod
    fun setHabitsData(data: String) {
        try {
            WidgetContract.prefs(reactApplicationContext).edit()
                .putString(WidgetContract.KEY_HABITS_DATA, data)
                .apply()
            HabitLinkWidget.refreshAll(reactApplicationContext)
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error updating habits data", e)
        }
    }

    /**
     * Config the foreground service needs: the Digital Sunset window, the noise
     * threshold, and which habit id owns each slot.
     *
     * Deliberately does not notify the widgets — this blob is invisible to them,
     * and JS pushes it on every store write, so redrawing here would double the
     * widget update rate for no visible change.
     */
    @ReactMethod
    fun setSensorConfig(data: String) {
        try {
            val sharedPref = reactApplicationContext.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            with(sharedPref.edit()) {
                putString(WidgetContract.KEY_SENSOR_CONFIG, data)
                apply()
            }
        } catch (e: Exception) {
            Log.e("WidgetBridge", "Error updating sensor config", e)
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

    // -----------------------------------------------------------------------
    // Focus timer
    // -----------------------------------------------------------------------
    //
    // The app tab is a second face on the same timer, not a timer of its own. Every
    // one of these calls goes through FocusTimer, which is also what the widget's
    // buttons and the notification actions go through, so a session started on the
    // home screen can be paused in the app and the history has one writer.
    //
    // Each resolves with the state as JSON, so the screen can render the result of its
    // own action without a second round trip.

    @ReactMethod
    fun getFocusState(promise: Promise) {
        try {
            promise.resolve(FocusTimer.read(reactApplicationContext).json().toString())
        } catch (e: Exception) {
            promise.reject("focus_state", e)
        }
    }

    /** One of the WidgetContract.FOCUS_OP_* values. */
    @ReactMethod
    fun focusOp(op: String, promise: Promise) {
        try {
            val state = FocusTimer.handle(
                reactApplicationContext, op, WidgetContract.FOCUS_SOURCE_APP
            )
            FocusTimer.refreshWidgets(reactApplicationContext)
            promise.resolve(state.json().toString())
        } catch (e: Exception) {
            promise.reject("focus_op", e)
        }
    }

    /** Dial in a duration and start it, in one step, as the app's picker does. */
    @ReactMethod
    fun focusStart(hours: Int, minutes: Int, promise: Promise) {
        try {
            FocusTimer.setDial(reactApplicationContext, hours, minutes)
            val state = FocusTimer.handle(
                reactApplicationContext,
                WidgetContract.FOCUS_OP_START,
                WidgetContract.FOCUS_SOURCE_APP
            )
            FocusTimer.refreshWidgets(reactApplicationContext)
            promise.resolve(state.json().toString())
        } catch (e: Exception) {
            promise.reject("focus_start", e)
        }
    }

    /** Remember the dial without starting, so the app and the widget agree on it. */
    @ReactMethod
    fun setFocusDial(hours: Int, minutes: Int, promise: Promise) {
        try {
            val state = FocusTimer.setDial(reactApplicationContext, hours, minutes)
            FocusTimer.refreshWidgets(reactApplicationContext)
            promise.resolve(state.json().toString())
        } catch (e: Exception) {
            promise.reject("focus_dial", e)
        }
    }

    @ReactMethod
    fun getFocusHistory(promise: Promise) {
        try {
            promise.resolve(FocusTimer.historyJson(reactApplicationContext))
        } catch (e: Exception) {
            promise.reject("focus_history", e)
        }
    }

    // -----------------------------------------------------------------------
    // Habit timers
    // -----------------------------------------------------------------------
    //
    // The app screen is one of three owners of a TIMER habit's countdown, alongside
    // the wrapper widget and the expiry alarm. It reads and moves the same native
    // state machine rather than keeping a timer of its own, which is the entire fix
    // for the old setInterval that only advanced while the screen was mounted.

    /** @param goalSeconds the habit's daily goal; an idle timer adopts it. */
    @ReactMethod
    fun getHabitTimer(habitId: String, goalSeconds: Double, promise: Promise) {
        try {
            val state = HabitTimer.read(
                reactApplicationContext, habitId, (goalSeconds * 1000).toLong()
            )
            promise.resolve(state.json().toString())
        } catch (e: Exception) {
            promise.reject("habit_timer_state", e)
        }
    }

    /** @param op one of the WidgetContract.HT_OP_* values. */
    @ReactMethod
    fun habitTimerOp(habitId: String, op: String, goalSeconds: Double, promise: Promise) {
        try {
            val state = HabitTimer.handle(
                reactApplicationContext, habitId, op, (goalSeconds * 1000).toLong()
            )
            promise.resolve(state.json().toString())
        } catch (e: Exception) {
            promise.reject("habit_timer_op", e)
        }
    }

    @ReactMethod
    fun clearFocusHistory(promise: Promise) {
        try {
            FocusTimer.clearHistory(reactApplicationContext)
            FocusTimer.refreshWidgets(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("focus_history_clear", e)
        }
    }

    @ReactMethod
    fun setFocusTheme(json: String, promise: Promise) {
        try {
            FocusTimer.setTheme(reactApplicationContext, json)
            // Immediately, so the ring on the home screen changes colour with the one
            // in the app rather than at the next tick.
            FocusTimer.refreshWidgets(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("focus_theme", e)
        }
    }

    @ReactMethod
    fun getFocusTheme(promise: Promise) {
        try {
            val t = FocusTimer.theme(reactApplicationContext)
            promise.resolve(
                JSONObject().apply {
                    put(WidgetContract.FOCUS_T_ID, t.id)
                    put(WidgetContract.FOCUS_T_FROM, hex(t.from))
                    put(WidgetContract.FOCUS_T_TO, hex(t.to))
                    put(WidgetContract.FOCUS_T_TRACK, hex(t.track))
                }.toString()
            )
        } catch (e: Exception) {
            promise.reject("focus_theme_get", e)
        }
    }

    private fun hex(color: Int): String =
        String.format("#%06X", 0xFFFFFF and color)

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

            // 2. Habit Matrix. It owns both halves of its redraw -- the header frame
            //    and the row collection -- so the notify id lives in one place.
            HabitControlWidget.refreshAll(context)

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
