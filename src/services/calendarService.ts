import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import { getActivePeriods } from '../constants/gdouTimetable';
import { AppSettings, CourseItem, ExamItem } from '../types/models';
import { parseExamIsoLocal } from './examParser';
import {
  getCourseOccurrences,
  isCourseSchedulable,
  parseLocalDateStrict,
} from './scheduleParser';

const GDOU_CALENDAR_TITLE = '海大课表 (GDOU)';
const GDOU_CALENDAR_NAME = 'gdou_schedule_calendar';
const GDOU_ACCOUNT_NAME = 'gdou_schedule_local';
const COURSE_TAG_PREFIX = '[GDOU-COURSE:';
const EXAM_TAG_PREFIX = '[GDOU-EXAM:';
const GDOU_TAG_REGEX = /\[GDOU-(?:COURSE|EXAM):[^\]]+\]/;

export interface CalendarTarget {
  calendarId: string;
  calendarTitle: string;
  isDedicated: boolean;
}

export interface CalendarSyncSummary {
  calendarId: string;
  calendarTitle: string;
  isDedicated: boolean;
  eventsCreated: number;
  eventsUpdated: number;
  eventsReplaced: number;
  eventsRemoved: number;
  skippedPast: number;
  skippedUnparsed: number;
  failed: number;
  firstError?: string;
}

type SystemCalendar = Awaited<ReturnType<typeof Calendar.getCalendarsAsync>>[number];
type SystemEvent = Awaited<ReturnType<typeof Calendar.getEventsAsync>>[number];

interface DesiredCalendarEvent {
  tag: string;
  details: {
    title: string;
    location?: string;
    notes?: string;
    startDate: Date;
    endDate: Date;
    timeZone?: string;
    alarms?: Calendar.Alarm[];
  };
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err ?? '未知系统错误');
}

function extractGdouTag(notes?: string | null): string | null {
  if (!notes) return null;
  const match = String(notes).match(GDOU_TAG_REGEX);
  return match ? match[0] : null;
}

function isDedicatedGdouCalendar(cal: SystemCalendar): boolean {
  return (
    cal.name === GDOU_CALENDAR_NAME ||
    cal.title === GDOU_CALENDAR_TITLE ||
    cal.title === '广海课表 (GDOU)'
  );
}

function isWritableCalendar(cal: SystemCalendar): boolean {
  if (cal.allowsModifications === false) return false;
  const sourceType = String(cal.source?.type ?? '').toLowerCase();
  if (
    sourceType === String(Calendar.SourceType.BIRTHDAYS).toLowerCase() ||
    sourceType === String(Calendar.SourceType.SUBSCRIBED).toLowerCase()
  ) {
    return false;
  }
  if (Platform.OS === 'android' && cal.accessLevel) {
    const level = String(cal.accessLevel).toLowerCase();
    const writableLevels = new Set([
      String(Calendar.CalendarAccessLevel.OWNER).toLowerCase(),
      String(Calendar.CalendarAccessLevel.ROOT).toLowerCase(),
      String(Calendar.CalendarAccessLevel.EDITOR).toLowerCase(),
      String(Calendar.CalendarAccessLevel.CONTRIBUTOR).toLowerCase(),
    ]);
    if (!writableLevels.has(level)) {
      return false;
    }
  }
  return true;
}

function pickFallbackWritableCalendar(
  calendars: SystemCalendar[],
  excludeId?: string
): SystemCalendar | null {
  const candidates = calendars.filter((c) => c.id !== excludeId && isWritableCalendar(c));
  if (candidates.length === 0) return null;

  const scoreCalendar = (c: SystemCalendar): number => {
    let score = 0;
    if (c.isPrimary) score += 100;
    if (c.isVisible !== false) score += 40;
    if (c.isSynced !== false) score += 20;
    const level = String(c.accessLevel ?? '').toLowerCase();
    if (level === 'owner' || level === 'root') score += 30;
    const srcType = String(c.source?.type ?? '').toLowerCase();
    if (
      srcType === String(Calendar.SourceType.LOCAL).toLowerCase() ||
      srcType === String(Calendar.SourceType.CALDAV).toLowerCase() ||
      srcType === String(Calendar.SourceType.EXCHANGE).toLowerCase()
    ) {
      score += 15;
    }
    const title = String(c.title ?? '');
    if (!/节假日|holiday|生日|birthday|农历|lunar|contact/i.test(title)) {
      score += 50;
    }
    return score;
  };

  candidates.sort((a, b) => scoreCalendar(b) - scoreCalendar(a));
  return candidates[0] ?? null;
}

