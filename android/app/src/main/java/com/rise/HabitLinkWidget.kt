package com.rise

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

/**
 * Rise: Habit — the wrapper widget.
 *
 * The five sensor widgets are each welded to one template (Step Legend, City Glider,
 * Deep Silence, Immediate Rise, Digital Sunset), so a habit somebody invented in the
 * app had no home-screen presence at all. This binds by habit id instead: one instance
 * shows one habit of the user's choosing, and draws whichever of three faces its goal
 * type calls for.
 *
 *   check    DONE / NOT DONE and the streak
 *   numeric  a value against a goal, with −step / +step
 *   timer    a self-ticking countdown driven by [HabitTimer]
 *
 * Binding happens inside the widget. Unbound, it is a "+ LINK HABIT" button; tapped, the
 * same widget fills with the habit list and a row press commits the binding. No
 * transparent activity, so linking a habit never cold-launches Rise — the same
 * reasoning as the task widget's label picker, and the same per-widget-id flag shape.
 *
 * Nothing here mutates the store directly, because React Native is usually not running
 * when a widget is tapped. Every habit change is queued as a PendingOp for JS to drain,
 * and the widget's own copy of the number is moved optimistically so the face responds
 * under the finger. That cannot double-count: JS owns KEY_HABITS_DATA and rewrites it
 * wholesale on its next sync, having applied the very same op.
 */
class HabitLinkWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    /**
     * Drop the per-instance binding when the widget is removed.
     *
     * appWidgetIds are recycled by the host, so leaving these behind would hand a
     * brand-new widget the habit its predecessor was showing.
     */
    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        val edit = WidgetContract.prefs(context).edit()
        for (id in appWidgetIds) {
            edit.remove(WidgetContract.habitLinkKey(id))
            edit.remove(WidgetContract.habitPickerKey(id))
        }
        edit.apply()
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)

        when (intent.action) {
            WidgetContract.ACTION_WIDGET_UPDATE -> refreshAll(context)

            // This receiver has to stay exported so the host can deliver
            // APPWIDGET_UPDATE, and an exported receiver can be targeted by an explicit
            // intent carrying any action at all. Every branch below therefore checks the
            // token first: a forged toggle would wreck a streak, and a forged RESET
            // would throw away a session. See WidgetContract.EXTRA_TOKEN.
            WidgetContract.ACTION_WIDGET_CONTROL -> {
                if (!WidgetContract.isTrustedControl(context, intent)) return
                handleControl(context, intent)
            }

            WidgetContract.ACTION_HABIT_TIMER -> {
                if (!WidgetContract.isTrustedControl(context, intent)) return
                val habitId = intent.getStringExtra(WidgetContract.EXTRA_HABIT_ID) ?: return
                val op = intent.getStringExtra(WidgetContract.EXTRA_OP) ?: return
                if (habitId.isEmpty()) return
                // handle() owns the state, the alarm, the credit and the redraw.
                HabitTimer.handle(context, habitId, op, goalMs(context, habitId))
            }

            WidgetContract.ACTION_PICK_HABIT -> {
                if (!WidgetContract.isTrustedControl(context, intent)) return
                setPickerOpen(context, widgetId(intent) ?: return, true)
            }

            WidgetContract.ACTION_LINK_HABIT -> {
                if (!WidgetContract.isTrustedControl(context, intent)) return
                val appWidgetId = widgetId(intent) ?: return
                val habitId = intent.getStringExtra(WidgetContract.EXTRA_HABIT_ID) ?: return
                WidgetContract.prefs(context).edit()
                    .putString(WidgetContract.habitLinkKey(appWidgetId), habitId)
                    .apply()
                setPickerOpen(context, appWidgetId, false)
            }
        }
    }

    private fun widgetId(intent: Intent): Int? {
        val id = intent.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID
        )
        return if (id == AppWidgetManager.INVALID_APPWIDGET_ID) null else id
    }

    /** Flip one instance between its bound face and the habit list, then redraw it. */
    private fun setPickerOpen(context: Context, appWidgetId: Int, open: Boolean) {
        WidgetContract.prefs(context).edit()
            .putBoolean(WidgetContract.habitPickerKey(appWidgetId), open)
            .apply()
        val manager = AppWidgetManager.getInstance(context)
        updateWidget(context, manager, appWidgetId)
        // The host caches rows it has already inflated, so opening the picker without
        // this shows whatever the factory happened to load last.
        manager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.link_picker_list)
    }

    /** dec / inc / check. The run buttons go through ACTION_HABIT_TIMER instead. */
    private fun handleControl(context: Context, intent: Intent) {
        val habitId = intent.getStringExtra(WidgetContract.EXTRA_HABIT_ID) ?: return
        val control = intent.getStringExtra(WidgetContract.EXTRA_OP) ?: return
        if (habitId.isEmpty()) return

        val op = WidgetContract.opForControl(control) ?: return
        val amount = intent.getDoubleExtra(WidgetContract.EXTRA_AMOUNT, 0.0)
        val date = WidgetContract.localDate()

        WidgetContract.enqueueOp(context, op, habitId, "", amount, date)
        applyOptimistic(context, habitId, op, amount)
        refreshAll(context)
    }

    companion object {

        private const val TAG = "HabitLinkWidget"

        private const val COLOR_TEXT = 0xFFFFFFFF.toInt()
        private const val COLOR_MUTED = 0xFF8A8A8A.toInt()
        private const val COLOR_ACCENT = 0xFFD71921.toInt()
        private const val COLOR_DONE = 0xFF4ADE80.toInt()

        // Request-code targets. appWidgetIds are unique across every provider, so
        // shifting the id and or-ing the target keeps codes unique app-wide without a
        // shared registry. Sixteen slots; nine used.
        private const val RC_OPEN = 0
        private const val RC_RELINK = 1
        private const val RC_TEMPLATE = 2
        private const val RC_PICK = 3
        private const val RC_DEC = 4
        private const val RC_INC = 5
        private const val RC_CHECK = 6
        private const val RC_RUN = 7
        private const val RC_RESET = 8

        private fun requestCode(appWidgetId: Int, target: Int) = (appWidgetId shl 4) or target

        // -------------------------------------------------------------------
        // Reading the published habits
        // -------------------------------------------------------------------

        /**
         * Every habit without a dedicated widget, as JS last published it.
         *
         * Written by WidgetService.updateWidget through WidgetBridge.setHabitsData, and
         * deliberately excludes the five sensor-bound habits: they already have widgets
         * of their own, and two widgets writing one habit's progress from two different
         * models is how double-counting starts.
         */
        @JvmStatic
        fun habits(context: Context): JSONArray {
            // Login gate: without it a signed-out device keeps the previous user's
            // habits on the home screen, because JS clearWidgetData does not empty
            // KEY_HABITS_DATA. The sensor renders and the task widget already gate on
            // WidgetContract.isLoggedIn; mirror that here. Returning nothing makes
            // habitById() miss, so updateWidget falls through to its empty face.
            if (!WidgetContract.isLoggedIn(context)) return JSONArray()
            return try {
                JSONArray(
                    WidgetContract.prefs(context).getString(WidgetContract.KEY_HABITS_DATA, "[]")
                        ?: "[]"
                )
            } catch (e: Exception) {
                Log.w(TAG, "Unreadable habits blob", e)
                JSONArray()
            }
        }

        /** The published habit with this id, or null if it has been deleted since. */
        @JvmStatic
        fun habitById(context: Context, habitId: String): JSONObject? {
            if (habitId.isEmpty()) return null
            val arr = habits(context)
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                if (o.optString(WidgetContract.F_ID) == habitId) return o
            }
            return null
        }

        /** A TIMER habit's daily goal in millis, for HabitTimer to adopt. */
        private fun goalMs(context: Context, habitId: String): Long {
            val goalSeconds = habitById(context, habitId)
                ?.optDouble(WidgetContract.F_GOAL, 0.0) ?: 0.0
            return (goalSeconds * 1000.0).toLong().coerceAtLeast(0L)
        }

        private fun boundHabitId(context: Context, appWidgetId: Int): String =
            WidgetContract.prefs(context)
                .getString(WidgetContract.habitLinkKey(appWidgetId), "") ?: ""

        private fun isPickerOpen(context: Context, appWidgetId: Int): Boolean =
            WidgetContract.prefs(context)
                .getBoolean(WidgetContract.habitPickerKey(appWidgetId), false)

        // -------------------------------------------------------------------
        // Drawing
        // -------------------------------------------------------------------

        @JvmStatic
        fun updateWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int
        ) {
            val views = RemoteViews(context.packageName, R.layout.widget_habit_link)

            try {
                if (isPickerOpen(context, appWidgetId)) {
                    renderPicker(context, views, appWidgetId)
                } else {
                    val habitId = boundHabitId(context, appWidgetId)
                    // A habit can be deleted in the app while a widget still points at
                    // it, so a missing entry falls back to the empty state rather than
                    // drawing a face full of zeroes for something that no longer exists.
                    val habit = habitById(context, habitId)
                    if (habit == null) {
                        renderEmpty(context, views, appWidgetId)
                    } else {
                        renderBound(context, views, appWidgetId, habitId, habit)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error updating widget $appWidgetId", e)
                showOnly(views, R.id.habit_face_empty)
                views.setTextViewText(R.id.link_title, "HABIT")
                views.setTextViewText(R.id.empty_btn, "+ LINK HABIT")
                views.setTextViewText(R.id.empty_hint, "COULD NOT READ HABITS")
            }

            appWidgetManager.updateAppWidget(appWidgetId, views)
        }

        /**
         * Exactly one of the four faces, plus the picker list.
         *
         * Every branch sets every visibility rather than only the one it wants, because
         * the host reuses the RemoteViews it already has: leaving a face alone means
         * leaving it in whatever state the previous draw put it in.
         */
        private fun showOnly(views: RemoteViews, faceId: Int) {
            val faces = intArrayOf(
                R.id.habit_face_check,
                R.id.habit_face_numeric,
                R.id.habit_face_timer,
                R.id.habit_face_empty,
                R.id.link_picker_list
            )
            for (id in faces) {
                views.setViewVisibility(id, if (id == faceId) View.VISIBLE else View.GONE)
            }
        }

        private fun renderEmpty(context: Context, views: RemoteViews, appWidgetId: Int) {
            showOnly(views, R.id.habit_face_empty)
            views.setTextViewText(R.id.link_title, "HABIT")
            views.setTextViewText(R.id.empty_btn, "+ LINK HABIT")

            val count = habits(context).length()
            views.setTextViewText(
                R.id.empty_hint,
                if (count == 0) "NO HABITS YET · OPEN RISE" else "$count TO CHOOSE FROM"
            )

            val pick = pickIntent(context, appWidgetId)
            views.setOnClickPendingIntent(R.id.empty_btn, pick)
            views.setOnClickPendingIntent(R.id.link_title, pick)
            // Nothing is bound, so there is nothing to open: the logo picks too.
            views.setOnClickPendingIntent(R.id.link_logo, pick)
        }

        private fun renderPicker(context: Context, views: RemoteViews, appWidgetId: Int) {
            showOnly(views, R.id.link_picker_list)
            views.setTextViewText(R.id.link_title, "CHOOSE A HABIT")

            // Stable per widget instance on purpose: a changing Uri makes the host build
            // a whole new factory, which is not how row data should refresh.
            // notifyAppWidgetViewDataChanged does that job.
            val adapter = Intent(context, HabitPickerService::class.java).apply {
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                data = Uri.parse("rise://habit-link/$appWidgetId")
            }
            views.setRemoteAdapter(R.id.link_picker_list, adapter)

            /*
             * The template every row fills in. Mutable because filling in is the whole
             * mechanism — the host writes the row's habit id into it. The action, the
             * widget id and the trust token are set here, where a fill-in cannot
             * override them: Intent.fillIn only supplies fields the template left empty.
             */
            val template = Intent(context, HabitLinkWidget::class.java).apply {
                action = WidgetContract.ACTION_LINK_HABIT
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
                data = Uri.parse("rise://habit-link/$appWidgetId/pick")
            }
            views.setPendingIntentTemplate(
                R.id.link_picker_list,
                PendingIntent.getBroadcast(
                    context,
                    requestCode(appWidgetId, RC_TEMPLATE),
                    template,
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
            )
            // Backing out of the picker without choosing. Both header targets get a
            // listener because the host reapplies RemoteViews onto the view it already
            // has: a listener this draw does not set is left as the last draw set it,
            // so link_title would still be opening the habit it used to show.
            val close = closePickerIntent(context, appWidgetId)
            views.setOnClickPendingIntent(R.id.link_title, close)
            views.setOnClickPendingIntent(R.id.link_logo, close)
        }

        private fun renderBound(
            context: Context,
            views: RemoteViews,
            appWidgetId: Int,
            habitId: String,
            habit: JSONObject
        ) {
            val title = habit.optString(WidgetContract.F_TITLE).ifEmpty { "HABIT" }
            views.setTextViewText(R.id.link_title, title.uppercase())

            // Title opens the habit; the logo re-opens the picker. RemoteViews has no
            // long-press, so re-linking needs a target of its own, and the logo is the
            // one piece of chrome that is not already carrying meaning.
            views.setOnClickPendingIntent(
                R.id.link_title,
                activityIntent(
                    context,
                    WidgetContract.deepLinkHabitDetail(habitId),
                    requestCode(appWidgetId, RC_OPEN)
                )
            )
            views.setOnClickPendingIntent(
                R.id.link_logo, pickIntent(context, appWidgetId, RC_RELINK)
            )

            when (habit.optString(WidgetContract.F_HABIT_TYPE, "check")) {
                "timer" -> renderTimerFace(context, views, appWidgetId, habitId, habit)
                "numeric" -> renderNumericFace(context, views, appWidgetId, habitId, habit)
                else -> renderCheckFace(context, views, appWidgetId, habitId, habit)
            }
        }

        private fun renderCheckFace(
            context: Context,
            views: RemoteViews,
            appWidgetId: Int,
            habitId: String,
            habit: JSONObject
        ) {
            showOnly(views, R.id.habit_face_check)

            val done = habit.optBoolean(WidgetContract.F_IS_COMPLETED, false)
            views.setTextViewText(R.id.check_state, if (done) "DONE" else "NOT DONE")
            views.setTextColor(R.id.check_state, if (done) COLOR_DONE else COLOR_TEXT)

            val streak = habit.optInt(WidgetContract.F_STREAK, 0)
            val note = habit.optString(WidgetContract.F_NOTE)
            views.setTextViewText(
                R.id.check_streak,
                when {
                    note.isNotEmpty() -> note.uppercase()
                    streak > 0 -> "$streak DAY STREAK"
                    else -> "NO STREAK YET"
                }
            )

            // The button reads out what tapping it does, which for a toggle means the
            // opposite of the state shown above it.
            views.setTextViewText(R.id.check_btn, if (done) "✕ UNDO" else "✓ DONE")
            views.setOnClickPendingIntent(
                R.id.check_btn,
                controlIntent(
                    context, appWidgetId, habitId,
                    WidgetContract.CTRL_CHECK, 0.0, RC_CHECK
                )
            )
        }

        private fun renderNumericFace(
            context: Context,
            views: RemoteViews,
            appWidgetId: Int,
            habitId: String,
            habit: JSONObject
        ) {
            showOnly(views, R.id.habit_face_numeric)

            val progress = habit.optDouble(WidgetContract.F_PROGRESS, 0.0)
            val goal = habit.optDouble(WidgetContract.F_GOAL, 0.0)
            val direction = habit.optString(
                WidgetContract.F_GOAL_DIRECTION, WidgetContract.DIR_AT_LEAST
            )
            val mode = habit.optString(WidgetContract.F_DISPLAY_MODE, WidgetContract.DISPLAY_INT)
            val step = habit.optDouble(WidgetContract.F_STEP, 1.0)

            views.setTextViewText(R.id.numeric_value, WidgetContract.formatValue(progress, mode))
            views.setTextColor(
                R.id.numeric_value,
                if (habit.optBoolean(WidgetContract.F_IS_COMPLETED, false)) COLOR_DONE
                else COLOR_TEXT
            )
            views.setTextViewText(
                R.id.numeric_unit,
                WidgetContract.formatUnit(progress, mode, habit.optString(WidgetContract.F_UNIT))
            )
            views.setTextViewText(
                R.id.numeric_goal, WidgetContract.formatGoal(goal, mode, direction)
            )
            views.setProgressBar(
                R.id.numeric_progress, 100,
                WidgetContract.progressPercent(progress, goal, direction), false
            )

            // Which buttons to draw is JS's call, not this widget's: habitControls in
            // HabitMetrics.ts decides, so the widget and the detail screen cannot drift
            // into offering different controls for the same habit.
            val controls = WidgetContract.controlsOf(habit)
            wireControl(
                context, views, appWidgetId, habitId, R.id.numeric_dec,
                WidgetContract.CTRL_DEC, controls, -step, step, mode, RC_DEC
            )
            wireControl(
                context, views, appWidgetId, habitId, R.id.numeric_inc,
                WidgetContract.CTRL_INC, controls, step, step, mode, RC_INC
            )
            wireControl(
                context, views, appWidgetId, habitId, R.id.numeric_check,
                WidgetContract.CTRL_CHECK, controls, 0.0, step, mode, RC_CHECK
            )
        }

        private fun renderTimerFace(
            context: Context,
            views: RemoteViews,
            appWidgetId: Int,
            habitId: String,
            habit: JSONObject
        ) {
            showOnly(views, R.id.habit_face_timer)

            val goalSeconds = habit.optDouble(WidgetContract.F_GOAL, 0.0)
            val state = HabitTimer.read(context, habitId, (goalSeconds * 1000.0).toLong())
            val now = System.currentTimeMillis()

            /*
             * setBase computes the text immediately, so this is right in all three
             * modes: running it ticks itself down from the deadline, paused and idle it
             * renders base-minus-now once and stays there — which is the remaining time
             * and the full duration respectively. Letting the system tick is the point:
             * a per-second RemoteViews push would be throttled by the host and would
             * cost a wakeup a second for a widget nobody may be looking at.
             */
            val remaining = HabitTimer.remaining(state, now)
            views.setChronometer(
                R.id.timer_chrono,
                SystemClock.elapsedRealtime() + remaining,
                null,
                state.running
            )
            views.setChronometerCountDown(R.id.timer_chrono, true)
            views.setTextColor(
                R.id.timer_chrono, if (state.running) COLOR_ACCENT else COLOR_TEXT
            )

            views.setTextViewText(
                R.id.timer_state,
                when {
                    state.running -> "RUNNING"
                    state.paused -> "PAUSED"
                    else -> "READY"
                }
            )
            views.setTextColor(R.id.timer_state, if (state.paused) COLOR_ACCENT else COLOR_MUTED)

            // The bar tracks the *day*, not the run: what makes a timer habit done is
            // the minutes banked today, and a run is only one contribution to that.
            val progress = habit.optDouble(WidgetContract.F_PROGRESS, 0.0)
            views.setProgressBar(
                R.id.timer_progress, 100,
                WidgetContract.progressPercent(progress, goalSeconds, WidgetContract.DIR_AT_LEAST),
                false
            )
            views.setTextViewText(
                R.id.timer_today,
                if (goalSeconds > 0.0)
                    "${(progress / 60).toInt()} / ${(goalSeconds / 60).toInt()} MIN TODAY"
                else "${(progress / 60).toInt()} MIN TODAY"
            )

            views.setTextViewText(R.id.timer_run, WidgetContract.runLabel(state.mode))
            views.setOnClickPendingIntent(
                R.id.timer_run,
                timerIntent(context, appWidgetId, habitId, WidgetContract.HT_OP_TOGGLE, RC_RUN)
            )
            views.setTextViewText(R.id.timer_reset, "↺")
            views.setOnClickPendingIntent(
                R.id.timer_reset,
                timerIntent(context, appWidgetId, habitId, WidgetContract.HT_OP_RESET, RC_RESET)
            )
        }

        /** Draw and wire one control button, or hide it if this habit does not offer it. */
        private fun wireControl(
            context: Context,
            views: RemoteViews,
            appWidgetId: Int,
            habitId: String,
            viewId: Int,
            control: String,
            controls: List<String>,
            amount: Double,
            step: Double,
            displayMode: String,
            target: Int
        ) {
            if (!controls.contains(control)) {
                views.setViewVisibility(viewId, View.GONE)
                return
            }
            views.setViewVisibility(viewId, View.VISIBLE)
            views.setTextViewText(viewId, WidgetContract.controlLabel(control, step, displayMode))
            views.setOnClickPendingIntent(
                viewId,
                controlIntent(context, appWidgetId, habitId, control, amount, target)
            )
        }

        // -------------------------------------------------------------------
        // PendingIntents
        // -------------------------------------------------------------------
        //
        // Every one of these carries a distinct data Uri as well as a distinct request
        // code. PendingIntent identity ignores extras, so two buttons differing only in
        // their extras are the *same* PendingIntent and FLAG_UPDATE_CURRENT quietly
        // rewrites the first one to do what the second does.

        private fun controlIntent(
            context: Context,
            appWidgetId: Int,
            habitId: String,
            control: String,
            amount: Double,
            target: Int
        ): PendingIntent {
            val intent = Intent(context, HabitLinkWidget::class.java).apply {
                action = WidgetContract.ACTION_WIDGET_CONTROL
                putExtra(WidgetContract.EXTRA_HABIT_ID, habitId)
                putExtra(WidgetContract.EXTRA_OP, control)
                putExtra(WidgetContract.EXTRA_AMOUNT, amount)
                putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
                data = Uri.parse("rise://habit-link/$appWidgetId/$control")
            }
            return PendingIntent.getBroadcast(
                context, requestCode(appWidgetId, target), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun timerIntent(
            context: Context,
            appWidgetId: Int,
            habitId: String,
            op: String,
            target: Int
        ): PendingIntent = PendingIntent.getBroadcast(
            context,
            requestCode(appWidgetId, target),
            // Built by HabitTimer so the widget, the app screen and the expiry alarm all
            // speak one vocabulary of ops.
            HabitTimer.controlIntent(context, habitId, op),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        private fun pickIntent(
            context: Context,
            appWidgetId: Int,
            target: Int = RC_PICK
        ): PendingIntent {
            val intent = Intent(context, HabitLinkWidget::class.java).apply {
                action = WidgetContract.ACTION_PICK_HABIT
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
                data = Uri.parse("rise://habit-link/$appWidgetId/pick/$target")
            }
            return PendingIntent.getBroadcast(
                context, requestCode(appWidgetId, target), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        /**
         * Close the picker without choosing.
         *
         * ACTION_LINK_HABIT carrying whatever is already bound, so backing out is the
         * same code path a real pick takes rather than a fourth action that would have
         * to be kept in step with it. An unbound widget re-binds to the empty string
         * and falls back to its empty face.
         */
        private fun closePickerIntent(context: Context, appWidgetId: Int): PendingIntent {
            val intent = Intent(context, HabitLinkWidget::class.java).apply {
                action = WidgetContract.ACTION_LINK_HABIT
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                putExtra(
                    WidgetContract.EXTRA_HABIT_ID,
                    // Keep whatever was bound; an unbound widget stays unbound.
                    boundHabitId(context, appWidgetId)
                )
                putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
                data = Uri.parse("rise://habit-link/$appWidgetId/close")
            }
            return PendingIntent.getBroadcast(
                context, requestCode(appWidgetId, RC_RELINK), intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun activityIntent(context: Context, uri: String, code: Int): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                data = Uri.parse(uri)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            return PendingIntent.getActivity(
                context, code, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        // -------------------------------------------------------------------
        // Refresh and optimistic writes
        // -------------------------------------------------------------------

        /**
         * Redraw every instance, faces and rows.
         *
         * Both halves are needed: updateAppWidget refreshes the faces, but the host
         * caches rows it has already inflated, so a habit added in the app would not
         * appear in an open picker until the next daily draw.
         */
        @JvmStatic
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, HabitLinkWidget::class.java)
            )
            if (ids.isEmpty()) return
            for (id in ids) updateWidget(context, manager, id)
            manager.notifyAppWidgetViewDataChanged(ids, R.id.link_picker_list)
        }

        /**
         * Move the number on the widget now, before JS has seen the op.
         *
         * Safe because JS owns KEY_HABITS_DATA and rewrites it wholesale on its next
         * sync, having applied the very same queued op — so this can be optimistic
         * without ever double-counting. Losing it is cosmetic; the op still lands.
         */
        private fun applyOptimistic(
            context: Context,
            habitId: String,
            op: String,
            amount: Double
        ) {
            try {
                val prefs = WidgetContract.prefs(context)
                val arr = habits(context)
                for (i in 0 until arr.length()) {
                    val habit = arr.optJSONObject(i) ?: continue
                    if (habit.optString(WidgetContract.F_ID) != habitId) continue

                    when (op) {
                        WidgetContract.OP_INC, WidgetContract.OP_TIMER_ADD -> {
                            val next = (habit.optDouble(WidgetContract.F_PROGRESS, 0.0) + amount)
                                .coerceAtLeast(0.0)
                            habit.put(WidgetContract.F_PROGRESS, next)
                            val goal = habit.optDouble(WidgetContract.F_GOAL, 0.0)
                            // Crossing the goal completes the habit, so the face turns
                            // green on the tap that earned it rather than a sync later.
                            if (goal > 0.0 &&
                                habit.optString(
                                    WidgetContract.F_GOAL_DIRECTION, WidgetContract.DIR_AT_LEAST
                                ) == WidgetContract.DIR_AT_LEAST
                            ) {
                                habit.put(WidgetContract.F_IS_COMPLETED, next >= goal)
                            }
                        }
                        WidgetContract.OP_TOGGLE -> habit.put(
                            WidgetContract.F_IS_COMPLETED,
                            !habit.optBoolean(WidgetContract.F_IS_COMPLETED, false)
                        )
                        else -> return
                    }

                    arr.put(i, habit)
                    prefs.edit()
                        .putString(WidgetContract.KEY_HABITS_DATA, arr.toString())
                        .apply()
                    return
                }
            } catch (e: Exception) {
                Log.w(TAG, "Optimistic update failed for $habitId", e)
            }
        }
    }
}
