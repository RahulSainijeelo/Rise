import { create } from 'zustand';
import dayjs from 'dayjs';
import { StorageService } from '../services/StorageService';
import { WidgetService } from '../services/WidgetService';
import { notificationService } from '../services/NotificationService';
import { SoundService } from '../services/SoundService';
import { SettingsService } from '../services/SettingsService';
import {
    NormalizedTaskState,
    buildNormalizedTasks,
    addTaskToNormalized,
    updateTaskInNormalized,
    toggleTaskInNormalized,
    deleteTaskFromNormalized,
    getTasksArray
} from '../utils/NormalizedTaskStore';
// Type-only import: erased at compile time, so this cannot create a runtime cycle
// even though HabitTemplates imports the Habit type back from here.
import type { SensorType, GoalDirection, SunsetVerification } from '../utils/HabitTemplates';

export interface Task {
    id: string;
    title: string;
    description?: string;
    completed: boolean;
    priority: 1 | 2 | 3 | 4;
    category: string;
    dueDate?: string;
    dueTime?: string;
    duration?: number;
    repeat?: 'none' | 'daily' | 'weekly' | 'monthly';
    reminders: string[];
    subtasks: { id: string; title: string; completed: boolean }[];
}

export interface Habit {
    id: string;
    title: string;
    description?: string;
    frequency: 'daily' | 'weekly' | 'monthly';
    targetDays?: number;
    completedDates: string[];
    numericProgress?: Record<string, number>;
    streak: number;
    bestStreak: number;
    reminders: string[];
    type: 'check' | 'timer' | 'numeric';
    timerGoal?: number; // in seconds
    numericGoal?: number;
    numericUnit?: string;
    accumulatedTimeToday?: number; // for legacy timer
    timerProgress?: Record<string, number>; // New: { "date": seconds }
    color?: string;
    // Atomic Habit breakdown
    cue?: string;
    craving?: string;
    response?: string;
    reward?: string;
    howToApply?: string;
    // Sensor Information
    isSensorBased?: boolean;
    sensorType?: SensorType;
    /**
     * The HabitTemplate this habit was created from, e.g. 'digital_sunset'.
     * This is how widgets bind to habits. Before it existed, WidgetService
     * guessed from the title, so renaming a habit orphaned its widget.
     */
    templateId?: string;
    requiredPermissions?: string[];
    /**
     * 'atMost' habits are won by staying *under* the goal, so completion must
     * never be inferred from progress crossing it. Defaults to 'atLeast'.
     */
    goalDirection?: GoalDirection;
    /** Ambient dB at or below which a 'noise' habit's timer accrues. */
    noiseThresholdDb?: number;
    /** 'screen' habits: nightly window and grace allowance. */
    cutoffTime?: string;
    windowEndTime?: string;
    allowanceMinutes?: number;
    sunsetVerification?: SunsetVerification;
}

/**
 * Whether `progress` should mark `date` complete, given the habit's goal
 * direction. Returns null when completion is not derivable from progress at all
 * and must be left exactly as the user set it.
 *
 * Every progress reducer must go through this. Comparing `progress >= goal`
 * inline is what made Digital Sunset complete itself the moment you blew past
 * your own screen-time limit.
 */
const derivesCompletion = (habit: Habit, progress: number, goal: number): boolean | null => {
    if ((habit.goalDirection || 'atLeast') === 'atMost') return null;
    return progress >= (goal || 1);
};

/** Apply a derived completion to a date list without disturbing other dates. */
const applyCompletion = (completedDates: string[], date: string, reached: boolean | null): string[] => {
    if (reached === null) return completedDates;
    const isCompleted = completedDates.includes(date);
    if (reached && !isCompleted) return [...completedDates, date];
    if (!reached && isCompleted) return completedDates.filter(d => d !== date);
    return completedDates;
};

