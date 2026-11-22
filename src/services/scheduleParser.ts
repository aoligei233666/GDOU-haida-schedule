import { COURSE_PALETTE } from '../theme/colors';
import { CourseItem, PeriodTime } from '../types/models';

/**
 * Parse 正方教务 `zcd` week expressions into a sorted array of unique week numbers.
 * Examples handled:
 * - "1-16周"
 * - "1-16周(单)" / "2-16周(双)"
 * - "1-4周,6-12周(双),15周"
 * - "第3周" / "3,5,7周"
 */
export function parseWeekExpression(zcd: string): number[] {
  if (!zcd) return [];
  const normalized = zcd
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/，/g, ',')
    .replace(/、/g, ',')
    .replace(/第/g, '')
    .trim();

  const weeks = new Set<number>();
  const segments = normalized.split(',').map((s) => s.trim()).filter(Boolean);

  for (const seg of segments) {
    const isOdd = seg.includes('单');
    const isEven = seg.includes('双');
    const cleaned = seg.replace(/周|\(单\)|\(双\)|单|双/g, '').trim();

    const rangeMatch = cleaned.match(/^(\d+)\s*[-~至]\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
        for (let w = start; w <= end; w++) {
          if (isOdd && w % 2 === 0) continue;
          if (isEven && w % 2 !== 0) continue;
          if (w >= 1 && w <= 30) weeks.add(w);
        }
      }
      continue;
    }

    const singleMatch = cleaned.match(/^(\d+)$/);
    if (singleMatch) {
      const w = parseInt(singleMatch[1], 10);
      if (w >= 1 && w <= 30) weeks.add(w);
    }
  }

  return Array.from(weeks).sort((a, b) => a - b);
}

/**
 * Parse 正方教务 section fields (`jcs`, `jc`, `jcor`) into { startSection, endSection }.
 * Examples: jcs="1-2", jc="1-2节", jcor="3-4" or "5"
 */
export function parseSectionRange(
  jc?: string,
  jcs?: string,
  jcor?: string
): { startSection: number; endSection: number } {
  const candidates = [jcs, jc, jcor].filter((v): v is string => Boolean(v && String(v).trim()));
  for (const raw of candidates) {
    const cleaned = String(raw).replace(/节|第/g, '').trim();
    const rangeMatch = cleaned.match(/(\d+)\s*[-~至]\s*(\d+)/);
    if (rangeMatch) {
      const s = parseInt(rangeMatch[1], 10);
      const e = parseInt(rangeMatch[2], 10);
      if (s >= 1 && e >= s && e <= 16) {
        return { startSection: s, endSection: e };
      }
    }
    const singleMatch = cleaned.match(/^(\d+)$/);
    if (singleMatch) {
      const s = parseInt(singleMatch[1], 10);
      if (s >= 1 && s <= 16) {
        return { startSection: s, endSection: s };
      }
    }
  }
  return { startSection: 1, endSection: 2 };
}

function stableColorIndex(courseName: string): number {
  let hash = 0;
  for (let i = 0; i < courseName.length; i++) {
    hash = (hash * 31 + courseName.charCodeAt(i)) >>> 0;
  }
  return hash % COURSE_PALETTE.length;
}

function parseDayOfWeek(xqj: unknown): number {
  const str = String(xqj ?? '').trim();
  const num = parseInt(str, 10);
  if (num >= 1 && num <= 7) return num;
  const map: Record<string, number> = {
    星期一: 1, 周一: 1, 一: 1,
    星期二: 2, 周二: 2, 二: 2,
    星期三: 3, 周三: 3, 三: 3,
    星期四: 4, 周四: 4, 四: 4,
    星期五: 5, 周五: 5, 五: 5,
    星期六: 6, 周六: 6, 六: 6,
    星期日: 7, 星期天: 7, 周日: 7, 周天: 7, 日: 7, 天: 7,
  };
  return map[str] ?? 1;
}

interface RawZfCourse {
  kcmc?: string;
  kch?: string;
  kch_id?: string;
  xm?: string;
  cdmc?: string;
  jgmc?: string;
  xqmc?: string;
  xqj?: string | number;
  xqjmc?: string;
  jc?: string;
  jcs?: string;
  jcor?: string;
  zcd?: string;
  xf?: string;
  jxbmc?: string;
  skbj?: string;
  jxb_id?: string;
}

/**
 * Parse 正方新教务系统 `/kbcx/xskbcx_cxXsgrkb.html` JSON payload into normalized CourseItem[].
 * Note: Intentionally discards personal student identifiers (`xsxx.xh`, `xsxx.xm`, etc.)
 * to adhere strictly to data minimization.
 */
