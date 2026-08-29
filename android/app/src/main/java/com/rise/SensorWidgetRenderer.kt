package com.rise

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject

/**
 * SensorWidgetRenderer
 * ====================
 * One renderer for all five sensor widgets.
 *
 * Previously each of StepWidget/DistanceWidget/SilenceWidget/MovementWidget/
 * SunsetWidget carried its own copy of the render logic, and each copy hardcoded
 * the habit's name, unit and goal ("STEP LEGEND", "STEPS", "GOAL: 10000"). That is
 * why the widgets appeared not to work: they showed the same numbers regardless of
 * what the habit was actually configured to do, and a habit that did not exist in
 * the pedometer slot still drew a step widget. Everything drawn here comes from the
 * payload JS writes, with the foreground service's live values overlaid by
 * WidgetContract.readSlot.
 *
 * Three behaviours are deliberate:
 *
 *  1. Controls act in place. A control tap is a *broadcast* back to the provider,
 *     not an activity launch, so tapping "+100" bumps the number on the home screen
 *     instead of throwing the user into the app. The card body still launches
 *     HabitDetail, because that is where the full history lives.
 *
 *  2. Every control intent carries a unique data Uri. Intent extras are not part of
 *     Intent.filterEquals, so two broadcasts differing only in their extras would
 *     collapse onto the same PendingIntent and every button on the widget would
 *     fire whichever op was registered first.
 *
 *  3. A tap is applied optimistically to the local payload before JS ever hears
 *     about it, then queued for JS. JS is the source of truth and overwrites the
 *     optimistic value on next sync, so the two cannot drift -- but the user sees
 *     the number move immediately even with the app force-stopped.
 */
object SensorWidgetRenderer {

    private const val TAG = "SensorWidgetRenderer"

    /**
     * Nothing-style palette.
     *
     * `val`, not `const val`: these literals are wider than Int, so they need
     * `.toInt()`, and a method call is not reliably a compile-time constant
     * expression. A plain object field costs nothing here.
     */
    private val COLOR_ACCENT = 0xFFD71921.toInt()
    private val COLOR_DONE = 0xFF4ADE80.toInt()
    private val COLOR_MUTED = 0xFF888888.toInt()
    private val COLOR_TEXT = 0xFFFFFFFF.toInt()

    /**
     * Everything that differs between the five widgets. Note that the habit's
     * *title* is not in here -- that comes from the payload, so renaming a habit in
     * the app renames it on the home screen.
     */
    data class SlotSpec(
        val slot: String,
        val templateId: String,
        val provider: Class<out android.appwidget.AppWidgetProvider>,
        val icon: Int,
        /** Which anim_<sequence>_f1..f6 set to flip through while in progress. */
        val idleSequence: String,
        /** Shown as the widget's name before any habit is linked to the slot. */
        val placeholderTitle: String,
        val emptyButtonLabel: String
    )

    val SPECS: Map<String, SlotSpec> = mapOf(
        WidgetContract.SLOT_PEDOMETER to SlotSpec(
            slot = WidgetContract.SLOT_PEDOMETER,
            templateId = "step_legend",
            provider = StepWidget::class.java,
            icon = R.drawable.widget_icon_steps,
            idleSequence = "step",
            placeholderTitle = "STEP LEGEND",
            emptyButtonLabel = "+ LINK STEPS"
        ),
        WidgetContract.SLOT_GPS to SlotSpec(
            slot = WidgetContract.SLOT_GPS,
            templateId = "city_glider",
            provider = DistanceWidget::class.java,
            icon = R.drawable.widget_icon_distance,
            idleSequence = "glider",
            placeholderTitle = "CITY GLIDER",
            emptyButtonLabel = "+ LINK DISTANCE"
        ),
        WidgetContract.SLOT_NOISE to SlotSpec(
            slot = WidgetContract.SLOT_NOISE,
            templateId = "deep_silence",
            provider = SilenceWidget::class.java,
            icon = R.drawable.widget_icon_silence,
            idleSequence = "silence",
            placeholderTitle = "DEEP SILENCE",
            emptyButtonLabel = "+ LINK SILENCE"
        ),
        WidgetContract.SLOT_MOVEMENT to SlotSpec(
            slot = WidgetContract.SLOT_MOVEMENT,
            templateId = "immediate_rise",
            provider = MovementWidget::class.java,
            icon = R.drawable.widget_icon_movement,
            idleSequence = "movement",
            placeholderTitle = "IMMEDIATE RISE",
            emptyButtonLabel = "+ LINK MOVEMENT"
        ),
        WidgetContract.SLOT_SCREEN to SlotSpec(
            slot = WidgetContract.SLOT_SCREEN,
            templateId = "digital_sunset",
            provider = SunsetWidget::class.java,
            icon = R.drawable.widget_icon_sunset,
            idleSequence = "sunset",
            placeholderTitle = "DIGITAL SUNSET",
            emptyButtonLabel = "+ LINK SUNSET"
        )
    )

