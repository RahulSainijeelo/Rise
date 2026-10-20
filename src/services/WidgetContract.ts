/**
 * WidgetContract
 * ==============
 * Single source of truth for the JS <-> native widget interface.
 *
 * The Kotlin mirror of this file is:
 *   android/app/src/main/java/com/rise/WidgetContract.kt
 *
 * If you change a key, a slot name, an op name or an action string here you MUST
 * change it there too. Every value in this file is duplicated in Kotlin because
 * SharedPreferences is an untyped string bag and there is no compiler keeping the
 * two halves honest.
 *
 * Prose overview: docs/WIDGET_CONTRACT.md
 */

// ---------------------------------------------------------------------------
// SharedPreferences
// ---------------------------------------------------------------------------

/** The one and only prefs file shared by the RN bridge, the widgets and the service. */
export const PREFS_NAME = 'RiseWidgetPrefs';

export const PREF_KEYS = {
    /** Tasks + habits list rendered by RiseWidget. Written by JS. */
    widgetData: 'widgetData',
    widgetLabels: 'widgetLabels',
    selectedLabel: 'selectedLabel',
    /** Active timer for TaskTimerWidget. Written by JS. */
    timerData: 'timerData',
    /** 35-day completion history per habit, for the heatmap widget. Written by JS. */
    habitHistoryData: 'habitHistoryData',
    pinnedHabitId: 'pinnedHabitId',
    pinnedHabitTitle: 'pinnedHabitTitle',

    /** SensorWidgetPayload. Written by JS, read by every sensor widget. */
    sensorData: 'sensorData',
    /**
     * Every habit without a dedicated widget, as a list, for HabitLinkWidget to
     * bind one instance to one habit. Same field set as a sensor slot.
     */
    habitsData: 'habitsData',
    /** habitId -> deadline state for TIMER habits. Written and read by native. */
    habitTimers: 'habitTimers',
    /**
     * Live values written by SensorForegroundService while the app is closed.
     * The renderer overlays this on top of sensorData so widgets stay live
     * without a JS bridge. Native writes, JS reads on foreground to reconcile.
     */
    sensorRuntime: 'sensorRuntime',
    /**
     * Queue of user actions taken on a widget while JS was not running.
     * Native appends, JS drains and clears. See PendingOp.
     */
    pendingOps: 'pendingOps',
    /** Per-habit config the native service needs (sunset window etc). Written by JS. */
    sensorConfig: 'sensorConfig',
    /**
     * TrackingState. Which sensors the user has switched off, whether tracking is
     * globally paused, and whether the app was explicitly quit. Written by BOTH
     * sides: JS when toggled in the app, native when toggled from a widget or the
     * notification. Whoever writes it last wins, which is correct here because
     * both are direct expressions of user intent.
     */
    trackingState: 'trackingState',
} as const;

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * A "slot" is one sensor widget's reserved seat. Exactly one habit may occupy a
 * slot at a time, and the binding is by templateId / sensorType -- never by
 * guessing at the habit's title.
 */
export const SENSOR_SLOTS = ['pedometer', 'gps', 'noise', 'movement', 'screen'] as const;
export type SensorSlot = (typeof SENSOR_SLOTS)[number];

/** Canonical template -> slot binding. */
export const TEMPLATE_SLOT: Record<string, SensorSlot> = {
    step_legend: 'pedometer',
    city_glider: 'gps',
    deep_silence: 'noise',
    immediate_rise: 'movement',
    digital_sunset: 'screen',
};

/**
 * The slot a habit occupies, or null if it occupies none.
 *
 * templateId first, sensorType second, and every layer must ask this rather than
 * reading either field directly. They used to disagree: the widgets bound slot to
 * habit by templateId while the native sensor config, the store commit and the
 * foreground fallback all matched on sensorType. A habit carrying one and not the
 * other therefore got a fully rendered widget and no sensor wiring whatsoever — no
 * permission request, no readings, no commits. That is exactly how City Glider ended
 * up showing a distance widget whose metres never moved.
 */
