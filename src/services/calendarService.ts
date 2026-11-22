import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import { getActivePeriods } from '../constants/gdouTimetable';
import { AppSettings, CourseItem, ExamItem } from '../types/models';
import { parseExamIsoLocal } from './examParser';
import { getCourseOccurrences } from './scheduleParser';

const GDOU_CALENDAR_TITLE = '广海课表 (GDOU)';
const GDOU_CALENDAR_NAME = 'gdou_schedule_calendar';

export interface CalendarSyncSummary {
  calendarId: string;
  eventsCreated: number;
  skippedPast: number;
}

async function ensureCalendarPermissions(): Promise<void> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== 'granted') {
    throw new Error('未获得系统日历权限，请在手机“设置 -> 广海课表”中允许访问日历');
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
 * Find or create the dedicated "广海课表 (GDOU)" calendar so schedule exports
 * never pollute the user's personal calendar and can be cleanly updated or deleted.
 */
export async function ensureGdouCalendar(): Promise<string> {
  await ensureCalendarPermissions();
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const existing = calendars.find(
    (c) => c.title === GDOU_CALENDAR_TITLE || c.name === GDOU_CALENDAR_NAME
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
 * Remove the dedicated GDOU calendar completely (clean reset).
 */
export async function deleteGdouCalendar(): Promise<boolean> {
  await ensureCalendarPermissions();
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const existing = calendars.find(
    (c) => c.title === GDOU_CALENDAR_TITLE || c.name === GDOU_CALENDAR_NAME
  );
  if (!existing) return false;
  await Calendar.deleteCalendarAsync(existing.id);
  return true;
}

/**
 * Batch sync an entire semester's courses to the native iOS/Android system calendar.
 * Optionally recreates the dedicated calendar first to avoid duplicate entries.
 */
export async function syncAllCoursesToCalendar(
  courses: CourseItem[],
  settings: AppSettings,
  options: { replaceExisting?: boolean; skipPastEvents?: boolean } = {}
): Promise<CalendarSyncSummary> {
  const { replaceExisting = true, skipPastEvents = false } = options;
  await ensureCalendarPermissions();

  if (replaceExisting) {
    await deleteGdouCalendar();
  }
  const calendarId = await ensureGdouCalendar();
  const periods = getActivePeriods(settings);
  const nowMs = Date.now();
  const reminderOffset = -Math.abs(settings.defaultCalendarReminderMinutes || 15);

  let eventsCreated = 0;
  let skippedPast = 0;

  for (const course of courses) {
    const occurrences = getCourseOccurrences(course, settings.termStartDate, periods);
    for (const occ of occurrences) {
      if (skipPastEvents && occ.end.getTime() < nowMs) {
        skippedPast++;
        continue;
      }
      await Calendar.createEventAsync(calendarId, {
        title: course.name,
        location: [course.campus, course.location].filter(Boolean).join(' · '),
        notes: `授课教师：${course.teacher}\n节次：第 ${course.startSection}-${course.endSection} 节\n周次：第 ${occ.week} 周（${course.weekText}）${
          course.credit ? `\n学分：${course.credit}` : ''
        }`,
        startDate: occ.start,
        endDate: occ.end,
        timeZone: 'Asia/Shanghai',
        alarms: [{ relativeOffset: reminderOffset }],
      });
      eventsCreated++;
    }
  }

  return { calendarId, eventsCreated, skippedPast };
}

/**
 * Add a single course across all of its teaching weeks into the GDOU calendar.
 */
export async function addSingleCourseToCalendar(
  course: CourseItem,
  settings: AppSettings
): Promise<CalendarSyncSummary> {
  const calendarId = await ensureGdouCalendar();
  const periods = getActivePeriods(settings);
  const reminderOffset = -Math.abs(settings.defaultCalendarReminderMinutes || 15);
  const occurrences = getCourseOccurrences(course, settings.termStartDate, periods);

  let eventsCreated = 0;
  for (const occ of occurrences) {
    await Calendar.createEventAsync(calendarId, {
      title: course.name,
      location: [course.campus, course.location].filter(Boolean).join(' · '),
      notes: `授课教师：${course.teacher}\n节次：第 ${course.startSection}-${course.endSection} 节\n周次：第 ${occ.week} 周（${course.weekText}）`,
      startDate: occ.start,
      endDate: occ.end,
      timeZone: 'Asia/Shanghai',
      alarms: [{ relativeOffset: reminderOffset }],
    });
    eventsCreated++;
  }

  return { calendarId, eventsCreated, skippedPast: 0 };
}

/**
 * Sync one or multiple exams into the native system calendar with dual reminders
 * (24 hours before + 60 minutes before).
 */
export async function syncExamsToCalendar(exams: ExamItem[]): Promise<CalendarSyncSummary> {
  const calendarId = await ensureGdouCalendar();
  let eventsCreated = 0;
  let skippedPast = 0;

  for (const exam of exams) {
    if (!exam.startIso) {
      skippedPast++;
      continue;
    }
    const startDate = parseExamIsoLocal(exam.startIso);
    const endDate = exam.endIso
      ? parseExamIsoLocal(exam.endIso)
      : new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

    const seatTag = exam.seatNumber ? ` · 座位 ${exam.seatNumber}` : '';
    await Calendar.createEventAsync(calendarId, {
      title: `【${exam.examType || '考试'}】${exam.courseName}`,
      location: `${[exam.campus, exam.location].filter(Boolean).join(' ')}${seatTag}`,
      notes: `课程代码：${exam.courseCode || '-'}\n考场地点：${exam.location}\n座位号：${
        exam.seatNumber || '待公布'
      }\n时间：${exam.rawTimeText}${exam.invigilator ? `\n监考/任课：${exam.invigilator}` : ''}`,
      startDate,
      endDate,
      timeZone: 'Asia/Shanghai',
      alarms: [{ relativeOffset: -24 * 60 }, { relativeOffset: -60 }],
    });
    eventsCreated++;
  }

  return { calendarId, eventsCreated, skippedPast };
}
