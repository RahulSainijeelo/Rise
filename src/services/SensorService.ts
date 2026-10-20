import { accelerometer, SensorTypes, setUpdateIntervalForType } from 'react-native-sensors';
import { map } from 'rxjs/operators';
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import RNSoundLevel from 'react-native-sound-level';
import type { PendingOp, SensorConfig, SensorSlot } from './WidgetContract';
import { NOISE_DEFAULTS, SUNSET_DEFAULTS, habitSlot } from './WidgetContract';

/**
 * SensorBridge is the native module backed by SensorForegroundService. When it is
 * present (Android) it is the sole owner of the hardware sensors, so readings
 * continue while the app is backgrounded and the home-screen widgets stay live.
 *
 * When it is absent (iOS, or a debug build without the service) we fall back to
 * the react-native-* libraries, which only run while the app is foregrounded.
 */
const { SensorBridge } = NativeModules;
const hasNativeService = Platform.OS === 'android' && !!SensorBridge;

/**
 * Habits as a flat array from the store, tolerant of both the normalized shape
 * (habitsById + habitIds, current) and a legacy flat `habits` array. The store was
 * normalized for performance; every sensor path reads through this so the switch
 * cannot silently leave the service seeing zero habits (which would stop every
 * reading from being committed).
 */
const habitsOf = (state: any): any[] => {
    if (state && state.habitsById && Array.isArray(state.habitIds)) {
        const out: any[] = [];
        for (const id of state.habitIds) {
            const h = state.habitsById[id];
            if (h) out.push(h);
        }
        return out;
    }
    return (state && state.habits) || [];
};

setUpdateIntervalForType(SensorTypes.accelerometer, 100);

/*
 * Distance filtering, kept in step with the same three constants in
 * SensorForegroundService.kt so a commute measures the same with the app open and
 * closed. See startLocationTracking for why a speed filter is not among them.
 */

/** Fixes worse than this are guesses, not positions. */
const ACCURACY_LIMIT_M = 40;

/** Shortest movement counted as movement; below it, GPS is only wandering. */
const MIN_SEGMENT_M = 8;

/** ~144 km/h: above this the fix jumped rather than the person moving. */
const MAX_SPEED_MPS = 40;

/**
 * Local calendar date, YYYY-MM-DD.
 *
 * Deliberately not `new Date().toISOString().split('T')[0]`, which is UTC: for a
 * user at UTC+5:30 that string does not roll over until 05:30 local, so every
 * reading taken between midnight and 05:30 was being written to the previous
 * day's progress — and for the Digital Sunset window, which is mostly made of
 * those hours, almost every reading. Mirrors WidgetContract.localDate() in Kotlin.
 */
