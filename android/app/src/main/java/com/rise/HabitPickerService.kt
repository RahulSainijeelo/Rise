package com.rise

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import org.json.JSONObject

/**
 * Rows for [HabitLinkWidget]'s in-widget habit picker.
 *
 * The list is only ever visible while the picker is open, so every row means the same
 * thing — "bind this widget to this habit" — and the single PendingIntent template a
 * collection is allowed can carry the action outright. Rows supply nothing but the
 * habit id.
 *
 * Reuses R.layout.widget_item so a picker row looks like every other list row Rise
 * draws on the home screen.
 */
class HabitPickerService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
        val appWidgetId = intent.getIntExtra(
            android.appwidget.AppWidgetManager.EXTRA_APPWIDGET_ID,
            android.appwidget.AppWidgetManager.INVALID_APPWIDGET_ID
        )
        return HabitPickerFactory(applicationContext, appWidgetId)
    }
}

class HabitPickerFactory(
    private val context: Context,
    private val appWidgetId: Int
) : RemoteViewsService.RemoteViewsFactory {

    private data class Row(
        val id: String,
        val title: String,
        val subtitle: String,
        val bound: Boolean
    )

    private val rows = ArrayList<Row>()

    override fun onCreate() {}

    /**
     * Called by the host on every notifyAppWidgetViewDataChanged, which is the only
     * way row content is meant to refresh — hence the deliberately stable adapter Uri
     * on the provider side.
     */
    override fun onDataSetChanged() {
        rows.clear()
        try {
            val boundId = WidgetContract.prefs(context)
                .getString(WidgetContract.habitLinkKey(appWidgetId), "") ?: ""
            val arr = HabitLinkWidget.habits(context)
            for (i in 0 until arr.length()) {
                val habit = arr.optJSONObject(i) ?: continue
                val id = habit.optString(WidgetContract.F_ID)
                if (id.isEmpty()) continue
                rows.add(
                    Row(
                        id = id,
                        title = habit.optString(WidgetContract.F_TITLE).ifEmpty { "Untitled" },
                        subtitle = subtitle(habit),
                        bound = id == boundId
                    )
                )
            }
        } catch (e: Exception) {
            // An unreadable blob shows an empty list, which the provider's empty face
            // already explains. Throwing here would leave the host with no adapter.
            rows.clear()
        }
    }

    /**
     * What this habit will look like once bound: the goal type decides the face, so
     * saying it here is the difference between picking blind and picking on purpose.
     */
    private fun subtitle(habit: JSONObject): String {
        val goal = habit.optDouble(WidgetContract.F_GOAL, 0.0)
        val mode = habit.optString(WidgetContract.F_DISPLAY_MODE, WidgetContract.DISPLAY_INT)

        return when (habit.optString(WidgetContract.F_HABIT_TYPE, "check")) {
            "timer" -> {
                if (goal > 0.0) "TIMER · ${(goal / 60).toInt()} MIN" else "TIMER"
            }
            "numeric" -> {
                if (goal <= 0.0) {
                    "COUNT"
                } else {
                    val value = WidgetContract.formatValue(goal, mode)
                    val unit = WidgetContract.formatUnit(
                        goal, mode, habit.optString(WidgetContract.F_UNIT)
                    )
                    "COUNT · $value $unit".trim()
                }
            }
            else -> "GOAL"
        }
    }

    override fun onDestroy() = rows.clear()

    override fun getCount(): Int = rows.size

    override fun getViewAt(position: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_item)
        if (position >= rows.size) return views
        val row = rows[position]

        val density = context.resources.displayMetrics.density
        val padding = (10 * density).toInt()
        views.setInt(R.id.widget_item_container, "setBackgroundResource", R.drawable.widget_item_bg)
        views.setViewPadding(R.id.widget_item_container, padding, padding, padding, padding)

        // Exactly one habit can be bound at a time, so a filled checkbox reads as the
        // radio dot it effectively is — the same convention as the label picker.
        views.setViewVisibility(R.id.widget_item_checkbox, View.VISIBLE)
        views.setImageViewResource(
            R.id.widget_item_checkbox,
            if (row.bound) R.drawable.widget_checkbox_filled else R.drawable.widget_checkbox
        )

        views.setTextViewText(R.id.widget_item_title, row.title)
        views.setFloat(R.id.widget_item_title, "setTextSize", 13f)
        views.setTextColor(
            R.id.widget_item_title,
            if (row.bound) 0xFFD71921.toInt() else Color.WHITE
        )

        views.setTextViewText(R.id.widget_item_datetime, row.subtitle)
        views.setViewVisibility(
            R.id.widget_item_datetime,
            if (row.subtitle.isEmpty()) View.GONE else View.VISIBLE
        )
        views.setViewVisibility(R.id.widget_item_type, View.GONE)
        views.setViewVisibility(R.id.widget_item_priority, View.GONE)

        // Only the habit id travels. The template already carries the action, the
        // widget id and the trust token, and fillIn cannot overwrite what it set.
        views.setOnClickFillInIntent(
            R.id.widget_item_container,
            Intent().putExtra(WidgetContract.EXTRA_HABIT_ID, row.id)
        )
        return views
    }

    override fun getLoadingView(): RemoteViews? = null

    override fun getViewTypeCount(): Int = 1

    override fun getItemId(position: Int): Long = position.toLong()

    override fun hasStableIds(): Boolean = true
}
