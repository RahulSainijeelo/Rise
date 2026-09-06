import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Check, Minus, Plus, Play, Pause, RotateCcw, ChevronRight, Activity } from 'lucide-react-native';
import dayjs from 'dayjs';
import { useTheme } from '../../theme';
import { NothingText } from '../NothingText';
import { useAppStore, type Habit } from '../../store/useAppStore';
import {
    formatHabitValue,
    habitDisplayMode,
    habitGoal,
    habitProgress,
    habitStep,
    isInverseGoal,
    isOverLimit,
    isSensorDerived,
} from '../../utils/HabitMetrics';
import {
    getHabitTimer,
    habitPendingSeconds,
    habitRemainingMs,
    habitTimerOp,
    idleHabitTimer,
    type HabitTimerOp,
    type HabitTimerState,
} from '../../services/HabitTimer';
import { applyPendingWidgetOps } from '../../services/WidgetOpsService';

/**
 * A habit, minified for the Deck.
 *
 * Everything shown here is derived through HabitMetrics, the same helpers the habit
 * screen and the widgets use. That is not tidiness for its own sake: the last time a
 * surface computed its own goal and unit, the same habit showed two different numbers
 * in two places, and the user could not tell which one was the truth.
 *
 * The card is deliberately not a third place to operate a sensor. Sensor-counted
 * habits (Step Legend, City Glider, Immediate Rise) and inverse-goal ones (Digital
 * Sunset) render read-only and tap through, because their honest control is switching
 * the sensor off — which already has two proper homes, the habit screen and the
 * widget. A + button here would let the user edit a number the next sensor reading
 * overwrites.
 */

interface Props {
    habit: Habit;
    /** False while the tab is unfocused; stops the timer repaint loop. */
    active: boolean;
    onOpen?: (habitId: string) => void;
    scale?: number;
    chrome?: boolean;
    /**
     * False in zen and edit modes. Zen is a phone across the room and edit mode is for
     * arranging cards, so in both the card is a readout with nothing to press.
     */
    controls?: boolean;
}

const unitLabel = (habit: Habit): string => {
    switch (habitDisplayMode(habit)) {
        case 'duration': return 'MIN';
        case 'distance': return habitProgress(habit, dayjs().format('YYYY-MM-DD')) < 1 ? 'M' : 'KM';
        case 'sunset': return habit.numericUnit || 'MIN';
        default: return (habit.numericUnit || '').toUpperCase();
    }
};

