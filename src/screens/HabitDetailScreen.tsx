import React, { useState, useEffect, useRef } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Dimensions, Vibration, Modal, NativeModules, AppState } from 'react-native';
const { WidgetBridge } = NativeModules;
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Play, Pause, RotateCcw, Flame, Trophy, Settings, Trash2, Check, X, Plus, Sparkles, Activity, Pin, PowerOff, Mic, MicOff } from 'lucide-react-native';
import { HabitDetailScreenStyles as styles } from '../styles/Habit.styles';
import dayjs from 'dayjs';
import { useTheme } from '../theme';
import { NothingText } from '../components/NothingText';
import { NothingCard } from '../components/NothingCard';
import { NothingButton } from '../components/NothingButton';
import { NothingInput } from '../components/NothingInput';
import { ConfirmationModal } from '../components/ConfirmationModal';
import { NoiseCalibrator } from '../components/NoiseCalibrator';
import { useAppStore } from '../store/useAppStore';
import { useHabit } from '../store/selectors';
import { SoundService } from '../services/SoundService';
const { width } = Dimensions.get('window');
const CIRCLE_SIZE = width * 0.7;

import { sensorService, clampNoiseThreshold, type LiveSensorData } from '../services/SensorService';
import { habitSlot } from '../services/WidgetContract';
import {
    getHabitTimer,
    habitTimerOp,
    habitRemainingMs,
    idleHabitTimer,
    type HabitTimerState,
    type HabitTimerOp,
} from '../services/HabitTimer';
import { applyPendingWidgetOps } from '../services/WidgetOpsService';
import { missingSensorPermissions, permissionLabel, requestSensorPermissions } from '../utils/permissions';
import {
    habitStep,
    formatHabitValue,
    isOverLimit as habitIsOverLimit,
    habitProgress,
    habitGoal,
    habitDisplayMode,
    isInverseGoal,
    isSensorDerived,
} from '../utils/HabitMetrics';

