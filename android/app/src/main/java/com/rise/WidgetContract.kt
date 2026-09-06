package com.rise

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * WidgetContract
 * ==============
 * Kotlin mirror of src/services/WidgetContract.ts. Keep the two in lockstep:
 * SharedPreferences is an untyped string bag, so nothing but discipline keeps
 * the JS and native halves agreeing on key names.
 *
 * Prose overview: docs/WIDGET_CONTRACT.md
 */
object WidgetContract {

    // -----------------------------------------------------------------------
    // SharedPreferences
    // -----------------------------------------------------------------------

    const val PREFS_NAME = "RiseWidgetPrefs"

    const val KEY_WIDGET_DATA = "widgetData"
    const val KEY_WIDGET_LABELS = "widgetLabels"
    const val KEY_SELECTED_LABEL = "selectedLabel"
    const val KEY_TIMER_DATA = "timerData"
    const val KEY_HABIT_HISTORY = "habitHistoryData"
    const val KEY_PINNED_HABIT_ID = "pinnedHabitId"
    const val KEY_PINNED_HABIT_TITLE = "pinnedHabitTitle"

    /** The label every task widget falls back to when nothing is chosen. */
    const val LABEL_ALL = "All"

    /**
     * Whether this widget instance is currently showing its label list instead
     * of its task list. Per widget id, because two task widgets on the same
     * screen should not both flip when one is tapped.
     *
     * The picker is drawn *inside* the widget on purpose: routing it through a
     * transparent activity meant a cold app launch just to change a filter,
     * which is the one thing a home-screen filter should never need.
     */
    @JvmStatic
    fun labelPickerKey(appWidgetId: Int) = "labelPickerOpen_$appWidgetId"

    /** Written by JS. The authoritative habit state for the sensor widgets. */
    const val KEY_SENSOR_DATA = "sensorData"

    /** Written by the foreground service. Live values overlaid on KEY_SENSOR_DATA. */
    const val KEY_SENSOR_RUNTIME = "sensorRuntime"

    /** Written natively when the user taps a control with JS not running. Drained by JS. */
    const val KEY_PENDING_OPS = "pendingOps"

    /** Written by JS. Config the service needs (sunset window, noise threshold...). */
    const val KEY_SENSOR_CONFIG = "sensorConfig"

    /**
     * Which sensors the user has switched off. Written by BOTH sides: JS when
     * toggled in the app, native when toggled from a widget or the notification.
     * Last write wins, which is right here because both are direct user intent.
     */
    const val KEY_TRACKING_STATE = "trackingState"

    // -- Focus timer ------------------------------------------------------
    // The Focus Timer is deliberately not a habit: no goal, no streak, no day. It is
    // one countdown shared by the widget and the app tab, so its state lives here
    // rather than in either half — a widget tap has to work with JS dead, and the app
    // tab has to show the run the widget started.

    /** The single focus countdown. Fields are the FOCUS_F_* names below. */
    const val KEY_FOCUS_STATE = "focusState"

    /** Finished and abandoned runs, newest first, capped at FOCUS_HISTORY_MAX. */
    const val KEY_FOCUS_HISTORY = "focusHistory"

    /** The ring palette picked in the app tab; the widget ring uses the same one. */
    const val KEY_FOCUS_THEME = "focusTheme"

    // -- Habit timers -----------------------------------------------------
    // A TIMER habit used to be counted by a setInterval on the detail screen, which
    // meant the clock only advanced while that screen was mounted and lost the run
    // whenever the app was backgrounded. These carry the same deadline state the
    // Focus Timer does, keyed by habit id, so a run survives the app being closed.

    /** habitId -> the HT_F_* fields below. One JSON object for every habit. */
    const val KEY_HABIT_TIMERS = "habitTimers"

    const val HT_MODE_IDLE = "idle"
    const val HT_MODE_RUNNING = "running"
    const val HT_MODE_PAUSED = "paused"

    const val HT_F_MODE = "mode"
    const val HT_F_DURATION = "durationMs"
    const val HT_F_ENDS_AT = "endsAt"
    const val HT_F_REMAINING = "remainingMs"
    const val HT_F_STARTED_AT = "startedAt"
    /**
     * Millis of this run already banked into the habit's progress.
     *
     * Progress is credited as a *delta* through the pending-op queue, so without a
     * high-water mark a pause followed by a resume followed by another pause would
     * bank the first stretch twice.
     */
    const val HT_F_CREDITED = "creditedMs"
    /** The habit-day the run belongs to. A run left over from yesterday is dropped. */
    const val HT_F_DATE = "date"

    /**
     * Every habit the app knows about, for the wrapper widget to bind to. The
     * sensor slots in KEY_SENSOR_DATA only cover the five built-ins; this is the
     * same field set for the rest.
     */
    const val KEY_HABITS_DATA = "habitsData"

