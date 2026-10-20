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
import {
    buildNormalizedHabits,
    getHabitsArray,
    recomputeStreaks
} from '../utils/NormalizedHabitStore';
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
 * How many days of per-day partial progress the full-history view keeps.
 *
 * The history grid shows a rolling month. 35 rather than 30 so the grid is a clean
 * five weeks and a 30-day-ago cell is never on the edge of being dropped while it is
 * still on screen; a few days of slack also absorbs a user a day or two behind their
 * device clock.
 */
export const PROGRESS_HISTORY_DAYS = 35;

/**
 * Drop per-day progress entries older than the rolling window.
 *
 * This is the whole of the "discard history older than a month" rule, and it is
 * deliberately scoped to the two partial-progress maps (numericProgress,
 * timerProgress). It must NEVER touch completedDates: that list is the binary
 * completion log the streaks are computed from, and bestStreak is the longest run
 * *anywhere* in history — prune it and you silently shorten a record the user earned
 * months ago. Partial values, by contrast, are only ever read for the last month of
 * the detail grid, so an older entry is pure dead weight in the saved file.
 *
 * Returns the same object when nothing was out of range, so a habit that has not been
 * touched in a while does not get a new identity (and a needless re-render) on load.
 * Compares on the YYYY-MM-DD key directly — the keys are local date strings, so a
 * lexical compare is a chronological one and there is no timezone round-trip.
 */
const pruneProgressMaps = (habit: Habit, today: string): Habit => {
    const cutoff = dayjs(today).subtract(PROGRESS_HISTORY_DAYS - 1, 'day').format('YYYY-MM-DD');

    const prune = (map?: Record<string, number>): Record<string, number> | 'unchanged' => {
        if (!map) return 'unchanged';
        const kept: Record<string, number> = {};
        let dropped = false;
        for (const key in map) {
            // Keep anything on or after the cutoff. A key in the future (a device whose
            // clock jumped) is on-or-after today and so is kept, never discarded.
            if (key >= cutoff) kept[key] = map[key];
            else dropped = true;
        }
        return dropped ? kept : 'unchanged';
    };

    const nextNumeric = prune(habit.numericProgress);
    const nextTimer = prune(habit.timerProgress);
    if (nextNumeric === 'unchanged' && nextTimer === 'unchanged') return habit;

    const next: Habit = { ...habit };
    if (nextNumeric !== 'unchanged') next.numericProgress = nextNumeric;
    if (nextTimer !== 'unchanged') next.timerProgress = nextTimer;
    return next;
};

/**
 * Reconciles every saved habit against its template on load.
 *
 * Two jobs. It backfills `templateId` for habits saved before that field existed —
 * title matching is only acceptable here, at load, as a migration, and must never
 * be used for runtime widget binding, which was the original bug. And it repairs
 * the sensor wiring of habits that already have a templateId, because a stale or
 * missing `sensorType` unbinds a habit from its sensor while leaving its widget
 * looking perfectly healthy.
 *
 * Also repairs the sensor habits whose templates had no usable goal: Digital
 * Sunset was a bare 'check' with no goal, target time or allowance, and
 * Immediate Rise was a 'check' that one detected step could complete.
 */