    // -----------------------------------------------------------------------
    // Resource tables
    //
    // Listed explicitly rather than resolved by name through
    // Resources.getIdentifier, so a missing or misnamed frame is a compile error
    // instead of a blank widget on someone's home screen.
    // -----------------------------------------------------------------------

    private val FRAME_VIEWS = intArrayOf(
        R.id.habit_anim_frame1,
        R.id.habit_anim_frame2,
        R.id.habit_anim_frame3,
        R.id.habit_anim_frame4,
        R.id.habit_anim_frame5,
        R.id.habit_anim_frame6
    )

    private val BUTTON_VIEWS = intArrayOf(
        R.id.habit_btn_1,
        R.id.habit_btn_2,
        R.id.habit_btn_3
    )

    private val SEQUENCES: Map<String, IntArray> = mapOf(
        "step" to intArrayOf(
            R.drawable.anim_step_f1, R.drawable.anim_step_f2, R.drawable.anim_step_f3,
            R.drawable.anim_step_f4, R.drawable.anim_step_f5, R.drawable.anim_step_f6
        ),
        "glider" to intArrayOf(
            R.drawable.anim_glider_f1, R.drawable.anim_glider_f2, R.drawable.anim_glider_f3,
            R.drawable.anim_glider_f4, R.drawable.anim_glider_f5, R.drawable.anim_glider_f6
        ),
        "silence" to intArrayOf(
            R.drawable.anim_silence_f1, R.drawable.anim_silence_f2, R.drawable.anim_silence_f3,
            R.drawable.anim_silence_f4, R.drawable.anim_silence_f5, R.drawable.anim_silence_f6
        ),
        "movement" to intArrayOf(
            R.drawable.anim_movement_f1, R.drawable.anim_movement_f2, R.drawable.anim_movement_f3,
            R.drawable.anim_movement_f4, R.drawable.anim_movement_f5, R.drawable.anim_movement_f6
        ),
        "sunset" to intArrayOf(
            R.drawable.anim_sunset_f1, R.drawable.anim_sunset_f2, R.drawable.anim_sunset_f3,
            R.drawable.anim_sunset_f4, R.drawable.anim_sunset_f5, R.drawable.anim_sunset_f6
        ),
        "complete" to intArrayOf(
            R.drawable.anim_complete_f1, R.drawable.anim_complete_f2, R.drawable.anim_complete_f3,
            R.drawable.anim_complete_f4, R.drawable.anim_complete_f5, R.drawable.anim_complete_f6
        )
    )

    // -----------------------------------------------------------------------
    // Request codes
    // -----------------------------------------------------------------------

    /**
     * PendingIntent request codes must be unique per (widget instance, target).
     * appWidgetId is unique across every widget on the device, so shifting it left
     * by four bits leaves room for the six targets below without the collisions the
     * old `100 + appWidgetId` / `200 + appWidgetId` scheme could produce (id 137 in
     * the step widget and id 37 in the distance widget both hashed to 237).
     */
    private const val RC_CARD = 0
    private const val RC_EMPTY = 1
    private const val RC_BUTTON_BASE = 2 // 2, 3, 4

