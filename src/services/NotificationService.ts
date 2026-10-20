import notifee, { AndroidImportance, TriggerType, TimestampTrigger, RepeatFrequency } from '@notifee/react-native';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

// scheduleTaskReminders parses times with an explicit format string
// (e.g. 'YYYY-MM-DD HH:mm'); dayjs only honours that format with this plugin loaded.
dayjs.extend(customParseFormat);

/**
 * Outcome of a (re)schedule call so callers can react instead of failing silently.
 * `ok` is false only when reminders were requested but could not be anchored to a
 * valid date/time (so nothing was scheduled).
 */
export interface ScheduleReminderResult {
    ok: boolean;
    scheduledCount: number;
    skippedReason?: 'no-reminders' | 'missing-date' | 'invalid-date';
}

class NotificationService {
    private channelId: string | null = null;

    // Initialize the notification channel (required for Android)
    async init() {
        if (this.channelId) return;

        this.channelId = await notifee.createChannel({
            id: 'rise-reminders',
            name: 'Rise Reminders',
            description: 'Task and Habit reminders from Rise',
            importance: AndroidImportance.HIGH,
            sound: 'default',
            vibration: true,
        });

        console.log('NotificationService initialized with channel:', this.channelId);
    }

    // Request notification permission (Android 13+)
    async requestPermission(): Promise<boolean> {
        const settings = await notifee.requestPermission();
        return settings.authorizationStatus >= 1; // 1 = AUTHORIZED
    }

    // Schedule a notification for a specific time
    async scheduleNotification(params: {
        id: string;
        title: string;
        body: string;
        triggerTime: Date;
        /** When set, the notification repeats at this cadence instead of firing once. */
        repeat?: RepeatFrequency;
        data?: Record<string, string>;
    }) {
        await this.init();

        const trigger: TimestampTrigger = {
            type: TriggerType.TIMESTAMP,
            timestamp: params.triggerTime.getTime(),
            ...(params.repeat !== undefined ? { repeatFrequency: params.repeat } : {}),
        };

        await notifee.createTriggerNotification(
            {
                id: params.id,
                title: params.title.toUpperCase(),
                body: params.body.toUpperCase(),
                android: {
                    channelId: this.channelId!,
                    smallIcon: 'ic_launcher',
                    color: '#FFFFFF',
                    pressAction: {
                        id: 'default',
                    },
                },
                data: params.data,
            },
            trigger
        );

        console.log(`Scheduled notification "${params.title}" for ${params.triggerTime}`);
    }

    // Schedule reminders for a task.
    //
    // Always cancels existing reminders first, so calling this with an empty
    // `reminders` array is the supported way to CLEAR a task's reminders (T-02).
    // Task reminders are offsets from a specific due datetime, so they are
    // correctly one-shot; recurrence belongs to habits (see scheduleHabitReminders).
    async scheduleTaskReminders(
        task: {
            id: string;
            title: string;
            dueDate?: string;
            dueTime?: string;
            reminders: string[];
        },
        opts?: { announce?: boolean }
    ): Promise<ScheduleReminderResult> {
        // Cancel first and unconditionally, so a reschedule is idempotent and an
        // empty reminder list genuinely clears what was there.
        await this.cancelTaskReminders(task.id);

        if (!task.reminders || task.reminders.length === 0) {
            return { ok: true, scheduledCount: 0, skippedReason: 'no-reminders' };
        }
        if (!task.dueDate) {
            console.warn(`Task "${task.title}" has reminders but no due date; nothing scheduled.`);
            return { ok: false, scheduledCount: 0, skippedReason: 'missing-date' };
        }

        // Parse the due datetime
        const dueTimeStr = task.dueTime || '09:00'; // Default to 9 AM
        const dueDateTime = dayjs(`${task.dueDate} ${dueTimeStr}`, 'YYYY-MM-DD HH:mm');
        if (!dueDateTime.isValid()) {
            console.warn(`Task "${task.title}" due date/time did not parse; nothing scheduled.`);
            return { ok: false, scheduledCount: 0, skippedReason: 'invalid-date' };
        }

        console.log(`Scheduling reminders for "${task.title}" due at ${dueDateTime.format()}`);

        let scheduledCount = 0;
        for (const reminder of task.reminders) {
            let triggerTime: dayjs.Dayjs | null = null;

            // Parse human-readable reminder strings
            if (reminder === 'At time of event') {
                triggerTime = dueDateTime;
            } else if (reminder === '10 minutes before' || reminder === '10m') {
                triggerTime = dueDateTime.subtract(10, 'minute');
            } else if (reminder === '30 minutes before' || reminder === '30m') {
                triggerTime = dueDateTime.subtract(30, 'minute');
            } else if (reminder === '1 hour before' || reminder === '1h') {
                triggerTime = dueDateTime.subtract(1, 'hour');
            } else if (reminder === '1 day before' || reminder === '1d') {
                triggerTime = dueDateTime.subtract(1, 'day');
            } else if (reminder.endsWith('m')) {
                const minutes = parseInt(reminder);
                triggerTime = dueDateTime.subtract(minutes, 'minute');
            } else if (reminder.endsWith('h')) {
                const hours = parseInt(reminder);
                triggerTime = dueDateTime.subtract(hours, 'hour');
            } else if (reminder.endsWith('d')) {
                const days = parseInt(reminder);
                triggerTime = dueDateTime.subtract(days, 'day');
            }

            if (!triggerTime) {
                console.log(`Unknown reminder format: ${reminder}`);
                continue;
            }

            // Only schedule if in the future
            if (triggerTime.isAfter(dayjs())) {
                console.log(`Scheduling reminder "${reminder}" for ${triggerTime.format()}`);
                await this.scheduleNotification({
                    id: `task-${task.id}-${reminder.replace(/\s/g, '_')}`,
                    title: '⏰ Task Reminder',
                    body: task.title,
                    triggerTime: triggerTime.toDate(),
                    data: { taskId: task.id, type: 'task' },
                });
                scheduledCount += 1;
            } else {
                console.log(`Skipping reminder "${reminder}" - time ${triggerTime.format()} is in the past`);
            }
        }

        // Only announce when the caller explicitly asks (e.g. an explicit Save),
        // never on incidental reschedules like time-dial drags (T-04).
        if (opts?.announce && scheduledCount > 0) {
            await this.showNow('✅ Reminders Set', `${scheduledCount} reminder(s) for "${task.title}"`);
        }
        return { ok: true, scheduledCount };
    }

