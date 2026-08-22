package com.rise

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SweepGradient
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The Focus Timer.
 * ================
 * One countdown, two faces, three owners: the home-screen widget, the app tab, and
 * the foreground service that keeps it honest while the phone is asleep.
 *
 * Why the state is a deadline rather than a "seconds left" counter
 * ---------------------------------------------------------------
 * The widget the user replaced stored `timeLeft` and decremented it from JavaScript,
 * which meant the number on the home screen froze the moment React Native stopped
 * running — which is most of the time. Here the only durable facts are `endsAt`
 * (while running) and `remainingMs` (while paused). Everything anybody displays is
 * derived from the clock, so a widget drawn after two hours of the app being closed,
 * a process death, or a reboot still shows the truth.
 *
 * That also makes the completion self-healing: [read] settles a run whose deadline
 * has passed, so even if the service was killed and every alarm was dropped, the next
 * thing that looks at the timer — a widget redraw, the app opening — records the
 * session and rings. Nothing is lost by being late, only by being wrong.
 *
 * Digits are drawn by a [android.widget.Chronometer] in the widget, not pushed a
 * second at a time. A RemoteViews update per second would be throttled by the host
 * and would cost a wakeup per tick; a Chronometer counts down by itself from a base
 * we set once per redraw.
 */
object FocusTimer {

    private const val TAG = "FocusTimer"

    /** Request codes for the alarm and the notification intents. */
    private const val RC_EXPIRE = 8801
    private const val RC_OPEN = 8802
    private const val RC_PAUSE = 8803
    private const val RC_RESET = 8804
    private const val RC_DONE_OPEN = 8805

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    data class State(
        val mode: String = WidgetContract.FOCUS_MODE_IDLE,
        /** The dial-in values on the setup face. Kept across runs on purpose. */
        val setupH: Int = 0,
        val setupM: Int = 25,
        val field: String = WidgetContract.FOCUS_FIELD_M,
        val durationMs: Long = 0L,
        val endsAt: Long = 0L,
        val remainingMs: Long = 0L,
        val startedAt: Long = 0L,
        val source: String = WidgetContract.FOCUS_SOURCE_WIDGET
    ) {
        val running: Boolean get() = mode == WidgetContract.FOCUS_MODE_RUNNING
        val paused: Boolean get() = mode == WidgetContract.FOCUS_MODE_PAUSED
        val idle: Boolean get() = mode == WidgetContract.FOCUS_MODE_IDLE

        /** The dialled duration, whether or not a run is going. */
        val setupMs: Long get() = (setupH * 3600L + setupM * 60L) * 1000L

        fun json(): JSONObject = JSONObject().apply {
            put(WidgetContract.FOCUS_F_MODE, mode)
            put(WidgetContract.FOCUS_F_SETUP_H, setupH)
            put(WidgetContract.FOCUS_F_SETUP_M, setupM)
            put(WidgetContract.FOCUS_F_FIELD, field)
            put(WidgetContract.FOCUS_F_DURATION, durationMs)
            put(WidgetContract.FOCUS_F_ENDS_AT, endsAt)
            put(WidgetContract.FOCUS_F_REMAINING, remainingMs)
            put(WidgetContract.FOCUS_F_STARTED_AT, startedAt)
            put(WidgetContract.FOCUS_F_SOURCE, source)
        }
    }

    /**
     * Millis still to run.
     *
     * While running this is measured against the wall clock, so it is right no matter
     * how long ago the state was written. While paused it is the stored number, which
     * is the only thing a pause can mean.
     */
    @JvmStatic
    @JvmOverloads
    fun remaining(state: State, now: Long = System.currentTimeMillis()): Long = when {
        state.running -> max(0L, state.endsAt - now)
        state.paused -> max(0L, state.remainingMs)
        else -> state.setupMs
    }

    /** 0..1, how much of the run is left. Used for the ring sweep. */
    @JvmStatic
    @JvmOverloads
    fun fractionLeft(state: State, now: Long = System.currentTimeMillis()): Double {
        val total = if (state.durationMs > 0L) state.durationMs else state.setupMs
        if (total <= 0L) return 0.0
        return (remaining(state, now).toDouble() / total.toDouble()).coerceIn(0.0, 1.0)
    }