export function parseZfScheduleResponse(raw: unknown): {
  courses: CourseItem[];
  termLabel?: string;
} {
  if (!raw || typeof raw !== 'object') {
    return { courses: [] };
  }
  const obj = raw as Record<string, unknown>;
  const kbList = Array.isArray(obj.kbList) ? (obj.kbList as RawZfCourse[]) : [];

  const seen = new Set<string>();
  const courses: CourseItem[] = [];

  for (let idx = 0; idx < kbList.length; idx++) {
    const item = kbList[idx];
    const name = String(item.kcmc ?? '').trim();
    if (!name) continue;

    const dayOfWeek = parseDayOfWeek(item.xqj ?? item.xqjmc);
    const { startSection, endSection } = parseSectionRange(item.jc, item.jcs, item.jcor);
    const weekText = String(item.zcd ?? '').trim();
    const weeks = parseWeekExpression(weekText);
    const location = String(item.cdmc ?? item.jgmc ?? '待定教室').trim();
    const teacher = String(item.xm ?? '待定教师').trim();
    const code = String(item.kch ?? item.kch_id ?? '').trim();
    const campus = String(item.xqmc ?? '').trim();
    const credit = String(item.xf ?? '').trim();
    const classGroup = String(item.jxbmc ?? item.skbj ?? '').trim();

    const dedupKey = `${name}|${dayOfWeek}|${startSection}-${endSection}|${weekText}|${location}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    courses.push({
      id: `c-${idx}-${dayOfWeek}-${startSection}-${endSection}-${code || stableColorIndex(name)}`,
      name,
      code,
      teacher,
      location,
      campus,
      dayOfWeek,
      startSection,
      endSection,
      weeks: weeks.length > 0 ? weeks : Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: weekText || '1-16周',
      credit,
      classGroup,
      colorIndex: stableColorIndex(name),
    });
  }

  let termLabel: string | undefined;
  const xsxx = obj.xsxx as Record<string, unknown> | undefined;
  if (xsxx && xsxx.XNMC && xsxx.XQMMC) {
    termLabel = `${String(xsxx.XNMC)}学年 第${String(xsxx.XQMMC)}学期`;
  }

  courses.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startSection - b.startSection);
  return { courses, termLabel };
}

/**
 * Parse YYYY-MM-DD strictly as local midnight to avoid UTC off-by-one-day bugs.
 */
export function parseLocalDate(ymd: string): Date {
  const m = ymd.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 0, 0, 0, 0);
}

/**
 * Compute 1-based academic week number from termStartDate (Week 1 Monday).
 */
export function computeTermWeek(termStartDate: string, now: Date = new Date()): number {
  const start = parseLocalDate(termStartDate);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return 1;
  return Math.floor(diffDays / 7) + 1;
}

/**
 * Return local Date (at 00:00) for a given academic week (1-based) and dayOfWeek (1=Mon..7=Sun).
 */
export function getDateForWeekAndDay(
  termStartDate: string,
  week: number,
  dayOfWeek: number
): Date {
  const base = parseLocalDate(termStartDate);
  base.setDate(base.getDate() + (week - 1) * 7 + (dayOfWeek - 1));
  return base;
}

export function applyTimeToDate(baseDate: Date, hhmm: string): Date {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr || '8', 10);
  const m = parseInt(mStr || '0', 10);
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    Number.isFinite(h) ? h : 8,
    Number.isFinite(m) ? m : 0,
    0,
    0
  );
}

export function getCourseTimeSpan(
  course: CourseItem,
  periods: PeriodTime[]
): { startText: string; endText: string } {
  const startPeriod =
    periods.find((p) => p.section === course.startSection) ??
    periods[Math.max(0, Math.min(periods.length - 1, course.startSection - 1))];
  const endPeriod =
    periods.find((p) => p.section === course.endSection) ??
    periods[Math.max(0, Math.min(periods.length - 1, course.endSection - 1))];
  return {
    startText: startPeriod?.start ?? '08:10',
    endText: endPeriod?.end ?? '09:50',
  };
}

export interface CourseOccurrence {
  week: number;
  start: Date;
  end: Date;
}

/**
 * Expand a course into exact calendar Date ranges across all of its teaching weeks.
 */
export function getCourseOccurrences(
  course: CourseItem,
  termStartDate: string,
  periods: PeriodTime[]
): CourseOccurrence[] {
  const { startText, endText } = getCourseTimeSpan(course, periods);
  return course.weeks.map((week) => {
    const dayDate = getDateForWeekAndDay(termStartDate, week, course.dayOfWeek);
    return {
      week,
      start: applyTimeToDate(dayDate, startText),
      end: applyTimeToDate(dayDate, endText),
    };
  });
}

/**
 * Find the earliest class for each day of the week (1..7) during a specific week.
 * Used for generating automatic smart morning wake-up alarms.
 */
export function getFirstClassPerDayInWeek(
  courses: CourseItem[],
  week: number
): Map<number, CourseItem> {
  const map = new Map<number, CourseItem>();
  const active = courses.filter((c) => c.weeks.includes(week));
  for (const c of active) {
    const prev = map.get(c.dayOfWeek);
    if (!prev || c.startSection < prev.startSection) {
      map.set(c.dayOfWeek, c);
    }
  }
  return map;
}

export function formatShortDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getTodayDayOfWeek(now: Date = new Date()): number {
  const d = now.getDay();
  return d === 0 ? 7 : d;
}
