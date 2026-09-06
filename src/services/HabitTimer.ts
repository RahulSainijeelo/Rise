import { NativeModules } from 'react-native';

/**
 * HabitTimer (JS half)
 * ====================
 * The app's view onto a TIMER habit's countdown. The state machine is native
 * (android/app/src/main/java/com/rise/HabitTimer.kt) and is shared with the wrapper
 * widget, exactly as the focus timer's is.
 *
 * Nothing here owns time. Every reading is derived from `endsAt`, a wall-clock deadline
 * in native SharedPreferences, so a screen is correct the instant it mounts without
 * having been running, and a run keeps counting with the app closed.
 *
 * The screen this replaces kept `timeLeft` in React state and decremented it on a
 * `setInterval`. That clock stopped the moment the screen unmounted and banked nothing
 * until it reached zero, so leaving mid-session threw the whole session away. Here the
 * seconds are credited as they are earned, by native, through the pending-op queue.
 *
 * Keep the shapes below in step with WidgetContract.kt's HT_* names — the transport is
 * an untyped JSON string in an untyped preferences bag.
 */

const bridge: any = NativeModules.WidgetBridge;

export type HabitTimerMode = 'idle' | 'running' | 'paused';

/** `toggle` is the widget's one button: start, pause or resume, whichever applies. */
export type HabitTimerOp = 'start' | 'pause' | 'resume' | 'reset' | 'toggle';

export interface HabitTimerState {
    habitId: string;
    mode: HabitTimerMode;
    /** The full length of the current (or next) run, in millis. */
    durationMs: number;
    /** Wall-clock millis the run ends at. Authoritative while running. */
    endsAt: number;
    /** Millis left. Authoritative only while paused. */
    remainingMs: number;
    startedAt: number;
    /** Millis of this run already banked into the habit. Native's high-water mark. */
    creditedMs: number;
    /** The habit-day the run belongs to, YYYY-MM-DD. */
    date: string;
}

export const idleHabitTimer = (
    habitId: string,
    goalSeconds = 0,
): HabitTimerState => ({
    habitId,
    mode: 'idle',
    durationMs: Math.max(0, Math.round(goalSeconds * 1000)),
    endsAt: 0,
    remainingMs: Math.max(0, Math.round(goalSeconds * 1000)),
    startedAt: 0,
    creditedMs: 0,
    date: '',
});

const num = (v: any, fallback = 0): number =>
    typeof v === 'number' && isFinite(v) ? v : fallback;

function parseState(habitId: string, raw: any, goalSeconds: number): HabitTimerState {
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!o || typeof o !== 'object') return idleHabitTimer(habitId, goalSeconds);
        const mode: HabitTimerMode =
            o.mode === 'running' || o.mode === 'paused' ? o.mode : 'idle';
        return {
            habitId,
            mode,
            durationMs: num(o.durationMs),
            endsAt: num(o.endsAt),
            remainingMs: num(o.remainingMs),
            startedAt: num(o.startedAt),
            creditedMs: num(o.creditedMs),
            date: typeof o.date === 'string' ? o.date : '',
        };
    } catch {
        return idleHabitTimer(habitId, goalSeconds);
    }
}

// ---------------------------------------------------------------------------
// The local stand-in
// ---------------------------------------------------------------------------
//
// Only reached when the native module is absent altogether. It keeps the screen
// working and the shapes identical, and it deliberately does not try to be durable:
// without native there is no widget, no alarm and no queue to be consistent with.

const localStates: Record<string, HabitTimerState> = {};

const hasNative = (method: string): boolean =>
    !!bridge && typeof bridge[method] === 'function';