    /**
     * The current state, with an overdue run settled first.
     *
     * Deliberately not a pure getter: a run whose deadline has passed is recorded and
     * cleared here, because this is the one function every reader goes through and
     * there may be no service alive to do it. See the note in the class comment.
     */
    @JvmStatic
    @Synchronized
    fun read(context: Context): State {
        val state = readRaw(context)
        if (state.running && System.currentTimeMillis() >= state.endsAt) {
            return complete(context, state)
        }
        return state
    }

    private fun readRaw(context: Context): State {
        val raw = WidgetContract.prefs(context).getString(WidgetContract.KEY_FOCUS_STATE, null)
        if (raw.isNullOrEmpty()) return State()
        return try {
            val o = JSONObject(raw)
            val mode = o.optString(WidgetContract.FOCUS_F_MODE, WidgetContract.FOCUS_MODE_IDLE)
            State(
                mode = if (mode == WidgetContract.FOCUS_MODE_RUNNING ||
                    mode == WidgetContract.FOCUS_MODE_PAUSED
                ) mode else WidgetContract.FOCUS_MODE_IDLE,
                setupH = o.optInt(WidgetContract.FOCUS_F_SETUP_H, 0).coerceIn(0, MAX_HOURS),
                setupM = o.optInt(WidgetContract.FOCUS_F_SETUP_M, 25).coerceIn(0, 59),
                field = if (o.optString(WidgetContract.FOCUS_F_FIELD) == WidgetContract.FOCUS_FIELD_H)
                    WidgetContract.FOCUS_FIELD_H else WidgetContract.FOCUS_FIELD_M,
                durationMs = o.optLong(WidgetContract.FOCUS_F_DURATION, 0L),
                endsAt = o.optLong(WidgetContract.FOCUS_F_ENDS_AT, 0L),
                remainingMs = o.optLong(WidgetContract.FOCUS_F_REMAINING, 0L),
                startedAt = o.optLong(WidgetContract.FOCUS_F_STARTED_AT, 0L),
                source = o.optString(WidgetContract.FOCUS_F_SOURCE, WidgetContract.FOCUS_SOURCE_WIDGET)
            )
        } catch (e: Exception) {
            Log.w(TAG, "Unreadable focus state; starting fresh", e)
            State()
        }
    }

    private fun write(context: Context, state: State) {
        WidgetContract.prefs(context).edit()
            .putString(WidgetContract.KEY_FOCUS_STATE, state.json().toString())
            .apply()
    }

    // -----------------------------------------------------------------------
    // The state machine
    // -----------------------------------------------------------------------

    /** Hours cap. A focus session longer than this is a different kind of app. */
    const val MAX_HOURS = 12

    /**
     * Apply one op and return the state it produced.
     *
     * Everything the widget, the notification and the app tab can do lands here, so
     * there is exactly one description of what "pause" means. The caller is
     * responsible for redrawing; this function only owns the state, the service and
     * the safety-net alarm.
     *
     * @param source who is asking, recorded on the run for the history list. Only
     *        read when the op actually starts a run.
     */
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun handle(
        context: Context,
        op: String,
        source: String = WidgetContract.FOCUS_SOURCE_WIDGET
    ): State {
        val now = System.currentTimeMillis()
        val current = read(context)

        val next: State = when (op) {
            WidgetContract.FOCUS_OP_SELECT_H ->
                current.copy(field = WidgetContract.FOCUS_FIELD_H)

            WidgetContract.FOCUS_OP_SELECT_M ->
                current.copy(field = WidgetContract.FOCUS_FIELD_M)

            WidgetContract.FOCUS_OP_UP -> step(current, +1)
            WidgetContract.FOCUS_OP_DOWN -> step(current, -1)

            WidgetContract.FOCUS_OP_START -> {
                // A zero-length run is a mis-tap, not an instruction.
                val duration = current.setupMs
                if (!current.idle || duration <= 0L) current
                else {
                    // Clear the previous session's card, or it sits in the shade above
                    // a run that has only just started.
                    cancelDone(context)
                    current.copy(
                        mode = WidgetContract.FOCUS_MODE_RUNNING,
                        durationMs = duration,
                        endsAt = now + duration,
                        remainingMs = duration,
                        startedAt = now,
                        source = source
                    )
                }
            }

            WidgetContract.FOCUS_OP_PAUSE -> {
                if (!current.running) current
                else current.copy(
                    mode = WidgetContract.FOCUS_MODE_PAUSED,
                    remainingMs = max(0L, current.endsAt - now)
                )
            }

            WidgetContract.FOCUS_OP_RESUME -> {
                if (!current.paused) current
                else current.copy(
                    mode = WidgetContract.FOCUS_MODE_RUNNING,
                    endsAt = now + max(0L, current.remainingMs)
                )
            }

            WidgetContract.FOCUS_OP_RESET -> abandon(context, current, now)

            // read() already settled it if it was due; nothing left to do.
            WidgetContract.FOCUS_OP_EXPIRE -> current

            else -> {
                Log.w(TAG, "Unknown focus op: $op")
                current
            }
        }

        if (next != current) write(context, next)
        // Even a no-op re-syncs: the ops that arrive when nothing changes are the ones
        // fired because something looked wrong (a stale notification, a dropped alarm).
        syncService(context, next)
        scheduleExpiry(context, next)
        return next
    }

