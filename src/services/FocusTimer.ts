import { NativeModules } from 'react-native';

/**
 * FocusTimer (JS half)
 * ====================
 * The app's view onto the one focus timer. The state machine itself is native
 * (android/app/src/main/java/com/rise/FocusTimer.kt) and is shared with the home-screen
 * widget, which is the whole point: a session started on the widget has to be pausable
 * in the app, a session started in the app has to keep counting with the app closed,
 * and both have to write to one history.
 *
 * So nothing here owns time. Every reading is derived from `endsAt`, which is a wall
 * clock deadline in native SharedPreferences, so the screen is correct the instant it
 * mounts without having to have been running.
 *
 * Keep the shapes below in step with WidgetContract.kt's FOCUS_* field names — the
 * transport is an untyped JSON string in an untyped preferences bag.
 */

const bridge: any = NativeModules.WidgetBridge;

export type FocusMode = 'idle' | 'running' | 'paused';
export type FocusField = 'h' | 'm';
export type FocusSource = 'widget' | 'app';

export type FocusOp =
    | 'selectH'
    | 'selectM'
    | 'up'
    | 'down'
    | 'start'
    | 'pause'
    | 'resume'
    | 'reset';

export interface FocusState {
    mode: FocusMode;
    /** The dial, kept between runs so the last duration is one tap away. */
    setupH: number;
    setupM: number;
    /** Which field the widget's steppers act on. Mirrored here so both agree. */
    field: FocusField;
    durationMs: number;
    /** Wall clock millis the run ends at. Authoritative while running. */
    endsAt: number;
    /** Millis left. Authoritative only while paused. */
    remainingMs: number;
    startedAt: number;
    source: FocusSource;
}

export interface FocusRun {
    id: string;
    startedAt: number;
    endedAt: number;
    plannedMs: number;
    actualMs: number;
    completed: boolean;
    source: FocusSource;
}

export interface FocusTheme {
    id: string;
    /** Ring gradient start / end and the unfilled track, all #RRGGBB. */
    from: string;
    to: string;
    track: string;
}

/**
 * The palettes offered in the Focus tab. Chosen so each one still reads as a countdown
 * at a glance on a black background — two hues close enough to look like one moving
 * colour, and a track dark enough to disappear until you look for it.
 */
export const FOCUS_THEMES: FocusTheme[] = [
    { id: 'ember', from: '#D71921', to: '#FF9A3C', track: '#241416' },
    { id: 'aurora', from: '#00E5A0', to: '#22D3EE', track: '#0C2222' },
    { id: 'nebula', from: '#8B5CF6', to: '#EC4899', track: '#1B1426' },
    { id: 'tide', from: '#2563EB', to: '#38BDF8', track: '#101A2C' },
    { id: 'mono', from: '#FFFFFF', to: '#8A8A8A', track: '#1C1C1C' },
];

export const DEFAULT_FOCUS_THEME: FocusTheme = FOCUS_THEMES[0];

export const MAX_FOCUS_HOURS = 12;

/** Quick durations, so the common case is one tap rather than twenty-five. */
export const FOCUS_PRESETS: { label: string; h: number; m: number }[] = [
    { label: '15M', h: 0, m: 15 },
    { label: '25M', h: 0, m: 25 },
    { label: '45M', h: 0, m: 45 },
    { label: '1H', h: 1, m: 0 },
    { label: '2H', h: 2, m: 0 },
];

export const IDLE_FOCUS_STATE: FocusState = {
    mode: 'idle',
    setupH: 0,
    setupM: 25,
    field: 'm',
    durationMs: 0,
    endsAt: 0,
    remainingMs: 0,
    startedAt: 0,
    source: 'app',
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const num = (v: any, fallback = 0): number =>
    typeof v === 'number' && isFinite(v) ? v : fallback;

function parseState(raw: any): FocusState {
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!o || typeof o !== 'object') return { ...IDLE_FOCUS_STATE };
        const mode: FocusMode =
            o.mode === 'running' || o.mode === 'paused' ? o.mode : 'idle';
        return {
            mode,
            setupH: Math.min(MAX_FOCUS_HOURS, Math.max(0, Math.round(num(o.setupH, 0)))),
            setupM: Math.min(59, Math.max(0, Math.round(num(o.setupM, 25)))),
            field: o.field === 'h' ? 'h' : 'm',
            durationMs: num(o.durationMs),
            endsAt: num(o.endsAt),
            remainingMs: num(o.remainingMs),
            startedAt: num(o.startedAt),
            source: o.source === 'app' ? 'app' : 'widget',
        };
    } catch {
        return { ...IDLE_FOCUS_STATE };
    }
}

function parseHistory(raw: any): FocusRun[] {
    try {
        const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(arr)) return [];
        return arr
            .filter(r => r && typeof r === 'object')
            .map((r: any) => ({
                id: String(r.id ?? `${r.startedAt}-${r.endedAt}`),
                startedAt: num(r.startedAt),
                endedAt: num(r.endedAt),
                plannedMs: num(r.plannedMs),
                actualMs: num(r.actualMs),
                completed: r.completed === true,
                source: r.source === 'app' ? 'app' : 'widget',
            }));
    } catch {
        return [];
    }
}

