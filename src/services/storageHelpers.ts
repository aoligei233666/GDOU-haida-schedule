import {
  createDefaultSettings,
  deriveCurrentTermParams,
} from '../constants/gdouTimetable';
import { CourseItem, PersistedAppData, TermArchiveSnapshot } from '../types/models';

export const SCHEMA_VERSION = 3;

export function buildTermArchiveKey(academicYear: string, semesterCode: string): string {
  const y = String(academicYear ?? '').trim() || 'unknown';
  const s = String(semesterCode ?? '').trim() || '3';
  return `${y}-${s}`;
}

export function snapshotActiveTermToArchive(data: PersistedAppData): Record<string, TermArchiveSnapshot> {
  const nextArchives: Record<string, TermArchiveSnapshot> = { ...(data.termArchives ?? {}) };
  if (data.courses.length > 0 || data.exams.length > 0) {
    const key = buildTermArchiveKey(data.academicYear, data.semesterCode);
    nextArchives[key] = {
      termKey: key,
      termLabel: data.termLabel,
      academicYear: data.academicYear,
      semesterCode: data.semesterCode,
      termStartDate: data.settings.termStartDate,
      courses: data.courses,
      exams: data.exams,
      updatedAtIso: data.lastSyncedAt || new Date().toISOString(),
    };
  }
  return nextArchives;
}

export function mergeCourseCustomizations(
  previousCourses: CourseItem[],
  incomingCourses: CourseItem[]
): CourseItem[] {
  const byIdentity = new Map<string, CourseItem>();
  const makeKey = (c: CourseItem) =>
    `${c.name.trim()}|${c.code.trim()}|${c.dayOfWeek}|${c.startSection}-${c.endSection}`;
  const byNameOnly = new Map<string, CourseItem>();

  for (const prev of previousCourses) {
    if (prev.isManual) continue;
    const hasCustom =
      Boolean(prev.customNote) ||
      Boolean(prev.customLocation) ||
      typeof prev.customColorIndex === 'number' ||
      Boolean(prev.todos && prev.todos.length > 0);
    if (!hasCustom) continue;
    byIdentity.set(makeKey(prev), prev);
    if (!byNameOnly.has(prev.name.trim())) {
      byNameOnly.set(prev.name.trim(), prev);
    }
  }

  return incomingCourses.map((inc) => {
    const matched = byIdentity.get(makeKey(inc)) ?? byNameOnly.get(inc.name.trim());
    if (!matched) return inc;
    return {
      ...inc,
      customNote: matched.customNote,
      customLocation: matched.customLocation,
      customColorIndex: matched.customColorIndex,
      todos: matched.todos,
    };
  });
}

export function switchToArchivedTerm(data: PersistedAppData, targetTermKey: string): PersistedAppData {
  const archives = snapshotActiveTermToArchive(data);
  const target = archives[targetTermKey];
  if (!target) return data;
  return {
    ...data,
    courses: target.courses,
    exams: target.exams,
    termLabel: target.termLabel,
    academicYear: target.academicYear,
    semesterCode: target.semesterCode,
    termArchives: archives,
    settings: {
      ...data.settings,
      termStartDate: target.termStartDate || data.settings.termStartDate,
    },
  };
}

export function createInitialAppData(now: Date = new Date()): PersistedAppData {
  const term = deriveCurrentTermParams(now);
  return {
    schemaVersion: SCHEMA_VERSION,
    courses: [],
    exams: [],
    grades: [],
    alarms: [],
    coupleSchedule: null,
    graduationAudit: null,
    lastScheduleDiff: null,
    emptyClassroomSnapshot: null,
    campusSearchHistory: null,
    termLabel: term.label,
    academicYear: term.xnm,
    semesterCode: term.xqm,
    termArchives: {},
    lastSyncedAt: null,
    lastSyncReceipt: null,
    settings: createDefaultSettings(now),
  };
}