async function ensureCalendarPermissions(): Promise<void> {
  const current = await Calendar.getCalendarPermissionsAsync();
  let status = current.status;
  if (status !== 'granted') {
    const req = await Calendar.requestCalendarPermissionsAsync();
    status = req.status;
  }
  if (status !== 'granted') {
    if (Platform.OS === 'ios') {
      throw new Error(
        '未获得 iOS 日历完全访问权限。请前往“设置 -> 海大课表 -> 日历”选择「完全访问」，否则无法同步或更新课表日程。'
      );
    }
    throw new Error('未获得系统日历读写权限，请在手机“设置 -> 应用 -> 海大课表 -> 权限”中允许访问日历');
  }
}

async function getDefaultIosWritableSource(
  calendars: SystemCalendar[]
): Promise<Calendar.Source | null> {
  try {
    const defaultCal = await Calendar.getDefaultCalendarAsync();
    if (defaultCal?.source && isWritableCalendar(defaultCal)) {
      return defaultCal.source;
    }
  } catch {
    // Fall back to scanning writable calendars
  }

  const writable = calendars.filter(isWritableCalendar);
  const icloud = writable.find((c) => c.source?.type === Calendar.SourceType.CALDAV);
  if (icloud?.source) return icloud.source;
  const local = writable.find((c) => c.source?.type === Calendar.SourceType.LOCAL);
  if (local?.source) return local.source;
  const exchange = writable.find((c) => c.source?.type === Calendar.SourceType.EXCHANGE);
  if (exchange?.source) return exchange.source;
  return writable[0]?.source ?? null;
}

/**
 * Find or create the dedicated "海大课表 (GDOU)" calendar.
 * - On Android: explicitly sets `isVisible: true`, `isSynced: true`, `timeZone`, `allowedReminders`,
 *   `allowedAvailabilities`, and repairs legacy invisible calendars created by older versions.
 * - On OEM Android ROMs (HyperOS/MIUI/HarmonyOS/ColorOS/OriginOS) or restricted iOS accounts where
 *   creating a new calendar is rejected, automatically falls back to the primary writable system calendar
 *   while keeping strict `[GDOU-COURSE:...]` / `[GDOU-EXAM:...]` tag isolation.
 */