export const HabitDetailScreen = ({ route, navigation }: any) => {
    const { habitId } = route.params;
    const { theme } = useTheme();
    const { updateHabit, deleteHabit, toggleHabit } = useAppStore();
    // Direct O(1) lookup against the normalized store, and this screen now
    // re-renders only when *this* habit changes rather than on every habit edit
    // anywhere (the old `habits.find` subscribed to the whole list). (SET G)
    const habit = useHabit(habitId);

    // The countdown is native state, not React state.
    //
    // What used to be here was `timeLeft` in useState plus a setInterval. That clock
    // stopped the instant this screen unmounted, and it banked nothing until it hit
    // zero — so backgrounding the app twenty minutes into a twenty-five minute run
    // threw all twenty minutes away. HabitTimer keeps a wall-clock deadline in native
    // prefs, credits the seconds as they are earned, and is the same state the
    // wrapper widget drives. See src/services/HabitTimer.ts.
    const timerGoalSeconds = habit?.timerGoal || 0;
    const [timerState, setTimerState] = useState<HabitTimerState>(() =>
        idleHabitTimer(habitId, timerGoalSeconds),
    );
    // Purely a repaint pulse. Every number shown is derived from the deadline, so a
    // dropped tick costs a frame rather than a second.
    const [, setTick] = useState(0);
    const [showSettings, setShowSettings] = useState(false);
    const [editTitle, setEditTitle] = useState(habit?.title || '');
    const [editGoal, setEditGoal] = useState(((habit?.timerGoal || 0) / 60).toString());
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // History grid: the streak view (binary done/missed) or the full view (how much of
    // each day's goal was actually done, even on days that fell short). Only habits that
    // store a per-day value — numeric and timer, sensor ones included — can offer the
    // full view; a plain check habit has nothing to show but done/not-done, so it never
    // sees the toggle and stays on the streak grid.
    const [historyFull, setHistoryFull] = useState(false);
    // Which day's exact figure to spell out under the full grid. A cell is a shaded
    // square; tapping it answers "how much, that day" without cramming a number into 14px.
    const [peekDate, setPeekDate] = useState<string | null>(null);

    // Sensor State
    //
    // This screen no longer starts sensors itself. SensorService owns the
    // hardware and this is a read-only subscription, so opening the screen can
    // no longer reset the global step count or stop tracking on unmount.
    const [liveData, setLiveData] = useState<LiveSensorData>(sensorService.getLive());

    // Assume granted until proven otherwise, so the prompt cannot flash on screens
    // where it does not belong or during the first async check.
    const [usageAccess, setUsageAccess] = useState(true);

    // Runtime permissions this habit's sensor still lacks. Same "assume fine until
    // the check comes back" rule as above: an empty list draws nothing.
    const [missingPerms, setMissingPerms] = useState<string[]>([]);

    const timerRef = useRef<any>(null);
    const today = dayjs().format('YYYY-MM-DD');
    const isCompletedToday = habit?.completedDates.includes(today) || false;
    const isAtMost = (habit?.goalDirection || 'atLeast') === 'atMost';

    const isTimerRunning = timerState.mode === 'running';
    const timeLeft = Math.ceil(habitRemainingMs(timerState) / 1000);

    // Which of the three kinds of sensor habit this is, because each gets a
    // different control set: counters (steps/distance) get an on/off switch and no
    // hand-editing, Deep Silence gets play/pause over the microphone, and Digital
    // Sunset keeps its held/slipped judgement call.
    //
    // Via habitSlot rather than habit.sensorType, so the pause switch and the noise
    // controls still resolve for a habit whose sensorType went missing but whose
    // templateId is intact — otherwise the screen renders a sensor habit with no way
    // to pause it and no live section.
    const sensorSlot = habit ? habitSlot(habit) : null;
    const sensorDerived = habit ? isSensorDerived(habit) : false;
    const isNoiseHabit = sensorSlot === 'noise';

    /**
     * Is this habit's sensor actually collecting right now?
     *
     * Read out of the live snapshot rather than local state: the same switch exists
     * on the widget and in the notification, so the app has to render whatever
     * native currently believes instead of its own idea of it.
     */
    const trackingOn =
        !liveData.pausedAll && !(sensorSlot ? liveData.paused.includes(sensorSlot) : false);

    const toggleSensor = () => {
        if (!sensorSlot) return;
        Vibration.vibrate(20);
        sensorService.setSlotTracking(sensorSlot, !trackingOn);
    };

    useEffect(() => {
        if (!habit?.isSensorBased) return;
        return sensorService.subscribe(setLiveData);
    }, [habit?.id, habit?.isSensorBased]);

    /**
     * Pull native's tracking state and last readings on open, and again on every
     * return to the foreground.
     *
     * Both can change while JS is dead — a widget tap pauses a sensor, the service
     * keeps counting steps for hours — so a screen that only listened for ticks
     * would paint a stale OFF button and a zero step count for its first seconds.
     */
    useEffect(() => {
        if (!habit?.isSensorBased) return;
        const sync = () => {
            sensorService.getTrackingState();
            sensorService.loadRuntimeSnapshot();
        };
        sync();
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') sync();
        });
        return () => sub.remove();
    }, [habit?.id, habit?.isSensorBased]);

    /**
     * Usage access is a "special app access" grant: there is no runtime dialog, only
     * a Settings page, so the only thing the app can do is detect the absence and
     * offer to open it. Without it Digital Sunset falls back to counting unlocks,
     * which is a much coarser signal than real minutes.
     *
     * Coming back from that Settings page is an AppState transition rather than a
     * navigation event, which is why the re-check hangs off AppState and not focus.
     */
    useEffect(() => {
        if (sensorSlot !== 'screen') return;
        let cancelled = false;
        const check = () => {
            sensorService.hasUsageStatsPermission().then(ok => {
                if (!cancelled) setUsageAccess(ok);
            });
        };
        check();
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') check();
        });
        return () => {
            cancelled = true;
            sub.remove();
        };
    }, [sensorSlot]);

    /**
     * Re-check this habit's runtime permissions whenever the app comes forward.
     *
     * A denied permission was previously invisible from inside the app: the native
     * service logged its bail and returned, and this screen went on drawing a
     * confident zero, which reads as a broken sensor rather than as something the
     * user can fix in one tap. Hangs off AppState because granting happens either in
     * the system dialog or, after a permanent denial, in Settings — neither of which
     * is a navigation event.
     */
    useEffect(() => {
        if (!sensorSlot || !habit) return;
        let cancelled = false;
        const check = () => {
            missingSensorPermissions(habit).then(missing => {
                if (!cancelled) setMissingPerms(missing);
            });
        };
        check();
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') check();
        });
        return () => {
            cancelled = true;
            sub.remove();
        };
    }, [sensorSlot, habit?.id]);

    /** Ask for whatever is missing, then re-check and restart tracking if it worked. */
    const grantSensorPermissions = async () => {
        if (!habit) return;
        Vibration.vibrate(20);
        await requestSensorPermissions([habit]);
        const still = await missingSensorPermissions(habit);
        setMissingPerms(still);
        // A newly granted sensor has to be picked up: the service decided what to
        // listen to when it started, back when it was not allowed to listen at all.
        if (still.length === 0) sensorService.refreshConfig(useAppStore.getState);
    };

    // Keep the config current: adding or editing a sensor habit has to
    // reconfigure tracking, which previously only happened once at app start.
    useEffect(() => {
        if (habit?.isSensorBased) {
            sensorService.refreshConfig(useAppStore.getState);
        }
    }, [habit?.id, sensorSlot, habit?.numericGoal, habit?.timerGoal, habit?.cutoffTime, habit?.allowanceMinutes]);

    // Sync state when habit updates or timer goal changes
    useEffect(() => {
        if (habit) {
            setEditTitle(habit.title);
            setEditGoal(((habit.timerGoal || 0) / 60).toString());
        }
    }, [habit?.id, habit?.timerGoal]);

    // Sensor readings are committed to the store by SensorService, which owns the
    // clock and runs whether or not this screen is mounted. The only thing left
    // here is the celebratory buzz when a sensor habit crosses its goal.
    const wasCompleted = useRef(isCompletedToday);
    useEffect(() => {
        if (habit?.isSensorBased && isCompletedToday && !wasCompleted.current) {
            Vibration.vibrate(200);
        }
        wasCompleted.current = isCompletedToday;
    }, [isCompletedToday, habit?.isSensorBased]);

    /**
     * Adopt whatever native currently believes.
     *
     * Runs on mount and on every return to this screen, because the run may have been
     * started from the widget, settled by the expiry alarm, or finished while the app
     * was not running at all. The screen is a view, never the owner.
     */
    useEffect(() => {
        if (habit?.type !== 'timer' || isNoiseHabit) return;
        let alive = true;
        const pull = () => {
            getHabitTimer(habitId, timerGoalSeconds).then(s => {
                if (alive) setTimerState(s);
            });
        };
        pull();
        const unsubscribe = navigation.addListener('focus', pull);
        return () => {
            alive = false;
            unsubscribe();
        };
    }, [habitId, habit?.type, isNoiseHabit, timerGoalSeconds, navigation]);

    // Repaint once a second while a run is going. Deliberately not a countdown: it
    // does not decide anything, it only asks React to look at the clock again.
    useEffect(() => {
        if (!isTimerRunning) return;
        timerRef.current = setInterval(() => setTick(t => t + 1), 1000);
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [isTimerRunning]);

    // Crossing zero is native's to settle, so ask rather than decide. That keeps the
    // completion identical whether the screen was open, closed, or the phone asleep —
    // which is the whole reason the deadline lives outside React.
    const timerFinished = habit?.type === 'timer' && !isNoiseHabit && isTimerRunning && timeLeft <= 0;
    useEffect(() => {
        if (!timerFinished) return;
        let alive = true;
        getHabitTimer(habitId, timerGoalSeconds).then(s => {
            if (!alive) return;
            setTimerState(s);
            // read() settled the overdue run and banked the full duration as an op;
            // drain it here so the ring lands on the number the run just earned.
            applyPendingWidgetOps(useAppStore.getState);
            SoundService.playSound('timer_end');
            Vibration.vibrate(200);
        });
        return () => {
            alive = false;
        };
    }, [timerFinished, habitId, timerGoalSeconds]);

    /**
     * Start, pause, resume or reset the run, then adopt what native produced.
     *
     * The drain is not optional. Native cannot write the zustand store, so every
     * settle point banks its seconds as a PendingOp instead; App.tsx only drains that
     * queue on a return to the foreground, which never happens while the user is
     * sitting on this screen. Without this, pausing a run would move the countdown
     * but leave "today" showing the same number it showed before — which is the exact
     * complaint the timer rebuild exists to answer.
     */
    const runTimerOp = (op: HabitTimerOp) => {
        Vibration.vibrate(20);
        habitTimerOp(habitId, op, timerGoalSeconds).then(state => {
            setTimerState(state);
            applyPendingWidgetOps(useAppStore.getState);
        });
    };

    if (!habit) {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
                <View style={[styles.header, { marginBottom: 20 }]}>
                    <TouchableOpacity
                        onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Main')}
                        style={[styles.backBtn, { backgroundColor: theme.colors.surface1 }]}
                    >
                        <ArrowLeft size={20} color={theme.colors.text} />
                    </TouchableOpacity>
                    <View style={{ flex: 1 }} />
                </View>
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 }}>
                    <NothingText variant="bold" size={18} style={{ marginBottom: 12, textAlign: 'center' }}>
                        HABIT NOT FOUND
                    </NothingText>
                    <NothingText size={14} color={theme.colors.textSecondary} style={{ textAlign: 'center', marginBottom: 24 }}>
                        This habit may have been deleted or you need to log in first.
                    </NothingText>
                    <NothingButton variant="primary" label="GO HOME" onPress={() => navigation.navigate('Main')} />
                </View>
            </SafeAreaView>
        );
    }

    const handleSaveSettings = () => {
        if (editTitle.trim()) {
            updateHabit(habitId, {
                title: editTitle,
                timerGoal: habit.type === 'timer' ? parseInt(editGoal) * 60 : undefined
            });
            setShowSettings(false);
        }
    };

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const numericStep = habitStep(habit);
    const isOverLimit = habitIsOverLimit(habit, today);

    // ── History ──────────────────────────────────────────────────────────────
    //
    // The streak grid answers "did you do it"; the full grid answers "how much did you
    // do", day by day, so a count habit you never quite finished still shows the 5 of 8
    // glasses or the 5,000 steps you managed. Only the two value-bearing types can tell
    // that story — a plain check habit has no partial figure — so the toggle appears for
    // them, sensor-measured ones included.
    //
    // Inverse ("at most") goals are deliberately left on the streak grid. habitProgress
    // reports 0 for a day with no entry, and under a limit a 0 is ambiguous — it could be
    // "stayed off it all day" (the best possible day) or "nothing was recorded" — so the
    // intensity shading can't colour that day honestly. completedDates already carries the
    // held/slipped verdict the streak grid draws, so that stays the truthful view for them.
    const inverse = isInverseGoal(habit);
    const dayGoal = habitGoal(habit);
    const hasProgressHistory = (habit.type === 'numeric' || habit.type === 'timer') && !inverse;

    /**
     * A single day's figures for the full grid: the raw value, the goal, how full the
     * cell should read (0..1), whether the day met its target, and a spelled-out
     * "5 / 8 GLASSES" for the peek line.
     *
     * duration is the one display mode where the stored number (seconds) and the shown
     * number (minutes) differ, so its value, goal and unit are all converted together
     * rather than run through formatHabitValue, which would format the value in minutes
     * while habitGoal handed back seconds.
     */
    const describeDay = (date: string) => {
        const value = habitProgress(habit, date);
        const mode = habitDisplayMode(habit);

        let valueText: string;
        let goalText: string;
        let unit: string;
        if (mode === 'duration') {
            valueText = `${Math.floor(value / 60)}`;
            goalText = `${Math.floor(dayGoal / 60)}`;
            unit = 'MIN';
        } else if (mode === 'distance') {
            const km = value;
            valueText = km < 1 ? `${Math.round(km * 1000)}` : km.toFixed(1);
            goalText = `${dayGoal}`;
            unit = km < 1 ? 'M' : (habit.numericUnit || 'KM').toUpperCase();
        } else {
            valueText = `${Math.round(value)}`;
            goalText = `${Math.round(dayGoal)}`;
            unit = (habit.numericUnit || '').toUpperCase();
        }

        // Fullness, always 0..1. For an inverse ("at most") goal the cell fills as the
        // day is held and empties as the allowance is spent, so a quiet day is full and
        // a blown limit is empty — the opposite of a count habit, and the reason the two
        // cannot share one ratio.
        const raw = dayGoal > 0 ? value / dayGoal : value > 0 ? 1 : 0;
        const ratio = inverse
            ? Math.max(0, 1 - raw)
            : Math.min(1, raw);

        // "Met" means the day counts as a win: under-or-equal for a limit, at-or-over for
        // a target. A day with no progress at all never counts as met, limit or not.
        const met = inverse
            ? dayGoal > 0 && value <= dayGoal
            : value >= dayGoal && dayGoal > 0;

        return { value, ratio, met, valueText, goalText, unit };
    };

    /**
     * Deep Silence's numbers, all of them persistent.
     *
     * The banked total is whatever the store has for today; the live reading is what
     * the service has accrued since its last write. Taking the larger of the two
     * means the display never goes backwards when the service restarts mid-day, and
     * never sits at zero while waiting for the first tick after an app launch.
     */
    const noiseGoal = habit.timerGoal || 0;
    const noiseElapsed = Math.max(habit.timerProgress?.[today] || 0, liveData.noiseSeconds || 0);
    const noiseRemaining = Math.max(0, noiseGoal - noiseElapsed);

    /**
     * The threshold the meter draws and the accrual tests against.
     *
     * Read from the habit, not from liveData, even though the tracker reports its own
     * copy. The tracker's copy only arrives on its next publish, up to a second later,
     * so driving the marker from it made the slider lag a full second behind the
     * finger. Both sides apply clampNoiseThreshold to the same stored field, so there
     * is nothing for them to disagree about — liveData.noiseThresholdDb exists so the
     * widget can describe the line it is using, not so this screen can re-derive it.
     */
    const noiseThreshold = clampNoiseThreshold(habit.noiseThresholdDb);

    /** True only when a second passing right now would actually be banked. */
    const noiseBanking =
        trackingOn &&
        liveData.noiseListening &&
        liveData.noiseHasReading &&
        liveData.noise <= noiseThreshold;

    /**
     * Persist a new threshold and push it to whichever tracker is running.
     *
     * refreshConfig is not optional. The native service holds its own copy of the
     * config and only re-reads it when JS hands over a new one, and startGlobalTracking
     * short-circuits on an unchanged config blob — so without this the slider would
     * move, the store would update, and the microphone would go on judging seconds
     * against the old number.
     */
    const setNoiseThreshold = (db: number) => {
        updateHabit(habitId, { noiseThresholdDb: clampNoiseThreshold(db) });
        sensorService.refreshConfig(useAppStore.getState);
    };

    // Counters read from the sensor, not from the store, so the figure on screen
    // moves as you walk instead of one commit behind.
    const storedValue = habitProgress(habit, today);
    const liveValue = sensorSlot === 'gps' ? liveData.distanceMeters / 1000 : liveData.steps;
    const shownValue = sensorDerived ? Math.max(storedValue, liveValue) : storedValue;
    const isDistance = habitDisplayMode(habit) === 'distance';
    const displayedProgress = sensorDerived
        ? isDistance
            ? shownValue < 1
                ? `${Math.round(shownValue * 1000)}`
                : shownValue.toFixed(1)
            : `${Math.round(shownValue)}`
        : formatHabitValue(habit, today);
    // Below a kilometre the big number is metres, so the unit under it has to agree.
    const displayedUnit =
        sensorDerived && isDistance && shownValue < 1 ? 'M' : habit.numericUnit?.toUpperCase() || '';

    const progress =
        habit.type === 'timer'
            ? isNoiseHabit
                ? noiseRemaining / (noiseGoal || 1)
                : timeLeft / (habit.timerGoal || 1)
            : 0;

    /**
     * The only honest control for a sensor-measured habit: switch the sensor off.
     *
     * A + or − would edit a number the next reading overwrites a second later, and a
     * manual "mark done" on a step goal is just a lie to your own streak. Switching
     * the sensor off is real — it releases the hardware and stops the battery drain,
     * and the banked count for today stays exactly where it was.
     */
    const SensorSwitch = () => (
        <View style={{ alignItems: 'center', marginTop: 28 }}>
            <TouchableOpacity
                onPress={toggleSensor}
                activeOpacity={0.8}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    paddingVertical: 14,
                    paddingHorizontal: 24,
                    borderRadius: 32,
                    borderWidth: 1.5,
                    borderColor: trackingOn ? theme.colors.success : theme.colors.border,
                    backgroundColor: trackingOn ? theme.colors.success + '12' : 'transparent',
                }}
            >
                {trackingOn ? (
                    <Activity size={18} color={theme.colors.success} />
                ) : (
                    <PowerOff size={18} color={theme.colors.textSecondary} />
                )}
                <NothingText
                    variant="bold"
                    size={13}
                    color={trackingOn ? theme.colors.success : theme.colors.textSecondary}
                >
                    {trackingOn ? 'TRACKING ON' : 'TRACKING OFF'}
                </NothingText>
            </TouchableOpacity>
            <NothingText
                size={11}
                color={theme.colors.textSecondary}
                style={{ marginTop: 10, paddingHorizontal: 40, textAlign: 'center' }}
            >
                {trackingOn
                    ? 'Counted by the sensor, in the background, with the app closed. Tap to switch the sensor off — today’s count is kept.'
                    : 'Sensor released. Nothing is being counted for this habit until you switch it back on.'}
            </NothingText>
        </View>
    );

    const SensorInsight = () => {
        if (!habit.isSensorBased) return null;

        return (
            <NothingCard margin="md" style={{ backgroundColor: theme.colors.surface1, padding: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                    <Activity size={18} color={theme.colors.primary} />
                    <NothingText variant="bold" size={14} style={{ marginLeft: 8, fontFamily: 'ndot' }}>LIVE INSIGHTS</NothingText>
                    <View style={{ flex: 1 }} />
                    {/* Green means a sensor is genuinely feeding this card. Once it is
                        paused the numbers are frozen, and a green dot over a frozen
                        number is the one thing worse than no dot. */}
                    <View style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: trackingOn ? theme.colors.success : theme.colors.textSecondary,
                        opacity: trackingOn ? 0.8 : 0.4,
                    }} />
                </View>

                {/* The reason the numbers below are zero, when that is the reason.
                    Rendered above every slot's live section rather than inside one,
                    because a refused permission produces the same convincing zero
                    whichever sensor it belonged to. */}
                {missingPerms.length > 0 && (
                    <TouchableOpacity
                        onPress={grantSensorPermissions}
                        style={{
                            marginBottom: 16,
                            padding: 12,
                            borderWidth: 1,
                            borderColor: theme.colors.error,
                            borderRadius: 4,
                        }}
                    >
                        <NothingText variant="bold" size={11} color={theme.colors.error}>
                            {`${missingPerms.map(permissionLabel).join(' + ')} NOT GRANTED`}
                        </NothingText>
                        <NothingText size={11} color={theme.colors.textSecondary} style={{ marginTop: 4 }}>
                            Nothing can be measured without it, so this habit will stay at zero. Tap to grant.
                        </NothingText>
                    </TouchableOpacity>
                )}

                {sensorSlot === 'pedometer' || sensorSlot === 'movement' ? (
                    /*
                      No step count here. This card used to repeat the same figure the
                      main readout shows a few hundred pixels away, at 48px against 80px
                      — the user's "showing measures two times". The count has one home,
                      the one that also carries the goal; this card is for the things
                      that reading cannot tell you.

                      The bar is the live activity level. It replaced a 30-bar sparkline
                      built from Math.random(), which moved convincingly on every
                      repaint while meaning nothing at all.
                    */
                    <View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                            <View>
                                <NothingText variant="bold" size={14}>{liveData.activity.toFixed(1)}%</NothingText>
                                <NothingText size={10} color={theme.colors.textSecondary}>ACTIVITY LEVEL</NothingText>
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                                <NothingText variant="bold" size={14} color={trackingOn ? theme.colors.success : theme.colors.textSecondary}>
                                    {trackingOn ? 'COUNTING' : 'PAUSED'}
                                </NothingText>
                                <NothingText size={10} color={theme.colors.textSecondary}>SENSOR</NothingText>
                            </View>
                        </View>
                        <View style={{ width: '100%', height: 4, backgroundColor: theme.colors.border, borderRadius: 2, marginTop: 12 }}>
                            <View style={{
                                width: `${Math.min(100, Math.max(0, liveData.activity))}%`,
                                height: '100%',
                                backgroundColor: theme.colors.primary,
                                borderRadius: 2,
                            }} />
                        </View>
                        <NothingText size={11} color={theme.colors.textSecondary} style={{ marginTop: 8 }}>
                            {sensorSlot === 'movement'
                                ? 'Movement past the walking threshold counts. Shaking the phone does not.'
                                : 'Steps are counted by the hardware step sensor, in the background.'}
                        </NothingText>
                    </View>
                ) : sensorSlot === 'screen' ? (
                    <View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                            <View>
                                <NothingText variant="dot" size={48}>
                                    {liveData.sunsetSource === 'usagestats' ? liveData.sunsetMinutes : liveData.sunsetUnlocks}
                                </NothingText>
                                <NothingText size={12} color={theme.colors.textSecondary}>
                                    {liveData.sunsetSource === 'usagestats' ? 'MINUTES USED' : 'UNLOCKS'}
                                </NothingText>
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                                <NothingText variant="bold" size={14}>
                                    {habit.cutoffTime || '22:00'} → {habit.windowEndTime || '06:00'}
                                </NothingText>
                                <NothingText size={10} color={theme.colors.textSecondary}>SUNSET WINDOW</NothingText>
                            </View>
                        </View>
                        <View style={{ width: '100%', height: 4, backgroundColor: theme.colors.border, borderRadius: 2, marginTop: 12 }}>
                            <View style={{
                                width: `${Math.min(100, ((habit.numericProgress?.[today] || 0) / (habit.numericGoal || 1)) * 100)}%`,
                                height: '100%',
                                backgroundColor: (habit.numericProgress?.[today] || 0) > (habit.numericGoal || 1)
                                    ? theme.colors.error
                                    : theme.colors.success,
                                borderRadius: 2
                            }} />
                        </View>
                        <NothingText size={11} color={theme.colors.textSecondary} style={{ marginTop: 8 }}>
                            {liveData.sunsetSource === 'usagestats'
                                ? `Allowance ${habit.allowanceMinutes ?? 5} min of screen time after ${habit.cutoffTime || '22:00'}.`
                                : liveData.sunsetSource === 'unlocks'
                                    ? 'Counting unlocks. Grant usage access in settings for real screen-time minutes.'
                                    : 'Self-reported. Confirm below when the window closes.'}
                        </NothingText>
                        {!usageAccess && (
                            <TouchableOpacity
                                onPress={() => sensorService.openUsageStatsSettings()}
                                style={{
                                    marginTop: 12,
                                    paddingVertical: 10,
                                    paddingHorizontal: 12,
                                    borderWidth: 1,
                                    borderColor: theme.colors.primary,
                                    borderRadius: 4,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                }}
                            >
                                <NothingText variant="bold" size={11} color={theme.colors.primary}>
                                    GRANT USAGE ACCESS
                                </NothingText>
                                <View style={{ flex: 1 }} />
                                <NothingText size={10} color={theme.colors.textSecondary}>
                                    OPENS SETTINGS
                                </NothingText>
                            </TouchableOpacity>
                        )}
                    </View>
                ) : sensorSlot === 'noise' ? (
                    <NoiseCalibrator
                        db={liveData.noise}
                        listening={liveData.noiseListening && trackingOn}
                        hasReading={liveData.noiseHasReading}
                        thresholdDb={noiseThreshold}
                        streakSeconds={liveData.noiseStreakSeconds}
                        breaches={liveData.noiseBreaches}
                        onChangeThreshold={setNoiseThreshold}
                    />
                ) : sensorSlot === 'gps' ? (
                    /*
                      Same reasoning as the step card: the distance itself belongs to the
                      main readout, which is the one that also states the goal. What this
                      card adds is how far along the goal that distance is, and whether
                      anything is being measured at all.
                    */
                    <View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <View>
                                <NothingText variant="bold" size={14}>
                                    {`${Math.min(100, Math.round((liveData.distanceMeters / 1000) / (habit.numericGoal || 1) * 100))}%`}
                                </NothingText>
                                <NothingText size={10} color={theme.colors.textSecondary}>
                                    {`OF ${habit.numericGoal || 0}${(habit.numericUnit || 'KM').toUpperCase()}`}
                                </NothingText>
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                                {/* What the tracker is actually doing. A distance habit
                                    reads zero for four unrelated reasons and they all
                                    used to look the same from here. */}
                                <NothingText
                                    variant="bold"
                                    size={12}
                                    color={
                                        !trackingOn ? theme.colors.textSecondary
                                            : liveData.gpsNote ? theme.colors.error
                                                : theme.colors.success
                                    }
                                >
                                    {!trackingOn ? 'PAUSED' : liveData.gpsNote || 'MEASURING'}
                                </NothingText>
                                <NothingText size={10} color={theme.colors.textSecondary}>LOCATION</NothingText>
                            </View>
                        </View>
                        <View style={{ width: '100%', height: 4, backgroundColor: theme.colors.border, borderRadius: 2, marginVertical: 12 }}>
                            <View style={{ width: `${Math.min(100, (liveData.distanceMeters / 1000) / (habit.numericGoal || 1) * 100)}%`, height: '100%', backgroundColor: theme.colors.primary, borderRadius: 2 }} />
                        </View>
                        <NothingText size={11} color={theme.colors.textSecondary}>
                            {trackingOn
                                ? 'Measured from GPS fixes, so it needs open sky — indoors it will sit at zero.'
                                : 'Location released. Nothing is being measured until you switch it back on.'}
                        </NothingText>
                    </View>
                ) : null}
            </NothingCard>
        );
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
            <View style={styles.header}>
                <TouchableOpacity
                    onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Main')}
                    style={styles.backBtn}
                >
                    <ArrowLeft color={theme.colors.text} size={24} />
                </TouchableOpacity>
                <NothingText variant="bold" style={{ fontFamily: 'ndot' }} size={24}>{habit.title.toUpperCase()}</NothingText>
                <TouchableOpacity onPress={() => setShowSettings(true)}>
                    <Settings color={theme.colors.text} size={24} />
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                <View style={styles.statsRow}>
                    <NothingCard style={styles.statCard}>
                        <Flame size={20} color={theme.colors.primary} />
                        <NothingText variant="bold" size={24} style={styles.statVal}>{habit.streak}</NothingText>
                        <NothingText size={10} color={theme.colors.textSecondary}>CURRENT STREAK</NothingText>
                    </NothingCard>

                    <NothingCard style={styles.statCard}>
                        <Trophy size={20} color="#FFD700" />
                        <NothingText variant="bold" size={24} style={styles.statVal}>{habit.bestStreak}</NothingText>
                        <NothingText size={10} color={theme.colors.textSecondary}>BEST STREAK</NothingText>
                    </NothingCard>
                </View>

                <SensorInsight />

                <View style={styles.mainArea}>
                    {habit.type === 'timer' ? (
                        <View style={styles.timerContainer}>
                            <View style={[styles.circleOutline, { borderColor: theme.colors.surface2 }]}>
                                <View style={[styles.progressOverlay, {
                                    height: CIRCLE_SIZE * (1 - progress),
                                    backgroundColor: theme.colors.background,
                                    opacity: 0.5
                                }]} />
                                <NothingText variant="dot" size={64}>{formatTime(isNoiseHabit ? noiseRemaining : timeLeft)}</NothingText>
                            </View>

                            {isNoiseHabit ? (
                                /* Deep Silence has exactly the controls its widget has:
                                   the microphone switch and done/undo. The middle button
                                   is a play/pause over the service, not over a local
                                   interval, so the clock keeps running with the app
                                   closed and picks up where it left off after a restart. */
                                <>
                                    <View style={[styles.timerControls, { justifyContent: 'center', gap: 28 }]}>
                                        <TouchableOpacity
                                            style={[styles.playBtn, { backgroundColor: trackingOn ? theme.colors.primary : theme.colors.surface1 }]}
                                            onPress={toggleSensor}
                                        >
                                            {trackingOn ? (
                                                <Pause size={32} color={theme.colors.background} fill={theme.colors.background} />
                                            ) : (
                                                <Play size={32} color={theme.colors.text} fill={theme.colors.text} />
                                            )}
                                        </TouchableOpacity>

                                        <TouchableOpacity
                                            style={[styles.controlBtn, { backgroundColor: theme.colors.surface1 }]}
                                            onPress={() => toggleHabit(habitId, today)}
                                        >
                                            {isCompletedToday ? (
                                                <X size={24} color={theme.colors.error} />
                                            ) : (
                                                <Check size={24} color={theme.colors.success} />
                                            )}
                                        </TouchableOpacity>
                                    </View>

                                    {/*
                                      The live level and the threshold marker live in
                                      the card above, so this line answers the other
                                      question: is the clock moving right now, and why.
                                      A silence timer that has simply stopped is
                                      otherwise indistinguishable from a dead mic.
                                    */}
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 }}>
                                        {trackingOn ? (
                                            <Mic size={14} color={noiseBanking ? theme.colors.success : theme.colors.error} />
                                        ) : (
                                            <MicOff size={14} color={theme.colors.textSecondary} />
                                        )}
                                        <NothingText
                                            variant="bold"
                                            size={12}
                                            color={
                                                !trackingOn
                                                    ? theme.colors.textSecondary
                                                    : noiseBanking
                                                        ? theme.colors.success
                                                        : theme.colors.error
                                            }
                                        >
                                            {!trackingOn
                                                ? 'MICROPHONE OFF'
                                                : !liveData.noiseHasReading
                                                    ? 'OPENING MICROPHONE'
                                                    : noiseBanking
                                                        ? `COUNTING · ${liveData.noise} dB`
                                                        : `PAUSED BY NOISE · ${liveData.noise} dB`}
                                        </NothingText>
                                    </View>
                                    <NothingText size={11} color={theme.colors.textSecondary} style={{ marginTop: 8, paddingHorizontal: 40, textAlign: 'center' }}>
                                        {`${Math.floor(noiseElapsed / 60)}m ${noiseElapsed % 60}s of quiet banked today, counted only while the room stays at or under ${noiseThreshold}. The count is kept if you close Rise or restart your phone.`}
                                    </NothingText>
                                </>
                            ) : (
                                <View style={styles.timerControls}>
                                    <TouchableOpacity
                                        style={[styles.controlBtn, { backgroundColor: theme.colors.surface1 }]}
                                        onPress={() => runTimerOp('reset')}
                                    >
                                        <RotateCcw size={24} color={theme.colors.text} />
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={[styles.playBtn, { backgroundColor: theme.colors.primary }]}
                                        onPress={() => runTimerOp('toggle')}
                                    >
                                        {isTimerRunning ?
                                            <Pause size={32} color={theme.colors.background} fill={theme.colors.background} /> :
                                            <Play size={32} color={theme.colors.background} fill={theme.colors.background} />
                                        }
                                    </TouchableOpacity>

                                    {/* Marks the habit done. It used to set the clock to
                                        zero instead, which looked like completion but
                                        touched nothing the streak reads. */}
                                    <TouchableOpacity
                                        style={[styles.controlBtn, { backgroundColor: theme.colors.surface1 }]}
                                        onPress={() => {
                                            Vibration.vibrate(20);
                                            toggleHabit(habitId, today);
                                        }}
                                    >
                                        {isCompletedToday ? (
                                            <X size={24} color={theme.colors.error} />
                                        ) : (
                                            <Check size={24} color={theme.colors.success} />
                                        )}
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    ) : habit.type === 'numeric' ? (
                        <View style={styles.checkContainer}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 32 }}>
                                {/* Manual controls are for habits a person counts. A
                                    step, distance or movement goal is counted by the
                                    sensor in real time, so + and − are gone there: they
                                    could only edit a number the next reading overwrites.
                                    Inverse-goal habits swap them for confirm/slipped. */}
                                {!isAtMost && !sensorDerived && (
                                    <TouchableOpacity
                                        style={[styles.largeCheckBtn, { width: 80, height: 80, borderRadius: 40, borderColor: theme.colors.border }]}
                                        onPress={() => useAppStore.getState().updateNumericProgress(habitId, today, -numericStep)}
                                    >
                                        <X size={32} color={theme.colors.error} />
                                    </TouchableOpacity>
                                )}

                                <View style={{ alignItems: 'center' }}>
                                    <NothingText variant="dot" size={80}>{displayedProgress}</NothingText>
                                    <NothingText color={theme.colors.textSecondary}>{displayedUnit}</NothingText>
                                </View>

                                {!isAtMost && !sensorDerived && (
                                    <TouchableOpacity
                                        style={[styles.largeCheckBtn, { width: 80, height: 80, borderRadius: 40, borderColor: theme.colors.border, backgroundColor: (habit.numericProgress?.[today] || 0) >= (habit.numericGoal || 1) ? theme.colors.success + '20' : 'transparent' }]}
                                        onPress={() => useAppStore.getState().updateNumericProgress(habitId, today, numericStep)}
                                    >
                                        <Plus size={32} color={theme.colors.success} />
                                    </TouchableOpacity>
                                )}
                            </View>

                            <NothingText variant="bold" style={{ marginTop: 24 }}>
                                {isAtMost ? 'LIMIT' : 'GOAL'}: {sensorSlot === 'gps' && habit.numericUnit === 'km'
                                    ? ((habit.numericGoal || 0) * 1000 >= 1000
                                        ? `${habit.numericGoal}km`
                                        : `${(habit.numericGoal || 0) * 1000}m`)
                                    : `${habit.numericGoal} ${habit.numericUnit}`
                                }
                            </NothingText>

                            {sensorDerived && <SensorSwitch />}

                            {isAtMost && (
                                <>
                                    <NothingText
                                        variant="bold"
                                        size={16}
                                        style={{ marginTop: 12 }}
                                        color={isCompletedToday
                                            ? theme.colors.success
                                            : isOverLimit ? theme.colors.error : theme.colors.text}
                                    >
                                        {isCompletedToday ? 'HELD' : isOverLimit ? 'LIMIT EXCEEDED' : 'HOLDING'}
                                    </NothingText>
                                    <NothingText size={12} color={theme.colors.textSecondary} style={{ marginTop: 6, paddingHorizontal: 32, textAlign: 'center' }}>
                                        You win this one by staying under the limit, so it is only
                                        settled when the window closes at {habit.windowEndTime || '06:00'}.
                                    </NothingText>
                                    <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                                        <NothingButton
                                            variant={isCompletedToday ? 'primary' : 'secondary'}
                                            label="✓ I HELD IT"
                                            onPress={() => {
                                                if (!isCompletedToday) {
                                                    toggleHabit(habitId, today);
                                                    Vibration.vibrate(200);
                                                }
                                            }}
                                        />
                                        <NothingButton
                                            variant="secondary"
                                            label="✕ SLIPPED"
                                            onPress={() => {
                                                if (isCompletedToday) toggleHabit(habitId, today);
                                                // Record the breach so the streak reflects reality.
                                                const limit = habit.numericGoal || 1;
                                                const cur = habit.numericProgress?.[today] || 0;
                                                if (cur <= limit) {
                                                    useAppStore.getState().updateNumericProgress(habitId, today, limit - cur + 1);
                                                }
                                            }}
                                        />
                                    </View>
                                </>
                            )}
                        </View>
                    ) : (
                        <View style={styles.checkContainer}>
                            {!habit.isSensorBased ? (
                                <>
                                    <TouchableOpacity
                                        style={[
                                            styles.largeCheckBtn,
                                            { borderColor: theme.colors.border },
                                            isCompletedToday && { backgroundColor: theme.colors.text, borderColor: theme.colors.text }
                                        ]}
                                        onPress={() => toggleHabit(habitId, today)}
                                    >
                                        <Check size={80} color={isCompletedToday ? theme.colors.background : theme.colors.surface2} strokeWidth={3} />
                                    </TouchableOpacity>
                                    <NothingText variant="bold" size={18} style={{ marginTop: 24 }}>
                                        {isCompletedToday ? 'COMPLETED FOR TODAY' : 'MARK AS DONE'}
                                    </NothingText>
                                </>
                            ) : (
                                <View style={{ alignItems: 'center' }}>
                                    <View style={[styles.largeCheckBtn, { borderColor: isCompletedToday ? theme.colors.success : theme.colors.border, backgroundColor: isCompletedToday ? theme.colors.success + '10' : 'transparent' }]}>
                                        {isCompletedToday ? (
                                            <Check size={80} color={theme.colors.success} strokeWidth={3} />
                                        ) : (
                                            <Activity size={80} color={theme.colors.surface2} />
                                        )}
                                    </View>
                                    <NothingText variant="bold" size={18} style={{ marginTop: 24, color: isCompletedToday ? theme.colors.success : theme.colors.text }}>
                                        {isCompletedToday ? 'GOAL REACHED' : trackingOn ? 'WAITING FOR SENSOR...' : 'SENSOR OFF'}
                                    </NothingText>
                                    {!isCompletedToday && trackingOn && (
                                        <NothingText size={12} color={theme.colors.textSecondary} style={{ marginTop: 8, paddingHorizontal: 40, textAlign: 'center' }}>
                                            This habit is automatically verified by your sensors. Keep moving!
                                        </NothingText>
                                    )}
                                    {sensorDerived ? (
                                        /* A step or distance goal cannot honestly be
                                           closed by hand, so the switch replaces the
                                           override rather than sitting beside it. */
                                        <SensorSwitch />
                                    ) : (
                                        /* Digital Sunset is the judgement call: the phone
                                           can measure the screen time but only the user
                                           can say the evening was held. */
                                        <View style={{ marginTop: 20 }}>
                                            <NothingButton
                                                variant="secondary"
                                                label={isCompletedToday ? 'UNDO' : 'MARK DONE MANUALLY'}
                                                onPress={() => toggleHabit(habitId, today)}
                                            />
                                        </View>
                                    )}
                                </View>
                            )}
                        </View>
                    )}
                </View>

                {/* Atomic Habit Section */}
                {habit.cue && (
                    <View style={{ marginTop: 40 }}>
                        <NothingText variant="bold" size={20} style={[styles.sectionTitle, { fontFamily: 'ndot' }]}>THE HABIT LOOP</NothingText>
                        <View style={styles.loopContainer}>
                            <View style={[styles.loopStep, { borderColor: theme.colors.border }]}>
                                <View style={[styles.stepIcon, { backgroundColor: '#3B82F620' }]}>
                                    <Sparkles size={24} color="#3B82F6" />
                                </View>
                                <View style={styles.stepContent}>
                                    <NothingText variant="bold" size={14} color="#3B82F6">1. CUE</NothingText>
                                    <NothingText size={13} color={theme.colors.textSecondary}>{habit.cue}</NothingText>
                                </View>
                            </View>

                            <View style={[styles.loopStep, { borderColor: theme.colors.border }]}>
                                <View style={[styles.stepIcon, { backgroundColor: '#F472B620' }]}>
                                    <Flame size={24} color="#F472B6" />
                                </View>
                                <View style={styles.stepContent}>
                                    <NothingText variant="bold" size={14} color="#F472B6">2. CRAVING</NothingText>
                                    <NothingText size={13} color={theme.colors.textSecondary}>{habit.craving}</NothingText>
                                </View>
                            </View>

                            <View style={[styles.loopStep, { borderColor: theme.colors.border }]}>
                                <View style={[styles.stepIcon, { backgroundColor: '#A78BFA20' }]}>
                                    <Check size={24} color="#A78BFA" />
                                </View>
                                <View style={styles.stepContent}>
                                    <NothingText variant="bold" size={14} color="#A78BFA">3. RESPONSE</NothingText>
                                    <NothingText size={13} color={theme.colors.textSecondary}>{habit.response}</NothingText>
                                </View>
                            </View>

                            <View style={[styles.loopStep, { borderColor: theme.colors.border }]}>
                                <View style={[styles.stepIcon, { backgroundColor: '#34D39920' }]}>
                                    <Trophy size={24} color="#34D399" />
                                </View>
                                <View style={styles.stepContent}>
                                    <NothingText variant="bold" size={14} color="#34D399">4. REWARD</NothingText>
                                    <NothingText size={13} color={theme.colors.textSecondary}>{habit.reward}</NothingText>
                                </View>
                            </View>
                        </View>

                        <View style={[styles.howToSection, { borderColor: theme.colors.primary + '40', backgroundColor: theme.colors.primary + '05' }]}>
                            <NothingText variant="bold" size={16} color={theme.colors.primary} style={{ marginBottom: 8 }}>How to Grow this Habit</NothingText>
                            <NothingText size={14} style={{ lineHeight: 20 }}>{habit.howToApply || 'Apply the 4 Laws of Behavior Change: Make it Obvious, Make it Attractive, Make it Easy, and Make it Satisfying.'}</NothingText>
                        </View>
                    </View>
                )}

                <View style={styles.historyHeader}>
                    <NothingText variant="bold" size={14} style={styles.sectionTitle}>HISTORY</NothingText>
                    {hasProgressHistory && (
                        <View style={[styles.historyToggle, { borderColor: theme.colors.border }]}>
                            {([['streak', 'STREAK'], ['full', 'PROGRESS']] as const).map(([key, label]) => {
                                const on = (key === 'full') === historyFull;
                                return (
                                    <TouchableOpacity
                                        key={key}
                                        onPress={() => {
                                            setHistoryFull(key === 'full');
                                            setPeekDate(null);
                                        }}
                                        style={[
                                            styles.historyToggleBtn,
                                            on && { backgroundColor: theme.colors.surface2 },
                                        ]}
                                    >
                                        <NothingText
                                            variant="bold"
                                            size={9}
                                            color={on ? theme.colors.text : theme.colors.textSecondary}
                                            style={{ letterSpacing: 1.4 }}
                                        >
                                            {label}
                                        </NothingText>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    )}
                </View>

                <NothingCard style={styles.historyCard}>
                    {historyFull && hasProgressHistory ? (
                        <>
                            <View style={styles.heatmap}>
                                {Array.from({ length: 35 }).map((_, i) => {
                                    const date = dayjs().subtract(34 - i, 'day').format('YYYY-MM-DD');
                                    const isFuture = dayjs(date).isAfter(dayjs(), 'day');
                                    const { ratio, met, value } = describeDay(date);
                                    const selected = peekDate === date;

                                    // A future day is a faint placeholder — nothing has
                                    // happened yet. A past/today cell with any progress is
                                    // tinted by how full it got; one with none reads like a
                                    // missed day on the streak grid, so the two views line up.
                                    const hasProgress = value > 0;
                                    const tint = met ? theme.colors.success : theme.colors.primary;
                                    const bg = isFuture
                                        ? theme.colors.surface2
                                        : hasProgress
                                            ? tint
                                            : theme.colors.error;
                                    const opacity = isFuture
                                        ? 0.35
                                        : hasProgress
                                            // Floor the fill so even a token amount is visibly
                                            // more than a blank day, then scale with the ratio.
                                            ? 0.25 + 0.75 * Math.max(0, Math.min(1, ratio))
                                            : 0.3;

                                    return (
                                        <TouchableOpacity
                                            key={i}
                                            activeOpacity={0.7}
                                            disabled={isFuture}
                                            onPress={() => setPeekDate(selected ? null : date)}
                                            style={[
                                                styles.heatDot,
                                                {
                                                    backgroundColor: bg,
                                                    opacity,
                                                    borderWidth: selected ? 1.5 : 0,
                                                    borderColor: theme.colors.text,
                                                },
                                            ]}
                                        />
                                    );
                                })}
                            </View>

                            {/* The exact figure for whichever cell was tapped, or a prompt
                                to tap one. This is where "5 / 8 glasses" actually gets read;
                                the squares only carry the shape of the month. */}
                            {(() => {
                                if (!peekDate) {
                                    return (
                                        <NothingText
                                            size={11}
                                            color={theme.colors.textSecondary}
                                            style={{ marginTop: 14, textAlign: 'center' }}
                                        >
                                            Tap a day to see how much you did.
                                        </NothingText>
                                    );
                                }
                                const d = describeDay(peekDate);
                                return (
                                    <View style={{ marginTop: 14, alignItems: 'center' }}>
                                        <NothingText size={11} color={theme.colors.textSecondary} style={{ letterSpacing: 1 }}>
                                            {dayjs(peekDate).format('ddd, D MMM').toUpperCase()}
                                        </NothingText>
                                        <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 4 }}>
                                            <NothingText
                                                variant="bold"
                                                size={20}
                                                color={d.met ? theme.colors.success : theme.colors.text}
                                            >
                                                {d.valueText}
                                            </NothingText>
                                            <NothingText size={13} color={theme.colors.textSecondary} style={{ marginBottom: 1 }}>
                                                {dayGoal > 0 ? ` / ${d.goalText}` : ''}{d.unit ? ` ${d.unit}` : ''}
                                            </NothingText>
                                        </View>
                                        {dayGoal > 0 && (
                                            <NothingText
                                                size={10}
                                                color={d.met ? theme.colors.success : theme.colors.textSecondary}
                                                style={{ marginTop: 2, letterSpacing: 1 }}
                                            >
                                                {d.met ? (inverse ? 'HELD' : 'GOAL MET') : inverse ? 'OVER LIMIT' : `${Math.round(Math.min(1, d.ratio) * 100)}% OF GOAL`}
                                            </NothingText>
                                        )}
                                    </View>
                                );
                            })()}

                            <NothingText
                                size={10}
                                color={theme.colors.textSecondary}
                                style={{ marginTop: 14, textAlign: 'center', lineHeight: 15 }}
                            >
                                {`Last 35 days. ${inverse ? 'Fuller squares are days you stayed under the limit.' : 'Fuller squares are days you did more toward the goal.'} Older days are cleared automatically.`}
                            </NothingText>
                        </>
                    ) : (
                        <View style={styles.heatmap}>
                            {Array.from({ length: 35 }).map((_, i) => {
                                const date = dayjs().subtract(34 - i, 'day').format('YYYY-MM-DD');
                                const active = habit.completedDates.includes(date);
                                const isPast = dayjs(date).isBefore(dayjs(), 'day');
                                const missed = isPast && !active;
                                return (
                                    <View
                                        key={i}
                                        style={[
                                            styles.heatDot,
                                            {
                                                backgroundColor: active
                                                    ? theme.colors.text
                                                    : missed
                                                        ? theme.colors.error
                                                        : theme.colors.surface2,
                                                opacity: active ? 1 : missed ? 0.3 : 0.5
                                            }
                                        ]}
                                    />
                                );
                            })}
                        </View>
                    )}
                </NothingCard>

                <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => setShowDeleteConfirm(true)}
                >
                    <Trash2 size={20} color={theme.colors.error} />
                    <NothingText color={theme.colors.error} style={{ marginLeft: 8 }}>Delete Habit</NothingText>
                </TouchableOpacity>
            </ScrollView>

            <Modal
                transparent={true}
                visible={showSettings}
                animationType="fade"
                onRequestClose={() => setShowSettings(false)}
            >
                <TouchableOpacity
                    style={styles.modalOverlay}
                    activeOpacity={1}
                    onPress={() => setShowSettings(false)}
                >
                    <NothingCard
                        style={[styles.modalContent, { backgroundColor: theme.colors.surface }]}
                        padding="lg"
                        onStartShouldSetResponder={() => true}
                    >
                        <View style={styles.modalHeader}>
                            <NothingText variant="bold" style={{ fontFamily: 'ndot' }} size={20}>EDIT HABIT</NothingText>
                            <TouchableOpacity onPress={() => setShowSettings(false)}>
                                <X color={theme.colors.text} size={24} />
                            </TouchableOpacity>
                        </View>

                        <NothingInput
                            placeholder="Habit Name"
                            value={editTitle}
                            onChangeText={setEditTitle}
                        />

                        {habit.type === 'timer' && (
                            <View style={{ marginTop: 16 }}>
                                <NothingText variant="bold" size={14} style={{ marginBottom: 12, fontFamily: 'ndot' }}>GOAL DURATION (MINS)</NothingText>
                                <NothingInput
                                    placeholder="10"
                                    value={editGoal}
                                    onChangeText={setEditGoal}
                                    keyboardType="numeric"
                                />
                            </View>
                        )}

                        <NothingButton
                            label="Save Changes"
                            onPress={handleSaveSettings}
                            style={{ marginTop: 24 }}
                        />

                        <NothingButton
                            label="Pin to Widget"
                            onPress={() => {
                                if (WidgetBridge && typeof WidgetBridge.pinHabit === 'function') {
                                    WidgetBridge.pinHabit(habitId, habit.title);
                                    setShowSettings(false);
                                }
                            }}
                            style={{ marginTop: 12 }}
                        />

                        <TouchableOpacity
                            style={[styles.deleteBtn, { marginTop: 24 }]}
                            onPress={() => {
                                setShowSettings(false);
                                setShowDeleteConfirm(true);
                            }}
                        >
                            <Trash2 size={18} color={theme.colors.error} />
                            <NothingText color={theme.colors.error} size={14} style={{ marginLeft: 8 }}>Delete Habit</NothingText>
                        </TouchableOpacity>
                    </NothingCard>
                </TouchableOpacity>
            </Modal>

            <ConfirmationModal
                visible={showDeleteConfirm}
                title="DELETE HABIT"
                message={`Are you sure you want to delete "${habit.title}"? This action cannot be undone.`}
                type="danger"
                onConfirm={() => {
                    setShowDeleteConfirm(false);
                    deleteHabit(habitId);
                    navigation.goBack();
                }}
                onCancel={() => setShowDeleteConfirm(false)}
            />
        </SafeAreaView>
    );
};

