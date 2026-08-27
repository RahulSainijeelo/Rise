package com.rise

import android.appwidget.AppWidgetManager
import android.content.Context

/** Step Legend. All behaviour lives in SensorWidgetRenderer. */
class StepWidget : SensorWidgetProvider() {

    override val spec: SensorWidgetRenderer.SlotSpec get() = SPEC

    companion object {
        private val SPEC = SensorWidgetRenderer.SPECS.getValue(WidgetContract.SLOT_PEDOMETER)

        /** Kept for WidgetBridge, which updates each provider directly. */
        @JvmStatic
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            SensorWidgetRenderer.render(context, appWidgetManager, appWidgetId, SPEC)
        }
    }
}
