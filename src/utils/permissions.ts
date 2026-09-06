import { PermissionsAndroid, Platform } from 'react-native';
import { habitSlot, type SensorSlot } from '../services/WidgetContract';

export const requestStoragePermission = async () => {
    if (Platform.OS !== 'android') return true;

    // Android 10+ (API 29+) uses scoped storage, doesn't need WRITE_EXTERNAL_STORAGE for Downloads
    const sdkVersion = Platform.Version;
    if (typeof sdkVersion === 'number' && sdkVersion >= 29) {
        // No permission needed for Downloads folder on Android 10+
        return true;
    }

    // For Android 9 and below
    try {
        const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
            PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
        ]);

        return (
            granted['android.permission.WRITE_EXTERNAL_STORAGE'] === PermissionsAndroid.RESULTS.GRANTED &&
            granted['android.permission.READ_EXTERNAL_STORAGE'] === PermissionsAndroid.RESULTS.GRANTED
        );
    } catch (err) {
        console.warn(err);
        return false;
    }
};

/**
 * Which runtime permissions a set of habits actually needs.
 *
 * Asking for everything up front is the fastest way to get everything denied, so
 * this is derived from the habits the user has: no distance habit, no location
 * prompt. ACTIVITY_RECOGNITION is the one that matters most — without it Android
 * 10+ refuses TYPE_STEP_COUNTER readings entirely, which is why a step habit could
 * sit at zero all day while the phone's own health app counted fine.
 */
const sensorPermissionsFor = (habits: any[]): string[] => {
    const sdk = typeof Platform.Version === 'number' ? Platform.Version : 0;
    const needed = new Set<string>();

    // Slot, not raw sensorType. A habit whose sensorType went missing while its
    // templateId survived still needs its permission asked for — otherwise City
    // Glider was never granted location at all, and a distance habit that is never
    // allowed to see a GPS fix reads zero metres forever with nothing to show why.
    const types = new Set(
        (habits || [])
            .map((h: any) => habitSlot(h))
            .filter((slot): slot is SensorSlot => slot !== null)
    );

    if (types.has('pedometer') || types.has('movement')) {
        if (sdk >= 29) needed.add('android.permission.ACTIVITY_RECOGNITION');
    }
    if (types.has('gps')) {
        needed.add('android.permission.ACCESS_FINE_LOCATION');
    }
    if (types.has('noise')) {
        needed.add('android.permission.RECORD_AUDIO');
    }
    // The tracking notification is the visible face of the foreground service; if
    // it is blocked the service still runs, but the user has no way to see or stop it.
    if (sdk >= 33 && types.size > 0) {
        needed.add('android.permission.POST_NOTIFICATIONS');
    }

    return [...needed];
};

/**
 * Request whatever the current sensor habits require. Returns the permissions still
 * missing afterwards, so callers can explain the consequence rather than silently
 * tracking nothing.
 *
 * Deliberately does not request ACCESS_BACKGROUND_LOCATION: Android 11+ only grants
 * it from Settings, and the foreground service keeps foreground-location access
 * alive for as long as it runs, which is enough for a distance habit.
 */
export const requestSensorPermissions = async (habits: any[]): Promise<string[]> => {
    if (Platform.OS !== 'android') return [];

    const wanted = sensorPermissionsFor(habits);
    if (wanted.length === 0) return [];

    try {
        const already = await Promise.all(wanted.map(p => PermissionsAndroid.check(p as any)));
        const toAsk = wanted.filter((_, i) => !already[i]);
        if (toAsk.length === 0) return [];

        // The permission names are built dynamically above, so the strongly-keyed
        // return type cannot be indexed with them; a plain record is the honest shape.
        const result = (await PermissionsAndroid.requestMultiple(toAsk as any)) as Record<string, string>;
        return toAsk.filter(p => result[p] !== PermissionsAndroid.RESULTS.GRANTED);
    } catch (err) {
        console.warn('Sensor permission request failed', err);
        return wanted;
    }
};

/**
 * Which permissions one habit still lacks, checked without prompting.
 *
 * For telling the user why a sensor habit is reading zero. POST_NOTIFICATIONS is
 * excluded on purpose: without it the foreground service loses its visible face, but
 * it keeps measuring, so listing it here would misattribute the silence.
 *
 * A denial used to be invisible — the native service logged its bail to logcat and
 * the screen carried on drawing a confident 0.0 KM, which reads as a broken sensor
 * rather than a permission the user can grant.
 */
export const missingSensorPermissions = async (habit: any): Promise<string[]> => {
    if (Platform.OS !== 'android' || !habit) return [];

    const wanted = sensorPermissionsFor([habit]).filter(
        p => p !== 'android.permission.POST_NOTIFICATIONS'
    );
    if (wanted.length === 0) return [];

    try {
        const already = await Promise.all(wanted.map(p => PermissionsAndroid.check(p as any)));
        return wanted.filter((_, i) => !already[i]);
    } catch (err) {
        console.warn('Sensor permission check failed', err);
        return [];
    }
};

/** Human label for a permission string, for the "grant this" prompts. */
export const permissionLabel = (permission: string): string => {
    if (permission.endsWith('ACCESS_FINE_LOCATION')) return 'LOCATION';
    if (permission.endsWith('ACTIVITY_RECOGNITION')) return 'PHYSICAL ACTIVITY';
    if (permission.endsWith('RECORD_AUDIO')) return 'MICROPHONE';
    if (permission.endsWith('POST_NOTIFICATIONS')) return 'NOTIFICATIONS';
    return permission.split('.').pop() || permission;
};
