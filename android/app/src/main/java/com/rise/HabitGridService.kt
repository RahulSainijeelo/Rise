package com.rise

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.util.Log
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Habit Matrix's row adapter.
 *
 * Still named HabitGridService because the manifest, and every PendingIntent the
 * widget host is already holding, name this class; what it serves changed from "one
 * habit's 35 days, one dot per item" to "one habit per item, its last seven days".
 */
class HabitGridService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        HabitMatrixFactory(this.applicationContext)
}

/**
 * Shared reading of `habitHistoryData`, used by both the factory (to draw rows) and
 * the provider (to count today in the header) so the two can never disagree about
 * what "done today" means.
 *
 * JS already writes every habit into this blob — 35 days each — so the matrix needed
 * no new bridge call, only a reader that stops treating the map as a one-habit lookup.
 */
object HabitMatrix {

    private const val TAG = "HabitMatrix"

    /** Columns per row: six days of history plus today. Fixed by the row layout. */
    const val COLUMNS = 7

    /** A day that was completed, at any point in the week. */
    val COLOR_DONE = 0xFFFFFFFF.toInt()

    /** A day that passed without the habit being done. Present, but barely. */
    val COLOR_MISSED = 0xFF2E2E2E.toInt()

    /** Today, still open. Accent, because this is the one cell that is tappable. */
    val COLOR_TODAY_OPEN = 0xFFD71921.toInt()

    /** Today, done. The same green the app uses, so the two agree at a glance. */
    val COLOR_TODAY_DONE = 0xFF4ADE80.toInt()

    /** Name colour for a habit already done today. */
    val COLOR_NAME_DONE = 0xFFFFFFFF.toInt()

    /** Name colour for a habit still outstanding. */
    val COLOR_NAME_OPEN = 0xFFBBBBBB.toInt()

    /** The streak column. */
    val COLOR_STREAK = 0xFF888888.toInt()

    data class Day(val date: String, val completed: Boolean)

    data class Row(
        val id: String,
        val title: String,
        val streak: Int,
        /** The sensor slot this habit is bound to, or null if it is hand-logged. */
        val slot: String?,
        /**
         * True when this habit has no manual completion at all — its value is counted
         * by a sensor. Steps, distance and movement are the cases: ticking one by hand
         * would invent a number, so today's cell is shown but not tappable, exactly as
         * the app screen and the sensor widgets now behave.
         */
        val locked: Boolean,
        /** False when this habit's sensor is currently paused. */
        val tracking: Boolean,
        /** Exactly COLUMNS entries, oldest first, the last one always today. */
        val days: List<Day>
    )

    /**
     * Every habit, ordered with the pinned one first.
     *
     * Pinning used to decide which single habit the widget showed. Now that it shows
     * all of them the pin still means something useful — it floats that habit to the
     * top row — so the existing `pinHabit` bridge call keeps working rather than
     * becoming a button that does nothing.
     */
    @JvmStatic
    fun load(context: Context): List<Row> {
        val out = ArrayList<Row>()
        try {
            val prefs = WidgetContract.prefs(context)
            val all = JSONObject(
                prefs.getString(WidgetContract.KEY_HABIT_HISTORY, "{}") ?: "{}"
            )
            val today = WidgetContract.localDate()
            val bound = boundSlots(prefs)

            val ids = ArrayList<String>()
            val keys = all.keys()
            while (keys.hasNext()) ids.add(keys.next())

            val pinned = prefs.getString(WidgetContract.KEY_PINNED_HABIT_ID, null)
            if (!pinned.isNullOrEmpty() && ids.remove(pinned)) ids.add(0, pinned)

            for (id in ids) {
                val habit = all.optJSONObject(id) ?: continue
                val binding = bound[id]
                out.add(
                    Row(
                        id = id,
                        title = habit.optString("title", "HABIT").uppercase(),
                        streak = habit.optInt("streak", 0),
                        slot = binding?.slot,
                        locked = binding?.locked == true,
                        tracking = binding?.slot?.let {
                            WidgetContract.isSlotTracking(context, it)
                        } ?: true,
                        days = lastDays(habit.optJSONArray("history"), today)
                    )
                )
            }
        } catch (e: Exception) {
            // An unreadable blob draws an empty matrix rather than crashing the host.
            Log.w(TAG, "Could not read the habit matrix", e)
        }
        return out
    }

    /** How many of these habits are already done today. */
    @JvmStatic
    fun doneToday(rows: List<Row>): Int = rows.count { it.days.lastOrNull()?.completed == true }

    private data class Binding(val slot: String, val locked: Boolean)

