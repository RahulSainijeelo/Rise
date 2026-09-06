import { NativeModules, Platform } from 'react-native';
import dayjs from 'dayjs';
import {
    SENSOR_SLOTS,
    SENSOR_PAYLOAD_VERSION,
    habitSlot,
    SUNSET_DEFAULTS,
} from './WidgetContract';
import {
    habitProgress,
    habitGoal,
    habitStep,
    habitDisplayMode,
    habitControls,
    isInverseGoal,
} from '../utils/HabitMetrics';
import { buildSensorConfig } from './SensorService';

// Accessing NativeModules safely
const WidgetBridge = NativeModules.WidgetBridge;

/**
 * Secondary status line for a sensor widget.
 *
 * Inverse-goal habits need this: "3 / 5 MIN" on its own does not tell you
 * whether you are winning, because for Digital Sunset a smaller number is
 * better and the day is not decided until the window closes.
 */
const sensorNote = (habit: any, date: string): string => {
    if (habitSlot(habit) === 'screen') {
        const cutoff = habit.cutoffTime || SUNSET_DEFAULTS.cutoffTime;
        const end = habit.windowEndTime || SUNSET_DEFAULTS.windowEndTime;
        const used = habitProgress(habit, date);
        const limit = habitGoal(habit);
        if (used > limit) return `LIMIT BROKEN AFTER ${cutoff}`;
        return `${cutoff}-${end} · ${Math.max(0, Math.round(limit - used))} MIN LEFT`;
    }
    if (isInverseGoal(habit)) {
        return habitProgress(habit, date) > habitGoal(habit) ? 'LIMIT BROKEN' : 'HOLDING';
    }
    if (habit.streak > 0) return `${habit.streak} DAY STREAK`;
    return '';
};

export interface WidgetItem {
    id: string;
    title: string;
    status: 'pending' | 'completed';
    type: 'task' | 'habit';
    habitType?: 'check' | 'timer' | 'numeric';
    category?: string;
    dueDate?: string;
    dueTime?: string;
    priority?: number;
}

export interface WidgetLabel {
    id: string;
    name: string;
}

