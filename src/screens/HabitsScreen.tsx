import React, { useState, useCallback } from 'react';
import { View, FlatList, TouchableOpacity, Modal, ScrollView, Platform } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { NothingText } from '../components/NothingText';
import { NothingCard } from '../components/NothingCard';
import { NothingInput } from '../components/NothingInput';
import { NothingButton } from '../components/NothingButton';
import { useAppStore } from '../store/useAppStore';
import { useHabit, useHabitIds, useOccupiedSensorSlots } from '../store/selectors';
import { habitSlot } from '../services/WidgetContract';
import { Plus, Check, Flame, X, Timer, Heart, Sparkles, Minus, TrendingUp, Compass, User as UserIcon, Activity } from 'lucide-react-native';
import dayjs from 'dayjs';
import { useNavigation } from '@react-navigation/native';
import { HabitsScreenStyles as styles } from '../styles/Habit.styles';
import { COMMON_HABITS_TEMPLATES, HabitTemplate, habitFromTemplate } from '../utils/HabitTemplates';

type NewHabitType = 'check' | 'timer' | 'numeric';

/**
 * The stored vocabulary and the spoken one disagree: a habit the user calls a
 * COUNT is stored as `'numeric'`. Keeping the mapping in one table stops that
 * mismatch from being re-derived at three separate call sites.
 */
const HABIT_TYPES: { key: NewHabitType; Icon: typeof Check; label: string }[] = [
    { key: 'check', Icon: Check, label: 'CHECK' },
    { key: 'numeric', Icon: TrendingUp, label: 'COUNT' },
    { key: 'timer', Icon: Timer, label: 'TIMER' },
];

/** One line of plain English so the selected chip explains itself. */
const TYPE_HINT: Record<NewHabitType, string> = {
    check: 'DONE OR NOT DONE',
    numeric: 'COUNT TOWARDS A NUMBER',
    timer: 'RUN A CLOCK',
};

interface HabitRowProps {
    habitId: string;
    navigation: any;
    theme: any;
    todayStr: string;
    toggleHabit: (id: string, date: string) => void;
    updateNumericProgress: (id: string, date: string, delta: number) => void;
}

/**
 * One habit row that subscribes to *its own* habit via useHabit(id). Because the
 * normalized store rebuilds only the habit that changed, ticking or incrementing one
 * habit re-renders exactly this row and leaves every sibling untouched — the fix for
 * "lags when I switch tabs" once a profile has many habits. Memoised so a parent
 * re-render (e.g. the Explore occupancy list changing) never repaints a whole list of
 * rows whose own habit did not move.
 */
const HabitRow = React.memo(({
    habitId,
    navigation,
    theme,
    todayStr,
    toggleHabit,
    updateNumericProgress,
}: HabitRowProps) => {
    const item = useHabit(habitId);
    if (!item) return null;
    return (
        <TouchableOpacity
            activeOpacity={0.7}
            onPress={() => navigation.navigate('HabitDetail', { habitId: item.id })}
        >
            <NothingCard margin="xs" style={styles.habitCard}>
                <View style={styles.habitMain}>
                    <View style={styles.habitInfo}>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            {item.type === 'timer' && <Timer size={14} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />}
                            {item.type === 'numeric' && <TrendingUp size={14} color={theme.colors.textSecondary} style={{ marginRight: 6 }} />}
                            <NothingText variant="bold" size={18}>{item.title}</NothingText>
                        </View>
                        <View style={styles.streakContainer}>
                            <Flame size={14} color={theme.colors.primary} />
                            <NothingText size={12} color={theme.colors.textSecondary} style={styles.streakText}>
                                {item.streak} DAY STREAK
                            </NothingText>
                        </View>
                    </View>

                    {/* Slot decides the control, not the raw isSensorBased flag: a sensor
                        habit whose templateId survived but whose sensorType was lost must
                        still render AUTO, not hand-editable +/- over a measured number. */}
                    {habitSlot(item) ? (
                        <View style={{ alignItems: 'flex-end', justifyContent: 'center', paddingRight: 8 }}>
                            <NothingText size={10} color={theme.colors.primary} variant="bold">AUTO</NothingText>
                            <Activity size={20} color={theme.colors.primary + '50'} />
                        </View>
                    ) : item.type === 'numeric' ? (
                        <View style={styles.numericControls}>
                            <TouchableOpacity
                                style={[styles.numericBtn, { borderColor: theme.colors.border }]}
                                onPress={() => updateNumericProgress(item.id, todayStr, -1)}
                            >
                                <Minus size={18} color={theme.colors.text} />
                            </TouchableOpacity>
                            <View style={styles.progressText}>
                                <NothingText variant="bold" size={16}>{item.numericProgress?.[todayStr] || 0}</NothingText>
                                <NothingText size={8} color={theme.colors.textSecondary}>{item.numericUnit?.toUpperCase()}</NothingText>
                            </View>
                            <TouchableOpacity
                                style={[styles.numericBtn, { borderColor: theme.colors.border, backgroundColor: (item.numericProgress?.[todayStr] || 0) >= (item.numericGoal || 1) ? theme.colors.primary : 'transparent' }]}
                                onPress={() => updateNumericProgress(item.id, todayStr, 1)}
                            >
                                <Plus size={18} color={(item.numericProgress?.[todayStr] || 0) >= (item.numericGoal || 1) ? theme.colors.background : theme.colors.text} />
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <TouchableOpacity
                            onPress={() => toggleHabit(item.id, todayStr)}
                            style={[
                                styles.checkBtn,
                                { borderColor: theme.colors.border },
                                item.completedDates.includes(todayStr) && { backgroundColor: theme.colors.text, borderColor: theme.colors.text }
                            ]}
                        >
                            <Check
                                color={item.completedDates.includes(todayStr) ? theme.colors.background : theme.colors.textSecondary}
                                size={24}
                            />
                        </TouchableOpacity>
                    )}
                </View>
            </NothingCard>
        </TouchableOpacity>
    );
});
HabitRow.displayName = 'HabitRow';