function parseTheme(raw: any): FocusTheme {
    try {
        const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!o || typeof o !== 'object') return DEFAULT_FOCUS_THEME;
        const known = FOCUS_THEMES.find(t => t.id === o.id);
        if (known) return known;
        return {
            id: String(o.id ?? 'custom'),
            from: typeof o.from === 'string' ? o.from : DEFAULT_FOCUS_THEME.from,
            to: typeof o.to === 'string' ? o.to : DEFAULT_FOCUS_THEME.to,
            track: typeof o.track === 'string' ? o.track : DEFAULT_FOCUS_THEME.track,
        };
    } catch {
        return DEFAULT_FOCUS_THEME;
    }
}

// ---------------------------------------------------------------------------
// The local stand-in
// ---------------------------------------------------------------------------
//
// Only used when the native module is not there at all. It keeps the screen working
// and the shapes identical, and it deliberately does not try to be durable: without
// native there is no widget, no service and no notification to be consistent with.

let localState: FocusState = { ...IDLE_FOCUS_STATE };
let localHistory: FocusRun[] = [];
let localTheme: FocusTheme = DEFAULT_FOCUS_THEME;

const hasNative = (method: string): boolean =>
    !!bridge && typeof bridge[method] === 'function';

function localSettle(now: number): FocusState {
    if (localState.mode === 'running' && now >= localState.endsAt) {
        localHistory = [
            {
                id: `${localState.startedAt}-${now}`,
                startedAt: localState.startedAt,
                endedAt: now,
                plannedMs: localState.durationMs,
                actualMs: localState.durationMs,
                completed: true,
                source: localState.source,
            },
            ...localHistory,
        ].slice(0, 100);
        localState = {
            ...IDLE_FOCUS_STATE,
            setupH: localState.setupH,
            setupM: localState.setupM,
            field: localState.field,
        };
    }
    return localState;
}

function localOp(op: FocusOp): FocusState {
    const now = Date.now();
    localSettle(now);
    const s = localState;
    switch (op) {
        case 'selectH':
            localState = { ...s, field: 'h' };
            break;
        case 'selectM':
            localState = { ...s, field: 'm' };
            break;
        case 'up':
        case 'down': {
            if (s.mode !== 'idle') break;
            const d = op === 'up' ? 1 : -1;
            if (s.field === 'h') {
                localState = {
                    ...s,
                    setupH: Math.min(MAX_FOCUS_HOURS, Math.max(0, s.setupH + d)),
                };
            } else {
                const m = s.setupM + d;
                localState = { ...s, setupM: m < 0 ? 59 : m > 59 ? 0 : m };
            }
            break;
        }
        case 'start': {
            const duration = (s.setupH * 3600 + s.setupM * 60) * 1000;
            if (s.mode !== 'idle' || duration <= 0) break;
            localState = {
                ...s,
                mode: 'running',
                durationMs: duration,
                endsAt: now + duration,
                remainingMs: duration,
                startedAt: now,
                source: 'app',
            };
            break;
        }
        case 'pause':
            if (s.mode !== 'running') break;
            localState = {
                ...s,
                mode: 'paused',
                remainingMs: Math.max(0, s.endsAt - now),
            };
            break;
        case 'resume':
            if (s.mode !== 'paused') break;
            localState = {
                ...s,
                mode: 'running',
                endsAt: now + Math.max(0, s.remainingMs),
            };
            break;
        case 'reset': {
            if (s.mode === 'idle') break;
            const elapsed = s.durationMs - remainingMs(s, now);
            if (elapsed >= 60000) {
                localHistory = [
                    {
                        id: `${s.startedAt}-${now}`,
                        startedAt: s.startedAt,
                        endedAt: now,
                        plannedMs: s.durationMs,
                        actualMs: elapsed,
                        completed: false,
                        source: s.source,
                    },
                    ...localHistory,
                ].slice(0, 100);
            }
            localState = {
                ...IDLE_FOCUS_STATE,
                setupH: s.setupH,
                setupM: s.setupM,
                field: s.field,
            };
            break;
        }
    }
    return localState;
}

// ---------------------------------------------------------------------------
// The API the screen uses
// ---------------------------------------------------------------------------

export async function getFocusState(): Promise<FocusState> {
    if (!hasNative('getFocusState')) return localSettle(Date.now());
    try {
        return parseState(await bridge.getFocusState());
    } catch {
        return { ...IDLE_FOCUS_STATE };
    }
}

export async function focusOp(op: FocusOp): Promise<FocusState> {
    if (!hasNative('focusOp')) return localOp(op);
    try {
        return parseState(await bridge.focusOp(op));
    } catch {
        return getFocusState();
    }
}

