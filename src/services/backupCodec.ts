import appConfig from '../../app.json';
import { createDefaultSettings, DEFAULT_SCHEDULE_APPEARANCE } from '../constants/gdouTimetable';
import { PersistedAppData } from '../types/models';
import { createInitialAppData } from './storageHelpers';
import {
  findForbiddenCredentialKeys,
  sanitizeForZeroRetention,
} from './zeroRetentionSanitizer';

export const BACKUP_FORMAT_TAG = 'gdou-schedule-backup-v1';

export interface GdouLocalBackupEnvelope {
  format: typeof BACKUP_FORMAT_TAG;
  appVersion: string;
  exportedAtIso: string;
  data: PersistedAppData;
}

export function buildZeroRetentionBackupEnvelope(
  data: PersistedAppData,
  now: Date = new Date()
): GdouLocalBackupEnvelope {
  const sanitized = sanitizeForZeroRetention(data);
  const portableSettings = {
    ...sanitized.settings,
    appearance: {
      ...(sanitized.settings.appearance ?? DEFAULT_SCHEDULE_APPEARANCE),
      customBackgroundUri: undefined,
      wallpaperPreset:
        sanitized.settings.appearance?.wallpaperPreset === 'custom_photo'
          ? 'ocean_breeze'
          : (sanitized.settings.appearance?.wallpaperPreset ?? 'none'),
    },
  };
  const envelope: GdouLocalBackupEnvelope = {
    format: BACKUP_FORMAT_TAG,
    appVersion: appConfig.expo.version,
    exportedAtIso: now.toISOString(),
    data: {
      ...sanitized,
      alarms: sanitized.alarms.map((a) => ({
        ...a,
        notificationId: undefined,
        systemAlarmId: undefined,
        enabled: false,
      })),
      settings: portableSettings,
    },
  };
  const forbidden = findForbiddenCredentialKeys(envelope);
  if (forbidden.length > 0) {
    throw new Error(`备份安全阻断：检测到敏感字段 ${forbidden.join(', ')}`);
  }
  return envelope;
}

export function parseAndValidateBackupJson(rawText: string): {
  data: PersistedAppData;
  exportedAtIso?: string;
  summary: {
    coursesCount: number;
    examsCount: number;
    gradesCount: number;
    archivedTermsCount: number;
    hasCouple: boolean;
  };
} {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) {
    throw new Error('备份内容为空，请粘贴或选择有效的 .gdoubackup.json 文件');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('备份文件不是有效的 JSON 格式，请检查是否完整复制');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('备份文件结构无效');
  }
  const obj = parsed as Record<string, unknown>;
  let rawData: Partial<PersistedAppData>;
  let exportedAtIso: string | undefined;

  if (obj.format === BACKUP_FORMAT_TAG && obj.data && typeof obj.data === 'object') {
    rawData = obj.data as Partial<PersistedAppData>;
    exportedAtIso = typeof obj.exportedAtIso === 'string' ? obj.exportedAtIso : undefined;
  } else if (Array.isArray(obj.courses) || Array.isArray(obj.grades) || Array.isArray(obj.exams)) {
    rawData = obj as Partial<PersistedAppData>;
  } else {
    throw new Error('未识别的海大课表备份格式（缺少 courses / exams / grades 数据）');
  }

  const defaults = createInitialAppData();
  const sanitized = sanitizeForZeroRetention(rawData);
  const mergedSettings = {
    ...createDefaultSettings(),
    ...(sanitized.settings ?? {}),
    appearance: {
      ...DEFAULT_SCHEDULE_APPEARANCE,
      ...(sanitized.settings?.appearance ?? {}),
    },
    calendarOverrides: Array.isArray(sanitized.settings?.calendarOverrides)
      ? sanitized.settings.calendarOverrides
      : [],
  };

  const normalized: PersistedAppData = {
    ...defaults,
    ...sanitized,
    schemaVersion: 3,
    courses: Array.isArray(sanitized.courses) ? sanitized.courses : [],
    exams: Array.isArray(sanitized.exams) ? sanitized.exams : [],
    grades: Array.isArray(sanitized.grades) ? sanitized.grades : [],
    alarms: Array.isArray(sanitized.alarms) ? sanitized.alarms : [],
    coupleSchedule:
      sanitized.coupleSchedule && Array.isArray(sanitized.coupleSchedule.courses)
        ? sanitized.coupleSchedule
        : null,
    termArchives:
      sanitized.termArchives && typeof sanitized.termArchives === 'object'
        ? sanitized.termArchives
        : {},
    settings: mergedSettings,
  };

  return {
    data: normalized,
    exportedAtIso,
    summary: {
      coursesCount: normalized.courses.length,
      examsCount: normalized.exams.length,
      gradesCount: normalized.grades.length,
      archivedTermsCount: Object.keys(normalized.termArchives ?? {}).length,
      hasCouple: Boolean(normalized.coupleSchedule),
    },
  };
}
