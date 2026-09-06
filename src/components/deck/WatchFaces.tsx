import React from 'react';
import { View, Text, Platform } from 'react-native';
import { useTheme } from '../../theme';
import { NothingText } from '../NothingText';
import type { WatchFaceId } from '../../services/DeckService';

/**
 * The Deck's watch faces.
 *
 * Five faces that differ in typeface, weight, rhythm and how they treat seconds —
 * not five colourways of one design. The point of offering a choice is that the
 * choice is legible: if the user cannot tell from the picker which one they are
 * getting, the feature is decoration.
 *
 * Every face shows hours, minutes and seconds, and every face treats seconds as the
 * element that proves the clock is live. Where a face shows seconds as a bar or a
 * rule rather than a number, the number is still there — a bar alone cannot be read
 * as a time.
 *
 * Android's built-in families do the typographic work here, so no new font files
 * ship for this. iOS has none of those names, so each one is paired with the nearest
 * system equivalent; without that, all five faces would silently collapse onto San
 * Francisco and the picker would show five identical options.
 */

const font = (android: string, ios: string) =>
    Platform.select({ android, ios, default: ios }) as string;

/** The app's own dot-matrix face, bundled at android/app/src/main/assets/fonts. */
const FONT_DOT = 'ndot';
const FONT_MONO = font('monospace', 'Menlo');
const FONT_THIN = font('sans-serif-thin', 'HelveticaNeue-Thin');
const FONT_SERIF = font('serif', 'Georgia');
const FONT_CONDENSED = font('sans-serif-condensed', 'AvenirNextCondensed-Bold');

export interface WatchFaceMeta {
    id: WatchFaceId;
    /** Shown in the edit-mode picker. */
    name: string;
    /** One line on what makes this face different, for the same picker. */
    note: string;
}

export const WATCH_FACES: WatchFaceMeta[] = [
    { id: 'matrix', name: 'MATRIX', note: 'Dot-matrix, wide tracking' },
    { id: 'stack', name: 'STACK', note: 'Monospaced, units stacked' },
    { id: 'hairline', name: 'HAIRLINE', note: 'Thin, seconds as a rule' },
    { id: 'serif', name: 'EDITORIAL', note: 'Serif, dated' },
    { id: 'block', name: 'BLOCK', note: 'Condensed slab, seconds bar' },
];

export const watchFaceMeta = (id: WatchFaceId): WatchFaceMeta =>
    WATCH_FACES.find(f => f.id === id) || WATCH_FACES[0];

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

interface Props {
    faceId: WatchFaceId;
    /** The tick. Passed in rather than held per face so all faces agree. */
    now: Date;
    /**
     * Scale factor. 1 is the normal-mode size; zen mode passes something larger
     * because there is nothing else on the screen to share space with.
     */
    scale?: number;
}

