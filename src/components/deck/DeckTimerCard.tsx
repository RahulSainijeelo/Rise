import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Pressable, AppState } from 'react-native';
import {
    Play,
    Pause,
    RotateCcw,
    ChevronRight,
    ChevronUp,
    ChevronDown,
} from 'lucide-react-native';
import { useTheme } from '../../theme';
import { NothingText } from '../NothingText';
import {
    clockText,
    durationText,
    focusOp,
    fractionLeft,
    getFocusState,
    getFocusTheme,
    onTint,
    pad2,
    remainingMs,
    DEFAULT_FOCUS_THEME,
    IDLE_FOCUS_STATE,
    MAX_FOCUS_HOURS,
    type FocusState,
    type FocusTheme,
} from '../../services/FocusTimer';

/**
 * The Deck's focus timer card.
 *
 * It does not own a timer. It reads and writes the same state the Focus tab and the
 * focus widget use, which is the only way three surfaces can show one countdown: a
 * second timer living here would drift the moment the user started one somewhere
 * else, and the user has no reason to believe two "focus timers" in one app are
 * different things.
 *
 * That has a consequence for how it reads. The countdown itself is derived locally
 * from endsAt, so it ticks smoothly without touching the bridge every second, but
 * the *state* has to be re-read on a slower loop as well — a pause tapped on the
 * widget changes nothing this component would otherwise notice.
 *
 * The dial is here rather than only on the Focus tab because a timer you can see but
 * not set is furniture: "allow the time editing in the normal mode after user added
 * the timer in the deck". Because the dial writes through focusOp, setting 25 minutes
 * here is the same act as setting it on the Focus tab or the widget.
 */

interface Props {
    /** False while the tab is unfocused or the app is backgrounded; stops the loops. */
    active: boolean;
    /** Opens the Focus tab. The card is a summary, not a replacement for it. */
    onOpen?: () => void;
    /** Zen mode passes a larger scale, matching the watch faces. */
    scale?: number;
    /** Zen mode drops the card chrome so the timer floats on black. */
    chrome?: boolean;
    /**
     * False in zen and edit modes: no dial, no run buttons, nothing to press.
     * Zen is for a phone across the room, and edit mode is for arranging cards rather
     * than operating them.
     */
    controls?: boolean;
}

/** How often the authoritative state is re-read, in ms. */
const STATE_POLL_MS = 3000;