export async function ensureGdouCalendarTarget(): Promise<{
  target: CalendarTarget;
  fallback: CalendarTarget | null;
}> {
  await ensureCalendarPermissions();

  let calendars: SystemCalendar[] = [];
  try {
    calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  } catch {
    calendars = [];
  }

  const fallbackCal = pickFallbackWritableCalendar(
    calendars.filter((c) => !isDedicatedGdouCalendar(c))
  );
  const fallbackTarget: CalendarTarget | null = fallbackCal
    ? {
        calendarId: fallbackCal.id,
        calendarTitle: fallbackCal.title || '系统默认日历',
        isDedicated: false,
      }
    : null;

  const existing = calendars.find(isDedicatedGdouCalendar);
  if (existing && isWritableCalendar(existing)) {
    // Repair legacy v1.1/v1.2 Android calendars that were created without VISIBLE=1 / SYNC_EVENTS=1
    if (
      Platform.OS === 'android' &&
      (existing.isVisible === false ||
        existing.isSynced === false ||
        existing.title !== GDOU_CALENDAR_TITLE)
    ) {
      try {
        await Calendar.updateCalendarAsync(existing.id, {
          name: GDOU_CALENDAR_NAME,
          title: GDOU_CALENDAR_TITLE,
          isVisible: true,
          isSynced: true,
        });
      } catch (err) {
        console.warn('Repair existing GDOU calendar warning:', err);
      }
    }
    return {
      target: {
        calendarId: existing.id,
        calendarTitle: GDOU_CALENDAR_TITLE,
        isDedicated: true,
      },
      fallback: fallbackTarget,
    };
  }

  let createErrorMsg = '';
  try {
    if (Platform.OS === 'ios') {
      const source = await getDefaultIosWritableSource(calendars);
      if (!source) {
        throw new Error('未找到支持新建日历的 iOS 日历源');
      }
      const createdId = await Calendar.createCalendarAsync({
        title: GDOU_CALENDAR_TITLE,
        color: '#0284C7',
        entityType: Calendar.EntityTypes.EVENT,
        sourceId: source.id,
        source,
        name: GDOU_CALENDAR_NAME,
        ownerAccount: 'personal',
        accessLevel: Calendar.CalendarAccessLevel.OWNER,
      });
      return {
        target: {
          calendarId: createdId,
          calendarTitle: GDOU_CALENDAR_TITLE,
          isDedicated: true,
        },
        fallback: fallbackTarget,
      };
    }

    const createdId = await Calendar.createCalendarAsync({
      title: GDOU_CALENDAR_TITLE,
      color: '#0284C7',
      entityType: Calendar.EntityTypes.EVENT,
      source: {
        isLocalAccount: true,
        name: GDOU_ACCOUNT_NAME,
        type: Calendar.SourceType.LOCAL,
      },
      name: GDOU_CALENDAR_NAME,
      ownerAccount: GDOU_ACCOUNT_NAME,
      timeZone: 'Asia/Shanghai',
      accessLevel: Calendar.CalendarAccessLevel.OWNER,
      isVisible: true,
      isSynced: true,
      allowedReminders: [Calendar.AlarmMethod.ALERT, Calendar.AlarmMethod.DEFAULT],
      allowedAvailabilities: [Calendar.Availability.BUSY, Calendar.Availability.FREE],
    });
    return {
      target: {
        calendarId: createdId,
        calendarTitle: GDOU_CALENDAR_TITLE,
        isDedicated: true,
      },
      fallback: fallbackTarget,
    };
  } catch (err) {
    createErrorMsg = formatErrorMessage(err);
    console.warn('Create dedicated GDOU calendar failed, attempting system calendar fallback:', createErrorMsg);
  }

  // Fallback path 1 (iOS): default writable calendar
  if (Platform.OS === 'ios') {
    try {
      const def = await Calendar.getDefaultCalendarAsync();
      if (def?.id && isWritableCalendar(def)) {
        return {
          target: {
            calendarId: def.id,
            calendarTitle: def.title || '默认日历',
            isDedicated: false,
          },
          fallback: null,
        };
      }
    } catch {
      // Proceed to scanned fallback
    }
  }

  // Fallback path 2: best existing writable calendar on Android or iOS
  if (fallbackTarget) {
    return {
      target: fallbackTarget,
      fallback: null,
    };
  }

  throw new Error(
    `无法创建「海大课表」日历且手机中无可用的可写系统日历（${createErrorMsg}）。请先打开手机自带「日历」App 完成初始化或登录日历账户后重试，或使用「导出 .ics 通用日历」。`
  );
}

export async function ensureGdouCalendar(): Promise<string> {
  const { target } = await ensureGdouCalendarTarget();
  return target.calendarId;
}

/**
 * Remove the dedicated GDOU calendar (if present) and clean up any GDOU-tagged events
 * written to fallback system calendars, without ever deleting user personal calendars.
 */
export async function deleteGdouCalendar(): Promise<{
  removedCalendar: boolean;
  removedEvents: number;
}> {
  await ensureCalendarPermissions();
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  let removedCalendar = false;
  let removedEvents = 0;

  const dedicated = calendars.filter(isDedicatedGdouCalendar);
  for (const cal of dedicated) {
    try {
      await Calendar.deleteCalendarAsync(cal.id);
      removedCalendar = true;
    } catch (err) {
      console.warn('Delete dedicated calendar warning:', err);
    }
  }

  // Clean up any GDOU-tagged events inside fallback system calendars without touching personal events
  const now = Date.now();
  const windowStart = new Date(now - 365 * 24 * 3600 * 1000);
  const windowEnd = new Date(now + 2 * 365 * 24 * 3600 * 1000);
  const others = calendars.filter((c) => !isDedicatedGdouCalendar(c) && isWritableCalendar(c));
  for (const cal of others) {
    try {
      const evs = await Calendar.getEventsAsync([cal.id], windowStart, windowEnd);
      const tagged = evs.filter((ev) => extractGdouTag(ev.notes) !== null);
      for (const ev of tagged) {
        try {
          await Calendar.deleteEventAsync(ev.id);
          removedEvents++;
        } catch {
          // Continue cleaning other events
        }
      }
    } catch {
      // Ignore calendars that do not support instance queries
    }
  }

  return { removedCalendar, removedEvents };
}