/**
 * One-time backfill for habits saved before `templateId` existed.
 *
 * Title matching is only acceptable here, at load, as a migration. It must never
 * be used for runtime widget binding — that was the original bug.
 *
 * Also repairs the sensor habits whose templates had no usable goal: Digital
 * Sunset was a bare 'check' with no goal, target time or allowance, and
 * Immediate Rise was a 'check' that one detected step could complete.
 */
const migrateHabits = (habits: Habit[]): Habit[] => {
    // Required lazily to keep the module graph acyclic at runtime.
    const { COMMON_HABITS_TEMPLATES } = require('../utils/HabitTemplates');
    const templates: any[] = COMMON_HABITS_TEMPLATES;

    return habits.map((h) => {
        if (h.templateId) return h;

        const match = templates.find((t) =>
            t.title.toLowerCase() === (h.title || '').toLowerCase()
        );
        if (!match) return h;

        const next: Habit = { ...h, templateId: match.id };

        // Adopt the template's sensor wiring if the habit predates it.
        if (next.isSensorBased === undefined) next.isSensorBased = match.isSensorBased;
        if (!next.sensorType) next.sensorType = match.sensorType;
        if (!next.requiredPermissions) next.requiredPermissions = match.requiredPermissions;
        if (next.noiseThresholdDb === undefined) next.noiseThresholdDb = match.noiseThresholdDb;

        // Inverse-goal and window config, absent from every previously saved habit.
        if (!next.goalDirection) next.goalDirection = match.goalDirection || 'atLeast';
        if (!next.cutoffTime) next.cutoffTime = match.cutoffTime;
        if (!next.windowEndTime) next.windowEndTime = match.windowEndTime;
        if (next.allowanceMinutes === undefined) next.allowanceMinutes = match.allowanceMinutes;
        if (!next.sunsetVerification) next.sunsetVerification = match.sunsetVerification;

        // A habit stored as 'check' whose template is now measured needs its type
        // and goal upgraded, or it stays uncompletable (Digital Sunset) or
        // trivially completable (Immediate Rise).
        if (h.type === 'check' && match.type !== 'check' && match.goal) {
            next.type = match.type;
            if (match.type === 'numeric') {
                next.numericGoal = next.numericGoal || match.goal;
                next.numericUnit = next.numericUnit || match.unit;
            } else if (match.type === 'timer') {
                next.timerGoal = next.timerGoal || match.goal;
            }
        }

        return next;
    });
};

export interface Label {
    id: string;
    name: string;
}

interface AppState {
    activeProfile: { id: string; name: string } | null;

    // Deprecated, use activeProfile
    currentUser: string | null;

    tasks: Task[];
    tasksById: Record<string, Task>;
    taskIds: string[];
    tasksByCategory: Record<string, string[]>;
    tasksByDate: Record<string, string[]>;
    tasksByStatus: {
        active: string[];
        completed: string[];
    };
    habits: Habit[];
    labels: Label[];

    activeTimer: {
        id: string;
        title: string;
        type: 'task' | 'habit';
        timeLeft: number;
        goal: number;
        isRunning: boolean;
    } | null;

    // Auth/Profile Actions
    login: (profile: { id: string; name: string }) => Promise<void>;
    createProfile: (name: string) => Promise<void>; // New action

    // Legacy support wrapper
    setCurrentUser: (username: string) => Promise<void>;

    logout: () => void;
    loadData: (id: string) => Promise<void>;
    saveData: () => Promise<void>;

    // Task Actions
    addTask: (task: Omit<Task, 'id' | 'completed'>) => void;
    updateTask: (id: string, updates: Partial<Task>) => void;
    toggleTask: (id: string) => void;
    deleteTask: (id: string) => void;
    addLabel: (name: string) => void;
    deleteLabel: (id: string) => void;