    /**
     * Set the dial without touching a run.
     *
     * The app tab has a proper picker, so it does not need the widget's one-tap-at-a-
     * time steppers — but it must not have its own idea of what "start a 25 minute
     * session" means either. It writes the dial here and then fires the same START op
     * the widget fires, so there is still exactly one state machine.
     */
    @JvmStatic
    @Synchronized
    fun setDial(context: Context, hours: Int, minutes: Int): State {
        val current = read(context)
        if (!current.idle) return current
        val next = current.copy(
            setupH = hours.coerceIn(0, MAX_HOURS),
            setupM = minutes.coerceIn(0, 59)
        )
        write(context, next)
        return next
    }

    /**
     * One press of up or down on the selected field.
     *
     * Hours clamp, minutes wrap. Wrapping is what makes the widget usable: dialling 55
     * minutes is one downward tap from zero instead of fifty-five upward ones, and a
     * stepper that does nothing at the end of its range reads as a broken button.
     * Hours cannot wrap for the same reason — rolling 12 → 0 would look like a reset.
     */
    private fun step(state: State, delta: Int): State {
        if (!state.idle) return state
        return if (state.field == WidgetContract.FOCUS_FIELD_H) {
            state.copy(setupH = (state.setupH + delta).coerceIn(0, MAX_HOURS))
        } else {
            val m = state.setupM + delta
            state.copy(setupM = if (m < 0) 59 else if (m > 59) 0 else m)
        }
    }

    /**
     * Reset: stop the run, keep the dial.
     *
     * A run that is thrown away is still recorded, marked incomplete, provided it ran
     * long enough to have been meant. Without the floor the history fills with the
     * three-second runs that come from starting a timer and immediately fixing it.
     */
    private fun abandon(context: Context, state: State, now: Long): State {
        if (state.idle) return state
        val elapsed = state.durationMs - remaining(state, now)
        if (elapsed >= WidgetContract.FOCUS_MIN_MS) {
            appendRun(context, state, now, elapsed, completed = false)
        }
        cancelDone(context)
        return State(
            mode = WidgetContract.FOCUS_MODE_IDLE,
            setupH = state.setupH,
            setupM = state.setupM,
            field = state.field
        )
    }

