import React, { useState, useEffect, useRef } from 'react';
import { View, TouchableOpacity, ScrollView, Animated, Dimensions, Vibration, Modal, NativeModules, AppState } from 'react-native';
const { WidgetBridge } = NativeModules;
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Play, Pause, RotateCcw, Flame, Trophy, Settings, Trash2, Check, X, Plus, Sparkles, Activity, Pin } from 'lucide-react-native';
import { HabitDetailScreenStyles as styles } from '../styles/Habit.styles';
import dayjs from 'dayjs';
import { useTheme } from '../theme';
import { NothingText } from '../components/NothingText';
import { NothingCard } from '../components/NothingCard';
import { NothingButton } from '../components/NothingButton';
import { NothingInput } from '../components/NothingInput';
import { ConfirmationModal } from '../components/ConfirmationModal';
import { useAppStore } from '../store/useAppStore';
import { SoundService } from '../services/SoundService';
const { width } = Dimensions.get('window');
const CIRCLE_SIZE = width * 0.7;

import { sensorService, type LiveSensorData } from '../services/SensorService';
import { habitStep, formatHabitValue, isOverLimit as habitIsOverLimit } from '../utils/HabitMetrics';

export const HabitDetailScreen = ({ route, navigation }: any) => {
    const { habitId } = route.params;
    const { theme } = useTheme();
    const { habits, updateHabit, deleteHabit, toggleHabit } = useAppStore();
    const habit = habits.find(h => h.id === habitId);

    const [isTimerRunning, setIsTimerRunning] = useState(false);
    const [timeLeft, setTimeLeft] = useState(habit?.timerGoal || 0);
    const [showSettings, setShowSettings] = useState(false);
    const [editTitle, setEditTitle] = useState(habit?.title || '');
    const [editGoal, setEditGoal] = useState(((habit?.timerGoal || 0) / 60).toString());
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // Sensor State
    //
    // This screen no longer starts sensors itself. SensorService owns the
    // hardware and this is a read-only subscription, so opening the screen can
    // no longer reset the global step count or stop tracking on unmount.
    const [liveData, setLiveData] = useState<LiveSensorData>(sensorService.getLive());

    // Assume granted until proven otherwise, so the prompt cannot flash on screens
    // where it does not belong or during the first async check.
    const [usageAccess, setUsageAccess] = useState(true);

    const timerRef = useRef<any>(null);
    const today = dayjs().format('YYYY-MM-DD');
    const isCompletedToday = habit?.completedDates.includes(today) || false;
    const isAtMost = (habit?.goalDirection || 'atLeast') === 'atMost';

    useEffect(() => {
        if (!habit?.isSensorBased) return;
        return sensorService.subscribe(setLiveData);
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
        if (habit?.sensorType !== 'screen') return;
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
    }, [habit?.sensorType]);

    // Keep the config current: adding or editing a sensor habit has to
    // reconfigure tracking, which previously only happened once at app start.
    useEffect(() => {
        if (habit?.isSensorBased) {
            sensorService.refreshConfig(useAppStore.getState);
        }
    }, [habit?.id, habit?.sensorType, habit?.numericGoal, habit?.timerGoal, habit?.cutoffTime, habit?.allowanceMinutes]);

    // Sync state when habit updates or timer goal changes
    useEffect(() => {
        if (habit) {
            setEditTitle(habit.title);
            setEditGoal(((habit.timerGoal || 0) / 60).toString());
            if (habit.type === 'timer' && !isTimerRunning) {
                setTimeLeft(habit.timerGoal || 0);
            }
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

    useEffect(() => {
        if (isTimerRunning && timeLeft > 0) {
            timerRef.current = setInterval(() => {
                setTimeLeft(prev => {
                    if (prev <= 1) {
                        setIsTimerRunning(false);
                        SoundService.playSound('timer_end');
                        if (habit && !habit.completedDates.includes(today)) {
                            toggleHabit(habitId, today);
                        }
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
        } else {
            if (timerRef.current) clearInterval(timerRef.current);
        }

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [isTimerRunning]);

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

    const progress = habit.type === 'timer' ? (timeLeft / (habit.timerGoal || 1)) : 0;

    const numericStep = habitStep(habit);
    const displayedProgress = formatHabitValue(habit, today);
    const isOverLimit = habitIsOverLimit(habit, today);

    const SensorInsight = () => {
        if (!habit.isSensorBased) return null;

        return (
            <NothingCard margin="md" style={{ backgroundColor: theme.colors.surface1, padding: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                    <Activity size={18} color={theme.colors.primary} />
                    <NothingText variant="bold" size={14} style={{ marginLeft: 8, fontFamily: 'ndot' }}>LIVE INSIGHTS</NothingText>
                    <View style={{ flex: 1 }} />
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.success, opacity: 0.8 }} />
                </View>

                {habit.sensorType === 'pedometer' || habit.sensorType === 'movement' ? (
                    <View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                            <View>
                                <NothingText variant="dot" size={48}>{liveData.steps}</NothingText>
                                <NothingText size={12} color={theme.colors.textSecondary}>STEPS DETECTED</NothingText>
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                                <NothingText variant="bold" size={14}>{liveData.activity.toFixed(1)}%</NothingText>
                                <NothingText size={10} color={theme.colors.textSecondary}>ACTIVITY LEVEL</NothingText>
                            </View>
                        </View>
                        <View style={{ height: 40, flexDirection: 'row', alignItems: 'flex-end', gap: 2, marginTop: 12 }}>
                            {Array.from({ length: 30 }).map((_, i) => (
                                <View
                                    key={i}
                                    style={{
                                        flex: 1,
                                        backgroundColor: theme.colors.primary,
                                        height: Math.max(4, Math.random() * (liveData.activity / 2)),
                                        opacity: 0.3 + (i / 30) * 0.7
                                    }}
                                />
                            ))}
                        </View>
                    </View>
                ) : habit.sensorType === 'screen' ? (
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
                ) : habit.sensorType === 'noise' ? (
                    <View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <NothingText variant="dot" size={48}>{liveData.noise}dB</NothingText>
                            <View style={{ flexDirection: 'row', gap: 4 }}>
                                {Array.from({ length: 5 }).map((_, i) => (
                                    <View
                                        key={i}
                                        style={{
                                            width: 8,
                                            height: 20 + Math.random() * 20,
                                            backgroundColor: liveData.noise > 60 ? theme.colors.error : theme.colors.success,
                                            opacity: 0.8
                                        }}
                                    />
                                ))}
                            </View>
                        </View>
                        <NothingText size={12} color={theme.colors.textSecondary}>AMBIENT NOISE LEVEL</NothingText>
                    </View>
                ) : habit.sensorType === 'gps' ? (
                    <View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <View>
                                <NothingText variant="dot" size={32}>
                                    {liveData.distanceMeters < 1000
                                        ? `${Math.floor(liveData.distanceMeters)}m`
                                        : `${Math.floor(liveData.distanceMeters / 1000)}km ${Math.floor(liveData.distanceMeters % 1000)}m`
                                    }
                                </NothingText>
                            </View>
                            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.primary + '20', alignItems: 'center', justifyContent: 'center' }}>
                                <Activity size={20} color={theme.colors.primary} />
                            </View>
                        </View>
                        {/* <View style={{ height: 1.5, backgroundColor: theme.colors.border, marginVertical: 12, opacity: 0.5 }} /> */}
                        <View style={{ width: '100%', height: 4, backgroundColor: theme.colors.border, borderRadius: 2, marginVertical: 12 }}>
                            <View style={{ width: `${Math.min(100, (liveData.distanceMeters / 1000) / (habit.numericGoal || 1) * 100)}%`, height: '100%', backgroundColor: theme.colors.primary, borderRadius: 2 }} />
                        </View>
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
                                <NothingText variant="dot" size={64}>{formatTime(timeLeft)}</NothingText>
                            </View>

                            <View style={styles.timerControls}>
                                <TouchableOpacity
                                    style={[styles.controlBtn, { backgroundColor: theme.colors.surface1 }]}
                                    onPress={() => {
                                        setIsTimerRunning(false);
                                        setTimeLeft(habit.timerGoal || 0);
                                    }}
                                >
                                    <RotateCcw size={24} color={theme.colors.text} />
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.playBtn, { backgroundColor: theme.colors.primary }]}
                                    onPress={() => setIsTimerRunning(!isTimerRunning)}
                                >
                                    {isTimerRunning ?
                                        <Pause size={32} color={theme.colors.background} fill={theme.colors.background} /> :
                                        <Play size={32} color={theme.colors.background} fill={theme.colors.background} />
                                    }
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.controlBtn, { backgroundColor: theme.colors.surface1 }]}
                                    onPress={() => {
                                        setIsTimerRunning(false);
                                        setTimeLeft(0);
                                    }}
                                >
                                    <Check size={24} color={theme.colors.success} />
                                </TouchableOpacity>
                            </View>
                        </View>
                    ) : habit.type === 'numeric' ? (
                        <View style={styles.checkContainer}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 32 }}>
                                {/* Manual controls used to be hidden for every sensor habit,
                                    which left Digital Sunset with no way to be completed at
                                    all. Sensor habits now keep a manual override; only
                                    inverse-goal habits swap it for a confirm/slipped pair. */}
                                {!isAtMost && (
                                    <TouchableOpacity
                                        style={[styles.largeCheckBtn, { width: 80, height: 80, borderRadius: 40, borderColor: theme.colors.border }]}
                                        onPress={() => useAppStore.getState().updateNumericProgress(habitId, today, -numericStep)}
                                    >
                                        <X size={32} color={theme.colors.error} />
                                    </TouchableOpacity>
                                )}

                                <View style={{ alignItems: 'center' }}>
                                    <NothingText variant="dot" size={80}>{displayedProgress}</NothingText>
                                    <NothingText color={theme.colors.textSecondary}>{habit.numericUnit?.toUpperCase()}</NothingText>
                                </View>

                                {!isAtMost && (
                                    <TouchableOpacity
                                        style={[styles.largeCheckBtn, { width: 80, height: 80, borderRadius: 40, borderColor: theme.colors.border, backgroundColor: (habit.numericProgress?.[today] || 0) >= (habit.numericGoal || 1) ? theme.colors.success + '20' : 'transparent' }]}
                                        onPress={() => useAppStore.getState().updateNumericProgress(habitId, today, numericStep)}
                                    >
                                        <Plus size={32} color={theme.colors.success} />
                                    </TouchableOpacity>
                                )}
                            </View>

                            <NothingText variant="bold" style={{ marginTop: 24 }}>
                                {isAtMost ? 'LIMIT' : 'GOAL'}: {habit.sensorType === 'gps' && habit.numericUnit === 'km'
                                    ? ((habit.numericGoal || 0) * 1000 >= 1000
                                        ? `${habit.numericGoal}km`
                                        : `${(habit.numericGoal || 0) * 1000}m`)
                                    : `${habit.numericGoal} ${habit.numericUnit}`
                                }
                            </NothingText>

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
                                        {isCompletedToday ? 'GOAL REACHED' : 'WAITING FOR SENSOR...'}
                                    </NothingText>
                                    {!isCompletedToday && (
                                        <NothingText size={12} color={theme.colors.textSecondary} style={{ marginTop: 8, paddingHorizontal: 40, textAlign: 'center' }}>
                                            This habit is automatically verified by your sensors. Keep moving!
                                        </NothingText>
                                    )}
                                    {/* Sensors miss things — a phone left on a desk, a
                                        permission not yet granted. Without an override a
                                        sensor habit could never be closed out by hand. */}
                                    <View style={{ marginTop: 20 }}>
                                        <NothingButton
                                            variant="secondary"
                                            label={isCompletedToday ? 'UNDO' : 'MARK DONE MANUALLY'}
                                            onPress={() => toggleHabit(habitId, today)}
                                        />
                                    </View>
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

                <NothingText variant="bold" size={14} style={styles.sectionTitle}>HISTORY</NothingText>
                <NothingCard style={styles.historyCard}>
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

