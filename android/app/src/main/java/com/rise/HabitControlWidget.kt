package com.rise

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

/**
 * Rise: Habit Matrix.
 *
 * Every habit by day, one row each, seven columns wide. It used to render a single
 * pinned habit's 35-day heatmap — which is one habit by days, not a matrix — and its
 * one button opened the app to register a tap. Now the whole list is here, the pinned
 * habit is simply first, and today's cell toggles in place: the tap is queued as a
 * PendingOp and drawn immediately, so it works with React Native not running.
 */
class HabitControlWidget : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)

        when (intent.action) {
            WidgetContract.ACTION_WIDGET_UPDATE -> refreshAll(context)

            WidgetContract.ACTION_WIDGET_CONTROL -> {
                // This receiver has to stay exported for APPWIDGET_UPDATE, and an
                // exported receiver can be targeted by an explicit intent carrying any
                // action at all. Without the token another app could forge taps and
                // wreck a streak; see WidgetContract.EXTRA_TOKEN.
                if (!WidgetContract.isTrustedControl(context, intent)) return
                // The only control this widget has. Checked rather than assumed so a
                // later op added to the template cannot arrive here as a silent toggle.
                val op = intent.getStringExtra(WidgetContract.EXTRA_OP)
                if (op != null && op != WidgetContract.OP_TOGGLE) return
                val habitId = intent.getStringExtra(WidgetContract.EXTRA_HABIT_ID) ?: return
                if (habitId.isEmpty()) return
                toggleToday(context, habitId)
                refreshAll(context)
            }
            // A "com.rise.TOGGLE_HABIT_WIDGET" branch used to live here. Nothing ever
            // built that intent and nothing consumed its action, so it was reachable
            // only from another app and its one effect was to pop Rise open.
        }
    }

    companion object {

        private const val TAG = "HabitControlWidget"

        /** Distinguishes this widget's PendingIntents from each other. */
        private const val RC_OPEN = 0
        private const val RC_TEMPLATE = 1

        // appWidgetIds are unique across every provider, so shifting the id and or-ing
        // the target keeps request codes unique app-wide without a shared registry.
        private fun requestCode(appWidgetId: Int, target: Int) = (appWidgetId shl 4) or target

        fun updateWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int
        ) {
            val views = RemoteViews(context.packageName, R.layout.habit_control_widget)

            try {
                val rows = HabitMatrix.load(context)

                // Header opens the app. It is the only navigation here on purpose: a
                // collection has a single PendingIntent template, so a row cannot mix
                // "toggle by broadcast" with "open by activity", and rows are where
                // toggling belongs.
                val open = activityPendingIntent(
                    context, "rise://", requestCode(appWidgetId, RC_OPEN)
                )
                views.setTextViewText(R.id.matrix_title, "HABIT MATRIX")
                views.setOnClickPendingIntent(R.id.matrix_title, open)
                views.setOnClickPendingIntent(R.id.app_logo, open)

                if (rows.isEmpty()) {
                    views.setTextViewText(R.id.matrix_subtitle, "NOTHING TO TRACK YET")
                    views.setViewVisibility(R.id.matrix_list, View.GONE)
                    views.setViewVisibility(R.id.matrix_empty, View.VISIBLE)
                    views.setOnClickPendingIntent(R.id.matrix_empty, open)
                } else {
                    views.setTextViewText(
                        R.id.matrix_subtitle,
                        "${HabitMatrix.doneToday(rows)}/${rows.size} DONE TODAY · ${HabitMatrix.COLUMNS} DAYS"
                    )
                    views.setViewVisibility(R.id.matrix_empty, View.GONE)
                    views.setViewVisibility(R.id.matrix_list, View.VISIBLE)

                    // Deliberately stable per widget instance, unlike the old adapter
                    // intent that embedded the habit id: a changing Uri makes the host
                    // build a new factory, which is not how row data should refresh.
                    // notifyAppWidgetViewDataChanged in refreshAll does that job.
                    val adapter = Intent(context, HabitGridService::class.java).apply {
                        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                        data = Uri.parse("rise://habit-matrix/$appWidgetId")
                    }
                    views.setRemoteAdapter(R.id.matrix_list, adapter)

                    /*
                     * The template every row's today-cell fills in. Mutable because
                     * filling in is the whole mechanism — the host writes the row's
                     * habit id and Uri into it. The action and the trust token are set
                     * here, where a fill-in cannot override them: Intent.fillIn only
                     * supplies fields the template left empty, and existing extras win.
                     */
                    val template = Intent(context, HabitControlWidget::class.java).apply {
                        action = WidgetContract.ACTION_WIDGET_CONTROL
                        putExtra(WidgetContract.EXTRA_OP, WidgetContract.OP_TOGGLE)
                        putExtra(WidgetContract.EXTRA_TOKEN, WidgetContract.controlToken(context))
                    }
                    views.setPendingIntentTemplate(
                        R.id.matrix_list,
                        PendingIntent.getBroadcast(
                            context,
                            requestCode(appWidgetId, RC_TEMPLATE),
                            template,
                            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                        )
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error updating widget", e)
                views.setTextViewText(R.id.matrix_title, "HABIT MATRIX")
                views.setTextViewText(R.id.matrix_subtitle, "COULD NOT READ HABITS")
            }

            appWidgetManager.updateAppWidget(appWidgetId, views)
        }

        /**
         * Redraw every instance, frame and rows.
         *
         * Both halves are needed: updateAppWidget refreshes the header, but the host
         * caches the rows it has already inflated, so the factory has to be told to
         * re-read prefs or a toggled dot would not change until the next hourly draw.
         */
        @JvmStatic
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, HabitControlWidget::class.java)
            )
            if (ids.isEmpty()) return
            for (id in ids) updateWidget(context, manager, id)
            manager.notifyAppWidgetViewDataChanged(ids, R.id.matrix_list)
        }

        /**
         * Toggle a habit for today from the matrix.
         *
         * Two steps, in this order: queue the op that JS will apply to the real store,
         * then flip the widget's own copy so the dot changes under the finger. The
         * optimistic write cannot double-count, because JS owns `habitHistoryData` and
         * rewrites the whole blob on its next sync — having applied this same op.
         */
        private fun toggleToday(context: Context, habitId: String) {
            val date = WidgetContract.localDate()
            WidgetContract.enqueueOp(context, WidgetContract.OP_TOGGLE, habitId, "", 0.0, date)

            try {
                val prefs = WidgetContract.prefs(context)
                val all = JSONObject(
                    prefs.getString(WidgetContract.KEY_HABIT_HISTORY, "{}") ?: "{}"
                )
                val habit = all.optJSONObject(habitId) ?: return
                val history = habit.optJSONArray("history") ?: JSONArray()
                val last = history.length() - 1

                if (last >= 0 && history.optJSONObject(last)?.optString("date") == date) {
                    // Mutating the object in place: JSONArray holds the reference.
                    val day = history.getJSONObject(last)
                    day.put("completed", !day.optBoolean("completed", false))
                } else {
                    // History stops short of today — the app has not run since
                    // midnight — so today's entry is the one being created.
                    history.put(JSONObject().apply {
                        put("date", date)
                        put("completed", true)
                    })
                }

                habit.put("history", history)
                all.put(habitId, habit)
                prefs.edit().putString(WidgetContract.KEY_HABIT_HISTORY, all.toString()).apply()
                // The streak is deliberately left alone: computing it correctly needs
                // the whole history, and JS overwrites it within a second of the app
                // coming forward. A wrong number would be worse than a stale one.
            } catch (e: Exception) {
                // Losing the optimistic redraw is cosmetic; the queued op still lands.
                Log.w(TAG, "Optimistic matrix update failed for $habitId", e)
            }
        }

        private fun activityPendingIntent(
            context: Context,
            uri: String,
            code: Int
        ): PendingIntent {
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
    }
}
