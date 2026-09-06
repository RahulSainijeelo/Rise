package com.rise

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import kotlin.math.max

/**
 * Habit timers.
 * =============
 * One countdown per TIMER habit, built on the same deadline model as [FocusTimer] and
 * for the same reason.
 *
 * What was wrong before
 * ---------------------
 * A TIMER habit was counted by a `setInterval` inside HabitDetailScreen. That meant the
 * clock only advanced while that one screen was mounted: navigating away, locking the
 * phone or letting React Native be swapped out froze the number, and the run was lost
 * outright if the process died. Worse, nothing was banked until the countdown reached
 * zero, so twenty minutes of a twenty-five minute session counted for nothing.
 *
 * What it is now
 * --------------
 * The only durable facts are `endsAt` (while running) and `remainingMs` (while paused),
 * both in native SharedPreferences. Everything shown anywhere is derived from the wall
 * clock, so the app screen, the wrapper widget and a notification all agree without
 * talking to each other, and a run survives the app being closed for an hour.
 *
 * Progress is credited *as it is earned*, not at the end. Every settle point — pause,
 * reset, completion, or simply a [read] that finds the deadline has passed — banks the
 * seconds since the last one. That is why [State.creditedMs] exists: the habit store is
 * updated with a delta through the pending-op queue, so without a high-water mark a
 * pause/resume/pause would count the first stretch twice.
 *
 * Native cannot write the zustand store, so crediting goes through
 * [WidgetContract.enqueueOp] with [WidgetContract.OP_TIMER_ADD], which
 * `src/services/WidgetOpsService.ts` drains into `updateTimerProgress` on next
 * foreground. An op is durable and idempotent per opId, so a session finished with the
 * app closed still lands.
 */
object HabitTimer {

    private const val TAG = "HabitTimer"

    /** Nothing shorter than this is worth an op; sub-second noise would flood it. */
    private const val CREDIT_FLOOR_MS = 1_000L

    private const val RC_EXPIRE = 8901
    private const val RC_DONE_OPEN = 8902

    private const val CHANNEL_ID = "rise_habit_timer_done"

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    data class State(
        val habitId: String,
        val mode: String = WidgetContract.HT_MODE_IDLE,
        val durationMs: Long = 0L,
        val endsAt: Long = 0L,
        val remainingMs: Long = 0L,
        val startedAt: Long = 0L,
        val creditedMs: Long = 0L,
        val date: String = ""
    ) {
        val running: Boolean get() = mode == WidgetContract.HT_MODE_RUNNING
        val paused: Boolean get() = mode == WidgetContract.HT_MODE_PAUSED
        val idle: Boolean get() = mode == WidgetContract.HT_MODE_IDLE

        fun json(): JSONObject = JSONObject().apply {
            put(WidgetContract.HT_F_MODE, mode)
            put(WidgetContract.HT_F_DURATION, durationMs)
            put(WidgetContract.HT_F_ENDS_AT, endsAt)
            put(WidgetContract.HT_F_REMAINING, remainingMs)
            put(WidgetContract.HT_F_STARTED_AT, startedAt)
            put(WidgetContract.HT_F_CREDITED, creditedMs)
            put(WidgetContract.HT_F_DATE, date)
        }
    }

    /**
     * Millis still to run.
     *
     * Measured against the clock while running, so it is right however long ago the
     * state was written. While paused it is the stored number, which is the only thing
     * a pause can mean. While idle it is the whole goal: a timer that has not started
     * shows the time it would take.
     */
    @JvmStatic
    @JvmOverloads
    fun remaining(state: State, now: Long = System.currentTimeMillis()): Long = when {
        state.running -> max(0L, state.endsAt - now)
        state.paused -> max(0L, state.remainingMs)
        else -> max(0L, state.durationMs)
    }

    /** Millis of the current run already spent. Never negative, never over duration. */
    @JvmStatic
    @JvmOverloads
    fun elapsed(state: State, now: Long = System.currentTimeMillis()): Long =
        (state.durationMs - remaining(state, now)).coerceIn(0L, max(0L, state.durationMs))