export const DeckTimerCard: React.FC<Props> = ({
    active,
    onOpen,
    scale = 1,
    chrome = true,
    controls = true,
}) => {
    const { theme } = useTheme();
    const [state, setState] = useState<FocusState>(IDLE_FOCUS_STATE);
    const [ring, setRing] = useState<FocusTheme>(DEFAULT_FOCUS_THEME);
    const [now, setNow] = useState(Date.now());
    /** Guards against a state write landing after unmount. */
    const alive = useRef(true);

    const z = (n: number) => Math.round(n * scale);

    const refresh = useCallback(async () => {
        const next = await getFocusState();
        if (alive.current) setState(next);
    }, []);

    useEffect(() => {
        alive.current = true;
        getFocusTheme().then(t => { if (alive.current) setRing(t); });
        return () => { alive.current = false; };
    }, []);

    useEffect(() => {
        if (!active) return;
        refresh();
        const poll = setInterval(refresh, STATE_POLL_MS);
        // The countdown is local arithmetic on endsAt, so it can tick at 1Hz without
        // asking native anything. Seconds is the finest unit the reading shows.
        const tick = setInterval(() => setNow(Date.now()), 1000);
        const sub = AppState.addEventListener('change', s => {
            // Coming back from the background is the likeliest moment for this state
            // to be stale: the widget's controls work while the app is not on screen.
            if (s === 'active') refresh();
        });
        return () => {
            clearInterval(poll);
            clearInterval(tick);
            sub.remove();
        };
    }, [active, refresh]);

    const left = remainingMs(state, now);
    const fraction = fractionLeft(state, now);
    const running = state.mode === 'running';
    const paused = state.mode === 'paused';
    const idle = state.mode === 'idle';

    // While idle the reading comes from the dial, not from remainingMs: an idle state
    // that has never been started has no deadline to count back from, and showing
    // 00:00 over a dial set to 25 minutes is the kind of disagreement that makes the
    // whole card look broken.
    const setupMs = (state.setupH * 3600 + state.setupM * 60) * 1000;

    const run = async (op: Parameters<typeof focusOp>[0]) => {
        const next = await focusOp(op);
        if (alive.current) setState(next);
    };

    const label = running ? 'RUNNING' : paused ? 'PAUSED' : 'READY';
    const labelColor = running ? ring.from : theme.colors.textSecondary;

    /** One field of the dial. Tapping it moves what the chevrons change. */
    const dialField = (which: 'h' | 'm', value: number) => {
        const selected = state.field === which;
        return (
            <Pressable
                onPress={() => run(which === 'h' ? 'selectH' : 'selectM')}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={which === 'h' ? 'Set hours' : 'Set minutes'}
                style={{
                    paddingHorizontal: z(6),
                    borderRadius: z(10),
                    borderWidth: 1,
                    backgroundColor: selected ? `${ring.from}26` : 'transparent',
                    borderColor: selected ? ring.from : 'transparent',
                }}>
                <NothingText
                    size={z(52)}
                    color={selected ? theme.colors.text : theme.colors.textSecondary}
                    style={{ fontFamily: 'ndot', letterSpacing: z(2) }}>
                    {pad2(value)}
                </NothingText>
            </Pressable>
        );
    };

    const chevron = (
        key: string,
        Icon: typeof ChevronUp,
        op: 'up' | 'down',
        disabled: boolean,
        label2: string,
    ) => (
        <TouchableOpacity
            key={key}
            onPress={() => run(op)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label2}
            style={{
                width: z(38),
                height: z(28),
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: z(8),
                borderWidth: 1,
                borderColor: theme.colors.border,
                opacity: disabled ? 0.3 : 1,
            }}>
            <Icon size={z(15)} color={theme.colors.text} />
        </TouchableOpacity>
    );

    /**
     * A round icon button.
     *
     * Icon-only by request. The filled variant takes its foreground from onTint()
     * rather than a hard-coded white, which is what turned the `mono` ring theme's
     * start button into a blank white circle.
     */
    const iconBtn = (
        key: string,
        Icon: typeof Play,
        onPress: () => void,
        label2: string,
        filled = false,
    ) => (
        <TouchableOpacity
            key={key}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label2}
            style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                height: z(40),
                borderRadius: z(20),
                borderWidth: 1.5,
                borderColor: filled ? ring.from : theme.colors.border,
                backgroundColor: filled ? ring.from : 'transparent',
            }}>
            <Icon size={z(16)} color={filled ? onTint(ring.from) : theme.colors.text} />
        </TouchableOpacity>
    );

    const editable = idle && controls;

    return (
        <View
            style={
                chrome
                    ? {
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: 18,
                        padding: 16,
                        backgroundColor: theme.colors.surface,
                    }
                    : undefined
            }>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <NothingText variant="bold" size={z(10)} color={theme.colors.textSecondary} style={{ letterSpacing: 2, flex: 1 }}>
                    FOCUS
                </NothingText>
                {onOpen ? (
                    <TouchableOpacity onPress={onOpen} hitSlop={10} style={{ marginLeft: 6 }}>
                        <ChevronRight size={z(15)} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                ) : null}
            </View>

            {editable ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: z(6) }}>
                    {dialField('h', state.setupH)}
                    <NothingText
                        size={z(52)}
                        color={theme.colors.textSecondary}
                        style={{ fontFamily: 'ndot' }}>
                        :
                    </NothingText>
                    {dialField('m', state.setupM)}
                    <View style={{ flex: 1 }} />
                    <View style={{ gap: z(6) }}>
                        {chevron(
                            'up',
                            ChevronUp,
                            'up',
                            state.field === 'h' && state.setupH >= MAX_FOCUS_HOURS,
                            'Increase',
                        )}
                        {chevron(
                            'down',
                            ChevronDown,
                            'down',
                            state.field === 'h' && state.setupH <= 0,
                            'Decrease',
                        )}
                    </View>
                </View>
            ) : (
                <NothingText
                    size={z(52)}
                    color={theme.colors.text}
                    style={{ fontFamily: 'ndot', letterSpacing: z(3), marginTop: z(6) }}>
                    {clockText(idle ? setupMs : left)}
                </NothingText>
            )}

            {/*
              The track is drawn even when idle, showing full. An empty rectangle
              would read as "no timer configured" when in fact the dial is set and one
              tap from starting.
            */}
            <View
                style={{
                    height: z(4),
                    borderRadius: z(2),
                    marginTop: z(10),
                    overflow: 'hidden',
                    backgroundColor: ring.track,
                }}>
                <View
                    style={{
                        height: '100%',
                        width: `${(idle ? 1 : fraction) * 100}%`,
                        backgroundColor: running ? ring.from : theme.colors.textSecondary,
                    }}
                />
            </View>

            <NothingText size={z(10)} color={theme.colors.textSecondary} style={{ marginTop: z(6) }}>
                {idle
                    ? editable
                        ? `SET FOR ${durationText(setupMs)} · ADJUSTING ${state.field === 'h' ? 'HOURS' : 'MINUTES'}`
                        : `SET FOR ${durationText(setupMs)}`
                    : `OF ${durationText(state.durationMs)}${state.source === 'widget' ? ' · STARTED ON WIDGET' : ''}`}
            </NothingText>

            {controls ? (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: z(12) }}>
                    {idle
                        ? iconBtn('start', Play, () => run('start'), 'Start focus', true)
                        : running
                            ? iconBtn('pause', Pause, () => run('pause'), 'Pause')
                            : iconBtn('resume', Play, () => run('resume'), 'Resume', true)}
                    {!idle
                        ? iconBtn('reset', RotateCcw, () => run('reset'), 'Reset')
                        : null}
                </View>
            ) : null}
        </View>
    );
};