    /** Which habit a wrapper widget instance is showing, or absent for unbound. */
    @JvmStatic
    fun habitLinkKey(appWidgetId: Int) = "habitLink_$appWidgetId"

    /**
     * Whether this wrapper widget instance is currently showing its habit list
     * instead of its bound habit. Per widget id, for the same reason
     * [labelPickerKey] is: two wrapper widgets on one screen must not both flip.
     */
    @JvmStatic
    fun habitPickerKey(appWidgetId: Int) = "habitPickerOpen_$appWidgetId"

    // -- Native-private runtime state -------------------------------------
    // Only SensorForegroundService reads or writes these. They are kept in the
    // same prefs file so a single clear() wipes everything.

    /** TYPE_STEP_COUNTER value at the start of the current day. */
    const val KEY_STEP_BASELINE = "nativeStepBaseline"
    /** Steps banked before a reboot reset the hardware counter to zero. */
    const val KEY_STEP_CARRY = "nativeStepCarry"
    const val KEY_STEP_DATE = "nativeStepDate"
    /** Unlocks observed inside the current Digital Sunset window. */
    const val KEY_UNLOCKS = "nativeUnlocks"
    /** The night the unlock count belongs to (date of the cutoff evening). */
    const val KEY_UNLOCK_WINDOW = "nativeUnlockWindow"
    /** Seconds of accrued silence today. */
    const val KEY_NOISE_SECONDS = "nativeNoiseSeconds"
    const val KEY_NOISE_DATE = "nativeNoiseDate"
    /**
     * How many times the room went loud today after a real stretch of quiet.
     *
     * Banked with the seconds because it is the other half of the same claim: "40
     * minutes of quiet" means something different across two breaks than across
     * thirty, and a timer that only ever counts up cannot say which happened.
     */
    const val KEY_NOISE_BREACHES = "nativeNoiseBreaches"
    /** Metres walked/ridden today. */
    const val KEY_GPS_METERS = "nativeGpsMeters"
    const val KEY_GPS_DATE = "nativeGpsDate"
    /** Last window we auto-resolved, so a clean night is only banked once. */
    const val KEY_SUNSET_RESOLVED = "nativeSunsetResolved"
    /** Set while the service is running, so the app can tell on cold start. */
    const val KEY_SERVICE_RUNNING = "nativeServiceRunning"

    @JvmStatic
    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Local calendar date, YYYY-MM-DD.
     *
     * Must be local, not UTC: for a user at UTC+5:30 a UTC date rolls over at
     * 05:30 local, so anything recorded between midnight and 05:30 would land on
     * the previous day.
     */
    @JvmStatic
    fun localDate(millis: Long = System.currentTimeMillis()): String {
        val c = java.util.Calendar.getInstance()
        c.timeInMillis = millis
        return String.format(
            java.util.Locale.US, "%04d-%02d-%02d",
            c.get(java.util.Calendar.YEAR),
            c.get(java.util.Calendar.MONTH) + 1,
            c.get(java.util.Calendar.DAY_OF_MONTH)
        )
    }

