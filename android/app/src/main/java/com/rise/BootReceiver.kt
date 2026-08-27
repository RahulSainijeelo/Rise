package com.rise

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject

/**
 * BootReceiver
 * ============
 * Restarts sensor tracking after a reboot.
 *
 * Without this, everything between powering the phone on and next opening Rise is
 * uncounted — and TYPE_STEP_COUNTER resets to zero at boot, so those steps are gone
 * for good rather than merely delayed. For a habit whose whole point is "walk
 * 10,000 steps today", a morning reboot used to mean the day silently restarted.
 *
 * Only starts when a habit actually needs tracking; an install with no sensor
 * habits linked has no business holding a foreground service.
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "RiseBootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != "android.intent.action.QUICKBOOT_POWERON"
        ) return

        try {
            val configJson = WidgetContract.prefs(context)
                .getString(WidgetContract.KEY_SENSOR_CONFIG, "{}") ?: "{}"

            val tracksSomething = try {
                val cfg = JSONObject(configJson)
                WidgetContract.ALL_SLOTS.any { cfg.has(it) }
            } catch (e: Exception) {
                false
            }

            // Widgets always need a redraw: the step baseline is about to be rebuilt
            // against a counter that just went back to zero.
            WidgetContract.broadcastUpdate(context)

            if (!tracksSomething) return

            // fromBoot = true, so the service knows to leave the microphone alone
            // until the app is next opened. See SensorForegroundService.foregroundTypes.
            SensorForegroundService.start(context, configJson, true)
        } catch (e: Exception) {
            Log.w(TAG, "Could not resume tracking after boot", e)
        }
    }
}
