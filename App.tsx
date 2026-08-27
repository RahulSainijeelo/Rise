import React, { useEffect } from 'react';
import { StatusBar, View, NativeEventEmitter, NativeModules, Linking, AppState } from 'react-native';
import { AppNavigator } from './src/navigation/AppNavigator';
import { useTheme } from './src/theme';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { notificationService } from './src/services/NotificationService';
import { useAppStore } from './src/store/useAppStore';
import { SettingsService } from './src/services/SettingsService';
import { sensorService, localDate } from './src/services/SensorService';
import { applyPendingWidgetOps } from './src/services/WidgetOpsService';
import { requestSensorPermissions } from './src/utils/permissions';

const { WidgetBridge } = NativeModules;
const widgetEmitter = new NativeEventEmitter(WidgetBridge);

const App = () => {
  const { theme, isDark } = useTheme();
  const { activeProfile, login, activeTimer, tickTimer, pauseTimer, resumeTimer, stopTimer, toggleHabit } = useAppStore();

  useEffect(() => {
    // Request notification permission on app start
    notificationService.requestPermission().then(granted => {
      if (granted) {
        console.log('Notification permission granted');
        notificationService.init();
      } else {
        console.log('Notification permission denied');
      }
    });

    // Auto-login to default profile
    const attemptAutoLogin = async () => {
      if (!activeProfile) {
        const settings = await SettingsService.getSettings();
        if (settings.defaultProfile) {
          await login({ id: settings.defaultProfile, name: 'User' });
        }
      }

      // Permissions before tracking: the foreground service narrows what it claims
      // to what has actually been granted, so asking after starting it would leave
      // it running with less capability than the user agreed to.
      const missing = await requestSensorPermissions(useAppStore.getState().habits || []);
      if (missing.length) {
        console.warn('Sensor habits are missing permissions:', missing.join(', '));
      }

      await sensorService.ensureTracking(useAppStore.getState);

      // Anything tapped on a widget while the app was closed.
      await applyPendingWidgetOps(useAppStore.getState);
    };
    attemptAutoLogin();

    /**
     * Coming back to the foreground is the only moment we can reliably (re)start the
     * foreground service — Android 12+ rejects the start from the background — and
     * it is also when widget taps need collecting. Both are idempotent.
     */
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      applyPendingWidgetOps(useAppStore.getState);
      sensorService.ensureTracking(useAppStore.getState);
    });

    // Keep the native service's config in step with the habits themselves, so
    // editing a goal or a sunset cutoff takes effect without restarting the app.
    const unsubscribeHabits = useAppStore.subscribe((state, prev) => {
      if (state.habits !== prev.habits) {
        sensorService.refreshConfig(useAppStore.getState);
      }
    });

    // Widget Action Listeners
    const timerSub = widgetEmitter.addListener('onTimerAction', (dataString) => {
      try {
        const data = JSON.parse(dataString);
        if (data.action === 'pause') pauseTimer();
        else if (data.action === 'resume') resumeTimer();
        else if (data.action === 'stop') stopTimer();
      } catch (e) {
        console.error('Failed to parse timer action', e);
      }
    });

    const habitSub = widgetEmitter.addListener('onHabitAction', (dataString) => {
      try {
        const data = JSON.parse(dataString);
        if (data.action === 'toggle') {
          toggleHabit(data.id, localDate());
        }
      } catch (e) {
        console.error('Failed to parse habit action', e);
      }
    });

    /**
     * Deep links, for navigation and for the older task/habit widgets.
     *
     * The sensor widgets no longer route state changes through here — their controls
     * broadcast to the provider and queue a PendingOp, so a tap on "+100" no longer
     * has to open the app to count. What remains is navigation plus the legacy
     * `habit-action` links, kept so a widget rendered by an older build of the app
     * that is still sitting on someone's home screen does not become a dead button.
     */
    const handleDeepLink = (event: { url: string }) => {
      const url = event.url;
      console.log('Deep link received:', url);

      // Local, not UTC. `toISOString()` does not roll over until 05:30 for a user at
      // UTC+5:30, so an early-morning tap used to be credited to yesterday.
      const today = localDate();

      if (url.includes('rise://timer-action/')) {
        const parts = url.replace('rise://timer-action/', '').split('/');
        const action = parts[0];
        // const id = parts[1]; // Not strictly needed if we assume one global active timer
        if (action === 'pause') pauseTimer();
        else if (action === 'resume') resumeTimer();
        else if (action === 'stop') stopTimer();
      } else if (url.includes('rise://habit-toggle/')) {
        const habitId = url.replace('rise://habit-toggle/', '');
        toggleHabit(habitId, today);
      } else if (url.includes('rise://habit-action/')) {
        const parts = url.replace('rise://habit-action/', '').split('/');
        const actionType = parts[0];
        const targetId = parts[1];
        const extra = parts[2];

        if (actionType === 'toggle' && targetId) {
          toggleHabit(targetId, today);
        } else if (actionType === 'increment' && targetId) {
          const amount = parseInt(extra) || 100;
          useAppStore.getState().updateNumericProgress(targetId, today, amount);
        } else if (actionType === 'silence-toggle' && targetId) {
          useAppStore.getState().updateTimerProgress(targetId, today, 300); // 5 mins
        }
      }
    };

    const linkSub = Linking.addEventListener('url', handleDeepLink);
    Linking.getInitialURL().then(url => {
      if (url) handleDeepLink({ url });
    });

    return () => {
      timerSub.remove();
      habitSub.remove();
      appStateSub.remove();
      linkSub.remove();
      unsubscribeHabits();
    };
  }, []);

  // Timer Tick Interval
  useEffect(() => {
    let interval: any;
    if (activeTimer && activeTimer.isRunning) {
      interval = setInterval(() => {
        tickTimer();
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [activeTimer?.isRunning, activeTimer?.id]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
          <StatusBar
            barStyle={isDark ? "light-content" : "dark-content"}
            backgroundColor={theme.colors.background}
          />
          <AppNavigator />
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

export default App;
