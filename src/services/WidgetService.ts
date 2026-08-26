import { NativeModules, Platform } from 'react-native';
import dayjs from 'dayjs';

// Accessing NativeModules safely
const WidgetBridge = NativeModules.WidgetBridge;

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

            // Dedicated payload for the 5 sensor widgets
            const sensorData: any = {};
            const sensorTypes = ['pedometer', 'gps', 'noise', 'movement', 'screen'];

            sensorTypes.forEach(type => {
                const habit = (habits || []).find((h: any) => {
                    if (h.sensorType === type) return true;
                    const lowerTitle = (h.title || '').toLowerCase();
                    if (type === 'pedometer' && (lowerTitle.includes('step') || lowerTitle.includes('walk') || h.sensorType === 'pedometer')) return true;
                    if (type === 'gps' && (lowerTitle.includes('glider') || lowerTitle.includes('city') || lowerTitle.includes('distance') || lowerTitle.includes('bike') || h.sensorType === 'gps')) return true;
                    if (type === 'noise' && (lowerTitle.includes('silence') || lowerTitle.includes('quiet') || lowerTitle.includes('meditation') || h.sensorType === 'noise')) return true;
                    if (type === 'movement' && (lowerTitle.includes('rise') || lowerTitle.includes('immediate') || lowerTitle.includes('snooze') || h.sensorType === 'movement')) return true;
                    if (type === 'screen' && (lowerTitle.includes('sunset') || lowerTitle.includes('phone') || lowerTitle.includes('night') || h.sensorType === 'screen')) return true;
                    return false;
                });

                if (habit) {
                    let progress = habit.numericProgress?.[today] || 0;
                    let goal = habit.numericGoal || (habit.type === 'timer' ? (habit.timerGoal || 3600) : 1);
                    let unit = habit.numericUnit || '';

                    if (type === 'gps') {
                        if (!unit) unit = 'KM';
                        if (!habit.numericGoal) goal = 2.0;
                    } else if (type === 'movement') {
                        goal = habit.numericGoal || 50;
                        unit = 'STEPS';
                    } else if (type === 'noise') {
                        goal = habit.timerGoal || 3600;
                        unit = 'MINUTES';
                        progress = habit.timerProgress?.[today] || progress;
                    } else if (type === 'pedometer') {
                        goal = habit.numericGoal || 10000;
                        unit = 'STEPS';
                    }

                    sensorData[type] = {
                        id: habit.id,
                        title: habit.title,
                        progress,
                        goal,
                        unit,
                        exists: true,
                        isCompleted: habit.completedDates?.includes(today) || false
                    };
                } else {
                    sensorData[type] = { exists: false };
                }
            });

            if (typeof WidgetBridge.setSensorData === 'function') {
                WidgetBridge.setSensorData(JSON.stringify(sensorData));
            } else {
                WidgetBridge.setWidgetData(JSON.stringify({ ...limitedItems, sensorData }));
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
        } catch (e) {
            console.error('WidgetService: Failed to clear widget data', e);
        }
    }
};