function getSemesterWindow(termStartDate: string, totalWeeks: number): { start: Date; end: Date } {
  const parsed = parseLocalDateStrict(termStartDate);
  const anchor = parsed ?? new Date();
  const start = new Date(anchor.getTime() - 21 * 24 * 3600 * 1000);
  const end = new Date(anchor.getTime() + (Math.max(20, totalWeeks) + 16) * 7 * 24 * 3600 * 1000);
  return { start, end };
}

async function safeListEvents(
  calendarId: string,
  windowStart: Date,
  windowEnd: Date
): Promise<SystemEvent[]> {
  try {
    return await Calendar.getEventsAsync([calendarId], windowStart, windowEnd);
  } catch (err) {
    // Some Android OEM ROMs throw EventsNotFoundException on fresh/empty calendars; do not abort sync
    console.warn('safeListEvents fallback to empty list:', formatErrorMessage(err));
    return [];
  }
}

async function createEventResilient(
  calendarId: string,
  details: DesiredCalendarEvent['details']
): Promise<string> {
  try {
    return await Calendar.createEventAsync(calendarId, details);
  } catch (firstErr) {
    // Retry without alarm method or without alarms if OEM CalendarProvider rejects Reminders insert
    if (details.alarms && details.alarms.length > 0) {
      try {
        const simplifiedAlarms = details.alarms.map((a) => ({
          relativeOffset: a.relativeOffset,
        }));
        return await Calendar.createEventAsync(calendarId, {
          ...details,
          alarms: simplifiedAlarms,
        });
      } catch {
        const { alarms: _ignored, ...withoutAlarms } = details;
        return await Calendar.createEventAsync(calendarId, withoutAlarms);
      }
    }
    throw firstErr;
  }
}

async function updateEventResilient(
  calendarId: string,
  eventId: string,
  details: DesiredCalendarEvent['details']
): Promise<{ updated: boolean }> {
  try {
    await Calendar.updateEventAsync(eventId, details);
    return { updated: true };
  } catch (updateErr) {
    // If updateEventAsync is rejected by a specific ROM, fall back cleanly to recreate
    try {
      await createEventResilient(calendarId, details);
      try {
        await Calendar.deleteEventAsync(eventId);
      } catch {
        // Ignore stale delete failure
      }
      return { updated: false };
    } catch {
      throw updateErr;
    }
  }
}

/**
 * True idempotent in-place upsert engine:
 * 1. Matches existing events by exact `[GDOU-COURSE:...]` / `[GDOU-EXAM:...]` tag.
 * 2. Updates existing events in-place via `Calendar.updateEventAsync` (zero blind delete+recreate).
 * 3. Creates only missing events sequentially (eliminates Android SQLite write contention).
 * 4. Removes only obsolete tagged events within `scopeMatcher` (never touches exams when syncing
 *    courses, never touches courses when syncing exams, never touches user's personal events).
 * 5. Automatically falls back to the primary writable system calendar if a newly created OEM
 *    dedicated calendar rejects event writes.
 */