    /** Parse "HH:mm" into minutes past midnight. Returns null when malformed. */
    @JvmStatic
    fun parseClock(hhmm: String?): Int? {
        val parts = (hhmm ?: "").split(":")
        if (parts.size != 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        if (h !in 0..23 || m !in 0..59) return null
        return h * 60 + m
    }

    // -----------------------------------------------------------------------
    // Slots
    // -----------------------------------------------------------------------

    const val SLOT_PEDOMETER = "pedometer"
    const val SLOT_GPS = "gps"
    const val SLOT_NOISE = "noise"
    const val SLOT_MOVEMENT = "movement"
    const val SLOT_SCREEN = "screen"

    val ALL_SLOTS = listOf(SLOT_PEDOMETER, SLOT_GPS, SLOT_NOISE, SLOT_MOVEMENT, SLOT_SCREEN)

    /**
     * Why a distance habit is not accruing metres.
     *
     * Zero metres has four unrelated causes and they used to be indistinguishable
     * from a broken app: the service logged its bail to logcat and every surface went
     * on drawing a confident 0.0 KM. These are the reasons, carried out to the widget
     * as a note and to JS as `gpsNote` so the flat line can explain itself.
     *
     * Internal to the native side — the strings JS sees are the finished note, not
     * these keys — so there is deliberately no TS mirror to keep in step.
     */
    const val GPS_BLOCKED_PERMISSION = "permission"
    const val GPS_BLOCKED_PROVIDER_OFF = "providerOff"
    const val GPS_BLOCKED_NO_PROVIDER = "noProvider"
    const val GPS_BLOCKED_NO_FIX = "noFix"

    /**
     * Ambient level, on the 0-100 scale below, at or under which Deep Silence counts
     * a second as quiet. Used whenever the habit has not been calibrated; the user's
     * own value arrives in the noise slot's `thresholdDb`.
     *
     * Must match NOISE_THRESHOLD_DEFAULT in the TS contract, or the same habit would
     * accrue differently with the app open and closed.
     */
    const val NOISE_THRESHOLD_DEFAULT = 45

    /**
     * The floor and ceiling a calibrated threshold is clamped to.
     *
     * Below 20 nothing but an anechoic chamber ever counts, and the habit becomes
     * impossible; above 80 a vacuum cleaner counts as silence, and it becomes
     * meaningless. Both ends are failure modes a slider can reach by accident.
     */
    const val NOISE_THRESHOLD_MIN = 20
    const val NOISE_THRESHOLD_MAX = 80

    /**
     * How long the room must stay quiet before going loud counts as a breach.
     *
     * A cough is not a broken silence. Without this a single transient would bank a
     * breach, and the count that is meant to say "you settled twice" would instead
     * say "you cleared your throat forty times".
     */
    const val NOISE_BREACH_MIN_QUIET_SECONDS = 20

    /** Metadata keys inside the sensorData object are prefixed with '_' and are not slots. */
    const val META_KEY = "_meta"
    const val SENSOR_PAYLOAD_VERSION = 2

    @JvmStatic
    fun isMetaKey(key: String) = key.startsWith("_")

    // -----------------------------------------------------------------------
    // Slot field names  (must match SensorSlotPayload in the TS contract)
    // -----------------------------------------------------------------------

    const val F_EXISTS = "exists"
    const val F_ID = "id"
    const val F_TEMPLATE_ID = "templateId"
    const val F_TITLE = "title"
    const val F_HABIT_TYPE = "habitType"
    const val F_PROGRESS = "progress"
    const val F_GOAL = "goal"
    const val F_UNIT = "unit"
    const val F_STEP = "step"
    const val F_DISPLAY_MODE = "displayMode"
    const val F_GOAL_DIRECTION = "goalDirection"
    const val F_IS_COMPLETED = "isCompleted"
    const val F_STREAK = "streak"
    const val F_CONTROLS = "controls"
    const val F_LIVE = "live"
    const val F_NOTE = "note"

    /**
     * The habit-day a runtime overlay describes, YYYY-MM-DD local.
     *
     * Only ever written into KEY_SENSOR_RUNTIME, never into the JS payload. Without
     * it a stale overlay outlives the day it belongs to: the service resets its
     * counters in rollDayIfNeeded, which only runs while the service is ticking, so
     * a service killed before midnight leaves yesterday's step count sitting in
     * prefs where readSlot's maxOf would prefer it over today's real zero.
     */
    const val F_DATE = "date"

    const val F_META_VERSION = "version"
    const val F_META_SYNCED_AT = "syncedAt"
    const val F_META_LOGGED_IN = "loggedIn"

    // -----------------------------------------------------------------------
    // Display modes and goal direction
    // -----------------------------------------------------------------------

    const val DISPLAY_INT = "int"
    const val DISPLAY_DISTANCE = "distance"
    const val DISPLAY_DURATION = "duration"
    const val DISPLAY_SUNSET = "sunset"

    const val DIR_AT_LEAST = "atLeast"
    const val DIR_AT_MOST = "atMost"

    // -----------------------------------------------------------------------
    // Controls
    // -----------------------------------------------------------------------

    const val CTRL_DEC = "dec"
    const val CTRL_INC = "inc"
    const val CTRL_CHECK = "check"
    const val CTRL_TIMER = "timer"
    const val CTRL_CONFIRM = "confirm"
    const val CTRL_SLIPPED = "slipped"
    /**
     * Switches this slot's sensor on or off. Not a habit mutation, so
     * opForControl returns null for it and the renderer routes it to
     * ACTION_SET_TRACKING instead of ACTION_WIDGET_CONTROL.
     */
    const val CTRL_TRACK = "track"
    const val CTRL_REFRESH = "refresh"

    /**
     * Start / pause a TIMER habit's run. One button, because the label reads out
     * the state it is in and there is never room on a widget for two.
     *
     * Like CTRL_TRACK this is not a habit mutation, so opForControl returns null:
     * the run is state, and only the seconds it produces become progress. See
     * HabitTimer, which credits them through OP_TIMER_ADD as it goes.
     */
    const val CTRL_RUN = "run"

    /** Throw away the rest of a TIMER habit's run, keeping what it already earned. */
    const val CTRL_RESET = "reset"

    /** Label drawn on each control button. */
    @JvmStatic
    fun controlLabel(control: String, step: Double, displayMode: String): String = when (control) {
        CTRL_DEC -> "−" + formatStep(step, displayMode)
        CTRL_INC -> "+" + formatStep(step, displayMode)
        CTRL_CHECK -> "✓ DONE"
        CTRL_TIMER -> "+" + formatStep(step, displayMode)
        CTRL_CONFIRM -> "✓ HELD"
        CTRL_SLIPPED -> "✕ SLIPPED"
        CTRL_TRACK -> trackLabel(true)
        CTRL_REFRESH -> "↻"
        CTRL_RUN -> runLabel(HT_MODE_IDLE)
        CTRL_RESET -> "↺ RESET"
        else -> control.uppercase()
    }

    /**
     * The run button reads out what tapping it will do, unlike [trackLabel], which
     * reads out the state. A countdown already shows its own state in the digits
     * next to the button, so repeating it there would waste the only wide row a
     * widget has.
     */
    @JvmStatic
    fun runLabel(mode: String): String = when (mode) {
        HT_MODE_RUNNING -> "❙❙ PAUSE"
        HT_MODE_PAUSED -> "▶ RESUME"
        else -> "▶ START"
    }

    /**
     * The track button reads out the state it is *in*, not the action it performs,
     * because a widget has no room for both and the state is the thing a user
     * glances for. Tapping it flips the state.
     */
    @JvmStatic
    fun trackLabel(tracking: Boolean): String = if (tracking) "◉ ON" else "◌ OFF"

    private fun formatStep(step: Double, displayMode: String): String = when (displayMode) {
        DISPLAY_DURATION -> "${(step / 60).toInt().coerceAtLeast(1)}M"
        DISPLAY_DISTANCE -> if (step < 1.0) "${(step * 1000).toInt()}M" else trimNumber(step)
        else -> trimNumber(step)
    }

    // -----------------------------------------------------------------------
    // Pending ops
    // -----------------------------------------------------------------------

    const val OP_INC = "inc"
    const val OP_TOGGLE = "toggle"
    const val OP_TIMER_ADD = "timerAdd"
    const val OP_SUNSET_CONFIRM = "sunsetConfirm"
    const val OP_SUNSET_SLIPPED = "sunsetSlipped"

    const val PENDING_OPS_MAX = 200

    /** Which op a control button fires, or null for a pure redraw. */
    @JvmStatic
    fun opForControl(control: String): String? = when (control) {
        CTRL_DEC, CTRL_INC -> OP_INC
        CTRL_CHECK -> OP_TOGGLE
        CTRL_TIMER -> OP_TIMER_ADD
        CTRL_CONFIRM -> OP_SUNSET_CONFIRM
        CTRL_SLIPPED -> OP_SUNSET_SLIPPED
        // CTRL_RUN and CTRL_RESET are missing on purpose: they move the timer's
        // state machine, and HabitTimer enqueues the seconds that fall out of it.
        else -> null
    }

    /**
     * Append an op to the queue JS will drain on next foreground.
     * Trims from the front so the blob stays bounded.
     *
     * `date` names the habit-day the op belongs to. Pass it explicitly for the
     * Digital Sunset window, which straddles midnight.
     */
    @JvmStatic
    @JvmOverloads
    fun enqueueOp(
        context: Context,
        op: String,
        habitId: String,
        slot: String,
        amount: Double,
        date: String? = null
    ) {
        val p = prefs(context)
        val arr = try {
            JSONArray(p.getString(KEY_PENDING_OPS, "[]") ?: "[]")
        } catch (e: Exception) {
            JSONArray()
        }
        arr.put(JSONObject().apply {
            put("opId", UUID.randomUUID().toString())
            put("op", op)
            put("habitId", habitId)
            put("slot", slot)
            put("amount", amount)
            put("ts", System.currentTimeMillis())
            if (date != null) put("date", date)
        })
        val trimmed = if (arr.length() > PENDING_OPS_MAX) {
            JSONArray().also { out ->
                for (i in (arr.length() - PENDING_OPS_MAX) until arr.length()) out.put(arr.get(i))
            }
        } else arr
        p.edit().putString(KEY_PENDING_OPS, trimmed.toString()).apply()
    }

    // -----------------------------------------------------------------------
    // Intents
    // -----------------------------------------------------------------------

    const val ACTION_WIDGET_UPDATE = "com.rise.WIDGET_UPDATE"
    const val ACTION_WIDGET_CONTROL = "com.rise.WIDGET_CONTROL"
    /** Turn one slot's sensor on or off. Extras: EXTRA_SLOT, EXTRA_ENABLED, EXTRA_TOKEN. */
    const val ACTION_SET_TRACKING = "com.rise.SET_TRACKING"
    /** Global pause / resume, fired by the notification actions. */
    const val ACTION_PAUSE_ALL = "com.rise.PAUSE_ALL"
    const val ACTION_RESUME_ALL = "com.rise.RESUME_ALL"
    /** Stop tracking, stop the service, and stay stopped until the app reopens. */
    const val ACTION_QUIT = "com.rise.QUIT"
    const val ACTION_TOGGLE_TASK = "com.rise.TOGGLE_TASK"
    const val ACTION_TIMER_ACTION = "com.rise.TIMER_ACTION"

    /**
     * A Focus Timer button was tapped. Extras: EXTRA_FOCUS_OP, EXTRA_TOKEN.
     *
     * Every one of these is handled inside the receiver — none of them opens the app.
     * That is the whole point of the rebuilt timer: the old one routed PAUSE and STOP
     * through an activity, so a countdown on the home screen could not be paused
     * without launching Rise.
     */
    const val ACTION_FOCUS_CONTROL = "com.rise.FOCUS_CONTROL"

    /**
     * A TIMER habit's run button was tapped, or its deadline passed.
     * Extras: EXTRA_HABIT_ID, EXTRA_OP (one of the HT_OP_* values), EXTRA_TOKEN.
     */
    const val ACTION_HABIT_TIMER = "com.rise.HABIT_TIMER"

    const val HT_OP_START = "start"
    const val HT_OP_PAUSE = "pause"
    const val HT_OP_RESUME = "resume"
    const val HT_OP_RESET = "reset"
    /** Fired by the safety-net alarm; settles a run whose deadline has passed. */
    const val HT_OP_EXPIRE = "expire"
    /** One button on the widget: start, pause or resume, whichever applies. */
    const val HT_OP_TOGGLE = "toggle"

    /** Bind a wrapper widget to a habit. Extras: EXTRA_HABIT_ID, EXTRA_APPWIDGET_ID. */
    const val ACTION_LINK_HABIT = "com.rise.LINK_HABIT"
    /** Open the wrapper widget's own habit picker. Extra: EXTRA_APPWIDGET_ID. */
    const val ACTION_PICK_HABIT = "com.rise.PICK_HABIT"

    const val EXTRA_OP = "extra_op"
    const val EXTRA_HABIT_ID = "extra_habit_id"
    const val EXTRA_SLOT = "extra_slot"
    const val EXTRA_AMOUNT = "extra_amount"
    /** Boolean for ACTION_SET_TRACKING: true = collect, false = pause this slot. */
    const val EXTRA_ENABLED = "extra_enabled"

    /** One of the FOCUS_OP_* values, for ACTION_FOCUS_CONTROL. */
    const val EXTRA_FOCUS_OP = "extra_focus_op"

    /**
     * Proves a control broadcast came from one of our own PendingIntents.
     *
     * The five sensor receivers must stay exported so the widget host can deliver
     * APPWIDGET_UPDATE, and an exported receiver can be targeted by an *explicit*
     * intent from any app regardless of which intent-filters it declares. Leaving
     * ACTION_WIDGET_CONTROL out of the manifest therefore hides the action but does
     * not protect it: another app could still forge a tap and, by toggling a habit
     * repeatedly, corrupt a real streak.
     *
     * The token closes that. It lives in our MODE_PRIVATE prefs, which no other app
     * can read, and it only ever leaves the process inside a PendingIntent held by
     * the widget host, whose extras a third party cannot inspect.
     */
    const val EXTRA_TOKEN = "extra_token"

    private const val KEY_CONTROL_TOKEN = "nativeControlToken"

    /** The current token, minted on first use and stable for the install. */
    @JvmStatic
    fun controlToken(context: Context): String {
        val p = prefs(context)
        p.getString(KEY_CONTROL_TOKEN, null)?.takeIf { it.isNotEmpty() }?.let { return it }
        val minted = UUID.randomUUID().toString()
        p.edit().putString(KEY_CONTROL_TOKEN, minted).apply()
        return minted
    }

    /** True only for a control intent carrying this install's token. */
    @JvmStatic
    fun isTrustedControl(context: Context, intent: Intent): Boolean {
        val supplied = intent.getStringExtra(EXTRA_TOKEN) ?: return false
        return supplied.isNotEmpty() && supplied == controlToken(context)
    }

    // -----------------------------------------------------------------------
    // Tracking / pause state
    // -----------------------------------------------------------------------
    //
    // Mirrors the TrackingState interface in WidgetContract.ts. Pausing is
    // indefinite on purpose: it survives restarts and reboots until the user turns
    // tracking back on. A pause that quietly expired overnight would re-enable a
    // microphone or a location listener somebody switched off deliberately.

    const val F_PAUSED = "paused"
    const val F_PAUSED_ALL = "pausedAll"
    const val F_QUIT = "quit"

    @JvmStatic
    fun readTracking(context: Context): JSONObject = try {
        JSONObject(prefs(context).getString(KEY_TRACKING_STATE, "{}") ?: "{}")
    } catch (e: Exception) {
        JSONObject()
    }

    private fun writeTracking(context: Context, state: JSONObject) {
        prefs(context).edit().putString(KEY_TRACKING_STATE, state.toString()).apply()
    }

    @JvmStatic
    fun isPausedAll(context: Context): Boolean =
        readTracking(context).optBoolean(F_PAUSED_ALL, false)

    /** True once the user chose "quit completely"; only opening the app clears it. */
    @JvmStatic
    fun isQuit(context: Context): Boolean =
        readTracking(context).optBoolean(F_QUIT, false)

    /** Slots switched off individually, for the service's listener bookkeeping. */
    @JvmStatic
    fun pausedSlots(context: Context): List<String> {
        val arr = readTracking(context).optJSONArray(F_PAUSED) ?: return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            val s = arr.optString(i)
            if (s.isNotEmpty()) out.add(s)
        }
        return out
    }

