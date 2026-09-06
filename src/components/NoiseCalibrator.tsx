import React, { useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, PanResponder, Vibration } from 'react-native';
import { Mic, MicOff, Crosshair, Minus, Plus } from 'lucide-react-native';
import { useTheme } from '../theme';
import { NothingText } from './NothingText';
import { NOISE_DEFAULTS } from '../services/WidgetContract';

/**
 * The live ambient meter and threshold control for Deep Silence.
 *
 * Why this exists at all: a silence habit whose only output is a timer cannot be
 * audited. The timer moving tells you nothing about whether it moved because the room
 * was quiet or because the tracker was broken, and a timer that has stopped is
 * indistinguishable from a microphone that has died. So the meter shows the level as
 * it is measured, marks the line the accrual actually tests against, and says in words
 * whether the clock is banking right now.
 *
 * Why the threshold is the user's and not ours: the scale is dBFS + 100, not SPL.
 * There is no calibrated reference, so the same room reads differently on different
 * handsets, and the hardcoded 45 this replaces was either unreachable or trivially
 * satisfied depending on whose phone it ran on. The only honest way to pick the number
 * is to measure the room you actually sit in — which is what CALIBRATE does.
 */

const SAMPLE_MS = 250;
const CALIBRATE_MS = 4000;
/**
 * Headroom added above the measured room floor.
 *
 * A threshold set exactly at the floor accrues nothing: the floor is a peak the room
 * already reaches, so every second would contain a breach. Three dB is enough to sit
 * above the room's own hiss without admitting speech, which typically lands 15-25 dB
 * higher on this scale.
 */
const CALIBRATION_HEADROOM_DB = 3;

interface Props {
    /** Current ambient level, 0-100 on the dBFS+100 scale. */
    db: number;
    /** True while the microphone is genuinely open. */
    listening: boolean;
    /** False until the first buffer has been measured. */
    hasReading: boolean;
    /** The threshold in force, already clamped by the tracker. */
    thresholdDb: number;
    /** Seconds of unbroken quiet right now. */
    streakSeconds: number;
    /** Runs of quiet broken today. */
    breaches: number;
    onChangeThreshold: (db: number) => void;
}

const clamp = (n: number) =>
    Math.min(NOISE_DEFAULTS.maxDb, Math.max(NOISE_DEFAULTS.minDb, Math.round(n)));

/** Where a dB value sits along the meter, 0-1, over the tunable range only. */
const fraction = (db: number) => {
    const span = NOISE_DEFAULTS.maxDb - NOISE_DEFAULTS.minDb;
    return Math.min(1, Math.max(0, (db - NOISE_DEFAULTS.minDb) / span));
};

