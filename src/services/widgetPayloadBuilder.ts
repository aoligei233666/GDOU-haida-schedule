import { DAY_FULL_LABELS, getActivePeriods } from '../constants/gdouTimetable';
import { AppSettings, CourseItem, ExamItem } from '../types/models';
import {
  buildTodayLiveSnapshot,
  getCoursesForDate,
  TodayClassLiveItem,
} from './academicCalendar';
import { getCourseTimeSpan } from './scheduleParser';
import { sanitizeForZeroRetention } from './zeroRetentionSanitizer';

export interface NativeWidgetCourseRow {
  name: string;
  location: string;
  time: string;
  sectionText: string;
  status: TodayClassLiveItem['status'];
  startMin: number;
  endMin: number;
}

export interface NativeWidgetDaySnapshot {
  dateStr: string;
  week: number;
  weekdayLabel: string;
  overrideBadge: string | null;
  isHoliday: boolean;
  holidayLabel: string;
  items: NativeWidgetCourseRow[];
}

export interface NativeWidgetPayload {
  updatedAtIso: string;
  termLabel: string;
  totalCourseCount: number;
  dateStr: string;
  week: number;
  weekdayLabel: string;
  overrideBadge: string | null;
  state: 'ongoing' | 'upcoming' | 'holiday' | 'done' | 'empty';
  headline: string;
  subline: string;
  activeCourseName: string;
  activeCourseRoom: string;
  activeCourseTime: string;
  minutesDelta: number;
  todayItems: NativeWidgetCourseRow[];
  upcomingDays: NativeWidgetDaySnapshot[];
  nextClassDayLabel: string;
  nextClassDayItems: NativeWidgetCourseRow[];
  nextExamTitle: string;
  nextExamCountdown: string;
}

