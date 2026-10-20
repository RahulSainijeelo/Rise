import React, { useState, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert, Switch, ScrollView, AppState, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { NothingText } from '../components/NothingText';
import { NothingCard } from '../components/NothingCard';
import { NothingButton } from '../components/NothingButton';
import { useAppStore } from '../store/useAppStore';
import { useHabitCount } from '../store/selectors';
import { StorageService, UserProfile } from '../services/StorageService';
import { SettingsService } from '../services/SettingsService';
import { Download, LogOut, User, ShieldCheck, Check, Users, Github, Coffee, Heart, Sparkles, Activity, BatteryCharging, Power } from 'lucide-react-native';
import { ProfileScreenStyle as styles } from '../styles/ProfileScreen.style';
import { requestStoragePermission } from '../utils/permissions';
import { ConfirmationModal } from '../components/ConfirmationModal';
import { Linking, Platform } from 'react-native';
import { sensorService } from '../services/SensorService';

export const ProfileScreen = ({ navigation }: any) => {
    const { activeProfile, currentUser, logout, tasks, login, loadData } = useAppStore();
    const habitCount = useHabitCount();
    const { theme } = useTheme();
    const [isDefault, setIsDefault] = useState(false);
    const [allProfiles, setAllProfiles] = useState<UserProfile[]>([]);

    const [confirmVisible, setConfirmVisible] = useState(false);
    const [confirmData, setConfirmData] = useState<{ title: string; message: string; onConfirm: () => void; type?: 'danger' | 'info' }>({
        title: '',
        message: '',
        onConfirm: () => { },
    });

    // Tracking switches. Both of these can be changed from outside the app — the
    // notification's PAUSE action, a widget button, the system battery screen — so
    // they are re-read on every return to the foreground rather than cached.
    const [pausedAll, setPausedAll] = useState(false);
    const [batteryExempt, setBatteryExempt] = useState(true);

    useEffect(() => {
        let alive = true;
        const sync = () => {
            sensorService.getTrackingState().then(s => {
                if (alive) setPausedAll(s.pausedAll || s.quit);
            });
            sensorService.isIgnoringBatteryOptimizations().then(ok => {
                if (alive) setBatteryExempt(ok);
            });
        };
        sync();
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') sync();
        });
        return () => {
            alive = false;
            sub.remove();
        };
    }, []);

    const toggleTrackingPaused = (value: boolean) => {
        // The switch reads "tracking on", so pausing is the inverse.
        setPausedAll(!value);
        sensorService.setPausedAll(!value);
    };

    /**
     * Quit: release every sensor, drop the notification, and stay off across
     * reboots — then close Rise. Deliberately not the same as force-stopping the
     * app, which would leave the flag unset and bring tracking back at next boot.
     */
    const handleQuit = () => {
        setConfirmData({
            title: 'QUIT RISE',
            message:
                'This stops all sensor tracking, removes the Rise notification and closes the app. Tracking stays off — even after restarting your phone — until you open Rise again. Today\'s counts are kept.',
            type: 'danger',
            onConfirm: () => {
                setConfirmVisible(false);
                sensorService.quitTracking();
                // Give the native side a moment to stop the service before the
                // process goes away, otherwise the notification can outlive us.
                setTimeout(() => BackHandler.exitApp(), 350);
            },
        });
        setConfirmVisible(true);
    };

    useEffect(() => {
        checkDefaultStatus();
        loadProfiles();
    }, [activeProfile]);

    const checkDefaultStatus = async () => {
        if (!activeProfile) return;
        const settings = await SettingsService.getSettings();
        // Check both ID (new) and Name (legacy fallback)
        setIsDefault(settings.defaultProfile === activeProfile.id || settings.defaultProfile === activeProfile.name);
    };

    const loadProfiles = async () => {
        const files = await StorageService.getProfiles();
        // Filter out current user by ID
        setAllProfiles(files.filter(p => p.id !== activeProfile?.id));
    };

    const toggleDefault = async (value: boolean) => {
        if (!activeProfile) return;

        if (value) {
            await SettingsService.updateSettings({ defaultProfile: activeProfile.id });
            setIsDefault(true);
            Alert.alert('Default Profile', `${activeProfile.name} is now the default profile.`);
        } else {
            await SettingsService.updateSettings({ defaultProfile: undefined });
            setIsDefault(false);
        }
    };

    const handleSwitchProfile = async (profile: UserProfile) => {
        setConfirmData({
            title: 'Switch Profile',
            message: `Do you want to switch to ${profile.name}? Any unsaved changes might be lost.`,
            type: 'info',
            onConfirm: async () => {
                setConfirmVisible(false);
                await login(profile);
                navigation.navigate('Main');
            }
        });
        setConfirmVisible(true);
    };

    const handleDownload = async () => {
        if (!activeProfile) return;

        const hasPermission = await requestStoragePermission();
        if (!hasPermission && Platform.OS === 'android') {
            setConfirmData({
                title: 'PERMISSION DENIED',
                message: 'Storage permission is required to save the backup. Please enable it in your device settings.',
                type: 'danger',
                onConfirm: () => {
                    setConfirmVisible(false);
                    Linking.openSettings();
                }
            });
            setConfirmVisible(true);
            return;
        }

        try {
            const path = await StorageService.exportProfile(activeProfile.id);
            setConfirmData({
                title: 'BACKUP SUCCESSFUL',
                message: `Your data has been saved to:\n\nDownloads/Rise/`,
                type: 'info',
                onConfirm: () => setConfirmVisible(false)
            });
            setConfirmVisible(true);
        } catch (e) {
            setConfirmData({
                title: 'BACKUP FAILED',
                message: 'An error occurred while creating the backup. Please try again.',
                type: 'danger',
                onConfirm: () => setConfirmVisible(false)
            });
            setConfirmVisible(true);
        }
    };

    const handleLogout = () => {
        setConfirmData({
            title: 'Logout',
            message: 'Are you sure you want to exit your profile? You will need to login again to access your data.',
            type: 'danger',
            onConfirm: () => {
                setConfirmVisible(false);
                logout();
                navigation.replace('Login');
            }
        });
        setConfirmVisible(true);
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => navigation.goBack()}>
                    <NothingText color={theme.colors.primary} size={20} style={{ fontFamily: 'ndot' }}>BACK</NothingText>
                </TouchableOpacity>
                {/* <NothingText variant="dot" size={32}>SYSTEM</NothingText> */}
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
                <NothingCard padding="lg" bordered={false} style={[styles.profileCard, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.primary, borderWidth: 1 }]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                        <View style={[styles.avatar, { borderColor: theme.colors.border }]}>
                            <User size={48} color={theme.colors.text} />
                        </View>
                        <View>
                            <NothingText variant="bold" style={{ fontFamily: 'ndot' }} size={40}>{activeProfile?.name || currentUser}</NothingText>
                            <NothingText color={theme.colors.textSecondary} size={12}>ID: {activeProfile?.id}</NothingText>
                        </View>
                    </View>
                </NothingCard>

                <View style={styles.statsRow}>
                    <NothingCard style={styles.statBox}>
                        <NothingText variant="dot" size={20}>{tasks.length}</NothingText>
                        <NothingText size={10} color={theme.colors.textSecondary}>TASKS</NothingText>
                    </NothingCard>
                    <NothingCard style={styles.statBox}>
                        <NothingText variant="dot" size={20}>{habitCount}</NothingText>
                        <NothingText size={10} color={theme.colors.textSecondary}>HABITS</NothingText>
                    </NothingCard>
                </View>

                {allProfiles.length > 0 && (
                    <View style={styles.section}>
                        <NothingText variant="medium" size={12} color={theme.colors.textSecondary} style={styles.sectionTitle}>
                            OTHER PROFILES
                        </NothingText>
                        {allProfiles.map(profile => (
                            <TouchableOpacity key={profile.id} onPress={() => handleSwitchProfile(profile)}>
                                <NothingCard margin="xs" style={styles.profileRow}>
                                    <View style={styles.row}>
                                        <View style={styles.rowLeft}>
                                            <Users size={18} color={theme.colors.textSecondary} />
                                            <NothingText style={styles.actionText}>{profile.name}</NothingText>
                                        </View>
                                        <NothingText color={theme.colors.primary} size={12}>SWITCH</NothingText>
                                    </View>
                                </NothingCard>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                <View style={styles.section}>
                    <NothingText variant="medium" size={12} color={theme.colors.textSecondary} style={styles.sectionTitle}>
                        TRACKING
                    </NothingText>

                    <NothingCard margin="xs" style={styles.actionItem}>
                        <View style={styles.row}>
                            <View style={styles.rowLeft}>
                                <Activity size={20} color={pausedAll ? theme.colors.textSecondary : theme.colors.primary} />
                                <View>
                                    <NothingText style={styles.actionText}>Sensor Tracking</NothingText>
                                    <NothingText size={10} color={theme.colors.textSecondary}>
                                        {pausedAll ? 'Paused — nothing is being counted' : 'Counting steps, distance and silence'}
                                    </NothingText>
                                </View>
                            </View>
                            <Switch
                                value={!pausedAll}
                                onValueChange={toggleTrackingPaused}
                                trackColor={{ false: theme.colors.surface2, true: theme.colors.primary }}
                                thumbColor={theme.colors.background}
                            />
                        </View>
                    </NothingCard>

                    {/* Doze is what silently ends all-day counting: sensor batches stall
                        while the phone is idle and OEM battery managers kill the service
                        outright. Hidden once granted, because there is nothing to do. */}
                    {!batteryExempt && (
                        <TouchableOpacity onPress={() => sensorService.requestIgnoreBatteryOptimizations()}>
                            <NothingCard margin="xs" style={styles.actionItem}>
                                <View style={styles.row}>
                                    <View style={styles.rowLeft}>
                                        <BatteryCharging size={20} color={theme.colors.primary} />
                                        <View>
                                            <NothingText style={[styles.actionText, { color: theme.colors.primary }]}>Allow Background Battery Use</NothingText>
                                            <NothingText size={10} color={theme.colors.textSecondary}>
                                                Required for all-day counting
                                            </NothingText>
                                        </View>
                                    </View>
                                    <NothingText color={theme.colors.primary} size={12}>FIX</NothingText>
                                </View>
                            </NothingCard>
                        </TouchableOpacity>
                    )}

                    <TouchableOpacity onPress={handleQuit}>
                        <NothingCard margin="xs" style={styles.actionItem}>
                            <View style={styles.row}>
                                <View style={styles.rowLeft}>
                                    <Power size={20} color={theme.colors.error} />
                                    <View>
                                        <NothingText style={[styles.actionText, { color: theme.colors.error }]}>Quit Rise Completely</NothingText>
                                        <NothingText size={10} color={theme.colors.textSecondary}>
                                            Stops tracking and stays off after a restart
                                        </NothingText>
                                    </View>
                                </View>
                            </View>
                        </NothingCard>
                    </TouchableOpacity>
                </View>

                <View style={styles.actions}>
                    <NothingCard margin="xs" style={styles.actionItem}>
                        <View style={styles.row}>
                            <View style={styles.rowLeft}>
                                <Check size={20} color={theme.colors.text} />
                                <NothingText style={styles.actionText}>Auto Login</NothingText>
                            </View>
                            <Switch
                                value={isDefault}
                                onValueChange={toggleDefault}
                                trackColor={{ false: theme.colors.surface2, true: theme.colors.primary }}
                                thumbColor={theme.colors.background}
                            />
                        </View>
                    </NothingCard>

                    <TouchableOpacity onPress={handleDownload}>
                        <NothingCard margin="xs" style={styles.actionItem}>
                            <View style={styles.row}>
                                <View style={styles.rowLeft}>
                                    <Download size={20} color={theme.colors.text} />
                                    <NothingText style={styles.actionText}>Backup App Data</NothingText>
                                </View>
                            </View>
                        </NothingCard>
                    </TouchableOpacity>

                    <NothingButton
                        label="Logout Profile"
                        onPress={handleLogout}
                        variant="outline"
                        style={styles.logoutBtn}
                        icon={<LogOut size={20} color={theme.colors.primary} />}
                    />
                </View>

                {/* Developer Footer */}
                <View style={[styles.footer, { paddingBottom: 40, marginTop: 32 }]}>
                    <View style={{ height: 1, backgroundColor: theme.colors.border, width: '100%', marginBottom: 24, opacity: 0.5 }} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        <NothingText size={10} color={theme.colors.textSecondary}>MADE WITH</NothingText>
                        <Heart size={12} color={theme.colors.error} fill={theme.colors.error} />
                        <NothingText size={10} color={theme.colors.textSecondary}>BY</NothingText>
                        <NothingText variant="bold" size={12} style={{ letterSpacing: 1 }}>RAHUL SAINI</NothingText>
                    </View>

                    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 24, marginTop: 16 }}>
                        <TouchableOpacity onPress={() => Linking.openURL('https://github.com/RahulSainijeelo')}>
                            <Github size={24} color={theme.colors.text} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => Linking.openURL('https://www.buymeacoffee.com/rahulsainidev')}>
                            <Coffee size={24} color="#FFDD00" fill="#FFDD00" />
                        </TouchableOpacity>
                    </View>
                </View>
            </ScrollView>

            <ConfirmationModal
                visible={confirmVisible}
                title={confirmData.title}
                message={confirmData.message}
                type={confirmData.type}
                onConfirm={confirmData.onConfirm}
                onCancel={() => setConfirmVisible(false)}
            />
        </SafeAreaView>
    );
};

