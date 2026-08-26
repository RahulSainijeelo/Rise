import dayjs from 'dayjs';
import { Task, Habit, Label } from '../store/useAppStore';

const TASK_CATEGORIES = ['Inbox', 'Work', 'Personal', 'Health', 'Finance', 'Projects', 'Learning'];

const TASK_TITLE_TEMPLATES = [
    'Review pull request for feature branch',
    'Write unit tests for authentication module',
    'Prepare weekly sprint status report',
    'Schedule 1:1 meeting with product team',
    'Refactor legacy database query pipeline',
    'Optimize image assets and bundle size',
    '30-minute cardio and stretching workout',
    'Read 20 pages of Clean Architecture',
    'Update monthly budget and track expenses',
    'Fix memory leak in background service',
    'Review design tokens and theme contrast',
    'Prepare slides for tech sync presentation',
    'Clean up unused npm dependencies',
    'Implement dark mode color adjustments',
    'Draft RFC for new offline cache strategy',
    'Plan grocery shopping list for the week',
    'Organize desktop workspace and notes',
    'Set up automated end-to-end test suite',
    'Verify Android widget sync on lock screen',
    'Check server health and error log alerts'
];

export function generateSeedData(): { tasks: Task[]; habits: Habit[]; labels: Label[] } {
    const today = dayjs();
    const todayStr = today.format('YYYY-MM-DD');

    const labels: Label[] = TASK_CATEGORIES.map((name, index) => ({
        id: `label_${index + 1}`,
        name
    }));

    const tasks: Task[] = [];

    for (let i = 1; i <= 200; i++) {
        const titleTemplate = TASK_TITLE_TEMPLATES[(i - 1) % TASK_TITLE_TEMPLATES.length];
        const category = TASK_CATEGORIES[i % TASK_CATEGORIES.length];
        const priority = ((i % 4) + 1) as 1 | 2 | 3 | 4;
        const isCompleted = i % 4 === 0; // ~25% completed (50 tasks)

        let dueDate: string | undefined;
        const dateType = i % 5;
        if (dateType === 0) {
            dueDate = undefined; // No due date
        } else if (dateType === 1 || dateType === 2) {
            dueDate = todayStr; // Due today
        } else if (dateType === 3) {
            dueDate = today.subtract((i % 7) + 1, 'day').format('YYYY-MM-DD'); // Past
        } else {
            dueDate = today.add((i % 20) + 1, 'day').format('YYYY-MM-DD'); // Upcoming
        }

        const dueTime = i % 3 === 0 ? `${String(9 + (i % 10)).padStart(2, '0')}:00` : undefined;
        const duration = i % 2 === 0 ? [15, 30, 45, 60][i % 4] : undefined;

        const subtasks = i % 3 === 0 ? [
            { id: `sub_${i}_1`, title: 'Check preconditions and requirements', completed: isCompleted || i % 2 === 0 },
            { id: `sub_${i}_2`, title: 'Execute primary implementation steps', completed: isCompleted },
            { id: `sub_${i}_3`, title: 'Verify and document results', completed: false }
        ] : [];

        tasks.push({
            id: `task_seed_${i}_${Math.random().toString(36).substr(2, 6)}`,
            title: `${titleTemplate} #${i}`,
            completed: isCompleted,
            priority,
            category,
            dueDate,
            dueTime,
            duration,
            reminders: [],
            subtasks
        });
    }

    const habits: Habit[] = [
        {
            id: 'habit_seed_1',
            title: 'Morning 5km Run',
            description: 'Maintain cardiovascular health and stamina',
            frequency: 'daily',
            type: 'check',
            completedDates: [
                today.subtract(1, 'day').format('YYYY-MM-DD'),
                today.subtract(2, 'day').format('YYYY-MM-DD'),
                today.subtract(3, 'day').format('YYYY-MM-DD')
            ],
            streak: 3,
            bestStreak: 14,
            reminders: ['07:00'],
            color: '#FF4500'
        },
        {
            id: 'habit_seed_2',
            title: 'Deep Work Focus',
            description: 'Uninterrupted deep coding sessions',
            frequency: 'daily',
            type: 'timer',
            timerGoal: 3600,
            accumulatedTimeToday: 1800,
            completedDates: [today.subtract(1, 'day').format('YYYY-MM-DD')],
            streak: 1,
            bestStreak: 7,
            reminders: ['10:00'],
            color: '#3B82F6'
        },
        {
            id: 'habit_seed_3',
            title: 'Hydration Tracker',
            description: 'Drink 8 glasses of water daily',
            frequency: 'daily',
            type: 'numeric',
            numericGoal: 8,
            numericUnit: 'glasses',
            numericProgress: { [todayStr]: 5 },
            completedDates: [
                today.subtract(1, 'day').format('YYYY-MM-DD'),
                today.subtract(2, 'day').format('YYYY-MM-DD')
            ],
            streak: 2,
            bestStreak: 21,
            reminders: ['09:00', '14:00', '18:00'],
            color: '#06B6D4'
        },
        {
            id: 'habit_seed_4',
            title: 'Read Non-Fiction',
            description: 'Read 20 pages every evening',
            frequency: 'daily',
            type: 'numeric',
            numericGoal: 20,
            numericUnit: 'pages',
            numericProgress: { [todayStr]: 20 },
            completedDates: [todayStr, today.subtract(1, 'day').format('YYYY-MM-DD')],
            streak: 5,
            bestStreak: 12,
            reminders: ['21:30'],
            color: '#10B981'
        },
        {
            id: 'habit_seed_5',
            title: 'Evening Meditation',
            description: '10 minutes mindfulness before sleep',
            frequency: 'daily',
            type: 'timer',
            timerGoal: 600,
            completedDates: [],
            streak: 0,
            bestStreak: 10,
            reminders: ['22:00'],
            color: '#8B5CF6'
        }
    ];

    return { tasks, habits, labels };
}
