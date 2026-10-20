import React, { useEffect, useRef, useState } from 'react';
import { StatusBar, View, NativeEventEmitter, NativeModules, Linking, AppState, Platform } from 'react-native';
import { AppNavigator } from './src/navigation/AppNavigator';
import { useTheme } from './src/theme';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { notificationService } from './src/services/NotificationService';
import { useAppStore } from './src/store/useAppStore';
import { useHabitsArray } from './src/store/selectors';
import { getHabitsArray } from './src/utils/NormalizedHabitStore';
import { SettingsService } from './src/services/SettingsService';
import { sensorService, localDate } from './src/services/SensorService';
import { applyPendingWidgetOps } from './src/services/WidgetOpsService';
import { requestSensorPermissions } from './src/utils/permissions';
import { restoreDefaultProfile } from './src/utils/restoreProfile';
import { TrackingConsentSheet, CONSENT_VERSION } from './src/components/TrackingConsentSheet';

const { WidgetBridge } = NativeModules;
const widgetEmitter = new NativeEventEmitter(WidgetBridge);

const App = () => {
  const { theme, isDark } = useTheme();
  const { activeTimer, tickTimer, pauseTimer, resumeTimer, stopTimer, toggleHabit } = useAppStore();
  // Habits as a flat array for the consent sheet, via the memoized selector so this
  // only re-renders App when the set of habits actually changes.
  const habits = useHabitsArray();

  // First-launch consent. Shown once (per CONSENT_VERSION) instead of firing bare
  // system dialogs at someone who has not yet been told what they are for.
  const [consentVisible, setConsentVisible] = useState(false);
  // The AppState listener is registered once with an empty dependency list, so it
  // needs a ref rather than the state value it would otherwise capture forever.
  const consentPendingRef = useRef(false);

  const showConsent = (show: boolean) => {
    consentPendingRef.current = show;
    setConsentVisible(show);
  };

  /**
   * Consent finished (or was skipped). Persist that it was seen, then do the two
   * things it was blocking: set up notifications and start tracking with exactly
   * the capabilities that were granted.
   */
  const finishConsent = async () => {
    showConsent(false);
    await SettingsService.updateSettings({ onboardedVersion: CONSENT_VERSION });
    notificationService.requestPermission().then(granted => {
      if (granted) notificationService.init();
    });
    await sensorService.ensureTracking(useAppStore.getState);
  };

  useEffect(() => {
    /**
     * Everything that must happen once a profile is actually active: check sensor
     * permissions, (re)start the foreground service, and drain any widget taps that
     * were queued while the app was closed. Split out so it can run both at mount
     * (if a profile is somehow already active) and from the store subscription the
     * moment auto-login makes one active — App no longer logs in itself (P-05), so
     * it reacts to the profile SplashScreen establishes rather than racing it.
     */
    const onProfileReady = async () => {
      // The consent sheet owns the first-run asks, so don't fire permission dialogs
      // or start the foreground service behind it — finishConsent() does that setup
      // when the sheet closes. Permissions before tracking: the service narrows what
      // it claims to what was granted, so asking after starting it would leave it
      // running with less capability than the user agreed to.
      if (!consentPendingRef.current) {
        const st = useAppStore.getState();
        const missing = await requestSensorPermissions(getHabitsArray({ byId: st.habitsById, allIds: st.habitIds }));
        if (missing.length) {
          console.warn('Sensor habits are missing permissions:', missing.join(', '));
        }
        await sensorService.ensureTracking(useAppStore.getState);
      }

      // Anything tapped on a widget while the app was closed. Draining it raises no
      // dialogs, so it is safe even while the consent sheet is up — but it still
      // needs a live profile. Draining against the empty pre-login store (where App
      // sat before P-05 moved login entirely to Splash) would throw the taps away.
      await applyPendingWidgetOps(useAppStore.getState);
    };

    const attemptAutoLogin = async () => {
      const settings = await SettingsService.getSettings();
      // Auto-login is owned solely by SplashScreen (the navigation gate): it
      // loads the profile's real name and decides Main vs Login. App used to also
      // log in here with a hardcoded name:'User', and because Splash waits out a
      // 2s animation first, App's version won the race on cold start — a widget
      // launch could land on a half-built 'User' profile, and a stale default was
      // how the phantom "deck_layout" profile surfaced. App now only reacts.

      const needsConsent =
        Platform.OS === 'android' && (settings.onboardedVersion || 0) < CONSENT_VERSION;

      if (needsConsent) {
        // The sheet owns every ask, including notifications: a dialog fired from
        // here would land on top of it and be dismissed without being read.
        showConsent(true);
      } else {
        notificationService.requestPermission().then(granted => {
          if (granted) notificationService.init();
        });
      }

      // Restore the saved profile here too, not only in SplashScreen. A widget
      // deep link can cold-start the app straight onto its target screen, which
      // outruns or entirely bypasses Splash — the only other restorer since P-05 —
      // so opening a habit/sensor widget landed on a blank (no name/id) profile.
      // restoreDefaultProfile loads the REAL name, so unlike App's pre-P-05
      // hardcoded 'User' login it converges on exactly the profile Splash would
      // pick and the two can race harmlessly. No-op if one is already active. (P-10)
      const wasActive = !!useAppStore.getState().activeProfile;
      await restoreDefaultProfile();

      // Post-login setup. If a profile was ALREADY active at mount (hot reload),
      // no null->active store transition fires, so run it directly here. If the
      // restore above (or Splash) is what makes a profile active, the subscription
      // below turns that transition into onProfileReady — running it here too would
      // double it. Either way a returning, onboarded user gets their queued widget
      // taps drained.
      if (wasActive) {
        await onProfileReady();
      }
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
      // Not while the consent sheet is still up: starting the service here would
      // raise its notification behind a screen that is still asking permission for it.
      if (!consentPendingRef.current) sensorService.ensureTracking(useAppStore.getState);
    });

    // Keep the native service's config in step with the habits themselves, so
    // editing a goal or a sunset cutoff takes effect without restarting the app.
    // habitsById gets a new identity on every habit mutation (add/edit/progress/
    // delete), so this fires on exactly the same changes the old `habits` array did.
    const unsubscribeHabits = useAppStore.subscribe((state, prev) => {
      if (state.habitsById !== prev.habitsById) {
        sensorService.refreshConfig(useAppStore.getState);
      }
      // A profile just became active — Splash's auto-login finished, or the user
      // logged in by hand. This is the first moment habits exist, so it is where
      // sensor permissions get checked, the service (re)starts, and queued widget
      // taps drain, now that App no longer does the login itself (P-05).
      if (state.activeProfile && state.activeProfile !== prev.activeProfile) {
        onProfileReady();
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
    const handleDeepLink = async (event: { url: string }) => {
      const url = event.url;
      console.log('Deep link received:', url);

      // A widget action link can cold-start the app straight here, ahead of any
      // profile being restored. The mutators below (toggleHabit, pauseTimer, the
      // progress updaters) act on whatever profile is loaded, so firing them against
      // the empty pre-login store silently drops the tap. Restore first — the same
      // guard WidgetActionHandler already does for the task widget. (P-10)
      await restoreDefaultProfile();

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
          <TrackingConsentSheet
            visible={consentVisible}
            habits={habits}
            onDone={finishConsent}
          />
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

export default App;
