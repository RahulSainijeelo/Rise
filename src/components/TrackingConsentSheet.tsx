import React, { useCallback, useEffect, useState } from 'react';
import { View, Modal, ScrollView, TouchableOpacity, AppState, PermissionsAndroid, Platform } from 'react-native';
import { useTheme } from '../theme';
import { NothingText } from './NothingText';
import { NothingButton } from './NothingButton';
import { Activity, Bell, MapPin, Mic, BatteryCharging, Hourglass, Check, ChevronRight } from 'lucide-react-native';
import { sensorService } from '../services/SensorService';
import { habitSlot, type SensorSlot } from '../services/WidgetContract';

/**
 * TrackingConsentSheet
 * ====================
 * The one-time first-launch ask.
 *
 * Rise counts steps, distance and silence in a foreground service so the numbers
 * are right whether or not the app is open. That needs several grants, and the
 * order matters: a permission dialog stacked on top of another gets dismissed
 * blind, and Android will not even let the service claim a sensor type whose
 * permission is missing. So this walks them one at a time, says what each one
 * buys, and lets any of them be refused — a refused sensor degrades that habit
 * instead of breaking the app.
 *
 * Bump CONSENT_VERSION to re-show this after adding a new capability.
 */
export const CONSENT_VERSION = 1;

type ItemKey = 'notifications' | 'steps' | 'location' | 'microphone' | 'battery' | 'usage';

interface ConsentItem {
    key: ItemKey;
    title: string;
    why: string;
    icon: React.ReactNode;
    /** Leaves the app for a Settings page, so it cannot be awaited. */
    viaSettings?: boolean;
    optional?: boolean;
    check: () => Promise<boolean>;
    request: () => Promise<void> | void;
}

const sdk = typeof Platform.Version === 'number' ? Platform.Version : 0;

const androidCheck = (permission: string) => async () => {
    try {
        return await PermissionsAndroid.check(permission as any);
    } catch (e) {
        return false;
    }
};

const androidRequest = (permission: string) => async () => {
    try {
        await PermissionsAndroid.request(permission as any);
    } catch (e) {
        // A refusal is a legitimate answer; the caller re-checks either way.
    }
};

interface Props {
    visible: boolean;
    habits: any[];
    onDone: () => void;
}

