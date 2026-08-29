package com.rise

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent

/**
 * SensorWidgetProvider
 * ====================
 * Shared base for the five sensor widgets. Each subclass supplies only its slot
 * spec; every pixel and every tap is handled by SensorWidgetRenderer.
 *
 * On the control broadcast: these receivers deliberately do *not* declare an
 * intent-filter for ACTION_WIDGET_CONTROL, but that alone is not protection --
 * they must stay exported so the widget host can deliver APPWIDGET_UPDATE, and an
 * exported receiver can be targeted by an *explicit* intent from any app whatever
 * its filters say. What actually authenticates a tap is WidgetContract.EXTRA_TOKEN;
 * without it a third-party app could forge progress and corrupt a real streak.
 */
abstract class SensorWidgetProvider : AppWidgetProvider() {

    protected abstract val spec: SensorWidgetRenderer.SlotSpec

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (appWidgetId in appWidgetIds) {
            SensorWidgetRenderer.render(context, appWidgetManager, appWidgetId, spec)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        when (intent.action) {
            WidgetContract.ACTION_WIDGET_CONTROL -> {
                // Drop anything that did not come from one of our PendingIntents.
                if (!WidgetContract.isTrustedControl(context, intent)) return
                SensorWidgetRenderer.handleControl(context, intent)
                // Redraw this widget first so the tap feels immediate, then let the
                // other widgets pick up the same change.
                SensorWidgetRenderer.refreshProvider(context, spec)
                WidgetContract.broadcastUpdate(context)
            }
            WidgetContract.ACTION_SET_TRACKING -> {
                // Same forgery check as a control tap: another app must not be able to
                // switch someone's step counting off.
                if (!WidgetContract.isTrustedControl(context, intent)) return
                SensorWidgetRenderer.handleSetTracking(context, intent, spec)
                SensorWidgetRenderer.refreshProvider(context, spec)
                WidgetContract.broadcastUpdate(context)
            }
            WidgetContract.ACTION_WIDGET_UPDATE -> {
                val mgr = AppWidgetManager.getInstance(context)
                onUpdate(context, mgr, mgr.getAppWidgetIds(ComponentName(context, javaClass)))
            }
        }
    }
}