export const HabitsScreen = () => {
    const route = useRoute<any>();
    const navigation = useNavigation<any>();
    const habitIds = useHabitIds();
    const occupiedSlots = useOccupiedSensorSlots();
    const addHabit = useAppStore(s => s.addHabit);
    const toggleHabit = useAppStore(s => s.toggleHabit);
    const updateNumericProgress = useAppStore(s => s.updateNumericProgress);
    const { theme } = useTheme();
    const [activeTab, setActiveTab] = useState<'my' | 'explore'>('my');
    const [isAddModalVisible, setIsAddModalVisible] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newFreq, setNewFreq] = useState<'daily' | 'weekly' | 'monthly'>('daily');
    const [newType, setNewType] = useState<'check' | 'timer' | 'numeric'>('check');
    const [newTimerGoal, setNewTimerGoal] = useState('10'); // minutes

    React.useEffect(() => {
        if (route.params?.openAdd) {
            setIsAddModalVisible(true);
            navigation.setParams({ openAdd: undefined });
        }

        // Handle deep link for specific sensor habit from widget
        if (route.params?.templateId) {
            const template = COMMON_HABITS_TEMPLATES.find(t => t.id === route.params.templateId);
            if (template) {
                // Match by slot, never a raw sensorType compare: a non-sensor template has
                // no sensorType, and `h.sensorType === undefined` would collide with every
                // hand-made habit. Read the store imperatively so the effect stays unsubscribed.
                const slot = habitSlot(template);
                const { habitsById, habitIds: ids } = useAppStore.getState();
                const existingId = slot
                    ? ids.find(id => habitSlot(habitsById[id]) === slot)
                    : undefined;
                if (existingId) {
                    navigation.navigate('HabitDetail', { habitId: existingId });
                } else {
                    setActiveTab('explore');
                    navigation.navigate('HabitKnowledge', { template });
                }
            }
            navigation.setParams({ templateId: undefined });
        }
    }, [route.params?.openAdd, route.params?.templateId]);

    const [newNumericGoal, setNewNumericGoal] = useState('8');
    const [newNumericUnit, setNewNumericUnit] = useState('glasses');

    const handleAddHabit = () => {
        if (newTitle.trim()) {
            // Start from the template so sensor wiring, templateId and any
            // inverse-goal config come along, then let the form's own fields win.
            const base = selectedTemplate
                ? habitFromTemplate(selectedTemplate, undefined, theme.colors.primary)
                : {};

            addHabit({
                ...base,
                title: newTitle,
                description: newDesc,
                frequency: newFreq,
                type: newType,
                timerGoal: newType === 'timer' ? parseInt(newTimerGoal) * 60 : undefined,
                numericGoal: newType === 'numeric' ? parseInt(newNumericGoal) : undefined,
                numericUnit: newType === 'numeric' ? newNumericUnit : undefined,
                reminders: [],
                color: theme.colors.primary,
                cue: selectedTemplate?.cue,
                craving: selectedTemplate?.craving,
                response: selectedTemplate?.response,
                reward: selectedTemplate?.reward,
                howToApply: selectedTemplate?.howToApply,
            } as any);
            setNewTitle('');
            setNewDesc('');
            setNewType('check');
            setNewTimerGoal('10');
            setNewNumericGoal('8');
            setNewNumericUnit('glasses');
            setSelectedTemplate(null);
            setIsAddModalVisible(false);
        }
    };

    const [selectedTemplate, setSelectedTemplate] = useState<HabitTemplate | null>(null);

    const handleSelectTemplateInModal = (template: HabitTemplate) => {
        setSelectedTemplate(template);
        setNewTitle(template.title);
        setNewDesc(template.description);
        setNewType(template.type);
        if (template.type === 'numeric') {
            setNewNumericGoal(template.goal?.toString() || '8');
            setNewNumericUnit(template.unit || 'units');
        } else if (template.type === 'timer') {
            setNewTimerGoal(((template.goal || 0) / 60).toString() || '10');
        }
    };

    const handleTemplateSelect = (template: HabitTemplate) => {
        navigation.navigate('HabitKnowledge', { template });
    };

    const todayStr = dayjs().format('YYYY-MM-DD');

    const renderMyItem = useCallback(({ item }: { item: string }) => (
        <HabitRow
            habitId={item}
            navigation={navigation}
            theme={theme}
            todayStr={todayStr}
            toggleHabit={toggleHabit}
            updateNumericProgress={updateNumericProgress}
        />
    ), [navigation, theme, todayStr, toggleHabit, updateNumericProgress]);

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
            <View style={styles.header}>
                <NothingText variant="dot" style={{ fontFamily: 'ndot' }} size={32}>RISE HABITS</NothingText>
            </View>

            <View style={styles.tabContainer}>
                <TouchableOpacity
                    onPress={() => setActiveTab('my')}
                    style={[styles.tab, activeTab === 'my' && { borderBottomColor: theme.colors.primary }]}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <UserIcon size={16} color={activeTab === 'my' ? theme.colors.text : theme.colors.textSecondary} style={{ marginRight: 8 }} />
                        <NothingText variant={activeTab === 'my' ? 'bold' : 'regular'} color={activeTab === 'my' ? theme.colors.text : theme.colors.textSecondary}>MY LIST</NothingText>
                    </View>
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => setActiveTab('explore')}
                    style={[styles.tab, activeTab === 'explore' && { borderBottomColor: theme.colors.primary }]}
                >
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Compass size={16} color={activeTab === 'explore' ? theme.colors.text : theme.colors.textSecondary} style={{ marginRight: 8 }} />
                        <NothingText variant={activeTab === 'explore' ? 'bold' : 'regular'} color={activeTab === 'explore' ? theme.colors.text : theme.colors.textSecondary}>EXPLORE</NothingText>
                    </View>
                </TouchableOpacity>
            </View>

            <FlatList
                showsVerticalScrollIndicator={false}
                initialNumToRender={8}
                maxToRenderPerBatch={8}
                windowSize={5}
                removeClippedSubviews={Platform.OS === 'android'}
                data={activeTab === 'my' ? habitIds : [
                    { id: 'header_sensor', isHeader: true, title: 'SENSORS' },
                    ...COMMON_HABITS_TEMPLATES.filter(t => t.isSensorBased),
                    { id: 'header_regular', isHeader: true, title: 'REGULAR' },
                    ...COMMON_HABITS_TEMPLATES.filter(t => !t.isSensorBased)
                ] as any}
                renderItem={(activeTab === 'my' ? renderMyItem : ({ item }: { item: any }) => {
                    if (item.isHeader) {
                        return (
                            <View style={{ paddingVertical: 12, paddingHorizontal: 4, marginTop: item.title === 'REGULAR HABITS' ? 16 : 0 }}>
                                {item.title === 'REGULAR HABITS' && <View style={{ height: 1, backgroundColor: theme.colors.border, opacity: 0.3, marginBottom: 16 }} />}
                                <NothingText variant="bold" size={12} color={theme.colors.textSecondary} style={{ letterSpacing: 3 }}>{item.title}</NothingText>
                            </View>
                        );
                    }

                    const isSensor = item.isSensorBased;
                    // Resolve the template's slot (templateId→slot, sensorType fallback) and
                    // ask the stable occupancy list whether a habit already fills it — no
                    // subscription to habit *contents*, so this list does not repaint on a tick.
                    const slot = isSensor ? habitSlot(item) : null;
                    const added = !!slot && occupiedSlots.includes(slot);

                    return (
                        <TouchableOpacity
                            onPress={() => {
                                if (added && slot) {
                                    // Resolve the occupying habit imperatively at tap time, so the
                                    // row never subscribes to habit contents just to navigate.
                                    const st = useAppStore.getState();
                                    const existingId = st.habitIds.find(id => habitSlot(st.habitsById[id]) === slot);
                                    if (existingId) navigation.navigate('HabitDetail', { habitId: existingId });
                                } else {
                                    handleTemplateSelect(item);
                                }
                            }}
                        >
                            <NothingCard
                                margin="xs"
                                style={[
                                    styles.habitCard,
                                    { padding: 12 },
                                    isSensor && {
                                        borderColor: theme.colors.primary + '80',
                                        borderWidth: 1.5,
                                        backgroundColor: theme.colors.surface1,
                                        shadowColor: theme.colors.primary,
                                        shadowOffset: { width: 0, height: 0 },
                                        shadowOpacity: 0.2,
                                        shadowRadius: 10,
                                        elevation: 4
                                    }
                                ]}
                            >
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <View style={[styles.templateIcon, {
                                        backgroundColor: item.color + '20',
                                        marginBottom: 0,
                                        marginRight: 16,
                                        borderColor: isSensor ? theme.colors.primary + '40' : 'transparent',
                                        borderWidth: isSensor ? 1 : 0
                                    }]}>
                                        <Sparkles size={18} color={item.color} />
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                            <NothingText variant="bold" size={16} color={isSensor ? theme.colors.text : theme.colors.text}>{item.title}</NothingText>
                                            {isSensor && (
                                                <View style={{ marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 2, backgroundColor: added ? theme.colors.success + '20' : theme.colors.primary + '20' }}>
                                                    <NothingText size={7} color={added ? theme.colors.success : theme.colors.primary} variant="bold" style={{ letterSpacing: 1 }}>
                                                        {added ? 'ADDED' : 'AUTO-LINK'}
                                                    </NothingText>
                                                </View>
                                            )}
                                        </View>
                                        <NothingText size={12} color={theme.colors.textSecondary} numberOfLines={1}>{item.description}</NothingText>
                                    </View>
                                    <View style={{ alignItems: 'flex-end' }}>
                                        <NothingText size={10} color={item.category === 'Bad Habit' ? '#EF4444' : theme.colors.primary} variant="bold">
                                            {item.category.toUpperCase()}
                                        </NothingText>
                                        {isSensor && <Activity size={12} color={theme.colors.primary + '60'} style={{ marginTop: 4 }} />}
                                    </View>
                                </View>
                            </NothingCard>
                        </TouchableOpacity>
                    );
                }) as any}
                keyExtractor={(activeTab === 'my' ? (item: any) => item : (item: any) => item.id) as any}
                contentContainerStyle={styles.listContainer}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <NothingText color={theme.colors.textSecondary}>
                            {activeTab === 'my' ? 'No habits being tracked' : 'Loading common habits...'}
                        </NothingText>
                    </View>
                }
            />

            <TouchableOpacity
                style={[styles.fab, { backgroundColor: theme.colors.primary }]}
                onPress={() => setIsAddModalVisible(true)}
            >
                <Plus color={theme.colors.background} size={32} />
            </TouchableOpacity>

            <Modal
                animationType="slide"
                transparent={true}
                visible={isAddModalVisible}
                onRequestClose={() => {
                    setIsAddModalVisible(false);
                    // Reset state to prevent "auto-linking" or stale data
                    setNewTitle('');
                    setNewDesc('');
                    setNewType('check');
                    setNewTimerGoal('10');
                    setNewNumericGoal('8');
                    setNewNumericUnit('glasses');
                }}
            >
                <View style={styles.modalOverlay}>
                    <NothingCard style={[styles.modalContent, { backgroundColor: theme.colors.surface }]} padding="lg">
                        <View style={styles.modalHeader}>
                            <NothingText variant="bold" size={20}>NEW HABIT</NothingText>
                            <TouchableOpacity onPress={() => {
                                setIsAddModalVisible(false);
                                setNewTitle('');
                                setNewDesc('');
                                setSelectedTemplate(null);
                            }}>
                                <X color={theme.colors.text} size={24} />
                            </TouchableOpacity>
                        </View>

                        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 500 }}>
                            <View style={{ marginBottom: 16 }}>
                                <NothingText variant="bold" size={12} color={theme.colors.textSecondary} style={{ marginBottom: 8, letterSpacing: 1 }}>BASE ON TEMPLATE (OPTIONAL)</NothingText>
                                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -4 }}>
                                    {COMMON_HABITS_TEMPLATES.filter(t => !t.isSensorBased).slice(0, 6).map(t => (
                                        <TouchableOpacity
                                            key={t.id}
                                            onPress={() => handleSelectTemplateInModal(t)}
                                            style={{
                                                paddingHorizontal: 12,
                                                paddingVertical: 8,
                                                borderRadius: 8,
                                                backgroundColor: selectedTemplate?.id === t.id ? theme.colors.primary + '20' : theme.colors.surface1,
                                                borderColor: selectedTemplate?.id === t.id ? theme.colors.primary : theme.colors.border,
                                                borderWidth: 1,
                                                marginHorizontal: 4,
                                                flexDirection: 'row',
                                                alignItems: 'center'
                                            }}
                                        >
                                            <NothingText size={12} color={selectedTemplate?.id === t.id ? theme.colors.primary : theme.colors.text}>{t.title}</NothingText>
                                        </TouchableOpacity>
                                    ))}
                                </ScrollView>
                            </View>

                            <NothingInput
                                placeholder="Habit Name"
                                value={newTitle}
                                onChangeText={setNewTitle}
                            />

                            <NothingInput
                                placeholder="Description (Optional)"
                                value={newDesc}
                                onChangeText={setNewDesc}
                                multiline
                            />

                            <View style={styles.freqRow}>
                                {(['daily', 'weekly', 'monthly'] as const).map(f => (
                                    <TouchableOpacity
                                        key={f}
                                        onPress={() => setNewFreq(f)}
                                        style={[
                                            styles.freqChip,
                                            { borderColor: theme.colors.border },
                                            newFreq === f && { backgroundColor: theme.colors.text, borderColor: theme.colors.text }
                                        ]}
                                    >
                                        <NothingText size={12} color={newFreq === f ? theme.colors.background : theme.colors.text}>
                                            {f.toUpperCase()}
                                        </NothingText>
                                    </TouchableOpacity>
                                ))}
                            </View>

                            <View style={styles.typeHeaderRow}>
                                <NothingText variant="bold" size={14}>TYPE</NothingText>
                            </View>
                            <View style={styles.typeRow}>
                                {HABIT_TYPES.map(({ key, Icon, label }) => {
                                    const selected = newType === key;
                                    return (
                                        <TouchableOpacity
                                            key={key}
                                            activeOpacity={0.85}
                                            onPress={() => setNewType(key)}
                                            style={[
                                                styles.typeBtn,
                                                // Order is load-bearing. The old code put the
                                                // unselected borderColor *after* the selected
                                                // one, so the selection never showed a border
                                                // and the only cue left was a 6% tint.
                                                { borderColor: theme.colors.border, backgroundColor: 'transparent' },
                                                selected && {
                                                    borderColor: theme.colors.text,
                                                    backgroundColor: theme.colors.text,
                                                },
                                            ]}
                                        >
                                            <Icon
                                                size={16}
                                                color={selected ? theme.colors.background : theme.colors.textSecondary}
                                            />
                                            <NothingText
                                                size={selected ? 12 : 10}
                                                color={selected ? theme.colors.background : theme.colors.textSecondary}
                                                style={[styles.typeBtnLabel, selected && styles.typeBtnLabelActive]}
                                            >
                                                {label}
                                            </NothingText>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>

                            {newType === 'numeric' && (
                                <View style={{ marginBottom: 24, flexDirection: 'row', gap: 12 }}>
                                    <View style={{ flex: 1 }}>
                                        <NothingText variant="bold" size={14} style={{ marginBottom: 8 }}>GOAL</NothingText>
                                        <NothingInput
                                            placeholder="8"
                                            value={newNumericGoal}
                                            onChangeText={setNewNumericGoal}
                                            keyboardType="numeric"
                                        />
                                    </View>
                                    <View style={{ flex: 2 }}>
                                        <NothingText variant="bold" size={14} style={{ marginBottom: 8 }}>UNIT</NothingText>
                                        <NothingInput
                                            placeholder="glasses"
                                            value={newNumericUnit}
                                            onChangeText={setNewNumericUnit}
                                        />
                                    </View>
                                </View>
                            )}

                            {newType === 'timer' && (
                                <View style={{ marginBottom: 24 }}>
                                    <NothingText variant="bold" size={14} style={{ marginBottom: 12 }}>DURATION (MINS)</NothingText>
                                    <NothingInput
                                        placeholder="10"
                                        value={newTimerGoal}
                                        onChangeText={setNewTimerGoal}
                                        keyboardType="numeric"
                                    />
                                </View>
                            )}

                            <NothingButton
                                label="Start Tracking"
                                onPress={handleAddHabit}
                                style={styles.submitBtn}
                            />
                        </ScrollView>
                    </NothingCard>
                </View>
            </Modal>
        </SafeAreaView>
    );
};