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
const COURSE_TAG_PREFIX = '[GDOU-COURSE:';
const EXAM_TAG_PREFIX = '[GDOU-EXAM:';

export interface CalendarSyncSummary {
  calendarId: string;
  eventsCreated: number;
  eventsReplaced: number;
  skippedPast: number;
  skippedUnparsed: number;
  failed: number;
}

async function ensureCalendarPermissions(): Promise<void> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('未获得系统日历权限，请在手机“设置 -> 海大课表”中允许访问日历');
  }
}

async function getDefaultIosSource(): Promise<Calendar.Source> {
  try {
    const defaultCal = await Calendar.getDefaultCalendarAsync();
    if (defaultCal?.source) return defaultCal.source;
  } catch {
    // Fallback to searching existing writable calendars
  }
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const icloud = calendars.find((c) => c.source?.type === Calendar.SourceType.CALDAV);
  if (icloud?.source) return icloud.source;
  const local = calendars.find((c) => c.source?.type === Calendar.SourceType.LOCAL);
  if (local?.source) return local.source;
  if (calendars[0]?.source) return calendars[0].source;
  throw new Error('未找到可用的 iOS 日历账户，请先在系统“日历”应用中启用本地或 iCloud 日历');
}

/**
 * Find or create the dedicated "海大课表 (GDOU)" calendar so schedule exports
 * never pollute the user's personal calendar and can be cleanly updated or deleted.
 */
export async function ensureGdouCalendar(): Promise<string> {
  await ensureCalendarPermissions();
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const existing = calendars.find(
    (c) =>
      c.name === GDOU_CALENDAR_NAME ||
      c.title === GDOU_CALENDAR_TITLE ||
      c.title === '广海课表 (GDOU)'
  );
  if (existing) {
    return existing.id;
  }

  if (Platform.OS === 'ios') {
    const source = await getDefaultIosSource();
    return Calendar.createCalendarAsync({
      title: GDOU_CALENDAR_TITLE,
      color: '#0284C7',
      entityType: Calendar.EntityTypes.EVENT,
      sourceId: source.id,
      source,
      name: GDOU_CALENDAR_NAME,
      ownerAccount: 'personal',
      accessLevel: Calendar.CalendarAccessLevel.OWNER,
    });
  }

  return Calendar.createCalendarAsync({
    title: GDOU_CALENDAR_TITLE,
    color: '#0284C7',
    entityType: Calendar.EntityTypes.EVENT,
    source: {
      isLocalAccount: true,
      name: GDOU_CALENDAR_TITLE,
      type: Calendar.SourceType.LOCAL,
    },
    name: GDOU_CALENDAR_NAME,
    ownerAccount: 'gdou-schedule-local',
    accessLevel: Calendar.CalendarAccessLevel.OWNER,
  });
}

/**
 * Remove the dedicated GDOU calendar completely (explicit user reset only).
 */
export async function deleteGdouCalendar(): Promise<boolean> {
  await ensureCalendarPermissions();
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const existing = calendars.find(
    (c) =>
      c.name === GDOU_CALENDAR_NAME ||
      c.title === GDOU_CALENDAR_TITLE ||
      c.title === '广海课表 (GDOU)'
  );
  if (!existing) return false;
  await Calendar.deleteCalendarAsync(existing.id);
  return true;
}

/**
 * Delete only events whose notes contain one of the specified GDOU tags within the search window.
 * Preserves exams when syncing courses and preserves courses when syncing exams.
 */
async function deleteTaggedEventsInWindow(
  calendarId: string,
  matcher: (notes: string) => boolean,
  windowStart: Date,
  windowEnd: Date
): Promise<number> {
  const existing = await Calendar.getEventsAsync([calendarId], windowStart, windowEnd);
  const targets = existing.filter((ev) => matcher(String(ev.notes ?? '')));
  if (targets.length === 0) return 0;

  const settled = await Promise.allSettled(
    targets.map((ev) => Calendar.deleteEventAsync(ev.id))
  );
  return settled.filter((r) => r.status === 'fulfilled').length;
}

function getSemesterWindow(termStartDate: string, totalWeeks: number): { start: Date; end: Date } {
  const parsed = parseLocalDateStrict(termStartDate);
  const anchor = parsed ?? new Date();
  const start = new Date(anchor.getTime() - 14 * 24 * 3600 * 1000);
  const end = new Date(anchor.getTime() + (Math.max(20, totalWeeks) + 12) * 7 * 24 * 3600 * 1000);
  return { start, end };
}

