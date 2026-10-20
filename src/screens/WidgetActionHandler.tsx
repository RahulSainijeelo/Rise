import React, { useEffect } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useAppStore } from '../store/useAppStore';
import { useTheme } from '../theme';
import { restoreDefaultProfile } from '../utils/restoreProfile';
import { localDate } from '../services/SensorService';

// This screen handles widget deep link actions
export const WidgetActionHandler = ({ route }: any) => {
    const navigation = useNavigation<any>();
    const { theme } = useTheme();

    const params = route.params || {};
    const { itemId, itemType, action } = params;

    useEffect(() => {
        const handleAction = async () => {
            // A widget deep link can cold-start the app straight onto this screen,
            // bypassing SplashScreen — so the profile Splash would normally restore
            // has not been loaded yet, and App no longer logs in on its own (P-05).
            // Acting now would toggle against an empty store with no active profile,
            // which is exactly how opening from a widget appeared to "log out" and
            // then land on the phantom "deck_layout" profile. Restore the default
            // profile first (the same job Splash does on a normal launch), and only
            // then perform the action. Shared with App/Splash so no entry point can
            // drift back to a blank profile. (P-08, consolidated P-10)
            if (!(await restoreDefaultProfile())) {
                // Still nothing to act on — send them in through the front door
                // rather than silently dropping the tap on an empty store.
                navigation.replace('Login');
                return;
            }

            // Get action from path or determine from itemType
            const resolvedAction = action || route.path?.split('/')[0] || (itemType === 'habit' ? 'habit-detail' : 'toggle');

            console.log('WidgetActionHandler:', { itemId, itemType, resolvedAction });

            const { toggleTask, toggleHabit } = useAppStore.getState();

            if (resolvedAction === 'toggle' && itemId) {
                // Toggle task completion
                if (itemType === 'task') {
                    toggleTask(itemId);
                } else if (itemType === 'habit') {
                    // Local, not UTC: toggleHabit keys the completion by day, and an
                    // ISO date does not roll until 05:30 for a user at UTC+5:30, so an
                    // early-morning tap would land on yesterday (W-06).
                    toggleHabit(itemId, localDate());
                }
                // Go back or to main
                if (navigation.canGoBack()) {
                    navigation.goBack();
                } else {
                    navigation.replace('Main');
                }
            } else if (resolvedAction === 'habit-detail' && itemId) {
                // Navigate to habit detail screen
                navigation.replace('HabitDetail', { habitId: itemId });
            } else {
                // Fallback to main
                navigation.replace('Main');
            }
        };

        handleAction();
    }, [itemId, itemType, action]);

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    }
});
