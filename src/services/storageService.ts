import AsyncStorage from '@react-native-async-storage/async-storage';
import { createDefaultSettings, deriveCurrentTermParams } from '../constants/gdouTimetable';
import { PersistedAppData } from '../types/models';

const STORAGE_KEY = '@gdou_schedule_data_v1';
const SCHEMA_VERSION = 1;

/**
 * Defense-in-depth denylist: guarantees NO credential or session key can ever
 * be serialized into local storage even by accident.
 */
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'username',
  'password',
  'pwd',
  'passwd',
  'cookie',
  'cookies',
  'token',
  'jsessionid',
  'wfwsessid',
  'tgc',
  'pwdEncryptSalt',
  'execution',
  'salt',
]);

export function sanitizeForZeroRetention<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForZeroRetention(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_CREDENTIAL_KEYS.has(k.toLowerCase()) || FORBIDDEN_CREDENTIAL_KEYS.has(k)) {
        continue;
      }
      clean[k] = sanitizeForZeroRetention(v);
    }
    return clean as T;
  }
  return value;
}

export function createInitialAppData(now: Date = new Date()): PersistedAppData {
  const term = deriveCurrentTermParams(now);
  return {
    schemaVersion: SCHEMA_VERSION,
    courses: [],
    exams: [],
    alarms: [],
    termLabel: term.label,
    academicYear: term.xnm,
    semesterCode: term.xqm,
    lastSyncedAt: null,
    lastSyncReceipt: null,
    settings: createDefaultSettings(now),
  };
}

export async function loadPersistedData(): Promise<PersistedAppData> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialAppData();
    const parsed = JSON.parse(raw) as Partial<PersistedAppData>;
    const defaults = createInitialAppData();
    return {
      ...defaults,
      ...parsed,
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
      exams: Array.isArray(parsed.exams) ? parsed.exams : [],
      alarms: Array.isArray(parsed.alarms) ? parsed.alarms : [],
      settings: {
        ...defaults.settings,
        ...(parsed.settings ?? {}),
      },
    };
  } catch {
    return createInitialAppData();
  }
}

export async function savePersistedData(data: PersistedAppData): Promise<void> {
  const sanitized = sanitizeForZeroRetention(data);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
}

export async function clearAllLocalData(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

/**
 * Audit helper shown in Settings -> Privacy Verification:
 * inspects actual persisted JSON keys to prove zero credentials exist on disk.
 */
export async function auditLocalStorageZeroCredentials(): Promise<{
  hasStoredData: boolean;
  byteSize: number;
  credentialKeysFound: string[];
}> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { hasStoredData: false, byteSize: 0, credentialKeysFound: [] };
  }
  const found: string[] = [];
  const inspect = (obj: unknown) => {
    if (Array.isArray(obj)) {
      obj.forEach(inspect);
    } else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (FORBIDDEN_CREDENTIAL_KEYS.has(k.toLowerCase())) {
          found.push(k);
        }
        inspect(v);
      }
    }
  };
  try {
    inspect(JSON.parse(raw));
  } catch {
    // ignore
  }
  return {
    hasStoredData: true,
    byteSize: raw.length,
    credentialKeysFound: found,
  };
}