/**
 * Idempotent semester course sync:
 * Replaces ONLY course-tagged events (`[GDOU-COURSE:...`) inside the dedicated calendar,
 * never deleting previously synced exam events (`[GDOU-EXAM:...`).
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

  const calendarId = await ensureGdouCalendar();
  const periods = getActivePeriods(settings);
  const nowMs = Date.now();
  const reminderOffset = -Math.abs(settings.defaultCalendarReminderMinutes || 15);

  let eventsReplaced = 0;
  if (replaceExisting) {
    const { start, end } = getSemesterWindow(settings.termStartDate, settings.totalWeeks);
    eventsReplaced = await deleteTaggedEventsInWindow(
      calendarId,
      (notes) => notes.includes(COURSE_TAG_PREFIX),
      start,
      end
    );
  }

  let eventsCreated = 0;
  let skippedPast = 0;
  let skippedUnparsed = 0;
  let failed = 0;

  const pendingOps: (() => Promise<string>)[] = [];

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
      pendingOps.push(() =>
        Calendar.createEventAsync(calendarId, {
          title: course.name,
          location: [course.campus, course.location].filter(Boolean).join(' · '),
          notes: `授课教师：${course.teacher}\n节次：第 ${course.startSection}-${course.endSection} 节\n周次：第 ${occ.week} 周（${course.weekText}）${
            course.credit ? `\n学分：${course.credit}` : ''
          }\n${tag}`,
          startDate: occ.start,
          endDate: occ.end,
          timeZone: 'Asia/Shanghai',
          alarms: [{ relativeOffset: reminderOffset }],
        })
      );
    }
  }

  // Batch in chunks of 10 to avoid overwhelming native CalendarProvider while collecting exact results
  for (let i = 0; i < pendingOps.length; i += 10) {
    const batch = pendingOps.slice(i, i + 10);
    const settled = await Promise.allSettled(batch.map((fn) => fn()));
    for (const res of settled) {
      if (res.status === 'fulfilled') eventsCreated++;
      else failed++;
    }
  }

  if (pendingOps.length > 0 && eventsCreated === 0) {
    throw new Error('写入系统日历全部失败，请检查系统日历账户状态与权限');
  }

  return { calendarId, eventsCreated, eventsReplaced, skippedPast, skippedUnparsed, failed };
}

/**
 * Idempotently sync a single course across all of its teaching weeks into the GDOU calendar.
 * Replaces any previous events belonging to the same course ID to prevent duplicates.
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

  const calendarId = await ensureGdouCalendar();
  const periods = getActivePeriods(settings);
  const reminderOffset = -Math.abs(settings.defaultCalendarReminderMinutes || 15);
  const occurrences = getCourseOccurrences(course, settings.termStartDate, periods);

  const { start, end } = getSemesterWindow(settings.termStartDate, settings.totalWeeks);
  const coursePrefix = `${COURSE_TAG_PREFIX}${course.id}:`;
  const eventsReplaced = await deleteTaggedEventsInWindow(
    calendarId,
    (notes) => notes.includes(coursePrefix),
    start,
    end
  );

  const settled = await Promise.allSettled(
    occurrences.map((occ) =>
      Calendar.createEventAsync(calendarId, {
        title: course.name,
        location: [course.campus, course.location].filter(Boolean).join(' · '),
        notes: `授课教师：${course.teacher}\n节次：第 ${course.startSection}-${course.endSection} 节\n周次：第 ${occ.week} 周（${course.weekText}）\n${COURSE_TAG_PREFIX}${course.id}:w${occ.week}]`,
        startDate: occ.start,
        endDate: occ.end,
        timeZone: 'Asia/Shanghai',
        alarms: [{ relativeOffset: reminderOffset }],
      })
    )
  );

  const eventsCreated = settled.filter((r) => r.status === 'fulfilled').length;
  const failed = settled.length - eventsCreated;
  if (settled.length > 0 && eventsCreated === 0) {
    throw new Error('写入课程日程失败，请检查系统日历权限');
  }

  return {
    calendarId,
    eventsCreated,
    eventsReplaced,
    skippedPast: 0,
    skippedUnparsed: 0,
    failed,
  };
}

/**
 * Idempotently sync one or multiple exams into the dedicated calendar with dual reminders
 * (24 hours before + 60 minutes before). Deduplicates by `[GDOU-EXAM:<exam.id>]` tag
 * without touching any course events.
 */
export async function syncExamsToCalendar(exams: ExamItem[]): Promise<CalendarSyncSummary> {
  const calendarId = await ensureGdouCalendar();
  let eventsCreated = 0;
  let eventsReplaced = 0;
  let skippedPast = 0;
  let failed = 0;

  const validExams = exams.filter((e) => Boolean(e.startIso));
  skippedPast = exams.length - validExams.length;

  if (validExams.length > 0) {
    const timestamps = validExams.map((e) => parseExamIsoLocal(e.startIso!).getTime());
    const minTs = Math.min(...timestamps) - 7 * 24 * 3600 * 1000;
    const maxTs = Math.max(...timestamps) + 7 * 24 * 3600 * 1000;
    const examTags = new Set(validExams.map((e) => `${EXAM_TAG_PREFIX}${e.id}]`));
    eventsReplaced = await deleteTaggedEventsInWindow(
      calendarId,
      (notes) => {
        for (const tag of examTags) {
          if (notes.includes(tag)) return true;
        }
        return false;
      },
      new Date(minTs),
      new Date(maxTs)
    );
  }

  const settled = await Promise.allSettled(
    validExams.map((exam) => {
      const startDate = parseExamIsoLocal(exam.startIso!);
      const endDate = exam.endIso
        ? parseExamIsoLocal(exam.endIso)
        : new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
      const seatTag = exam.seatNumber ? ` · 座位 ${exam.seatNumber}` : '';
      const marker = `${EXAM_TAG_PREFIX}${exam.id}]`;

      return Calendar.createEventAsync(calendarId, {
        title: `【${exam.examType || '考试'}】${exam.courseName}`,
        location: `${[exam.campus, exam.location].filter(Boolean).join(' ')}${seatTag}`,
        notes: `课程代码：${exam.courseCode || '-'}\n考场地点：${exam.location}\n座位号：${
          exam.seatNumber || '待公布'
        }\n时间：${exam.rawTimeText}${
          exam.invigilator ? `\n监考/任课：${exam.invigilator}` : ''
        }\n${marker}`,
        startDate,
        endDate,
        timeZone: 'Asia/Shanghai',
        alarms: [{ relativeOffset: -24 * 60 }, { relativeOffset: -60 }],
      });
    })
  );

  for (const res of settled) {
    if (res.status === 'fulfilled') eventsCreated++;
    else failed++;
  }

  if (validExams.length > 0 && eventsCreated === 0) {
    throw new Error('写入考试日程失败，请检查系统日历权限');
  }

  return {
    calendarId,
    eventsCreated,
    eventsReplaced,
    skippedPast,
    skippedUnparsed: 0,
    failed,
  };
}
