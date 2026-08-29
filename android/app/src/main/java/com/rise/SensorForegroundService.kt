package com.rise

import android.Manifest
import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.util.Calendar
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * SensorForegroundService
 * =======================
 * The single owner of every hardware sensor a Rise habit depends on.
 *
 * Why this exists: before it, sensors ran on the React Native JS thread, so they
 * only counted while the app was open — and in practice only while the habit's own
 * detail screen was mounted. A step goal you were meant to hit by walking around
 * all day only counted the steps you took while staring at the app, and the
 * home-screen widgets showed whatever number happened to be frozen there when you
 * last closed Rise.
 *
 * What it owns:
 *   - steps          TYPE_STEP_COUNTER with a daily baseline, accelerometer fallback
 *   - distance       GPS with the same accuracy/speed filters as the JS path
 *   - silence        microphone RMS -> dB, accruing one second per second under threshold
 *   - digital sunset UsageStatsManager minutes, or unlock count, inside a nightly window
 *
 * What it publishes, once a minute and on material change:
 *   - PREF_KEYS.sensorRuntime  so widgets render live values with no JS alive
 *   - an `onSensorUpdate` event via SensorBridge, when JS happens to be running
 *
 * What it must never do: write identity, goals or units. Those belong to JS.
 * See docs/WIDGET_CONTRACT.md.
 */
class SensorForegroundService : Service(), SensorEventListener {

    companion object {
        private const val TAG = "RiseSensorService"

        /** Publish cadence. One minute is the finest granularity any widget shows. */
        private const val TICK_MS = 60_000L

        /**
         * Coalescing window for event-driven publishes.
         *
         * This used to be 20s, which is why steps and distance looked stale even with
         * the service running: you could walk half a minute before the number moved.
         * Two seconds is short enough to read as live and long enough that a batched
         * TYPE_STEP_COUNTER burst does not turn into a burst of writes. A trailing
         * publish is scheduled for events that land inside the window, so the last
         * reading of a burst is never the one that gets dropped.
         */
        private const val PUBLISH_COALESCE_MS = 2_000L

        /**
         * Floor between widget redraw broadcasts.
         *
         * Prefs are rewritten on every publish, so any redraw shows the newest number;
         * this only limits how often all eight receivers are woken to redraw. The
         * in-app screen gets the 2s cadence over the JS listener, where it matters.
         */
        private const val WIDGET_BROADCAST_MIN_MS = 10_000L

        /** Matches the JS accelerometer heuristic so both paths count alike. */
        private const val STEP_THRESHOLD = 14.5
        private const val STEP_COOLDOWN_MS = 400L

        private const val EXTRA_CONFIG = "extra_config"

        /**
         * Set when BootReceiver starts us. Android 14 forbids starting a
         * `microphone`-typed foreground service from the background, and
         * BOOT_COMPLETED counts as background, so a boot start has to run without
         * the microphone until the app is next opened.
         */
        private const val EXTRA_FROM_BOOT = "extra_from_boot"

        private const val PERM_ACTIVITY_RECOGNITION = "android.permission.ACTIVITY_RECOGNITION"
        private const val PERM_PACKAGE_USAGE_STATS = "android.permission.PACKAGE_USAGE_STATS"

        /** Request codes for the notification's PendingIntents; one each, no reuse. */
        private const val RC_NOTIF_OPEN = 0
        private const val RC_NOTIF_PAUSE = 1
        private const val RC_NOTIF_RESUME = 2
        private const val RC_NOTIF_QUIT = 3

        /**
         * Bridge back into JS. Held statically because the service has no handle on
         * the ReactContext; SensorBridge installs this when JS starts and clears it
         * when the context is torn down, so a dead context is never invoked.
         */
        @Volatile
        private var listener: ((String) -> Unit)? = null

        @JvmStatic
        fun setListener(l: ((String) -> Unit)?) {
            listener = l
        }

        @JvmStatic
        @JvmOverloads
        fun start(context: Context, configJson: String?, fromBoot: Boolean = false) {
            // Anything other than a boot start is the app itself asking, and opening
            // the app is the one thing that clears "quit completely".
            if (!fromBoot) WidgetContract.setQuit(context, false)
            val intent = Intent(context, SensorForegroundService::class.java).apply {
                action = WidgetContract.SERVICE_ACTION_START
                putExtra(EXTRA_CONFIG, configJson)
                putExtra(EXTRA_FROM_BOOT, fromBoot)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                // Android 12+ throws ForegroundServiceStartNotAllowedException if we
                // are in the background. Nothing to do but wait for the next
                // foreground moment; JS retries on resume.
                Log.w(TAG, "Could not start sensor service", e)
            }
        }

        @JvmStatic
        fun stop(context: Context) {
            try {
                context.startService(
                    Intent(context, SensorForegroundService::class.java)
                        .apply { action = WidgetContract.SERVICE_ACTION_STOP }
                )
            } catch (e: Exception) {
                Log.w(TAG, "Could not stop sensor service", e)
            }
        }

        @JvmStatic
        fun isRunning(context: Context): Boolean =
            WidgetContract.prefs(context).getBoolean(WidgetContract.KEY_SERVICE_RUNNING, false)

        /**
         * PACKAGE_USAGE_STATS is a special access grant, not a runtime permission:
         * there is no dialog to request it, so all we can do is check it and, when
         * it is missing, send the user to Settings.
         */
        @JvmStatic
        fun hasUsageStatsPermission(context: Context): Boolean {
            return try {
                val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    appOps.unsafeCheckOpNoThrow(
                        AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName
                    )
                } else {
                    @Suppress("DEPRECATION")
                    appOps.checkOpNoThrow(
                        AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName
                    )
                }
                if (mode == AppOpsManager.MODE_DEFAULT) {
                    context.checkCallingOrSelfPermission(PERM_PACKAGE_USAGE_STATS) ==
                        PackageManager.PERMISSION_GRANTED
                } else {
                    mode == AppOpsManager.MODE_ALLOWED
                }
            } catch (e: Exception) {
                false
            }
        }
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    private var sensorManager: SensorManager? = null
    private var stepSensor: Sensor? = null
    private var accelSensor: Sensor? = null
    private var locationManager: LocationManager? = null

