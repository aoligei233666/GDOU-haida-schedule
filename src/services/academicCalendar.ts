import { DAY_FULL_LABELS, getActivePeriods } from '../constants/gdouTimetable';
import {
  AppSettings,
  CalendarDayOverride,
  CourseItem,
  ExamItem,
} from '../types/models';
import {
  computeTermWeek,
  getCourseTimeSpan,
  isCourseSchedulable,
  parseLocalDateStrict,
} from './scheduleParser';

/**
 * Built-in 2025–2027 Chinese legal holidays & common university makeup-day presets.
 * Users can override, disable, or add GDOU-specific makeup notices anytime.
 */
export const GDOU_PRESET_CALENDAR_OVERRIDES: CalendarDayOverride[] = [
  // 2026 春季学期常用法定节假日与常见调休
  { date: '2026-04-04', kind: 'holiday', label: '清明节放假', isPreset: true },
  { date: '2026-04-05', kind: 'holiday', label: '清明节放假', isPreset: true },
  { date: '2026-04-06', kind: 'holiday', label: '清明节放假', isPreset: true },
  { date: '2026-05-01', kind: 'holiday', label: '劳动节放假', isPreset: true },
  { date: '2026-05-02', kind: 'holiday', label: '劳动节放假', isPreset: true },
  { date: '2026-05-03', kind: 'holiday', label: '劳动节放假', isPreset: true },
  { date: '2026-05-04', kind: 'holiday', label: '劳动节放假', isPreset: true },
  { date: '2026-05-05', kind: 'holiday', label: '劳动节放假', isPreset: true },
  { date: '2026-05-09', kind: 'makeup', label: '五一调休补周二课', mappedDayOfWeek: 2, isPreset: true },
  { date: '2026-06-19', kind: 'holiday', label: '端午节放假', isPreset: true },
  { date: '2026-06-20', kind: 'holiday', label: '端午节放假', isPreset: true },
  { date: '2026-06-21', kind: 'holiday', label: '端午节放假', isPreset: true },
  // 2026 秋季学期常用法定节假日与调休
  { date: '2026-09-25', kind: 'holiday', label: '中秋节放假', isPreset: true },
  { date: '2026-09-26', kind: 'holiday', label: '中秋节放假', isPreset: true },
  { date: '2026-09-27', kind: 'holiday', label: '中秋节放假', isPreset: true },
  { date: '2026-10-01', kind: 'holiday', label: '国庆节放假', isPreset: true },
  { date: '2026-10-02', kind: 'holiday', label: '国庆节放假', isPreset: true },
  { date: '2026-10-03', kind: 'holiday', label: '国庆节放假', isPreset: true },
  { date: '2026-10-04', kind: 'holiday', label: '国庆节放假', isPreset: true },
  { date: '2026-10-05', kind: 'holiday', label: '国庆节放假', isPreset: true },
  { date: '2026-10-06', kind: 'holiday', label: '国庆节放假', isPreset: true },
  { date: '2026-10-07', kind: 'holiday', label: '国庆节放假', isPreset: true },
  { date: '2026-10-10', kind: 'makeup', label: '国庆调休补周三课', mappedDayOfWeek: 3, isPreset: true },
  { date: '2026-12-12', kind: 'event', label: '全国大学英语四六级（参考）', isPreset: true },
  { date: '2027-01-01', kind: 'holiday', label: '元旦放假', isPreset: true },
  { date: '2027-01-02', kind: 'holiday', label: '元旦放假', isPreset: true },
  { date: '2027-01-03', kind: 'holiday', label: '元旦放假', isPreset: true },
];