const migrateHabits = (habits: Habit[]): Habit[] => {
    // Required lazily to keep the module graph acyclic at runtime.
    const { COMMON_HABITS_TEMPLATES } = require('../utils/HabitTemplates');
    const templates: any[] = COMMON_HABITS_TEMPLATES;

    // One local "today" for the rolling-window prune below, computed once rather than
    // per habit. Local, not UTC: the progress keys are local date strings.
    const today = dayjs().format('YYYY-MM-DD');

    return habits.map((h) => {
        /*
          Bind by id when the habit has one, and fall back to the title only as the
          original migration for habits saved before templateId existed.

          A habit that already carries a templateId used to return early here, which
          was wrong: its sensor wiring still has to be reconciled against the template
          on every load. Widgets bind slot to habit by templateId, while the native
          sensor config, the store commit and the foreground fallback all matched on
          sensorType, so a habit carrying a templateId and a missing or stale
          sensorType got a perfectly rendered widget and no sensor behind it — no
          permission request, no readings, no commits. City Glider showed a distance
          widget whose metres never moved for exactly this reason, and the early
          return is what kept it broken across every launch.
        */
        const match = h.templateId
            ? templates.find((t) => t.id === h.templateId)
            : templates.find((t) => t.title.toLowerCase() === (h.title || '').toLowerCase());
        if (!match) return pruneProgressMaps(h, today);

        const next: Habit = { ...h, templateId: match.id };

        /*
          Sensor wiring. The slot fields are *corrected*, not merely filled in,
          because a wrong sensorType silently unbinds the habit from its sensor.
          Everything below this block stays fill-if-absent so a habit the user has
          customised keeps their goal, unit and window.

          Repairing isSensorBased cannot re-enable a sensor someone switched off:
          pausing goes through setSlotTracking on the native service and lands in
          TrackingState, never in this flag.
        */
        if (match.isSensorBased) {
            if (next.sensorType !== match.sensorType) next.sensorType = match.sensorType;
            if (!next.isSensorBased) next.isSensorBased = true;
        } else if (next.isSensorBased === undefined) {
            next.isSensorBased = match.isSensorBased;
        }
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

        // Discard partial progress older than the rolling window as the last step, so
        // every freshly-loaded habit — matched or not — carries at most a month of it.
        return pruneProgressMaps(next, today);
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
    /**
     * Habits in "database" shape: a byId map plus an id-order array, instead of a
     * flat Habit[]. Lets a single habit update rebuild one object and shallow-copy
     * one map, so only the touched habit changes identity and memoized rows for
     * other habits do not re-render. Read via the selectors in src/store/selectors.ts;
     * the flat array still lives on disk (see getHabitsArray in saveData).
     */
    habitsById: Record<string, Habit>;
    habitIds: string[];
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
let widgetDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastTimerWidgetPush = 0;

/** Build the flat tasks + habits arrays the widget bridge expects from store state. */
const widgetArraysFor = (state: AppState): { tasks: Task[]; habits: Habit[] } => ({
    tasks: getTasksArray({
        byId: state.tasksById,
        allIds: state.taskIds,
        byCategory: state.tasksByCategory,
        byDate: state.tasksByDate,
        byStatus: state.tasksByStatus
    }),
    habits: getHabitsArray({ byId: state.habitsById, allIds: state.habitIds })
});

/** Serialize current state to the native widgets now. The expensive path (rebuilds
 *  every habit's heatmap), so callers debounce/throttle it rather than firing it on
 *  every keystroke. */
const pushWidgetNow = (get: () => AppState) => {
    try {
        const state = get();
        if (!state.activeProfile) return;
        const { tasks, habits } = widgetArraysFor(state);
        WidgetService.updateWidget(tasks, habits, state.labels, state.activeTimer);
    } catch (e) {
        console.warn('Failed widget update', e);
    }
};

const scheduleSave = (get: () => AppState) => {
    // Debounce the widget serialize (B5). It used to run synchronously on EVERY
    // mutation — so a slider drag or a burst of toggles rebuilt all habit heatmaps
    // (O(habits × 35 days) of dayjs work) on every single step, which is a large
    // part of the tab-switch lag. The in-app UI still updates instantly from
    // zustand; only the home-screen widget trails the burst by ~200ms, which is
    // imperceptible for a widget.
    if (widgetDebounceTimer) clearTimeout(widgetDebounceTimer);
    widgetDebounceTimer = setTimeout(() => {
        widgetDebounceTimer = null;
        pushWidgetNow(get);
    }, 200);

    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
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
    habitsById: {},
    habitIds: [],
    labels: DEFAULT_LABELS,
    activeTimer: null,

    login: async (profile) => {
        set({ activeProfile: profile, currentUser: profile.name });
        await get().loadData(profile.id);

        // Persist this profile as the default on EVERY login, not only when none is
        // set (P-03). The default is "the profile to reopen into", so switching
        // profiles has to move it — otherwise a cold start (and the widgets) keep
        // landing on whichever profile happened to be first-ever, which is how the
        // app appeared to "log into the wrong profile".
        try {
            await SettingsService.updateSettings({ defaultProfile: profile.id });
        } catch (e) {
            console.warn('Failed to persist default profile on login', e);
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
            habitsById: {},
            habitIds: [],
            labels: DEFAULT_LABELS
        });
        await get().saveData();
        // A freshly created profile is the one the user is now in, so make it the
        // default too (P-04). Without this, creating a profile left the default
        // pointing at a previous one and the next launch logged into that instead.
        try {
            await SettingsService.updateSettings({ defaultProfile: id });
        } catch (e) {
            console.warn('Failed to persist default profile on create', e);
        }
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
        if (widgetDebounceTimer) {
            clearTimeout(widgetDebounceTimer);
            widgetDebounceTimer = null;
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
            habitsById: {},
            habitIds: [],
            // Reset labels to the defaults so the next profile does not inherit the
            // previous user's custom labels before its own data loads (P-10).
            labels: DEFAULT_LABELS
        });
        // Clear the persisted default (P-10): an explicit logout must not auto-login
        // the same profile on next launch. updateSettings merges and JSON.stringify
        // drops the undefined key, so this genuinely removes it from the file.
        SettingsService.updateSettings({ defaultProfile: undefined }).catch((e) =>
            console.warn('Failed to clear default profile on logout', e)
        );
    },

    loadData: async (id) => {
        const data = await StorageService.loadUserData(id);
        if (data) {
            const loadedTasks: Task[] = data.tasks || [];
            const normalized = buildNormalizedTasks(loadedTasks);
            const habitsArr = migrateHabits(data.habits || []);
            const normalizedHabits = buildNormalizedHabits(habitsArr);
            set({
                activeProfile: { id: id, name: data.name || get().activeProfile?.name || id },
                currentUser: data.name || get().currentUser,
                tasks: loadedTasks,
                tasksById: normalized.byId,
                taskIds: normalized.allIds,
                tasksByCategory: normalized.byCategory,
                tasksByDate: normalized.byDate,
                tasksByStatus: normalized.byStatus,
                habitsById: normalizedHabits.byId,
                habitIds: normalizedHabits.allIds,
                labels: data.labels && Array.isArray(data.labels) && typeof data.labels[0] === 'object'
                    ? data.labels
                    : (data.labels || DEFAULT_LABELS).map((l: any) => typeof l === 'string' ? { id: Math.random().toString(36).substr(2, 9), name: l } : l)
            });
            const loadedLabels = data.labels && Array.isArray(data.labels) ? data.labels : DEFAULT_LABELS;
            WidgetService.updateWidget(loadedTasks, habitsArr, loadedLabels, get().activeTimer);
        } else {
            set({
                tasks: [],
                tasksById: {},
                taskIds: [],
                tasksByCategory: {},
                tasksByDate: {},
                tasksByStatus: { active: [], completed: [] },
                habitsById: {},
                habitIds: []
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
        const { activeProfile, labels, tasksById, taskIds, tasksByCategory, tasksByDate, tasksByStatus } = state;
        if (activeProfile) {
            const allTasks = getTasksArray({
                byId: tasksById,
                allIds: taskIds,
                byCategory: tasksByCategory,
                byDate: tasksByDate,
                byStatus: tasksByStatus
            });
            // Serialize habits back to a flat array for storage — the on-disk shape
            // stays {id,name,tasks[],habits[],labels}, so this change is in-memory
            // only and never rewrites or drops a user's saved habits.
            const habits = getHabitsArray({ byId: state.habitsById, allIds: state.habitIds });
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

        // Only touch notifications when a field the schedule actually depends on
        // changed (T-04): editing a title or toggling a subtask must not re-arm
        // reminders. When it IS relevant, call unconditionally — scheduleTaskReminders
        // cancels first, so clearing the reminders array genuinely clears them (T-02),
        // which the old `reminders.length > 0` guard failed to do.
        const reminderRelevant =
            updates.reminders !== undefined ||
            updates.dueDate !== undefined ||
            updates.dueTime !== undefined;
        if (reminderRelevant) {
            const t = get().tasksById[id];
            if (t) {
                notificationService.scheduleTaskReminders({
                    id: t.id,
                    title: t.title,
                    dueDate: t.dueDate,
                    dueTime: t.dueTime,
                    reminders: t.reminders
                });
            }
        }
    },

    toggleTask: (id) => {
        let toggled: Task | undefined;
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
            const { newState: updated, toggledTask } = toggleTaskInNormalized(currentNormalized, id);
            toggled = toggledTask;
            return {
                tasksById: updated.byId,
                taskIds: updated.allIds,
                tasksByCategory: updated.byCategory,
                tasksByDate: updated.byDate,
                tasksByStatus: updated.byStatus
            };
        });
        scheduleSave(get);

        // Reconcile reminders with the new completion state (T-01). Completing a task
        // silences its reminders — a done task should not keep nagging. A recurring
        // task comes back as not-completed with its dueDate advanced to the next
        // occurrence, so we re-arm from the current fields; that is exactly the
        // "daily reminder keeps firing after completion" case the user reported.
        const t = toggled;
        if (t) {
            if (t.completed) {
                notificationService.cancelTaskReminders(t.id);
            } else if (t.reminders && t.reminders.length > 0) {
                notificationService.scheduleTaskReminders({
                    id: t.id,
                    title: t.title,
                    dueDate: t.dueDate,
                    dueTime: t.dueTime,
                    reminders: t.reminders
                });
            }
        }
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
        const newHabit: Habit = {
            ...habit,
            id: newId,
            completedDates: [],
            numericProgress: {},
            timerProgress: {},
            streak: 0,
            bestStreak: 0,
        };
        set((state) => ({
            habitsById: { ...state.habitsById, [newId]: newHabit },
            habitIds: [...state.habitIds, newId],
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
            const h = state.habitsById[id];
            if (!h) return {};
            const isCompleted = h.completedDates.includes(date);
            const completedDates = isCompleted
                ? h.completedDates.filter((d) => d !== date)
                : [...h.completedDates, date];
            const { streak, bestStreak } = recomputeStreaks(completedDates, h.bestStreak);
            if (!isCompleted) {
                SoundService.playSound('complete');
            }
            return {
                habitsById: { ...state.habitsById, [id]: { ...h, completedDates, streak, bestStreak } }
            };
        });
        scheduleSave(get);
    },

    updateNumericProgress: (id, date, amount) => {
        set((state) => {
            const h = state.habitsById[id];
            if (!h || h.type !== 'numeric') return {};
            const currentProgress = h.numericProgress?.[date] || 0;
            const newProgress = Math.max(0, currentProgress + amount);
            const numericProgress = { ...h.numericProgress, [date]: newProgress };
            const completedDates = applyCompletion(
                h.completedDates,
                date,
                derivesCompletion(h, newProgress, h.numericGoal || 1)
            );
            const { streak, bestStreak } = recomputeStreaks(completedDates, h.bestStreak);
            return {
                habitsById: {
                    ...state.habitsById,
                    [id]: { ...h, numericProgress, completedDates, streak, bestStreak }
                }
            };
        });
        scheduleSave(get);
    },

    updateTimerProgress: (id, date, seconds) => {
        set((state) => {
            const h = state.habitsById[id];
            if (!h || h.type !== 'timer') return {};
            const currentProgress = h.timerProgress?.[date] || 0;
            const newProgress = currentProgress + seconds;
            const timerProgress = { ...h.timerProgress, [date]: newProgress };
            const completedDates = applyCompletion(
                h.completedDates,
                date,
                derivesCompletion(h, newProgress, h.timerGoal || 1)
            );
            const { streak, bestStreak } = recomputeStreaks(completedDates, h.bestStreak);
            return {
                habitsById: {
                    ...state.habitsById,
                    [id]: { ...h, timerProgress, completedDates, streak, bestStreak }
                }
            };
        });
        scheduleSave(get);
    },

    updateHabit: (id, updates) => {
        set((state) => {
            const h = state.habitsById[id];
            if (!h) return {};
            return { habitsById: { ...state.habitsById, [id]: { ...h, ...updates } } };
        });
        scheduleSave(get);

        // Re-sync reminders when an edit changes what/when they should fire (T-05):
        // a changed reminder time, or a frequency change that flips daily<->weekly
        // repetition. scheduleHabitReminders cancels first, so an emptied list clears.
        if (updates.reminders !== undefined || updates.frequency !== undefined) {
            const h = get().habitsById[id];
            if (h) {
                notificationService.scheduleHabitReminders({
                    id: h.id,
                    title: h.title,
                    reminders: h.reminders || [],
                    frequency: h.frequency
                });
            }
        }
    },

    updateSensorProgress: (id, date, value) => {
        set((state) => {
            const h = state.habitsById[id];
            if (!h) return {};
            // Sensors report an absolute running total, not a delta.
            // Route it to the field that matches the habit's own type:
            // timer habits (Deep Silence) keep seconds in timerProgress.
            // Writing everything to numericProgress is what made the
            // silence widget read 0 forever while the sensor was working.
            const isTimer = h.type === 'timer';
            const goal = isTimer ? (h.timerGoal || 1) : (h.numericGoal || 1);
            const completedDates = applyCompletion(
                h.completedDates,
                date,
                derivesCompletion(h, value, goal)
            );
            const { streak, bestStreak } = recomputeStreaks(completedDates, h.bestStreak);
            const next: Habit = isTimer
                ? { ...h, timerProgress: { ...h.timerProgress, [date]: value }, completedDates, streak, bestStreak }
                : { ...h, numericProgress: { ...h.numericProgress, [date]: value }, completedDates, streak, bestStreak };
            return { habitsById: { ...state.habitsById, [id]: next } };
        });
        scheduleSave(get);
    },

    deleteHabit: (id) => {
        notificationService.cancelHabitReminders(id);
        SoundService.playSound('delete');

        set((state) => {
            if (!state.habitsById[id]) return {};
            const habitsById = { ...state.habitsById };
            delete habitsById[id];
            return { habitsById, habitIds: state.habitIds.filter((hid) => hid !== id) };
        });
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
        let ended = false;
        set((state) => {
            if (!state.activeTimer || !state.activeTimer.isRunning) return {};
            const nextTime = state.activeTimer.timeLeft - 1;
            if (nextTime <= 0) {
                ended = true;
                SoundService.playSound('timer_end');
                // Auto-complete the habit if this was a habit timer.
                if (state.activeTimer.type === 'habit') {
                    const habitId = state.activeTimer.id;
                    const today = dayjs().format('YYYY-MM-DD');
                    const h = state.habitsById[habitId];
                    if (h && !h.completedDates.includes(today)) {
                        const completedDates = [...h.completedDates, today];
                        const { streak, bestStreak } = recomputeStreaks(completedDates, h.bestStreak);
                        return {
                            activeTimer: null,
                            habitsById: { ...state.habitsById, [habitId]: { ...h, completedDates, streak, bestStreak } }
                        };
                    }
                }
                return { activeTimer: null };
            }
            return { activeTimer: { ...state.activeTimer, timeLeft: nextTime } };
        });

        // Push to the widget on completion immediately; otherwise throttle to at most
        // once every 5s. The old code rebuilt every habit's heatmap on the widget on
        // EVERY one-second tick, which is pure waste — the native TaskTimerWidget runs
        // its own chronometer for the visible countdown, so JS only needs to reconcile
        // the value occasionally and commit the final completion.
        if (ended) {
            lastTimerWidgetPush = Date.now();
            pushWidgetNow(get);
        } else {
            const now = Date.now();
            if (now - lastTimerWidgetPush >= 5000) {
                lastTimerWidgetPush = now;
                pushWidgetNow(get);
            }
        }
    },
}));