export const habitSlot = (habit: any): SensorSlot | null => {
    const byTemplate = habit?.templateId ? TEMPLATE_SLOT[habit.templateId] : undefined;
    if (byTemplate) return byTemplate;
    return (SENSOR_SLOTS as readonly string[]).includes(habit?.sensorType)
        ? (habit.sensorType as SensorSlot)
        : null;
};

/** How the widget should format `progress` and `goal` for display. */
export type WidgetDisplayMode =
    | 'int'       // 8412 STEPS
    | 'distance'  // km, shown as metres under 1km
    | 'duration'  // seconds, shown as whole minutes
    | 'sunset';   // inverse goal, renders `note` as the primary status

/**
 * Buttons the renderer should draw. Order is preserved left-to-right.
 * Each maps to at most one PendingOp when tapped.
 *
 * 'track' is the odd one out: it does not mutate habit progress, it turns this
 * slot's sensor on or off. Steps, distance and movement are measured rather than
 * entered, so they offer 'track' *instead of* dec/inc — hand-editing a number the
 * sensor overwrites on its next reading was never meaningful.
 *
 * 'run' and 'reset' are odd in the same way: they move a TIMER habit's countdown,
 * and only the seconds it actually runs for become progress. See HabitTimer.kt.
 */
export const WIDGET_CONTROLS = ['dec', 'inc', 'check', 'timer', 'confirm', 'slipped', 'track', 'refresh', 'run', 'reset'] as const;
export type WidgetControl = (typeof WIDGET_CONTROLS)[number];

export interface SensorSlotPayload {
    /** false => widget renders its empty "+ LINK ..." state. */
    exists: boolean;
    id?: string;
    templateId?: string;
    /** The habit's real title. Widgets must render this, not a hardcoded string. */
    title?: string;
    habitType?: 'check' | 'timer' | 'numeric';
    /** Canonical progress: steps | km | seconds | minutes-used. */
    progress?: number;
    goal?: number;
    /** The habit's real unit, uppercased for display. Never hardcoded natively. */
    unit?: string;
    /** Increment size for inc/dec, in the same unit as `progress`. */
    step?: number;
    displayMode?: WidgetDisplayMode;
    /**
     * 'atLeast' (default): progress >= goal completes the habit.
     * 'atMost': staying under goal completes it (Digital Sunset). Completion is
     * only committed when the window closes or the user confirms.
     */
    goalDirection?: 'atLeast' | 'atMost';
    isCompleted?: boolean;
    streak?: number;
    controls?: WidgetControl[];
    /** True when the native service is actively feeding this slot. */
    live?: boolean;
    /** Secondary status line, e.g. "0 UNLOCKS SINCE 22:00". */
    note?: string;
}

export interface SensorWidgetPayload {
    _meta: {
        version: number;
        /** epoch ms of the last JS write, for the "SYNCED HH:MM" line. */
        syncedAt: number;
        /** false => widgets render the logged-out state. */
        loggedIn: boolean;
    };
    // Slots live at the top level, keyed by SensorSlot. Any key starting with
    // "_" is metadata and must be skipped when iterating slots.
    [slot: string]: SensorSlotPayload | SensorWidgetPayload['_meta'];
}

/** Bump when the shape changes incompatibly; native ignores payloads it can't read. */
export const SENSOR_PAYLOAD_VERSION = 2;

/**
 * Shape of one slot inside PREF_KEYS.sensorRuntime.
 *
 * Written only by SensorForegroundService and read only by the native renderer, so
 * no TS code touches it — it is declared here because this file is where the two
 * halves of the contract are supposed to be legible side by side.
 *
 * `id` and `date` are both guards, not data. The renderer discards the overlay
 * unless both match what it is drawing: `id` because a slot's habit can be swapped
 * out, and `date` because the service resets its counters on a tick, so a service
 * killed before midnight would otherwise leave yesterday's step count in prefs to
 * be shown as today's.
 */
export interface SensorRuntimeSlot {
    id: string;
    progress: number;
    /** Habit-day this reading belongs to, YYYY-MM-DD local. Sunset uses window date. */
    date: string;
    note?: string;
}

// ---------------------------------------------------------------------------
// Pending ops (native -> JS)
// ---------------------------------------------------------------------------