export const DeckHabitCard: React.FC<Props> = ({
    habit,
    active,
    onOpen,
    scale = 1,
    chrome = true,
    controls: showControls = true,
}) => {
    const { theme } = useTheme();
    const toggleHabit = useAppStore(s => s.toggleHabit);
    const updateNumericProgress = useAppStore(s => s.updateNumericProgress);

    // Local dates only. toISOString() would roll the day over at the wrong hour for
    // every user east or west of UTC, silently crediting the wrong date.
    const today = dayjs().format('YYYY-MM-DD');

    const z = (n: number) => Math.round(n * scale);

    const isTimer = habit.type === 'timer' && !habit.sensorType;
    const readOnly = isSensorDerived(habit) || isInverseGoal(habit) || !!habit.sensorType;

    const goalSeconds = habit.timerGoal || 0;
    const [timer, setTimer] = useState<HabitTimerState>(() =>
        idleHabitTimer(habit.id, goalSeconds),
    );
    const [, setTick] = useState(0);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);

    const readTimer = useCallback(async () => {
        if (!isTimer) return;
        const s = await getHabitTimer(habit.id, goalSeconds);
        if (alive.current) setTimer(s);
    }, [isTimer, habit.id, goalSeconds]);

    useEffect(() => {
        if (!active) return;
        readTimer();
    }, [active, readTimer]);

    // A repaint pulse, not a countdown: every number below is derived from the
    // deadline native holds, so this only asks React to look at the clock again.
    useEffect(() => {
        if (!active || timer.mode !== 'running') return;
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, [active, timer.mode]);

    const runTimerOp = (op: HabitTimerOp) => {
        habitTimerOp(habit.id, op, goalSeconds).then(s => {
            if (alive.current) setTimer(s);
            // Native cannot write the zustand store, so each settle point banks its
            // seconds as a pending op. Draining here is what stops today's total from
            // sitting still while the user watches this card.
            applyPendingWidgetOps(useAppStore.getState);
        });
    };

    const goal = habitGoal(habit);
    const stored = habitProgress(habit, today);
    // While a run is going, the stored total is behind by whatever native has not yet
    // credited. Showing `stored` alone is why the old timer looked frozen mid-session.
    const pending = isTimer ? habitPendingSeconds(timer) : 0;
    const value = stored + pending;
    const done = habit.completedDates.includes(today);
    const over = isOverLimit(habit, today);

    const percent = goal > 0 ? Math.min(100, Math.round((value / goal) * 100)) : 0;
    const barColor = over
        ? theme.colors.error
        : done
            ? theme.colors.success
            : theme.colors.text;

    // formatHabitValue reads the habit, so the uncredited seconds are folded into a
    // copy of it rather than formatted by hand here. Only timer habits can have
    // pending seconds, which is the one map that needs patching.
    const withPending: Habit = pending > 0
        ? { ...habit, timerProgress: { ...(habit.timerProgress || {}), [today]: value } }
        : habit;

    const bigText = isTimer && timer.mode !== 'idle'
        ? `${Math.floor(habitRemainingMs(timer) / 60000)}`
        : formatHabitValue(withPending, today);

    const bigUnit = isTimer && timer.mode !== 'idle' ? 'MIN LEFT' : unitLabel(habit);

    const iconBtn = (
        key: string,
        icon: React.ReactNode,
        onPress: () => void,
        emphasis = false,
    ) => (
        <TouchableOpacity
            key={key}
            onPress={onPress}
            style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                height: z(32),
                borderRadius: 9,
                borderWidth: 1,
                borderColor: emphasis ? theme.colors.primary : theme.colors.border,
                backgroundColor: emphasis ? `${theme.colors.primary}1A` : 'transparent',
            }}>
            {icon}
        </TouchableOpacity>
    );

    const controls = () => {
        if (!showControls || readOnly) return null;
        if (isTimer) {
            const running = timer.mode === 'running';
            return (
                <View style={{ flexDirection: 'row', gap: 6, marginTop: z(10) }}>
                    {iconBtn(
                        'run',
                        running
                            ? <Pause size={z(14)} color={theme.colors.text} />
                            : <Play size={z(14)} color={theme.colors.primary} />,
                        () => runTimerOp('toggle'),
                        !running,
                    )}
                    {timer.mode !== 'idle'
                        ? iconBtn('reset', <RotateCcw size={z(14)} color={theme.colors.text} />, () => runTimerOp('reset'))
                        : null}
                </View>
            );
        }
        if (habit.type === 'check') {
            return (
                <View style={{ flexDirection: 'row', gap: 6, marginTop: z(10) }}>
                    {iconBtn(
                        'check',
                        <Check size={z(14)} color={done ? theme.colors.success : theme.colors.text} />,
                        () => toggleHabit(habit.id, today),
                        done,
                    )}
                </View>
            );
        }
        const step = habitStep(habit);
        return (
            <View style={{ flexDirection: 'row', gap: 6, marginTop: z(10) }}>
                {iconBtn('dec', <Minus size={z(14)} color={theme.colors.text} />, () =>
                    updateNumericProgress(habit.id, today, -step))}
                {iconBtn('inc', <Plus size={z(14)} color={theme.colors.primary} />, () =>
                    updateNumericProgress(habit.id, today, step), true)}
            </View>
        );
    };

    return (
        <View
            style={
                chrome
                    ? {
                        borderWidth: 1,
                        borderColor: done ? theme.colors.success : theme.colors.border,
                        borderRadius: 18,
                        padding: 14,
                        backgroundColor: theme.colors.surface,
                    }
                    : undefined
            }>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <NothingText
                    variant="bold"
                    size={z(10)}
                    color={theme.colors.textSecondary}
                    numberOfLines={1}
                    style={{ letterSpacing: 1.6, flex: 1 }}>
                    {habit.title.toUpperCase()}
                </NothingText>
                {goal > 0 ? (
                    <NothingText
                        variant="bold"
                        size={z(10)}
                        color={done ? theme.colors.success : theme.colors.textSecondary}
                        style={{ letterSpacing: 1 }}>
                        {`${percent}%`}
                    </NothingText>
                ) : null}
                {onOpen ? (
                    <TouchableOpacity onPress={() => onOpen(habit.id)} hitSlop={10} style={{ marginLeft: 6 }}>
                        <ChevronRight size={z(14)} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                ) : null}
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: z(6) }}>
                <NothingText
                    size={z(34)}
                    color={over ? theme.colors.error : theme.colors.text}
                    style={{ fontFamily: 'ndot', letterSpacing: z(1) }}>
                    {bigText}
                </NothingText>
                {bigUnit ? (
                    <NothingText
                        variant="bold"
                        size={z(9)}
                        color={theme.colors.textSecondary}
                        style={{ letterSpacing: 1.4, marginLeft: z(6), marginBottom: z(6) }}>
                        {bigUnit}
                    </NothingText>
                ) : null}
                <View style={{ flex: 1 }} />
                {readOnly ? (
                    <View style={{ marginBottom: z(6) }}>
                        <Activity size={z(14)} color={theme.colors.textSecondary} />
                    </View>
                ) : null}
            </View>

            {goal > 0 ? (
                <View
                    style={{
                        height: z(4),
                        borderRadius: z(2),
                        marginTop: z(8),
                        overflow: 'hidden',
                        backgroundColor: theme.colors.surface2,
                    }}>
                    <View style={{ height: '100%', width: `${percent}%`, backgroundColor: barColor }} />
                </View>
            ) : null}

            {controls()}
        </View>
    );
};