export const WidgetService = {
    updateWidget: (tasks: any[], habits: any[], labels?: any[], activeTimer?: any) => {
        // Guard against non-Android or missing native module
        if (Platform.OS !== 'android') return;
        if (!WidgetBridge || typeof WidgetBridge.setWidgetData !== 'function') {
            console.warn('WidgetBridge native module not found or missing setWidgetData method');
            return;
        }

        try {
            const today = dayjs().format('YYYY-MM-DD');

            // Include ALL tasks with full details
            const widgetTasks: WidgetItem[] = (tasks || []).map(t => ({
                id: t.id,
                title: t.title,
                status: t.completed ? 'completed' : 'pending',
                type: 'task' as const,
                category: t.category || 'Inbox',
                dueDate: t.dueDate || today,
                dueTime: t.dueTime || undefined,
                priority: t.priority || 4
            }));

            // Include all habits with their specific types
            const widgetHabits: WidgetItem[] = (habits || []).map(h => ({
                id: h.id,
                title: h.title,
                status: h.completedDates?.includes(today) ? 'completed' : 'pending',
                type: 'habit' as const,
                habitType: h.type || 'check',
                dueDate: today,
                priority: 4
            }));

            const allItems = [...widgetTasks, ...widgetHabits];

            // Sort by date
            allItems.sort((a, b) => {
                const dateA = a.dueDate || today;
                const dateB = b.dueDate || today;
                return dateA.localeCompare(dateB);
            });

            // Limit to a reasonable number of items
            const limitedItems = allItems.slice(0, 100);

            // Also send labels if available
            const widgetLabels: WidgetLabel[] = (labels || []).map(l => ({
                id: l.id,
                name: l.name
            }));

            console.log('WidgetService: Sending', limitedItems.length, 'items and', widgetLabels.length, 'labels');

            WidgetBridge.setWidgetData(JSON.stringify(limitedItems));

            // Send labels separately if the method exists
            if (typeof WidgetBridge.setWidgetLabels === 'function') {
                WidgetBridge.setWidgetLabels(JSON.stringify(widgetLabels));
            }

            // Sync Active Timer
            if (activeTimer && typeof WidgetBridge.setTimerData === 'function') {
                WidgetBridge.setTimerData(JSON.stringify(activeTimer));
            } else if (!activeTimer && typeof WidgetBridge.setTimerData === 'function') {
                WidgetBridge.setTimerData(JSON.stringify(null));
            }

            // Sync Habit History (last 35 days for heatmap)
            if (typeof WidgetBridge.setHabitHistoryData === 'function') {
                const habitHistory: any = {};
                (habits || []).forEach(h => {
                    const history = [];
                    for (let i = 0; i < 35; i++) {
                        const date = dayjs().subtract(34 - i, 'day').format('YYYY-MM-DD');
                        history.push({
                            date,
                            completed: h.completedDates?.includes(date) || false
                        });
                    }
                    habitHistory[h.id] = {
                        title: h.title,
                        history,
                        streak: h.streak || 0,
                        bestStreak: h.bestStreak || 0
                    };
                });
                WidgetBridge.setHabitHistoryData(JSON.stringify(habitHistory));
            }

            // ---------------------------------------------------------------
            // Dedicated payload for the five sensor widgets.
            //
            // Binding is deterministic and goes through habitSlot: templateId
            // first, then an exact sensorType match, with every layer asking the
            // same function so the widget and the sensor behind it can never
            // disagree about which habit owns a slot. The previous version guessed
            // from the title (`includes('sunset') || includes('phone') ||
            // includes('night')`), so renaming a habit orphaned its widget and two
            // similarly named habits fought over one slot. It then discarded the
            // user's goal and unit in favour of hardcoded ones.
            // See docs/WIDGET_CONTRACT.md.
            // ---------------------------------------------------------------
            const sensorData: any = {
                _meta: {
                    version: SENSOR_PAYLOAD_VERSION,
                    syncedAt: Date.now(),
                    loggedIn: true,
                },
            };

            /** Habits already owned by one of the five dedicated widgets. */
            const boundIds = new Set<string>();

            SENSOR_SLOTS.forEach((slot) => {
                const habit = (habits || []).find((h: any) => habitSlot(h) === slot);

                if (!habit) {
                    sensorData[slot] = { exists: false };
                    return;
                }

                boundIds.add(habit.id);

                sensorData[slot] = {
                    exists: true,
                    id: habit.id,
                    templateId: habit.templateId,
                    // The habit's own title and unit, never a hardcoded string.
                    title: habit.title,
                    habitType: habit.type || 'check',
                    progress: habitProgress(habit, today),
                    goal: habitGoal(habit),
                    unit: (habit.numericUnit || '').toUpperCase(),
                    step: habitStep(habit),
                    displayMode: habitDisplayMode(habit),
                    goalDirection: habit.goalDirection || 'atLeast',
                    isCompleted: habit.completedDates?.includes(today) || false,
                    streak: habit.streak || 0,
                    controls: habitControls(habit),
                    live: false, // the native service flips this on when it is feeding
                    note: sensorNote(habit, today),
                };
            });

            if (typeof WidgetBridge.setSensorData === 'function') {
                WidgetBridge.setSensorData(JSON.stringify(sensorData));
            }

            // ---------------------------------------------------------------
            // Everything else, for the wrapper widget.
            //
            // The five slots above are hardcoded bindings to specific templates.
            // A habit the user invented has no slot, so it had no widget at all;
            // this is the same field set, as a list, for HabitLinkWidget to pick
            // from. Sensor-bound habits are left out on purpose — they already
            // have a widget of their own, and two widgets writing one habit's
            // progress from different models is how double-counting starts.
            // ---------------------------------------------------------------
            if (typeof WidgetBridge.setHabitsData === 'function') {
                const habitsData = (habits || [])
                    .filter((h: any) => h && h.id && !boundIds.has(h.id) && !h.isSensorBased)
                    .map((habit: any) => ({
                        exists: true,
                        id: habit.id,
                        templateId: habit.templateId,
                        title: habit.title,
                        habitType: habit.type || 'check',
                        progress: habitProgress(habit, today),
                        goal: habitGoal(habit),
                        unit: (habit.numericUnit || '').toUpperCase(),
                        step: habitStep(habit),
                        displayMode: habitDisplayMode(habit),
                        goalDirection: habit.goalDirection || 'atLeast',
                        isCompleted: habit.completedDates?.includes(today) || false,
                        streak: habit.streak || 0,
                        controls: habitControls(habit),
                        note: sensorNote(habit, today),
                    }));
                WidgetBridge.setHabitsData(JSON.stringify(habitsData));
            }

            // Hand the native service the window and threshold config it needs to
            // keep counting while the app is closed.
            if (typeof WidgetBridge.setSensorConfig === 'function') {
                WidgetBridge.setSensorConfig(JSON.stringify(buildSensorConfig(habits || [])));
            }
        } catch (e) {
            console.error('WidgetService: Failed to update widget data', e);
        }
    },

    // Call this on logout or when no user is logged in
    clearWidgetData: () => {
        if (Platform.OS !== 'android') return;
        if (!WidgetBridge || typeof WidgetBridge.setWidgetData !== 'function') return;

        try {
            // Send a special marker to indicate not logged in
            WidgetBridge.setWidgetData(JSON.stringify([{ id: '__not_logged_in__', title: 'LOGIN', status: 'pending', type: 'task' }]));

            // The sensor widgets have their own payload, so clearing widgetData
            // alone left them showing the previous user's step count.
            if (typeof WidgetBridge.setSensorData === 'function') {
                const cleared: any = {
                    _meta: { version: SENSOR_PAYLOAD_VERSION, syncedAt: Date.now(), loggedIn: false },
                };
                SENSOR_SLOTS.forEach(slot => { cleared[slot] = { exists: false }; });
                WidgetBridge.setSensorData(JSON.stringify(cleared));
            }
            if (typeof WidgetBridge.setSensorConfig === 'function') {
                WidgetBridge.setSensorConfig(JSON.stringify({}));
            }
        } catch (e) {
            console.error('WidgetService: Failed to clear widget data', e);
        }
    }
};