    /**
     * A run that reached its deadline. Records it, rings, and returns the idle state.
     *
     * Does not redraw anything on purpose: this is reached from inside [read], which
     * is itself called from widget draws, and a redraw from there would re-enter the
     * draw it was called from. Every caller of read() is about to render the state it
     * was handed, which is already the settled one.
     */
    private fun complete(context: Context, state: State): State {
        val now = System.currentTimeMillis()
        appendRun(context, state, now, state.durationMs, completed = true)
        val settled = State(
            mode = WidgetContract.FOCUS_MODE_IDLE,
            setupH = state.setupH,
            setupM = state.setupM,
            field = state.field
        )
        write(context, settled)
        cancelExpiry(context)
        try {
            context.stopService(Intent(context, FocusTimerService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "Could not stop the focus service", e)
        }
        notifyDone(context, state.durationMs)
        return settled
    }

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    private fun appendRun(
        context: Context,
        state: State,
        endedAt: Long,
        actualMs: Long,
        completed: Boolean
    ) {
        try {
            val p = WidgetContract.prefs(context)
            val old = try {
                JSONArray(p.getString(WidgetContract.KEY_FOCUS_HISTORY, "[]") ?: "[]")
            } catch (e: Exception) {
                JSONArray()
            }
            val run = JSONObject().apply {
                put(WidgetContract.FOCUS_H_ID, UUID.randomUUID().toString())
                put(WidgetContract.FOCUS_H_STARTED_AT, state.startedAt)
                put(WidgetContract.FOCUS_H_ENDED_AT, endedAt)
                put(WidgetContract.FOCUS_H_PLANNED, state.durationMs)
                put(WidgetContract.FOCUS_H_ACTUAL, max(0L, actualMs))
                put(WidgetContract.FOCUS_H_COMPLETED, completed)
                put(WidgetContract.FOCUS_H_SOURCE, state.source)
            }
            // Newest first, so the app tab and any "last session" line agree without
            // either of them having to sort. org.json has no insert, so rebuild.
            val out = JSONArray()
            out.put(run)
            for (i in 0 until min(old.length(), WidgetContract.FOCUS_HISTORY_MAX - 1)) {
                out.put(old.get(i))
            }
            p.edit().putString(WidgetContract.KEY_FOCUS_HISTORY, out.toString()).apply()
        } catch (e: Exception) {
            Log.e(TAG, "Could not record the focus run", e)
        }
    }

    /** The raw history blob, newest first. Handed to JS as-is. */
    @JvmStatic
    fun historyJson(context: Context): String =
        WidgetContract.prefs(context).getString(WidgetContract.KEY_FOCUS_HISTORY, "[]") ?: "[]"

    @JvmStatic
    fun clearHistory(context: Context) {
        WidgetContract.prefs(context).edit()
            .putString(WidgetContract.KEY_FOCUS_HISTORY, "[]").apply()
    }

    /** Total focused millis today, for the widget's footer line. */
    @JvmStatic
    fun focusedTodayMs(context: Context): Long {
        var total = 0L
        try {
            val arr = JSONArray(historyJson(context))
            val today = WidgetContract.localDate()
            for (i in 0 until arr.length()) {
                val run = arr.optJSONObject(i) ?: continue
                val ended = run.optLong(WidgetContract.FOCUS_H_ENDED_AT, 0L)
                if (ended <= 0L) continue
                // Newest first, so the first entry from before today ends the scan.
                if (WidgetContract.localDate(ended) != today) break
                total += run.optLong(WidgetContract.FOCUS_H_ACTUAL, 0L)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not total today's focus", e)
        }
        return total
    }

    // -----------------------------------------------------------------------
    // Theme
    // -----------------------------------------------------------------------

    data class Theme(
        val id: String = "ember",
        val from: Int = 0xFFD71921.toInt(),
        val to: Int = 0xFFFF9A3C.toInt(),
        val track: Int = 0xFF241416.toInt()
    )

    @JvmStatic
    fun theme(context: Context): Theme {
        val raw = WidgetContract.prefs(context).getString(WidgetContract.KEY_FOCUS_THEME, null)
        if (raw.isNullOrEmpty()) return Theme()
        return try {
            val o = JSONObject(raw)
            Theme(
                id = o.optString(WidgetContract.FOCUS_T_ID, "custom"),
                from = parseColor(o.optString(WidgetContract.FOCUS_T_FROM), Theme().from),
                to = parseColor(o.optString(WidgetContract.FOCUS_T_TO), Theme().to),
                track = parseColor(o.optString(WidgetContract.FOCUS_T_TRACK), Theme().track)
            )
        } catch (e: Exception) {
            Theme()
        }
    }

    @JvmStatic
    fun setTheme(context: Context, json: String) {
        WidgetContract.prefs(context).edit()
            .putString(WidgetContract.KEY_FOCUS_THEME, json).apply()
    }

    private fun parseColor(hex: String?, fallback: Int): Int {
        if (hex.isNullOrEmpty()) return fallback
        return try {
            Color.parseColor(hex)
        } catch (e: Exception) {
            fallback
        }
    }

    // -----------------------------------------------------------------------
    // The ring
    // -----------------------------------------------------------------------

    /**
     * The countdown ring, drawn to a bitmap because RemoteViews has no vector it can
     * animate and no way to set a sweep angle on anything it can inflate.
     *
     * The colour moves without a per-frame push: the gradient is a [SweepGradient]
     * whose local matrix is rotated by a phase derived from the elapsed time, and the
     * palette breathes a few degrees of hue either side of the chosen one. Each redraw
     * therefore lands on a different point of the same animation, so what the user
     * sees is a slow living colour rather than a stepped one — and it costs nothing,
     * because the phase is a function of the clock rather than of a timer.
     *
     * @param sizePx keep this modest. The bitmap travels to the launcher inside a
     *        Binder transaction shared with everything else in the update.
     */
    @JvmStatic
    @JvmOverloads
    fun ringBitmap(
        state: State,
        theme: Theme,
        now: Long = System.currentTimeMillis(),
        sizePx: Int = 224
    ): Bitmap {
        val size = sizePx.coerceIn(96, 320)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bitmap)

        val stroke = size * 0.085f
        val inset = stroke / 2f + size * 0.02f
        val rect = RectF(inset, inset, size - inset, size - inset)
        val cx = size / 2f
        val cy = size / 2f
        val radius = rect.width() / 2f

        val paused = state.paused
        // Elapsed drives the animation, so a paused ring is frozen at the colour it
        // stopped on. Measured as time actually counted, not wall time since the
        // start, or a run paused for an hour would jump on resume.
        val elapsedSec = if (state.startedAt > 0L) {
            val elapsedMs = if (paused) state.durationMs - state.remainingMs
            else now - state.startedAt
            (max(0L, elapsedMs) / 1000L).toDouble()
        } else 0.0

        val track = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = stroke
            color = theme.track
        }
        canvas.drawArc(rect, 0f, 360f, false, track)

        val drift = (16.0 * sin(elapsedSec / 15.0)).toFloat()
        val from = shiftHue(theme.from, drift)
        val to = shiftHue(theme.to, -drift)
        // Slow on purpose. The widget is redrawn every few seconds, not every frame,
        // so anything faster than a couple of degrees a second samples as a jump
        // rather than as motion. Over a 25-minute run this turns the gradient several
        // times and breathes the hue about a hundred times.
        val phase = ((elapsedSec * 1.5) % 360.0).toFloat()

        val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = stroke
            strokeCap = Paint.Cap.ROUND
            shader = SweepGradient(cx, cy, intArrayOf(from, to, from), null).apply {
                setLocalMatrix(Matrix().apply { setRotate(phase - 90f, cx, cy) })
            }
            alpha = if (paused) 90 else 255
        }