    /** 0..1 of the run still to go. Drives the widget's bar. */
    @JvmStatic
    @JvmOverloads
    fun fractionLeft(state: State, now: Long = System.currentTimeMillis()): Double {
        if (state.durationMs <= 0L) return 0.0
        return (remaining(state, now).toDouble() / state.durationMs.toDouble()).coerceIn(0.0, 1.0)
    }

    // -----------------------------------------------------------------------
    // Reading
    // -----------------------------------------------------------------------

    private fun readAll(context: Context): JSONObject = try {
        JSONObject(
            WidgetContract.prefs(context).getString(WidgetContract.KEY_HABIT_TIMERS, "{}") ?: "{}"
        )
    } catch (e: Exception) {
        Log.w(TAG, "Unreadable habit timer blob; starting fresh", e)
        JSONObject()
    }

    private fun parse(habitId: String, o: JSONObject?): State {
        if (o == null) return State(habitId)
        val mode = o.optString(WidgetContract.HT_F_MODE, WidgetContract.HT_MODE_IDLE)
        return State(
            habitId = habitId,
            mode = if (mode == WidgetContract.HT_MODE_RUNNING || mode == WidgetContract.HT_MODE_PAUSED)
                mode else WidgetContract.HT_MODE_IDLE,
            durationMs = o.optLong(WidgetContract.HT_F_DURATION, 0L),
            endsAt = o.optLong(WidgetContract.HT_F_ENDS_AT, 0L),
            remainingMs = o.optLong(WidgetContract.HT_F_REMAINING, 0L),
            startedAt = o.optLong(WidgetContract.HT_F_STARTED_AT, 0L),
            creditedMs = o.optLong(WidgetContract.HT_F_CREDITED, 0L),
            date = o.optString(WidgetContract.HT_F_DATE, "")
        )
    }

    private fun write(context: Context, state: State) {
        val all = readAll(context)
        all.put(state.habitId, state.json())
        WidgetContract.prefs(context).edit()
            .putString(WidgetContract.KEY_HABIT_TIMERS, all.toString())
            .apply()
    }

    /**
     * The habit's timer, settled first.
     *
     * Deliberately not a pure getter, for the same reason [FocusTimer.read] is not:
     * this is the one function every reader goes through, and there may be no process
     * alive when a deadline passes. A run that ended while nobody was looking is
     * recorded here, by whoever looks first.
     *
     * @param goalMs the habit's daily goal in millis. An idle timer adopts it, so
     *        editing the goal in the app changes what the widget offers to run.
     */
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun read(context: Context, habitId: String, goalMs: Long = 0L): State {
        if (habitId.isEmpty()) return State(habitId)
        var state = parse(habitId, readAll(context).optJSONObject(habitId))
        val now = System.currentTimeMillis()
        val today = WidgetContract.localDate(now)

        // A run left over from yesterday must not bank seconds onto today. Credit
        // what it earned against *its own* day, then start today clean.
        if (state.date.isNotEmpty() && state.date != today && !state.idle) {
            state = credit(context, state, now)
            state = state.copy(
                mode = WidgetContract.HT_MODE_IDLE,
                endsAt = 0L, remainingMs = state.durationMs,
                startedAt = 0L, creditedMs = 0L, date = today
            )
            cancelExpiry(context, habitId)
            write(context, state)
        }

        if (state.running && now >= state.endsAt) {
            return complete(context, state, now)
        }

        if (state.idle && goalMs > 0L && state.durationMs != goalMs) {
            state = state.copy(durationMs = goalMs, remainingMs = goalMs)
            write(context, state)
        }
        return state
    }

    // -----------------------------------------------------------------------
    // The state machine
    // -----------------------------------------------------------------------

