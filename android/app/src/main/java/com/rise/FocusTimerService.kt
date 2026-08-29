package com.rise

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log

/**
 * Keeps a running focus session alive and visible.
 *
 * What it is actually for
 * ----------------------
 * The countdown itself does not need a service: the state is a deadline, the widget's
 * Chronometer ticks itself, and [FocusTimer.read] settles a finished run whenever
 * anybody looks. What needs a process is the part where nobody is looking — ringing at
 * the moment the timer ends, and moving the ring while the user watches it.
 *
 * Exact alarms would have been the other way to ring on time, but from Android 12 they
 * need SCHEDULE_EXACT_ALARM, which the user has to grant by hand in Settings. A focus
 * timer is not worth that dialog, so the timing lives here and an inexact
 * allow-while-idle alarm ([FocusTimer] schedules it) is the backstop for a killed
 * process.
 *
 * Foreground type is `specialUse`: there is no timer type, `dataSync` is capped at six
 * hours a day on Android 15, and claiming a sensor type we are not using would be a
 * lie the system now rejects.
 */
class FocusTimerService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var power: PowerManager? = null

    /**
     * Moves the ring. Deliberately not the clock — the digits are the Chronometer's
     * job — so a missed tick costs a slightly stale ring and nothing else.
     */
    private val tick = object : Runnable {
        override fun run() {
            val state = FocusTimer.read(this@FocusTimerService)
            if (!state.running) {
                // read() has already recorded and rung; all that is left is to go away.
                FocusTimer.refreshWidgets(this@FocusTimerService)
                stopEverything()
                return
            }
            // Nobody is looking at a widget behind a dark screen, and every redraw is a
            // Binder round trip plus an inflate in the launcher.
            if (power?.isInteractive != false) {
                FocusTimer.refreshWidgets(this@FocusTimerService)
            }
            handler.postDelayed(this, TICK_MS)
        }
    }

    /** The moment the run ends. read() does the recording and the ringing. */
    private val finish = Runnable {
        FocusTimer.read(this)
        FocusTimer.refreshWidgets(this)
        stopEverything()
    }

    override fun onCreate() {
        super.onCreate()
        power = getSystemService(Context.POWER_SERVICE) as? PowerManager
        FocusTimer.createChannels(this)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == WidgetContract.FOCUS_SERVICE_ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }

        val state = FocusTimer.read(this)
        if (!state.running) {
            /*
             * Coming up only to go straight back down is normal, not an error: every
             * focus state change pokes this service, and the change may have been the
             * one that paused or ended the run. Stopping promptly also cancels the
             * five-second startForeground deadline that startForegroundService armed.
             */
            stopEverything()
            return START_NOT_STICKY
        }

        // A refused foreground start costs the notification, not the timer, so there is
        // no point arming the handler afterwards — the widget counts down on its own
        // and read() settles the run whenever anybody looks.
        if (!goForeground(state)) return START_NOT_STICKY

        handler.removeCallbacks(tick)
        handler.removeCallbacks(finish)
        handler.postDelayed(tick, TICK_MS)
        handler.postDelayed(finish, FocusTimer.remaining(state).coerceAtLeast(0L))

        // Sticky: a restarted service re-reads the deadline from prefs and picks the
        // run up mid-flight, which is the whole reason the state is a deadline.
        return START_STICKY
    }

    private fun goForeground(state: FocusTimer.State): Boolean {
        try {
            val notification = FocusTimer.runningNotification(this, state)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    WidgetContract.FOCUS_NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else {
                startForeground(WidgetContract.FOCUS_NOTIFICATION_ID, notification)
            }
            return true
        } catch (e: Exception) {
            Log.w(TAG, "startForeground refused for the focus timer", e)
            stopEverything()
            return false
        }
    }

    private fun stopEverything() {
        handler.removeCallbacks(tick)
        handler.removeCallbacks(finish)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (e: Exception) {
            Log.w(TAG, "stopForeground failed", e)
        }
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        handler.removeCallbacks(finish)
        super.onDestroy()
    }

    private companion object {
        const val TAG = "FocusTimerService"

        /** Ring redraw cadence. Fast enough to read as motion, slow enough to be free. */
        const val TICK_MS = 3_000L
    }
}