export const TrackingConsentSheet: React.FC<Props> = ({ visible, habits, onDone }) => {
    const { theme } = useTheme();
    const [granted, setGranted] = useState<Partial<Record<ItemKey, boolean>>>({});
    const [busy, setBusy] = useState(false);

    /**
     * Only ask for what this profile's habits actually use.
     *
     * Asking for everything up front is the quickest way to have everything
     * refused. Notifications and the battery exemption are always included because
     * they are what make *any* background counting work: the notification is the
     * service's visible face and its pause button, and Doze is what otherwise
     * quietly stops the counting a few minutes after the screen goes off.
     */
    const items: ConsentItem[] = React.useMemo(() => {
        // habitSlot rather than the raw sensorType, and no isSensorBased filter: this
        // sheet is often the *first* thing a profile sees, before anything has had a
        // chance to repair a habit whose sensorType went missing. Missing the slot
        // here means never asking for the permission, which is how City Glider ended
        // up measuring nothing at all.
        const types = new Set(
            (habits || [])
                .map((h: any) => habitSlot(h))
                .filter((slot): slot is SensorSlot => slot !== null)
        );
        const list: ConsentItem[] = [];

        if (sdk >= 33) {
            list.push({
                key: 'notifications',
                title: 'Notifications',
                why: 'Shows the tracking notification, which is also where you pause or stop tracking.',
                icon: <Bell size={20} color={theme.colors.primary} />,
                check: androidCheck('android.permission.POST_NOTIFICATIONS'),
                request: androidRequest('android.permission.POST_NOTIFICATIONS'),
            });
        }

        // No sensor habits yet on a fresh profile, but steps is what every starter
        // habit uses, so it is worth the one prompt.
        if (sdk >= 29 && (types.size === 0 || types.has('pedometer') || types.has('movement'))) {
            list.push({
                key: 'steps',
                title: 'Physical Activity',
                why: 'Counts your steps. Without it Android refuses step readings entirely and a step habit sits at zero all day.',
                icon: <Activity size={20} color={theme.colors.primary} />,
                check: androidCheck('android.permission.ACTIVITY_RECOGNITION'),
                request: androidRequest('android.permission.ACTIVITY_RECOGNITION'),
            });
        }

        if (types.has('gps')) {
            list.push({
                key: 'location',
                title: 'Location',
                why: 'Measures the distance you cover. Used only while a distance habit is being tracked.',
                icon: <MapPin size={20} color={theme.colors.primary} />,
                check: androidCheck('android.permission.ACCESS_FINE_LOCATION'),
                request: androidRequest('android.permission.ACCESS_FINE_LOCATION'),
            });
        }

        if (types.has('noise')) {
            list.push({
                key: 'microphone',
                title: 'Microphone',
                why: 'Measures how quiet the room is for Deep Silence. Nothing is recorded or stored — only a loudness number.',
                icon: <Mic size={20} color={theme.colors.primary} />,
                check: androidCheck('android.permission.RECORD_AUDIO'),
                request: androidRequest('android.permission.RECORD_AUDIO'),
            });
        }

        list.push({
            key: 'battery',
            title: 'Unrestricted Background Use',
            why: 'Keeps counting while the phone is idle. Without it your device pauses the sensors minutes after the screen goes off.',
            icon: <BatteryCharging size={20} color={theme.colors.primary} />,
            check: () => sensorService.isIgnoringBatteryOptimizations(),
            request: () => sensorService.requestIgnoreBatteryOptimizations(),
        });

        if (types.has('screen')) {
            list.push({
                key: 'usage',
                title: 'Usage Access',
                why: 'Turns Digital Sunset into real screen-time minutes instead of a count of unlocks. Optional.',
                icon: <Hourglass size={20} color={theme.colors.primary} />,
                viaSettings: true,
                optional: true,
                check: () => sensorService.hasUsageStatsPermission(),
                request: () => sensorService.openUsageStatsSettings(),
            });
        }

        return list;
    }, [habits, theme.colors.primary]);

    const refresh = useCallback(async () => {
        const entries = await Promise.all(
            items.map(async (item) => [item.key, await item.check()] as const)
        );
        setGranted(Object.fromEntries(entries));
    }, [items]);

    // Re-check on every return to the foreground: the battery dialog and the usage
    // access page both hand control to the system and come back as an AppState
    // change rather than anything this component would otherwise hear about.
    useEffect(() => {
        if (!visible) return;
        refresh();
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') refresh();
        });
        return () => sub.remove();
    }, [visible, refresh]);

    /**
     * Walk the asks in order, awaiting each one. Sequential on purpose: fired in
     * parallel, Android shows one dialog and silently denies the rest.
     */
    const allowAll = async () => {
        if (busy) return;
        setBusy(true);
        try {
            for (const item of items) {
                if (granted[item.key]) continue;
                // A Settings trip ends the loop's usefulness — the app is no longer
                // in front — so those rows are left for the user to tap.
                if (item.viaSettings) continue;
                await item.request();
                const ok = await item.check();
                setGranted(prev => ({ ...prev, [item.key]: ok }));
            }
        } finally {
            setBusy(false);
        }
    };

    const askOne = async (item: ConsentItem) => {
        await item.request();
        // A Settings trip is confirmed by the AppState listener when the user comes
        // back; a runtime dialog is answered before this resolves.
        if (!item.viaSettings) refresh();
    };

    const outstanding = items.filter(i => !granted[i.key] && !i.optional).length;

    return (
        <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onDone}>
            <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: 56 }}>
                <ScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 32 }}>
                    <NothingText variant="dot" size={34} style={{ fontFamily: 'ndot' }}>
                        TRACK IT{'\n'}FOR REAL
                    </NothingText>
                    <NothingText size={13} color={theme.colors.textSecondary} style={{ marginTop: 14, lineHeight: 20 }}>
                        Rise counts your steps, distance and quiet time in the background, so a
                        habit is measured by what you actually did — not by what you remembered
                        to tap. That runs in a foreground service you can pause or stop at any
                        time, from the notification, a widget, or the habit itself.
                    </NothingText>
                    <NothingText size={13} color={theme.colors.textSecondary} style={{ marginTop: 10, lineHeight: 20 }}>
                        Everything stays on this phone.
                    </NothingText>

                    <View style={{ marginTop: 28, gap: 12 }}>
                        {items.map((item) => {
                            const ok = !!granted[item.key];
                            return (
                                <TouchableOpacity
                                    key={item.key}
                                    activeOpacity={ok ? 1 : 0.7}
                                    onPress={() => { if (!ok) askOne(item); }}
                                    style={{
                                        flexDirection: 'row',
                                        gap: 14,
                                        padding: 16,
                                        borderRadius: 16,
                                        borderWidth: 1,
                                        borderColor: ok ? theme.colors.success + '60' : theme.colors.border,
                                        backgroundColor: ok ? theme.colors.success + '0D' : theme.colors.surface1,
                                    }}
                                >
                                    <View style={{ marginTop: 2 }}>
                                        {ok ? <Check size={20} color={theme.colors.success} /> : item.icon}
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                            <NothingText variant="bold" size={14}>
                                                {item.title}
                                            </NothingText>
                                            {item.optional && (
                                                <NothingText size={10} color={theme.colors.textSecondary} style={{ marginLeft: 8 }}>
                                                    OPTIONAL
                                                </NothingText>
                                            )}
                                            <View style={{ flex: 1 }} />
                                            {ok ? (
                                                <NothingText size={10} color={theme.colors.success}>ALLOWED</NothingText>
                                            ) : (
                                                <ChevronRight size={16} color={theme.colors.textSecondary} />
                                            )}
                                        </View>
                                        <NothingText size={11} color={theme.colors.textSecondary} style={{ marginTop: 6, lineHeight: 16 }}>
                                            {item.why}
                                        </NothingText>
                                    </View>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </ScrollView>

                <View style={{ paddingHorizontal: 24, paddingBottom: 32, gap: 12 }}>
                    <NothingButton
                        label={busy ? 'ASKING...' : outstanding > 0 ? 'ALLOW ALL' : 'START TRACKING'}
                        onPress={outstanding > 0 ? allowAll : onDone}
                    />
                    <TouchableOpacity onPress={onDone} style={{ alignItems: 'center', padding: 10 }}>
                        <NothingText size={12} color={theme.colors.textSecondary}>
                            {outstanding > 0 ? 'NOT NOW' : 'DONE'}
                        </NothingText>
                    </TouchableOpacity>
                    {/* Refusal has to be a real option, so say what it costs rather than
                        blocking the app behind the prompt. */}
                    <NothingText size={10} color={theme.colors.textSecondary} style={{ textAlign: 'center' }}>
                        Skip and sensor habits fall back to manual entry. You can turn any of
                        this on later from your profile.
                    </NothingText>
                </View>
            </View>
        </Modal>
    );
};
