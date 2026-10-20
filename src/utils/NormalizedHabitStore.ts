import dayjs from 'dayjs';
// Type-only import: erased at compile time, so this does not create a runtime
// import cycle even though useAppStore imports these functions back.
import type { Habit } from '../store/useAppStore';

/**
 * NormalizedHabitStore
 * ====================
 * The habit half of the app's "database-shaped" local state, mirroring
 * NormalizedTaskStore. Habits are kept as a `byId` map plus an `allIds` order
 * array instead of a flat `Habit[]`, so a single habit can be updated by
 * rebuilding one object and shallow-copying one map — O(1)-ish — rather than
 * mapping the whole array on every tap. Crucially, only the touched habit gets a
 * new object identity, so a memoized row bound to a *different* habit does not
 * re-render. That is what removes the tab-switch lag once a profile has many
 * habits.
 *
 * Unlike tasks, habits are not filed by date/category/status: a habit recurs
 * every day and is looked up by id or iterated in order, so byId + allIds is the
 * whole index.
 *
 * The on-disk JSON shape is unchanged — habits still persist as a plain array via
 * getHabitsArray — so this is a pure in-memory representation change.
 */
export interface NormalizedHabitState {
    byId: Record<string, Habit>;
    allIds: string[];
}

export const createEmptyNormalizedHabitState = (): NormalizedHabitState => ({
    byId: {},
    allIds: [],
});

/** Build the normalized shape from a flat array (load / migrate path). O(N). */
export const buildNormalizedHabits = (habits: Habit[] = []): NormalizedHabitState => {
    const byId: Record<string, Habit> = {};
    const allIds: string[] = [];
    for (let i = 0; i < habits.length; i++) {
        const h = habits[i];
        if (!h || !h.id) continue;
        if (!byId[h.id]) allIds.push(h.id); // de-dupe defensively
        byId[h.id] = h;
    }
    return { byId, allIds };
};

/** Flat array in insertion order — the shape every screen and the on-disk file expect. */
export const getHabitsArray = (state: NormalizedHabitState): Habit[] => {
    const out: Habit[] = [];
    for (let i = 0; i < state.allIds.length; i++) {
        const h = state.byId[state.allIds[i]];
        if (h) out.push(h);
    }
    return out;
};

/** Insert or replace one habit, preserving order. Only this habit changes identity. */
export const upsertHabitInNormalized = (
    state: NormalizedHabitState,
    habit: Habit
): NormalizedHabitState => {
    const exists = !!state.byId[habit.id];
    return {
        byId: { ...state.byId, [habit.id]: habit },
        allIds: exists ? state.allIds : [...state.allIds, habit.id],
    };
};

/** Remove one habit. Returns the same state object if the id was unknown. */
export const removeHabitFromNormalized = (
    state: NormalizedHabitState,
    id: string
): NormalizedHabitState => {
    if (!state.byId[id]) return state;
    const byId = { ...state.byId };
    delete byId[id];
    return { byId, allIds: state.allIds.filter((x) => x !== id) };
};

/**
 * Recompute a habit's current streak and all-time best from its completed dates.
 *
 * This exists because toggleHabit, updateNumericProgress, updateTimerProgress and
 * updateSensorProgress each inlined their own streak math, and they disagreed:
 * toggleHabit recomputed bestStreak from scratch (so an undo could *shrink* a
 * previously earned best), while the three progress reducers ratcheted with
 * `Math.max(prevBest, streak)` (so they never considered historical runs that did
 * not touch today). One habit therefore reported two different bests depending on
 * which control last touched it.
 *
 * The unified rule:
 *   - `streak`     = contiguous run of days ending today or yesterday (a run that
 *                    ended earlier is broken, so the current streak is 0).
 *   - `bestStreak` = max(priorBest, longest contiguous run anywhere in history).
 *                    Ratcheting against priorBest means a correction/undo can never
 *                    retroactively erase a best the user genuinely reached.
 *
 * All day arithmetic uses local YYYY-MM-DD strings (never toISOString, which rolls
 * at 05:30 for a UTC+5:30 user).
 */
export const recomputeStreaks = (
    completedDates: string[],
    priorBest = 0
): { streak: number; bestStreak: number } => {
    if (!completedDates || completedDates.length === 0) {
        return { streak: 0, bestStreak: Math.max(priorBest || 0, 0) };
    }

    const sorted = [...completedDates].sort((a, b) => b.localeCompare(a)); // newest first
    const today = dayjs().format('YYYY-MM-DD');
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    // Current streak: only counts if the most recent completion is today/yesterday.
    let streak = 0;
    if (sorted[0] === today || sorted[0] === yesterday) {
        streak = 1;
        for (let i = 0; i < sorted.length - 1; i++) {
            const prevDay = dayjs(sorted[i]).subtract(1, 'day').format('YYYY-MM-DD');
            if (prevDay === sorted[i + 1]) {
                streak++;
            } else {
                break;
            }
        }
    }

    // Longest contiguous run anywhere in history.
    let run = 1;
    let longest = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
        const prevDay = dayjs(sorted[i]).subtract(1, 'day').format('YYYY-MM-DD');
        if (prevDay === sorted[i + 1]) {
            run++;
            if (run > longest) longest = run;
        } else {
            run = 1;
        }
    }

    const bestStreak = Math.max(priorBest || 0, streak, longest);
    return { streak, bestStreak };
};
