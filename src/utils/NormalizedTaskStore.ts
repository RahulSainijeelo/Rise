import dayjs from 'dayjs';

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

export interface NormalizedTaskState {
    byId: Record<string, Task>;
    allIds: string[];
    byCategory: Record<string, string[]>;
    byDate: Record<string, string[]>;
    byStatus: {
        active: string[];
        completed: string[];
    };
}

export const createEmptyNormalizedTaskState = (): NormalizedTaskState => ({
    byId: {},
    allIds: [],
    byCategory: {},
    byDate: {},
    byStatus: {
        active: [],
        completed: []
    }
});

/**
 * Builds normalized state and auxiliary indexes from an array of tasks in O(N) time.
 */
export const buildNormalizedTasks = (tasks: Task[] = []): NormalizedTaskState => {
    const byId: Record<string, Task> = {};
    const allIds: string[] = [];
    const byCategory: Record<string, string[]> = {};
    const byDate: Record<string, string[]> = {};
    const active: string[] = [];
    const completed: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (!task || !task.id) continue;

        byId[task.id] = task;
        allIds.push(task.id);

        // Index by status
        if (task.completed) {
            completed.push(task.id);
        } else {
            active.push(task.id);
        }

        // Index by category
        const category = task.category || 'Inbox';
        if (!byCategory[category]) {
            byCategory[category] = [];
        }
        byCategory[category].push(task.id);

        // Index by due date
        if (task.dueDate) {
            if (!byDate[task.dueDate]) {
                byDate[task.dueDate] = [];
            }
            byDate[task.dueDate].push(task.id);
        }
    }

    return {
        byId,
        allIds,
        byCategory,
        byDate,
        byStatus: {
            active,
            completed
        }
    };
};

/**
 * Adds a new task to normalized state and updates all indexes in O(1) time.
 */
export const addTaskToNormalized = (
    state: NormalizedTaskState,
    newTask: Task
): NormalizedTaskState => {
    const { id, category = 'Inbox', dueDate, completed } = newTask;

    const byId = { ...state.byId, [id]: newTask };
    const allIds = [...state.allIds, id];

    // Update status index
    const byStatus = {
        active: completed ? state.byStatus.active : [...state.byStatus.active, id],
        completed: completed ? [...state.byStatus.completed, id] : state.byStatus.completed
    };

    // Update category index
    const categoryList = state.byCategory[category] || [];
    const byCategory = {
        ...state.byCategory,
        [category]: [...categoryList, id]
    };

    // Update date index
    let byDate = state.byDate;
    if (dueDate) {
        const dateList = state.byDate[dueDate] || [];
        byDate = {
            ...state.byDate,
            [dueDate]: [...dateList, id]
        };
    }

    return {
        byId,
        allIds,
        byCategory,
        byDate,
        byStatus
    };
};

/**
 * Updates a task in normalized state and synchronizes indexes in O(1) time.
 */
export const updateTaskInNormalized = (
    state: NormalizedTaskState,
    id: string,
    updates: Partial<Task>
): NormalizedTaskState => {
    const currentTask = state.byId[id];
    if (!currentTask) {
        return state;
    }

    const updatedTask: Task = { ...currentTask, ...updates };
    const byId = { ...state.byId, [id]: updatedTask };

    let byStatus = state.byStatus;
    if (updates.completed !== undefined && updates.completed !== currentTask.completed) {
        if (updates.completed) {
            byStatus = {
                active: state.byStatus.active.filter(taskId => taskId !== id),
                completed: [...state.byStatus.completed, id]
            };
        } else {
            byStatus = {
                active: [...state.byStatus.active, id],
                completed: state.byStatus.completed.filter(taskId => taskId !== id)
            };
        }
    }

    let byCategory = state.byCategory;
    if (updates.category !== undefined && updates.category !== currentTask.category) {
        const oldCat = currentTask.category || 'Inbox';
        const newCat = updates.category || 'Inbox';

        const oldList = (state.byCategory[oldCat] || []).filter(taskId => taskId !== id);
        const newList = [...(state.byCategory[newCat] || []).filter(taskId => taskId !== id), id];

        byCategory = {
            ...state.byCategory,
            [oldCat]: oldList,
            [newCat]: newList
        };
    }

    let byDate = state.byDate;
    if (updates.dueDate !== undefined && updates.dueDate !== currentTask.dueDate) {
        const oldDate = currentTask.dueDate;
        const newDate = updates.dueDate;

        byDate = { ...state.byDate };
        if (oldDate && byDate[oldDate]) {
            byDate[oldDate] = byDate[oldDate].filter(taskId => taskId !== id);
            if (byDate[oldDate].length === 0) {
                delete byDate[oldDate];
            }
        }
        if (newDate) {
            byDate[newDate] = [...(byDate[newDate] || []).filter(taskId => taskId !== id), id];
        }
    }

    return {
        byId,
        allIds: state.allIds,
        byCategory,
        byDate,
        byStatus
    };
};