    // Habit Actions
    addHabit: (habit: Omit<Habit, 'id' | 'completedDates' | 'streak' | 'bestStreak'>) => void;
    toggleHabit: (id: string, date: string) => void;
    updateHabit: (id: string, updates: Partial<Habit>) => void;
    updateNumericProgress: (id: string, date: string, amount: number) => void;
    updateTimerProgress: (id: string, date: string, seconds: number) => void;
    updateSensorProgress: (id: string, date: string, value: number) => void;
    deleteHabit: (id: string) => void;

    // Timer Actions
    startTimer: (id: string, title: string, type: 'task' | 'habit', goal: number) => void;
    pauseTimer: () => void;
    resumeTimer: () => void;
    stopTimer: () => void;
    tickTimer: () => void;
}

const DEFAULT_LABELS: Label[] = [
    { id: 'l1', name: 'Inbox' },
    { id: 'l2', name: 'Work' },
    { id: 'l3', name: 'Personal' }
];

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleSave = (get: () => AppState) => {
    if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
    }
    // Update native widgets immediately on every state change
    try {
        const state = get();
        if (state.activeProfile) {
            const allTasks = getTasksArray({
                byId: state.tasksById,
                allIds: state.taskIds,
                byCategory: state.tasksByCategory,
                byDate: state.tasksByDate,
                byStatus: state.tasksByStatus
            });
            WidgetService.updateWidget(allTasks, state.habits, state.labels, state.activeTimer);
        }
    } catch (e) {
        console.warn('Failed immediate widget update in scheduleSave', e);
    }
    saveDebounceTimer = setTimeout(() => {
        get().saveData();
    }, 400);
};