export function formatIsoLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getEffectiveCalendarOverrides(
  userOverrides: CalendarDayOverride[] = []
): CalendarDayOverride[] {
  const byDate = new Map<string, CalendarDayOverride>();
  for (const preset of GDOU_PRESET_CALENDAR_OVERRIDES) {
    byDate.set(preset.date, preset);
  }
  for (const custom of userOverrides) {
    if (!custom || !custom.date) continue;
    // Special convention: label === '__CLEAR__' suppresses a built-in preset
    if (custom.label === '__CLEAR__') {
      byDate.delete(custom.date);
    } else {
      byDate.set(custom.date, { ...custom, isPreset: false });
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export interface ResolvedScheduleDate {
  dateStr: string;
  naturalWeek: number;
  naturalDayOfWeek: number; // 1..7
  effectiveWeek: number;
  effectiveDayOfWeek: number; // 1..7
  isHoliday: boolean;
  isMakeup: boolean;
  override: CalendarDayOverride | null;
  badgeText: string | null;
}

/**
 * Resolve any calendar date into its effective teaching week & weekday,
 * honoring GDOU holidays (classes suspended) and makeup-day weekday swaps (e.g. Sun -> Wed).
 */
export function resolveEffectiveScheduleDate(
  date: Date,
  termStartDate: string,
  totalWeeks: number,
  userOverrides: CalendarDayOverride[] = []
): ResolvedScheduleDate {
  const dateStr = formatIsoLocalDate(date);
  const rawDow = date.getDay();
  const naturalDayOfWeek = rawDow === 0 ? 7 : rawDow;
  const naturalWeek = computeTermWeek(termStartDate, date);

  const overrides = getEffectiveCalendarOverrides(userOverrides);
  const override = overrides.find((o) => o.date === dateStr) ?? null;

  if (override?.kind === 'holiday') {
    return {
      dateStr,
      naturalWeek,
      naturalDayOfWeek,
      effectiveWeek: naturalWeek,
      effectiveDayOfWeek: naturalDayOfWeek,
      isHoliday: true,
      isMakeup: false,
      override,
      badgeText: `休·${override.label.replace(/放假$/, '')}`,
    };
  }

  if (
    override?.kind === 'makeup' &&
    override.mappedDayOfWeek &&
    override.mappedDayOfWeek >= 1 &&
    override.mappedDayOfWeek <= 7
  ) {
    const mappedWeek =
      override.mappedWeek && override.mappedWeek >= 1 && override.mappedWeek <= totalWeeks
        ? override.mappedWeek
        : naturalWeek;
    const targetDayLabel = DAY_FULL_LABELS[override.mappedDayOfWeek - 1] ?? `周${override.mappedDayOfWeek}`;
    return {
      dateStr,
      naturalWeek,
      naturalDayOfWeek,
      effectiveWeek: mappedWeek,
      effectiveDayOfWeek: override.mappedDayOfWeek,
      isHoliday: false,
      isMakeup: true,
      override,
      badgeText: `调·上${targetDayLabel}`,
    };
  }

  return {
    dateStr,
    naturalWeek,
    naturalDayOfWeek,
    effectiveWeek: naturalWeek,
    effectiveDayOfWeek: naturalDayOfWeek,
    isHoliday: false,
    isMakeup: false,
    override,
    badgeText: override?.kind === 'event' ? override.label : null,
  };
}

/**
 * Return sorted courses actually taking place on a given Date, applying holiday & makeup overrides.
 */
export function getCoursesForDate(
  courses: CourseItem[],
  date: Date,
  settings: AppSettings
): { resolved: ResolvedScheduleDate; courses: CourseItem[] } {
  const resolved = resolveEffectiveScheduleDate(
    date,
    settings.termStartDate,
    settings.totalWeeks,
    settings.calendarOverrides
  );
  if (resolved.isHoliday || resolved.effectiveWeek < 1 || resolved.effectiveWeek > settings.totalWeeks) {
    return { resolved, courses: [] };
  }
  const active = courses
    .filter(
      (c) =>
        isCourseSchedulable(c) &&
        c.weeks.includes(resolved.effectiveWeek) &&
        c.dayOfWeek === resolved.effectiveDayOfWeek
    )
    .sort((a, b) => a.startSection - b.startSection);
  return { resolved, courses: active };
}

export interface TodayClassLiveItem {
  id: string;
  name: string;
  location: string;
  teacher: string;
  startSection: number;
  endSection: number;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  status: 'finished' | 'ongoing' | 'upcoming';
  isAudit?: boolean;
}

export interface TodayLiveSnapshot {
  dateStr: string;
  week: number;
  weekdayLabel: string;
  overrideBadge: string | null;
  state: 'ongoing' | 'upcoming' | 'holiday' | 'done' | 'empty';
  headline: string;
  subline: string;
  activeCourse: TodayClassLiveItem | null;
  minutesDelta: number | null; // minutes until start (upcoming) or end (ongoing)
  items: TodayClassLiveItem[];
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/**
 * Compute live status of today's classes for the Schedule header, Android Home Widget,
 * Android Ongoing Notification, and iOS WidgetKit / Dynamic Island Live Activity.
 */
export function buildTodayLiveSnapshot(
  courses: CourseItem[],
  settings: AppSettings,
  now: Date = new Date()
): TodayLiveSnapshot {
  const periods = getActivePeriods(settings);
  const { resolved, courses: todayCourses } = getCoursesForDate(courses, now, settings);
  const weekdayLabel = DAY_FULL_LABELS[resolved.naturalDayOfWeek - 1] ?? `周${resolved.naturalDayOfWeek}`;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (resolved.isHoliday) {
    return {
      dateStr: resolved.dateStr,
      week: Math.max(1, resolved.effectiveWeek),
      weekdayLabel,
      overrideBadge: resolved.badgeText,
      state: 'holiday',
      headline: `${resolved.override?.label || '法定节假日'} · 今日停课`,
      subline: '祝假期愉快，可打开海大课表查看校历调休安排',
      activeCourse: null,
      minutesDelta: null,
      items: [],
    };
  }

  const items: TodayClassLiveItem[] = todayCourses.map((c) => {
    const { startText, endText } = getCourseTimeSpan(c, periods);
    const sMin = hhmmToMinutes(startText);
    const eMin = hhmmToMinutes(endText);
    const status: TodayClassLiveItem['status'] =
      nowMinutes >= eMin ? 'finished' : nowMinutes >= sMin ? 'ongoing' : 'upcoming';
    return {
      id: c.id,
      name: c.name,
      location: c.location,
      teacher: c.teacher,
      startSection: c.startSection,
      endSection: c.endSection,
      startTime: startText,
      endTime: endText,
      status,
      isAudit: c.isAudit,
    };
  });

  if (items.length === 0) {
    return {
      dateStr: resolved.dateStr,
      week: Math.max(1, resolved.effectiveWeek),
      weekdayLabel,
      overrideBadge: resolved.badgeText,
      state: 'empty',
      headline: '今日无排课',
      subline: resolved.badgeText
        ? `${resolved.badgeText} · 好好休息或去空教室自习吧`
        : `第 ${Math.max(1, resolved.effectiveWeek)} 周 ${weekdayLabel} · 自由安排时间`,
      activeCourse: null,
      minutesDelta: null,
      items: [],
    };
  }

  const ongoing = items.find((it) => it.status === 'ongoing') ?? null;
  if (ongoing) {
    const minsLeft = Math.max(1, hhmmToMinutes(ongoing.endTime) - nowMinutes);
    return {
      dateStr: resolved.dateStr,
      week: Math.max(1, resolved.effectiveWeek),
      weekdayLabel,
      overrideBadge: resolved.badgeText,
      state: 'ongoing',
      headline: `上课中 · ${ongoing.name}`,
      subline: `${ongoing.location} · 第${ongoing.startSection}-${ongoing.endSection}节 · 距下课 ${minsLeft} 分钟`,
      activeCourse: ongoing,
      minutesDelta: minsLeft,
      items,
    };
  }

  const upcoming = items.find((it) => it.status === 'upcoming') ?? null;
  if (upcoming) {
    const minsUntil = Math.max(1, hhmmToMinutes(upcoming.startTime) - nowMinutes);
    const timeDesc =
      minsUntil >= 60
        ? `${Math.floor(minsUntil / 60)}小时${minsUntil % 60 > 0 ? `${minsUntil % 60}分` : ''}`
        : `${minsUntil}分钟`;
    return {
      dateStr: resolved.dateStr,
      week: Math.max(1, resolved.effectiveWeek),
      weekdayLabel,
      overrideBadge: resolved.badgeText,
      state: 'upcoming',
      headline: `下节 ${upcoming.startTime} · ${upcoming.name}`,
      subline: `${upcoming.location} · 第${upcoming.startSection}-${upcoming.endSection}节 · 还有 ${timeDesc}`,
      activeCourse: upcoming,
      minutesDelta: minsUntil,
      items,
    };
  }

  return {
    dateStr: resolved.dateStr,
    week: Math.max(1, resolved.effectiveWeek),
    weekdayLabel,
    overrideBadge: resolved.badgeText,
    state: 'done',
    headline: `今日 ${items.length} 节课已全部结束`,
    subline: `第 ${Math.max(1, resolved.effectiveWeek)} 周 ${weekdayLabel} · 辛苦啦`,
    activeCourse: null,
    minutesDelta: null,
    items,
  };
}

export interface GdouCalendarCountdown {
  label: string;
  dateStr: string;
  daysLeft: number;
  tone: 'ocean' | 'amber' | 'emerald' | 'coral';
}

export function buildGdouCalendarCountdowns(
  termStartDate: string,
  totalWeeks: number,
  exams: ExamItem[],
  userOverrides: CalendarDayOverride[] = [],
  now: Date = new Date()
): {
  currentWeek: number;
  progressPercent: number;
  countdowns: GdouCalendarCountdown[];
} {
  const startDt = parseLocalDateStrict(termStartDate) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rawWeek = computeTermWeek(termStartDate, now);
  const currentWeek = Math.min(totalWeeks, Math.max(1, rawWeek));
  const totalDays = Math.max(7, totalWeeks * 7);
  const elapsedDays = Math.max(0, Math.floor((todayStart.getTime() - startDt.getTime()) / 86_400_000));
  const progressPercent = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)));

  const countdowns: GdouCalendarCountdown[] = [];

  // 1) Nearest upcoming exam
  const upcomingExams = exams
    .map((e) => ({ e, dt: parseLocalDateStrict(e.dateText) }))
    .filter((x): x is { e: ExamItem; dt: Date } => Boolean(x.dt && x.dt.getTime() >= todayStart.getTime()))
    .sort((a, b) => a.dt.getTime() - b.dt.getTime());
  if (upcomingExams.length > 0) {
    const first = upcomingExams[0];
    const daysLeft = Math.round((first.dt.getTime() - todayStart.getTime()) / 86_400_000);
    countdowns.push({
      label: `最近考试 · ${first.e.courseName}`,
      dateStr: first.e.dateText,
      daysLeft,
      tone: 'coral',
    });
  }

  // 2) End of teaching term / vacation estimate
  const termEnd = new Date(startDt);
  termEnd.setDate(startDt.getDate() + totalWeeks * 7 - 1);
  if (termEnd.getTime() >= todayStart.getTime()) {
    const daysLeft = Math.round((termEnd.getTime() - todayStart.getTime()) / 86_400_000);
    countdowns.push({
      label: '本学期结束（放假参考）',
      dateStr: formatIsoLocalDate(termEnd),
      daysLeft,
      tone: 'emerald',
    });
  }

  // 3) Next upcoming holiday / makeup / event
  const overrides = getEffectiveCalendarOverrides(userOverrides);
  const nextHoliday = overrides.find((o) => {
    const dt = parseLocalDateStrict(o.date);
    return dt && dt.getTime() >= todayStart.getTime() && o.kind !== 'makeup';
  });
  if (nextHoliday) {
    const dt = parseLocalDateStrict(nextHoliday.date)!;
    const daysLeft = Math.round((dt.getTime() - todayStart.getTime()) / 86_400_000);
    countdowns.push({
      label: nextHoliday.label,
      dateStr: nextHoliday.date,
      daysLeft,
      tone: nextHoliday.kind === 'holiday' ? 'ocean' : 'amber',
    });
  }

  return { currentWeek, progressPercent, countdowns };
}
