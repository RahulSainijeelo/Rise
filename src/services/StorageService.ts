import RNFS from 'react-native-fs';
import { Platform } from 'react-native';
import dayjs from 'dayjs';

const APP_FOLDER_NAME = 'Rise_Data';
const BASE_PATH = `${RNFS.DocumentDirectoryPath}/${APP_FOLDER_NAME}`;

// Files written into Rise_Data/ by other services that must never be treated as
// user profiles (DeckService writes deck_layout.json; SettingsService writes
// system_settings.json).
const NON_PROFILE_FILES = ['system_settings.json', 'deck_layout.json'];

export interface UserProfile {
    id: string;
    name: string;
}

export class StorageService {
    static async init() {
        if (!RNFS || !RNFS.exists) {
            console.warn('RNFS native module is not ready. Storage will be disabled.');
            return false;
        }
        try {
            const exists = await RNFS.exists(BASE_PATH);
            if (!exists) {
                await RNFS.mkdir(BASE_PATH);
            }
            return true;
        } catch (e) {
            console.warn('Failed to init storage:', e);
            return false;
        }
    }

    // True only for a real profile file: a non-empty string id + name, and not a
    // deck layout ({ cards: [...] }). Used to keep non-profile files in the data
    // directory (e.g. deck_layout.json) from surfacing as phantom profiles.
    private static isProfileShape(data: any): boolean {
        return (
            !!data &&
            typeof data === 'object' &&
            !Array.isArray(data) &&
            typeof data.id === 'string' &&
            data.id.length > 0 &&
            typeof data.name === 'string' &&
            data.name.length > 0 &&
            !Array.isArray(data.cards)
        );
    }

    // Scans all JSON files and returns basic identity info
    static async getProfiles(): Promise<UserProfile[]> {
        const ready = await this.init();
        if (!ready) return [];
        try {
            const files = await RNFS.readDir(BASE_PATH);
            const jsonFiles = files.filter(
                f => f.isFile() && f.name.endsWith('.json') && !NON_PROFILE_FILES.includes(f.name),
            );

            const profiles: UserProfile[] = [];

            for (const file of jsonFiles) {
                try {
                    const content = await RNFS.readFile(file.path, 'utf8');
                    const data = JSON.parse(content);

                    // Only keep files that are genuinely profiles. Non-profile files
                    // (e.g. a stray deck layout) are ignored, never deleted.
                    if (this.isProfileShape(data)) {
                        profiles.push({ id: data.id, name: data.name });
                    } else {
                        console.warn(`Skipping non-profile file in data directory: ${file.name}`);
                    }
                } catch (readErr) {
                    console.warn(`Failed to read/parse profile ${file.name}`, readErr);
                }
            }
            return profiles;
        } catch (e) {
            console.error('Failed to read profiles directory:', e);
            return [];
        }
    }

    // Backward compatibility for LoginScreen until fully refactored
    static async getUserFiles() {
        const profiles = await this.getProfiles();
        return profiles.map(p => p.name);
    }

    static async saveUserData(userId: string, data: any) {
        await this.init();
        const filePath = `${BASE_PATH}/${userId}.json`;
        await RNFS.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    }

    // Load full data by ID
    static async loadUserData(userId: string) {
        const filePath = `${BASE_PATH}/${userId}.json`;

        const exists = await RNFS.exists(filePath);
        if (exists) {
            const content = await RNFS.readFile(filePath, 'utf8');
            const data = JSON.parse(content);

            // The data directory also holds non-profile files (e.g. deck_layout.json).
            // Refuse to surface those as an empty-but-valid profile; mirror the
            // missing-file case by returning null rather than fabricating a profile.
            if (!this.isProfileShape(data)) {
                console.warn(`loadUserData: "${userId}" is not a valid profile; ignoring.`);
                return null;
            }

            return data;
        }
        return null;
    }

    static async exportProfile(userId: string) {
        const sourcePath = `${BASE_PATH}/${userId}.json`;
        const fileName = `Rise_Backup_${userId}_${dayjs().format('YYYYMMDD_HHmmss')}.json`;

        let destPath: string;
        if (Platform.OS === 'android') {
            // Create Rise folder in Downloads
            const riseFolder = `${RNFS.DownloadDirectoryPath}/Rise`;
            const folderExists = await RNFS.exists(riseFolder);
            if (!folderExists) {
                await RNFS.mkdir(riseFolder);
            }
            destPath = `${riseFolder}/${fileName}`;
        } else {
            destPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
        }

        try {
            await RNFS.copyFile(sourcePath, destPath);
            return destPath;
        } catch (e) {
            console.error('Export failed', e);
            throw e;
        }
    }

    // Generates a profile id that is not already taken by a file on disk.
    private static async generateUniqueProfileId(): Promise<string> {
        let id = '';
        do {
            id = Math.random().toString(36).slice(2, 11);
        } while (id.length === 0 || (await RNFS.exists(`${BASE_PATH}/${id}.json`)));
        return id;
    }

    static async importProfile(sourceUri: string) {
        await this.init();
        try {
            const content = await RNFS.readFile(sourceUri, 'utf8');
            const data = JSON.parse(content);

            // Validate basic structure
            if (!this.isProfileShape(data)) {
                throw new Error("Invalid profile format: missing id or name");
            }

            // Non-destructive import: never overwrite an existing profile. If the
            // incoming id collides with one already on disk, mint a fresh unique id
            // so the imported data is kept alongside the existing profile.
            let destId: string = data.id;
            let destPath = `${BASE_PATH}/${destId}.json`;
            if (await RNFS.exists(destPath)) {
                destId = await this.generateUniqueProfileId();
                destPath = `${BASE_PATH}/${destId}.json`;
                data.id = destId;
            }

            await RNFS.writeFile(destPath, JSON.stringify(data, null, 2), 'utf8');

            return { id: destId, name: data.name };
        } catch (e) {
            console.error('Import failed', e);
            throw e;
        }
    }
}