/**
 * Toggles a task's completion status in O(1) time.
 * If the task has a repeat rule (daily/weekly/monthly), completing it automatically advances its dueDate to the next cycle and resets subtasks.
 */
export const toggleTaskInNormalized = (
    state: NormalizedTaskState,
    id: string
): { newState: NormalizedTaskState; toggledTask?: Task } => {
    const currentTask = state.byId[id];
    if (!currentTask) {
        return { newState: state };
    }

    // If task is not completed and has a repeat rule, advance dueDate to next cycle
    if (!currentTask.completed && currentTask.repeat && currentTask.repeat !== 'none') {
        const baseDate = currentTask.dueDate || dayjs().format('YYYY-MM-DD');
        let nextDate = baseDate;
        if (currentTask.repeat === 'daily') {
            nextDate = dayjs(baseDate).add(1, 'day').format('YYYY-MM-DD');
        } else if (currentTask.repeat === 'weekly') {
            nextDate = dayjs(baseDate).add(1, 'week').format('YYYY-MM-DD');
        } else if (currentTask.repeat === 'monthly') {
            nextDate = dayjs(baseDate).add(1, 'month').format('YYYY-MM-DD');
        }

        const resetSubtasks = (currentTask.subtasks || []).map(st => ({ ...st, completed: false }));

        const newState = updateTaskInNormalized(state, id, {
            dueDate: nextDate,
            completed: false,
            subtasks: resetSubtasks
        });
        return { newState, toggledTask: newState.byId[id] };
    }

    const nextCompleted = !currentTask.completed;
    const newState = updateTaskInNormalized(state, id, { completed: nextCompleted });
    return { newState, toggledTask: newState.byId[id] };
};

/**
 * Deletes a task from normalized state and removes it from all indexes in O(1) time.
 */
export const deleteTaskFromNormalized = (
    state: NormalizedTaskState,
    id: string
): { newState: NormalizedTaskState; deletedTask?: Task } => {
    const currentTask = state.byId[id];
    if (!currentTask) {
        return { newState: state };
    }

    const byId = { ...state.byId };
    delete byId[id];

    const allIds = state.allIds.filter(taskId => taskId !== id);

    const byStatus = {
        active: state.byStatus.active.filter(taskId => taskId !== id),
        completed: state.byStatus.completed.filter(taskId => taskId !== id)
    };

    const category = currentTask.category || 'Inbox';
    const byCategory = { ...state.byCategory };
    if (byCategory[category]) {
        byCategory[category] = byCategory[category].filter(taskId => taskId !== id);
    }

    const byDate = { ...state.byDate };
    if (currentTask.dueDate && byDate[currentTask.dueDate]) {
        byDate[currentTask.dueDate] = byDate[currentTask.dueDate].filter(taskId => taskId !== id);
        if (byDate[currentTask.dueDate].length === 0) {
            delete byDate[currentTask.dueDate];
        }
    }

    return {
        newState: {
            byId,
            allIds,
            byCategory,
            byDate,
            byStatus
        },
        deletedTask: currentTask
    };
};

/**
 * Derives array of Task objects from normalized state.
 */
export const getTasksArray = (state: NormalizedTaskState): Task[] => {
    return state.allIds.map(id => state.byId[id]).filter(Boolean);
};