/** Dial in a duration and start it in one step. */
export async function startFocus(hours: number, minutes: number): Promise<FocusState> {
    if (!hasNative('focusStart')) {
        localState = { ...localState, setupH: hours, setupM: minutes };
        return localOp('start');
    }
    try {
        return parseState(await bridge.focusStart(hours, minutes));
    } catch {
        return getFocusState();
    }
}

/** Remember the dial without starting, so the widget shows the same numbers. */
export async function setFocusDial(hours: number, minutes: number): Promise<FocusState> {
    if (!hasNative('setFocusDial')) {
        if (localState.mode === 'idle') {
            localState = { ...localState, setupH: hours, setupM: minutes };
        }
        return localState;
    }
    try {
        return parseState(await bridge.setFocusDial(hours, minutes));
    } catch {
        return getFocusState();
    }
}

export async function getFocusHistory(): Promise<FocusRun[]> {
    if (!hasNative('getFocusHistory')) return localHistory;
    try {
        return parseHistory(await bridge.getFocusHistory());
    } catch {
        return [];
    }
}

export async function clearFocusHistory(): Promise<void> {
    if (!hasNative('clearFocusHistory')) {
        localHistory = [];
        return;
    }
    try {
        await bridge.clearFocusHistory();
    } catch {
        // Nothing to recover: the list simply stays as it was.
    }
}

export async function getFocusTheme(): Promise<FocusTheme> {
    if (!hasNative('getFocusTheme')) return localTheme;
    try {
        return parseTheme(await bridge.getFocusTheme());
    } catch {
        return DEFAULT_FOCUS_THEME;
    }
}

export async function setFocusTheme(theme: FocusTheme): Promise<void> {
    localTheme = theme;
    if (!hasNative('setFocusTheme')) return;
    try {
        await bridge.setFocusTheme(JSON.stringify(theme));
    } catch {
        // The app keeps the choice either way; only the widget misses out.
    }
}

// ---------------------------------------------------------------------------
// Derivation and formatting
// ---------------------------------------------------------------------------

/** Millis left, measured against the clock while running. */
export function remainingMs(state: FocusState, now: number = Date.now()): number {
    if (state.mode === 'running') return Math.max(0, state.endsAt - now);
    if (state.mode === 'paused') return Math.max(0, state.remainingMs);
    return (state.setupH * 3600 + state.setupM * 60) * 1000;
}

/** 0..1 of the run still to go. Drives the ring. */
export function fractionLeft(state: FocusState, now: number = Date.now()): number {
    const total =
        state.durationMs > 0
            ? state.durationMs
            : (state.setupH * 3600 + state.setupM * 60) * 1000;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, remainingMs(state, now) / total));
}

export function pad2(value: number): string {
    const v = Math.max(0, Math.floor(value));
    return v < 10 ? `0${v}` : `${v}`;
}

/**
 * The countdown reading. Two places for every field, always: a clock that changes
 * width as it counts is a clock that jitters.
 */
export function clockText(ms: number): string {
    const total = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/** "1h 25m" / "25m" / "40s", for totals and the history list. */
export function durationText(ms: number): string {
    const total = Math.floor(Math.max(0, ms) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    if (m > 0) return `${m}m`;
    return `${total}s`;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '');
    const full =
        clean.length === 3
            ? clean
                  .split('')
                  .map(c => c + c)
                  .join('')
            : clean;
    const int = parseInt(full.slice(0, 6), 16);
    if (isNaN(int)) return { r: 255, g: 255, b: 255 };
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/**
 * Rotate a colour's hue, keeping how bright and how saturated it is.
 *
 * This is what makes the ring feel alive without leaving the palette the user chose:
 * the two gradient stops are pushed a few degrees apart and back on a slow cycle, so
 * the colour moves but never becomes a different colour.
 */
export function shiftHue(hex: string, degrees: number): string {
    const { r, g, b } = hexToRgb(hex);
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        else if (max === gn) h = ((bn - rn) / d + 2) / 6;
        else h = ((rn - gn) / d + 4) / 6;
    }
    h = (((h * 360 + degrees) % 360) + 360) % 360 / 360;

    if (s === 0) {
        const v = Math.round(l * 255);
        return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number): number => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };
    const out = [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)]
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0'))
        .join('');
    return `#${out}`;
}

/**
 * A foreground that can be read on top of `hex`.
 *
 * The filled buttons used to hard-code white on the ring colour. Four of the five ring
 * themes are dark enough for that to work; `mono` is #FFFFFF, so its start button was
 * white text and a white icon on a white fill — a blank white button, exactly as
 * reported. `aurora` (#00E5A0) was close behind.
 *
 * Relative luminance rather than a per-theme override, so a ring colour added later
 * cannot reintroduce the bug.
 */
export function onTint(hex: string): string {
    const { r, g, b } = hexToRgb(hex);
    const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const luminance =
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    // 0.35 rather than the midpoint: white-on-colour stays readable further down the
    // scale than black-on-colour does, and the palette is mostly saturated mid-tones.
    return luminance > 0.35 ? '#000000' : '#FFFFFF';
}