        // Sweep clockwise from twelve o'clock and shrink as the time goes: the ring is
        // the time left, so an empty ring and a zero clock mean the same thing.
        val sweep = (360.0 * fractionLeft(state, now)).toFloat()
        if (sweep > 0.5f) canvas.drawArc(rect, -90f, sweep, false, arc)

        // The head of the arc, so a nearly-finished ring still reads as alive.
        if (!paused && sweep > 0.5f) {
            val angle = Math.toRadians((-90.0 + sweep))
            val hx = cx + radius * cos(angle).toFloat()
            val hy = cy + radius * sin(angle).toFloat()
            val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = to
                alpha = 70
            }
            canvas.drawCircle(hx, hy, stroke * 1.15f, glow)
            canvas.drawCircle(hx, hy, stroke * 0.42f, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = 0xFFFFFFFF.toInt()
            })
        }

        return bitmap
    }

    /** Rotate a colour's hue, keeping saturation, value and alpha. */
    private fun shiftHue(color: Int, degrees: Float): Int {
        val hsv = FloatArray(3)
        Color.colorToHSV(color, hsv)
        hsv[0] = ((hsv[0] + degrees) % 360f + 360f) % 360f
        return Color.HSVToColor(Color.alpha(color), hsv)
    }

    // -----------------------------------------------------------------------
    // Formatting
    // -----------------------------------------------------------------------

    /** "01:25:00" or "25:00" — hours only when there are any, minutes always padded. */
    @JvmStatic
    fun clock(ms: Long): String {
        val total = max(0L, ms) / 1000L
        val h = total / 3600L
        val m = (total % 3600L) / 60L
        val s = total % 60L
        return if (h > 0L) {
            String.format(java.util.Locale.US, "%d:%02d:%02d", h, m, s)
        } else {
            String.format(java.util.Locale.US, "%02d:%02d", m, s)
        }
    }

    /** "1h 25m" / "25m" / "40s", for the history and the footer. */
    @JvmStatic
    fun duration(ms: Long): String {
        val total = max(0L, ms) / 1000L
        val h = total / 3600L
        val m = (total % 3600L) / 60L
        return when {
            h > 0L && m > 0L -> "${h}h ${m}m"
            h > 0L -> "${h}h"
            m > 0L -> "${m}m"
            else -> "${total}s"
        }
    }

    // -----------------------------------------------------------------------
    // Service, alarm, widgets
    // -----------------------------------------------------------------------

    /**
     * Bring the foreground service in line with the state.
     *
     * A refused start is survivable and deliberately not retried: Android 12+ can
     * refuse a background foreground-service start, but the widget's Chronometer
     * counts down on its own and [read] settles the run whenever anybody looks, so
     * all that is lost is the countdown notification.
     */
    private fun syncService(context: Context, state: State) {
        try {
            if (state.running) {
                val intent = Intent(context, FocusTimerService::class.java)
                    .setAction(WidgetContract.FOCUS_SERVICE_ACTION_SYNC)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } else {
                // stopService, not a STOP intent: stopping is allowed from the
                // background, whereas starting a service in order to stop it is the
                // thing Android 12 refuses.
                context.stopService(Intent(context, FocusTimerService::class.java))
            }
        } catch (e: Exception) {
            Log.w(TAG, "Focus service sync refused", e)
        }
    }

    /**
     * A safety net, not the timer.
     *
     * The service's own handler fires the completion on time. This alarm exists for
     * the case where the process is gone: it is inexact and allowed to run in Doze,
     * which is exactly the trade one wants for "make sure somebody notices, within a
     * few minutes, that the timer finished". Exact alarms are not used because from
     * Android 12 they need SCHEDULE_EXACT_ALARM, which the user would have to grant by
     * hand, and a focus timer is not worth that dialog.
     */
    private fun scheduleExpiry(context: Context, state: State) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val pi = expiryIntent(context)
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
            Log.w(TAG, "Could not schedule the focus expiry alarm", e)
        }
    }

    private fun cancelExpiry(context: Context) {
        try {
            (context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager)
                ?.cancel(expiryIntent(context))
        } catch (e: Exception) {
            Log.w(TAG, "Could not cancel the focus expiry alarm", e)
        }
    }

    private fun expiryIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, RC_EXPIRE,
        controlIntent(context, WidgetContract.FOCUS_OP_EXPIRE),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    /**
     * An explicit control broadcast at the timer widget.
     *
     * Explicit, so it needs no intent-filter; token-carrying, because an exported
     * receiver can be targeted by any app and a forged RESET would throw away
     * somebody's session. Same reasoning as WidgetContract.isTrustedControl.
     */
    @JvmStatic
    fun controlIntent(context: Context, op: String): Intent =
        Intent(context, TaskTimerWidget::class.java).apply {
            action = WidgetContract.ACTION_FOCUS_CONTROL
            putExtra(WidgetContract.EXTRA_FOCUS_OP, op)
            putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
        }

    /** Redraw every placed Focus Timer widget. */
    @JvmStatic
    fun refreshWidgets(context: Context) {
        try {
            val mgr = AppWidgetManager.getInstance(context) ?: return
            val ids = mgr.getAppWidgetIds(ComponentName(context, TaskTimerWidget::class.java))
            for (id in ids) TaskTimerWidget.updateWidget(context, mgr, id)
        } catch (e: Exception) {
            Log.w(TAG, "Could not refresh the focus widgets", e)
        }
    }

    // -----------------------------------------------------------------------
    // Notifications
    // -----------------------------------------------------------------------

    @JvmStatic
    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        if (nm.getNotificationChannel(WidgetContract.FOCUS_CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    WidgetContract.FOCUS_CHANNEL_ID,
                    context.getString(R.string.focus_channel_name),
                    // Silent and low: the running notification is a countdown to
                    // glance at, and it is on screen for the whole session.
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = context.getString(R.string.focus_channel_desc)
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                }
            )
        }
        if (nm.getNotificationChannel(WidgetContract.FOCUS_DONE_CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    WidgetContract.FOCUS_DONE_CHANNEL_ID,
                    context.getString(R.string.focus_done_channel_name),
                    // The one notification in this app that is allowed to interrupt:
                    // a timer nobody hears is a timer that did not work.
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = context.getString(R.string.focus_done_channel_desc)
                    enableVibration(true)
                }
            )
        }
    }

    /**
     * The running countdown notification.
     *
     * setUsesChronometer with a countdown base makes the system tick the digits, so
     * the service posts this once per state change rather than once per second.
     */
    @JvmStatic
    fun runningNotification(context: Context, state: State): Notification {
        createChannels(context)
        val builder = NotificationCompat.Builder(context, WidgetContract.FOCUS_CHANNEL_ID)
            .setContentTitle(
                if (state.paused) context.getString(R.string.focus_notif_paused)
                else context.getString(R.string.focus_notif_running)
            )
            .setSmallIcon(R.drawable.ic_stat_rise)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openIntent(context, RC_OPEN))
            .setOnlyAlertOnce(true)

        if (state.running) {
            builder.setUsesChronometer(true)
                .setWhen(state.endsAt)
                .setShowWhen(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                builder.setChronometerCountDown(true)
            }
            builder.setContentText(
                context.getString(R.string.focus_notif_of, duration(state.durationMs))
            )
            builder.addAction(
                R.drawable.ic_stat_pause, context.getString(R.string.focus_action_pause),
                broadcast(context, RC_PAUSE, WidgetContract.FOCUS_OP_PAUSE)
            )
        } else {
            builder.setShowWhen(false)
                .setContentText(clock(remaining(state)))
            builder.addAction(
                R.drawable.ic_stat_play, context.getString(R.string.focus_action_resume),
                broadcast(context, RC_PAUSE, WidgetContract.FOCUS_OP_RESUME)
            )
        }
        builder.addAction(
            R.drawable.ic_stat_quit, context.getString(R.string.focus_action_reset),
            broadcast(context, RC_RESET, WidgetContract.FOCUS_OP_RESET)
        )
        return builder.build()
    }

    private fun notifyDone(context: Context, plannedMs: Long) {
        try {
            createChannels(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return
            val notification = NotificationCompat.Builder(context, WidgetContract.FOCUS_DONE_CHANNEL_ID)
                .setContentTitle(context.getString(R.string.focus_done_title))
                .setContentText(
                    context.getString(R.string.focus_done_text, duration(plannedMs))
                )
                .setSmallIcon(R.drawable.ic_stat_rise)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(openIntent(context, RC_DONE_OPEN))
                .build()
            nm.notify(WidgetContract.FOCUS_DONE_NOTIFICATION_ID, notification)
        } catch (e: Exception) {
            Log.w(TAG, "Could not post the focus completion", e)
        }
    }

    /** Clear a stale "session done" card, so a new run starts with a clean shade. */
    @JvmStatic
    fun cancelDone(context: Context) {
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
                ?.cancel(WidgetContract.FOCUS_DONE_NOTIFICATION_ID)
        } catch (e: Exception) {
            // Nothing to do: a leftover card is cosmetic.
        }
    }

    private fun broadcast(context: Context, requestCode: Int, op: String): PendingIntent =
        PendingIntent.getBroadcast(
            context, requestCode, controlIntent(context, op),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun openIntent(context: Context, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            context, requestCode,
            Intent(context, MainActivity::class.java)
                .setAction(Intent.ACTION_VIEW)
                .setData(android.net.Uri.parse(WidgetContract.deepLinkFocus()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
}