    private var config: JSONObject = JSONObject()

    /** Steps today. */
    private var steps = 0
    /**
     * Steps already banked today from earlier boot segments (hardware mode), or the
     * running total (accelerometer mode). Persisted so a restart does not lose the day.
     */
    private var stepCarry = 0
    private var usingHardwareSteps = false
    /** Cosmetic 0-100 movement intensity from the accelerometer. */
    private var activity = 0
    private var accelWasAbove = false
    private var accelLastStepMs = 0L

    private var distanceMeters = 0.0
    private var lastLocation: Location? = null

    private var currentDb = 0
    private var noiseSeconds = 0
    /** noiseSeconds at the last persist, so accrual banks every ten seconds. */
    private var lastNoisePersistSeconds = 0
    @Volatile
    private var noiseThreadRunning = false
    private var noiseThread: Thread? = null

    private var unlocks = 0
    private var sunsetMinutes = 0
    private var sunsetSource = "none"
    /** The night the current sunset numbers belong to: the date of the cutoff. */
    private var sunsetWindowDate = ""
    private var sunsetWindowOpen = false

    private var dayKey = ""
    private var lastPublishMs = 0L
    private var lastWidgetBroadcastMs = 0L

    /** True while a trailing publish is already scheduled; see publishThrottled. */
    private var publishPending = false

    /** True until the app itself (re)starts us; see EXTRA_FROM_BOOT. */
    private var startedFromBoot = false

    private val handler = Handler(Looper.getMainLooper())

    private val publishRunnable = Runnable {
        publishPending = false
        try {
            publish()
        } catch (e: Exception) {
            Log.w(TAG, "trailing publish failed", e)
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            try {
                onTick()
            } catch (e: Exception) {
                Log.e(TAG, "tick failed", e)
            }
            handler.postDelayed(this, TICK_MS)
        }
    }