async function upsertTaggedEvents(params: {
  initialTarget: CalendarTarget;
  fallbackTarget: CalendarTarget | null;
  desired: DesiredCalendarEvent[];
  windowStart: Date;
  windowEnd: Date;
  scopeMatcher: (tag: string) => boolean;
  deleteObsolete: boolean;
}): Promise<{
  target: CalendarTarget;
  eventsCreated: number;
  eventsUpdated: number;
  eventsRemoved: number;
  failed: number;
  firstError?: string;
}> {
  let activeTarget = params.initialTarget;
  let fallback = params.fallbackTarget;

  const loadExistingByTag = async (calId: string): Promise<Map<string, SystemEvent[]>> => {
    const existing = await safeListEvents(calId, params.windowStart, params.windowEnd);
    const map = new Map<string, SystemEvent[]>();
    for (const ev of existing) {
      const tag = extractGdouTag(ev.notes);
      if (!tag || !params.scopeMatcher(tag)) continue;
      const list = map.get(tag) ?? [];
      list.push(ev);
      map.set(tag, list);
    }
    return map;
  };

  let existingByTag = await loadExistingByTag(activeTarget.calendarId);
  const desiredTags = new Set(params.desired.map((d) => d.tag));

  let eventsCreated = 0;
  let eventsUpdated = 0;
  let eventsRemoved = 0;
  let failed = 0;
  let firstError: string | undefined;

  for (let i = 0; i < params.desired.length; i++) {
    const item = params.desired[i];
    const matched = existingByTag.get(item.tag);

    try {
      if (matched && matched.length > 0) {
        const res = await updateEventResilient(
          activeTarget.calendarId,
          matched[0].id,
          item.details
        );
        if (res.updated) eventsUpdated++;
        else eventsCreated++;

        // Remove any legacy duplicate events with the exact same tag
        for (let dup = 1; dup < matched.length; dup++) {
          try {
            await Calendar.deleteEventAsync(matched[dup].id);
            eventsRemoved++;
          } catch {
            // Non-fatal cleanup
          }
        }
      } else {
        await createEventResilient(activeTarget.calendarId, item.details);
        eventsCreated++;
      }
    } catch (err) {
      // Auto-fallback if dedicated OEM calendar accepted creation but refuses event insertion
      if (
        eventsCreated === 0 &&
        eventsUpdated === 0 &&
        activeTarget.isDedicated &&
        fallback &&
        fallback.calendarId !== activeTarget.calendarId
      ) {
        console.warn(
          `Write to dedicated calendar failed (${formatErrorMessage(err)}); switching to fallback calendar "${fallback.calendarTitle}"`
        );
        activeTarget = fallback;
        fallback = null;
        existingByTag = await loadExistingByTag(activeTarget.calendarId);
        // Retry current event on fallback calendar
        i--;
        continue;
      }
      failed++;
      if (!firstError) {
        firstError = formatErrorMessage(err);
      }
    }
  }

  if (params.deleteObsolete) {
    for (const [tag, events] of existingByTag.entries()) {
      if (desiredTags.has(tag)) continue;
      for (const ev of events) {
        try {
          await Calendar.deleteEventAsync(ev.id);
          eventsRemoved++;
        } catch {
          // Non-fatal obsolete cleanup
        }
      }
    }
  }

  return {
    target: activeTarget,
    eventsCreated,
    eventsUpdated,
    eventsRemoved,
    failed,
    firstError,
  };
}

function buildReminderAlarms(offsetsMinutes: number[]): Calendar.Alarm[] {
  return offsetsMinutes.map((relativeOffset) =>
    Platform.OS === 'android'
      ? { relativeOffset, method: Calendar.AlarmMethod.ALERT }
      : { relativeOffset }
  );
}

/**
 * Idempotent semester course sync:
 * Updates existing `[GDOU-COURSE:...]` events in-place via `Calendar.updateEventAsync`,
 * creates missing ones, removes dropped ones, and preserves exams & personal events.
 */