export const WatchFace: React.FC<Props> = ({ faceId, now, scale = 1 }) => {
    const { theme } = useTheme();

    const h = pad(now.getHours());
    const m = pad(now.getMinutes());
    const s = pad(now.getSeconds());
    const secondsFraction = now.getSeconds() / 60;
    const dateLine =
        `${WEEKDAYS[now.getDay()]} ${pad(now.getDate())} ${MONTHS[now.getMonth()]}`;

    const text = theme.colors.text;
    const dim = theme.colors.textSecondary;
    const accent = theme.colors.primary;
    const z = (n: number) => Math.round(n * scale);

    switch (faceId) {
        /**
         * Wide-tracked dot matrix. The app's signature face, so it is the default:
         * a new user's first Deck should look like the rest of Rise.
         */
        case 'matrix':
            return (
                <View>
                    <Text
                        style={{
                            fontFamily: FONT_DOT,
                            fontSize: z(64),
                            lineHeight: z(70),
                            letterSpacing: z(4),
                            color: text,
                        }}>
                        {`${h}:${m}`}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: z(8) }}>
                        <Text
                            style={{
                                fontFamily: FONT_DOT,
                                fontSize: z(26),
                                letterSpacing: z(3),
                                color: accent,
                            }}>
                            {s}
                        </Text>
                        <NothingText variant="bold" size={z(9)} color={dim} style={{ letterSpacing: 2 }}>
                            SEC
                        </NothingText>
                    </View>
                </View>
            );

        /**
         * Units stacked instead of run together. Reads as an instrument panel rather
         * than a clock, which is the point — and it is the one face that stays legible
         * at a glance from across a room, because each field has its own line.
         */
        case 'stack':
            return (
                <View style={{ gap: z(2) }}>
                    {([
                        ['H', h, text],
                        ['M', m, text],
                        ['S', s, dim],
                    ] as [string, string, string][]).map(([label, value, colour]) => (
                        <View key={label} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: z(10) }}>
                            <Text
                                style={{
                                    fontFamily: FONT_MONO,
                                    fontSize: z(46),
                                    lineHeight: z(50),
                                    fontWeight: '700',
                                    color: colour,
                                }}>
                                {value}
                            </Text>
                            <NothingText
                                variant="bold"
                                size={z(10)}
                                color={label === 'S' ? accent : dim}
                                style={{ marginBottom: z(9), letterSpacing: 2 }}>
                                {label}
                            </NothingText>
                        </View>
                    ))}
                </View>
            );

        /**
         * Thin and quiet, with the minute drawn as a rule that fills as the seconds
         * run out. The rule is the only face element in the set that carries meaning
         * by shape, which is what makes this the natural zen default.
         */
        case 'hairline':
            return (
                <View>
                    <NothingText variant="bold" size={z(10)} color={dim} style={{ letterSpacing: 3, marginBottom: z(6) }}>
                        {dateLine}
                    </NothingText>
                    <Text
                        style={{
                            fontFamily: FONT_THIN,
                            fontSize: z(78),
                            lineHeight: z(84),
                            fontWeight: '200',
                            letterSpacing: z(1),
                            color: text,
                        }}>
                        {`${h}:${m}`}
                    </Text>
                    <View
                        style={{
                            height: 1,
                            marginTop: z(8),
                            backgroundColor: theme.colors.border,
                        }}>
                        <View
                            style={{
                                height: 1,
                                width: `${secondsFraction * 100}%`,
                                backgroundColor: text,
                            }}
                        />
                    </View>
                    <Text
                        style={{
                            fontFamily: FONT_THIN,
                            fontSize: z(13),
                            marginTop: z(6),
                            letterSpacing: z(3),
                            color: dim,
                        }}>
                        {`${s} SEC`}
                    </Text>
                </View>
            );

        /**
         * Serif, dated, with seconds set small beside the minute the way a masthead
         * sets a volume number. The only face that leads with the date, for the user
         * whose Deck is a desk clock rather than a timer.
         */
        case 'serif':
            return (
                <View>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                        <Text
                            style={{
                                fontFamily: FONT_SERIF,
                                fontSize: z(66),
                                lineHeight: z(72),
                                color: text,
                            }}>
                            {`${h}:${m}`}
                        </Text>
                        <Text
                            style={{
                                fontFamily: FONT_SERIF,
                                fontSize: z(22),
                                lineHeight: z(30),
                                marginLeft: z(6),
                                marginBottom: z(6),
                                color: accent,
                            }}>
                            {s}
                        </Text>
                    </View>
                    <View
                        style={{
                            height: 1,
                            width: z(56),
                            marginTop: z(6),
                            marginBottom: z(6),
                            backgroundColor: theme.colors.border,
                        }}
                    />
                    <Text
                        style={{
                            fontFamily: FONT_SERIF,
                            fontSize: z(12),
                            letterSpacing: z(2),
                            color: dim,
                        }}>
                        {dateLine}
                    </Text>
                </View>
            );

        /**
         * Condensed and set solid, with no colon: the four digits read as one mark.
         * Seconds move to a bar, because a face this dense has nowhere left to put a
         * number without breaking the block.
         */
        case 'block':
        default:
            return (
                <View>
                    <Text
                        style={{
                            fontFamily: FONT_CONDENSED,
                            fontSize: z(86),
                            lineHeight: z(88),
                            fontWeight: '700',
                            letterSpacing: z(-2),
                            color: text,
                        }}>
                        {`${h}${m}`}
                    </Text>
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: z(8),
                            marginTop: z(8),
                        }}>
                        <View
                            style={{
                                flex: 1,
                                height: z(5),
                                borderRadius: z(3),
                                overflow: 'hidden',
                                backgroundColor: theme.colors.surface2,
                            }}>
                            <View
                                style={{
                                    height: '100%',
                                    width: `${secondsFraction * 100}%`,
                                    backgroundColor: accent,
                                }}
                            />
                        </View>
                        <Text
                            style={{
                                fontFamily: FONT_CONDENSED,
                                fontSize: z(16),
                                fontWeight: '700',
                                letterSpacing: z(1),
                                color: dim,
                            }}>
                            {s}
                        </Text>
                    </View>
                </View>
            );
    }
};