export const localDate = (d: Date = new Date()): string => {
    const pad = (n: number) => `${n}`.padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A single snapshot of everything the sensors currently believe. */
export interface LiveSensorData {
    steps: number;
    /** 0-100, derived from accelerometer magnitude. Cosmetic. */
    activity: number;
    /** Ambient level in dB. */
    noise: number;
    /** Seconds of silence accrued today, owned by the service in native mode. */
    noiseSeconds: number;
    /**
     * True while the microphone is actually open.
     *
     * Distinct from `noise > 0`. A silent room legitimately reads 0, so "0 means the
     * microphone is not running" was a sentinel the quietest possible conditions
     * could collide with — and the screen would claim the mic was off in exactly the
     * moment the habit was going best.
     */
    noiseListening: boolean;
    /** False until the first buffer has been measured; see noiseListening. */
    noiseHasReading: boolean;
    /** Seconds of unbroken quiet right now, reset whenever the room goes loud. */
    noiseStreakSeconds: number;
    /** How many worthwhile runs of quiet were broken today. */
    noiseBreaches: number;
    /**
     * The threshold the tracker is really using, clamped, as opposed to whatever is
     * stored on the habit. The meter draws its marker from this so the line the user
     * sees is the line the accrual actually tests against.
     */
    noiseThresholdDb: number;
    distanceMeters: number;
    /**
     * Why the metres are not moving, already worded for display, or '' when nothing
     * is wrong.
     *
     * Zero metres has four unrelated causes — permission refused, the system location
     * toggle off, no provider, or no fix yet — and from the outside they were all the
     * same confident 0.0 KM with an explanation buried in logcat.
     */
    gpsNote: string;
    location: { latitude: number; longitude: number } | null;
    /** Minutes of screen time recorded after the Digital Sunset cutoff. */
    sunsetMinutes: number;
    /** Device unlocks since the cutoff, used when UsageStats is not granted. */
    sunsetUnlocks: number;
    /** Which verification tier actually produced sunsetMinutes. */
    sunsetSource: 'usagestats' | 'unlocks' | 'manual' | 'none';
    /**
     * The habit-day the sunset numbers belong to: the date of the cutoff evening,
     * which is not today's date once you are past midnight.
     */
    sunsetDate: string;
    sunsetWindowOpen: boolean;
    /** True when a native foreground service is feeding these numbers. */
    live: boolean;
    /**
     * Tracking state, mirrored out of native prefs on every service tick.
     *
     * This is a read-only view: the authoritative copy lives in
     * RiseWidgetPrefs["trackingState"], because a widget tap or a notification
     * action can pause a sensor while JS is not running at all. Screens render
     * from here and write through setSlotTracking, never the other way round.
     */
    pausedAll: boolean;
    paused: SensorSlot[];
}

/** Everything the app needs to know about what is and is not being measured. */
export interface TrackingSnapshot {
    paused: SensorSlot[];
    pausedAll: boolean;
    quit: boolean;
}

const EMPTY_LIVE: LiveSensorData = {
    steps: 0,
    activity: 0,
    noise: 0,
    noiseSeconds: 0,
    noiseListening: false,
    noiseHasReading: false,
    noiseStreakSeconds: 0,
    noiseBreaches: 0,
    noiseThresholdDb: NOISE_DEFAULTS.thresholdDb,
    distanceMeters: 0,
    gpsNote: '',
    location: null,
    sunsetMinutes: 0,
    sunsetUnlocks: 0,
    sunsetSource: 'none',
    sunsetDate: '',
    sunsetWindowOpen: false,
    live: false,
    pausedAll: false,
    paused: [],
};

/**
 * The fields screens print as text. Guarded on the way in — see emit().
 */
const NUMERIC_LIVE_FIELDS: (keyof LiveSensorData)[] = [
    'steps',
    'activity',
    'noise',
    'noiseSeconds',
    'noiseStreakSeconds',
    'noiseBreaches',
    'noiseThresholdDb',
    'distanceMeters',
    'sunsetMinutes',
    'sunsetUnlocks',
];

/**
 * A threshold that is safe to accrue against.
 *
 * Exported because three places need the same answer — the config handed to native,
 * the JS fallback accrual, and the calibration control on the habit screen — and a
 * habit carrying an out-of-range value (hand-edited, restored from an older build,
 * or set by a slider that overshot) must not mean three different behaviours.
 */
export const clampNoiseThreshold = (db: number | undefined | null): number => {
    const n = Number(db);
    if (!isFinite(n)) return NOISE_DEFAULTS.thresholdDb;
    return Math.min(NOISE_DEFAULTS.maxDb, Math.max(NOISE_DEFAULTS.minDb, Math.round(n)));
};

/**
 * Derive the config the native service needs from the current habit list.
 * Exported so WidgetService and the app lifecycle can push it without
 * duplicating the field mapping.
 */
export const buildSensorConfig = (habits: any[]): SensorConfig => {
    const config: SensorConfig = {};
    // habitSlot, not h.sensorType: the widgets bind by templateId, and a habit whose
    // sensorType went missing used to get a widget with no sensor behind it.
    const bySlot = (slot: SensorSlot) => habits.find((h: any) => habitSlot(h) === slot);

    const ped = bySlot('pedometer');
    if (ped) config.pedometer = { habitId: ped.id, goal: ped.numericGoal || 0 };

    const mov = bySlot('movement');
    if (mov) config.movement = { habitId: mov.id, goal: mov.numericGoal || 0 };

    const gps = bySlot('gps');
    if (gps) config.gps = { habitId: gps.id, goalKm: gps.numericGoal || 0 };

    const noise = bySlot('noise');
    if (noise) {
        config.noise = {
            habitId: noise.id,
            thresholdDb: clampNoiseThreshold(noise.noiseThresholdDb),
            goalSeconds: noise.timerGoal || 0,
        };
    }

    const screen = bySlot('screen');
    if (screen) {
        config.screen = {
            habitId: screen.id,
            cutoffTime: screen.cutoffTime || SUNSET_DEFAULTS.cutoffTime,
            windowEndTime: screen.windowEndTime || SUNSET_DEFAULTS.windowEndTime,
            allowanceMinutes: screen.allowanceMinutes ?? SUNSET_DEFAULTS.allowanceMinutes,
            verification: screen.sunsetVerification || SUNSET_DEFAULTS.verification,
        };
    }

    return config;
};

class SensorService {
    private accelerometerSubscription: any = null;
    private stepCount = 0;
    private lastPosition: { latitude: number; longitude: number } | null = null;
    private totalDistance = 0; // in meters
    private lastStepTime = 0; // Cooldown for step detection
    private threshold = 14.5; // Higher threshold - requires actual walking motion
    private stepCooldown = 400; // Minimum 400ms between steps (prevents shaking)
    private isNoiseSensorRunning = false;
    private noiseAccrualTimer: ReturnType<typeof setInterval> | null = null;
    /** Loudest frame since the accrual interval last looked; see startNoiseSensor. */
    private noisePeakDb = 0;
    private noisePeakSeen = false;

    private live: LiveSensorData = { ...EMPTY_LIVE };
    private listeners = new Set<(d: LiveSensorData) => void>();
    private nativeSub: any = null;
    private getStore: (() => any) | null = null;
    private configJson = '';
    private tracking = false;

    // -----------------------------------------------------------------------
    // Subscription API
    //
    // Screens must subscribe rather than start sensors themselves. Two owners
    // of the same hardware meant the habit detail screen reset the step count
    // on mount and stopped global tracking on unmount.
    // -----------------------------------------------------------------------

    subscribe(cb: (d: LiveSensorData) => void): () => void {
        this.listeners.add(cb);
        cb(this.live);
        return () => { this.listeners.delete(cb); };
    }

    getLive(): LiveSensorData {
        return this.live;
    }

    private emit(patch: Partial<LiveSensorData>) {
        this.live = { ...this.live, ...NUMERIC_LIVE_FIELDS.reduce((clean, key) => {
            // The chokepoint for every reading that reaches a screen.
            //
            // Screens render these straight into text, so one wrongly-shaped value
            // from native does not misprint a number — it throws "Objects are not
            // valid as a React child" and takes the whole screen with it. That has
            // already happened once, when a per-slot overlay object landed in
            // `noise`. Anything that is not a finite number is dropped here, and the
            // previous good reading stands.
            const value = (patch as any)[key];
            if (value === undefined) return clean;
            const n = typeof value === 'number' ? value : Number(value);
            if (isFinite(n)) (clean as any)[key] = n;
            else delete (clean as any)[key];
            return clean;
        }, { ...patch }) };
        this.listeners.forEach(cb => {
            try {
                cb(this.live);
            } catch (e) {
                console.warn('Sensor listener threw', e);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Global tracking
    // -----------------------------------------------------------------------

    /**
     * Start (or restart) tracking for whatever sensor habits currently exist.
     * Safe to call repeatedly: it no-ops when the derived config is unchanged,
     * so it can be called from a store subscription.
     */
    startGlobalTracking(getStore: () => any) {
        this.getStore = getStore;
        const state = getStore();
        const habits = habitsOf(state);
        const config = buildSensorConfig(habits);
        const json = JSON.stringify(config);

        if (this.tracking && json === this.configJson) return;
        this.configJson = json;

        if (hasNativeService) {
            this.startNativeTracking(json);
        } else {
            this.startFallbackTracking(habits);
        }
        this.tracking = true;
    }

    /** Alias that reads better at the call site when habits have changed. */
    refreshConfig(getStore: () => any) {
        this.startGlobalTracking(getStore);
    }

    /** Is the native foreground service alive right now? */
    async isNativeTracking(): Promise<boolean> {
        if (!hasNativeService) return false;
        try {
            return await SensorBridge.isTracking();
        } catch (e) {
            return false;
        }
    }

    /**
     * Start tracking, retrying a start that the OS previously refused.
     *
     * startGlobalTracking short-circuits when the config has not changed, which is
     * what keeps it cheap to call from a store subscription — but it also means a
     * start that Android 12+ rejected for happening in the background would never be
     * retried, because from JS's point of view tracking was already underway. Call
     * this on every return to the foreground, where the start is permitted.
     */
    async ensureTracking(getStore: () => any) {
        if (hasNativeService && this.tracking && !(await this.isNativeTracking())) {
            // Clear the short-circuit so the next call really starts the service.
            this.tracking = false;
            this.configJson = '';
        }
        this.startGlobalTracking(getStore);
    }

    private startNativeTracking(configJson: string) {
        try {
            if (!this.nativeSub) {
                const emitter = new NativeEventEmitter(SensorBridge);
                this.nativeSub = emitter.addListener('onSensorUpdate', (payload: string) => {
                    this.handleNativeUpdate(payload);
                });
            }
            SensorBridge.startTracking(configJson);
        } catch (e) {
            console.warn('Native sensor service failed to start, falling back', e);
            const habits = habitsOf(this.getStore?.());
            this.startFallbackTracking(habits);
        }
    }

    private handleNativeUpdate(payload: string) {
        let data: any;
        try {
            data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        } catch (e) {
            return;
        }

        this.emit({
            steps: data.steps ?? this.live.steps,
            activity: data.activity ?? this.live.activity,
            noise: data.noise ?? this.live.noise,
            noiseSeconds: data.noiseSeconds ?? this.live.noiseSeconds,
            // `??` and not `||`: false and 0 are the readings that matter most here —
            // a microphone that just went off, and a room that has just fallen silent.
            noiseListening: data.noiseListening ?? this.live.noiseListening,
            noiseHasReading: data.noiseHasReading ?? this.live.noiseHasReading,
            noiseStreakSeconds: data.noiseStreakSeconds ?? this.live.noiseStreakSeconds,
            noiseBreaches: data.noiseBreaches ?? this.live.noiseBreaches,
            noiseThresholdDb: data.noiseThresholdDb ?? this.live.noiseThresholdDb,
            distanceMeters: data.distanceMeters ?? this.live.distanceMeters,
            // `??` again, and the empty string matters: '' is the service telling us a
            // fix landed and the previous complaint no longer applies.
            gpsNote: data.gpsNote ?? this.live.gpsNote,
            sunsetMinutes: data.sunsetMinutes ?? this.live.sunsetMinutes,
            sunsetUnlocks: data.sunsetUnlocks ?? this.live.sunsetUnlocks,
            sunsetSource: data.sunsetSource ?? this.live.sunsetSource,
            sunsetDate: data.sunsetDate ?? this.live.sunsetDate,
            sunsetWindowOpen: data.sunsetWindowOpen ?? this.live.sunsetWindowOpen,
            live: true,
            pausedAll: !!data.pausedAll,
            paused: Array.isArray(data.paused) ? data.paused : [],
        });

        this.commitToStore();
    }

    /**
     * Push live readings into the store. The store is the only thing that writes
     * the widget payload, so this is what makes widgets update.
     */
    private commitToStore() {
        const getStore = this.getStore;
        if (!getStore) return;
        const state = getStore();
        const habits: any[] = habitsOf(state);
        const today = localDate();
        const d = this.live;

        habits.forEach((h) => {
            if (!h.isSensorBased) return;

            // The slot, not the raw sensorType: a habit bound to a widget by templateId
            // must be credited by the same rule the widget was drawn with, or the widget
            // shows a number the habit never receives.
            const slot = habitSlot(h);
            if (!slot) return;

            // The Digital Sunset window straddles midnight, so its readings belong
            // to the night that began at the cutoff, not to whatever the calendar
            // says right now.
            const date = slot === 'screen' && d.sunsetDate ? d.sunsetDate : today;

            // Never overwrite a day the user has already closed out, except for
            // 'atMost' habits where the count must keep rising until the window
            // ends, otherwise a breach after completion would go unrecorded.
            const isAtMost = (h.goalDirection || 'atLeast') === 'atMost';
            if (h.completedDates?.includes(date) && !isAtMost) return;

            if (slot === 'pedometer' || slot === 'movement') {
                const cur = h.numericProgress?.[date] || 0;
                if (d.steps > cur) state.updateSensorProgress(h.id, date, d.steps);
            } else if (slot === 'gps') {
                const km = d.distanceMeters / 1000;
                const cur = h.numericProgress?.[date] || 0;
                if (km > cur) state.updateSensorProgress(h.id, date, km);
            } else if (slot === 'screen') {
                // A Digital Sunset habit's progress is MINUTES of post-cutoff screen
                // time — that is the unit its goal (allowanceMinutes) is in and the
                // unit every surface prints ("12 / 45 MIN"). Unlocks are only a coarse
                // proxy the service falls back to when UsageStats is not granted;
                // committing an unlock *count* into the same minutes-denominated field
                // made "3 / 45 MIN" compare three unlocks against a forty-five-minute
                // allowance, and flipped the held/slipped verdict on a unit mismatch
                // (H-03). Only auto-commit the authoritative minutes reading. Without
                // UsageStats the habit stands on its confirm/slipped controls rather
                // than a mismeasured number — honest beats precise-looking-but-wrong.
                if (d.sunsetSource === 'usagestats') {
                    const cur = h.numericProgress?.[date] || 0;
                    if (d.sunsetMinutes > cur) state.updateSensorProgress(h.id, date, d.sunsetMinutes);
                }
            } else if (slot === 'noise' && d.live) {
                // In native mode the service owns the silence clock. In fallback
                // mode startNoiseAccrual does, so this must not double-count.
                const cur = h.timerProgress?.[date] || 0;
                if (d.noiseSeconds > cur) state.updateSensorProgress(h.id, date, d.noiseSeconds);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Foreground-only fallback (iOS, or Android without the service)
    // -----------------------------------------------------------------------

    private startFallbackTracking(habits: any[]) {
        const today = localDate();
        // Same rule as the config and the commit: slot, not raw sensorType.
        const bySlot = (slot: string) => habits.find((h: any) => habitSlot(h) === slot);
        const has = (slot: string) => !!bySlot(slot);

        if (has('pedometer') || has('movement')) {
            const seed = bySlot('pedometer') || bySlot('movement');
            this.startPedometer(seed?.numericProgress?.[today] || 0, (steps, activity) => {
                this.emit({ steps, activity });
                this.commitToStore();
            });
        }

        if (has('gps')) {
            const seed = bySlot('gps');
            const initialMeters = (seed?.numericProgress?.[today] || 0) * 1000;
            this.startLocationTracking(initialMeters, (lat, lng, distMeters) => {
                this.emit({ location: { latitude: lat, longitude: lng }, distanceMeters: distMeters });
                this.commitToStore();
            });
        }

        // Noise was never started by global tracking at all, so Deep Silence only
        // ever accrued while its detail screen happened to be open.
        const noiseHabit = bySlot('noise');
        if (noiseHabit) {
            this.startNoiseSensor((db) => this.emit({
                noise: db,
                noiseListening: true,
                noiseHasReading: true,
            }));
            this.startNoiseAccrual(noiseHabit.id, clampNoiseThreshold(noiseHabit.noiseThresholdDb));
        }
    }

    /**
     * Accrue one second of silence per wall-clock second the room stayed under the
     * threshold, and keep the two numbers that make that total legible: the current
     * unbroken run, and how many worthwhile runs were broken today.
     *
     * Owning the clock in one interval avoids the previous bug where a new interval
     * was created on every dB reading. The threshold and the peak-per-second rule are
     * deliberately identical to SensorForegroundService.startNoise, because the same
     * habit must accrue the same way whichever path is running.
     */
    private startNoiseAccrual(habitId: string, thresholdDb: number) {
        this.stopNoiseAccrual();
        this.emit({ noiseThresholdDb: thresholdDb });
        this.noisePeakSeen = false;
        this.noisePeakDb = 0;
        this.noiseAccrualTimer = setInterval(() => {
            const getStore = this.getStore;
            if (!getStore) return;

            // A second with no frames at all is not evidence of anything: the streak
            // is neither extended nor broken.
            if (!this.noisePeakSeen) return;
            const peak = this.noisePeakDb;
            this.noisePeakSeen = false;
            this.noisePeakDb = 0;

            if (peak > thresholdDb) {
                // A cough is not a broken silence; only a run worth having counts as
                // one that was lost.
                const broke = this.live.noiseStreakSeconds >= NOISE_DEFAULTS.breachMinQuietSeconds;
                this.emit({
                    noiseStreakSeconds: 0,
                    noiseBreaches: this.live.noiseBreaches + (broke ? 1 : 0),
                });
                return;
            }

            const state = getStore();
            const habit = (state.habitsById && state.habitsById[habitId]) ||
                habitsOf(state).find((h: any) => h.id === habitId);
            if (!habit) return;
            const today = localDate();
            if (habit.completedDates?.includes(today)) return;

            const cur = habit.timerProgress?.[today] || 0;
            state.updateSensorProgress(habitId, today, cur + 1);
            this.emit({
                noiseSeconds: cur + 1,
                noiseStreakSeconds: this.live.noiseStreakSeconds + 1,
            });
        }, 1000);
    }

    private stopNoiseAccrual() {
        if (this.noiseAccrualTimer) {
            clearInterval(this.noiseAccrualTimer);
            this.noiseAccrualTimer = null;
        }
    }

    stopGlobalTracking() {
        this.tracking = false;
        this.configJson = '';
        this.stopNoiseAccrual();
        if (hasNativeService) {
            try {
                SensorBridge.stopTracking();
            } catch (e) { }
        }
        this.stopPedometer();
        this.stopLocationTracking();
        this.stopNoiseSensor();
        this.emit({ live: false });
    }

    // -----------------------------------------------------------------------
    // Digital Sunset permission plumbing
    // -----------------------------------------------------------------------

    /**
     * PACKAGE_USAGE_STATS cannot be requested with a runtime dialog, so the app
     * has to check the grant and send the user to Settings instead.
     */
    async hasUsageStatsPermission(): Promise<boolean> {
        if (!hasNativeService) return false;
        try {
            return await SensorBridge.hasUsageStatsPermission();
        } catch (e) {
            return false;
        }
    }

    openUsageStatsSettings() {
        if (!hasNativeService) return;
        try {
            SensorBridge.openUsageStatsSettings();
        } catch (e) { }
    }

    // -----------------------------------------------------------------------
    // Tracking / pause
    // -----------------------------------------------------------------------
    //
    // There is intentionally no JS copy of the pause state. The same bag is
    // written by the habit screen, by a widget button and by the notification's
    // PAUSE action, and the last two happen with JS dead, so a cached copy here
    // would be wrong exactly when it mattered. Reads go to native; writes go to
    // native and come back on the next tick through LiveSensorData.

    async getTrackingState(): Promise<TrackingSnapshot> {
        const fallback: TrackingSnapshot = { paused: [], pausedAll: false, quit: false };
        if (!hasNativeService) return fallback;
        try {
            const parsed = JSON.parse((await SensorBridge.getTrackingState()) || '{}');
            const state: TrackingSnapshot = {
                paused: Array.isArray(parsed.paused) ? parsed.paused : [],
                pausedAll: !!parsed.pausedAll,
                quit: !!parsed.quit,
            };
            // Fold it into the live snapshot too: a widget or notification pause
            // happened outside JS, and waiting for the next service tick would leave
            // a just-resumed screen drawing a stale OFF button.
            this.emit({ paused: state.paused, pausedAll: state.pausedAll || state.quit });
            return state;
        } catch (e) {
            return fallback;
        }
    }

    /**
     * Synchronous answer for render: is this slot being measured right now?
     * Uses the last tick, so it is correct the instant a screen paints and is
     * corrected within one publish cycle if it ever lags.
     */
    isSlotTracking(slot: SensorSlot): boolean {
        if (!hasNativeService) return true;
        return !this.live.pausedAll && !this.live.paused.includes(slot);
    }

    /** Switch one sensor off (or back on). Releases the hardware natively. */
    async setSlotTracking(slot: SensorSlot, enabled: boolean) {
        // Paint immediately; the service confirms on its next publish.
        const paused = this.live.paused.filter(s => s !== slot);
        this.emit({
            paused: enabled ? paused : [...paused, slot],
            pausedAll: enabled ? false : this.live.pausedAll,
        });
        if (!hasNativeService) return;
        try {
            SensorBridge.setSlotTracking(slot, enabled);
        } catch (e) {
            console.warn('Could not change sensor tracking', e);
        }
    }

    /** Pause or resume every sensor at once, as the notification does. */
    async setPausedAll(paused: boolean) {
        this.emit({ pausedAll: paused });
        if (!hasNativeService) return;
        try {
            SensorBridge.setPausedAll(paused);
        } catch (e) {
            console.warn('Could not change global tracking', e);
        }
    }

    /**
     * Stop everything and stay stopped across reboots. Opening the app clears the
     * flag, so this is a quit rather than an uninstall.
     */
    quitTracking() {
        this.tracking = false;
        this.configJson = '';
        this.stopNoiseAccrual();
        this.stopPedometer();
        this.stopLocationTracking();
        this.stopNoiseSensor();
        this.emit({ live: false, pausedAll: true });
        if (!hasNativeService) return;
        try {
            SensorBridge.quitTracking();
        } catch (e) { }
    }

    // -----------------------------------------------------------------------
    // Battery optimisation
    // -----------------------------------------------------------------------

    /**
     * Doze is what quietly ends all-day counting: sensor batches stall while the
     * phone is idle and OEM battery managers kill the service outright. Reported as
     * already-granted where the concept does not exist, so callers can treat false
     * as "worth asking".
     */
    async isIgnoringBatteryOptimizations(): Promise<boolean> {
        if (!hasNativeService) return true;
        try {
            return await SensorBridge.isIgnoringBatteryOptimizations();
        } catch (e) {
            return true;
        }
    }

    requestIgnoreBatteryOptimizations() {
        if (!hasNativeService) return;
        try {
            SensorBridge.requestIgnoreBatteryOptimizations();
        } catch (e) { }
    }

    /**
     * Restore the service's last published counters, so a habit screen opens on the
     * real numbers instead of on zeros.
     *
     * Read this carefully before changing it. The blob behind getRuntimeSnapshot is
     * the per-slot overlay the service writes *for the widgets*: keyed by slot name,
     * each entry `{id, progress, date}`. It is not the JS-shaped reading set that
     * arrives on the tick listener. The two vocabularies overlap on exactly one word
     * — "noise", which means a slot here and decibels there — so treating one as the
     * other put a `{id, progress, date, note}` object into `live.noise` and took the
     * Deep Silence card down with "Objects are not valid as a React child". Every
     * other field silently fell through to its previous value, which is why the only
     * visible symptom was that one screen.
     *
     * So: translate deliberately, name the unit at every step, and never widen a
     * value from this blob without coercing it to a number first.
     */
    async loadRuntimeSnapshot(): Promise<void> {
        if (!hasNativeService) return;
        try {
            const raw = await SensorBridge.getRuntimeSnapshot();
            const data = JSON.parse(raw || '{}');
            if (!data || typeof data !== 'object') return;

            const today = localDate();

            /** A slot's banked figure, or null if it is absent or from another day. */
            const banked = (name: SensorSlot): number | null => {
                const entry = (data as any)[name];
                if (!entry || typeof entry !== 'object') return null;
                // An overlay stamped with another date is yesterday's count, left
                // behind by a service killed before it could roll the day over.
                const stamp = typeof entry.date === 'string' ? entry.date : '';
                if (stamp && stamp !== today) return null;
                const value = Number(entry.progress);
                return isFinite(value) ? value : null;
            };

            const steps = banked('pedometer') ?? banked('movement');
            const quietSeconds = banked('noise');
            const kilometres = banked('gps');

            // Taken as-is rather than max()'d against the current snapshot: these come
            // from the same service fields the tick listener reports, so they agree,
            // and preferring the larger of the two would carry a count across midnight.
            const next: Partial<LiveSensorData> = {};
            if (steps !== null) next.steps = Math.round(steps);
            if (quietSeconds !== null) next.noiseSeconds = Math.round(quietSeconds);
            if (kilometres !== null) next.distanceMeters = kilometres * 1000;

            // Decibels, activity and the sunset tier are instantaneous readings, not
            // banked ones, so they are not in this blob at all. The first tick after
            // the screen opens fills them in; until then the previous values stand.
            if (Object.keys(next).length > 0) this.emit(next);
        } catch (e) { }
    }

    /**
     * Actions the user took on a widget while JS was not running. Cleared
     * natively as they are handed over, so each op is delivered once.
     */
    async drainPendingOps(): Promise<PendingOp[]> {
        if (!hasNativeService) return [];
        try {
            const json = await SensorBridge.drainPendingOps();
            const parsed = JSON.parse(json || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.warn('Failed to drain pending widget ops', e);
            return [];
        }
    }

    // -----------------------------------------------------------------------
    // Raw sensor plumbing
    // -----------------------------------------------------------------------

    resetDistance() {
        this.totalDistance = 0;
        this.lastPosition = null;
    }

    resetSteps() {
        this.stepCount = 0;
    }

    /**
     * GPS tracking for the in-app path.
     *
     * The filters mirror SensorForegroundService's locationListener — same accuracy
     * limit, same minimum segment, same implied-speed ceiling — because a commute has
     * to measure the same whether the app is open or closed. What is deliberately gone
     * is the old speed test: plenty of devices report speed 0 on every fix (the field
     * is only filled in when the chipset has a Doppler solution), so "ignore anything
     * slower than 0.3 m/s" threw away every fix and the metre count never moved.
     * Standing still is now rejected geometrically instead, by MIN_SEGMENT_M.
     */
    startLocationTracking(initialDistance: number, onData: (lat: number, lng: number, distance: number) => void) {
        if (!Geolocation) {
            console.warn("Geolocation module not found");
            return;
        }
        this.totalDistance = initialDistance;
        let lastFixAt = 0;
        // Nothing has arrived yet, and saying so is the honest state: the first fix
        // takes a while outdoors and may never come indoors, which is otherwise
        // indistinguishable from a dead sensor.
        this.emit({ gpsNote: 'WAITING FOR A FIX' });
        Geolocation.watchPosition(
            (position) => {
                const { latitude, longitude, accuracy } = position.coords;
                const now = position.timestamp || Date.now();

                // A fix this imprecise is a guess, not a position.
                if (typeof accuracy === 'number' && accuracy > ACCURACY_LIMIT_M) return;

                // Cleared before the segment filters, not after: a rejected segment
                // still proves location is working.
                if (this.live.gpsNote) this.emit({ gpsNote: '' });

                if (this.lastPosition) {
                    const d = this.calculateDistance(
                        this.lastPosition.latitude,
                        this.lastPosition.longitude,
                        latitude,
                        longitude
                    );

                    // Below the noise floor the anchor is kept, so slow movement
                    // accumulates into one accepted segment instead of being discarded
                    // a metre at a time.
                    if (d >= MIN_SEGMENT_M) {
                        const seconds = (now - lastFixAt) / 1000;
                        const plausible = !(lastFixAt && seconds > 0.5 && d / seconds > MAX_SPEED_MPS);
                        if (plausible) {
                            this.totalDistance += d;
                            this.lastPosition = { latitude, longitude };
                            lastFixAt = now;
                        }
                    }
                } else {
                    this.lastPosition = { latitude, longitude };
                    lastFixAt = now;
                }

                onData(latitude, longitude, this.totalDistance);
            },
            (error) => {
                // Was console.log and nothing else, so a refused permission or a
                // switched-off location toggle produced a habit stuck at zero with no
                // account of itself anywhere the user could see.
                console.log(error);
                const code = (error as any)?.code;
                this.emit({
                    gpsNote:
                        code === 1 ? 'LOCATION NOT ALLOWED'
                            : code === 5 ? 'LOCATION SWITCHED OFF'
                                : code === 3 ? 'WAITING FOR A FIX'
                                    : 'NO LOCATION SOURCE',
                });
            },
            {
                enableHighAccuracy: true,
                // Filtering happens above, in one place: the platform's own
                // displacement filter measures from the last fix it delivered, not
                // from our anchor, so it swallows movement between a rejected fix and
                // the next good one.
                distanceFilter: 0,
                interval: 2000,
                fastestInterval: 1000
            }
        );
    }

    private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
        const R = 6371e3; // meters
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return R * c; // meters
    }

    stopLocationTracking() {
        if (Geolocation) Geolocation.stopObserving();
        // Nothing is listening because nothing asked it to, which is not a fault.
        // A stale "waiting for a fix" would explain a paused habit as a broken one.
        this.emit({ gpsNote: '' });
    }

    // Sound Level (Real)
    startNoiseSensor(onData: (db: number) => void) {
        if (!RNSoundLevel) {
            console.warn("SoundLevel module not found");
            return null;
        }
        try {
            if (this.isNoiseSensorRunning) return;
            RNSoundLevel.start();
            this.isNoiseSensorRunning = true;
            this.noisePeakDb = 0;
            this.noisePeakSeen = false;
            RNSoundLevel.onNewFrame = (data: any) => {
                const level = Math.max(0, data.value + 100);
                const db = Math.floor(level);
                // Peak, not average, and held until the accrual interval consumes it:
                // frames arrive several times a second, and one quiet frame does not
                // make the second quiet. Averaging would let a short bark hide inside
                // an otherwise still second and still bank it as silence.
                if (!this.noisePeakSeen || db > this.noisePeakDb) {
                    this.noisePeakDb = db;
                    this.noisePeakSeen = true;
                }
                onData(db);
            };
        } catch (e) {
            console.warn("Failed to start noise sensor", e);
        }
    }

    /**
     * Release the microphone and say so.
     *
     * Both callers are "stop everything" paths, so the mic-off state is emitted in
     * native mode too, where nothing of ours was listening. That is not redundant: the
     * foreground service publishes noiseListening=false from its own stopNoise, but a
     * service that is being torn down may not get that publish out before it dies —
     * and the habit screen would then sit showing an advancing run of quiet next to a
     * microphone that is no longer open.
     */
    stopNoiseSensor() {
        if (RNSoundLevel && this.isNoiseSensorRunning) {
            try {
                RNSoundLevel.stop();
            } catch (e) {
                console.warn("Error stopping sound level", e);
            }
        }
        this.isNoiseSensorRunning = false;
        this.noisePeakSeen = false;
        this.noisePeakDb = 0;
        // Ending the run is the user's own choice, so it is not charged as a breach —
        // see startNoiseAccrual.
        this.emit({
            noiseListening: false,
            noiseHasReading: false,
            noiseStreakSeconds: 0,
        });
    }

    /**
     * Accelerometer step estimation.
     *
     * Note there is no `Pedometer` native module on Android: react-native-pedometer
     * ships iOS sources only and does not appear in the generated PackageList, so
     * the old `NativeModules.Pedometer` guard was always false and this heuristic
     * was the only thing ever running. Real step counting now comes from
     * SensorForegroundService via TYPE_STEP_COUNTER; this remains the fallback.
     */
    startPedometer(initialSteps: number, onData: (steps: number, activity: number) => void) {
        this.stepCount = initialSteps;
        this.lastStepTime = 0;

        let wasAboveThreshold = false;

        if (!this.accelerometerSubscription) {
            this.accelerometerSubscription = accelerometer
                .pipe(
                    map(({ x, y, z }: any) => Math.sqrt(x * x + y * y + z * z))
                )
                .subscribe((acceleration: any) => {
                    const activity = Math.min(100, Math.max(0, (acceleration - 9.8) * 10));

                    const currentTime = Date.now();
                    const isAboveThreshold = acceleration > this.threshold;

                    // Count step only on rising edge AND if cooldown has passed
                    if (isAboveThreshold && !wasAboveThreshold) {
                        if (currentTime - this.lastStepTime > this.stepCooldown) {
                            this.stepCount++;
                            this.lastStepTime = currentTime;
                        }
                    }
                    wasAboveThreshold = isAboveThreshold;

                    onData(this.stepCount, activity);
                });
        }
    }

    stopPedometer() {
        if (this.accelerometerSubscription) {
            this.accelerometerSubscription.unsubscribe();
            this.accelerometerSubscription = null;
        }
    }
}

export const sensorService = new SensorService();