/**
 * Pending-op names, mirrored in WidgetContract.kt.
 *
 * `taskToggle` is the odd one out: it toggles a TASK's completion, not a habit.
 * It reuses the PendingOp envelope, carrying the taskId in the `habitId` field and
 * leaving `slot`/`amount` empty. It exists because the Tasks widget used to flip a
 * task's status only inside its own prefs blob, which JS never read back and the
 * next render overwrote — so the tap was silently lost. Routing it through the
 * queue (like every habit op) is what makes a widget task-toggle durable.
 */
export const PENDING_OPS = ['inc', 'toggle', 'timerAdd', 'sunsetConfirm', 'sunsetSlipped', 'taskToggle'] as const;
export type PendingOpName = (typeof PENDING_OPS)[number];

/** Op-name constant for the Tasks-widget toggle. Must equal WidgetContract.kt OP_TASK_TOGGLE. */
export const OP_TASK_TOGGLE: PendingOpName = 'taskToggle';

export interface PendingOp {
    /** Dedupe key. JS must ignore an opId it has already applied. */
    opId: string;
    op: PendingOpName;
    habitId: string;
    slot: SensorSlot;
    /** Signed delta for `inc`, seconds for `timerAdd`, ignored otherwise. */
    amount: number;
    /** epoch ms, so JS can attribute the op to the correct day. */
    ts: number;
    /**
     * The habit-day this op belongs to, YYYY-MM-DD local.
     *
     * Needed because the Digital Sunset window straddles midnight: an op fired at
     * 01:00 belongs to the night that began at 22:00 the previous evening. When
     * absent, JS falls back to the local date of `ts`.
     */
    date?: string;
}

/** Native drops the oldest entries beyond this to bound the prefs blob. */
export const PENDING_OPS_MAX = 200;

/** Which op each control button fires. */
export const CONTROL_OP: Record<WidgetControl, PendingOpName | null> = {
    dec: 'inc',           // negative amount
    inc: 'inc',
    check: 'toggle',
    timer: 'timerAdd',
    confirm: 'sunsetConfirm',
    slipped: 'sunsetSlipped',
    track: null,          // flips TrackingState natively, never a habit mutation
    refresh: null,        // pure redraw, no state change
    run: null,            // moves HabitTimer; the seconds arrive as timerAdd ops
    reset: null,          // ditto — abandons the countdown, keeps what it earned
};

// ---------------------------------------------------------------------------
// Tracking / pause state
// ---------------------------------------------------------------------------

/**
 * Contents of PREF_KEYS.trackingState.
 *
 * Pausing is deliberately indefinite — it persists across restarts and reboots
 * until the user turns tracking back on. A pause that silently expires overnight
 * would re-enable a sensor someone switched off for privacy reasons.
 */
export interface TrackingState {
    /** Slots the user switched off individually. */
    paused: SensorSlot[];
    /** Global pause, from the app or the notification's PAUSE action. */
    pausedAll: boolean;
    /**
     * Set by "quit completely". The service stops and must NOT come back on boot;
     * only opening the app clears this.
     */
    quit: boolean;
}

export const DEFAULT_TRACKING_STATE: TrackingState = {
    paused: [],
    pausedAll: false,
    quit: false,
};

/** True when this slot should currently be collecting. */
export const isSlotTracking = (state: TrackingState, slot: SensorSlot): boolean =>
    !state.quit && !state.pausedAll && !state.paused.includes(slot);

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export const ACTIONS = {
    /** Tell every widget to redraw from prefs. */
    widgetUpdate: 'com.rise.WIDGET_UPDATE',
    /** A control button was tapped. Handled in-process, never launches the app. */
    widgetControl: 'com.rise.WIDGET_CONTROL',
    /** Turn one slot's sensor on or off. Extras: slot, enabled. */
    setTracking: 'com.rise.SET_TRACKING',
    /** Global pause / resume, fired by the notification actions. */
    pauseAll: 'com.rise.PAUSE_ALL',
    resumeAll: 'com.rise.RESUME_ALL',
    /** Stop tracking, stop the service, and stay stopped until the app reopens. */
    quit: 'com.rise.QUIT',
    /** Task/timer actions that predate this contract. */
    toggleTask: 'com.rise.TOGGLE_TASK',
    timerAction: 'com.rise.TIMER_ACTION',
} as const;

