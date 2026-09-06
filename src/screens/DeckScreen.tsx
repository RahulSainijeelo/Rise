import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    View,
    ScrollView,
    TouchableOpacity,
    Modal,
    StatusBar,
    AppState,
    Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import {
    Pencil,
    Check,
    Plus,
    Trash2,
    ArrowUp,
    ArrowDown,
    Clock,
    Timer as TimerIcon,
    Activity,
    Moon,
    X,
} from 'lucide-react-native';
import { useTheme } from '../theme';
import { NothingText } from '../components/NothingText';
import { useAppStore } from '../store/useAppStore';
import {
    DEFAULT_WATCH_FACE,
    getDeckLayout,
    newDeckCardId,
    saveDeckLayout,
    type DeckCard,
    type DeckLayout,
    type DeckViewMode,
    type WatchFaceId,
} from '../services/DeckService';
import { WatchFace, WATCH_FACES, watchFaceMeta } from '../components/deck/WatchFaces';
import { DeckTimerCard } from '../components/deck/DeckTimerCard';
import { DeckHabitCard } from '../components/deck/DeckHabitCard';

/**
 * The Deck.
 *
 * One arrangement, three ways of looking at it. Normal is the deck; edit is the same
 * deck with handles on it; zen is the same deck on black with the handles and the
 * controls taken away.
 *
 * There used to be two arrangements, one for normal and one for zen, and edit mode had
 * a switch between them. The user's verdict was that this was one thing pretending to
 * be two — "we don't have to edit both modes individually they are basically one" — so
 * there is now a single list, and the modes differ only in what they let you touch.
 * Nothing you can reach in zen mode can change the deck.
 *
 * Zen still has to be a full-screen Modal rather than a state flag on this screen,
 * because GlobalHeader is rendered by TabNavigator *above* the navigator: a screen
 * cannot hide it from the inside. The Modal covers the header and the tab bar
 * together, which is the only way "pure black other than the features" is achievable.
 */

/** How a card is being shown. Not a layout — the layout is the same in all three. */
type CardVariant = 'normal' | 'edit' | 'zen';

