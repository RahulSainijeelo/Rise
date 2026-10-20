import { useAppStore } from '../store/useAppStore';
import { SettingsService } from '../services/SettingsService';
import { StorageService } from '../services/StorageService';

/**
 * Restore the saved default profile into the store, if nothing is logged in yet.
 * ============================================================================
 * The single source of truth for "reopen into the user's profile". It used to be
 * copied in three places — SplashScreen (normal launch), WidgetActionHandler (the
 * task widget, P-08), and once in App.tsx — and the copies drifted: P-05 removed
 * App's copy to kill a phantom (see below), which left every widget deep link that
 * does NOT route through WidgetActionHandler (habit detail, focus, add-sensor-habit,
 * the habit-matrix / habit-link links) cold-starting onto a screen with no profile
 * restored — the "blank profile, no name/no id" a habit/sensor widget opened into.
 * Consolidating into one helper means a new entry point cannot silently reintroduce
 * that gap. (P-10)
 *
 * Crucially it loads the profile's REAL name via loadUserData, exactly as Splash
 * does, rather than the hardcoded `name: 'User'` App.tsx used before P-05. That
 * hardcoded name was the phantom: because Splash waits out a 2s animation, App's
 * copy won the cold-start race and the app showed a half-built "User" profile. With
 * the real name, App and Splash converge on the identical profile, so whichever
 * runs first the result is the same and the race is harmless.
 *
 * Idempotent: no-ops (and reports success) when a profile is already active, so it
 * is safe to call from several entry points that may overlap on the same launch.
 *
 * @returns true if a profile is active afterwards (already was, or was just
 *          restored); false if there is no default profile or its data is missing —
 *          the caller then decides whether to send the user to Login.
 */
export const restoreDefaultProfile = async (): Promise<boolean> => {
    // Already logged in (hot reload, or another entry point beat us to it).
    if (useAppStore.getState().activeProfile) return true;

    const settings = await SettingsService.getSettings();
    if (!settings.defaultProfile) return false;

    // Load the real name so this can never resurrect the pre-P-05 "User" phantom;
    // a missing/invalid file means there is nothing to reopen into.
    const userData = await StorageService.loadUserData(settings.defaultProfile);
    if (!userData) return false;

    await useAppStore.getState().login({
        id: settings.defaultProfile,
        name: userData.name || settings.defaultProfile,
    });

    return !!useAppStore.getState().activeProfile;
};
