package com.rise

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.widget.RemoteViews

/**
 * Rise: Focus Timer — the home-screen face.
 *
 * Still named TaskTimerWidget because the manifest receiver, the provider info XML and
 * every PendingIntent the launcher is already holding name this class; what it shows
 * changed completely. It used to be a countdown attached to whichever task JS had
 * pushed into `timerData`, with PAUSE and STOP routed through an activity so that
 * pausing a timer meant launching the app. It is now a standalone focus timer bound to
 * no habit and no task, and every button acts inside this receiver.
 *
 * Two faces, chosen by [FocusTimer.State.mode]:
 *
 *   idle     the dial — HH:MM, both fields always two places, one of them selected,
 *            with a single − and + pair that acts on the selected field, then START.
 *   running  the countdown — a drawn ring whose colour moves, a self-ticking
 *            Chronometer, pause/resume and reset.
 *
 * The state lives in SharedPreferences and is shared with the app's Focus tab, so a
 * run started here can be watched, paused or reset there and the other way round.
 */
class TaskTimerWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (id in appWidgetIds) updateWidget(context, appWidgetManager, id)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        when (intent.action) {
            WidgetContract.ACTION_FOCUS_CONTROL -> {
                // An exported receiver accepts explicit intents from any app, so the
                // token is what stops a third party resetting somebody's session.
                if (!WidgetContract.isTrustedControl(context, intent)) {
                    Log.w(TAG, "Dropped an untrusted focus control")
                    return
                }
                val op = intent.getStringExtra(WidgetContract.EXTRA_FOCUS_OP) ?: return
                FocusTimer.handle(context, op, WidgetContract.FOCUS_SOURCE_WIDGET)
                FocusTimer.refreshWidgets(context)
            }