    /**
     * Which habits are bound to a sensor slot, and which of those may still be
     * completed by hand.
     *
     * The slot's own `controls` list is the authority — the same list JS derives from
     * habitControls() and the sensor widgets render — so the matrix cannot drift from
     * the rest of the app. A slot offering only "track" has no manual completion:
     * steps, distance and movement are counted, not claimed. Deep Silence keeps its
     * check and Digital Sunset its held/slipped, so both stay tappable here.
     *
     * An empty controls list means JS has not said, and the sensor widgets fall back
     * to a check in that case, so this defaults to tappable for the same reason.
     */
    private fun boundSlots(prefs: SharedPreferences): Map<String, Binding> {
        val out = HashMap<String, Binding>()
        try {
            val data = JSONObject(prefs.getString(WidgetContract.KEY_SENSOR_DATA, "{}") ?: "{}")
            val keys = data.keys()
            while (keys.hasNext()) {
                val name = keys.next()
                val slot = data.optJSONObject(name) ?: continue
                val id = slot.optString(WidgetContract.F_ID)
                if (id.isEmpty()) continue
                val controls = WidgetContract.controlsOf(slot)
                val byHand = controls.isEmpty() || controls.any {
                    it == WidgetContract.CTRL_CHECK ||
                        it == WidgetContract.CTRL_CONFIRM ||
                        it == WidgetContract.CTRL_SLIPPED
                }
                out[id] = Binding(slot = name, locked = !byHand)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read sensor bindings", e)
        }
        return out
    }

    /**
     * The tail of a habit's history, normalised to exactly COLUMNS days ending today.
     *
     * The "ending today" part matters: the blob is only rewritten when JS runs, so a
     * widget drawn at 00:05 — or after a day with the app never opened — has a history
     * that stops short. Appending today keeps the last column meaning today, which is
     * what the tap target claims to be.
     */
    private fun lastDays(history: JSONArray?, today: String): List<Day> {
        val days = ArrayList<Day>()
        if (history != null) {
            val from = (history.length() - COLUMNS).coerceAtLeast(0)
            for (i in from until history.length()) {
                val day = history.optJSONObject(i) ?: continue
                days.add(Day(day.optString("date", ""), day.optBoolean("completed", false)))
            }
        }
        if (days.lastOrNull()?.date != today) days.add(Day(today, false))
        while (days.size > COLUMNS) days.removeAt(0)
        while (days.size < COLUMNS) days.add(0, Day("", false))
        return days
    }
}

class HabitMatrixFactory(private val context: Context) : RemoteViewsService.RemoteViewsFactory {

    private var rows: List<HabitMatrix.Row> = emptyList()

    override fun onCreate() {
        rows = HabitMatrix.load(context)
    }

    override fun onDataSetChanged() {
        rows = HabitMatrix.load(context)
    }

    override fun onDestroy() {}

    override fun getCount(): Int = rows.size

    override fun getViewAt(position: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.habit_matrix_row)
        val row = rows.getOrNull(position) ?: return views

        try {
            val days = row.days
            val today = days.lastOrNull()
            val doneToday = today?.completed == true
            // A sensor-measured habit is shown, not offered: ticking one by hand would
            // invent steps nobody walked.
            val tappable = !row.locked

            views.setTextViewText(R.id.matrix_name, row.title)
            views.setTextColor(
                R.id.matrix_name,
                if (doneToday) HabitMatrix.COLOR_NAME_DONE else HabitMatrix.COLOR_NAME_OPEN
            )

            /*
             * The streak column doubles as an alarm. A paused sensor is the one thing
             * that can make a row lie — the habit is not being measured at all — so it
             * takes precedence over the number. Otherwise a dot rather than a zero: an
             * empty streak should read as absence, not as a score being graded.
             */
            val dark = row.locked && !row.tracking
            views.setTextViewText(
                R.id.matrix_streak,
                when {
                    dark -> "◌"
                    row.streak > 0 -> "${row.streak}"
                    else -> "·"
                }
            )
            views.setTextColor(
                R.id.matrix_streak,
                if (dark) HabitMatrix.COLOR_TODAY_OPEN else HabitMatrix.COLOR_STREAK
            )

            HISTORY_DOTS.forEachIndexed { index, viewId ->
                val completed = days.getOrNull(index)?.completed == true
                views.setInt(
                    viewId,
                    "setBackgroundColor",
                    if (completed) HabitMatrix.COLOR_DONE else HabitMatrix.COLOR_MISSED
                )
            }
            // Accent is reserved for the cell a tap would actually change, so a
            // sensor-measured today reads as history until the sensor completes it.
            views.setInt(
                R.id.matrix_today,
                "setBackgroundColor",
                when {
                    doneToday -> HabitMatrix.COLOR_TODAY_DONE
                    tappable -> HabitMatrix.COLOR_TODAY_OPEN
                    else -> HabitMatrix.COLOR_MISSED
                }
            )

            /*
             * Per-item click. A collection child cannot carry its own PendingIntent,
             * so it fills in the provider's broadcast template instead: the habit id
             * comes from here, the action and the trust token from the template, which
             * is where a fill-in cannot overwrite them.
             *
             * The Uri is only there to keep one row's filled-in intent distinguishable
             * from another's; nothing reads it. The habit-day is decided when the
             * broadcast is handled, not here, so a tap the host replays after midnight
             * still lands on the day it is applied.
             *
             * Locked rows get an intent carrying no habit id, which the provider drops,
             * rather than no intent at all: the host recycles row views, and an unset
             * click action can leave the previous row's behind.
             */
            views.setOnClickFillInIntent(
                R.id.matrix_today_cell,
                Intent().apply {
                    data = Uri.parse(
                        if (tappable) "rise://habit-matrix/toggle/${row.id}"
                        else "rise://habit-matrix/sensor/${row.id}"
                    )
                    if (tappable) putExtra(WidgetContract.EXTRA_HABIT_ID, row.id)
                }
            )
        } catch (e: Exception) {
            Log.e(TAG, "Could not draw matrix row $position", e)
        }

        return views
    }

    override fun getLoadingView(): RemoteViews? = null
    override fun getViewTypeCount(): Int = 1

    /*
     * Position-keyed, unstable ids, exactly like RiseWidgetService — the one collection
     * widget in this app with a long history of working. Hashing the habit id and
     * claiming stable ids reads better but hands RemoteViewsAdapter a cache key it did
     * not have before, and the rows here are cheap enough that there is nothing to win.
     */
    override fun getItemId(position: Int): Long = position.toLong()

    override fun hasStableIds(): Boolean = false

    private companion object {
        const val TAG = "HabitMatrixFactory"

        val HISTORY_DOTS = intArrayOf(
            R.id.matrix_d0,
            R.id.matrix_d1,
            R.id.matrix_d2,
            R.id.matrix_d3,
            R.id.matrix_d4,
            R.id.matrix_d5
        )
    }
}
