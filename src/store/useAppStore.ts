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
    sensorType?: 'pedometer' | 'light' | 'screen' | 'noise' | 'movement' | 'gps';
}

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
            const habits = data.habits || [];
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

                    const isCompleted = h.completedDates.includes(date);
                    const goalReached = newProgress >= (h.numericGoal || 1);
                    let newCompletedDates = [...h.completedDates];

                    if (goalReached && !isCompleted) {
                        newCompletedDates.push(date);
                    } else if (!goalReached && isCompleted) {
                        newCompletedDates = newCompletedDates.filter(d => d !== date);
                    }

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

                    const isCompleted = h.completedDates.includes(date);
                    const goalReached = newProgress >= (h.timerGoal || 1);
                    let newCompletedDates = [...h.completedDates];

                    if (goalReached && !isCompleted) {
                        newCompletedDates.push(date);
                    } else if (!goalReached && isCompleted) {
                        newCompletedDates = newCompletedDates.filter(d => d !== date);
                    }

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
                    const numericProgress = { ...h.numericProgress };
                    numericProgress[date] = value;

                    let newCompletedDates = [...h.completedDates];
                    const goalReached = value >= (h.numericGoal || 1);
                    const isCompleted = newCompletedDates.includes(date);

                    if (goalReached && !isCompleted) {
                        newCompletedDates.push(date);
                    } else if (!goalReached && isCompleted) {
                        newCompletedDates = newCompletedDates.filter(d => d !== date);
                    }

                    return { ...h, numericProgress, completedDates: newCompletedDates };
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