export const NoiseCalibrator: React.FC<Props> = ({
    db,
    listening,
    hasReading,
    thresholdDb,
    streakSeconds,
    breaches,
    onChangeThreshold,
}) => {
    const { theme } = useTheme();
    const [trackWidth, setTrackWidth] = useState(0);
    const [calibrating, setCalibrating] = useState(false);

    /**
     * The drag needs three things the render closure cannot give it: the measured
     * track width, the value at the moment the finger went down, and the newest
     * threshold. PanResponder is created once — recreating it mid-gesture drops the
     * gesture — so those are read through refs rather than captured.
     */
    const trackWidthRef = useRef(0);
    const thresholdRef = useRef(thresholdDb);
    const dragStartRef = useRef(thresholdDb);
    trackWidthRef.current = trackWidth;
    thresholdRef.current = thresholdDb;

    /**
     * Peak seen during calibration, in a ref rather than state.
     *
     * The sampler runs every 250ms and must accumulate across ticks; in state each
     * write would schedule a render and the interval would read a stale value.
     */
    const peakRef = useRef(0);
    const calibrateTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const calibrateStop = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Latest reading, so the sampler sees the current value and not the one at start. */
    const dbRef = useRef(db);
    dbRef.current = db;

    useEffect(() => () => {
        if (calibrateTimer.current) clearInterval(calibrateTimer.current);
        if (calibrateStop.current) clearTimeout(calibrateStop.current);
    }, []);

    const commit = (next: number) => {
        const value = clamp(next);
        if (value !== thresholdRef.current) onChangeThreshold(value);
    };

    const pan = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: () => true,
            onPanResponderGrant: () => {
                dragStartRef.current = thresholdRef.current;
                Vibration.vibrate(10);
            },
            onPanResponderMove: (_e, gesture) => {
                const w = trackWidthRef.current;
                if (w <= 0) return;
                const span = NOISE_DEFAULTS.maxDb - NOISE_DEFAULTS.minDb;
                // Relative to where the finger landed, not absolute along the track:
                // an absolute mapping would teleport the threshold to wherever the
                // user first touched, which is a destructive surprise on a value they
                // spent time calibrating.
                commit(dragStartRef.current + (gesture.dx / w) * span);
            },
        }),
    ).current;

    /**
     * Measure the room for four seconds and put the threshold just above its loudest
     * moment. Peak rather than mean for the same reason the tracker accrues on peaks:
     * a threshold the room's own noise floor already exceeds would never bank a
     * second, and the habit would look broken rather than badly tuned.
     */
    const calibrate = () => {
        if (calibrating || !listening) return;
        Vibration.vibrate(20);
        peakRef.current = 0;
        setCalibrating(true);
        calibrateTimer.current = setInterval(() => {
            if (dbRef.current > peakRef.current) peakRef.current = dbRef.current;
        }, SAMPLE_MS);
        calibrateStop.current = setTimeout(() => {
            if (calibrateTimer.current) clearInterval(calibrateTimer.current);
            calibrateTimer.current = null;
            setCalibrating(false);
            // Nothing measured means no microphone; leave the threshold alone rather
            // than clamping it to the floor and making the habit impossible.
            if (peakRef.current > 0) {
                commit(peakRef.current + CALIBRATION_HEADROOM_DB);
                Vibration.vibrate(30);
            }
        }, CALIBRATE_MS);
    };

    const quiet = listening && hasReading && db <= thresholdDb;
    const levelColor = !listening || !hasReading
        ? theme.colors.textSecondary
        : quiet
            ? theme.colors.success
            : theme.colors.error;

    const status = !listening
        ? 'MICROPHONE OFF'
        : !hasReading
            ? 'OPENING MICROPHONE'
            : quiet
                ? 'BANKING QUIET'
                : `TOO LOUD · OVER ${thresholdDb}`;

    const markerLeft = trackWidth > 0 ? fraction(thresholdDb) * trackWidth : 0;

    return (
        <View>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
                    <NothingText variant="dot" size={48} color={levelColor}>
                        {listening && hasReading ? `${db}` : '--'}
                    </NothingText>
                    <NothingText size={12} color={theme.colors.textSecondary} style={{ marginBottom: 8, marginLeft: 4 }}>
                        dB
                    </NothingText>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {listening ? (
                        <Mic size={13} color={levelColor} />
                    ) : (
                        <MicOff size={13} color={theme.colors.textSecondary} />
                    )}
                    <NothingText variant="bold" size={11} color={levelColor}>
                        {calibrating ? 'MEASURING ROOM' : status}
                    </NothingText>
                </View>
            </View>

            {/*
              The meter. One track carrying two things: how loud the room is right now
              (the fill) and the line it has to stay under (the marker). Drawing them
              on the same scale is the whole point — a separate number for the
              threshold would leave the user doing the comparison in their head.
            */}
            <View
                {...pan.panHandlers}
                onLayout={e => setTrackWidth(e.nativeEvent.layout.width)}
                style={{ marginTop: 14, paddingVertical: 10 }}
            >
                <View style={{ height: 10, backgroundColor: theme.colors.surface2, borderRadius: 2, overflow: 'hidden' }}>
                    {/* The permitted region, so "under the line" reads as a place. */}
                    <View
                        style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            bottom: 0,
                            width: `${fraction(thresholdDb) * 100}%`,
                            backgroundColor: theme.colors.success,
                            opacity: 0.18,
                        }}
                    />
                    <View
                        style={{
                            width: `${listening && hasReading ? fraction(db) * 100 : 0}%`,
                            height: '100%',
                            backgroundColor: levelColor,
                        }}
                    />
                </View>
                {/* Sits over the track, so it reads as a line on the scale. */}
                <View
                    style={{
                        position: 'absolute',
                        left: Math.max(0, markerLeft - 1),
                        top: 4,
                        width: 2,
                        height: 22,
                        backgroundColor: theme.colors.text,
                    }}
                />
            </View>

            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <NothingText size={10} color={theme.colors.textSecondary}>
                    {`${NOISE_DEFAULTS.minDb}`}
                </NothingText>
                <NothingText variant="bold" size={10} color={theme.colors.text}>
                    {`THRESHOLD ${thresholdDb}`}
                </NothingText>
                <NothingText size={10} color={theme.colors.textSecondary}>
                    {`${NOISE_DEFAULTS.maxDb}`}
                </NothingText>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
                <TouchableOpacity
                    onPress={() => { Vibration.vibrate(10); commit(thresholdDb - 1); }}
                    style={{
                        width: 38,
                        height: 34,
                        borderWidth: 1.5,
                        borderColor: theme.colors.border,
                        borderRadius: 4,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <Minus size={15} color={theme.colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={() => { Vibration.vibrate(10); commit(thresholdDb + 1); }}
                    style={{
                        width: 38,
                        height: 34,
                        borderWidth: 1.5,
                        borderColor: theme.colors.border,
                        borderRadius: 4,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <Plus size={15} color={theme.colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                    onPress={calibrate}
                    disabled={!listening || calibrating}
                    style={{
                        flex: 1,
                        height: 34,
                        borderWidth: 1.5,
                        borderColor: listening && !calibrating ? theme.colors.primary : theme.colors.border,
                        borderRadius: 4,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        opacity: listening && !calibrating ? 1 : 0.45,
                    }}
                >
                    <Crosshair size={13} color={listening && !calibrating ? theme.colors.primary : theme.colors.textSecondary} />
                    <NothingText
                        variant="bold"
                        size={11}
                        color={listening && !calibrating ? theme.colors.primary : theme.colors.textSecondary}
                    >
                        {calibrating ? 'MEASURING…' : 'CALIBRATE ROOM'}
                    </NothingText>
                </TouchableOpacity>
            </View>

            {/*
              The account of the day. The total alone cannot distinguish forty minutes
              held in one sitting from forty minutes assembled out of thirty fragments,
              and those are not the same achievement.
            */}
            <View style={{ flexDirection: 'row', marginTop: 16, gap: 24 }}>
                <View>
                    <NothingText variant="bold" size={16}>
                        {streakSeconds >= 60
                            ? `${Math.floor(streakSeconds / 60)}m ${streakSeconds % 60}s`
                            : `${streakSeconds}s`}
                    </NothingText>
                    <NothingText size={10} color={theme.colors.textSecondary}>UNBROKEN NOW</NothingText>
                </View>
                <View>
                    <NothingText variant="bold" size={16} color={breaches > 0 ? theme.colors.error : theme.colors.text}>
                        {`${breaches}`}
                    </NothingText>
                    <NothingText size={10} color={theme.colors.textSecondary}>BROKEN TODAY</NothingText>
                </View>
            </View>

            <NothingText size={10} color={theme.colors.textSecondary} style={{ marginTop: 12 }}>
                DRAG THE METER TO MOVE THE LINE
            </NothingText>
        </View>
    );
};
