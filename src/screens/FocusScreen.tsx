import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Pressable,
    ScrollView,
    Modal,
    AppState,
    Alert,
    StatusBar,
    useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import {
    ChevronUp,
    ChevronDown,
    Play,
    Pause,
    RotateCcw,
    Maximize2,
    X,
    Trash2,
} from 'lucide-react-native';
import dayjs from 'dayjs';

import { useTheme } from '../theme';
import { getFontFamily } from '../utils/Nothing.ui.utils';
import {
    FocusRun,
    FocusState,
    FocusTheme,
    FOCUS_PRESETS,
    FOCUS_THEMES,
    DEFAULT_FOCUS_THEME,
    IDLE_FOCUS_STATE,
    MAX_FOCUS_HOURS,
    clearFocusHistory,
    clockText,
    durationText,
    focusOp,
    fractionLeft,
    getFocusHistory,
    getFocusState,
    getFocusTheme,
    onTint,
    pad2,
    remainingMs,
    setFocusTheme,
    shiftHue,
    startFocus,
} from '../services/FocusTimer';

/**
 * Focus — the fourth tab.
 *
 * Two faces, the same two the widget has, on the same native timer: a dial while idle
 * and a countdown while running. Nothing here keeps time. `now` is sampled from the
 * clock and every reading is derived from the deadline native holds, which is why the
 * screen is already correct on its first frame after being away for twenty minutes.
 *
 * The ring animates by re-rendering SVG props rather than through Animated: the values
 * that move (the gradient's angle and a small hue drift) are functions of the clock, so
 * a dropped frame lands on the right colour instead of falling behind, and it sidesteps
 * the typing problems this codebase already has with animated SVG props.
 */

const DEG = Math.PI / 180;

/** Gradient sheen speed and the hue drift, both per second of the run. */
const SHEEN_DEG_PER_SEC = 22;
const HUE_SWING = 14;
const HUE_PERIOD_SEC = 11;

type SubTab = 'timer' | 'history';

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

interface RingProps {
    size: number;
    stroke: number;
    /** 0..1 of the run still to go. */
    fraction: number;
    theme: FocusTheme;
    /** Seconds into the run; drives the colour, so a still ring has a still colour. */
    elapsedSec: number;
    /** Distinct per instance: the tab's ring and zen's ring can be mounted together. */
    gradientId: string;
    dim?: boolean;
    showHead?: boolean;
}