    /** True when this slot should currently be collecting. Mirrors isSlotTracking in TS. */
    @JvmStatic
    fun isSlotTracking(context: Context, slot: String): Boolean {
        val state = readTracking(context)
        if (state.optBoolean(F_QUIT, false) || state.optBoolean(F_PAUSED_ALL, false)) return false
        val paused = state.optJSONArray(F_PAUSED) ?: return true
        for (i in 0 until paused.length()) if (paused.optString(i) == slot) return false
        return true
    }

    /**
     * Switch one slot's sensor on or off, leaving the other slots alone.
     *
     * Enabling a slot also lifts a global pause or quit. Without that, tapping a
     * widget's track button while everything is paused would look like it did
     * nothing at all — the flag would flip but the sensor would stay dark.
     */
    @JvmStatic
    fun setSlotTracking(context: Context, slot: String, enabled: Boolean) {
        val state = readTracking(context)
        val kept = JSONArray()
        val existing = state.optJSONArray(F_PAUSED)
        if (existing != null) {
            for (i in 0 until existing.length()) {
                val s = existing.optString(i)
                if (s.isNotEmpty() && s != slot) kept.put(s)
            }
        }
        if (!enabled) kept.put(slot)
        state.put(F_PAUSED, kept)
        if (enabled) {
            state.put(F_PAUSED_ALL, false)
            state.put(F_QUIT, false)
        }
        writeTracking(context, state)
    }