function hhmmToMinutesSafe(hhmm: string): number {
  const [hRaw, mRaw] = String(hhmm || '').split(':');
  const h = parseInt(hRaw || '0', 10);
  const m = parseInt(mRaw || '0', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

function buildDayCourseRows(
  dayCourses: CourseItem[],
  settings: AppSettings,
  nowMinutes: number | null
): NativeWidgetCourseRow[] {
  const periods = getActivePeriods(settings);
  return dayCourses.slice(0, 6).map((c) => {
    const { startText, endText } = getCourseTimeSpan(c, periods);
    const startMin = hhmmToMinutesSafe(startText);
    const endMin = hhmmToMinutesSafe(endText);
    const status: TodayClassLiveItem['status'] =
      nowMinutes === null
        ? 'upcoming'
        : nowMinutes >= endMin
          ? 'finished'
          : nowMinutes >= startMin
            ? 'ongoing'
            : 'upcoming';
    return {
      name: String(c.name || '').trim() || '未命名课程',
      location: String(c.location || '').trim() || '待定教室',
      time: `${startText}-${endText}`,
      sectionText: `${c.startSection}-${c.endSection}节`,
      status,
      startMin,
      endMin,
    };
  });
}

function formatFutureDayLabel(
  offsetDays: number,
  date: Date,
  weekdayLabel: string,
  overrideBadge: string | null
): string {
  const base =
    offsetDays === 1
      ? `明天 ${weekdayLabel}`
      : offsetDays === 2
        ? `后天 ${weekdayLabel}`
        : `${date.getMonth() + 1}月${date.getDate()}日 ${weekdayLabel}`;
  return overrideBadge ? `${base}(${overrideBadge})` : base;
}

export function buildNativeWidgetPayload(
  courses: CourseItem[],
  exams: ExamItem[],
  settings: AppSettings,
  termLabel: string,
  now: Date = new Date()
): NativeWidgetPayload {
  const snap = buildTodayLiveSnapshot(courses, settings, now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const upcomingExam = exams
    .map((e) => ({ e, ts: e.dateText ? Date.parse(`${e.dateText}T00:00:00`) : NaN }))
    .filter((x) => Number.isFinite(x.ts) && x.ts >= todayStart)
    .sort((a, b) => a.ts - b.ts)[0];

  const nextExamTitle = upcomingExam ? String(upcomingExam.e.courseName || '').trim() : '';
  const nextExamCountdown = upcomingExam
    ? (() => {
        const d = Math.max(0, Math.round((upcomingExam.ts - todayStart) / 86_400_000));
        return d === 0 ? '今天考试' : `还有 ${d} 天`;
      })()
    : '';

  // Build rolling 7-day snapshots so iOS WidgetKit & Android AppWidget can roll over
  // past midnight and recalculate live ongoing/upcoming classes even before the app is reopened.
  const upcomingDays: NativeWidgetDaySnapshot[] = [];
  let nextClassDayLabel = '';
  let nextClassDayItems: NativeWidgetCourseRow[] = [];

  for (let offset = 0; offset < 14; offset += 1) {
    const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const { resolved, courses: dayCourses } = getCoursesForDate(courses, targetDate, settings);
    const weekdayLabel =
      DAY_FULL_LABELS[resolved.naturalDayOfWeek - 1] ?? `周${resolved.naturalDayOfWeek}`;
    const rows = buildDayCourseRows(dayCourses, settings, offset === 0 ? nowMinutes : null);
    if (offset < 7) {
      upcomingDays.push({
        dateStr: resolved.dateStr,
        week: Math.max(1, resolved.effectiveWeek),
        weekdayLabel,
        overrideBadge: resolved.badgeText,
        isHoliday: resolved.isHoliday,
        holidayLabel: resolved.override?.label || '',
        items: rows,
      });
    }
    if (offset >= 1 && nextClassDayItems.length === 0 && rows.length > 0) {
      nextClassDayLabel = formatFutureDayLabel(
        offset,
        targetDate,
        weekdayLabel,
        resolved.badgeText
      );
      nextClassDayItems = rows;
    }
  }

  const todayRows =
    upcomingDays[0]?.items ??
    snap.items.slice(0, 6).map((it) => ({
      name: String(it.name || '').trim() || '未命名课程',
      location: String(it.location || '').trim() || '待定教室',
      time: `${it.startTime}-${it.endTime}`,
      sectionText: `${it.startSection}-${it.endSection}节`,
      status: it.status,
      startMin: hhmmToMinutesSafe(it.startTime),
      endMin: hhmmToMinutesSafe(it.endTime),
    }));

  const hasAnyCourses = courses.length > 0;
  let headline = snap.headline;
  let subline = snap.subline;
  if (!hasAnyCourses) {
    headline = '尚未同步课表';
    subline = '点击打开海大课表，一步登录教务同步课程';
  } else if ((snap.state === 'empty' || snap.state === 'holiday') && nextClassDayItems.length > 0) {
    subline =
      snap.state === 'holiday'
        ? `假期停课 · 下个上课日 ${nextClassDayLabel}（共 ${nextClassDayItems.length} 节）`
        : `下个上课日：${nextClassDayLabel}（共 ${nextClassDayItems.length} 节）`;
  } else if (snap.state === 'done' && nextClassDayItems.length > 0) {
    const firstNext = nextClassDayItems[0];
    subline = `下个上课日 ${nextClassDayLabel} · ${firstNext.time} ${firstNext.name}`;
  }

  return sanitizeForZeroRetention({
    updatedAtIso: now.toISOString(),
    termLabel: String(termLabel || '海大课表'),
    totalCourseCount: courses.length,
    dateStr: snap.dateStr,
    week: snap.week,
    weekdayLabel: snap.weekdayLabel,
    overrideBadge: snap.overrideBadge,
    state: snap.state,
    headline,
    subline,
    activeCourseName: String(snap.activeCourse?.name || headline),
    activeCourseRoom: String(snap.activeCourse?.location || '').trim(),
    activeCourseTime: snap.activeCourse
      ? `${snap.activeCourse.startTime}-${snap.activeCourse.endTime}`
      : '',
    minutesDelta: snap.minutesDelta ?? 0,
    todayItems: todayRows,
    upcomingDays,
    nextClassDayLabel,
    nextClassDayItems,
    nextExamTitle,
    nextExamCountdown,
  });
}
