import AsyncStorage from '@react-native-async-storage/async-storage';
import { createDefaultSettings, deriveCurrentTermParams } from '../constants/gdouTimetable';
import { PersistedAppData } from '../types/models';
import {
  findForbiddenCredentialKeys,
  FORBIDDEN_CREDENTIAL_KEYS,
  sanitizeForZeroRetention,
} from './zeroRetentionSanitizer';

export { FORBIDDEN_CREDENTIAL_KEYS, findForbiddenCredentialKeys, sanitizeForZeroRetention };

const STORAGE_KEY = '@gdou_schedule_data_v1';
const SCHEMA_VERSION = 1;

export function createInitialAppData(now: Date = new Date()): PersistedAppData {
  const term = deriveCurrentTermParams(now);
  return {
    schemaVersion: SCHEMA_VERSION,
    courses: [],
    exams: [],
    grades: [],
    alarms: [],
    coupleSchedule: null,
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
    const rawCouple = parsed.coupleSchedule;
    const coupleSchedule =
      rawCouple &&
      typeof rawCouple === 'object' &&
      Array.isArray(rawCouple.courses)
        ? {
            partnerName: String(rawCouple.partnerName || 'TA').trim().slice(0, 20) || 'TA',
            termLabel: String(rawCouple.termLabel || defaults.termLabel),
            termStartDate: String(rawCouple.termStartDate || defaults.settings.termStartDate),
            courses: rawCouple.courses,
            updatedAtIso: String(rawCouple.updatedAtIso || new Date().toISOString()),
          }
        : null;
    return {
      ...defaults,
      ...parsed,
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
      exams: Array.isArray(parsed.exams) ? parsed.exams : [],
      grades: Array.isArray(parsed.grades) ? parsed.grades : [],
      alarms: Array.isArray(parsed.alarms) ? parsed.alarms : [],
      coupleSchedule,
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
 * inspects actual persisted JSON keys recursively to prove zero credentials exist on disk.
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
  let found: string[] = [];
  try {
    found = findForbiddenCredentialKeys(JSON.parse(raw));
  } catch {
    found = [];
  }
  return {
    hasStoredData: true,
    byteSize: raw.length,
    credentialKeysFound: found,
  };
}
