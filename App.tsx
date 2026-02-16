import React, { useEffect } from 'react';
import { StatusBar, View, NativeEventEmitter, NativeModules, Linking } from 'react-native';
import { AppNavigator } from './src/navigation/AppNavigator';
import { useTheme } from './src/theme';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { notificationService } from './src/services/NotificationService';
import { useAppStore } from './src/store/useAppStore';
import { SettingsService } from './src/services/SettingsService';

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
          // find profile name (we might need a method to list profiles or just use ID)
          // For now, if we have a default ID, we just login with it.
          // Note: useAppStore.login expects {id, name}
          login({ id: settings.defaultProfile, name: 'User' });
        }
      }
    };
    attemptAutoLogin();

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
          const today = new Date().toISOString().split('T')[0];
          toggleHabit(data.id, today);
        }
      } catch (e) {
        console.error('Failed to parse habit action', e);
      }
    });

    // Handle Deep Links (Widget Actions)
    const handleDeepLink = (event: { url: string }) => {
      const url = event.url;
      console.log('Deep link received:', url);

      if (url.includes('rise://timer-action/')) {
        const parts = url.replace('rise://timer-action/', '').split('/');
        const action = parts[0];
        // const id = parts[1]; // Not strictly needed if we assume one global active timer
        if (action === 'pause') pauseTimer();
        else if (action === 'resume') resumeTimer();
        else if (action === 'stop') stopTimer();
      } else if (url.includes('rise://habit-toggle/')) {
        const habitId = url.replace('rise://habit-toggle/', '');
        const today = new Date().toISOString().split('T')[0];
        toggleHabit(habitId, today);
      }
    };

    Linking.addEventListener('url', handleDeepLink);
    Linking.getInitialURL().then(url => {
      if (url) handleDeepLink({ url });
    });

    return () => {
      timerSub.remove();
      habitSub.remove();
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
