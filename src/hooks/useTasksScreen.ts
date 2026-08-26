import { useState, useRef, useMemo, useCallback } from 'react';
import { PanResponder } from 'react-native';
import dayjs from 'dayjs';
import { useAppStore, Task } from '../store/useAppStore';
import { useTheme } from '../theme';

export type SubTab = 'today' | 'upcoming' | 'browse';

export const useTasksScreen = () => {
    const [activeTab, setActiveTab] = useState<SubTab>('today');
    const [isAddModalVisible, setIsAddModalVisible] = useState(false);
    const {
        tasksById,
        taskIds,
        tasksByCategory,
        tasksByDate,
        tasksByStatus,
        toggleTask,
        labels,
        addTask,
        addLabel,
        deleteTask,
        deleteLabel
    } = useAppStore();
    const { theme } = useTheme();

    // New task state
    const [newTitle, setNewTitle] = useState('');
    const [newDate, setNewDate] = useState(dayjs().format('YYYY-MM-DD'));
    const [newTime, setNewTime] = useState<string | undefined>(undefined);
    const [newPriority, setNewPriority] = useState<1 | 2 | 3 | 4>(4);
    const [newLabel, setNewLabel] = useState('Inbox');
    const [customLabel, setCustomLabel] = useState('');

    // Browse State & Search Debouncing
    const [searchQuery, setSearchQuery] = useState('');
    const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleSearchQueryChange = useCallback((query: string) => {
        setSearchQuery(query);
        if (searchDebounceRef.current) {
            clearTimeout(searchDebounceRef.current);
        }
        searchDebounceRef.current = setTimeout(() => {
            setDebouncedSearchQuery(query);
        }, 150);
    }, []);

    const [selectedLabelFilter, setSelectedLabelFilter] = useState<string | null>(null);

    // Picker State
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [showAdvDateModal, setShowAdvDateModal] = useState(false);
    const [showTimePicker, setShowTimePicker] = useState(false);
    const [showAdvTimeModal, setShowAdvTimeModal] = useState(false);
    const [showDurationModal, setShowDurationModal] = useState(false);
    const [duration, setDuration] = useState<number | null>(null);
    const [showRemindersModal, setShowRemindersModal] = useState(false);
    const [selectedReminders, setSelectedReminders] = useState<string[]>([]);
    const [showLabelPicker, setShowLabelPicker] = useState(false);
    const [showManageLabelsModal, setShowManageLabelsModal] = useState(false);
    const [selectedTaskForView, setSelectedTaskForView] = useState<string | null>(null);
    const [isDetailModalVisible, setIsDetailModalVisible] = useState(false);

    // Advanced Date Modal State
    const [currentMonth, setCurrentMonth] = useState(dayjs());
    const [isRepeatEnabled, setIsRepeatEnabled] = useState(false);
    const [repeatType, setRepeatType] = useState<'daily' | 'weekly' | 'monthly'>('daily');
    const [timeMode, setTimeMode] = useState<'hour' | 'minute'>('hour');

    const timeModeRef = useRef(timeMode);
    timeModeRef.current = timeMode;
    const newTimeRef = useRef(newTime);
    newTimeRef.current = newTime;

    const isDetailModalVisibleRef = useRef(isDetailModalVisible);
    isDetailModalVisibleRef.current = isDetailModalVisible;
    const selectedTaskForViewRef = useRef(selectedTaskForView);
    selectedTaskForViewRef.current = selectedTaskForView;

    const handleTimeDrag = (x: number, y: number) => {
        const centerX = 130;
        const centerY = 130;
        const dx = x - centerX;
        const dy = y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        let angle = Math.atan2(dy, dx) * (180 / Math.PI);
        angle = angle + 90;
        if (angle < 0) angle += 360;

        if (timeModeRef.current === 'minute') {
            let minute = Math.round(angle / 6);
            if (minute === 60) minute = 0;
            const h = newTimeRef.current ? newTimeRef.current.split(':')[0] : '12';
            const formattedTime = `${h}:${minute.toString().padStart(2, '0')}`;
            setNewTime(formattedTime);
            if (isDetailModalVisibleRef.current && selectedTaskForViewRef.current) {
                useAppStore.getState().updateTask(selectedTaskForViewRef.current, { dueTime: formattedTime });
            }
        } else {
            let hourIndex = Math.round(angle / 30) % 12;
            let hour = 0;

            if (distance < 82.5) {
                const innerHours = [0, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
                hour = innerHours[hourIndex];
            } else {
                const outerHours = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
                hour = outerHours[hourIndex];
            }

            const m = newTimeRef.current ? newTimeRef.current.split(':')[1] : '00';
            const formattedTime = `${hour.toString().padStart(2, '0')}:${m}`;
            setNewTime(formattedTime);
            if (isDetailModalVisibleRef.current && selectedTaskForViewRef.current) {
                useAppStore.getState().updateTask(selectedTaskForViewRef.current, { dueTime: formattedTime });
            }
        }
    };

    const handleTimeDragRef = useRef(handleTimeDrag);
    handleTimeDragRef.current = handleTimeDrag;

    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: (evt) => {
                handleTimeDragRef.current(evt.nativeEvent.locationX, evt.nativeEvent.locationY);
            },
            onPanResponderMove: (evt) => {
                handleTimeDragRef.current(evt.nativeEvent.locationX, evt.nativeEvent.locationY);
            },
        })
    ).current;

    const allFilteredTasks = useMemo(() => {
        const todayStr = dayjs().format('YYYY-MM-DD');

        if (activeTab === 'today') {
            const activeIds = tasksByStatus?.active || [];
            const result: Task[] = [];
            for (let i = 0; i < activeIds.length; i++) {
                const task = tasksById[activeIds[i]];
                if (task && (task.dueDate === todayStr || !task.dueDate)) {
                    result.push(task);
                }
            }
            return result;
        }

        if (activeTab === 'upcoming') {
            const activeIds = tasksByStatus?.active || [];
            const result: Task[] = [];
            for (let i = 0; i < activeIds.length; i++) {
                const task = tasksById[activeIds[i]];
                if (task && task.dueDate && task.dueDate > todayStr) {
                    result.push(task);
                }
            }
            return result;
        }

        if (activeTab === 'browse') {
            const query = debouncedSearchQuery.trim().toLowerCase();
            let targetIds: string[];

            if (selectedLabelFilter === 'Done') {
                targetIds = tasksByStatus?.completed || [];
            } else if (selectedLabelFilter) {
                const categoryIds = tasksByCategory?.[selectedLabelFilter] || [];
                targetIds = [];
                for (let i = 0; i < categoryIds.length; i++) {
                    const task = tasksById[categoryIds[i]];
                    if (task && !task.completed) {
                        targetIds.push(task.id);
                    }
                }
            } else {
                targetIds = tasksByStatus?.active || [];
            }

            if (!query) {
                const result: Task[] = [];
                for (let i = 0; i < targetIds.length; i++) {
                    const task = tasksById[targetIds[i]];
                    if (task) result.push(task);
                }
                return result;
            }

            const result: Task[] = [];
            for (let i = 0; i < targetIds.length; i++) {
                const task = tasksById[targetIds[i]];
                if (task && task.title.toLowerCase().includes(query)) {
                    result.push(task);
                }
            }
            return result;
        }

        const allIds = taskIds || [];
        const result: Task[] = [];
        for (let i = 0; i < allIds.length; i++) {
            const task = tasksById[allIds[i]];
            if (task) result.push(task);
        }
        return result;
    }, [activeTab, debouncedSearchQuery, selectedLabelFilter, tasksById, tasksByStatus, tasksByCategory, taskIds]);

    const activeTask = selectedTaskForView ? tasksById[selectedTaskForView] : undefined;

    const handleAddTask = useCallback(() => {
        if (newTitle.trim()) {
            addTask({
                title: newTitle,
                dueDate: newDate,
                dueTime: newTime,
                priority: newPriority,
                category: newLabel,
                reminders: selectedReminders,
                duration: duration || undefined,
                repeat: isRepeatEnabled ? repeatType : 'none',
                subtasks: []
            });
            setNewTitle('');
            setNewTime(undefined);
            setDuration(null);
            setSelectedReminders([]);
            setIsRepeatEnabled(false);
            setRepeatType('daily');
            setIsAddModalVisible(false);
        }
    }, [newTitle, newDate, newTime, newPriority, newLabel, selectedReminders, duration, isRepeatEnabled, repeatType, addTask]);

    const handleOpenAddModal = useCallback(() => {
        setNewTitle('');
        setNewDate(dayjs().format('YYYY-MM-DD'));
        setNewTime(undefined);
        setNewPriority(4);
        setNewLabel('Inbox');
        setDuration(null);
        setSelectedReminders([]);
        setIsRepeatEnabled(false);
        setRepeatType('daily');
        setIsAddModalVisible(true);
    }, []);

    const onDateChange = useCallback((event: any, selectedDate?: Date) => {
        setShowDatePicker(false);
        if (selectedDate) {
            setNewDate(dayjs(selectedDate).format('YYYY-MM-DD'));
        }
    }, []);

    const onTimeChange = useCallback((event: any, selectedDate?: Date) => {
        setShowTimePicker(false);
        if (selectedDate) {
            setNewTime(dayjs(selectedDate).format('HH:mm'));
        }
    }, []);

    const handleTaskPress = useCallback((taskId: string) => {
        setSelectedTaskForView(taskId);
        setIsDetailModalVisible(true);
    }, []);

    const handleAddSubtask = useCallback((taskId: string, title: string) => {
        const task = useAppStore.getState().tasksById[taskId];
        if (task) {
            const newSubtask = {
                id: Math.random().toString(36).substr(2, 9),
                title,
                completed: false
            };
            const updatedSubtasks = [...(task.subtasks || []), newSubtask];
            useAppStore.getState().updateTask(taskId, { subtasks: updatedSubtasks });
        }
    }, []);

    const handleToggleSubtask = useCallback((taskId: string, subtaskId: string) => {
        const task = useAppStore.getState().tasksById[taskId];
        if (task) {
            const updatedSubtasks = task.subtasks.map(st =>
                st.id === subtaskId ? { ...st, completed: !st.completed } : st
            );
            useAppStore.getState().updateTask(taskId, { subtasks: updatedSubtasks });
        }
    }, []);

    const handleDeleteSubtask = useCallback((taskId: string, subtaskId: string) => {
        const task = useAppStore.getState().tasksById[taskId];
        if (task) {
            const updatedSubtasks = task.subtasks.filter(st => st.id !== subtaskId);
            useAppStore.getState().updateTask(taskId, { subtasks: updatedSubtasks });
        }
    }, []);

    const handleUpdateTaskPriority = useCallback((taskId: string, priority: 1 | 2 | 3 | 4) => {
        useAppStore.getState().updateTask(taskId, { priority });
    }, []);

    const handleUpdateTaskLabel = useCallback((taskId: string, label: string) => {
        useAppStore.getState().updateTask(taskId, { category: label });
    }, []);

    const handleUpdateTaskDate = useCallback((taskId: string, date: string) => {
        useAppStore.getState().updateTask(taskId, { dueDate: date });
    }, []);

    const handleUpdateTaskTime = useCallback((taskId: string, time: string | undefined) => {
        useAppStore.getState().updateTask(taskId, { dueTime: time });
    }, []);

    const handleUpdateTaskDuration = useCallback((taskId: string, durationVal: number | null) => {
        useAppStore.getState().updateTask(taskId, { duration: durationVal || undefined });
    }, []);

    const handleUpdateTaskReminders = useCallback((taskId: string, reminders: string[]) => {
        useAppStore.getState().updateTask(taskId, { reminders });
    }, []);

    return {
        activeTab, setActiveTab,
        isAddModalVisible, setIsAddModalVisible,
        toggleTask, labels, addTask, addLabel, deleteTask, deleteLabel,
        theme,
        newTitle, setNewTitle,
        newDate, setNewDate,
        newTime, setNewTime,
        newPriority, setNewPriority,
        newLabel, setNewLabel: setNewLabel,
        customLabel, setCustomLabel,
        searchQuery, setSearchQuery: handleSearchQueryChange,
        selectedLabelFilter, setSelectedLabelFilter,
        showDatePicker, setShowDatePicker,
        showAdvDateModal, setShowAdvDateModal,
        showTimePicker, setShowTimePicker,
        showAdvTimeModal, setShowAdvTimeModal,
        showDurationModal, setShowDurationModal,
        duration, setDuration,
        showRemindersModal, setShowRemindersModal,
        selectedReminders, setSelectedReminders,
        showLabelPicker, setShowLabelPicker,
        showManageLabelsModal, setShowManageLabelsModal,
        currentMonth, setCurrentMonth,
        isRepeatEnabled, setIsRepeatEnabled,
        repeatType, setRepeatType,
        timeMode, setTimeMode,
        handleTimeDrag,
        panResponder,
        allFilteredTasks,
        handleAddTask,
        handleOpenAddModal,
        onDateChange,
        onTimeChange,
        selectedTaskForView, setSelectedTaskForView,
        isDetailModalVisible, setIsDetailModalVisible,
        activeTask,
        handleTaskPress,
        handleAddSubtask,
        handleToggleSubtask,
        handleDeleteSubtask,
        handleUpdateTaskPriority,
        handleUpdateTaskLabel,
        handleUpdateTaskDate,
        handleUpdateTaskTime,
        handleUpdateTaskDuration,
        handleUpdateTaskReminders,
    };
};
