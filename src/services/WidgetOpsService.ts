import { PendingOp, PendingOpName } from './WidgetContract';
import { sensorService, localDate } from './SensorService';

/**
 * WidgetOpsService
 * ================
 * Applies the taps a user made on a home-screen widget while JS was not running.
 *
 * Widget controls do not launch the app any more: the provider mutates the widget's
 * own copy of the data for instant feedback and queues a PendingOp natively. This
 * module is the other half of that deal — it drains the queue into the real store,
 * which is the only place a habit's history actually lives.
 *
 * Drain it whenever JS regains control: on mount, and on every return to the
 * foreground. Nothing else in the app touches the queue.
 */

/**
 * opIds already applied in this process.
 *
 * Native clears the queue as it hands it over, so an op can only arrive twice if
 * two drains overlap — which is exactly what happens when a widget tap brings the
 * app forward and both the mount effect and the AppState listener fire. The set is
 * deliberately not persisted: a fresh process cannot have a half-applied op,
 * because the native queue is only cleared once JS has it in hand.
 */
const appliedOpIds = new Set<string>();

/** Bound the set so a long session cannot grow it without limit. */
const APPLIED_MAX = 500;

/** Serialises drains, so two callers cannot each claim the same op. */
let draining = false;

const remember = (opId: string) => {
    appliedOpIds.add(opId);
    if (appliedOpIds.size > APPLIED_MAX) {
        // Sets iterate in insertion order, so this drops the oldest.
        const oldest = appliedOpIds.values().next().value;
        if (oldest !== undefined) appliedOpIds.delete(oldest);
    }
};

/**
 * The habit-day an op belongs to.
 *
 * Native supplies `date` for the Digital Sunset window, which runs past midnight —
 * a tap at 00:30 belongs to the night that started at 22:00 the previous evening.
 * Everything else falls back to the local date of the tap, and specifically not to
 * `new Date(ts).toISOString()`, which is UTC and would file anything before 05:30
 * against yesterday for a user at UTC+5:30.
 */
const dateOf = (op: PendingOp): string =>
    op.date || localDate(new Date(op.ts || Date.now()));

const isKnownOp = (name: string): name is PendingOpName =>
    name === 'inc' ||
    name === 'toggle' ||
    name === 'timerAdd' ||
    name === 'sunsetConfirm' ||
    name === 'sunsetSlipped' ||
    name === 'taskToggle';

/**
 * Resolve a habit by id from the store, tolerating both the legacy flat
 * `habits: Habit[]` shape and the normalized `habitsById` map.
 */
const findHabit = (store: any, id: string): any => {
    if (store.habitsById && store.habitsById[id]) return store.habitsById[id];
    return (store.habits || []).find((h: any) => h.id === id);
};

/**
 * Apply one op to the store.
 *
 * Returns false when the op could not be applied — a habit deleted since the tap,
 * or an op name from a newer APK than this JS bundle. Either way it is dropped
 * rather than retried, because there is nothing a retry would fix.
 */
const applyOne = (store: any, op: PendingOp): boolean => {
    // A task toggle is not a habit op: the taskId travels in the habitId field and
    // the store owns the completion/reminder side effects via toggleTask.
    if (op.op === 'taskToggle') {
        if (typeof store.toggleTask === 'function') {
            store.toggleTask(op.habitId);
            return true;
        }
        return false;
    }

    const habit = findHabit(store, op.habitId);
    if (!habit) return false;

    const date = dateOf(op);
    const amount = Number(op.amount) || 0;

    switch (op.op) {
        case 'inc':
            // updateNumericProgress and updateTimerProgress both take a delta and
            // both ignore a habit of the wrong type, so route by the habit's type
            // rather than trusting the widget to have picked the right control.
            if (habit.type === 'timer') {
                store.updateTimerProgress(op.habitId, date, amount);
            } else {
                store.updateNumericProgress(op.habitId, date, amount);
            }
            return true;

        case 'timerAdd':
            if (habit.type === 'timer') {
                store.updateTimerProgress(op.habitId, date, amount);
            } else {
                store.updateNumericProgress(op.habitId, date, amount);
            }
            return true;

        case 'toggle':
            store.toggleHabit(op.habitId, date);
            return true;

        // The next two exist because an "at most" habit cannot infer completion
        // from its progress: staying under a screen-time limit is only settled once
        // the window closes. toggleHabit flips, so both cases have to check first
        // or a second confirmation would undo the first.
        case 'sunsetConfirm':
            if (!(habit.completedDates || []).includes(date)) {
                store.toggleHabit(op.habitId, date);
            }
            return true;

        case 'sunsetSlipped':
            if ((habit.completedDates || []).includes(date)) {
                store.toggleHabit(op.habitId, date);
            }
            return true;

        default:
            return false;
    }
};

/**
 * Drain the native queue into the store.
 *
 * @param getStore the zustand getState function, passed in rather than imported so
 *        this module stays out of the store's own import cycle.
 * @returns how many ops were applied.
 */
export const applyPendingWidgetOps = async (getStore: () => any): Promise<number> => {
    if (draining) return 0;
    draining = true;
    try {
        const ops = await sensorService.drainPendingOps();
        if (!ops.length) return 0;

        let applied = 0;
        ops.forEach((op) => {
            if (!op || !op.opId || !op.habitId) return;
            if (appliedOpIds.has(op.opId)) return;
            if (!isKnownOp(op.op)) {
                remember(op.opId);
                return;
            }
            // Read the store fresh for each op: applying one op can change the very
            // completedDates the next op has to inspect.
            if (applyOne(getStore(), op)) applied += 1;
            remember(op.opId);
        });

        if (applied > 0) {
            console.log(`Applied ${applied} widget op(s) from the home screen`);
        }
        return applied;
    } catch (e) {
        console.warn('Failed to apply pending widget ops', e);
        return 0;
    } finally {
        draining = false;
    }
};