    /**
     * ACTION_USER_PRESENT fires when the user unlocks the device. It cannot be
     * declared in the manifest, which is precisely why counting unlocks needs a
     * live service rather than a broadcast receiver.
     */
    private val userPresentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != Intent.ACTION_USER_PRESENT) return
            if (!sunsetWindowOpen) return
            unlocks += 1
            persistCounters()
            publish()
        }
    }
    private var receiverRegistered = false

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        locationManager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        createChannel()
        registerUserPresent()
        restoreCounters()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == WidgetContract.SERVICE_ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }

        // "Quit completely" from the notification. Distinct from STOP: it also sets
        // the quit flag, so BootReceiver leaves us alone until the app is opened.
        if (intent?.action == WidgetContract.ACTION_QUIT) {
            WidgetContract.setQuit(this, true)
            stopEverything()
            // Widgets must repaint: their sensors are now off, and saying so is the
            // only way the user can tell this from a service that crashed.
            WidgetContract.broadcastUpdate(this)
            return START_NOT_STICKY
        }

        // Pause / resume keep the service alive. It costs nothing once every listener
        // is unregistered, and it is what keeps the RESUME action in the shade
        // reachable -- a stopped service has no notification to tap.
        when (intent?.action) {
            WidgetContract.ACTION_PAUSE_ALL -> WidgetContract.setPausedAll(this, true)
            WidgetContract.ACTION_RESUME_ALL -> WidgetContract.setPausedAll(this, false)
        }

        intent?.getStringExtra(EXTRA_CONFIG)?.let { saveConfig(it) }
        // Sticky restarts arrive with a null intent, so absence of the flag means
        // "not from boot" -- which is the safe default: it only ever adds capability.
        startedFromBoot = intent?.getBooleanExtra(EXTRA_FROM_BOOT, false) ?: false
        loadConfig()
        goForeground()
        applyConfig()
        handler.removeCallbacks(tick)
        handler.post(tick)
        WidgetContract.prefs(this).edit()
            .putBoolean(WidgetContract.KEY_SERVICE_RUNNING, true).apply()

        // START_STICKY so the system brings us back after a low-memory kill. The
        // config is read from prefs, so the null restart intent still works.
        return START_STICKY
    }

    override fun onDestroy() {
        stopEverything()
        super.onDestroy()
    }

    private fun stopEverything() {
        handler.removeCallbacks(tick)
        handler.removeCallbacks(publishRunnable)
        publishPending = false
        try {
            sensorManager?.unregisterListener(this)
        } catch (e: Exception) { }
        stopLocation()
        stopNoise()
        if (receiverRegistered) {
            try {
                unregisterReceiver(userPresentReceiver)
            } catch (e: Exception) { }
            receiverRegistered = false
        }
        persistCounters()
        WidgetContract.prefs(this).edit()
            .putBoolean(WidgetContract.KEY_SERVICE_RUNNING, false).apply()
        @Suppress("DEPRECATION")
        stopForeground(true)
        stopSelf()
    }

    private fun registerUserPresent() {
        if (receiverRegistered) return
        val filter = IntentFilter(Intent.ACTION_USER_PRESENT)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // A system-only broadcast must be registered NOT_EXPORTED on 13+.
                registerReceiver(userPresentReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                registerReceiver(userPresentReceiver, filter)
            }
            receiverRegistered = true
        } catch (e: Exception) {
            Log.w(TAG, "Could not register unlock receiver", e)
        }
    }

    // -----------------------------------------------------------------------
    // Notification
    // -----------------------------------------------------------------------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(WidgetContract.SERVICE_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            WidgetContract.SERVICE_CHANNEL_ID,
            getString(R.string.sensor_service_channel_name),
            // MIN keeps it collapsed and silent. This notification is the price of
            // a foreground service, not something anyone wants to look at.
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = getString(R.string.sensor_service_channel_desc)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val pausedAll = WidgetContract.isPausedAll(this)
        val open = PendingIntent.getActivity(
            this, RC_NOTIF_OPEN,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = NotificationCompat.Builder(this, WidgetContract.SERVICE_CHANNEL_ID)
            .setContentTitle(if (pausedAll) "Rise tracking paused" else "Rise is tracking")
            .setContentText(
                if (pausedAll) "Every sensor is off. Tap RESUME to start counting again."
                else summaryLine()
            )
            // Mono vector, not the launcher mipmap: the system keeps only a small
            // icon's alpha, so a full-colour one shows as a grey blob.
            .setSmallIcon(R.drawable.ic_stat_rise)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(open)

        // The two actions are the whole reason this notification is worth expanding.
        // An ongoing foreground-service notification cannot be swiped away, so
        // without them the only way to stop Rise using the microphone or GPS would be
        // to dig through system settings.
        if (pausedAll) {
            builder.addAction(
                R.drawable.ic_stat_play, "RESUME",
                serviceAction(WidgetContract.ACTION_RESUME_ALL, RC_NOTIF_RESUME)
            )
        } else {
            builder.addAction(
                R.drawable.ic_stat_pause, "PAUSE",
                serviceAction(WidgetContract.ACTION_PAUSE_ALL, RC_NOTIF_PAUSE)
            )
        }
        builder.addAction(
            R.drawable.ic_stat_quit, "QUIT",
            serviceAction(WidgetContract.ACTION_QUIT, RC_NOTIF_QUIT)
        )
        return builder.build()
    }

    /**
     * PendingIntent straight at this service rather than a broadcast: acting on a
     * notification is an explicit user action, so a service start is allowed here
     * even under Android 12+ background-start rules, and it skips a receiver hop.
     */
    private fun serviceAction(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getService(
            this, requestCode,
            Intent(this, SensorForegroundService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun summaryLine(): String {
        val parts = mutableListOf<String>()
        if (wantsSteps()) parts.add("$steps steps")
        if (wantsLocation()) parts.add(String.format("%.1f km", distanceMeters / 1000.0))
        if (wantsNoise()) parts.add("${noiseSeconds / 60} min quiet")
        if (wantsScreen() && sunsetWindowOpen) {
            parts.add(
                if (sunsetSource == WidgetContract.VERIFY_USAGESTATS) "$sunsetMinutes min screen"
                else "$unlocks unlocks"
            )
        }
        // Only count pauses on slots a habit actually occupies, so a leftover pause
        // for a slot with no habit in it does not show up as a mystery.
        val pausedHere = WidgetContract.pausedSlots(this).count { config.has(it) }
        if (pausedHere > 0) parts.add("$pausedHere paused")
        return when {
            parts.isNotEmpty() -> parts.joinToString(" · ")
            else -> "No sensor habits linked"
        }
    }

    /**
     * Declare only the foreground-service types we are actually using and hold the
     * permission for. From Android 14 a declared type whose permission is missing
     * throws SecurityException, so this has to be computed rather than hardcoded.
     *
     * HEALTH is preferred on Android 14+ because Android 15 caps DATA_SYNC at six
     * hours a day, which would silently stop all-day step counting each afternoon.
     */
    private fun goForeground() {
        val notification = buildNotification()
        try {
            val types = foregroundTypes()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && types != 0) {
                startForeground(WidgetContract.SERVICE_NOTIFICATION_ID, notification, types)
            } else {
                startForeground(WidgetContract.SERVICE_NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground rejected", e)
            stopSelf()
        }
    }

    private fun foregroundTypes(): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
        var types = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            hasPermission(PERM_ACTIVITY_RECOGNITION)
        ) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH
        }
        if (wantsLocation() && hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        // A microphone-typed service cannot be started from the background on
        // Android 14+, and BOOT_COMPLETED is the background. Claiming the type here
        // would make the boot start throw and take the whole service down with it,
        // losing step counting too -- so silence tracking waits for the app instead.
        if (wantsNoise() && hasPermission(Manifest.permission.RECORD_AUDIO) && !startedFromBoot) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        // Never leave the mask at 0 on Q+: the two-argument startForeground adopts
        // every type declared in the manifest, which would demand permissions we
        // have deliberately not claimed.
        if (types == 0) types = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        return types
    }

    private fun updateNotification() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(WidgetContract.SERVICE_NOTIFICATION_ID, buildNotification())
        } catch (e: Exception) { }
    }

    private fun hasPermission(name: String) =
        checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED

    // -----------------------------------------------------------------------
    // Config
    // -----------------------------------------------------------------------

    private fun saveConfig(json: String) {
        WidgetContract.prefs(this).edit()
            .putString(WidgetContract.KEY_SENSOR_CONFIG, json).apply()
    }

    private fun loadConfig() {
        config = try {
            JSONObject(
                WidgetContract.prefs(this).getString(WidgetContract.KEY_SENSOR_CONFIG, "{}") ?: "{}"
            )
        } catch (e: Exception) {
            JSONObject()
        }
    }

    /**
     * A slot is only tracked when a habit occupies it AND the user has not switched
     * it off. Every listener registration, every foreground-service type and the
     * notification summary all flow from these four, so a pause genuinely releases
     * the hardware instead of merely hiding the number.
     */
    private fun tracked(slot: String) =
        config.has(slot) && WidgetContract.isSlotTracking(this, slot)

    private fun wantsSteps() =
        tracked(WidgetContract.SLOT_PEDOMETER) || tracked(WidgetContract.SLOT_MOVEMENT)

    private fun wantsLocation() = tracked(WidgetContract.SLOT_GPS)
    private fun wantsNoise() = tracked(WidgetContract.SLOT_NOISE)
    private fun wantsScreen() = tracked(WidgetContract.SLOT_SCREEN)

    private fun applyConfig() {
        rollDayIfNeeded()

        val sm = sensorManager
        try {
            sm?.unregisterListener(this)
        } catch (e: Exception) { }
        stepSensor = null
        accelSensor = null

        if (wantsSteps() && sm != null) {
            stepSensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
            if (stepSensor != null) {
                usingHardwareSteps = true
                sm.registerListener(this, stepSensor, SensorManager.SENSOR_DELAY_NORMAL)
            } else {
                // No pedometer hardware: fall back to the accelerometer heuristic,
                // and say so on the widget via stepNote().
                usingHardwareSteps = false
                accelSensor = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
                accelSensor?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
            }
        }

        if (wantsLocation()) startLocation() else stopLocation()
        // Mirrors foregroundTypes(): if we could not claim the microphone type we
        // must not open the microphone either.
        if (wantsNoise() && !startedFromBoot) startNoise() else stopNoise()
    }

    // -----------------------------------------------------------------------
    // Day rollover and persistence
    // -----------------------------------------------------------------------

    /**
     * Reset per-day counters when the local date changes.
     *
     * The step baseline is the crux. TYPE_STEP_COUNTER is cumulative since boot, so
     * "steps today" is (current reading − the reading at midnight). Without a stored
     * baseline the first reading of a session reports every step since the phone was
     * last rebooted, which is one of the ways a 10,000-step goal completes itself
     * the moment you open the app.
     */
    private fun rollDayIfNeeded() {
        val today = WidgetContract.localDate()
        if (dayKey == today) return
        dayKey = today

        val p = WidgetContract.prefs(this)
        if (p.getString(WidgetContract.KEY_STEP_DATE, "") != today) {
            // Force re-baselining on the next TYPE_STEP_COUNTER event.
            steps = 0
            stepCarry = 0
            p.edit()
                .putString(WidgetContract.KEY_STEP_DATE, today)
                .putLong(WidgetContract.KEY_STEP_BASELINE, -1L)
                .putInt(WidgetContract.KEY_STEP_CARRY, 0)
                .apply()
        }

        if (p.getString(WidgetContract.KEY_NOISE_DATE, "") != today) {
            noiseSeconds = 0
            p.edit()
                .putString(WidgetContract.KEY_NOISE_DATE, today)
                .putInt(WidgetContract.KEY_NOISE_SECONDS, 0).apply()
        }

        if (p.getString(WidgetContract.KEY_GPS_DATE, "") != today) {
            distanceMeters = 0.0
            lastLocation = null
            p.edit()
                .putString(WidgetContract.KEY_GPS_DATE, today)
                .putFloat(WidgetContract.KEY_GPS_METERS, 0f).apply()
        }
    }

    private fun restoreCounters() {
        val p = WidgetContract.prefs(this)
        val today = WidgetContract.localDate()
        dayKey = today
        if (p.getString(WidgetContract.KEY_STEP_DATE, "") == today) {
            stepCarry = p.getInt(WidgetContract.KEY_STEP_CARRY, 0)
            steps = stepCarry
        }
        if (p.getString(WidgetContract.KEY_NOISE_DATE, "") == today) {
            noiseSeconds = p.getInt(WidgetContract.KEY_NOISE_SECONDS, 0)
        }
        if (p.getString(WidgetContract.KEY_GPS_DATE, "") == today) {
            distanceMeters = p.getFloat(WidgetContract.KEY_GPS_METERS, 0f).toDouble()
        }
        sunsetWindowDate = p.getString(WidgetContract.KEY_UNLOCK_WINDOW, "") ?: ""
        unlocks = p.getInt(WidgetContract.KEY_UNLOCKS, 0)
    }

    private fun persistCounters() {
        try {
            WidgetContract.prefs(this).edit()
                .putInt(WidgetContract.KEY_STEP_CARRY, stepCarry)
                .putString(WidgetContract.KEY_STEP_DATE, dayKey)
                .putInt(WidgetContract.KEY_NOISE_SECONDS, noiseSeconds)
                .putString(WidgetContract.KEY_NOISE_DATE, dayKey)
                .putFloat(WidgetContract.KEY_GPS_METERS, distanceMeters.toFloat())
                .putString(WidgetContract.KEY_GPS_DATE, dayKey)
                .putInt(WidgetContract.KEY_UNLOCKS, unlocks)
                .putString(WidgetContract.KEY_UNLOCK_WINDOW, sunsetWindowDate)
                .apply()
        } catch (e: Exception) { }
    }

    // -----------------------------------------------------------------------
    // Sensors
    // -----------------------------------------------------------------------

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { }

    override fun onSensorChanged(event: SensorEvent?) {
        event ?: return
        when (event.sensor.type) {
            Sensor.TYPE_STEP_COUNTER -> handleStepCounter(event.values[0].toLong())
            Sensor.TYPE_ACCELEROMETER -> handleAccelerometer(event)
        }
    }

    private fun handleStepCounter(reading: Long) {
        rollDayIfNeeded()
        val p = WidgetContract.prefs(this)
        var baseline = p.getLong(WidgetContract.KEY_STEP_BASELINE, -1L)
        stepCarry = p.getInt(WidgetContract.KEY_STEP_CARRY, stepCarry)

        if (baseline < 0L) {
            // First reading of the day: today's count starts from here.
            baseline = reading
            p.edit().putLong(WidgetContract.KEY_STEP_BASELINE, baseline).apply()
        } else if (reading < baseline) {
            // The device rebooted, which resets the hardware counter to zero. Bank
            // what we had and re-baseline, otherwise today's count goes negative.
            stepCarry = max(stepCarry, steps)
            baseline = 0L
            p.edit()
                .putLong(WidgetContract.KEY_STEP_BASELINE, 0L)
                .putInt(WidgetContract.KEY_STEP_CARRY, stepCarry)
                .apply()
        }

        val next = (stepCarry + (reading - baseline)).toInt()
        if (next > steps) {
            steps = next
            persistCounters()
            publishThrottled()
        }
    }

    private fun handleAccelerometer(event: SensorEvent) {
        val x = event.values[0].toDouble()
        val y = event.values[1].toDouble()
        val z = event.values[2].toDouble()
        val magnitude = sqrt(x * x + y * y + z * z)
        activity = ((magnitude - 9.8) * 10).coerceIn(0.0, 100.0).toInt()

        val above = magnitude > STEP_THRESHOLD
        val now = System.currentTimeMillis()
        // Rising edge plus a cooldown, so shaking the phone cannot farm steps.
        if (above && !accelWasAbove && now - accelLastStepMs > STEP_COOLDOWN_MS) {
            accelLastStepMs = now
            steps += 1
            stepCarry = steps
            persistCounters()
            publishThrottled()
        }
        accelWasAbove = above
    }

    // -----------------------------------------------------------------------
    // Location
    // -----------------------------------------------------------------------

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            // Same filters as the JS path: ignore imprecise fixes and standing
            // still, which are what made the distance number drift upward while the
            // phone sat motionless on a table.
            if (location.hasAccuracy() && location.accuracy > 20f) return
            if (location.hasSpeed() && location.speed < 0.3f) return

            val prev = lastLocation
            if (prev == null) {
                lastLocation = location
                return
            }
            val delta = prev.distanceTo(location)
            if (delta > 5f) {
                distanceMeters += delta
                lastLocation = location
                persistCounters()
                publishThrottled()
            }
        }

        @Deprecated("Required by the pre-30 LocationListener interface")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) { }
        override fun onProviderEnabled(provider: String) { }
        override fun onProviderDisabled(provider: String) { }
    }

    private fun startLocation() {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            Log.w(TAG, "Distance habit linked but location permission not granted")
            return
        }
        try {
            locationManager?.requestLocationUpdates(
                LocationManager.GPS_PROVIDER, 5_000L, 5f, locationListener
            )
        } catch (e: Exception) {
            Log.w(TAG, "Could not start location updates", e)
        }
    }

    private fun stopLocation() {
        try {
            locationManager?.removeUpdates(locationListener)
        } catch (e: Exception) { }
        lastLocation = null
    }

    // -----------------------------------------------------------------------
    // Noise
    // -----------------------------------------------------------------------

    /**
     * Read raw PCM and convert RMS to the same 0-100 scale the JS path uses
     * (dBFS + 100), so a threshold of 45 means the same thing whichever path is
     * running. Without that alignment the same habit would behave differently with
     * the app open and closed, which is exactly the class of bug this rewrite is
     * meant to remove.
     */
    /**
     * One accrued second of silence, handled on the main thread.
     *
     * Persisting every single second would rewrite the prefs file sixty times a
     * minute for the whole session, so counters are banked every ten seconds; the
     * publish itself is coalesced, so the visible timer still moves smoothly.
     */
    private fun onNoiseAccrued() {
        val moved = noiseSeconds - lastNoisePersistSeconds
        // The second test catches midnight, when noiseSeconds resets below the mark.
        if (moved >= 10 || noiseSeconds < lastNoisePersistSeconds) {
            lastNoisePersistSeconds = noiseSeconds
            persistCounters()
        }
        publishThrottled()
    }

    private fun startNoise() {
        if (noiseThreadRunning) return
        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            Log.w(TAG, "Silence habit linked but microphone permission not granted")
            return
        }
        noiseThreadRunning = true
        noiseThread = Thread {
            var record: AudioRecord? = null
            try {
                val sampleRate = 8000
                val minBuf = AudioRecord.getMinBufferSize(
                    sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
                )
                val bufSize = if (minBuf > 0) minBuf * 2 else sampleRate
                record = AudioRecord(
                    MediaRecorder.AudioSource.MIC, sampleRate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize
                )
                if (record.state != AudioRecord.STATE_INITIALIZED) {
                    Log.w(TAG, "AudioRecord failed to initialise")
                    return@Thread
                }
                record.startRecording()
                val buffer = ShortArray(max(1, bufSize / 2))
                var lastAccrualMs = System.currentTimeMillis()

                while (noiseThreadRunning) {
                    val read = record.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        var sum = 0.0
                        for (i in 0 until read) {
                            val v = buffer[i].toDouble()
                            sum += v * v
                        }
                        val rms = sqrt(sum / read)
                        val dbfs = if (rms > 0.0) 20.0 * log10(rms / 32767.0) else -100.0
                        currentDb = (dbfs + 100.0).coerceIn(0.0, 100.0).toInt()
                    }

                    // Accrue in wall-clock seconds rather than per buffer, so the
                    // buffer size cannot change how fast the goal fills.
                    val now = System.currentTimeMillis()
                    val elapsed = ((now - lastAccrualMs) / 1000L).toInt()
                    if (elapsed >= 1) {
                        lastAccrualMs = now
                        val threshold = config
                            .optJSONObject(WidgetContract.SLOT_NOISE)
                            ?.optInt("thresholdDb", 45) ?: 45
                        // currentDb == 0 means "no reading yet", not silence.
                        if (currentDb > 0 && currentDb < threshold) {
                            noiseSeconds += elapsed
                            // The silence timer is the one number a user sits and
                            // watches, so it must move without waiting for the minute
                            // tick. Hand off to the main thread: everything else
                            // persists and publishes from there.
                            handler.post { onNoiseAccrued() }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Noise monitoring stopped", e)
            } finally {
                try {
                    record?.stop()
                } catch (e: Exception) { }
                try {
                    record?.release()
                } catch (e: Exception) { }
            }
        }.also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun stopNoise() {
        noiseThreadRunning = false
        noiseThread = null
        currentDb = 0
    }

    // -----------------------------------------------------------------------
    // Digital Sunset
    // -----------------------------------------------------------------------

    /**
     * The window is nightly and straddles midnight (22:00 -> 06:00), so it is
     * identified by the date of its *cutoff*, not by the calendar date at the moment
     * of measurement. Screen time recorded at 01:00 belongs to the night that began
     * the previous evening, and recording it against the new calendar day would both
     * break the streak that was still intact and credit the wrong day.
     */
    private fun evaluateSunset() {
        val cfg = config.optJSONObject(WidgetContract.SLOT_SCREEN)
        if (cfg == null) {
            sunsetWindowOpen = false
            sunsetSource = "none"
            return
        }

        val cutoff = WidgetContract.parseClock(
            cfg.optString("cutoffTime", WidgetContract.SUNSET_CUTOFF_DEFAULT)
        ) ?: return
        val end = WidgetContract.parseClock(
            cfg.optString("windowEndTime", WidgetContract.SUNSET_WINDOW_END_DEFAULT)
        ) ?: return

        val now = Calendar.getInstance()
        val minutesNow = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val crossesMidnight = end <= cutoff

        val open: Boolean
        val windowStartMs: Long
        if (crossesMidnight) {
            open = minutesNow >= cutoff || minutesNow < end
            // Before the window-end hour we are in the tail of last night's window,
            // so the cutoff we measure from is yesterday's.
            val startDayOffset = if (minutesNow < end) -1 else 0
            windowStartMs = atMinuteOfDay(cutoff, startDayOffset)
        } else {
            open = minutesNow >= cutoff && minutesNow < end
            windowStartMs = atMinuteOfDay(cutoff, 0)
        }

        val windowDate = WidgetContract.localDate(windowStartMs)
        val wasOpen = sunsetWindowOpen
        val previousDate = sunsetWindowDate

        if (windowDate != previousDate) {
            // A new night: unlock counting restarts.
            unlocks = 0
            sunsetWindowDate = windowDate
            persistCounters()
        }
        sunsetWindowOpen = open

        val verification = cfg.optString("verification", WidgetContract.VERIFY_USAGESTATS)
        if (verification == WidgetContract.VERIFY_MANUAL) {
            sunsetSource = WidgetContract.VERIFY_MANUAL
        } else if (verification == WidgetContract.VERIFY_USAGESTATS &&
            hasUsageStatsPermission(this)
        ) {
            val minutes = queryUsageMinutes(windowStartMs, System.currentTimeMillis())
            if (minutes >= 0) {
                sunsetMinutes = minutes
                sunsetSource = WidgetContract.VERIFY_USAGESTATS
            } else {
                sunsetSource = WidgetContract.VERIFY_UNLOCKS
            }
        } else {
            // Degrade to unlock counting, which needs no special access.
            sunsetSource = WidgetContract.VERIFY_UNLOCKS
        }

        // When the window closes, bank the result exactly once. An 'atMost' habit
        // cannot be completed by progress crossing a threshold, so somebody has to
        // decide the night — and only the service knows when the window ended.
        if (wasOpen && !open && previousDate.isNotEmpty() &&
            sunsetSource != WidgetContract.VERIFY_MANUAL
        ) {
            val p = WidgetContract.prefs(this)
            if (p.getString(WidgetContract.KEY_SUNSET_RESOLVED, "") != previousDate) {
                val allowance = cfg.optInt(
                    "allowanceMinutes", WidgetContract.SUNSET_ALLOWANCE_MINUTES_DEFAULT
                )
                val used =
                    if (sunsetSource == WidgetContract.VERIFY_USAGESTATS) sunsetMinutes else unlocks
                val habitId = cfg.optString("habitId", "")
                if (habitId.isNotEmpty()) {
                    WidgetContract.enqueueOp(
                        this,
                        if (used <= allowance) WidgetContract.OP_SUNSET_CONFIRM
                        else WidgetContract.OP_SUNSET_SLIPPED,
                        habitId, WidgetContract.SLOT_SCREEN, used.toDouble(), previousDate
                    )
                }
                p.edit().putString(WidgetContract.KEY_SUNSET_RESOLVED, previousDate).apply()
            }
        }
    }

    /** Epoch ms for `minuteOfDay` on today + dayOffset, in local time. */
    private fun atMinuteOfDay(minuteOfDay: Int, dayOffset: Int): Long {
        val c = Calendar.getInstance()
        c.add(Calendar.DAY_OF_YEAR, dayOffset)
        c.set(Calendar.HOUR_OF_DAY, minuteOfDay / 60)
        c.set(Calendar.MINUTE, minuteOfDay % 60)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    /**
     * Total foreground app time in the window, in whole minutes, or -1 when usage
     * stats are unavailable.
     *
     * Rise itself is excluded: opening the app to see how you are doing should not
     * count against the very limit you are checking.
     *
     * Note the ACTIVITY_RESUMED / ACTIVITY_PAUSED constants are referenced by their
     * pre-29 names so the minSdk-24 build does not trip a NewApi lint error; the
     * values are identical.
     */
    private fun queryUsageMinutes(startMs: Long, endMs: Long): Int {
        val usm = try {
            getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
        } catch (e: Exception) {
            null
        } ?: return -1

        @Suppress("DEPRECATION")
        val resumed = UsageEvents.Event.MOVE_TO_FOREGROUND
        @Suppress("DEPRECATION")
        val paused = UsageEvents.Event.MOVE_TO_BACKGROUND

        return try {
            val events = usm.queryEvents(startMs, endMs)
            val event = UsageEvents.Event()
            var totalMs = 0L
            var openedAt = 0L
            var openPackage: String? = null

            while (events.hasNextEvent()) {
                events.getNextEvent(event)
                when (event.eventType) {
                    resumed -> {
                        openedAt = event.timeStamp
                        openPackage = event.packageName
                    }
                    paused -> {
                        if (openedAt > 0L && openPackage != packageName) {
                            totalMs += (event.timeStamp - openedAt).coerceAtLeast(0L)
                        }
                        openedAt = 0L
                        openPackage = null
                    }
                }
            }
            // Something may still be in the foreground right now.
            if (openedAt > 0L && openPackage != packageName) {
                totalMs += (endMs - openedAt).coerceAtLeast(0L)
            }
            (totalMs / 60_000L).toInt()
        } catch (e: Exception) {
            Log.w(TAG, "Usage stats query failed", e)
            -1
        }
    }

    // -----------------------------------------------------------------------
    // Tick and publish
    // -----------------------------------------------------------------------

    private fun onTick() {
        rollDayIfNeeded()
        if (wantsScreen()) evaluateSunset() else sunsetWindowOpen = false
        persistCounters()
        publish(forceWidgets = true)
        updateNotification()
    }

    /**
     * Publish on a sensor event, at most once per coalescing window.
     *
     * Leading edge plus a trailing publish: the first event after a quiet spell is
     * published immediately, and anything arriving inside the window schedules one
     * catch-up publish. A plain "drop it if too soon" throttle loses the final
     * reading of every burst, which for a step counter that batches is most of them.
     */
    private fun publishThrottled() {
        val since = System.currentTimeMillis() - lastPublishMs
        if (since >= PUBLISH_COALESCE_MS) {
            publish()
            return
        }
        if (publishPending) return
        publishPending = true
        handler.postDelayed(publishRunnable, PUBLISH_COALESCE_MS - since)
    }

    /**
     * Write the runtime overlay the widgets read, notify them, then hand the same
     * numbers to JS if it happens to be alive. Widgets first: they are the surface
     * that has to work when nothing else is running.
     */
    private fun publish(forceWidgets: Boolean = false) {
        val now = System.currentTimeMillis()
        lastPublishMs = now
        val runtime = JSONObject()

        // applyConfig rolls the day before anything can publish, but a publish on a
        // path that skipped it must still stamp a real date or the renderer would
        // discard every overlay as undated.
        val today = if (dayKey.isNotEmpty()) dayKey else WidgetContract.localDate()

        fun slot(name: String, progress: Double, note: String, forDate: String) {
            val cfg = config.optJSONObject(name) ?: return
            val habitId = cfg.optString("habitId", "")
            if (habitId.isEmpty()) return
            runtime.put(name, JSONObject().apply {
                // The id is what lets the renderer confirm the overlay still refers
                // to the habit currently occupying the slot.
                put(WidgetContract.F_ID, habitId)
                put(WidgetContract.F_PROGRESS, progress)
                // ...and the date is what stops a stale overlay outliving its day.
                // Counters reset in rollDayIfNeeded, which only runs while this
                // service ticks, so an overlay written before a kill-then-midnight
                // must be recognisably yesterday's and discarded by the renderer.
                put(WidgetContract.F_DATE, forDate)
                if (note.isNotEmpty()) put(WidgetContract.F_NOTE, note)
            })
        }

        slot(WidgetContract.SLOT_PEDOMETER, steps.toDouble(), stepNote(), today)
        slot(WidgetContract.SLOT_MOVEMENT, steps.toDouble(), stepNote(), today)
        slot(WidgetContract.SLOT_GPS, distanceMeters / 1000.0, "", today)
        slot(WidgetContract.SLOT_NOISE, noiseSeconds.toDouble(), noiseNote(), today)
        // The sunset window straddles midnight, so its overlay is stamped with the
        // evening the window opened, matching SensorWidgetRenderer.habitDate.
        slot(
            WidgetContract.SLOT_SCREEN,
            (if (sunsetSource == WidgetContract.VERIFY_USAGESTATS) sunsetMinutes else unlocks)
                .toDouble(),
            sunsetNote(),
            if (sunsetWindowDate.isNotEmpty()) sunsetWindowDate else today
        )

        try {
            WidgetContract.prefs(this).edit()
                .putString(WidgetContract.KEY_SENSOR_RUNTIME, runtime.toString()).apply()
            // Prefs are rewritten every publish, so any redraw -- from any cause --
            // picks up the newest number. The broadcast is what wakes all eight
            // receivers, so it is rate-limited separately.
            if (forceWidgets || now - lastWidgetBroadcastMs >= WIDGET_BROADCAST_MIN_MS) {
                lastWidgetBroadcastMs = now
                WidgetContract.broadcastUpdate(this)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not publish runtime", e)
        }

        val forJs = JSONObject().apply {
            put("steps", steps)
            put("activity", activity)
            put("noise", currentDb)
            put("noiseSeconds", noiseSeconds)
            put("distanceMeters", distanceMeters)
            put("sunsetMinutes", sunsetMinutes)
            put("sunsetUnlocks", unlocks)
            put("sunsetSource", sunsetSource)
            put("sunsetDate", sunsetWindowDate)
            put("sunsetWindowOpen", sunsetWindowOpen)
            put("date", today)
            // Pause state travels with the readings so the habit screen can grey a
            // sensor out the moment it is switched off from the notification, without
            // a separate bridge round-trip.
            put("pausedAll", WidgetContract.isPausedAll(this@SensorForegroundService))
            put(
                "paused",
                org.json.JSONArray(WidgetContract.pausedSlots(this@SensorForegroundService))
            )
        }
        try {
            listener?.invoke(forJs.toString())
        } catch (e: Exception) {
            // A dead ReactContext must not take the service down with it.
            Log.w(TAG, "JS listener threw", e)
        }
    }

    private fun stepNote(): String = if (usingHardwareSteps) "" else "ESTIMATED"

    private fun noiseNote(): String = if (currentDb > 0) "$currentDb dB NOW" else ""

    private fun sunsetNote(): String {
        val cfg = config.optJSONObject(WidgetContract.SLOT_SCREEN) ?: return ""
        val cutoff = cfg.optString("cutoffTime", WidgetContract.SUNSET_CUTOFF_DEFAULT)
        val end = cfg.optString("windowEndTime", WidgetContract.SUNSET_WINDOW_END_DEFAULT)
        if (!sunsetWindowOpen) return "WINDOW OPENS $cutoff"
        val allowance =
            cfg.optInt("allowanceMinutes", WidgetContract.SUNSET_ALLOWANCE_MINUTES_DEFAULT)
        return when (sunsetSource) {
            WidgetContract.VERIFY_USAGESTATS ->
                if (sunsetMinutes > allowance) "LIMIT BROKEN · $cutoff-$end"
                else "${allowance - sunsetMinutes} MIN LEFT · UNTIL $end"
            WidgetContract.VERIFY_UNLOCKS -> "$unlocks UNLOCKS SINCE $cutoff"
            else -> "CHECK IN BY $end"
        }
    }
}