export const EXTRAS = {
    op: 'extra_op',
    habitId: 'extra_habit_id',
    slot: 'extra_slot',
    amount: 'extra_amount',
    /** Boolean for setTracking: true = collect, false = pause this slot. */
    enabled: 'extra_enabled',
    /**
     * Native-only. Not listed above with the others because JS never sends a
     * control broadcast; the value lives in MODE_PRIVATE prefs and only leaves the
     * process inside a PendingIntent. Declared here so nobody reuses the name:
     * see WidgetContract.kt EXTRA_TOKEN for why the widget receivers need it.
     */
    token: 'extra_token',
} as const;

/** Deep links still used for navigation (not for state mutation). */
export const DEEP_LINKS = {
    habitDetail: (habitId: string) => `rise://item/${habitId}/habit`,
    addSensorHabit: (templateId: string) => `rise://add-sensor-habit/${templateId}`,
} as const;

// ---------------------------------------------------------------------------
// Foreground service
// ---------------------------------------------------------------------------

export const SERVICE = {
    actionStart: 'com.rise.sensor.START',
    actionStop: 'com.rise.sensor.STOP',
    actionRefresh: 'com.rise.sensor.REFRESH',
    notificationChannelId: 'rise_sensors',
    notificationId: 4711,
} as const;

// ---------------------------------------------------------------------------
// Digital Sunset defaults
// ---------------------------------------------------------------------------

/**
 * Digital Sunset is an inverse-goal habit: you win by staying under a limit
 * inside a nightly window.
 *
 * Verification degrades gracefully:
 *   'usagestats' - real screen-time minutes after the cutoff (needs the
 *                  PACKAGE_USAGE_STATS special access grant)
 *   'unlocks'    - count of device unlocks after the cutoff, observed by the
 *                  foreground service (no special permission)
 *   'manual'     - self-reported; the widget shows confirm / slipped buttons
 */
export const SUNSET_DEFAULTS = {
    cutoffTime: '22:00',
    /** End of the window, next morning. */
    windowEndTime: '06:00',
    /** Minutes of post-cutoff screen time still counted as a success. */
    allowanceMinutes: 5,
    verification: 'usagestats' as const,
} as const;

export type SunsetVerification = 'usagestats' | 'unlocks' | 'manual';

/**
 * Deep Silence's tuning, mirrored in WidgetContract.kt.
 *
 * The scale is dBFS + 100 clamped to 0-100, which is what both the native
 * AudioRecord path and the JS fallback produce. It is not SPL — there is no
 * calibrated reference — so the numbers are only meaningful relative to each other,
 * which is precisely why the threshold has to be set by measuring the user's own
 * room rather than shipped as a universal constant.
 *
 * If these drift from the Kotlin copy the same habit accrues differently with the
 * app open and closed, which is the bug the shared constant exists to prevent.
 */
export const NOISE_DEFAULTS = {
    /** Used until the habit is calibrated. */
    thresholdDb: 45,
    /**
     * Clamp for a calibrated threshold. Below the floor only an anechoic chamber
     * counts and the habit is impossible; above the ceiling a vacuum cleaner counts
     * and it is meaningless. A slider can reach both ends by accident.
     */
    minDb: 20,
    maxDb: 80,
    /**
     * How long quiet must hold before going loud counts as a breach. A cough is not
     * a broken silence.
     */
    breachMinQuietSeconds: 20,
} as const;

/** Config blob handed to the native service via PREF_KEYS.sensorConfig. */
export interface SensorConfig {
    screen?: {
        habitId: string;
        cutoffTime: string;
        windowEndTime: string;
        allowanceMinutes: number;
        verification: SunsetVerification;
    };
    noise?: {
        habitId: string;
        /** Ambient dB at or below which the silence timer accrues. */
        thresholdDb: number;
        goalSeconds: number;
    };
    pedometer?: { habitId: string; goal: number };
    movement?: { habitId: string; goal: number };
    gps?: { habitId: string; goalKm: number };
}
