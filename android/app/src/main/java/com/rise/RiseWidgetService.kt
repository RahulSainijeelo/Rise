package com.rise

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import org.json.JSONArray
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Locale

class RiseWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
        // The widget id decides whether this instance is showing tasks or its
        // label picker, so the factory has to know which widget it belongs to.
        val appWidgetId = intent.getIntExtra(
            android.appwidget.AppWidgetManager.EXTRA_APPWIDGET_ID,
            android.appwidget.AppWidgetManager.INVALID_APPWIDGET_ID
        )
        return RiseWidgetFactory(applicationContext, appWidgetId)
    }
}

class RiseWidgetFactory(
    private val context: Context,
    private val appWidgetId: Int
) : RemoteViewsService.RemoteViewsFactory {

    private var items: MutableList<WidgetItem> = mutableListOf()

    data class WidgetItem(
        val id: String,
        val title: String,
        val status: String,
        val type: String,
        val category: String,
        val dueDate: String,
        val dueTime: String?,
        val priority: Int,
        val habitType: String? = null,
        val isDateHeader: Boolean = false,
        /** A row in the in-widget label picker rather than a task. */
        val isLabelRow: Boolean = false,
        /** Only meaningful for label rows: this label is the active filter. */
        val isSelectedLabel: Boolean = false
    )

    override fun onCreate() {
        Log.d("RiseWidget", "Factory onCreate")
    }

    override fun onDataSetChanged() {
        Log.d("RiseWidget", "Factory onDataSetChanged")
        items.clear()

        val sharedPref = context.getSharedPreferences(WidgetContract.PREFS_NAME, Context.MODE_PRIVATE)
        val selectedLabel = sharedPref.getString(WidgetContract.KEY_SELECTED_LABEL, WidgetContract.LABEL_ALL)
            ?: WidgetContract.LABEL_ALL

        if (appWidgetId != android.appwidget.AppWidgetManager.INVALID_APPWIDGET_ID &&
            sharedPref.getBoolean(WidgetContract.labelPickerKey(appWidgetId), false)
        ) {
            loadLabels(sharedPref, selectedLabel)
            return
        }

        loadTasks(sharedPref, selectedLabel)
    }

    /**
     * The picker's rows. "All" is synthesised rather than stored, because it is
     * the absence of a filter and no label with that name has to exist.
     */
    private fun loadLabels(
        sharedPref: android.content.SharedPreferences,
        selectedLabel: String
    ) {
        val names = mutableListOf(WidgetContract.LABEL_ALL)
        try {
            val raw = sharedPref.getString(WidgetContract.KEY_WIDGET_LABELS, "[]") ?: "[]"
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val name = arr.optJSONObject(i)?.optString("name").orEmpty()
                if (name.isNotEmpty() && !names.contains(name)) names.add(name)
            }
        } catch (e: Exception) {
            Log.e("RiseWidget", "Error loading labels", e)
        }

        for (name in names) {
            items.add(
                WidgetItem(
                    id = "label_$name",
                    title = name,
                    status = "",
                    type = "label",
                    category = name,
                    dueDate = "",
                    dueTime = null,
                    priority = 0,
                    isLabelRow = true,
                    isSelectedLabel = name == selectedLabel
                )
            )
        }
        Log.d("RiseWidget", "Picker rows: ${items.size}")
    }

    private fun loadTasks(
        sharedPref: android.content.SharedPreferences,
        selectedLabel: String
    ) {
        try {
            val dataString = sharedPref.getString(WidgetContract.KEY_WIDGET_DATA, "[]") ?: "[]"

            Log.d("RiseWidget", "Selected label: $selectedLabel")

            val jsonArray = JSONArray(dataString)
            val tempItems = mutableListOf<WidgetItem>()
            val inputFormat = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
            val todayStr = inputFormat.format(java.util.Date())
            
            for (i in 0 until jsonArray.length()) {
                val obj = jsonArray.getJSONObject(i)
                val id = obj.optString("id", "")
                
                if (id == "__not_logged_in__") continue
                
                val dueDate = obj.optString("dueDate", "")
                
                // Hide past dates
                if (dueDate.isNotEmpty() && dueDate < todayStr) {
                    continue
                }
                
                val category = obj.optString("category", "Inbox")
                val type = obj.optString("type", "task")
                
                if (selectedLabel != WidgetContract.LABEL_ALL && type == "task" && category != selectedLabel) {
                    continue
                }
                
                val dueTime = if (obj.has("dueTime") && !obj.isNull("dueTime")) {
                    val time = obj.optString("dueTime", "")
                    if (time.isNotEmpty()) time else null
                } else null
                
                tempItems.add(WidgetItem(
                    id = id,
                    title = obj.optString("title", "Task"),
                    status = obj.optString("status", "pending"),
                    type = type,
                    category = category,
                    dueDate = obj.optString("dueDate", ""),
                    dueTime = dueTime,
                    priority = obj.optInt("priority", 4),
                    habitType = if (obj.has("habitType") && !obj.isNull("habitType")) obj.optString("habitType") else null
                ))
            }
            
            tempItems.sortBy { it.dueDate }
            
            // Group by date with headers
            var lastDate = ""
            for (item in tempItems) {
                if (item.dueDate.isNotEmpty() && item.dueDate != lastDate) {
                    items.add(WidgetItem(
                        id = "header_${item.dueDate}",
                        title = formatDateHeader(item.dueDate),
                        status = "",
                        type = "header",
                        category = "",
                        dueDate = item.dueDate,
                        dueTime = null,
                        priority = 0,
                        isDateHeader = true
                    ))
                    lastDate = item.dueDate
                }
                items.add(item)
            }
            
            Log.d("RiseWidget", "Total items including headers: ${items.size}")
        } catch (e: Exception) {
            Log.e("RiseWidget", "Error loading data", e)
        }
    }
    
    private fun formatDateHeader(dateStr: String): String {
        return try {
            val inputFormat = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
            val date = inputFormat.parse(dateStr)
            val today = inputFormat.format(java.util.Date())
            val tomorrow = inputFormat.format(java.util.Date(System.currentTimeMillis() + 86400000))
            
            when (dateStr) {
                today -> "Today"
                tomorrow -> "Tomorrow"
                else -> {
                    val outputFormat = SimpleDateFormat("EEE, MMM d", Locale.getDefault())
                    outputFormat.format(date!!)
                }
            }
        } catch (e: Exception) {
            dateStr
        }
    }

    override fun onDestroy() {
        items.clear()
    }

    override fun getCount(): Int = items.size

    override fun getViewAt(position: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_item)
        
        if (position < items.size) {
            val item = items[position]

            if (item.isLabelRow) {
                val density = context.resources.displayMetrics.density
                val padding = (10 * density).toInt()
                views.setInt(R.id.widget_item_container, "setBackgroundResource", R.drawable.widget_item_bg)
                views.setViewPadding(R.id.widget_item_container, padding, padding, padding, padding)

                // The filled checkbox doubles as the radio dot: exactly one label
                // is active, so a tick on the current one reads correctly.
                views.setViewVisibility(R.id.widget_item_checkbox, View.VISIBLE)
                views.setImageViewResource(
                    R.id.widget_item_checkbox,
                    if (item.isSelectedLabel) R.drawable.widget_checkbox_filled else R.drawable.widget_checkbox
                )

                views.setTextViewText(R.id.widget_item_title, item.title)
                views.setFloat(R.id.widget_item_title, "setTextSize", 13f)
                views.setTextColor(
                    R.id.widget_item_title,
                    if (item.isSelectedLabel) 0xFFD71921.toInt() else 0xFFFFFFFF.toInt()
                )

                views.setViewVisibility(R.id.widget_item_datetime, View.GONE)
                views.setViewVisibility(R.id.widget_item_type, View.GONE)
                views.setViewVisibility(R.id.widget_item_priority, View.GONE)

                // Only the label travels; the template already carries the action
                // and the widget id, and fillIn cannot overwrite what it set.
                views.setOnClickFillInIntent(
                    R.id.widget_item_container,
                    Intent().putExtra(RiseWidget.EXTRA_LABEL, item.title)
                )
            } else if (item.isDateHeader) {
                // Date header - minimal styling, no card background
                views.setTextViewText(R.id.widget_item_title, item.title)
                views.setTextColor(R.id.widget_item_title, 0xFF888888.toInt())
                views.setFloat(R.id.widget_item_title, "setTextSize", 11f)
                views.setTextViewText(R.id.widget_item_datetime, "")
                views.setViewVisibility(R.id.widget_item_datetime, View.GONE)
                views.setTextViewText(R.id.widget_item_type, "")
                views.setViewVisibility(R.id.widget_item_type, View.GONE)
                views.setViewVisibility(R.id.widget_item_priority, View.GONE)
                views.setViewVisibility(R.id.widget_item_checkbox, View.GONE)
                // Transparent background for headers
                views.setInt(R.id.widget_item_container, "setBackgroundColor", Color.TRANSPARENT)
                
                // Minimal padding for headers (4dp top, 8dp bottom as requested)
                val density = context.resources.displayMetrics.density
                val topPadding = (4 * density).toInt()
                val bottomPadding = (8 * density).toInt()
                val sidePadding = (10 * density).toInt()
                views.setViewPadding(R.id.widget_item_container, sidePadding, topPadding, sidePadding, bottomPadding)
                
                views.setOnClickFillInIntent(R.id.widget_item_container, Intent())
            } else {
                val isCompleted = item.status.equals("completed", ignoreCase = true)
                
                // Reset background and padding for task/habit items
                views.setInt(R.id.widget_item_container, "setBackgroundResource", R.drawable.widget_item_bg)
                val density = context.resources.displayMetrics.density
                val padding = (10 * density).toInt()
                views.setViewPadding(R.id.widget_item_container, padding, padding, padding, padding)
                
                // Checkbox
                views.setViewVisibility(R.id.widget_item_checkbox, View.VISIBLE)
                if (isCompleted) {
                    views.setImageViewResource(R.id.widget_item_checkbox, R.drawable.widget_checkbox_filled)
                } else {
                    views.setImageViewResource(R.id.widget_item_checkbox, R.drawable.widget_checkbox)
                }
                
                // Title
                views.setTextViewText(R.id.widget_item_title, item.title)
                views.setFloat(R.id.widget_item_title, "setTextSize", 13f)
                views.setTextColor(R.id.widget_item_title, 
                    if (isCompleted) 0xFF666666.toInt() else 0xFFFFFFFF.toInt())
                
                // Time display
                if (item.dueTime != null && item.dueTime.isNotEmpty()) {
                    views.setTextViewText(R.id.widget_item_datetime, item.dueTime)
                    views.setViewVisibility(R.id.widget_item_datetime, View.VISIBLE)
                } else {
                    views.setTextViewText(R.id.widget_item_datetime, "")
                    views.setViewVisibility(R.id.widget_item_datetime, View.GONE)
                }
                
                // Type indicator
                var typeIndicator = if (item.type == "habit") "H" else "T"
                if (item.type == "habit" && item.habitType != null) {
                    typeIndicator = when (item.habitType) {
                        "timer" -> "H(T)"
                        "numeric" -> "H(N)"
                        else -> "H"
                    }
                }
                
                views.setViewVisibility(R.id.widget_item_type, View.VISIBLE)
                views.setTextViewText(R.id.widget_item_type, typeIndicator)
                views.setTextColor(R.id.widget_item_type, 
                    if (item.type == "habit") 0xFFE91E63.toInt() else 0xFF2196F3.toInt())
                
                // Priority dot
                views.setViewVisibility(R.id.widget_item_priority, View.VISIBLE)
                val priorityColor = when (item.priority) {
                    1 -> 0xFFFF0000.toInt()
                    2 -> 0xFFFFAB00.toInt()
                    3 -> 0xFF0052CC.toInt()
                    else -> 0xFF444444.toInt()
                }
                views.setInt(R.id.widget_item_priority, "setColorFilter", priorityColor)
                
                // Fill-in intent - different action for habits vs tasks
                val fillIntent = Intent().apply {
                    putExtra("itemId", item.id)
                    putExtra("itemType", item.type)
                    putExtra("isHabit", item.type == "habit")
                }
                views.setOnClickFillInIntent(R.id.widget_item_container, fillIntent)
            }
        }
        
        return views
    }

    override fun getLoadingView(): RemoteViews? = null
    
    override fun getViewTypeCount(): Int = 1
    
    override fun getItemId(position: Int): Long = position.toLong()
    
    override fun hasStableIds(): Boolean = false
}