export const DeckScreen = ({ navigation }: any) => {
    const { theme } = useTheme();
    const habits = useAppStore(s => s.habits);

    const [layout, setLayout] = useState<DeckLayout | null>(null);
    const [mode, setMode] = useState<DeckViewMode>('normal');
    const [picking, setPicking] = useState(false);
    const [now, setNow] = useState(new Date());

    const isFocused = useIsFocused();
    const [appActive, setAppActive] = useState(AppState.currentState === 'active');

    useEffect(() => {
        const sub = AppState.addEventListener('change', s => setAppActive(s === 'active'));
        return () => sub.remove();
    }, []);

    useEffect(() => {
        let alive = true;
        getDeckLayout().then(l => { if (alive) setLayout(l); });
        return () => { alive = false; };
    }, []);

    /**
     * One clock for every face on screen.
     *
     * Held here rather than inside each face so two faces can never disagree by a
     * second, and stopped when the Deck is not on screen — a clock ticking behind
     * three other tabs is a wakeup a second for nothing.
     */
    const live = isFocused && appActive;
    useEffect(() => {
        if (!live) return;
        setNow(new Date());
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, [live]);

    const commit = useCallback((next: DeckLayout) => {
        setLayout(next);
        // Fire and forget: a failed write is logged by the service and costs the user
        // the arrangement on next launch, which is not worth blocking a tap over.
        saveDeckLayout(next);
    }, []);

    const mutate = useCallback(
        (fn: (cards: DeckCard[]) => DeckCard[]) => {
            if (!layout) return;
            commit({ cards: fn(layout.cards) });
        },
        [layout, commit],
    );

    const addCard = (card: DeckCard) => mutate(cards => [...cards, card]);

    const removeCard = (id: string) => mutate(cards => cards.filter(c => c.id !== id));

    const moveCard = (id: string, delta: -1 | 1) =>
        mutate(cards => {
            const i = cards.findIndex(c => c.id === id);
            const j = i + delta;
            if (i < 0 || j < 0 || j >= cards.length) return cards;
            const next = [...cards];
            [next[i], next[j]] = [next[j], next[i]];
            return next;
        });

    const setFace = (id: string, faceId: WatchFaceId) =>
        mutate(cards => cards.map(c => (c.id === id ? { ...c, faceId } : c)));

    const habitById = useMemo(() => {
        const m = new Map<string, typeof habits[number]>();
        habits.forEach(h => m.set(h.id, h));
        return m;
    }, [habits]);

    /**
     * Cards that can actually render right now.
     *
     * A habit card whose habit was deleted — or that belongs to another profile — is
     * dropped here rather than removed from the file, so switching back to that
     * profile brings the card straight back instead of the user having to rebuild it.
     */
    const cards: DeckCard[] = (layout?.cards || []).filter(
        c => c.kind !== 'habit' || (c.habitId ? habitById.has(c.habitId) : false),
    );

    const renderCard = (card: DeckCard, variant: CardVariant) => {
        const zen = variant === 'zen';
        // Only the normal deck is operable. In edit mode the cards are the thing being
        // arranged, so a stray tap should not start a focus session.
        const interactive = variant === 'normal';

        switch (card.kind) {
            case 'clock':
                return (
                    <View
                        key={card.id}
                        style={
                            variant === 'normal'
                                ? {
                                    borderWidth: 1,
                                    borderColor: theme.colors.border,
                                    borderRadius: 18,
                                    padding: 16,
                                    backgroundColor: theme.colors.surface,
                                }
                                : { alignItems: 'flex-start' }
                        }>
                        <WatchFace
                            faceId={card.faceId || DEFAULT_WATCH_FACE}
                            now={now}
                            scale={zen ? 1.35 : 1}
                        />
                    </View>
                );
            case 'timer':
                return (
                    <DeckTimerCard
                        key={card.id}
                        active={live}
                        scale={zen ? 1.15 : 1}
                        chrome={variant === 'normal'}
                        controls={interactive}
                        onOpen={interactive ? () => navigation.navigate('Focus') : undefined}
                    />
                );
            case 'habit': {
                const habit = card.habitId ? habitById.get(card.habitId) : undefined;
                if (!habit) return null;
                return (
                    <DeckHabitCard
                        key={card.id}
                        habit={habit}
                        active={live}
                        scale={zen ? 1.15 : 1}
                        chrome={variant === 'normal'}
                        controls={interactive}
                        onOpen={
                            interactive
                                ? id => navigation.navigate('HabitDetail', { habitId: id })
                                : undefined
                        }
                    />
                );
            }
            default:
                return null;
        }
    };

    // ─── chrome ────────────────────────────────────────────────────────────────

    const modeButton = (
        label: string,
        icon: React.ReactNode,
        onPress: () => void,
        on = false,
    ) => (
        <TouchableOpacity
            onPress={onPress}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                height: 34,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: on ? theme.colors.primary : theme.colors.border,
                backgroundColor: on ? `${theme.colors.primary}1A` : 'transparent',
            }}>
            {icon}
            <NothingText
                variant="bold"
                size={10}
                color={on ? theme.colors.primary : theme.colors.text}
                style={{ letterSpacing: 1.6 }}>
                {label}
            </NothingText>
        </TouchableOpacity>
    );

    const cardLabel = (card: DeckCard): string => {
        if (card.kind === 'clock') {
            return `CLOCK · ${watchFaceMeta(card.faceId || DEFAULT_WATCH_FACE).name}`;
        }
        if (card.kind === 'timer') return 'FOCUS TIMER';
        const habit = card.habitId ? habitById.get(card.habitId) : undefined;
        return `HABIT · ${(habit?.title || 'MISSING').toUpperCase()}`;
    };

    /**
     * A card with handles on it.
     *
     * The real card is rendered inside the frame rather than represented by a row of
     * text, so moving something is a decision about what you can see. `pointerEvents`
     * is off on the preview: in edit mode a tap belongs to the frame, not to the card.
     */
    const editFrame = (card: DeckCard, index: number, total: number) => (
        <View
            key={card.id}
            style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 16,
                padding: 12,
                backgroundColor: theme.colors.surface,
            }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <NothingText
                    variant="bold"
                    size={10}
                    color={theme.colors.textSecondary}
                    numberOfLines={1}
                    style={{ flex: 1, letterSpacing: 1.4 }}>
                    {cardLabel(card)}
                </NothingText>
                <TouchableOpacity
                    onPress={() => moveCard(card.id, -1)}
                    disabled={index === 0}
                    hitSlop={8}
                    accessibilityLabel="Move up"
                    style={{ padding: 6, opacity: index === 0 ? 0.3 : 1 }}>
                    <ArrowUp size={16} color={theme.colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => moveCard(card.id, 1)}
                    disabled={index === total - 1}
                    hitSlop={8}
                    accessibilityLabel="Move down"
                    style={{ padding: 6, opacity: index === total - 1 ? 0.3 : 1 }}>
                    <ArrowDown size={16} color={theme.colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => removeCard(card.id)}
                    hitSlop={8}
                    accessibilityLabel="Remove card"
                    style={{ padding: 6 }}>
                    <Trash2 size={16} color={theme.colors.error} />
                </TouchableOpacity>
            </View>

            <View pointerEvents="none" style={{ marginTop: 10 }}>
                {renderCard(card, 'edit')}
            </View>

            {/*
              The face picker sits on the card it belongs to rather than in a separate
              screen, so the user can see which of five clocks they are changing.
            */}
            {card.kind === 'clock' ? (
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ marginTop: 12 }}
                    contentContainerStyle={{ gap: 6 }}>
                    {WATCH_FACES.map(face => {
                        const on = (card.faceId || DEFAULT_WATCH_FACE) === face.id;
                        return (
                            <TouchableOpacity
                                key={face.id}
                                onPress={() => setFace(card.id, face.id)}
                                style={{
                                    paddingHorizontal: 10,
                                    paddingVertical: 7,
                                    borderRadius: 9,
                                    borderWidth: 1,
                                    borderColor: on ? theme.colors.primary : theme.colors.border,
                                    backgroundColor: on ? `${theme.colors.primary}1A` : 'transparent',
                                }}>
                                <NothingText
                                    variant="bold"
                                    size={9}
                                    color={on ? theme.colors.primary : theme.colors.text}
                                    style={{ letterSpacing: 1.2 }}>
                                    {face.name}
                                </NothingText>
                                <NothingText size={8} color={theme.colors.textSecondary}>
                                    {face.note}
                                </NothingText>
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            ) : null}
        </View>
    );

    const addButton = (label: string, icon: React.ReactNode, onPress: () => void) => (
        <TouchableOpacity
            onPress={onPress}
            style={{
                flex: 1,
                alignItems: 'center',
                gap: 4,
                paddingVertical: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: theme.colors.border,
            }}>
            {icon}
            <NothingText variant="bold" size={9} style={{ letterSpacing: 1.2 }}>
                {label}
            </NothingText>
        </TouchableOpacity>
    );

    // ─── render ────────────────────────────────────────────────────────────────

    if (!layout) {
        return (
            <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <NothingText size={11} color={theme.colors.textSecondary} style={{ letterSpacing: 2 }}>
                        LOADING DECK
                    </NothingText>
                </View>
            </SafeAreaView>
        );
    }

    const editing = mode === 'edit';

    return (
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }} edges={['bottom']}>
            <ScrollView
                contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
                showsVerticalScrollIndicator={false}>
                {/* The heading the other tabs use: the brand face at 32, named 'ndot'
                    directly because getFontFamily('dot') resolves to Courier. */}
                <NothingText variant="dot" size={32} style={{ fontFamily: 'ndot' }}>
                    RISE DECK
                </NothingText>

                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <NothingText
                        size={10}
                        color={theme.colors.textSecondary}
                        style={{ flex: 1, letterSpacing: 1.4 }}>
                        {editing ? 'ARRANGING YOUR DECK' : `${cards.length} ON THE DECK`}
                    </NothingText>
                    {modeButton(
                        editing ? 'DONE' : 'EDIT',
                        editing
                            ? <Check size={14} color={theme.colors.primary} />
                            : <Pencil size={14} color={theme.colors.text} />,
                        () => setMode(editing ? 'normal' : 'edit'),
                        editing,
                    )}
                    {!editing
                        ? modeButton('ZEN', <Moon size={14} color={theme.colors.text} />, () => setMode('zen'))
                        : null}
                </View>

                {cards.length === 0 && !editing ? (
                    <View style={{ paddingVertical: 40, alignItems: 'center', gap: 10 }}>
                        <NothingText variant="bold" size={12} style={{ letterSpacing: 2 }}>
                            EMPTY DECK
                        </NothingText>
                        <NothingText size={11} color={theme.colors.textSecondary} align="center">
                            Add a watch face, the focus timer, or a habit in edit mode.
                        </NothingText>
                        {modeButton('EDIT', <Pencil size={14} color={theme.colors.text} />, () => setMode('edit'))}
                    </View>
                ) : editing ? (
                    cards.map((card, i) => editFrame(card, i, cards.length))
                ) : (
                    cards.map(card => renderCard(card, 'normal'))
                )}

                {editing ? (
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        {addButton('CLOCK', <Clock size={16} color={theme.colors.text} />, () =>
                            addCard({
                                id: newDeckCardId(),
                                kind: 'clock',
                                faceId: DEFAULT_WATCH_FACE,
                            }))}
                        {addButton('TIMER', <TimerIcon size={16} color={theme.colors.text} />, () =>
                            addCard({ id: newDeckCardId(), kind: 'timer' }))}
                        {addButton('HABIT', <Activity size={16} color={theme.colors.text} />, () =>
                            setPicking(true))}
                    </View>
                ) : null}
            </ScrollView>

            {/* ── zen ──────────────────────────────────────────────────────────── */}
            <Modal
                visible={mode === 'zen'}
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setMode('normal')}>
                <StatusBar hidden />
                {/*
                  Hard-coded black, not theme.background: zen mode is the one screen
                  that should not follow a light theme — the point is a phone that
                  disappears in a dark room.
                */}
                <View style={{ flex: 1, backgroundColor: '#000000' }}>
                    <ScrollView
                        contentContainerStyle={{
                            flexGrow: 1,
                            justifyContent: 'center',
                            paddingHorizontal: 28,
                            paddingVertical: 40,
                            gap: 28,
                        }}
                        showsVerticalScrollIndicator={false}>
                        {cards.length === 0 ? (
                            <NothingText size={11} color="#666666" align="center">
                                Your deck is empty. Add a clock, the focus timer, or a habit in
                                edit mode.
                            </NothingText>
                        ) : (
                            cards.map(card => renderCard(card, 'zen'))
                        )}
                    </ScrollView>

                    {/* The only chrome zen mode keeps. */}
                    <Pressable
                        onPress={() => setMode('normal')}
                        style={{
                            alignSelf: 'center',
                            marginBottom: 34,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 8,
                            paddingHorizontal: 18,
                            paddingVertical: 11,
                            borderRadius: 22,
                            borderWidth: 1,
                            borderColor: '#262626',
                        }}>
                        <X size={13} color="#8A8A8A" />
                        <NothingText variant="bold" size={10} color="#8A8A8A" style={{ letterSpacing: 2 }}>
                            EXIT ZEN
                        </NothingText>
                    </Pressable>
                </View>
            </Modal>

            {/* ── habit picker ─────────────────────────────────────────────────── */}
            <Modal
                visible={picking}
                animationType="slide"
                transparent
                onRequestClose={() => setPicking(false)}>
                <View style={{ flex: 1, backgroundColor: '#000000CC', justifyContent: 'flex-end' }}>
                    <View
                        style={{
                            backgroundColor: theme.colors.background,
                            borderTopLeftRadius: 22,
                            borderTopRightRadius: 22,
                            borderWidth: 1,
                            borderColor: theme.colors.border,
                            paddingTop: 18,
                            paddingBottom: 28,
                            maxHeight: '75%',
                        }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18 }}>
                            <NothingText variant="bold" size={12} style={{ flex: 1, letterSpacing: 2 }}>
                                ADD A HABIT
                            </NothingText>
                            <TouchableOpacity onPress={() => setPicking(false)} hitSlop={10}>
                                <X size={18} color={theme.colors.text} />
                            </TouchableOpacity>
                        </View>

                        {habits.length === 0 ? (
                            <NothingText
                                size={11}
                                color={theme.colors.textSecondary}
                                style={{ paddingHorizontal: 18, paddingTop: 16 }}>
                                You have no habits yet. Create one on the Habits tab first.
                            </NothingText>
                        ) : (
                            <ScrollView
                                contentContainerStyle={{ padding: 18, gap: 8 }}
                                showsVerticalScrollIndicator={false}>
                                {habits.map(habit => (
                                    <TouchableOpacity
                                        key={habit.id}
                                        onPress={() => {
                                            addCard({
                                                id: newDeckCardId(),
                                                kind: 'habit',
                                                habitId: habit.id,
                                            });
                                            setPicking(false);
                                        }}
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            gap: 10,
                                            padding: 14,
                                            borderRadius: 12,
                                            borderWidth: 1,
                                            borderColor: theme.colors.border,
                                        }}>
                                        <Plus size={15} color={theme.colors.primary} />
                                        <View style={{ flex: 1 }}>
                                            <NothingText variant="bold" size={11} numberOfLines={1} style={{ letterSpacing: 1 }}>
                                                {habit.title.toUpperCase()}
                                            </NothingText>
                                            <NothingText size={9} color={theme.colors.textSecondary} style={{ letterSpacing: 1 }}>
                                                {habit.type.toUpperCase()}
                                                {habit.sensorType ? ` · ${habit.sensorType.toUpperCase()}` : ''}
                                            </NothingText>
                                        </View>
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        )}
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
};

export default DeckScreen;
