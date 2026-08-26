import {
    buildNormalizedTasks,
    addTaskToNormalized,
    updateTaskInNormalized,
    toggleTaskInNormalized,
    deleteTaskFromNormalized,
    getTasksArray,
    Task
} from '../src/utils/NormalizedTaskStore';

describe('NormalizedTaskStore', () => {
    const mockTasks: Task[] = [
        {
            id: 't1',
            title: 'Buy groceries',
            completed: false,
            priority: 2,
            category: 'Personal',
            dueDate: '2026-08-26',
            reminders: [],
            subtasks: []
        },
        {
            id: 't2',
            title: 'Fix server bug',
            completed: false,
            priority: 1,
            category: 'Work',
            dueDate: '2026-08-27',
            reminders: [],
            subtasks: []
        },
        {
            id: 't3',
            title: 'Read Atomic Habits',
            completed: true,
            priority: 3,
            category: 'Personal',
            dueDate: '2026-08-25',
            reminders: [],
            subtasks: []
        }
    ];

    test('buildNormalizedTasks correctly indexes tasks', () => {
        const normalized = buildNormalizedTasks(mockTasks);

        expect(normalized.allIds).toEqual(['t1', 't2', 't3']);
        expect(normalized.byId['t1'].title).toBe('Buy groceries');
        expect(normalized.byStatus.active).toEqual(['t1', 't2']);
        expect(normalized.byStatus.completed).toEqual(['t3']);
        expect(normalized.byCategory['Personal']).toEqual(['t1', 't3']);
        expect(normalized.byCategory['Work']).toEqual(['t2']);
        expect(normalized.byDate['2026-08-26']).toEqual(['t1']);
        expect(normalized.byDate['2026-08-27']).toEqual(['t2']);
        expect(normalized.byDate['2026-08-25']).toEqual(['t3']);
    });

    test('addTaskToNormalized updates indexes in O(1)', () => {
        const initial = buildNormalizedTasks(mockTasks);
        const newTask: Task = {
            id: 't4',
            title: 'Plan sprint',
            completed: false,
            priority: 1,
            category: 'Work',
            dueDate: '2026-08-28',
            reminders: [],
            subtasks: []
        };

        const updated = addTaskToNormalized(initial, newTask);

        expect(updated.allIds).toContain('t4');
        expect(updated.byId['t4']).toEqual(newTask);
        expect(updated.byStatus.active).toContain('t4');
        expect(updated.byCategory['Work']).toEqual(['t2', 't4']);
        expect(updated.byDate['2026-08-28']).toEqual(['t4']);
    });

    test('toggleTaskInNormalized moves task between active and completed indexes', () => {
        const initial = buildNormalizedTasks(mockTasks);

        // Toggle t1 to completed
        const { newState: completedState, toggledTask } = toggleTaskInNormalized(initial, 't1');
        expect(toggledTask?.completed).toBe(true);
        expect(completedState.byStatus.active).not.toContain('t1');
        expect(completedState.byStatus.completed).toContain('t1');

        // Toggle t1 back to active
        const { newState: activeState } = toggleTaskInNormalized(completedState, 't1');
        expect(activeState.byStatus.active).toContain('t1');
        expect(activeState.byStatus.completed).not.toContain('t1');
    });

    test('updateTaskInNormalized updates category and date indexes', () => {
        const initial = buildNormalizedTasks(mockTasks);

        const updated = updateTaskInNormalized(initial, 't1', {
            category: 'Work',
            dueDate: '2026-08-30'
        });

        expect(updated.byId['t1'].category).toBe('Work');
        expect(updated.byId['t1'].dueDate).toBe('2026-08-30');
        expect(updated.byCategory['Personal']).toEqual(['t3']);
        expect(updated.byCategory['Work']).toEqual(['t2', 't1']);
        expect(updated.byDate['2026-08-26']).toBeUndefined();
        expect(updated.byDate['2026-08-30']).toEqual(['t1']);
    });

    test('deleteTaskFromNormalized removes task from all indexes', () => {
        const initial = buildNormalizedTasks(mockTasks);

        const { newState, deletedTask } = deleteTaskFromNormalized(initial, 't1');

        expect(deletedTask?.id).toBe('t1');
        expect(newState.byId['t1']).toBeUndefined();
        expect(newState.allIds).not.toContain('t1');
        expect(newState.byStatus.active).not.toContain('t1');
        expect(newState.byCategory['Personal']).toEqual(['t3']);
        expect(newState.byDate['2026-08-26']).toBeUndefined();
    });

    test('getTasksArray returns full array of tasks in order', () => {
        const initial = buildNormalizedTasks(mockTasks);
        const array = getTasksArray(initial);

        expect(array).toHaveLength(3);
        expect(array.map(t => t.id)).toEqual(['t1', 't2', 't3']);
    });

    test('toggleTaskInNormalized advances repeating tasks to next occurrence', () => {
        const repeatTasks: Task[] = [
            {
                id: 'rep-daily',
                title: 'Daily Standup',
                completed: false,
                priority: 1,
                category: 'Work',
                dueDate: '2026-08-26',
                repeat: 'daily',
                reminders: [],
                subtasks: [{ id: 'st1', title: 'Prepare notes', completed: true }]
            },
            {
                id: 'rep-weekly',
                title: 'Weekly Review',
                completed: false,
                priority: 2,
                category: 'Work',
                dueDate: '2026-08-26',
                repeat: 'weekly',
                reminders: [],
                subtasks: []
            },
            {
                id: 'rep-monthly',
                title: 'Monthly Budget',
                completed: false,
                priority: 3,
                category: 'Finance',
                dueDate: '2026-08-26',
                repeat: 'monthly',
                reminders: [],
                subtasks: []
            }
        ];

        let state = buildNormalizedTasks(repeatTasks);

        // Complete daily task -> advances by 1 day, stays active, resets subtasks
        const { newState: stateAfterDaily, toggledTask: dailyToggled } = toggleTaskInNormalized(state, 'rep-daily');
        expect(dailyToggled?.dueDate).toBe('2026-08-27');
        expect(dailyToggled?.completed).toBe(false);
        expect(dailyToggled?.subtasks[0].completed).toBe(false);
        expect(stateAfterDaily.byStatus.active).toContain('rep-daily');
        expect(stateAfterDaily.byDate['2026-08-27']).toContain('rep-daily');

        // Complete weekly task -> advances by 7 days
        const { newState: stateAfterWeekly, toggledTask: weeklyToggled } = toggleTaskInNormalized(stateAfterDaily, 'rep-weekly');
        expect(weeklyToggled?.dueDate).toBe('2026-09-02');
        expect(weeklyToggled?.completed).toBe(false);

        // Complete monthly task -> advances by 1 month
        const { toggledTask: monthlyToggled } = toggleTaskInNormalized(stateAfterWeekly, 'rep-monthly');
        expect(monthlyToggled?.dueDate).toBe('2026-09-26');
        expect(monthlyToggled?.completed).toBe(false);
    });
});
