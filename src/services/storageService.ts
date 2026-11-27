import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_SCHEDULE_APPEARANCE } from '../constants/gdouTimetable';
import { PersistedAppData } from '../types/models';
import {
  buildTermArchiveKey,
  createInitialAppData,
  mergeCourseCustomizations,
  SCHEMA_VERSION,
  snapshotActiveTermToArchive,
  switchToArchivedTerm,
} from './storageHelpers';
import {
  findForbiddenCredentialKeys,
  FORBIDDEN_CREDENTIAL_KEYS,
  sanitizeForZeroRetention,
} from './zeroRetentionSanitizer';

export {
  buildTermArchiveKey,
  createInitialAppData,
  findForbiddenCredentialKeys,
  FORBIDDEN_CREDENTIAL_KEYS,
  mergeCourseCustomizations,
  sanitizeForZeroRetention,
  snapshotActiveTermToArchive,
  switchToArchivedTerm,
};

const STORAGE_KEY = '@gdou_schedule_data_v1';

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
    const mergedSettings = {
      ...defaults.settings,
      ...(parsed.settings ?? {}),
      themePreference: parsed.settings?.themePreference ?? 'system',
      appearance: {
        ...DEFAULT_SCHEDULE_APPEARANCE,
        ...(parsed.settings?.appearance ?? {}),
      },
      calendarOverrides: Array.isArray(parsed.settings?.calendarOverrides)
        ? parsed.settings.calendarOverrides
        : [],
    };
    const courses = Array.isArray(parsed.courses) ? parsed.courses : [];
    const exams = Array.isArray(parsed.exams) ? parsed.exams : [];
    const academicYear = String(parsed.academicYear || defaults.academicYear);
    const semesterCode = String(parsed.semesterCode || defaults.semesterCode);
    const termLabel = String(parsed.termLabel || defaults.termLabel);

    const rawArchives =
      parsed.termArchives && typeof parsed.termArchives === 'object'
        ? { ...parsed.termArchives }
        : {};
    if (courses.length > 0) {
      const currentKey = buildTermArchiveKey(academicYear, semesterCode);
      if (!rawArchives[currentKey]) {
        rawArchives[currentKey] = {
          termKey: currentKey,
          termLabel,
          academicYear,
          semesterCode,
          termStartDate: mergedSettings.termStartDate,
          courses,
          exams,
          updatedAtIso: parsed.lastSyncedAt || new Date().toISOString(),
        };
      }
    }

    return {
      ...defaults,
      ...parsed,
      schemaVersion: SCHEMA_VERSION,
      courses,
      exams,
      grades: Array.isArray(parsed.grades) ? parsed.grades : [],
      alarms: Array.isArray(parsed.alarms) ? parsed.alarms : [],
      coupleSchedule,
      graduationAudit: parsed.graduationAudit ?? null,
      lastScheduleDiff: parsed.lastScheduleDiff ?? null,
      emptyClassroomSnapshot: parsed.emptyClassroomSnapshot ?? null,
      campusSearchHistory: parsed.campusSearchHistory ?? null,
      termLabel,
      academicYear,
      semesterCode,
      termArchives: rawArchives,
      settings: mergedSettings,
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