    /**
     * Global pause / resume. Per-slot pauses are preserved, so resuming does not
     * silently switch a sensor back on that the user had turned off on its own.
     */
    @JvmStatic
    fun setPausedAll(context: Context, paused: Boolean) {
        val state = readTracking(context)
        state.put(F_PAUSED_ALL, paused)
        if (!paused) state.put(F_QUIT, false)
        writeTracking(context, state)
    }

    /**
     * "Quit completely". Deliberately a separate flag from pausedAll rather than an
     * extra-strong version of it: BootReceiver must be able to tell "paused" (still
     * a running service showing a paused notification) from "quit" (no service at
     * all, and none after a reboot either).
     */
    @JvmStatic
    fun setQuit(context: Context, quit: Boolean) {
        val state = readTracking(context)
        state.put(F_QUIT, quit)
        writeTracking(context, state)
    }

    @JvmStatic
    fun deepLinkHabitDetail(habitId: String) = "rise://item/$habitId/habit"
    @JvmStatic
    fun deepLinkAddSensorHabit(templateId: String) = "rise://add-sensor-habit/$templateId"

    /** Broadcast every widget provider so they redraw from prefs. */
    @JvmStatic
    fun broadcastUpdate(context: Context) {
        context.sendBroadcast(Intent(ACTION_WIDGET_UPDATE).setPackage(context.packageName))
    }