    /**
     * Apply one op and return the state it produced.
     *
     * Every caller lands here — widget button, app screen, expiry alarm — so there is
     * exactly one description of what "pause" means. The caller redraws; this owns the
     * state, the alarm and the credit.
     */
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun handle(context: Context, habitId: String, op: String, goalMs: Long = 0L): State {
        if (habitId.isEmpty()) return State(habitId)
        val now = System.currentTimeMillis()
        val state = read(context, habitId, goalMs)

        val next = when (op) {
            WidgetContract.HT_OP_TOGGLE -> return handle(
                context, habitId,
                when {
                    state.running -> WidgetContract.HT_OP_PAUSE
                    state.paused -> WidgetContract.HT_OP_RESUME
                    else -> WidgetContract.HT_OP_START
                },
                goalMs
            )

            WidgetContract.HT_OP_START -> {
                if (!state.idle) return state
                val duration = if (goalMs > 0L) goalMs else state.durationMs
                if (duration <= 0L) return state
                state.copy(
                    mode = WidgetContract.HT_MODE_RUNNING,
                    durationMs = duration,
                    endsAt = now + duration,
                    remainingMs = duration,
                    startedAt = now,
                    // A fresh run has banked nothing, whatever the last one did.
                    creditedMs = 0L,
                    date = WidgetContract.localDate(now)
                )
            }

            WidgetContract.HT_OP_RESUME -> {
                if (!state.paused) return state
                state.copy(
                    mode = WidgetContract.HT_MODE_RUNNING,
                    endsAt = now + max(0L, state.remainingMs)
                )
            }

            WidgetContract.HT_OP_PAUSE -> {
                if (!state.running) return state
                // Credit before changing mode: `remaining` reads endsAt while running
                // and remainingMs once paused, so banking after the flip would measure
                // the new state and lose the stretch being ended.
                credit(context, state, now).copy(
                    mode = WidgetContract.HT_MODE_PAUSED,
                    remainingMs = remaining(state, now)
                )
            }

            WidgetContract.HT_OP_RESET -> {
                if (state.idle) return state
                // Reset abandons the countdown, not the work: the seconds already sat
                // through are the user's, and taking them back would punish stopping.
                credit(context, state, now).copy(
                    mode = WidgetContract.HT_MODE_IDLE,
                    endsAt = 0L,
                    remainingMs = state.durationMs,
                    startedAt = 0L,
                    creditedMs = 0L
                )
            }

            WidgetContract.HT_OP_EXPIRE -> {
                if (!state.running) return state
                return complete(context, state, now)
            }

            else -> return state
        }

        write(context, next)
        scheduleExpiry(context, next)
        refreshWidgets(context)
        return next
    }

    /** Bank the run in full, ring, and go back to idle. */
    private fun complete(context: Context, state: State, now: Long): State {
        // Credit against the deadline, not `now`: a run settled twenty minutes late
        // earned the duration it was set for, not twenty extra minutes.
        val settled = credit(context, state, state.endsAt)
        val next = settled.copy(
            mode = WidgetContract.HT_MODE_IDLE,
            endsAt = 0L,
            remainingMs = settled.durationMs,
            startedAt = 0L,
            creditedMs = 0L
        )
        write(context, next)
        cancelExpiry(context, state.habitId)
        notifyDone(context, state)
        refreshWidgets(context)
        return next
    }

    /**
     * Hand the seconds earned since the last settle to the habit store.
     *
     * Whole seconds only, and the high-water mark advances by exactly what was sent, so
     * the fraction left over is credited by the next settle rather than lost or double
     * counted.
     */
    private fun credit(context: Context, state: State, at: Long): State {
        val delta = elapsed(state, at) - state.creditedMs
        if (delta < CREDIT_FLOOR_MS) return state
        val seconds = delta / 1000L
        WidgetContract.enqueueOp(
            context,
            WidgetContract.OP_TIMER_ADD,
            state.habitId,
            "",
            seconds.toDouble(),
            state.date.ifEmpty { WidgetContract.localDate() }
        )
        return state.copy(creditedMs = state.creditedMs + seconds * 1000L)
    }

    // -----------------------------------------------------------------------
    // The safety net
    // -----------------------------------------------------------------------