            WidgetContract.ACTION_WIDGET_UPDATE,
            WidgetContract.ACTION_TIMER_ACTION -> FocusTimer.refreshWidgets(context)
        }
    }

    /**
     * The last widget was removed. The timer is deliberately left alone: the app tab
     * shares this state, so a run in progress belongs to the user, not to the widget
     * that happened to start it.
     */
    override fun onDisabled(context: Context) {
        super.onDisabled(context)
    }

    companion object {
        private const val TAG = "FocusWidget"

        /**
         * Request-code base for the control buttons.
         *
         * One code per op, and they must not collide: PendingIntent identity ignores
         * extras, so two buttons sharing a request code would share one intent and
         * FLAG_UPDATE_CURRENT would quietly rewrite the first one's op. Kept clear of
         * the 8801-8805 block FocusTimer uses for its alarm and notification actions.
         */
        private const val RC_BASE = 8810

        private val OPS = listOf(
            WidgetContract.FOCUS_OP_SELECT_H,
            WidgetContract.FOCUS_OP_SELECT_M,
            WidgetContract.FOCUS_OP_UP,
            WidgetContract.FOCUS_OP_DOWN,
            WidgetContract.FOCUS_OP_START,
            WidgetContract.FOCUS_OP_PAUSE,
            WidgetContract.FOCUS_OP_RESUME,
            WidgetContract.FOCUS_OP_RESET
        )

        private const val COLOR_ON = 0xFFFFFFFF.toInt()
        private const val COLOR_OFF = 0xFF6E6E6E.toInt()
        private const val COLOR_MUTED = 0xFF888888.toInt()

        @JvmStatic
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.task_timer_widget)
            try {
                val state = FocusTimer.read(context)
                val theme = FocusTimer.theme(context)
                val now = System.currentTimeMillis()

                // The card itself opens the Focus tab. Every control below is a
                // broadcast, so nothing but this needs the app to be running.
                views.setOnClickPendingIntent(R.id.focus_header, openFocusTab(context))

                val todayMs = FocusTimer.focusedTodayMs(context)
                views.setTextViewText(
                    R.id.focus_today,
                    if (todayMs > 0L) "${FocusTimer.duration(todayMs)} TODAY" else ""
                )

                if (state.idle) drawSetup(context, views, state, theme)
                else drawRun(context, views, state, theme, now)
            } catch (e: Exception) {
                // A half-drawn widget is better than a crashed host process.
                Log.e(TAG, "Could not draw the focus widget", e)
            }
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }

        // -------------------------------------------------------------------
        // Setup face
        // -------------------------------------------------------------------

        private fun drawSetup(
            context: Context,
            views: RemoteViews,
            state: FocusTimer.State,
            theme: FocusTimer.Theme
        ) {
            views.setViewVisibility(R.id.focus_setup, View.VISIBLE)
            views.setViewVisibility(R.id.focus_run, View.GONE)

            views.setTextViewText(R.id.focus_h, WidgetContract.focusPad(state.setupH))
            views.setTextViewText(R.id.focus_m, WidgetContract.focusPad(state.setupM))

            // The selected field is the one the steppers act on, so it is shown in the
            // theme colour and lit from behind; the other is dimmed. Anything subtler
            // leaves the two buttons looking like they do nothing.
            val hoursSelected = state.field == WidgetContract.FOCUS_FIELD_H
            paintField(views, R.id.focus_h, hoursSelected, theme)
            paintField(views, R.id.focus_m, !hoursSelected, theme)

            views.setTextViewText(
                R.id.focus_hint,
                if (hoursSelected) "HOURS SELECTED" else "MINUTES SELECTED"
            )

            // A zero dial cannot start, so the button says what is missing instead of
            // sitting there swallowing taps.
            val ready = state.setupMs > 0L
            views.setTextViewText(R.id.focus_start, if (ready) "START" else "SET A TIME")
            views.setTextColor(R.id.focus_start, if (ready) COLOR_ON else COLOR_OFF)

            views.setOnClickPendingIntent(R.id.focus_h, op(context, WidgetContract.FOCUS_OP_SELECT_H))
            views.setOnClickPendingIntent(R.id.focus_m, op(context, WidgetContract.FOCUS_OP_SELECT_M))
            views.setOnClickPendingIntent(R.id.focus_up, op(context, WidgetContract.FOCUS_OP_UP))
            views.setOnClickPendingIntent(R.id.focus_down, op(context, WidgetContract.FOCUS_OP_DOWN))
            views.setOnClickPendingIntent(R.id.focus_start, op(context, WidgetContract.FOCUS_OP_START))
        }

        private fun paintField(
            views: RemoteViews,
            viewId: Int,
            selected: Boolean,
            theme: FocusTimer.Theme
        ) {
            views.setTextColor(viewId, if (selected) COLOR_ON else COLOR_OFF)
            views.setInt(
                viewId, "setBackgroundColor",
                // The theme's own hue at low alpha, so the selection belongs to the
                // palette the user picked in the app rather than to a fixed accent.
                if (selected) (theme.from and 0x00FFFFFF) or 0x40000000 else 0
            )
        }

        // -------------------------------------------------------------------
        // Running face
        // -------------------------------------------------------------------

        private fun drawRun(
            context: Context,
            views: RemoteViews,
            state: FocusTimer.State,
            theme: FocusTimer.Theme,
            now: Long
        ) {
            views.setViewVisibility(R.id.focus_setup, View.GONE)
            views.setViewVisibility(R.id.focus_run, View.VISIBLE)

            views.setImageViewBitmap(R.id.focus_ring, FocusTimer.ringBitmap(state, theme, now))

            /*
             * The digits tick themselves. Chronometer counts against
             * elapsedRealtime, so the base is "now plus what is left" rather than the
             * wall-clock deadline; setting it on every redraw is what keeps it honest
             * after a doze, a reboot or a pause. Stopped, it freezes on the text
             * setBase just computed, which is exactly the paused reading.
             */
            val remaining = FocusTimer.remaining(state, now)
            views.setChronometer(
                R.id.focus_time,
                SystemClock.elapsedRealtime() + remaining,
                null,
                state.running
            )
            views.setChronometerCountDown(R.id.focus_time, true)

            views.setTextViewText(R.id.focus_state, if (state.running) "FOCUS" else "PAUSED")
            views.setTextColor(R.id.focus_state, if (state.running) COLOR_MUTED else theme.from)

            views.setTextViewText(R.id.focus_toggle, if (state.running) "PAUSE" else "RESUME")
            views.setOnClickPendingIntent(
                R.id.focus_toggle,
                op(
                    context,
                    if (state.running) WidgetContract.FOCUS_OP_PAUSE
                    else WidgetContract.FOCUS_OP_RESUME
                )
            )
            views.setOnClickPendingIntent(R.id.focus_reset, op(context, WidgetContract.FOCUS_OP_RESET))
        }

        // -------------------------------------------------------------------
        // Intents
        // -------------------------------------------------------------------

        private fun op(context: Context, op: String): PendingIntent {
            val index = OPS.indexOf(op).coerceAtLeast(0)
            return PendingIntent.getBroadcast(
                context, RC_BASE + index,
                FocusTimer.controlIntent(context, op),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun openFocusTab(context: Context): PendingIntent = PendingIntent.getActivity(
            context, RC_BASE + OPS.size,
            Intent(context, MainActivity::class.java)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(WidgetContract.deepLinkFocus()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