    // -----------------------------------------------------------------------
    // Foreground service
    // -----------------------------------------------------------------------

    const val SERVICE_ACTION_START = "com.rise.sensor.START"
    const val SERVICE_ACTION_STOP = "com.rise.sensor.STOP"
    const val SERVICE_ACTION_REFRESH = "com.rise.sensor.REFRESH"
    const val SERVICE_CHANNEL_ID = "rise_sensors"
    const val SERVICE_NOTIFICATION_ID = 4711

    // -----------------------------------------------------------------------
    // Focus timer
    // -----------------------------------------------------------------------
    //
    // Mirrors FocusState / FocusRun / FocusTheme in src/services/FocusTimer.ts.
    // The state machine itself lives in FocusTimer.kt; only the vocabulary is here,
    // because both halves and three files have to agree on it.

    const val FOCUS_MODE_IDLE = "idle"
    const val FOCUS_MODE_RUNNING = "running"
    const val FOCUS_MODE_PAUSED = "paused"

    /** Which of the two setup fields the up/down buttons currently act on. */
    const val FOCUS_FIELD_H = "h"
    const val FOCUS_FIELD_M = "m"

    // State fields.
    const val FOCUS_F_MODE = "mode"
    const val FOCUS_F_SETUP_H = "setupH"
    const val FOCUS_F_SETUP_M = "setupM"
    const val FOCUS_F_FIELD = "field"
    const val FOCUS_F_DURATION = "durationMs"
    /** Wall-clock millis the run ends at. Authoritative while running. */
    const val FOCUS_F_ENDS_AT = "endsAt"
    /** Millis left. Authoritative only while paused. */
    const val FOCUS_F_REMAINING = "remainingMs"
    const val FOCUS_F_STARTED_AT = "startedAt"
    const val FOCUS_F_SOURCE = "source"

