package com.rise

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * SensorBridge
 * ============
 * The JS-facing half of SensorForegroundService.
 *
 * Its presence is what SensorService.ts checks to decide whether it can hand
 * sensor ownership to the OS or must fall back to the foreground-only
 * react-native-* libraries. Nothing here does any measuring: it starts and stops
 * the service, answers permission questions, and relays the service's readings
 * into JS.
 */
class SensorBridge(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "SensorBridge"
        const val EVENT_SENSOR_UPDATE = "onSensorUpdate"
    }

    private var listenerCount = 0

    override fun getName(): String = "SensorBridge"

    override fun initialize() {
        super.initialize()
        // Relay service readings to JS only while a ReactContext is alive. The
        // service holds this as a static, so it must be cleared on teardown or the
        // next emit lands on a dead bridge.
        SensorForegroundService.setListener { payload ->
            try {
                if (reactContext.hasActiveReactInstance()) {
                    reactContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit(EVENT_SENSOR_UPDATE, payload)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Could not emit sensor update", e)
            }
        }
    }

    override fun invalidate() {
        SensorForegroundService.setListener(null)
        super.invalidate()
    }

    /**
     * NativeEventEmitter requires these two on Android as well as iOS; without them
     * RN logs a warning on every addListener call.
     */
    @ReactMethod
    fun addListener(eventName: String) {
        listenerCount += 1
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        listenerCount = (listenerCount - count).coerceAtLeast(0)
    }

    // -----------------------------------------------------------------------
    // Service control
    // -----------------------------------------------------------------------

    /**
     * @param configJson a SensorConfig blob (see the TS contract). Persisted by the
     *        service so a sticky restart with a null intent still knows what to track.
     */
    @ReactMethod
    fun startTracking(configJson: String?) {
        // Persist before starting: if the OS refuses the start (app is in the
        // background on Android 12+), the config is still there for the next try.
        WidgetContract.prefs(reactContext).edit()
            .putString(WidgetContract.KEY_SENSOR_CONFIG, configJson ?: "{}").apply()
        SensorForegroundService.start(reactContext, configJson)
    }

    @ReactMethod
    fun stopTracking() {
        SensorForegroundService.stop(reactContext)
    }

    @ReactMethod
    fun isTracking(promise: Promise) {
        promise.resolve(SensorForegroundService.isRunning(reactContext))
    }

    // -----------------------------------------------------------------------
    // Digital Sunset permission
    // -----------------------------------------------------------------------

    @ReactMethod
    fun hasUsageStatsPermission(promise: Promise) {
        promise.resolve(SensorForegroundService.hasUsageStatsPermission(reactContext))
    }

    /**
     * PACKAGE_USAGE_STATS has no runtime dialog, so the only way to obtain it is to
     * drop the user on the Usage Access screen in Settings and explain why.
     */
    @ReactMethod
    fun openUsageStatsSettings() {
        try {
            val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // Some OEMs honour the package hint and land directly on our entry.
                data = Uri.parse("package:${reactContext.packageName}")
            }
            reactContext.startActivity(intent)
        } catch (e: Exception) {
            try {
                reactContext.startActivity(
                    Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
            } catch (e2: Exception) {
                Log.w(TAG, "No usage access settings screen on this device", e2)
            }
        }
    }

    // -----------------------------------------------------------------------
    // Pending widget ops
    // -----------------------------------------------------------------------

    /**
     * Hand over everything the user did on a widget while JS was not running, and
     * clear the queue in the same breath so each op is delivered exactly once.
     */
    @ReactMethod
    fun drainPendingOps(promise: Promise) {
        try {
            val prefs = WidgetContract.prefs(reactContext)
            val json = prefs.getString(WidgetContract.KEY_PENDING_OPS, "[]") ?: "[]"
            prefs.edit().putString(WidgetContract.KEY_PENDING_OPS, "[]").apply()
            promise.resolve(json)
        } catch (e: Exception) {
            promise.resolve("[]")
        }
    }

    /** Current live values, for a screen that mounts between service ticks. */
    @ReactMethod
    fun getRuntimeSnapshot(promise: Promise) {
        try {
            promise.resolve(
                WidgetContract.prefs(reactContext)
                    .getString(WidgetContract.KEY_SENSOR_RUNTIME, "{}") ?: "{}"
            )
        } catch (e: Exception) {
            promise.resolve("{}")
        }
    }

    /** Ask every widget to redraw from prefs. Used after a manual refresh in-app. */
    @ReactMethod
    fun refreshWidgets() {
        try {
            WidgetContract.broadcastUpdate(reactContext.applicationContext as Context)
        } catch (e: Exception) {
            Log.w(TAG, "Could not broadcast widget update", e)
        }
    }
}
