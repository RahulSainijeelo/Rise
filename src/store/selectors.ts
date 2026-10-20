import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from './useAppStore';
import type { Habit, Task } from './useAppStore';
import { getTasksArray } from '../utils/NormalizedTaskStore';
import { habitSlot } from '../services/WidgetContract';

/**
 * selectors
 * =========
 * Narrow, memoized hooks over the normalized store. The point is subscription
 * scope: a screen that renders a *list* should subscribe to the id order only
 * (`useHabitIds`) and let each row subscribe to its own habit (`useHabit(id)`).
 * Then toggling one habit re-renders exactly one row — not the whole list — which
 * is what kills the "lags when I switch tabs with many habits" symptom.
 *
 * `useShallow` is used where a selector necessarily builds a new array/object each
 * call, so zustand compares element-by-element instead of by identity and skips
 * the re-render when nothing the component cares about actually changed.
 */

// --- Habits -------------------------------------------------------------------

/** The habit id order. Stable across progress/streak updates; changes only on add/remove/reorder. */
export const useHabitIds = (): string[] => useAppStore(useShallow((s) => s.habitIds));

/** One habit by id. Single reference, so default identity comparison is both correct and cheapest. */
export const useHabit = (id: string): Habit | undefined => useAppStore((s) => s.habitsById[id]);

/**
 * The full habit list, in order. Prefer `useHabitIds` + per-row `useHabit` for long
 * lists; reach for this only when a view genuinely needs every habit at once
 * (aggregates, counts by state, the home summary).
 */
export const useHabitsArray = (): Habit[] =>
    useAppStore(
        useShallow((s) => {
            const out: Habit[] = [];
            for (let i = 0; i < s.habitIds.length; i++) {
                const h = s.habitsById[s.habitIds[i]];
                if (h) out.push(h);
            }
            return out;
        })
    );

/** Habit count without subscribing to habit contents. */
export const useHabitCount = (): number => useAppStore((s) => s.habitIds.length);

/**
 * The sensor slots currently occupied by some habit, as a stable, shallow-compared
 * list. Lets the Explore tab mark a template ADDED without subscribing to habit
 * *contents*: the list changes only when a habit is added, removed, or re-slotted, so
 * incrementing a counter or ticking a box never re-renders the template list. Slots are
 * resolved through habitSlot (templateId first), never a raw sensorType read.
 */
export const useOccupiedSensorSlots = (): string[] =>
    useAppStore(
        useShallow((s) => {
            const slots: string[] = [];
            for (let i = 0; i < s.habitIds.length; i++) {
                const slot = habitSlot(s.habitsById[s.habitIds[i]]);
                if (slot && slots.indexOf(slot) === -1) slots.push(slot);
            }
            return slots;
        })
    );

// --- Tasks --------------------------------------------------------------------

/** The task id order. */
export const useTaskIds = (): string[] => useAppStore(useShallow((s) => s.taskIds));

/** One task by id. */
export const useTask = (id: string): Task | undefined => useAppStore((s) => s.tasksById[id]);

/** The full task list, rebuilt from the normalized indexes. */
export const useTasksArray = (): Task[] =>
    useAppStore(
        useShallow((s) =>
            getTasksArray({
                byId: s.tasksById,
                allIds: s.taskIds,
                byCategory: s.tasksByCategory,
                byDate: s.tasksByDate,
                byStatus: s.tasksByStatus,
            })
        )
    );
