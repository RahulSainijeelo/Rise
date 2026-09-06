import RNFS from 'react-native-fs';

/**
 * The Deck's saved arrangement.
 *
 * Kept in its own file rather than in useAppStore because the store's data is
 * per-profile and loaded through loadData/saveData: a layout is a property of the
 * device and the home surface, not of whoever is signed in. A layout that vanished
 * on profile switch — or, worse, that a profile switch overwrote — would be a
 * strange thing for the user to have to understand.
 *
 * The one thing that *is* profile-shaped is a habit card's habitId. Rather than
 * partitioning the file, DeckScreen drops habit cards whose habit no longer exists
 * when it renders. That way a stale card disappears instead of showing a blank, and
 * switching back to the original profile brings it straight back.
 */

const APP_FOLDER_NAME = 'Rise_Data';
const DECK_FILE = 'deck_layout.json';
const BASE_PATH = `${RNFS.DocumentDirectoryPath}/${APP_FOLDER_NAME}`;

/**
 * The three states the Deck tab can be in.
 *
 * All three show the *same* cards. `edit` adds the arranging controls to them in place
 * and `zen` takes the controls away; neither is a separate arrangement. An earlier
 * version did keep two lists, one for normal and one for zen, and the user's verdict
 * was immediate: "we don't have to edit both modes individually they are basically
 * one."
 */
export type DeckViewMode = 'normal' | 'edit' | 'zen';

export type DeckCardKind = 'clock' | 'timer' | 'habit';

/**
 * The five faces. Ids are stored, so renaming a face is free but reordering or
 * renumbering them is not — an unknown id falls back to the default rather than
 * rendering nothing.
 */
export type WatchFaceId = 'matrix' | 'stack' | 'hairline' | 'serif' | 'block';

export const WATCH_FACE_IDS: WatchFaceId[] = [
    'matrix',
    'stack',
    'hairline',
    'serif',
    'block',
];

export const DEFAULT_WATCH_FACE: WatchFaceId = 'matrix';

export interface DeckCard {
    /** Unique per card, not per kind: the same face can be placed twice. */
    id: string;
    kind: DeckCardKind;
    /** Clock cards only. */
    faceId?: WatchFaceId;
    /** Habit cards only. Resolved against the live habit list at render time. */
    habitId?: string;
}

export interface DeckLayout {
    /** One arrangement, shown in every mode. */
    cards: DeckCard[];
}

let seq = 0;
/**
 * Card ids only need to be unique within one layout, and they are generated on the
 * device that stores them, so time plus a counter is enough. The counter matters:
 * two cards added inside the same millisecond would otherwise collide, and React
 * would quietly reuse one card's state for the other.
 */
export const newDeckCardId = (): string =>
    `dc_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/**
 * What a first-time Deck looks like.
 *
 * It opens with the default face and the focus timer, because a tab that opens empty
 * reads as broken rather than as unconfigured.
 */
export const defaultDeckLayout = (): DeckLayout => ({
    cards: [
        { id: newDeckCardId(), kind: 'clock', faceId: DEFAULT_WATCH_FACE },
        { id: newDeckCardId(), kind: 'timer' },
    ],
});

const asFace = (v: any): WatchFaceId =>
    WATCH_FACE_IDS.includes(v) ? v : DEFAULT_WATCH_FACE;

/**
 * Read one card back defensively.
 *
 * This file is on disk across app versions, so every field is treated as untrusted:
 * a card kind that no longer exists, or a clock with no face, has to degrade to
 * something renderable instead of throwing inside a list render — which in React
 * Native means a red screen on the tab the user just opened.
 */
const parseCard = (raw: any): DeckCard | null => {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : newDeckCardId();

    if (raw.kind === 'clock') return { id, kind: 'clock', faceId: asFace(raw.faceId) };
    if (raw.kind === 'timer') return { id, kind: 'timer' };
    if (raw.kind === 'habit') {
        const habitId = typeof raw.habitId === 'string' ? raw.habitId : '';
        // A habit card with no habit can never resolve to anything, so it is dropped
        // here rather than carried around as a permanently blank tile.
        return habitId ? { id, kind: 'habit', habitId } : null;
    }
    return null;
};

const parseLayout = (raw: any): DeckLayout => {
    const fallback = defaultDeckLayout();
    if (!raw || typeof raw !== 'object') return fallback;

    const list = (v: any): DeckCard[] =>
        Array.isArray(v) ? (v.map(parseCard).filter(Boolean) as DeckCard[]) : [];

    // An empty saved deck is respected — clearing every card is a legitimate thing to
    // do in edit mode, and re-seeding it with defaults would make that impossible.
    // Only a file we could not read at all falls back.
    if (Array.isArray(raw.cards)) return { cards: list(raw.cards) };

    // Migration from the two-list shape this file used to hold. The normal list is the
    // one the user arranged for the tab itself, so it becomes the single deck; the zen
    // list is only consulted if normal was never populated, which is the one case where
    // dropping it would lose the user's only arrangement.
    if (Array.isArray(raw.normal) || Array.isArray(raw.zen)) {
        const normal = list(raw.normal);
        return { cards: normal.length ? normal : list(raw.zen) };
    }

    return fallback;
};

async function ensureDir(): Promise<boolean> {
    if (!RNFS || !RNFS.exists) return false;
    try {
        if (!(await RNFS.exists(BASE_PATH))) await RNFS.mkdir(BASE_PATH);
        return true;
    } catch (e) {
        console.warn('Deck: could not prepare storage', e);
        return false;
    }
}

export async function getDeckLayout(): Promise<DeckLayout> {
    if (!(await ensureDir())) return defaultDeckLayout();
    const path = `${BASE_PATH}/${DECK_FILE}`;
    try {
        if (await RNFS.exists(path)) {
            return parseLayout(JSON.parse(await RNFS.readFile(path, 'utf8')));
        }
    } catch (e) {
        console.warn('Deck: could not read layout', e);
    }
    return defaultDeckLayout();
}

export async function saveDeckLayout(layout: DeckLayout): Promise<void> {
    if (!(await ensureDir())) return;
    try {
        await RNFS.writeFile(
            `${BASE_PATH}/${DECK_FILE}`,
            JSON.stringify(layout, null, 2),
            'utf8',
        );
    } catch (e) {
        console.error('Deck: could not save layout', e);
    }
}