    /**
     * Inexact, Doze-tolerant, and not the timer.
     *
     * The widget's Chronometer counts down by itself and [read] settles a finished run
     * whenever anybody looks, so this alarm exists only to make sure *somebody* looks
     * within a few minutes of the deadline. Exact alarms are avoided for the same
     * reason the focus timer avoids them: from Android 12 they need a permission the
     * user must grant by hand.
     */
    private fun scheduleExpiry(context: Context, state: State) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val pi = expiryIntent(context, state.habitId)
        try {
            am.cancel(pi)
            if (!state.running) return
            val at = max(state.endsAt, System.currentTimeMillis() + 1_000L)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            } else {
                am.set(AlarmManager.RTC_WAKEUP, at, pi)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not schedule the expiry alarm for ${state.habitId}", e)
        }
    }

    private fun cancelExpiry(context: Context, habitId: String) {
        try {
            (context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager)
                ?.cancel(expiryIntent(context, habitId))
        } catch (e: Exception) {
            Log.w(TAG, "Could not cancel the expiry alarm for $habitId", e)
        }
    }

    /**
     * One alarm per habit.
     *
     * The habit id is in the *data* Uri, not just an extra: PendingIntent identity
     * ignores extras, so two habits sharing a request code with different extras would
     * be the same PendingIntent and scheduling the second would silently move the
     * first.
     */
    private fun expiryIntent(context: Context, habitId: String): PendingIntent =
        PendingIntent.getBroadcast(
            context, RC_EXPIRE,
            controlIntent(context, habitId, WidgetContract.HT_OP_EXPIRE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    /**
     * An explicit, token-carrying control broadcast at the wrapper widget.
     *
     * Explicit so it needs no intent-filter; token-carrying because an exported
     * receiver can be targeted by any app, and a forged RESET would throw away a
     * session. Same reasoning as [WidgetContract.isTrustedControl].
     */
    @JvmStatic
    fun controlIntent(context: Context, habitId: String, op: String): Intent =
        Intent(context, HabitLinkWidget::class.java).apply {
            action = WidgetContract.ACTION_HABIT_TIMER
            putExtra(WidgetContract.EXTRA_HABIT_ID, habitId)
            putExtra(WidgetContract.EXTRA_OP, op)
            putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
            data = Uri.parse("rise-habit-timer://$habitId/$op")
        }

    private fun refreshWidgets(context: Context) {
        try {
            HabitLinkWidget.refreshAll(context)
        } catch (e: Exception) {
            Log.w(TAG, "Could not refresh the habit widgets", e)
        }
    }

    // -----------------------------------------------------------------------
    // Notification
    // -----------------------------------------------------------------------

    @JvmStatic
    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.habit_timer_channel_name),
                // Allowed to interrupt: a timer nobody hears is a timer that did not
                // work. Same call the focus timer makes for its completion channel.
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = context.getString(R.string.habit_timer_channel_desc)
                enableVibration(true)
            }
        )
    }

    private fun notifyDone(context: Context, state: State) {
        try {
            createChannel(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return
            val title = habitTitle(context, state.habitId)
            val open = PendingIntent.getActivity(
                context, RC_DONE_OPEN,
                Intent(context, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    data = Uri.parse("rise://item/${state.habitId}/habit")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notification = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(
                    context.getString(
                        R.string.habit_timer_done_text,
                        FocusTimer.duration(state.durationMs)
                    )
                )
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build()
            // Keyed by habit so two timers finishing do not overwrite each other.
            nm.notify(state.habitId.hashCode(), notification)
        } catch (e: Exception) {
            Log.w(TAG, "Could not post the habit timer notification", e)
        }
    }

    /** The habit's name from the published blob, falling back to something neutral. */
    @JvmStatic
    fun habitTitle(context: Context, habitId: String): String = try {
        val raw = WidgetContract.prefs(context).getString(WidgetContract.KEY_HABITS_DATA, "[]")
            ?: "[]"
        val arr = org.json.JSONArray(raw)
        var found = context.getString(R.string.habit_timer_done_fallback)
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            if (o.optString(WidgetContract.F_ID) == habitId) {
                val t = o.optString(WidgetContract.F_TITLE)
                if (t.isNotEmpty()) found = t
                break
            }
        }
        found
    } catch (e: Exception) {
        context.getString(R.string.habit_timer_done_fallback)
    }
}
