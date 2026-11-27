import { AppSettings, CourseItem, ExamItem } from '../types/models';
import { getEffectiveCourseWallClockOccurrences } from './academicCalendar';

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatIcsUtcStamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

function formatWallClockParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
): string {
  return `${year}${pad2(month)}${pad2(day)}T${pad2(hour)}${pad2(minute)}${pad2(second)}`;
}

function escapeIcsText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function sanitizeUidSegment(raw: string): string {
  const ascii = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  if (ascii.length > 0) return ascii.slice(0, 48);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return `h${hash.toString(16)}`;
}

function utf8CodePointByteLength(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * RFC 5545 Section 3.1 content line folding:
 * folds lines strictly at <= 75 UTF-8 octets without splitting multi-byte UTF-8 characters.
 */
export function foldIcsLine(line: string, maxOctets = 75): string {
  const segments: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0;
    const chBytes = utf8CodePointByteLength(cp);
    const limit = segments.length === 0 ? maxOctets : maxOctets - 1; // continuation starts with 1-byte space
    if (currentBytes + chBytes > limit && current.length > 0) {
      segments.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current.length > 0 || segments.length === 0) {
    segments.push(current);
  }
  return segments.join('\r\n ');
}

function parseIsoWallClock(iso: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10),
    day: parseInt(m[3], 10),
    hour: parseInt(m[4], 10),
    minute: parseInt(m[5], 10),
  };
}

function addMinutesWallClock(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  deltaMinutes: number
): { year: number; month: number; day: number; hour: number; minute: number } {
  const utc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute + deltaMinutes, 0)
  );
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: utc.getUTCHours(),
    minute: utc.getUTCMinutes(),
  };
}

/**
 * RFC 5545 compliant iCalendar (.ics) generator containing courses and exams with VALARM alerts:
 * - UTC DTSTAMP with trailing Z
 * - Explicit Asia/Shanghai wall-clock timestamps independent of host device timezone
 * - Stable deterministic UIDs (re-importing updates existing events instead of duplicating)
 * - Strict 75-octet UTF-8-boundary line folding
 */
export function buildGdouIcsContent(
  courses: CourseItem[],
  exams: ExamItem[],
  settings: AppSettings,
  termLabel: string,
  now: Date = new Date()
): string {
  const dtStamp = formatIcsUtcStamp(now);
  const reminderMin = Math.max(5, settings.defaultCalendarReminderMinutes || 15);
  const safeTermStart = sanitizeUidSegment(settings.termStartDate);

  const rawLines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GDOU Schedule//Guangdong Ocean University//CN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcsText(`海大课表 - ${termLabel}`)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  for (const course of courses) {
    const occurrences = getEffectiveCourseWallClockOccurrences(course, settings);
    const courseKey = sanitizeUidSegment(course.id || `${course.name}-${course.dayOfWeek}-${course.startSection}`);
    const effectiveRoom = course.customLocation?.trim() || course.location;
    for (const occ of occurrences) {
      const occKey = occ.isMakeup ? `m${sanitizeUidSegment(occ.dateStr)}` : `w${occ.week}`;
      const uid = `gdou-course-${courseKey}-${occKey}-${safeTermStart}@schedule.gdou.edu.cn`;
      const location = [course.campus, effectiveRoom].filter(Boolean).join(' ');
      const makeupSuffix = occ.isMakeup && occ.overrideLabel ? ` | 调休: ${occ.overrideLabel}` : '';
      const noteSuffix = course.customNote?.trim() ? ` | 备注: ${course.customNote.trim()}` : '';
      const desc = `教师: ${course.teacher} | 第${course.startSection}-${course.endSection}节 | 第${occ.effectiveWeek}周 (${course.weekText})${makeupSuffix}${noteSuffix}`;
      const summary = occ.isMakeup ? `[调休] ${course.name}` : course.name;
      rawLines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART;TZID=Asia/Shanghai:${formatWallClockParts(occ.year, occ.month, occ.day, occ.startHour, occ.startMinute)}`,
        `DTEND;TZID=Asia/Shanghai:${formatWallClockParts(occ.year, occ.month, occ.day, occ.endHour, occ.endMinute)}`,
        `SUMMARY:${escapeIcsText(summary)}`,
        `LOCATION:${escapeIcsText(location)}`,
        `DESCRIPTION:${escapeIcsText(desc)}`,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeIcsText(`${summary} 即将上课 (${location})`)}`,
        `TRIGGER:-PT${reminderMin}M`,
        'END:VALARM',
        'END:VEVENT'
      );
    }
  }

  for (const exam of exams) {
    if (!exam.startIso) continue;
    const startParts = parseIsoWallClock(exam.startIso);
    if (!startParts) continue;
    const endParts =
      (exam.endIso ? parseIsoWallClock(exam.endIso) : null) ??
      addMinutesWallClock(startParts, 120);

    const examKey = sanitizeUidSegment(exam.id || `${exam.courseName}-${exam.dateText}`);
    const uid = `gdou-exam-${examKey}-${sanitizeUidSegment(exam.dateText || 'tbd')}@schedule.gdou.edu.cn`;
    const location = `${[exam.campus, exam.location].filter(Boolean).join(' ')}${
      exam.seatNumber ? ` 座位${exam.seatNumber}` : ''
    }`;
    const desc = `考试性质: ${exam.examType} | 座位号: ${exam.seatNumber || '待公布'} | ${exam.rawTimeText}`;
    rawLines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;TZID=Asia/Shanghai:${formatWallClockParts(startParts.year, startParts.month, startParts.day, startParts.hour, startParts.minute)}`,
      `DTEND;TZID=Asia/Shanghai:${formatWallClockParts(endParts.year, endParts.month, endParts.day, endParts.hour, endParts.minute)}`,
      `SUMMARY:${escapeIcsText(`【${exam.examType}】${exam.courseName}`)}`,
      `LOCATION:${escapeIcsText(location)}`,
      `DESCRIPTION:${escapeIcsText(desc)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(`明日考试：${exam.courseName} (${location})`)}`,
      'TRIGGER:-P1D',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(`考试即将开始：${exam.courseName} (${location})`)}`,
      'TRIGGER:-PT60M',
      'END:VALARM',
      'END:VEVENT'
    );
  }

  rawLines.push('END:VCALENDAR');
  return rawLines.map((line) => foldIcsLine(line)).join('\r\n');
}