function localRead(habitId: string, goalSeconds: number): HabitTimerState {
    const goalMs = Math.max(0, Math.round(goalSeconds * 1000));
    let s = localStates[habitId] ?? idleHabitTimer(habitId, goalSeconds);
    const now = Date.now();
    if (s.mode === 'running' && now >= s.endsAt) {
        s = { ...s, mode: 'idle', endsAt: 0, remainingMs: s.durationMs, creditedMs: 0 };
    }
    if (s.mode === 'idle' && goalMs > 0 && s.durationMs !== goalMs) {
        s = { ...s, durationMs: goalMs, remainingMs: goalMs };
    }
    localStates[habitId] = s;
    return s;
}

function localOp(habitId: string, op: HabitTimerOp, goalSeconds: number): HabitTimerState {
    const now = Date.now();
    const s = localRead(habitId, goalSeconds);
    let next = s;
    switch (op === 'toggle' ? (s.mode === 'running' ? 'pause' : s.mode === 'paused' ? 'resume' : 'start') : op) {
        case 'start': {
            const duration = s.durationMs > 0 ? s.durationMs : Math.round(goalSeconds * 1000);
            if (s.mode !== 'idle' || duration <= 0) break;
            next = {
                ...s,
                mode: 'running',
                durationMs: duration,
                endsAt: now + duration,
                remainingMs: duration,
                startedAt: now,
                creditedMs: 0,
            };
            break;
        }
        case 'pause':
            if (s.mode !== 'running') break;
            next = { ...s, mode: 'paused', remainingMs: Math.max(0, s.endsAt - now) };
            break;
        case 'resume':
            if (s.mode !== 'paused') break;
            next = { ...s, mode: 'running', endsAt: now + Math.max(0, s.remainingMs) };
            break;
        case 'reset':
            if (s.mode === 'idle') break;
            next = {
                ...s,
                mode: 'idle',
                endsAt: 0,
                remainingMs: s.durationMs,
                startedAt: 0,
                creditedMs: 0,
            };
            break;
    }
    localStates[habitId] = next;
    return next;
}

// ---------------------------------------------------------------------------
// The API the screen uses
// ---------------------------------------------------------------------------

export async function getHabitTimer(
    habitId: string,
    goalSeconds: number,
): Promise<HabitTimerState> {
    if (!hasNative('getHabitTimer')) return localRead(habitId, goalSeconds);
    try {
        return parseState(
            habitId,
            await bridge.getHabitTimer(habitId, goalSeconds),
            goalSeconds,
        );
    } catch {
        return idleHabitTimer(habitId, goalSeconds);
    }
}

export async function habitTimerOp(
    habitId: string,
    op: HabitTimerOp,
    goalSeconds: number,
): Promise<HabitTimerState> {
    if (!hasNative('habitTimerOp')) return localOp(habitId, op, goalSeconds);
    try {
        return parseState(
            habitId,
            await bridge.habitTimerOp(habitId, op, goalSeconds),
            goalSeconds,
        );
    } catch {
        return getHabitTimer(habitId, goalSeconds);
    }
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Millis left, measured against the clock while running. */
export function habitRemainingMs(
    state: HabitTimerState,
    now: number = Date.now(),
): number {
    if (state.mode === 'running') return Math.max(0, state.endsAt - now);
    if (state.mode === 'paused') return Math.max(0, state.remainingMs);
    return Math.max(0, state.durationMs);
}

/** 0..1 of the run already spent. Drives the ring fill. */
export function habitElapsedFraction(
    state: HabitTimerState,
    now: number = Date.now(),
): number {
    if (state.durationMs <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - habitRemainingMs(state, now) / state.durationMs));
}

/**
 * Seconds this run has earned but not yet handed over.
 *
 * Native credits at settle points only, so between them the store is behind by this
 * much. Adding it to the stored progress is what stops today's total from sitting
 * still for the whole of a twenty-five minute session.
 */
export function habitPendingSeconds(
    state: HabitTimerState,
    now: number = Date.now(),
): number {
    if (state.durationMs <= 0) return 0;
    const elapsed = state.durationMs - habitRemainingMs(state, now);
    return Math.max(0, Math.floor((elapsed - state.creditedMs) / 1000));
}