    // History fields.
    const val FOCUS_H_ID = "id"
    const val FOCUS_H_STARTED_AT = "startedAt"
    const val FOCUS_H_ENDED_AT = "endedAt"
    const val FOCUS_H_PLANNED = "plannedMs"
    const val FOCUS_H_ACTUAL = "actualMs"
    const val FOCUS_H_COMPLETED = "completed"
    const val FOCUS_H_SOURCE = "source"

    // Theme fields. from/to/track are #RRGGBB strings.
    const val FOCUS_T_ID = "id"
    const val FOCUS_T_FROM = "from"
    const val FOCUS_T_TO = "to"
    const val FOCUS_T_TRACK = "track"

    // Ops. The widget's buttons and the bridge both speak these.
    const val FOCUS_OP_SELECT_H = "selectH"
    const val FOCUS_OP_SELECT_M = "selectM"
    const val FOCUS_OP_UP = "up"
    const val FOCUS_OP_DOWN = "down"
    const val FOCUS_OP_START = "start"
    const val FOCUS_OP_PAUSE = "pause"
    const val FOCUS_OP_RESUME = "resume"
    /** Back to the setup face. Records the run as not completed if one was going. */
    const val FOCUS_OP_RESET = "reset"
    /** Fired by the safety-net alarm: settle a run whose deadline has passed. */
    const val FOCUS_OP_EXPIRE = "expire"

    /** Who started the run, for the history list. */
    const val FOCUS_SOURCE_WIDGET = "widget"
    const val FOCUS_SOURCE_APP = "app"

    const val FOCUS_HISTORY_MAX = 100

    /** A run has to be at least this long to be worth recording. */
    const val FOCUS_MIN_MS = 60_000L

    const val FOCUS_CHANNEL_ID = "rise_focus"
    const val FOCUS_DONE_CHANNEL_ID = "rise_focus_done"
    const val FOCUS_NOTIFICATION_ID = 4712
    const val FOCUS_DONE_NOTIFICATION_ID = 4713

    const val FOCUS_SERVICE_ACTION_SYNC = "com.rise.focus.SYNC"
    const val FOCUS_SERVICE_ACTION_STOP = "com.rise.focus.STOP"

    /**
     * The Focus tab. `home/` is not decoration: React Navigation concatenates nested
     * paths, and Focus is a tab inside the Main stack screen whose path is `home`, so
     * `rise://focus` matches nothing and lands the user on the default tab.
     */
    @JvmStatic
    fun deepLinkFocus() = "rise://home/focus"

    /** "01:25" — always two places per field, which is what the setup face promises. */
    @JvmStatic
    fun focusPad(value: Int): String = String.format(java.util.Locale.US, "%02d", value)

    // -----------------------------------------------------------------------
    // Digital Sunset defaults
    // -----------------------------------------------------------------------

    const val SUNSET_CUTOFF_DEFAULT = "22:00"
    const val SUNSET_WINDOW_END_DEFAULT = "06:00"
    const val SUNSET_ALLOWANCE_MINUTES_DEFAULT = 5

    const val VERIFY_USAGESTATS = "usagestats"
    const val VERIFY_UNLOCKS = "unlocks"
    const val VERIFY_MANUAL = "manual"

    // -----------------------------------------------------------------------
    // Shared read helpers
    // -----------------------------------------------------------------------

    /**
     * Read the sensor payload with the native runtime overlay applied, so widgets
     * show live values even when JS has not run for hours.
     *
     * Returns null if there is no readable payload at all; the caller should then
     * render its empty state rather than stale hardcoded numbers.
     *
     * @param expectedDate the habit-day the caller is rendering, YYYY-MM-DD local.
     *        The overlay is discarded unless it was written for that same day. Pass
     *        null only when the caller genuinely does not care which day it gets.
     */
    @JvmStatic
    @JvmOverloads
    fun readSlot(context: Context, slot: String, expectedDate: String? = null): JSONObject? {
        val p = prefs(context)
        val base = try {
            JSONObject(p.getString(KEY_SENSOR_DATA, "{}") ?: "{}")
        } catch (e: Exception) {
            return null
        }
        val meta = base.optJSONObject(META_KEY)
        if (meta != null && meta.optInt(F_META_VERSION, 0) > SENSOR_PAYLOAD_VERSION) {
            // Payload written by a newer JS than this APK understands.
            return null
        }
        val slotObj = base.optJSONObject(slot) ?: return null

        // Overlay live values from the service. Native only ever contributes
        // progress / note / live -- never identity or goal, which JS owns.
        try {
            val runtime = JSONObject(p.getString(KEY_SENSOR_RUNTIME, "{}") ?: "{}")
            val live = runtime.optJSONObject(slot)
            val sameHabit = live != null && live.optString(F_ID) == slotObj.optString(F_ID)
            // An undated overlay is one written by an older build of the service; it
            // cannot be validated, and preferring an unvalidatable number over the
            // correctly-dated one JS wrote is how the widget ends up showing
            // yesterday. The service redates it within one tick of starting.
            val sameDay = live != null &&
                expectedDate != null &&
                live.optString(F_DATE) == expectedDate
            if (sameHabit && sameDay) {
                if (live!!.has(F_PROGRESS)) {
                    // The service is authoritative only when it is ahead, so a
                    // stale runtime blob can never walk progress backwards. This
                    // holds for inverse goals too: screen-time minutes and unlock
                    // counts only ever grow inside a single window.
                    val nativeProgress = live.optDouble(F_PROGRESS, 0.0)
                    val jsProgress = slotObj.optDouble(F_PROGRESS, 0.0)
                    slotObj.put(F_PROGRESS, maxOf(nativeProgress, jsProgress))
                }
                if (live.has(F_NOTE)) slotObj.put(F_NOTE, live.optString(F_NOTE))
                slotObj.put(F_LIVE, true)
            }
        } catch (e: Exception) {
            // A malformed runtime overlay must never break the base render.
        }
        return slotObj
    }

