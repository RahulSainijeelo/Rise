import { accelerometer, SensorTypes, setUpdateIntervalForType } from 'react-native-sensors';
import { map } from 'rxjs/operators';
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import RNSoundLevel from 'react-native-sound-level';
import type { PendingOp, SensorConfig, SensorSlot } from './WidgetContract';
import { SUNSET_DEFAULTS } from './WidgetContract';

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

setUpdateIntervalForType(SensorTypes.accelerometer, 100);

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
    distanceMeters: number;
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
}

const EMPTY_LIVE: LiveSensorData = {
    steps: 0,
    activity: 0,
    noise: 0,
    noiseSeconds: 0,
    distanceMeters: 0,
    location: null,
    sunsetMinutes: 0,
    sunsetUnlocks: 0,
    sunsetSource: 'none',
    sunsetDate: '',
    sunsetWindowOpen: false,
    live: false,
};

/**
 * Derive the config the native service needs from the current habit list.
 * Exported so WidgetService and the app lifecycle can push it without
 * duplicating the field mapping.
 */
export const buildSensorConfig = (habits: any[]): SensorConfig => {
    const config: SensorConfig = {};
    const bySlot = (slot: SensorSlot) => habits.find((h: any) => h.sensorType === slot);

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
            thresholdDb: noise.noiseThresholdDb ?? 45,
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
        this.live = { ...this.live, ...patch };
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
        const habits = state.habits || [];
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
            const habits = this.getStore?.().habits || [];
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
            distanceMeters: data.distanceMeters ?? this.live.distanceMeters,
            sunsetMinutes: data.sunsetMinutes ?? this.live.sunsetMinutes,
            sunsetUnlocks: data.sunsetUnlocks ?? this.live.sunsetUnlocks,
            sunsetSource: data.sunsetSource ?? this.live.sunsetSource,
            sunsetDate: data.sunsetDate ?? this.live.sunsetDate,
            sunsetWindowOpen: data.sunsetWindowOpen ?? this.live.sunsetWindowOpen,
            live: true,
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
        const habits: any[] = state.habits || [];
        const today = localDate();
        const d = this.live;

        habits.forEach((h) => {
            if (!h.isSensorBased) return;

            // The Digital Sunset window straddles midnight, so its readings belong
            // to the night that began at the cutoff, not to whatever the calendar
            // says right now.
            const date = h.sensorType === 'screen' && d.sunsetDate ? d.sunsetDate : today;

            // Never overwrite a day the user has already closed out, except for
            // 'atMost' habits where the count must keep rising until the window
            // ends, otherwise a breach after completion would go unrecorded.
            const isAtMost = (h.goalDirection || 'atLeast') === 'atMost';
            if (h.completedDates?.includes(date) && !isAtMost) return;

            if (h.sensorType === 'pedometer' || h.sensorType === 'movement') {
                const cur = h.numericProgress?.[date] || 0;
                if (d.steps > cur) state.updateSensorProgress(h.id, date, d.steps);
            } else if (h.sensorType === 'gps') {
                const km = d.distanceMeters / 1000;
                const cur = h.numericProgress?.[date] || 0;
                if (km > cur) state.updateSensorProgress(h.id, date, km);
            } else if (h.sensorType === 'screen') {
                const cur = h.numericProgress?.[date] || 0;
                const used = d.sunsetSource === 'usagestats' ? d.sunsetMinutes : d.sunsetUnlocks;
                if (used > cur) state.updateSensorProgress(h.id, date, used);
            } else if (h.sensorType === 'noise' && d.live) {
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
        const has = (slot: string) => habits.some((h: any) => h.sensorType === slot);

        if (has('pedometer') || has('movement')) {
            const seed = habits.find((h: any) => h.sensorType === 'pedometer' || h.sensorType === 'movement');
            this.startPedometer(seed?.numericProgress?.[today] || 0, (steps, activity) => {
                this.emit({ steps, activity });
                this.commitToStore();
            });
        }

        if (has('gps')) {
            const seed = habits.find((h: any) => h.sensorType === 'gps');
            const initialMeters = (seed?.numericProgress?.[today] || 0) * 1000;
            this.startLocationTracking(initialMeters, (lat, lng, distMeters) => {
                this.emit({ location: { latitude: lat, longitude: lng }, distanceMeters: distMeters });
                this.commitToStore();
            });
        }

        // Noise was never started by global tracking at all, so Deep Silence only
        // ever accrued while its detail screen happened to be open.
        const noiseHabit = habits.find((h: any) => h.sensorType === 'noise');
        if (noiseHabit) {
            this.startNoiseSensor((db) => this.emit({ noise: db }));
            this.startNoiseAccrual(noiseHabit.id, noiseHabit.noiseThresholdDb ?? 45);
        }
    }

    /**
     * Accrue one second of silence per wall-clock second spent under the
     * threshold. Owning the clock in one interval avoids the previous bug where
     * a new interval was created on every dB reading.
     */
    private startNoiseAccrual(habitId: string, thresholdDb: number) {
        this.stopNoiseAccrual();
        this.noiseAccrualTimer = setInterval(() => {
            const getStore = this.getStore;
            if (!getStore) return;
            const db = this.live.noise;
            // db === 0 means "no reading yet", not "perfect silence".
            if (db <= 0 || db >= thresholdDb) return;

            const state = getStore();
            const habit = (state.habits || []).find((h: any) => h.id === habitId);
            if (!habit) return;
            const today = localDate();
            if (habit.completedDates?.includes(today)) return;

            const cur = habit.timerProgress?.[today] || 0;
            state.updateSensorProgress(habitId, today, cur + 1);
            this.emit({ noiseSeconds: cur + 1 });
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

    // GPS Tracking - STRICT mode to prevent table drift
    startLocationTracking(initialDistance: number, onData: (lat: number, lng: number, distance: number) => void) {
        if (!Geolocation) {
            console.warn("Geolocation module not found");
            return;
        }
        this.totalDistance = initialDistance;
        Geolocation.watchPosition(
            (position) => {
                const { latitude, longitude, accuracy, speed } = position.coords;

                // STRICT: Only accept high accuracy GPS readings (< 20m)
                if (accuracy > 20) return;

                // STRICT: Ignore if speed is essentially zero (stationary)
                if (speed !== null && speed < 0.3) return; // less than 1 km/h

                if (this.lastPosition) {
                    const d = this.calculateDistance(
                        this.lastPosition.latitude,
                        this.lastPosition.longitude,
                        latitude,
                        longitude
                    );

                    // STRICT: Only add if movement is greater than 5 meters
                    if (d > 5) {
                        this.totalDistance += d;
                        this.lastPosition = { latitude, longitude };
                    }
                } else {
                    this.lastPosition = { latitude, longitude };
                }

                onData(latitude, longitude, this.totalDistance);
            },
            (error) => console.log(error),
            {
                enableHighAccuracy: true,
                distanceFilter: 5, // Only trigger after 5m movement
                interval: 5000,
                fastestInterval: 3000
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
            RNSoundLevel.onNewFrame = (data: any) => {
                const level = Math.max(0, data.value + 100);
                onData(Math.floor(level));
            };
        } catch (e) {
            console.warn("Failed to start noise sensor", e);
        }
    }

    stopNoiseSensor() {
        if (RNSoundLevel && this.isNoiseSensorRunning) {
            try {
                RNSoundLevel.stop();
                this.isNoiseSensorRunning = false;
            } catch (e) {
                console.warn("Error stopping sound level", e);
            }
        }
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