    // Schedule reminders for a habit.
    //
    // Habit reminders are times of day, so they REPEAT (daily, or weekly for a
    // weekly habit) rather than firing once — the previous one-shot behaviour is
    // why a "daily" reminder only ever fired on the day the habit was created
    // (T-05). Cancels first, so this is also the way to re-sync a habit's reminders
    // after an edit, and an empty list clears them.
    async scheduleHabitReminders(habit: {
        id: string;
        title: string;
        reminders: string[];
        frequency: string;
    }): Promise<ScheduleReminderResult> {
        await this.cancelHabitReminders(habit.id);

        if (!habit.reminders || habit.reminders.length === 0) {
            return { ok: true, scheduledCount: 0, skippedReason: 'no-reminders' };
        }

        const repeat =
            habit.frequency === 'weekly' ? RepeatFrequency.WEEKLY : RepeatFrequency.DAILY;

        // For habits, reminders are times of day (e.g., '08:00', '20:00')
        let scheduledCount = 0;
        for (const reminderTime of habit.reminders) {
            const [hours, minutes] = reminderTime.split(':').map(Number);
            if (Number.isNaN(hours) || Number.isNaN(minutes)) {
                console.warn(`Habit "${habit.title}" has an unparseable reminder time: ${reminderTime}`);
                continue;
            }

            // Anchor the FIRST fire today, or tomorrow if the time already passed;
            // repeatFrequency then carries it forward each day/week.
            let triggerTime = dayjs().hour(hours).minute(minutes).second(0).millisecond(0);
            if (triggerTime.isBefore(dayjs())) {
                triggerTime = triggerTime.add(1, 'day');
            }

            await this.scheduleNotification({
                id: `habit-${habit.id}-${reminderTime}`,
                title: '💪 Habit Reminder',
                body: `Time for: ${habit.title}`,
                triggerTime: triggerTime.toDate(),
                repeat,
                data: { habitId: habit.id, type: 'habit' },
            });
            scheduledCount += 1;
        }

        return { ok: true, scheduledCount };
    }

    // Cancel all reminders for a task
    async cancelTaskReminders(taskId: string) {
        const notifications = await notifee.getTriggerNotificationIds();
        const taskNotifications = notifications.filter(id => id.startsWith(`task-${taskId}-`));

        for (const id of taskNotifications) {
            await notifee.cancelNotification(id);
        }
    }

    // Cancel all reminders for a habit
    async cancelHabitReminders(habitId: string) {
        const notifications = await notifee.getTriggerNotificationIds();
        const habitNotifications = notifications.filter(id => id.startsWith(`habit-${habitId}-`));

        for (const id of habitNotifications) {
            await notifee.cancelNotification(id);
        }
    }

    // Cancel all notifications
    async cancelAll() {
        await notifee.cancelAllNotifications();
    }

    // Show an immediate notification (Nothing UI style)
    async showNow(title: string, body: string) {
        await this.init();

        await notifee.displayNotification({
            title: title.toUpperCase(),
            body: body.toUpperCase(),
            android: {
                channelId: this.channelId!,
                smallIcon: 'ic_launcher',
                color: '#FFFFFF',
            },
        });
    }
}

export const notificationService = new NotificationService();