    @JvmStatic
    fun isLoggedIn(context: Context): Boolean {
        return try {
            val base = JSONObject(prefs(context).getString(KEY_SENSOR_DATA, "{}") ?: "{}")
            base.optJSONObject(META_KEY)?.optBoolean(F_META_LOGGED_IN, true) ?: true
        } catch (e: Exception) {
            true
        }
    }

    @JvmStatic
    fun controlsOf(slot: JSONObject): List<String> {
        val arr = slot.optJSONArray(F_CONTROLS) ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optString(it).takeIf { s -> s.isNotEmpty() } }
    }

    // -----------------------------------------------------------------------
    // Shared formatting  (keeps all five sensor widgets visually identical)
    // -----------------------------------------------------------------------

    /** The big number on the widget face. */
    @JvmStatic
    fun formatValue(value: Double, displayMode: String): String = when (displayMode) {
        DISPLAY_DISTANCE -> if (value < 1.0) "${(value * 1000).toInt()}" else trimNumber(value)
        DISPLAY_DURATION -> "${(value / 60).toInt()}"
        DISPLAY_SUNSET -> "${value.toInt()}"
        else -> value.toInt().toString()
    }

    /** The unit caption under the big number, derived when JS did not supply one. */
    @JvmStatic
    fun formatUnit(value: Double, displayMode: String, supplied: String?): String {
        if (!supplied.isNullOrEmpty()) {
            // Distance flips between metres and km, so override only that case.
            if (displayMode == DISPLAY_DISTANCE && value < 1.0) return "METRES"
            return supplied.uppercase()
        }
        return when (displayMode) {
            DISPLAY_DISTANCE -> if (value < 1.0) "METRES" else "KM"
            DISPLAY_DURATION -> "MINUTES"
            else -> ""
        }
    }

    @JvmStatic
    fun formatGoal(goal: Double, displayMode: String, direction: String): String {
        if (goal <= 0.0) return ""
        val prefix = if (direction == DIR_AT_MOST) "LIMIT" else "GOAL"
        val body = when (displayMode) {
            DISPLAY_DISTANCE -> if (goal < 1.0) "${(goal * 1000).toInt()}M" else "${trimNumber(goal)}KM"
            DISPLAY_DURATION -> "${(goal / 60).toInt()}M"
            else -> goal.toInt().toString()
        }
        return "$prefix: $body"
    }

    /**
     * 0..100 for the ProgressBar.
     *
     * The same ratio serves both directions, but it reads differently: for an
     * inverse goal the bar fills as the allowance is consumed, so a full bar means
     * the limit is blown rather than the habit is done.
     */
    @JvmStatic
    fun progressPercent(progress: Double, goal: Double, direction: String): Int {
        if (goal <= 0.0) return 0
        return ((progress / goal) * 100.0).coerceIn(0.0, 100.0).toInt()
    }

    /** Short status word shown next to the progress bar. */
    @JvmStatic
    fun statusBadge(slot: JSONObject): String {
        val completed = slot.optBoolean(F_IS_COMPLETED, false)
        val direction = slot.optString(F_GOAL_DIRECTION, DIR_AT_LEAST)
        val progress = slot.optDouble(F_PROGRESS, 0.0)
        val goal = slot.optDouble(F_GOAL, 0.0)
        return when {
            completed -> "COMPLETE"
            direction == DIR_AT_MOST && goal > 0 && progress > goal -> "BROKEN"
            direction == DIR_AT_MOST -> "HOLDING"
            progress <= 0.0 -> "NOT STARTED"
            else -> "IN PROGRESS"
        }
    }

    private fun trimNumber(v: Double): String {
        val oneDp = Math.round(v * 10.0) / 10.0
        return if (oneDp == Math.floor(oneDp)) oneDp.toInt().toString() else oneDp.toString()
    }
}