export async function syncAllCoursesToCalendar(
  courses: CourseItem[],
  settings: AppSettings,
  options: { replaceExisting?: boolean; skipPastEvents?: boolean } = {}
): Promise<CalendarSyncSummary> {
  const { replaceExisting = true, skipPastEvents = false } = options;
  if (!parseLocalDateStrict(settings.termStartDate)) {
    throw new Error(`开学日期格式无效（${settings.termStartDate}），请先在「关于设置」中修正`);
  }

  const { target, fallback } = await ensureGdouCalendarTarget();
  const periods = getActivePeriods(settings);
  const nowMs = Date.now();
  const reminderOffset = -Math.abs(settings.defaultCalendarReminderMinutes || 15);
  const alarms = buildReminderAlarms([reminderOffset]);

  let skippedPast = 0;
  let skippedUnparsed = 0;
  const desired: DesiredCalendarEvent[] = [];

  for (const course of courses) {
    if (!isCourseSchedulable(course)) {
      skippedUnparsed++;
      continue;
    }
    const occurrences = getCourseOccurrences(course, settings.termStartDate, periods);
    for (const occ of occurrences) {
      if (skipPastEvents && occ.end.getTime() < nowMs) {
        skippedPast++;
        continue;
      }
      const tag = `${COURSE_TAG_PREFIX}${course.id}:w${occ.week}]`;
      desired.push({
        tag,
        details: {
          title: course.name,
          location: [course.campus, course.location].filter(Boolean).join(' · '),
          notes: `授课教师：${course.teacher}\n节次：第 ${course.startSection}-${course.endSection} 节\n周次：第 ${occ.week} 周（${course.weekText}）${
            course.credit ? `\n学分：${course.credit}` : ''
          }\n${tag}`,
          startDate: occ.start,
          endDate: occ.end,
          timeZone: 'Asia/Shanghai',
          alarms,
        },
      });
    }
  }

  const { start, end } = getSemesterWindow(settings.termStartDate, settings.totalWeeks);
  const result = await upsertTaggedEvents({
    initialTarget: target,
    fallbackTarget: fallback,
    desired,
    windowStart: start,
    windowEnd: end,
    scopeMatcher: (tag) => tag.startsWith(COURSE_TAG_PREFIX),
    deleteObsolete: replaceExisting,
  });

  if (desired.length > 0 && result.eventsCreated === 0 && result.eventsUpdated === 0) {
    throw new Error(
      `写入系统日历失败（目标日历：${result.target.calendarTitle}）：${
        result.firstError || '请检查系统日历账户状态与权限'
      }`
    );
  }

  return {
    calendarId: result.target.calendarId,
    calendarTitle: result.target.calendarTitle,
    isDedicated: result.target.isDedicated,
    eventsCreated: result.eventsCreated,
    eventsUpdated: result.eventsUpdated,
    eventsReplaced: result.eventsUpdated + result.eventsRemoved,
    eventsRemoved: result.eventsRemoved,
    skippedPast,
    skippedUnparsed,
    failed: result.failed,
    firstError: result.firstError,
  };
}

/**
 * Idempotently sync a single course across all of its teaching weeks into the calendar.
 * Updates existing occurrences in-place via `Calendar.updateEventAsync`.
 */
export async function addSingleCourseToCalendar(
  course: CourseItem,
  settings: AppSettings
): Promise<CalendarSyncSummary> {
  if (!isCourseSchedulable(course)) {
    throw new Error(`《${course.name}》缺少有效星期/节次/周次信息，无法写入系统日历`);
  }
  if (!parseLocalDateStrict(settings.termStartDate)) {
    throw new Error(`开学日期格式无效（${settings.termStartDate}），请先在「关于设置」中修正`);
  }

  const { target, fallback } = await ensureGdouCalendarTarget();
  const periods = getActivePeriods(settings);
  const reminderOffset = -Math.abs(settings.defaultCalendarReminderMinutes || 15);
  const alarms = buildReminderAlarms([reminderOffset]);
  const occurrences = getCourseOccurrences(course, settings.termStartDate, periods);

  const desired: DesiredCalendarEvent[] = occurrences.map((occ) => {
    const tag = `${COURSE_TAG_PREFIX}${course.id}:w${occ.week}]`;
    return {
      tag,
      details: {
        title: course.name,
        location: [course.campus, course.location].filter(Boolean).join(' · '),
        notes: `授课教师：${course.teacher}\n节次：第 ${course.startSection}-${course.endSection} 节\n周次：第 ${occ.week} 周（${course.weekText}）\n${tag}`,
        startDate: occ.start,
        endDate: occ.end,
        timeZone: 'Asia/Shanghai',
        alarms,
      },
    };
  });

  const { start, end } = getSemesterWindow(settings.termStartDate, settings.totalWeeks);
  const coursePrefix = `${COURSE_TAG_PREFIX}${course.id}:`;
  const result = await upsertTaggedEvents({
    initialTarget: target,
    fallbackTarget: fallback,
    desired,
    windowStart: start,
    windowEnd: end,
    scopeMatcher: (tag) => tag.startsWith(coursePrefix),
    deleteObsolete: true,
  });

  if (desired.length > 0 && result.eventsCreated === 0 && result.eventsUpdated === 0) {
    throw new Error(
      `写入课程日程失败（目标日历：${result.target.calendarTitle}）：${
        result.firstError || '请检查系统日历权限'
      }`
    );
  }

  return {
    calendarId: result.target.calendarId,
    calendarTitle: result.target.calendarTitle,
    isDedicated: result.target.isDedicated,
    eventsCreated: result.eventsCreated,
    eventsUpdated: result.eventsUpdated,
    eventsReplaced: result.eventsUpdated + result.eventsRemoved,
    eventsRemoved: result.eventsRemoved,
    skippedPast: 0,
    skippedUnparsed: 0,
    failed: result.failed,
    firstError: result.firstError,
  };
}

