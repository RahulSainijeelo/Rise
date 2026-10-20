package com.rise

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.View
import android.widget.RemoteViews
import android.util.Log
import org.json.JSONArray

class RiseWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        Log.d("RiseWidget", "onUpdate called with ${appWidgetIds.size} widgets")
        
        for (appWidgetId in appWidgetIds) {
            updateAppWidget(context, appWidgetManager, appWidgetId)
        }
    }
    
    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)

        when (intent.action) {
            "com.rise.WIDGET_UPDATE" -> {
                Log.d("RiseWidget", "Received WIDGET_UPDATE broadcast")
                val appWidgetManager = AppWidgetManager.getInstance(context)
                val componentName = ComponentName(context, RiseWidget::class.java)
                val appWidgetIds = appWidgetManager.getAppWidgetIds(componentName)

                appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.widget_list)
                onUpdate(context, appWidgetManager, appWidgetIds)
            }
            ACTION_LABEL_PICKER -> {
                // Flip this one widget between its task list and its label list.
                // Nothing is launched: the picker is the same ListView showing
                // different rows, which is the only way to filter from the home
                // screen without bringing the app to the foreground.
                val appWidgetId = intent.getIntExtra(
                    AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID
                )
                if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return

                val prefs = context.getSharedPreferences(WidgetContract.PREFS_NAME, Context.MODE_PRIVATE)
                val key = WidgetContract.labelPickerKey(appWidgetId)
                prefs.edit().putBoolean(key, !prefs.getBoolean(key, false)).apply()

                refresh(context, intArrayOf(appWidgetId))
            }
            ACTION_SELECT_LABEL -> {
                val appWidgetId = intent.getIntExtra(
                    AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID
                )
                val label = intent.getStringExtra(EXTRA_LABEL) ?: WidgetContract.LABEL_ALL

                val prefs = context.getSharedPreferences(WidgetContract.PREFS_NAME, Context.MODE_PRIVATE)
                prefs.edit()
                    .putString(WidgetContract.KEY_SELECTED_LABEL, label)
                    .apply()

                // Close the picker on the widget that was tapped...
                if (appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
                    prefs.edit().putBoolean(WidgetContract.labelPickerKey(appWidgetId), false).apply()
                }

                // ...but redraw every task widget, because the selected label is a
                // single shared pref and the others are now showing a stale filter.
                val manager = AppWidgetManager.getInstance(context)
                refresh(context, manager.getAppWidgetIds(ComponentName(context, RiseWidget::class.java)))
                Log.d("RiseWidget", "Label filter set to $label")
            }
            "com.rise.TOGGLE_TASK" -> {
                val itemId = intent.getStringExtra("itemId") ?: return
                val itemType = intent.getStringExtra("itemType") ?: "task"
                val isHabit = intent.getBooleanExtra("isHabit", false)

                Log.d("RiseWidget", "Toggle action: $itemId, type: $itemType, isHabit: $isHabit")

                if (isHabit) {
                    // Open HabitDetailScreen for habits
                    val habitIntent = Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse("rise://item/$itemId/habit")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    context.startActivity(habitIntent)
                } else {
                    // Queue the durable op JS drains into the real task store, THEN flip
                    // the widget's own copy so the row responds under the finger. Without
                    // the enqueue the prefs flip is cosmetic: nothing reads widgetData back
                    // and the next updateWidget overwrites it, so the toggle is lost. This
                    // mirrors HabitControlWidget.toggleToday (enqueue first, optimistic
                    // flip second); JS owns widgetData and rewrites it wholesale on its
                    // next sync having applied this same op, so the flip cannot double-count.
                    WidgetContract.enqueueOp(
                        context,
                        WidgetContract.OP_TASK_TOGGLE,
                        itemId,
                        "",
                        0.0,
                        WidgetContract.localDate()
                    )

                    // Toggle the task in SharedPreferences (optimistic under-finger feedback)
                    toggleItemInPrefs(context, itemId, itemType)

                    // Refresh widget
                    val appWidgetManager = AppWidgetManager.getInstance(context)
                    val componentName = ComponentName(context, RiseWidget::class.java)
                    val appWidgetIds = appWidgetManager.getAppWidgetIds(componentName)
                    appWidgetManager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.widget_list)
                }
            }
        }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        // Picker state is keyed by widget id, so a removed widget would leave a
        // stray boolean behind forever. Ids get recycled; a stale `true` would
        // make the next widget open in picker mode.
        val editor = context.getSharedPreferences(WidgetContract.PREFS_NAME, Context.MODE_PRIVATE).edit()
        for (id in appWidgetIds) editor.remove(WidgetContract.labelPickerKey(id))
        editor.apply()
    }

    private fun toggleItemInPrefs(context: Context, itemId: String, itemType: String) {
        try {
            val sharedPref = context.getSharedPreferences(WidgetContract.PREFS_NAME, Context.MODE_PRIVATE)
            val dataString = sharedPref.getString(WidgetContract.KEY_WIDGET_DATA, "[]") ?: "[]"
            val items = JSONArray(dataString)
            
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i)
                if (item.optString("id") == itemId) {
                    val currentStatus = item.optString("status", "pending")
                    val newStatus = if (currentStatus == "completed") "pending" else "completed"
                    item.put("status", newStatus)
                    break
                }
            }
            
            with(sharedPref.edit()) {
                putString(WidgetContract.KEY_WIDGET_DATA, items.toString())
                apply()
            }
            Log.d("RiseWidget", "Toggled item $itemId")
        } catch (e: Exception) {
            Log.e("RiseWidget", "Error toggling item", e)
        }
    }

    companion object {

        /** Tapping the label chip flips this widget into (or out of) picker mode. */
        const val ACTION_LABEL_PICKER = "com.rise.LABEL_PICKER"

        /** Tapping a row while in picker mode commits that label. */
        const val ACTION_SELECT_LABEL = "com.rise.SELECT_LABEL"

        const val EXTRA_LABEL = "label"

        private val COLOR_TEXT = 0xFFFFFFFF.toInt()
        private val COLOR_ACCENT = 0xFFD71921.toInt()

        // One request code per operation. PendingIntent identity ignores extras,
        // so two ops sharing a code would collapse into one and FLAG_UPDATE_CURRENT
        // would silently rewrite whichever was registered first.
        private const val RC_LOGO = 0
        private const val RC_ADD = 1
        private const val RC_TOGGLE_TEMPLATE = 2
        private const val RC_LABEL_CHIP = 3
        private const val RC_LOGIN = 5
        private const val RC_SELECT_TEMPLATE = 6

        /** Redraw rows *and* chrome. Either alone leaves half the widget stale. */
        private fun refresh(context: Context, appWidgetIds: IntArray) {
            if (appWidgetIds.isEmpty()) return
            val manager = AppWidgetManager.getInstance(context)
            // The host caches inflated rows, so changing what the factory returns
            // is invisible until it is told the data set moved.
            manager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.widget_list)
            for (id in appWidgetIds) updateAppWidget(context, manager, id)
        }

        fun updateAppWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            Log.d("RiseWidget", "updateAppWidget for $appWidgetId")

            val views = RemoteViews(context.packageName, R.layout.rise_widget)

            val sharedPref = context.getSharedPreferences(WidgetContract.PREFS_NAME, Context.MODE_PRIVATE)
            val dataString = sharedPref.getString(WidgetContract.KEY_WIDGET_DATA, "[]") ?: "[]"
            val selectedLabel = sharedPref.getString(WidgetContract.KEY_SELECTED_LABEL, WidgetContract.LABEL_ALL)
                ?: WidgetContract.LABEL_ALL
            val picking = sharedPref.getBoolean(WidgetContract.labelPickerKey(appWidgetId), false)
            val items = try { JSONArray(dataString) } catch (e: Exception) { JSONArray() }

            val itemCount = items.length()
            Log.d("RiseWidget", "Data count: $itemCount, label: $selectedLabel, picking: $picking")

            val isNotLoggedIn = itemCount == 1 &&
                items.optJSONObject(0)?.optString("id") == "__not_logged_in__"

            if (isNotLoggedIn) {
                views.setViewVisibility(R.id.widget_list, View.GONE)
                views.setViewVisibility(R.id.widget_empty, View.GONE)
                views.setViewVisibility(R.id.widget_add, View.GONE)
                views.setViewVisibility(R.id.widget_label_container, View.GONE)
                views.setViewVisibility(R.id.widget_login_btn, View.VISIBLE)
                views.setTextViewText(R.id.widget_date_label, "RISE")

                val loginIntent = Intent(context, MainActivity::class.java).apply {
                    action = Intent.ACTION_MAIN
                    addCategory(Intent.CATEGORY_LAUNCHER)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val loginPendingIntent = PendingIntent.getActivity(
                    context, RC_LOGIN, loginIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                views.setOnClickPendingIntent(R.id.widget_login_btn, loginPendingIntent)
            } else {
                views.setViewVisibility(R.id.widget_login_btn, View.GONE)
                views.setViewVisibility(R.id.widget_label_container, View.VISIBLE)
                views.setViewVisibility(R.id.widget_list, View.VISIBLE)

                // While picking, "+" would launch the app mid-decision. Hide it and
                // let the whole widget be about one question.
                views.setViewVisibility(R.id.widget_add, if (picking) View.GONE else View.VISIBLE)

                views.setTextViewText(R.id.widget_date_label, if (picking) "SELECT LABEL" else selectedLabel)
                views.setTextColor(R.id.widget_date_label, if (picking) COLOR_ACCENT else COLOR_TEXT)
                views.setTextViewText(R.id.widget_empty, if (picking) "NO LABELS" else "NO TASKS")

                // The adapter Uri is stable per widget id on purpose: a Uri that
                // changed per render would make the host build a fresh factory
                // instead of reusing this one and calling onDataSetChanged.
                val serviceIntent = Intent(context, RiseWidgetService::class.java).apply {
                    putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                    data = Uri.parse("rise-widget://tasks/$appWidgetId")
                }
                views.setRemoteAdapter(R.id.widget_list, serviceIntent)
                views.setEmptyView(R.id.widget_list, R.id.widget_empty)

                // A collection has exactly one template, so the mode decides what a
                // row press means: commit a label, or toggle a task.
                val template = if (picking) {
                    Intent(context, RiseWidget::class.java).apply {
                        action = ACTION_SELECT_LABEL
                        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                        data = Uri.parse("rise-widget://select/$appWidgetId")
                    }
                } else {
                    Intent(context, RiseWidget::class.java).apply {
                        action = "com.rise.TOGGLE_TASK"
                        data = Uri.parse("rise-widget://toggle/$appWidgetId")
                    }
                }
                val templatePendingIntent = PendingIntent.getBroadcast(
                    context,
                    if (picking) RC_SELECT_TEMPLATE else RC_TOGGLE_TEMPLATE,
                    template,
                    // Must be mutable: fillIn only supplies fields the template left
                    // empty, and the row's label arrives that way.
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                )
                views.setPendingIntentTemplate(R.id.widget_list, templatePendingIntent)
            }

            // Logo click - opens main app
            val logoIntent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val logoPendingIntent = PendingIntent.getActivity(
                context, RC_LOGO, logoIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_logo, logoPendingIntent)

            // Label chip - opens/closes the in-widget picker. This used to be a
            // getActivity on MainActivity, which cold-launched the whole app just
            // to change a filter on the home screen.
            val labelIntent = Intent(context, RiseWidget::class.java).apply {
                action = ACTION_LABEL_PICKER
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                // Extras do not distinguish PendingIntents; the Uri does. Without
                // this, every task widget would share one chip.
                data = Uri.parse("rise-widget://picker/$appWidgetId")
            }
            val labelPendingIntent = PendingIntent.getBroadcast(
                context, RC_LABEL_CHIP, labelIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_label_container, labelPendingIntent)

            // Add button click - opens add modal
            val addIntent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                data = Uri.parse("rise://add")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            val addPendingIntent = PendingIntent.getActivity(
                context, RC_ADD, addIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_add, addPendingIntent)

            appWidgetManager.updateAppWidget(appWidgetId, views)
            Log.d("RiseWidget", "Widget updated successfully")
        }
    }
}