    private fun requestCode(appWidgetId: Int, target: Int) = (appWidgetId shl 4) or target

    // -----------------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------------

    @JvmStatic
    fun render(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        spec: SlotSpec
    ) {
        val views = RemoteViews(context.packageName, R.layout.widget_habit_sensor)
        views.setImageViewResource(R.id.app_logo, spec.icon)
        views.setImageViewResource(R.id.habit_empty_icon, spec.icon)

        try {
            // The same habit-day a control tap would be filed under, so a runtime
            // overlay left behind by a service that died before midnight is
            // recognised as yesterday's and ignored rather than shown as today's.
            val slot = WidgetContract.readSlot(context, spec.slot, habitDate(context, spec.slot))
            val loggedIn = WidgetContract.isLoggedIn(context)
            val exists = loggedIn && slot != null && slot.optBoolean(WidgetContract.F_EXISTS, false)

            if (exists) {
                renderActive(context, views, appWidgetId, spec, slot!!)
            } else {
                renderEmpty(context, views, appWidgetId, spec, loggedIn)
            }
        } catch (e: Exception) {
            // A broken payload must still leave a usable widget rather than the
            // blank grey box the host draws for a provider that threw.
            Log.e(TAG, "Render failed for slot ${spec.slot}", e)
            renderEmpty(context, views, appWidgetId, spec, true)
        }

        appWidgetManager.updateAppWidget(appWidgetId, views)
    }

    private fun renderActive(
        context: Context,
        views: RemoteViews,
        appWidgetId: Int,
        spec: SlotSpec,
        slot: JSONObject
    ) {
        views.setViewVisibility(R.id.habit_content, View.VISIBLE)
        views.setViewVisibility(R.id.habit_empty_container, View.GONE)

        val habitId = slot.optString(WidgetContract.F_ID, "")
        val title = slot.optString(WidgetContract.F_TITLE, "").ifEmpty { spec.placeholderTitle }
        val progress = slot.optDouble(WidgetContract.F_PROGRESS, 0.0)
        val goal = slot.optDouble(WidgetContract.F_GOAL, 0.0)
        val step = slot.optDouble(WidgetContract.F_STEP, 1.0)
        val displayMode = slot.optString(WidgetContract.F_DISPLAY_MODE, WidgetContract.DISPLAY_INT)
        val direction = slot.optString(WidgetContract.F_GOAL_DIRECTION, WidgetContract.DIR_AT_LEAST)
        val completed = slot.optBoolean(WidgetContract.F_IS_COMPLETED, false)
        val live = slot.optBoolean(WidgetContract.F_LIVE, false)
        // Read pause state from the tracking prefs, not from the payload: the user may
        // have paused this sensor from a widget or the notification since JS last
        // wrote, and native is the side that knows.
        val tracking = WidgetContract.isSlotTracking(context, spec.slot)

        views.setTextViewText(R.id.habit_title, title.uppercase())
        views.setTextViewText(R.id.sensor_value, WidgetContract.formatValue(progress, displayMode))
        views.setTextViewText(
            R.id.sensor_unit,
            WidgetContract.formatUnit(progress, displayMode, slot.optString(WidgetContract.F_UNIT, ""))
        )
        views.setTextViewText(R.id.habit_goal_text, WidgetContract.formatGoal(goal, displayMode, direction))

        // Fixed 0..100 scale so the bar means the same thing in every widget,
        // including inverse goals where "full" is bad news.
        views.setProgressBar(
            R.id.habit_progress, 100,
            WidgetContract.progressPercent(progress, goal, direction), false
        )

        val badge = WidgetContract.statusBadge(slot)
        views.setTextViewText(R.id.habit_status_badge, badge)
        views.setTextColor(R.id.habit_status_badge, badgeColor(badge))
        views.setTextColor(R.id.sensor_value, if (completed) COLOR_DONE else COLOR_TEXT)

        // Secondary line. The live marker is the only visible proof that the
        // foreground service is feeding this widget, which is what makes the
        // home screen match the in-app habit page instead of lagging behind it.
        // A paused sensor says so instead: the number below it is frozen, not wrong,
        // and without this line a stalled count looks like a bug.
        val note = slot.optString(WidgetContract.F_NOTE, "")
        val noteText = when {
            !tracking -> "◌ SENSOR OFF · TAP TO RESUME"
            live && note.isNotEmpty() -> "● $note"
            live -> "● LIVE"
            else -> note
        }
        if (noteText.isEmpty()) {
            views.setViewVisibility(R.id.habit_note, View.GONE)
        } else {
            views.setViewVisibility(R.id.habit_note, View.VISIBLE)
            views.setTextViewText(R.id.habit_note, noteText)
            views.setTextColor(R.id.habit_note, if (live && tracking) COLOR_ACCENT else COLOR_MUTED)
        }

        applySequence(views, if (completed) "complete" else spec.idleSequence)

        // Card body -> habit detail. Set on the content block and the title, which
        // between them cover every part of the face a control does not occupy.
        val detailPi = activityPendingIntent(
            context,
            WidgetContract.deepLinkHabitDetail(habitId),
            requestCode(appWidgetId, RC_CARD)
        )
        views.setOnClickPendingIntent(R.id.habit_content, detailPi)
        views.setOnClickPendingIntent(R.id.habit_title, detailPi)

        renderControls(
            context, views, appWidgetId, spec, slot, step, displayMode, completed, habitId, tracking
        )
    }

