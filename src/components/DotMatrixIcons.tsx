import React from 'react';
import Svg, { Circle } from 'react-native-svg';

/**
 * Tab icons drawn as dot matrices.
 *
 * Three of the five tabs ship as dot-matrix PNGs in src/assets/tabs. Focus and the
 * Deck had no raster of their own and borrowed lucide outlines, which put two
 * hairline vector glyphs in a row of dotted ones — visible immediately, and the
 * thing the user called out as "not according to theme".
 *
 * Drawn rather than rastered because a tab icon has to take a tint at two sizes
 * without softening, and because there is no design tool in this repo to author a
 * matching PNG with. Geometry is expressed as fractions of `size` so both icons keep
 * their dot rhythm at 24px and at 36px.
 *
 * Everything is a filled Circle: no strokes, no paths, nothing that reads as a
 * different drawing language from the PNGs beside them.
 */

interface DotIconProps {
    size?: number;
    color: string;
    /** Matches the PNG tabs, which dim to 0.7 when the tab is not focused. */
    opacity?: number;
}

/** Ring positions for the clock face, in twelfths of a turn from 12 o'clock. */
const HOUR_MARKS = Array.from({ length: 12 }, (_, i) => i);

/**
 * Focus: a dot-matrix clock.
 *
 * A ring of twelve marks with two hands built from dots — the same idea as the
 * lucide Timer it replaces, so the tab does not change meaning, only material.
 */
export const DotClockIcon: React.FC<DotIconProps> = ({ size = 26, color, opacity = 1 }) => {
    const c = size / 2;
    const ringR = size * 0.4;
    const dot = size * 0.062;

    // The hands are dots stepping out from the centre rather than lines, which is
    // what keeps this legible next to the PNGs at 26px.
    const minute = [0.13, 0.22, 0.31].map(t => ({ x: c, y: c - size * t }));
    const hour = [0.13, 0.21].map(t => ({ x: c + size * t, y: c }));

    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} opacity={opacity}>
            {HOUR_MARKS.map(i => {
                const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
                // Quarter marks sit slightly larger, the way a dotted dial reads.
                const r = i % 3 === 0 ? dot * 1.25 : dot;
                return (
                    <Circle
                        key={`m${i}`}
                        cx={c + Math.cos(a) * ringR}
                        cy={c + Math.sin(a) * ringR}
                        r={r}
                        fill={color}
                    />
                );
            })}
            {minute.map((p, i) => (
                <Circle key={`mi${i}`} cx={p.x} cy={p.y} r={dot * 0.85} fill={color} />
            ))}
            {hour.map((p, i) => (
                <Circle key={`h${i}`} cx={p.x} cy={p.y} r={dot * 0.85} fill={color} />
            ))}
            <Circle cx={c} cy={c} r={dot * 0.6} fill={color} />
        </Svg>
    );
};

/**
 * Deck: four dot clusters.
 *
 * Sixteen dots on a 4×4 lattice with a gap down the middle in both directions, so it
 * reads as four tiles — a deck of cards — without drawing a single rectangle.
 */
export const DotDeckIcon: React.FC<DotIconProps> = ({ size = 26, color, opacity = 1 }) => {
    const dot = size * 0.072;
    const steps = [0.22, 0.38, 0.62, 0.78];

    return (
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} opacity={opacity}>
            {steps.map((fy, r) =>
                steps.map((fx, c) => (
                    <Circle
                        key={`${r}-${c}`}
                        cx={size * fx}
                        cy={size * fy}
                        r={dot}
                        fill={color}
                    />
                )),
            )}
        </Svg>
    );
};
