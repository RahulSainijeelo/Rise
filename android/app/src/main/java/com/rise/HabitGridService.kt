package com.rise

import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import org.json.JSONArray
import org.json.JSONObject

class HabitGridService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory {
        return HabitGridFactory(this.applicationContext, intent)
    }
}

class HabitGridFactory(private val context: Context, private val intent: Intent) : RemoteViewsService.RemoteViewsFactory {
    private var habitId: String = ""
    private var history: JSONArray = JSONArray()

    override fun onCreate() {
        habitId = intent.getStringExtra("habitId") ?: ""
        updateData()
    }

    override fun onDataSetChanged() {
        updateData()
    }

    private fun updateData() {
        try {
            val sharedPref = context.getSharedPreferences("RiseWidgetPrefs", Context.MODE_PRIVATE)
            val historyDataStr = sharedPref.getString("habitHistoryData", "{}") ?: "{}"
            val allHistory = JSONObject(historyDataStr)
            
            if (allHistory.has(habitId)) {
                val habitData = allHistory.getJSONObject(habitId)
                history = habitData.optJSONArray("history") ?: JSONArray()
            }
            Log.d("HabitGridFactory", "History updated: ${history.length()} items for $habitId")
        } catch (e: Exception) {
            Log.e("HabitGridFactory", "Error updating data", e)
        }
    }

    override fun onDestroy() {}

    override fun getCount(): Int = history.length()

    override fun getViewAt(position: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.habit_grid_item)
        
        try {
            val dayData = history.getJSONObject(position)
            val completed = dayData.optBoolean("completed", false)
            
            views.setInt(R.id.habit_dot, "setBackgroundColor", 
                if (completed) 0xFFFFFFFF.toInt() else 0xFF333333.toInt())
                
        } catch (e: Exception) {
            Log.e("HabitGridFactory", "Error setting view at $position", e)
        }
        
        return views
    }

    override fun getLoadingView(): RemoteViews? = null
    override fun getViewTypeCount(): Int = 1
    override fun getItemId(position: Int): Long = position.toLong()
    override fun hasStableIds(): Boolean = true
}
