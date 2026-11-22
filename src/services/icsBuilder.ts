import { getActivePeriods } from '../constants/gdouTimetable';
import { AppSettings, CourseItem, ExamItem } from '../types/models';
import { parseExamIsoLocal } from './examParser';
import { getCourseOccurrences } from './scheduleParser';

function formatIcsLocalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * Pure RFC 5545 iCalendar (.ics) generator containing courses and exams with VALARM alerts.
 */
export function buildGdouIcsContent(
  courses: CourseItem[],
  exams: ExamItem[],
  settings: AppSettings,
  termLabel: string
): string {
  const periods = getActivePeriods(settings);
  const dtStamp = formatIcsLocalDate(new Date());
  const reminderMin = Math.max(5, settings.defaultCalendarReminderMinutes || 15);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GDOU Schedule//Guangdong Ocean University//CN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcsText(`广海课表 - ${termLabel}`)}`,
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

  let seq = 1;

  for (const course of courses) {
    const occurrences = getCourseOccurrences(course, settings.termStartDate, periods);
    for (const occ of occurrences) {
      const uid = `gdou-course-${seq++}-${occ.week}@schedule.gdou.edu.cn`;
      const location = [course.campus, course.location].filter(Boolean).join(' ');
      const desc = `教师: ${course.teacher} | 第${course.startSection}-${course.endSection}节 | 第${occ.week}周 (${course.weekText})`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART;TZID=Asia/Shanghai:${formatIcsLocalDate(occ.start)}`,
        `DTEND;TZID=Asia/Shanghai:${formatIcsLocalDate(occ.end)}`,
        `SUMMARY:${escapeIcsText(course.name)}`,
        `LOCATION:${escapeIcsText(location)}`,
        `DESCRIPTION:${escapeIcsText(desc)}`,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeIcsText(`${course.name} 即将上课 (${location})`)}`,
        `TRIGGER:-PT${reminderMin}M`,
        'END:VALARM',
        'END:VEVENT'
      );
    }
  }

  for (const exam of exams) {
    if (!exam.startIso) continue;
    const start = parseExamIsoLocal(exam.startIso);
    const end = exam.endIso
      ? parseExamIsoLocal(exam.endIso)
      : new Date(start.getTime() + 2 * 3600 * 1000);
    const uid = `gdou-exam-${seq++}@schedule.gdou.edu.cn`;
    const location = `${[exam.campus, exam.location].filter(Boolean).join(' ')}${
      exam.seatNumber ? ` 座位${exam.seatNumber}` : ''
    }`;
    const desc = `考试性质: ${exam.examType} | 座位号: ${exam.seatNumber || '待公布'} | ${exam.rawTimeText}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;TZID=Asia/Shanghai:${formatIcsLocalDate(start)}`,
      `DTEND;TZID=Asia/Shanghai:${formatIcsLocalDate(end)}`,
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

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
