import type { Habit } from '../store/useAppStore';
import type { WidgetControl, WidgetDisplayMode } from '../services/WidgetContract';

/**
 * Shared derivations for a habit's current numbers.
 *
 * The habit detail screen and WidgetService must agree on all of this. When they
 * disagreed, the widget invented its own goals and units ("STEPS", 10000) and
 * read progress out of the wrong field, so the same habit showed two different
 * numbers in two places.
 */

export const isInverseGoal = (habit: Pick<Habit, 'goalDirection'>): boolean =>
    (habit.goalDirection || 'atLeast') === 'atMost';

/** Which progress map this habit's type actually stores its value in. */
export const habitProgress = (habit: Habit, date: string): number => {
    if (habit.type === 'timer') return habit.timerProgress?.[date] || 0;
    return habit.numericProgress?.[date] || 0;
};

export const habitGoal = (habit: Habit): number => {
    if (habit.type === 'timer') return habit.timerGoal || 0;
    if (habit.type === 'numeric') return habit.numericGoal || 0;
    return 1; // a check habit is one unit of itself
};

export const habitDisplayMode = (habit: Habit): WidgetDisplayMode => {
    if (habit.sensorType === 'screen') return 'sunset';
    if (habit.sensorType === 'gps' || habit.numericUnit === 'km') return 'distance';
    if (habit.type === 'timer') return 'duration';
    return 'int';
};

/**
 * How much one tap of + or − should move the number.
 *
 * Sized to the metric so a single tap is a meaningful nudge: 100 steps rather
 * than 1, a tenth of a kilometre, five minutes of a timer.
 */
export const habitStep = (habit: Habit): number => {
    switch (habit.sensorType) {
        case 'pedometer': return 100;
        case 'movement': return 10;
        case 'gps': return 0.1;
        case 'screen': return 1; // one minute of allowance
        default: break;
    }
    if (habit.type === 'timer') return 300; // five minutes
    const goal = habitGoal(habit);
    // A large hand-made goal (e.g. 2000 words) deserves a bigger step than 1.
    if (goal >= 1000) return 100;
    if (goal >= 100) return 10;
    return 1;
};

/** True when an inverse-goal habit has blown through its allowance. */
export const isOverLimit = (habit: Habit, date: string): boolean => {
    if (!isInverseGoal(habit)) return false;
    const goal = habitGoal(habit);
    return goal > 0 && habitProgress(habit, date) > goal;
};

/** The number to render large on screen or on a widget face. */
export const formatHabitValue = (habit: Habit, date: string): string => {
    const value = habitProgress(habit, date);
    switch (habitDisplayMode(habit)) {
        case 'distance':
            return value < 1 ? `${Math.round(value * 1000)}` : value.toFixed(1);
        case 'duration':
            return `${Math.floor(value / 60)}`;
        default:
            return `${Math.round(value)}`;
    }
};

/**
 * Which control buttons this habit should offer, in draw order.
 * Mirrors the controls on the habit detail screen so the widget is not a
 * second-class surface.
 */
export const habitControls = (habit: Habit): WidgetControl[] => {
    if (isInverseGoal(habit)) return ['confirm', 'slipped'];
    if (habit.type === 'check') return ['check'];
    if (habit.type === 'timer') return ['timer', 'check'];
    return ['dec', 'inc'];
};