/**
 * Idempotently sync one or multiple exams into the calendar with dual reminders
 * (24 hours before + 60 minutes before), updating existing `[GDOU-EXAM:<id>]` events in-place.
 */
export async function syncExamsToCalendar(exams: ExamItem[]): Promise<CalendarSyncSummary> {
  const { target, fallback } = await ensureGdouCalendarTarget();
  const validExams = exams.filter((e) => Boolean(e.startIso));
  const skippedPast = exams.length - validExams.length;

  if (validExams.length === 0) {
    return {
      calendarId: target.calendarId,
      calendarTitle: target.calendarTitle,
      isDedicated: target.isDedicated,
      eventsCreated: 0,
      eventsUpdated: 0,
      eventsReplaced: 0,
      eventsRemoved: 0,
      skippedPast,
      skippedUnparsed: 0,
      failed: 0,
    };
  }

  const alarms = buildReminderAlarms([-24 * 60, -60]);
  const desired: DesiredCalendarEvent[] = validExams.map((exam) => {
    const startDate = parseExamIsoLocal(exam.startIso!);
    const endDate = exam.endIso
      ? parseExamIsoLocal(exam.endIso)
      : new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
    const seatTag = exam.seatNumber ? ` · 座位 ${exam.seatNumber}` : '';
    const tag = `${EXAM_TAG_PREFIX}${exam.id}]`;

    return {
      tag,
      details: {
        title: `【${exam.examType || '考试'}】${exam.courseName}`,
        location: `${[exam.campus, exam.location].filter(Boolean).join(' ')}${seatTag}`,
        notes: `课程代码：${exam.courseCode || '-'}\n考场地点：${exam.location}\n座位号：${
          exam.seatNumber || '待公布'
        }\n时间：${exam.rawTimeText}${
          exam.invigilator ? `\n监考/任课：${exam.invigilator}` : ''
        }\n${tag}`,
        startDate,
        endDate,
        timeZone: 'Asia/Shanghai',
        alarms,
      },
    };
  });

  const timestamps = validExams.map((e) => parseExamIsoLocal(e.startIso!).getTime());
  const windowStart = new Date(Math.min(...timestamps) - 14 * 24 * 3600 * 1000);
  const windowEnd = new Date(Math.max(...timestamps) + 14 * 24 * 3600 * 1000);
  const examTags = new Set(desired.map((d) => d.tag));

  const result = await upsertTaggedEvents({
    initialTarget: target,
    fallbackTarget: fallback,
    desired,
    windowStart,
    windowEnd,
    scopeMatcher: (tag) => examTags.has(tag),
    deleteObsolete: false,
  });

  if (desired.length > 0 && result.eventsCreated === 0 && result.eventsUpdated === 0) {
    throw new Error(
      `写入考试日程失败（目标日历：${result.target.calendarTitle}）：${
        result.firstError || '请检查系统日历权限'
      }`
    );
  }

  return {
    calendarId: result.target.calendarId,
    calendarTitle: result.target.calendarTitle,
    isDedicated: result.target.isDedicated,
    eventsCreated: result.eventsCreated,
    eventsUpdated: result.eventsUpdated,
    eventsReplaced: result.eventsUpdated + result.eventsRemoved,
    eventsRemoved: result.eventsRemoved,
    skippedPast,
    skippedUnparsed: 0,
    failed: result.failed,
    firstError: result.firstError,
  };
}