    /**
     * Draws the same control set the in-app habit page offers for this habit type:
     * minus/plus for numeric habits, a timer bump plus a done toggle for timed
     * ones, held/slipped for a habit whose goal is a limit, a sensor on/off switch
     * for the habits that are measured rather than entered, and a refresh on any
     * habit with room for it so a sensor reading can be pulled on demand.
     */
    private fun renderControls(
        context: Context,
        views: RemoteViews,
        appWidgetId: Int,
        spec: SlotSpec,
        slot: JSONObject,
        step: Double,
        displayMode: String,
        completed: Boolean,
        habitId: String,
        tracking: Boolean
    ) {
        val controls = WidgetContract.controlsOf(slot).toMutableList()
        if (controls.isEmpty()) controls.add(WidgetContract.CTRL_CHECK)
        // Refresh only fills a leftover slot; it never displaces a real control.
        if (controls.size < BUTTON_VIEWS.size) controls.add(WidgetContract.CTRL_REFRESH)

        BUTTON_VIEWS.forEachIndexed { index, viewId ->
            val control = controls.getOrNull(index)
            if (control == null) {
                views.setViewVisibility(viewId, View.GONE)
                return@forEachIndexed
            }

            views.setViewVisibility(viewId, View.VISIBLE)
            views.setTextViewText(viewId, labelFor(control, step, displayMode, completed, tracking))
            views.setTextColor(viewId, controlColor(control, completed, tracking))

            val op = WidgetContract.opForControl(control)
            val isTrack = control == WidgetContract.CTRL_TRACK
            val intent = Intent(context, spec.provider).apply {
                // The track button is not a habit mutation, so it travels under its
                // own action and is handled without touching progress or the op queue.
                action =
                    if (isTrack) WidgetContract.ACTION_SET_TRACKING
                    else WidgetContract.ACTION_WIDGET_CONTROL
                // Distinguishes this PendingIntent from its siblings; extras alone
                // do not, because filterEquals ignores them. The target state is part
                // of the track button's Uri so the intent stays idempotent: a stale
                // RemoteViews can only re-assert a state, never flip the current one.
                data = Uri.parse(
                    if (isTrack) "rise://widget/$appWidgetId/${spec.slot}/track/${if (tracking) 0 else 1}"
                    else "rise://widget/$appWidgetId/${spec.slot}/$control"
                )
                putExtra(WidgetContract.EXTRA_SLOT, spec.slot)
                putExtra(WidgetContract.EXTRA_HABIT_ID, habitId)
                putExtra(WidgetContract.EXTRA_AMOUNT, amountFor(control, step))
                if (isTrack) putExtra(WidgetContract.EXTRA_ENABLED, !tracking)
                if (op != null) putExtra(WidgetContract.EXTRA_OP, op)
                // Marks the broadcast as ours; see WidgetContract.EXTRA_TOKEN for
                // why an unexported-looking action is not protection on its own.
                putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
            }
            views.setOnClickPendingIntent(
                viewId,
                PendingIntent.getBroadcast(
                    context,
                    requestCode(appWidgetId, RC_BUTTON_BASE + index),
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
        }
    }

    private fun renderEmpty(
        context: Context,
        views: RemoteViews,
        appWidgetId: Int,
        spec: SlotSpec,
        loggedIn: Boolean
    ) {
        views.setViewVisibility(R.id.habit_content, View.GONE)
        views.setViewVisibility(R.id.habit_empty_container, View.VISIBLE)
        views.setTextViewText(R.id.habit_title, spec.placeholderTitle)

        if (loggedIn) {
            views.setTextViewText(R.id.habit_empty_btn, spec.emptyButtonLabel)
            views.setTextViewText(R.id.habit_empty_hint, "NO HABIT IN THIS SLOT")
            val pi = activityPendingIntent(
                context,
                WidgetContract.deepLinkAddSensorHabit(spec.templateId),
                requestCode(appWidgetId, RC_EMPTY)
            )
            views.setOnClickPendingIntent(R.id.habit_empty_container, pi)
            views.setOnClickPendingIntent(R.id.habit_empty_btn, pi)
        } else {
            views.setTextViewText(R.id.habit_empty_btn, "SIGN IN")
            views.setTextViewText(R.id.habit_empty_hint, "SIGN IN TO TRACK")
            val pi = activityPendingIntent(context, "rise://", requestCode(appWidgetId, RC_EMPTY))
            views.setOnClickPendingIntent(R.id.habit_empty_container, pi)
            views.setOnClickPendingIntent(R.id.habit_empty_btn, pi)
        }
    }

    private fun applySequence(views: RemoteViews, sequence: String) {
        val frames = SEQUENCES[sequence] ?: SEQUENCES["step"]!!
        // Modulo rather than a bare index: every sequence currently has exactly six
        // frames, but a shorter one added later should loop rather than throw, since
        // an exception here would drop the whole widget to its empty state.
        FRAME_VIEWS.forEachIndexed { i, viewId ->
            views.setImageViewResource(viewId, frames[i % frames.size])
        }
    }

    // -----------------------------------------------------------------------
    // Control handling
    // -----------------------------------------------------------------------

    /**
     * Apply a control tap. Called from the provider's onReceive, so it runs whether
     * or not the React Native side is alive -- which is the whole point of moving
     * the controls off activity launches.
     */
    @JvmStatic
    fun handleControl(context: Context, intent: Intent) {
        val slotName = intent.getStringExtra(WidgetContract.EXTRA_SLOT) ?: return
        val habitId = intent.getStringExtra(WidgetContract.EXTRA_HABIT_ID) ?: ""
        val amount = intent.getDoubleExtra(WidgetContract.EXTRA_AMOUNT, 0.0)
        val op = intent.getStringExtra(WidgetContract.EXTRA_OP)

        if (op == null) {
            // Refresh: ask the service for a fresh reading. It broadcasts an update
            // when it publishes, so there is nothing to redraw here.
            requestServiceRefresh(context)
            return
        }
        if (habitId.isEmpty()) return

        val date = habitDate(context, slotName)
        WidgetContract.enqueueOp(context, op, habitId, slotName, amount, date)
        applyOptimistic(context, slotName, habitId, op, amount)
    }

    /**
     * Which habit-day a tap belongs to. For every slot but Digital Sunset that is
     * simply today; the sunset window runs past midnight, so a tap at 00:30 belongs
     * to the night that began the previous evening and must not open a new day.
     */
    private fun habitDate(context: Context, slotName: String): String {
        if (slotName != WidgetContract.SLOT_SCREEN) return WidgetContract.localDate()
        return try {
            val cfg = JSONObject(
                WidgetContract.prefs(context).getString(WidgetContract.KEY_SENSOR_CONFIG, "{}") ?: "{}"
            ).optJSONObject(WidgetContract.SLOT_SCREEN)
            val cutoff = WidgetContract.parseClock(
                cfg?.optString("cutoffTime") ?: WidgetContract.SUNSET_CUTOFF_DEFAULT
            ) ?: return WidgetContract.localDate()
            val end = WidgetContract.parseClock(
                cfg?.optString("windowEndTime") ?: WidgetContract.SUNSET_WINDOW_END_DEFAULT
            ) ?: return WidgetContract.localDate()

            val cal = java.util.Calendar.getInstance()
            val nowMinutes = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 +
                cal.get(java.util.Calendar.MINUTE)
            val crossesMidnight = end <= cutoff
            if (crossesMidnight && nowMinutes < end) {
                // Still inside last night's window: bank against yesterday.
                WidgetContract.localDate(System.currentTimeMillis() - 24L * 60 * 60 * 1000)
            } else {
                WidgetContract.localDate()
            }
        } catch (e: Exception) {
            WidgetContract.localDate()
        }
    }

    /**
     * Move the number on the widget now, before JS has seen the op.
     *
     * Safe because JS owns KEY_SENSOR_DATA and rewrites the slot wholesale on its
     * next sync, having applied the very same queued op -- so this can be optimistic
     * without ever double-counting.
     */
    private fun applyOptimistic(
        context: Context,
        slotName: String,
        habitId: String,
        op: String,
        amount: Double
    ) {
        try {
            val prefs = WidgetContract.prefs(context)
            val base = JSONObject(prefs.getString(WidgetContract.KEY_SENSOR_DATA, "{}") ?: "{}")
            val slot = base.optJSONObject(slotName) ?: return
            if (slot.optString(WidgetContract.F_ID) != habitId) return

            val goal = slot.optDouble(WidgetContract.F_GOAL, 0.0)
            val direction = slot.optString(WidgetContract.F_GOAL_DIRECTION, WidgetContract.DIR_AT_LEAST)

            when (op) {
                WidgetContract.OP_INC, WidgetContract.OP_TIMER_ADD -> {
                    val next = (slot.optDouble(WidgetContract.F_PROGRESS, 0.0) + amount)
                        .coerceAtLeast(0.0)
                    slot.put(WidgetContract.F_PROGRESS, next)
                    // Crossing an "at least" goal completes the habit, so the
                    // celebration frames start flipping on the tap that earned them.
                    if (direction == WidgetContract.DIR_AT_LEAST && goal > 0.0) {
                        slot.put(WidgetContract.F_IS_COMPLETED, next >= goal)
                    }
                }
                WidgetContract.OP_TOGGLE -> {
                    slot.put(
                        WidgetContract.F_IS_COMPLETED,
                        !slot.optBoolean(WidgetContract.F_IS_COMPLETED, false)
                    )
                }
                WidgetContract.OP_SUNSET_CONFIRM -> slot.put(WidgetContract.F_IS_COMPLETED, true)
                WidgetContract.OP_SUNSET_SLIPPED -> slot.put(WidgetContract.F_IS_COMPLETED, false)
                else -> return
            }

            base.put(slotName, slot)
            prefs.edit().putString(WidgetContract.KEY_SENSOR_DATA, base.toString()).apply()
        } catch (e: Exception) {
            // Losing the optimistic update is cosmetic; the queued op still lands.
            Log.w(TAG, "Optimistic update failed for $slotName", e)
        }
    }

    /**
     * Switch this slot's sensor on or off from a widget tap.
     *
     * The intent carries the *target* state rather than "toggle", so two taps that
     * race, or a stale RemoteViews the host held onto, can only ever re-assert what
     * the user asked for.
     */
    @JvmStatic
    fun handleSetTracking(context: Context, intent: Intent, spec: SlotSpec) {
        val slotName = intent.getStringExtra(WidgetContract.EXTRA_SLOT) ?: spec.slot
        val enabled = intent.getBooleanExtra(WidgetContract.EXTRA_ENABLED, true)
        WidgetContract.setSlotTracking(context, slotName, enabled)

        // The flag alone changes nothing: the service is what holds the sensor open,
        // so it has to re-read the state and unregister (or re-register) its
        // listeners. Without this a "pause" would only hide the number.
        try {
            val serviceIntent = Intent(context, SensorForegroundService::class.java)
                .setAction(
                    if (enabled) WidgetContract.SERVICE_ACTION_START
                    else WidgetContract.SERVICE_ACTION_REFRESH
                )
            if (enabled) {
                // Acting on a widget is an explicit user action, which is one of the
                // exemptions that still permits a foreground-service start from the
                // background -- so switching a sensor back on can start the service.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            } else if (SensorForegroundService.isRunning(context)) {
                // Only poke a service that exists. Starting one just to tell it to
                // stop collecting would put up a notification for a sensor the user
                // has just switched off.
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            // Nothing to recover here: the flag is saved either way, and the service
            // re-reads it the next time it starts.
            Log.w(TAG, "Could not hand tracking change to the service", e)
        }
    }

    private fun requestServiceRefresh(context: Context) {
        try {
            context.startService(
                Intent(context, SensorForegroundService::class.java)
                    .setAction(WidgetContract.SERVICE_ACTION_REFRESH)
            )
        } catch (e: Exception) {
            // Background start restrictions can refuse this. Redraw from prefs so
            // the tap is not silently ignored.
            Log.w(TAG, "Could not ask the service to refresh", e)
            WidgetContract.broadcastUpdate(context)
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Redraw every instance of one provider. Used after a control tap. */
    @JvmStatic
    fun refreshProvider(context: Context, spec: SlotSpec) {
        val mgr = AppWidgetManager.getInstance(context)
        for (id in mgr.getAppWidgetIds(ComponentName(context, spec.provider))) {
            render(context, mgr, id, spec)
        }
    }

    private fun activityPendingIntent(context: Context, uri: String, code: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse(uri)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context, code, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun labelFor(
        control: String,
        step: Double,
        displayMode: String,
        completed: Boolean,
        tracking: Boolean
    ): String = when {
        // The shared label helper cannot know the habit is already done, and a
        // button reading "✓ DONE" on a finished habit gives no hint that it undoes.
        control == WidgetContract.CTRL_CHECK && completed -> "✕ UNDO"
        control == WidgetContract.CTRL_TRACK -> WidgetContract.trackLabel(tracking)
        else -> WidgetContract.controlLabel(control, step, displayMode)
    }

    private fun controlColor(control: String, completed: Boolean, tracking: Boolean): Int = when {
        control == WidgetContract.CTRL_CONFIRM -> COLOR_DONE
        control == WidgetContract.CTRL_SLIPPED -> COLOR_ACCENT
        control == WidgetContract.CTRL_CHECK && completed -> COLOR_MUTED
        control == WidgetContract.CTRL_REFRESH -> COLOR_MUTED
        // Green while collecting, red once off: the button is a status light as much
        // as a switch, and this is the one control whose state is not visible from
        // the number above it.
        control == WidgetContract.CTRL_TRACK -> if (tracking) COLOR_DONE else COLOR_ACCENT
        else -> COLOR_TEXT
    }

    private fun amountFor(control: String, step: Double): Double = when (control) {
        WidgetContract.CTRL_DEC -> -step
        WidgetContract.CTRL_INC, WidgetContract.CTRL_TIMER -> step
        else -> 0.0
    }

    private fun badgeColor(badge: String): Int = when (badge) {
        "COMPLETE" -> COLOR_DONE
        "BROKEN" -> COLOR_ACCENT
        "HOLDING" -> COLOR_DONE
        "NOT STARTED" -> COLOR_MUTED
        else -> COLOR_ACCENT
    }
}
