package com.rise

import android.appwidget.AppWidgetManager
import android.content.Context

/** Deep Silence. All behaviour lives in SensorWidgetRenderer. */
class SilenceWidget : SensorWidgetProvider() {

    override val spec: SensorWidgetRenderer.SlotSpec get() = SPEC

    companion object {
        private val SPEC = SensorWidgetRenderer.SPECS.getValue(WidgetContract.SLOT_NOISE)

        /** Kept for WidgetBridge, which updates each provider directly. */
        @JvmStatic
        fun updateWidget(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int) {
            SensorWidgetRenderer.render(context, appWidgetManager, appWidgetId, SPEC)
        }
    }
}