export const useAppStore = create<AppState>((set, get) => ({
    activeProfile: null,
    currentUser: null,
    tasks: [],
    tasksById: {},
    taskIds: [],
    tasksByCategory: {},
    tasksByDate: {},
    tasksByStatus: { active: [], completed: [] },
    habits: [],
    labels: DEFAULT_LABELS,
    activeTimer: null,

    login: async (profile) => {
        set({ activeProfile: profile, currentUser: profile.name });
        await get().loadData(profile.id);

        // Auto-set as default if no default exists
        const { SettingsService } = await import('../services/SettingsService');
        const settings = await SettingsService.getSettings();
        if (!settings.defaultProfile) {
            await SettingsService.updateSettings({ defaultProfile: profile.id });
            console.log(`Auto-set ${profile.name} as default profile`);
        }
    },

    createProfile: async (name) => {
        const id = Math.random().toString(36).substr(2, 9);
        const newProfile = { id, name };
        set({
            activeProfile: newProfile,
            currentUser: name,
            tasks: [],
            tasksById: {},
            taskIds: [],
            tasksByCategory: {},
            tasksByDate: {},
            tasksByStatus: { active: [], completed: [] },
            habits: [],
            labels: DEFAULT_LABELS
        });
        await get().saveData();
    },

    // Legacy Support (Try to find ID by name or treat as legacy ID)
    setCurrentUser: async (usernameOrId) => {
        set({ currentUser: usernameOrId, activeProfile: { id: usernameOrId, name: usernameOrId } });
        await get().loadData(usernameOrId);
    },

    logout: () => {
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }
        WidgetService.clearWidgetData();
        set({
            activeProfile: null,
            currentUser: null,
            tasks: [],
            tasksById: {},
            taskIds: [],
            tasksByCategory: {},
            tasksByDate: {},
            tasksByStatus: { active: [], completed: [] },
            habits: []
        });
    },

    loadData: async (id) => {
        const data = await StorageService.loadUserData(id);
        if (data) {
            const loadedTasks: Task[] = data.tasks || [];
            const normalized = buildNormalizedTasks(loadedTasks);
            const habits = migrateHabits(data.habits || []);
            set({
                activeProfile: { id: id, name: data.name || get().activeProfile?.name || id },
                currentUser: data.name || get().currentUser,
                tasks: loadedTasks,
                tasksById: normalized.byId,
                taskIds: normalized.allIds,
                tasksByCategory: normalized.byCategory,
                tasksByDate: normalized.byDate,
                tasksByStatus: normalized.byStatus,
                habits,
                labels: data.labels && Array.isArray(data.labels) && typeof data.labels[0] === 'object'
                    ? data.labels
                    : (data.labels || DEFAULT_LABELS).map((l: any) => typeof l === 'string' ? { id: Math.random().toString(36).substr(2, 9), name: l } : l)
            });
            const loadedLabels = data.labels && Array.isArray(data.labels) ? data.labels : DEFAULT_LABELS;
            WidgetService.updateWidget(loadedTasks, habits, loadedLabels, get().activeTimer);
        } else {
            set({
                tasks: [],
                tasksById: {},
                taskIds: [],
                tasksByCategory: {},
                tasksByDate: {},
                tasksByStatus: { active: [], completed: [] },
                habits: []
            });
            WidgetService.updateWidget([], [], DEFAULT_LABELS, null);
        }
    },

    saveData: async () => {
        if (saveDebounceTimer) {
            clearTimeout(saveDebounceTimer);
            saveDebounceTimer = null;
        }
        const state = get();
        const { activeProfile, habits, labels, tasksById, taskIds, tasksByCategory, tasksByDate, tasksByStatus } = state;
        if (activeProfile) {
            const allTasks = getTasksArray({
                byId: tasksById,
                allIds: taskIds,
                byCategory: tasksByCategory,
                byDate: tasksByDate,
                byStatus: tasksByStatus
            });
            const dataToSave = {
                id: activeProfile.id,
                name: activeProfile.name,
                tasks: allTasks,
                habits,
                labels
            };
            await StorageService.saveUserData(activeProfile.id, dataToSave);
            WidgetService.updateWidget(allTasks, habits, labels, state.activeTimer);
        }
    },

    addTask: (task) => {
        const newId = Math.random().toString(36).substr(2, 9);
        const newTask: Task = {
            ...task,
            id: newId,
            completed: false,
            subtasks: task.subtasks || []
        };

        set((state) => {
            const currentNormalized: NormalizedTaskState = {
                byId: state.tasksById,
                allIds: state.taskIds,
                byCategory: state.tasksByCategory,
                byDate: state.tasksByDate,
                byStatus: state.tasksByStatus
            };
            const updated = addTaskToNormalized(currentNormalized, newTask);
            return {
                tasksById: updated.byId,
                taskIds: updated.allIds,
                tasksByCategory: updated.byCategory,
                tasksByDate: updated.byDate,
                tasksByStatus: updated.byStatus
            };
        });
        scheduleSave(get);

        // Schedule reminders for this task
        if (task.reminders && task.reminders.length > 0) {
            notificationService.scheduleTaskReminders({
                id: newId,
                title: task.title,
                dueDate: task.dueDate,
                dueTime: task.dueTime,
                reminders: task.reminders
            });
        }
    },

    updateTask: (id, updates) => {
        set((state) => {
            const currentNormalized: NormalizedTaskState = {
                byId: state.tasksById,
                allIds: state.taskIds,
                byCategory: state.tasksByCategory,
                byDate: state.tasksByDate,
                byStatus: state.tasksByStatus
            };
            const updated = updateTaskInNormalized(currentNormalized, id, updates);
            return {
                tasksById: updated.byId,
                taskIds: updated.allIds,
                tasksByCategory: updated.byCategory,
                tasksByDate: updated.byDate,
                tasksByStatus: updated.byStatus
            };
        });
        scheduleSave(get);

        // Re-schedule reminders if task details changed
        const updatedTask = get().tasksById[id];
        if (updatedTask && updatedTask.reminders && updatedTask.reminders.length > 0) {
            notificationService.scheduleTaskReminders(updatedTask);
        }
    },

    toggleTask: (id) => {
        set((state) => {
            const task = state.tasksById[id];
            if (task && !task.completed) {
                SoundService.playSound('complete');
            }
            const currentNormalized: NormalizedTaskState = {
                byId: state.tasksById,
                allIds: state.taskIds,
                byCategory: state.tasksByCategory,
                byDate: state.tasksByDate,
                byStatus: state.tasksByStatus
            };
            const { newState: updated } = toggleTaskInNormalized(currentNormalized, id);
            return {
                tasksById: updated.byId,
                taskIds: updated.allIds,
                tasksByCategory: updated.byCategory,
                tasksByDate: updated.byDate,
                tasksByStatus: updated.byStatus
            };
        });
        scheduleSave(get);
    },

    deleteTask: (id) => {
        // Cancel reminders before deleting
        notificationService.cancelTaskReminders(id);
        SoundService.playSound('delete');

        set((state) => {
            const currentNormalized: NormalizedTaskState = {
                byId: state.tasksById,
                allIds: state.taskIds,
                byCategory: state.tasksByCategory,
                byDate: state.tasksByDate,
                byStatus: state.tasksByStatus
            };
            const { newState: updated } = deleteTaskFromNormalized(currentNormalized, id);
            return {
                tasksById: updated.byId,
                taskIds: updated.allIds,
                tasksByCategory: updated.byCategory,
                tasksByDate: updated.byDate,
                tasksByStatus: updated.byStatus
            };
        });
        scheduleSave(get);
    },

    addLabel: (name) => {
        set((state) => ({
            labels: [...state.labels, { id: Math.random().toString(36).substr(2, 9), name }]
        }));
        scheduleSave(get);
    },

    deleteLabel: (id) => {
        set((state) => ({
            labels: state.labels.filter((l) => l.id !== id)
        }));
        scheduleSave(get);
    },

    addHabit: (habit) => {
        const newId = Math.random().toString(36).substr(2, 9);
        set((state) => ({
            habits: [...state.habits, {
                ...habit,
                id: newId,
                completedDates: [],
                numericProgress: {},
                timerProgress: {},
                streak: 0,
                bestStreak: 0,
            }]
        }));
        scheduleSave(get);

        // Schedule reminders for this habit
        if (habit.reminders && habit.reminders.length > 0) {
            notificationService.scheduleHabitReminders({
                id: newId,
                title: habit.title,
                reminders: habit.reminders,
                frequency: habit.frequency
            });
        }
    },

    toggleHabit: (id, date) => {
        set((state) => {
            const habits = state.habits.map((h) => {
                if (h.id === id) {
                    const isCompleted = h.completedDates.includes(date);
                    const newCompletedDates = isCompleted
                        ? h.completedDates.filter((d) => d !== date)
                        : [...h.completedDates, date];

                    // Recalculate streak correctly (contiguous days)
                    const sortedDates = [...newCompletedDates].sort((a, b) => b.localeCompare(a));
                    let streak = 0;
                    if (sortedDates.length > 0) {
                        const today = dayjs().format('YYYY-MM-DD');
                        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

                        if (sortedDates[0] === today || sortedDates[0] === yesterday) {
                            streak = 1;
                            for (let i = 0; i < sortedDates.length - 1; i++) {
                                const curr = dayjs(sortedDates[i]);
                                const next = dayjs(sortedDates[i + 1]);
                                if (curr.subtract(1, 'day').format('YYYY-MM-DD') === next.format('YYYY-MM-DD')) {
                                    streak++;
                                } else {
                                    break;
                                }
                            }
                        }
                    }

                    // For best streak: Recalculate based on full history to handle undo cases
                    let bestStreak = 0;
                    if (sortedDates.length > 0) {
                        let currentCount = 1;
                        bestStreak = 1;
                        for (let i = 0; i < sortedDates.length - 1; i++) {
                            const curr = dayjs(sortedDates[i]);
                            const next = dayjs(sortedDates[i + 1]);
                            if (curr.subtract(1, 'day').format('YYYY-MM-DD') === next.format('YYYY-MM-DD')) {
                                currentCount++;
                                bestStreak = Math.max(bestStreak, currentCount);
                            } else {
                                currentCount = 1;
                            }
                        }
                    }

                    if (!isCompleted) {
                        SoundService.playSound('complete');
                    }

                    return { ...h, completedDates: newCompletedDates, streak, bestStreak };
                }
                return h;
            });
            return { habits };
        });
        scheduleSave(get);
    },

    updateNumericProgress: (id, date, amount) => {
        set((state) => {
            const habits = state.habits.map((h) => {
                if (h.id === id && h.type === 'numeric') {
                    const currentProgress = h.numericProgress?.[date] || 0;
                    const newProgress = Math.max(0, currentProgress + amount);
                    const numericProgress = { ...h.numericProgress, [date]: newProgress };

                    const newCompletedDates = applyCompletion(
                        h.completedDates,
                        date,
                        derivesCompletion(h, newProgress, h.numericGoal || 1)
                    );

                    return { ...h, numericProgress, completedDates: newCompletedDates };
                }
                return h;
            });
            return { habits };
        });
        set((state) => ({
            habits: state.habits.map(h => {
                if (h.id === id) {
                    const sortedDates = [...h.completedDates].sort((a, b) => b.localeCompare(a));
                    let streak = 0;
                    if (sortedDates.length > 0) {
                        const today = dayjs().format('YYYY-MM-DD');
                        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
                        if (sortedDates[0] === today || sortedDates[0] === yesterday) {
                            streak = 1;
                            for (let i = 0; i < sortedDates.length - 1; i++) {
                                const curr = dayjs(sortedDates[i]);
                                const next = dayjs(sortedDates[i + 1]);
                                if (curr.subtract(1, 'day').format('YYYY-MM-DD') === next.format('YYYY-MM-DD')) {
                                    streak++;
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                    const bestStreak = Math.max(h.bestStreak || 0, streak);
                    return { ...h, streak, bestStreak };
                }
                return h;
            })
        }));
        scheduleSave(get);
    },

    updateTimerProgress: (id, date, seconds) => {
        set((state) => {
            const habits = state.habits.map((h) => {
                if (h.id === id && h.type === 'timer') {
                    const currentProgress = h.timerProgress?.[date] || 0;
                    const newProgress = currentProgress + seconds;
                    const timerProgress = { ...h.timerProgress, [date]: newProgress };

                    const newCompletedDates = applyCompletion(
                        h.completedDates,
                        date,
                        derivesCompletion(h, newProgress, h.timerGoal || 1)
                    );

                    return { ...h, timerProgress, completedDates: newCompletedDates };
                }
                return h;
            });
            return { habits };
        });
        set((state) => ({
            habits: state.habits.map(h => {
                if (h.id === id) {
                    const sortedDates = [...h.completedDates].sort((a, b) => b.localeCompare(a));
                    let streak = 0;
                    if (sortedDates.length > 0) {
                        const today = dayjs().format('YYYY-MM-DD');
                        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
                        if (sortedDates[0] === today || sortedDates[0] === yesterday) {
                            streak = 1;
                            for (let i = 0; i < sortedDates.length - 1; i++) {
                                const curr = dayjs(sortedDates[i]);
                                const next = dayjs(sortedDates[i + 1]);
                                if (curr.subtract(1, 'day').format('YYYY-MM-DD') === next.format('YYYY-MM-DD')) {
                                    streak++;
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                    const bestStreak = Math.max(h.bestStreak || 0, streak);
                    return { ...h, streak, bestStreak };
                }
                return h;
            })
        }));
        scheduleSave(get);
    },

    updateHabit: (id, updates) => {
        set((state) => ({
            habits: state.habits.map(h => h.id === id ? { ...h, ...updates } : h)
        }));
        scheduleSave(get);
    },

    updateSensorProgress: (id, date, value) => {
        set((state) => ({
            habits: state.habits.map(h => {
                if (h.id === id) {
                    // Sensors report an absolute running total, not a delta.
                    // Route it to the field that matches the habit's own type:
                    // timer habits (Deep Silence) keep seconds in timerProgress.
                    // Writing everything to numericProgress is what made the
                    // silence widget read 0 forever while the sensor was working.
                    const isTimer = h.type === 'timer';
                    const goal = isTimer ? (h.timerGoal || 1) : (h.numericGoal || 1);
                    const newCompletedDates = applyCompletion(
                        h.completedDates,
                        date,
                        derivesCompletion(h, value, goal)
                    );

                    if (isTimer) {
                        return {
                            ...h,
                            timerProgress: { ...h.timerProgress, [date]: value },
                            completedDates: newCompletedDates
                        };
                    }
                    return {
                        ...h,
                        numericProgress: { ...h.numericProgress, [date]: value },
                        completedDates: newCompletedDates
                    };
                }
                return h;
            })
        }));
        set((state) => ({
            habits: state.habits.map(h => {
                if (h.id === id) {
                    const sortedDates = [...h.completedDates].sort((a, b) => b.localeCompare(a));
                    let streak = 0;
                    if (sortedDates.length > 0) {
                        const today = dayjs().format('YYYY-MM-DD');
                        const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
                        if (sortedDates[0] === today || sortedDates[0] === yesterday) {
                            streak = 1;
                            for (let i = 0; i < sortedDates.length - 1; i++) {
                                const curr = dayjs(sortedDates[i]);
                                const next = dayjs(sortedDates[i + 1]);
                                if (curr.subtract(1, 'day').format('YYYY-MM-DD') === next.format('YYYY-MM-DD')) {
                                    streak++;
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                    const bestStreak = Math.max(h.bestStreak || 0, streak);
                    return { ...h, streak, bestStreak };
                }
                return h;
            })
        }));
        scheduleSave(get);
    },

    deleteHabit: (id) => {
        notificationService.cancelHabitReminders(id);
        SoundService.playSound('delete');

        set((state) => ({
            habits: state.habits.filter((h) => h.id !== id)
        }));
        scheduleSave(get);
    },

    startTimer: (id, title, type, goal) => {
        set({ activeTimer: { id, title, type, timeLeft: goal, goal, isRunning: true } });
        scheduleSave(get);
    },
    pauseTimer: () => {
        set((state) => ({
            activeTimer: state.activeTimer ? { ...state.activeTimer, isRunning: false } : null
        }));
        scheduleSave(get);
    },
    resumeTimer: () => {
        set((state) => ({
            activeTimer: state.activeTimer ? { ...state.activeTimer, isRunning: true } : null
        }));
        scheduleSave(get);
    },
    stopTimer: () => {
        set({ activeTimer: null });
        scheduleSave(get);
    },
    tickTimer: () => {
        set((state) => {
            if (!state.activeTimer || !state.activeTimer.isRunning) return { habits: state.habits };
            const nextTime = state.activeTimer.timeLeft - 1;
            if (nextTime <= 0) {
                SoundService.playSound('timer_end');
                // Auto-toggle habit if it was a habit timer
                if (state.activeTimer.type === 'habit') {
                    const habitId = state.activeTimer.id;
                    const today = dayjs().format('YYYY-MM-DD');
                    const habits = state.habits.map(h => {
                        if (h.id === habitId && !h.completedDates.includes(today)) {
                            return { ...h, completedDates: [...h.completedDates, today] };
                        }
                        return h;
                    });
                    return { activeTimer: null, habits };
                }
                return { activeTimer: null };
            }
            const updatedTimer = { ...state.activeTimer, timeLeft: nextTime };
            WidgetService.updateWidget(state.tasks, state.habits, state.labels, updatedTimer);
            return { activeTimer: updatedTimer };
        });
    },
}));