const Ring: React.FC<RingProps> = ({
    size,
    stroke,
    fraction,
    theme,
    elapsedSec,
    gradientId,
    dim,
    showHead,
}) => {
    const r = (size - stroke) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * r;

    // Two stops pushed apart and back, so the colour moves without leaving the palette.
    const drift = HUE_SWING * Math.sin(elapsedSec / HUE_PERIOD_SEC);
    const from = shiftHue(theme.from, drift);
    const to = shiftHue(theme.to, -drift);

    // A rotating axis reads as a sheen travelling around the arc.
    const angle = (elapsedSec * SHEEN_DEG_PER_SEC) % 360;
    const ax = Math.cos(angle * DEG) / 2;
    const ay = Math.sin(angle * DEG) / 2;

    // Head of the arc, in the same clockwise-from-twelve frame the dash uses.
    const headAngle = (-90 + 360 * fraction) * DEG;
    const headX = cx + r * Math.cos(headAngle);
    const headY = cy + r * Math.sin(headAngle);

    return (
        <Svg width={size} height={size}>
            <Defs>
                <LinearGradient
                    id={gradientId}
                    x1={0.5 - ax}
                    y1={0.5 - ay}
                    x2={0.5 + ax}
                    y2={0.5 + ay}>
                    <Stop offset="0" stopColor={from} />
                    <Stop offset="0.5" stopColor={to} />
                    <Stop offset="1" stopColor={from} />
                </LinearGradient>
            </Defs>
            <Circle
                cx={cx}
                cy={cy}
                r={r}
                stroke={theme.track}
                strokeWidth={stroke}
                fill="none"
            />
            <Circle
                cx={cx}
                cy={cy}
                r={r}
                stroke={`url(#${gradientId})`}
                strokeWidth={stroke}
                strokeLinecap="round"
                fill="none"
                opacity={dim ? 0.4 : 1}
                strokeDasharray={`${circumference} ${circumference}`}
                strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, fraction)))}
                transform={`rotate(-90 ${cx} ${cy})`}
            />
            {showHead && fraction > 0.002 && fraction < 0.999 ? (
                <>
                    <Circle
                        cx={headX}
                        cy={headY}
                        r={stroke * 0.9}
                        fill={to}
                        opacity={0.25}
                    />
                    <Circle cx={headX} cy={headY} r={stroke * 0.34} fill="#FFFFFF" />
                </>
            ) : null}
        </Svg>
    );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const FocusScreen: React.FC = () => {
    const { theme } = useTheme();
    const { width, height } = useWindowDimensions();

    const [state, setState] = useState<FocusState>(IDLE_FOCUS_STATE);
    const [history, setHistory] = useState<FocusRun[]>([]);
    const [ring, setRing] = useState<FocusTheme>(DEFAULT_FOCUS_THEME);
    const [tab, setTab] = useState<SubTab>('timer');
    const [zen, setZen] = useState(false);
    const [now, setNow] = useState<number>(() => Date.now());

    // A completed run has to be claimed from native (which records it and rings), and
    // the tick that notices the clock ran out fires many times before the read returns.
    const settling = useRef(false);

    const refreshState = useCallback(async () => {
        const next = await getFocusState();
        setState(next);
        setNow(Date.now());
        return next;
    }, []);

    const refreshHistory = useCallback(async () => {
        setHistory(await getFocusHistory());
    }, []);

    const refreshAll = useCallback(async () => {
        await Promise.all([refreshState(), refreshHistory(), (async () => {
            setRing(await getFocusTheme());
        })()]);
    }, [refreshState, refreshHistory]);

    // Coming back to the tab, or to the app, is the moment the screen is most likely to
    // be wrong: the widget or the notification may have paused, reset or finished a run.
    useFocusEffect(
        useCallback(() => {
            refreshAll();
        }, [refreshAll]),
    );

    useEffect(() => {
        const sub = AppState.addEventListener('change', s => {
            if (s === 'active') refreshAll();
        });
        return () => sub.remove();
    }, [refreshAll]);

    // Only a running timer needs a heartbeat. Paused and idle are still pictures.
    useEffect(() => {
        if (state.mode !== 'running') return;
        const id = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(id);
    }, [state.mode]);

    const left = remainingMs(state, now);

    useEffect(() => {
        if (state.mode !== 'running' || left > 0 || settling.current) return;
        settling.current = true;
        (async () => {
            await refreshState();
            await refreshHistory();
            settling.current = false;
        })();
    }, [state.mode, left, refreshState, refreshHistory]);

    const run = useCallback(
        async (op: Parameters<typeof focusOp>[0]) => {
            setState(await focusOp(op));
            setNow(Date.now());
            if (op === 'reset') refreshHistory();
        },
        [refreshHistory],
    );

    const onStart = useCallback(async () => {
        if (state.setupH === 0 && state.setupM === 0) return;
        setState(await startFocus(state.setupH, state.setupM));
        setNow(Date.now());
    }, [state.setupH, state.setupM]);

    const onPreset = useCallback(
        async (h: number, m: number) => {
            setState(await startFocus(h, m));
            setNow(Date.now());
        },
        [],
    );

    const onTheme = useCallback(async (next: FocusTheme) => {
        setRing(next);
        await setFocusTheme(next);
    }, []);

    const onClear = useCallback(() => {
        if (history.length === 0) return;
        Alert.alert(
            'Clear focus history',
            `Delete all ${history.length} recorded sessions? This cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Clear',
                    style: 'destructive',
                    onPress: async () => {
                        await clearFocusHistory();
                        refreshHistory();
                    },
                },
            ],
        );
    }, [history.length, refreshHistory]);

    const idle = state.mode === 'idle';
    const running = state.mode === 'running';
    const paused = state.mode === 'paused';
    const fraction = fractionLeft(state, now);

    /** Seconds of the run behind us — frozen while paused, so the colour freezes too. */
    const elapsedSec = useMemo(() => {
        if (idle) return 0;
        const elapsed = paused
            ? state.durationMs - state.remainingMs
            : state.durationMs - left;
        return Math.max(0, elapsed) / 1000;
    }, [idle, paused, state.durationMs, state.remainingMs, left]);

    const totals = useMemo(() => {
        const startOfToday = dayjs().startOf('day').valueOf();
        const startOfWeek = dayjs().subtract(6, 'day').startOf('day').valueOf();
        let today = 0;
        let week = 0;
        let all = 0;
        let sessions = 0;
        for (const h of history) {
            all += h.actualMs;
            if (h.completed) sessions += 1;
            if (h.startedAt >= startOfWeek) week += h.actualMs;
            if (h.startedAt >= startOfToday) today += h.actualMs;
        }
        return { today, week, all, sessions };
    }, [history]);

    const grouped = useMemo(() => {
        const out: { day: string; label: string; runs: FocusRun[] }[] = [];
        for (const h of history) {
            const d = dayjs(h.startedAt);
            const key = d.format('YYYY-MM-DD');
            const last = out[out.length - 1];
            if (last && last.day === key) {
                last.runs.push(h);
            } else {
                const label = d.isSame(dayjs(), 'day')
                    ? 'TODAY'
                    : d.isSame(dayjs().subtract(1, 'day'), 'day')
                    ? 'YESTERDAY'
                    : d.format('ddd, D MMM').toUpperCase();
                out.push({ day: key, label, runs: [h] });
            }
        }
        return out;
    }, [history]);

    const dotFont = getFontFamily('dot');
    const mediumFont = getFontFamily('medium');
    const boldFont = getFontFamily('bold');

    const ringSize = Math.min(width - 72, 288);
    const zenRing = Math.min(width - 48, height - 260, 340);

    // -----------------------------------------------------------------------
    // Pieces
    // -----------------------------------------------------------------------

    const digits = (value: string, size: number, color: string) => (
        <Text
            style={{
                fontFamily: dotFont,
                fontSize: size,
                lineHeight: size * 1.1,
                color,
                letterSpacing: 2,
                fontWeight: '700',
            }}>
            {value}
        </Text>
    );

    /** The idle dial: two zero-padded fields, one of them selected. */
    const dial = (size: number) => {
        const field = (which: 'h' | 'm', value: number) => {
            const selected = state.field === which;
            return (
                <Pressable
                    onPress={() => run(which === 'h' ? 'selectH' : 'selectM')}
                    hitSlop={8}
                    style={[
                        styles.dialField,
                        {
                            backgroundColor: selected ? `${ring.from}26` : 'transparent',
                            borderColor: selected ? ring.from : 'transparent',
                        },
                    ]}>
                    {digits(
                        pad2(value),
                        size,
                        selected ? theme.colors.text : theme.colors.textSecondary,
                    )}
                </Pressable>
            );
        };
        return (
            <View style={styles.dialRow}>
                {field('h', state.setupH)}
                {digits(':', size, theme.colors.textSecondary)}
                {field('m', state.setupM)}
            </View>
        );
    };

    const stepper = () => {
        const atCeiling =
            state.field === 'h' ? state.setupH >= MAX_FOCUS_HOURS : false;
        const atFloor = state.field === 'h' ? state.setupH <= 0 : false;
        const btn = (
            dir: 'up' | 'down',
            disabled: boolean,
            Icon: typeof ChevronUp,
        ) => (
            <Pressable
                onPress={() => run(dir)}
                disabled={disabled}
                style={({ pressed }) => [
                    styles.stepBtn,
                    {
                        borderColor: theme.colors.border,
                        backgroundColor: pressed
                            ? theme.colors.surface2
                            : theme.colors.surface1,
                        opacity: disabled ? 0.3 : 1,
                    },
                ]}>
                <Icon size={22} color={theme.colors.text} />
            </Pressable>
        );
        return (
            <View style={styles.stepRow}>
                {btn('down', atFloor, ChevronDown)}
                <Text
                    style={{
                        fontFamily: mediumFont,
                        fontSize: 11,
                        letterSpacing: 2,
                        color: theme.colors.textSecondary,
                        minWidth: 132,
                        textAlign: 'center',
                    }}>
                    {state.field === 'h' ? 'HOURS' : 'MINUTES'}
                </Text>
                {btn('up', atCeiling, ChevronUp)}
            </View>
        );
    };

    /**
     * A round icon button.
     *
     * The run controls used to be icon-plus-label pills whose filled variant hard-coded
     * a white foreground over the ring colour, so the `mono` theme drew a white glyph
     * and white text on a white fill — the blank white button the user hit. The
     * foreground now comes from onTint(), and the label moved to accessibilityLabel so
     * the control is a glyph on screen and still a named button to a screen reader.
     */
    const iconBtn = (
        key: string,
        Icon: typeof Play,
        onPress: () => void,
        label: string,
        opts?: { filled?: boolean; size?: number },
    ) => {
        const size = opts?.size ?? 56;
        const tint = ring.from;
        return (
            <Pressable
                key={key}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={({ pressed }) => [
                    styles.iconBtn,
                    {
                        width: size,
                        height: size,
                        borderRadius: size / 2,
                        backgroundColor: opts?.filled
                            ? tint
                            : pressed
                            ? theme.colors.surface2
                            : theme.colors.surface1,
                        borderColor: opts?.filled ? tint : theme.colors.border,
                        opacity: pressed ? 0.85 : 1,
                    },
                ]}>
                <Icon
                    size={Math.round(size * 0.38)}
                    color={opts?.filled ? onTint(tint) : theme.colors.text}
                />
            </Pressable>
        );
    };

    const timerFace = () => (
        <View style={styles.faceWrap}>
            <View style={{ width: ringSize, height: ringSize }}>
                <Ring
                    size={ringSize}
                    stroke={14}
                    fraction={idle ? 1 : fraction}
                    theme={ring}
                    elapsedSec={elapsedSec}
                    gradientId="focusRingTab"
                    dim={paused}
                    showHead={!idle}
                />
                <View style={[styles.ringCenter, { width: ringSize, height: ringSize }]}>
                    {idle ? (
                        dial(46)
                    ) : (
                        <>
                            {digits(clockText(left), left >= 3600000 ? 40 : 50, theme.colors.text)}
                            <Text
                                style={{
                                    fontFamily: mediumFont,
                                    fontSize: 10,
                                    letterSpacing: 3,
                                    marginTop: 8,
                                    color: paused ? theme.colors.textSecondary : ring.from,
                                }}>
                                {paused ? 'PAUSED' : 'REMAINING'}
                            </Text>
                        </>
                    )}
                    {idle ? (
                        <Text
                            style={{
                                fontFamily: mediumFont,
                                fontSize: 10,
                                letterSpacing: 3,
                                marginTop: 6,
                                color: theme.colors.textSecondary,
                            }}>
                            {state.setupH === 0 && state.setupM === 0
                                ? 'SET A DURATION'
                                : durationText(
                                      (state.setupH * 3600 + state.setupM * 60) * 1000,
                                  ).toUpperCase()}
                        </Text>
                    ) : null}
                </View>
            </View>

            {idle ? (
                <>
                    {stepper()}
                    <View style={styles.presetRow}>
                        {FOCUS_PRESETS.map(p => (
                            <Pressable
                                key={p.label}
                                onPress={() => onPreset(p.h, p.m)}
                                style={({ pressed }) => [
                                    styles.preset,
                                    {
                                        borderColor: theme.colors.border,
                                        backgroundColor: pressed
                                            ? theme.colors.surface2
                                            : 'transparent',
                                    },
                                ]}>
                                <Text
                                    style={{
                                        fontFamily: mediumFont,
                                        fontSize: 11,
                                        letterSpacing: 1,
                                        color: theme.colors.textSecondary,
                                    }}>
                                    {p.label}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                    <View style={styles.controlRow}>
                        {iconBtn('start', Play, onStart, 'Start focus', {
                            filled: true,
                            size: 76,
                        })}
                    </View>
                </>
            ) : (
                <View style={styles.controlRow}>
                    {running
                        ? iconBtn('pause', Pause, () => run('pause'), 'Pause')
                        : iconBtn('resume', Play, () => run('resume'), 'Resume', {
                              filled: true,
                          })}
                    {iconBtn('reset', RotateCcw, () => run('reset'), 'Reset')}
                    {iconBtn('zen', Maximize2, () => setZen(true), 'Zen mode')}
                </View>
            )}

            <View style={styles.themeRow}>
                {FOCUS_THEMES.map(t => {
                    const active = t.id === ring.id;
                    return (
                        <Pressable
                            key={t.id}
                            onPress={() => onTheme(t)}
                            hitSlop={6}
                            style={[
                                styles.swatchOuter,
                                {
                                    borderColor: active ? theme.colors.text : 'transparent',
                                },
                            ]}>
                            <View style={[styles.swatchInner, { backgroundColor: t.from }]}>
                                <View
                                    style={[styles.swatchHalf, { backgroundColor: t.to }]}
                                />
                            </View>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );

    const historyFace = () => (
        <View style={styles.historyWrap}>
            <View style={[styles.totalsCard, { backgroundColor: theme.colors.surface1 }]}>
                {[
                    { label: 'TODAY', value: durationText(totals.today) },
                    { label: '7 DAYS', value: durationText(totals.week) },
                    { label: 'ALL TIME', value: durationText(totals.all) },
                    { label: 'SESSIONS', value: `${totals.sessions}` },
                ].map(t => (
                    <View key={t.label} style={styles.totalCell}>
                        <Text
                            style={{
                                fontFamily: dotFont,
                                fontSize: 17,
                                fontWeight: '700',
                                color: theme.colors.text,
                            }}>
                            {t.value}
                        </Text>
                        <Text
                            style={{
                                fontFamily: mediumFont,
                                fontSize: 9,
                                letterSpacing: 1.4,
                                marginTop: 4,
                                color: theme.colors.textSecondary,
                            }}>
                            {t.label}
                        </Text>
                    </View>
                ))}
            </View>

            {grouped.length === 0 ? (
                <View style={styles.empty}>
                    <Text
                        style={{
                            fontFamily: mediumFont,
                            fontSize: 13,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                        }}>
                        No sessions yet.
                    </Text>
                    <Text
                        style={{
                            fontFamily: mediumFont,
                            fontSize: 11,
                            marginTop: 8,
                            lineHeight: 18,
                            color: theme.colors.textSecondary,
                            textAlign: 'center',
                        }}>
                        Runs from this tab and from the home-screen widget are both
                        recorded here.
                    </Text>
                </View>
            ) : (
                grouped.map(g => (
                    <View key={g.day} style={styles.dayBlock}>
                        <Text
                            style={{
                                fontFamily: mediumFont,
                                fontSize: 10,
                                letterSpacing: 2,
                                marginBottom: 8,
                                color: theme.colors.textSecondary,
                            }}>
                            {g.label}
                        </Text>
                        {g.runs.map(h => (
                            <View
                                key={h.id}
                                style={[
                                    styles.runRow,
                                    { borderColor: theme.colors.border },
                                ]}>
                                <View
                                    style={[
                                        styles.runDot,
                                        {
                                            backgroundColor: h.completed
                                                ? ring.from
                                                : theme.colors.border,
                                        },
                                    ]}
                                />
                                <View style={styles.runMain}>
                                    <Text
                                        style={{
                                            fontFamily: dotFont,
                                            fontSize: 15,
                                            fontWeight: '700',
                                            color: theme.colors.text,
                                        }}>
                                        {durationText(h.actualMs)}
                                    </Text>
                                    <Text
                                        style={{
                                            fontFamily: mediumFont,
                                            fontSize: 10,
                                            marginTop: 3,
                                            color: theme.colors.textSecondary,
                                        }}>
                                        {h.completed
                                            ? `${dayjs(h.startedAt).format(
                                                  'HH:mm',
                                              )} — completed`
                                            : `${dayjs(h.startedAt).format(
                                                  'HH:mm',
                                              )} — stopped early of ${durationText(
                                                  h.plannedMs,
                                              )}`}
                                    </Text>
                                </View>
                                <View
                                    style={[
                                        styles.chip,
                                        { borderColor: theme.colors.border },
                                    ]}>
                                    <Text
                                        style={{
                                            fontFamily: mediumFont,
                                            fontSize: 8,
                                            letterSpacing: 1.2,
                                            color: theme.colors.textSecondary,
                                        }}>
                                        {h.source === 'widget' ? 'WIDGET' : 'APP'}
                                    </Text>
                                </View>
                            </View>
                        ))}
                    </View>
                ))
            )}

            {grouped.length > 0 ? (
                <Pressable
                    onPress={onClear}
                    style={({ pressed }) => [
                        styles.clearBtn,
                        {
                            borderColor: theme.colors.border,
                            opacity: pressed ? 0.6 : 1,
                        },
                    ]}>
                    <Trash2 size={14} color={theme.colors.error} />
                    <Text
                        style={{
                            fontFamily: boldFont,
                            fontSize: 11,
                            letterSpacing: 1.6,
                            marginLeft: 8,
                            color: theme.colors.error,
                        }}>
                        CLEAR HISTORY
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );

    // -----------------------------------------------------------------------

    return (
        <SafeAreaView style={[styles.root, { backgroundColor: theme.colors.background }]}>
            <View style={styles.header}>
                {/*
                  The dot heading the other tabs use. `dotFont` is not it —
                  getFontFamily('dot') resolves to Courier, which is why every screen
                  that wants the brand face names 'ndot' literally.
                */}
                <Text
                    style={{
                        fontFamily: 'ndot',
                        fontSize: 32,
                        color: theme.colors.text,
                    }}>
                    RISE FOCUS
                </Text>
                <View style={styles.headerRow}>
                    <Text
                        style={{
                            fontFamily: mediumFont,
                            fontSize: 11,
                            color: theme.colors.textSecondary,
                        }}>
                        {durationText(totals.today)} today
                    </Text>
                    <View style={[styles.segment, { borderColor: theme.colors.border }]}>
                        {(['timer', 'history'] as SubTab[]).map(t => {
                            const active = tab === t;
                            return (
                                <Pressable
                                    key={t}
                                    onPress={() => {
                                        setTab(t);
                                        if (t === 'history') refreshHistory();
                                    }}
                                    style={[
                                        styles.segmentBtn,
                                        active && { backgroundColor: theme.colors.surface2 },
                                    ]}>
                                    <Text
                                        style={{
                                            fontFamily: mediumFont,
                                            fontSize: 10,
                                            letterSpacing: 1.4,
                                            color: active
                                                ? theme.colors.text
                                                : theme.colors.textSecondary,
                                        }}>
                                        {t === 'timer' ? 'TIMER' : 'HISTORY'}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>
            </View>

            <ScrollView
                contentContainerStyle={styles.scroll}
                showsVerticalScrollIndicator={false}>
                {tab === 'timer' ? timerFace() : historyFace()}
            </ScrollView>

            {/*
              Zen: the timer and nothing else. A Modal rather than a screen so it covers
              the header and the tab bar too, which is the entire point of it.
            */}
            <Modal
                visible={zen}
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setZen(false)}>
                <View style={styles.zen}>
                    <StatusBar barStyle="light-content" backgroundColor="#000000" />
                    <View style={{ width: zenRing, height: zenRing }}>
                        <Ring
                            size={zenRing}
                            stroke={10}
                            fraction={idle ? 1 : fraction}
                            theme={ring}
                            elapsedSec={elapsedSec}
                            gradientId="focusRingZen"
                            dim={paused}
                            showHead={!idle}
                        />
                        <View
                            style={[
                                styles.ringCenter,
                                { width: zenRing, height: zenRing },
                            ]}>
                            <Text
                                style={{
                                    fontFamily: dotFont,
                                    fontSize: left >= 3600000 ? 46 : 58,
                                    fontWeight: '700',
                                    letterSpacing: 3,
                                    color: '#FFFFFF',
                                }}>
                                {clockText(left)}
                            </Text>
                            {paused ? (
                                <Text
                                    style={{
                                        fontFamily: mediumFont,
                                        fontSize: 10,
                                        letterSpacing: 4,
                                        marginTop: 10,
                                        color: '#666666',
                                    }}>
                                    PAUSED
                                </Text>
                            ) : null}
                        </View>
                    </View>

                    <View style={styles.zenControls}>
                        <Pressable
                            onPress={() => run(running ? 'pause' : 'resume')}
                            hitSlop={16}
                            style={styles.zenBtn}>
                            {running ? (
                                <Pause size={20} color="#555555" />
                            ) : (
                                <Play size={20} color="#555555" />
                            )}
                        </Pressable>
                        <Pressable
                            onPress={() => setZen(false)}
                            hitSlop={16}
                            style={styles.zenBtn}>
                            <X size={20} color="#555555" />
                        </Pressable>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 12,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 6,
    },
    segment: {
        flexDirection: 'row',
        borderWidth: 1,
        borderRadius: 999,
        padding: 2,
    },
    segmentBtn: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 999,
    },
    scroll: { paddingHorizontal: 20, paddingBottom: 40 },

    faceWrap: { alignItems: 'center', paddingTop: 8 },
    ringCenter: {
        position: 'absolute',
        top: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dialRow: { flexDirection: 'row', alignItems: 'center' },
    dialField: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
        borderWidth: 1,
    },
    stepRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 24,
    },
    stepBtn: {
        width: 54,
        height: 44,
        borderRadius: 12,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    presetRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        marginTop: 18,
    },
    preset: {
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 7,
        marginHorizontal: 4,
        marginBottom: 8,
    },
    iconBtn: {
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        marginHorizontal: 8,
    },
    controlRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        marginTop: 26,
    },
    themeRow: { flexDirection: 'row', marginTop: 28 },
    swatchOuter: {
        width: 36,
        height: 36,
        borderRadius: 999,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 5,
    },
    swatchInner: {
        width: 22,
        height: 22,
        borderRadius: 999,
        overflow: 'hidden',
    },
    swatchHalf: {
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: 11,
    },

    historyWrap: { paddingTop: 4 },
    totalsCard: {
        flexDirection: 'row',
        borderRadius: 16,
        paddingVertical: 16,
        marginBottom: 22,
    },
    totalCell: { flex: 1, alignItems: 'center' },
    empty: { paddingVertical: 48, paddingHorizontal: 24 },
    dayBlock: { marginBottom: 20 },
    runRow: {
        flexDirection: 'row',
        alignItems: 'center',
        borderTopWidth: 1,
        paddingVertical: 12,
    },
    runDot: { width: 8, height: 8, borderRadius: 999, marginRight: 12 },
    runMain: { flex: 1 },
    chip: {
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 8,
        paddingVertical: 3,
    },
    clearBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 18,
        paddingVertical: 11,
        marginTop: 8,
    },

    zen: {
        flex: 1,
        backgroundColor: '#000000',
        alignItems: 'center',
        justifyContent: 'center',
    },
    zenControls: { flexDirection: 'row', marginTop: 56 },
    zenBtn: {
        width: 52,
        height: 52,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 10,
        opacity: 0.7,
    },
});

export default FocusScreen;
