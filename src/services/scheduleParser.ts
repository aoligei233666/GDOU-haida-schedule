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
    const cleaned = seg.replace(/周|\(\s*[单双]\s*\)|[单双]/g, '').trim();

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
 * Parse 正方教务 section fields (`jcs`, `jc`, `jcor`, plus optional bitmask `oldjc`)
 * into { startSection, endSection }.
 * Returns null if unparseable (never silently fabricates 1-2节).
 */
export function parseSectionRange(
  jc?: string,
  jcs?: string,
  jcor?: string,
  oldjc?: string | number
): { startSection: number; endSection: number } | null {
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
    if (cleaned.includes(',')) {
      const nums = cleaned
        .split(',')
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 16);
      if (nums.length > 0) {
        return { startSection: Math.min(...nums), endSection: Math.max(...nums) };
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

  // Fallback: Zhengfang `oldjc` bitmask (bit i-1 set => section i active, e.g. 3 => 0b11 => 1-2)
  const mask = parseInt(String(oldjc ?? '').trim(), 10);
  if (Number.isFinite(mask) && mask > 0 && mask < 1 << 16) {
    let first = 0;
    let last = 0;
    for (let sec = 1; sec <= 16; sec++) {
      if ((mask & (1 << (sec - 1))) !== 0) {
        if (!first) first = sec;
        last = sec;
      }
    }
    if (first >= 1 && last >= first) {
      return { startSection: first, endSection: last };
    }
  }

  return null;
}

function normalizeTimeToken(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

interface RawZfPeriodTime {
  jcdm?: string | number;
  jcbh?: string | number;
  jc?: string | number;
  jcmc?: string;
  xh?: string | number;
  qssj?: string;
  kssj?: string;
  jssj?: string;
  xksj?: string;
  sj?: string;
  qzsj?: string;
  sksj?: string;
}

/**
 * Parse 正方V9 `/kbcx/xskbcx_cxRjc.html` official section-time response into sorted PeriodTime[].
 * Handles array or `{ items | rows | rjcList | sjdList | data }` wrapper shapes cleanly.
 */
export function parseZfPeriodTimesResponse(raw: unknown): PeriodTime[] {
  let rows: RawZfPeriodTime[] = [];
  if (Array.isArray(raw)) {
    rows = raw as RawZfPeriodTime[];
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const candidate =
      obj.items ?? obj.rows ?? obj.rjcList ?? obj.sjdList ?? obj.data ?? obj.list;
    if (Array.isArray(candidate)) {
      rows = candidate as RawZfPeriodTime[];
    }
  }
  if (rows.length === 0) return [];

  const bySection = new Map<number, PeriodTime>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const secRaw = row.jcdm ?? row.jcbh ?? row.jc ?? row.jcmc ?? row.xh;
    const secMatch = String(secRaw ?? '').match(/(\d+)/);
    if (!secMatch) continue;
    const section = parseInt(secMatch[1], 10);
    if (!Number.isFinite(section) || section < 1 || section > 16) continue;

    let start = normalizeTimeToken(row.qssj ?? row.kssj);
    let end = normalizeTimeToken(row.jssj ?? row.xksj);

    if (!start || !end) {
      const combined = String(row.sj ?? row.qzsj ?? row.sksj ?? '').trim();
      const rangeMatch = combined.match(/(\d{1,2}:\d{2})(?::\d{2})?\s*[-~至—–]\s*(\d{1,2}:\d{2})(?::\d{2})?/);
      if (rangeMatch) {
        start = normalizeTimeToken(rangeMatch[1]);
        end = normalizeTimeToken(rangeMatch[2]);
      }
    }

    if (!start || !end || start >= end) continue;
    bySection.set(section, { section, start, end });
  }

  return Array.from(bySection.values()).sort((a, b) => a.section - b.section);
}

function stableColorIndex(courseName: string): number {
  let hash = 0;
  for (let i = 0; i < courseName.length; i++) {
    hash = (hash * 31 + courseName.charCodeAt(i)) >>> 0;
  }
  return hash % COURSE_PALETTE.length;
}

/**
 * Parse weekday into 1..7 (Monday..Sunday), or null if unparseable (never silently guesses Monday).
 */
export function parseDayOfWeek(xqj: unknown): number | null {
  const str = String(xqj ?? '').trim();
  if (!str) return null;
  if (/^[1-7]$/.test(str)) {
    return parseInt(str, 10);
  }
  const map: Record<string, number> = {
    星期一: 1, 周一: 1, 一: 1,
    星期二: 2, 周二: 2, 二: 2,
    星期三: 3, 周三: 3, 三: 3,
    星期四: 4, 周四: 4, 四: 4,
    星期五: 5, 周五: 5, 五: 5,
    星期六: 6, 周六: 6, 六: 6,
    星期日: 7, 星期天: 7, 周日: 7, 周天: 7, 日: 7, 天: 7,
  };
  return map[str] ?? null;
}

interface RawZfCourse {
  kcmc?: string;
  kch?: string;
  kch_id?: string;
  xm?: string;
  cdmc?: string;
  jgmc?: string;
  xqmc?: string;
  xqh_id?: string;
  xqj?: string | number;
  xqjmc?: string;
  jc?: string;
  jcs?: string;
  jcor?: string;
  oldjc?: string | number;
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
 * Unparseable time fields are flagged explicitly in `warnings` and `course.parseWarning`
 * instead of silently fabricating bogus Mondays/sections/weeks.
 */
export function parseZfScheduleResponse(raw: unknown): {
  courses: CourseItem[];
  termLabel?: string;
  campusId?: string;
  campusName?: string;
  warnings: string[];
} {
  if (!raw || typeof raw !== 'object') {
    return { courses: [], warnings: [] };
  }
  const obj = raw as Record<string, unknown>;
  const kbList = Array.isArray(obj.kbList) ? (obj.kbList as RawZfCourse[]) : [];

  const seen = new Set<string>();
  const courses: CourseItem[] = [];
  const warnings: string[] = [];
  let campusId: string | undefined;
  let campusName: string | undefined;

  for (let idx = 0; idx < kbList.length; idx++) {
    const item = kbList[idx];
    const name = String(item.kcmc ?? '').trim();
    if (!name) continue;

    if (!campusId && item.xqh_id) {
      campusId = String(item.xqh_id).trim() || undefined;
    }
    if (!campusName && item.xqmc) {
      campusName = String(item.xqmc).trim() || undefined;
    }

    const dayOfWeek = parseDayOfWeek(item.xqj ?? item.xqjmc);
    const sectionRange = parseSectionRange(item.jc, item.jcs, item.jcor, item.oldjc);
    const weekText = String(item.zcd ?? '').trim();
    const weeks = parseWeekExpression(weekText);
    const location = String(item.cdmc ?? item.jgmc ?? '待定教室').trim();
    const teacher = String(item.xm ?? '待定教师').trim();
    const code = String(item.kch ?? item.kch_id ?? '').trim();
    const campus = String(item.xqmc ?? '').trim();
    const credit = String(item.xf ?? '').trim();
    const classGroup = String(item.jxbmc ?? item.skbj ?? '').trim();

    const missingParts: string[] = [];
    if (dayOfWeek === null) missingParts.push(`星期(${String(item.xqj ?? item.xqjmc ?? '空')})`);
    if (sectionRange === null) missingParts.push(`节次(${String(item.jcs ?? item.jc ?? item.jcor ?? '空')})`);
    if (weeks.length === 0) missingParts.push(`周次(${weekText || '空'})`);

    const parseWarning =
      missingParts.length > 0
        ? `时间字段未解析：${missingParts.join('、')}，已跳过日历/闹钟自动导出`
        : undefined;
    if (parseWarning) {
      warnings.push(`《${name}》${parseWarning}`);
    }

    const effDay = dayOfWeek ?? 0;
    const effStart = sectionRange?.startSection ?? 0;
    const effEnd = sectionRange?.endSection ?? 0;

    const dedupKey = `${name}|${effDay}|${effStart}-${effEnd}|${weekText}|${location}|${teacher}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Merge disjoint week segments of the exact same course/slot/room/teacher into one CourseItem
    // so multi-segment courses (e.g. "1-4周" + "6-16周") never split into fake self-overlaps
    if (!parseWarning && effDay >= 1 && effStart >= 1 && weeks.length > 0) {
      const mergeTarget = courses.find(
        (existing) =>
          !existing.parseWarning &&
          existing.name === name &&
          existing.code === code &&
          existing.dayOfWeek === effDay &&
          existing.startSection === effStart &&
          existing.endSection === effEnd &&
          existing.location === location &&
          existing.teacher === teacher
      );
      if (mergeTarget) {
        const mergedWeeks = Array.from(new Set([...mergeTarget.weeks, ...weeks])).sort(
          (a, b) => a - b
        );
        mergeTarget.weeks = mergedWeeks;
        if (weekText && !mergeTarget.weekText.includes(weekText)) {
          mergeTarget.weekText = `${mergeTarget.weekText},${weekText}`;
        }
        continue;
      }
    }

    courses.push({
      id: `c-${code || stableColorIndex(name)}-${effDay}-${effStart}-${effEnd}-${idx}`,
      name,
      code,
      teacher,
      location,
      campus,
      dayOfWeek: effDay,
      startSection: effStart,
      endSection: effEnd,
      weeks,
      weekText: weekText || '周次待定',
      credit,
      classGroup,
      colorIndex: stableColorIndex(name),
      parseWarning,
    });
  }

  let termLabel: string | undefined;
  const xsxx = obj.xsxx as Record<string, unknown> | undefined;
  if (xsxx && xsxx.XNMC && xsxx.XQMMC) {
    termLabel = `${String(xsxx.XNMC)}学年 第${String(xsxx.XQMMC)}学期`;
  }

  courses.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startSection - b.startSection);
  return { courses, termLabel, campusId, campusName, warnings };
}

/**
 * Strictly parse YYYY-MM-DD as local midnight, returning null for malformed or impossible dates
 * (e.g., "2026-02-31"). Never silently substitutes today's date.
 */
export function parseLocalDateStrict(ymd: string): Date | null {
  const m = String(ymd ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

/**
 * Parse YYYY-MM-DD strictly as local midnight; throws if invalid so callers cannot silently use today.
 */
export function parseLocalDate(ymd: string): Date {
  const strict = parseLocalDateStrict(ymd);
  if (!strict) {
    throw new Error(`无效的日期格式：${ymd}（期望 YYYY-MM-DD）`);
  }
  return strict;
}

/**
 * Compute 1-based academic week number from termStartDate (Week 1 Monday).
 */
export function computeTermWeek(termStartDate: string, now: Date = new Date()): number {
  const start = parseLocalDateStrict(termStartDate);
  if (!start) return 1;
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
  const base = parseLocalDateStrict(termStartDate);
  if (!base) {
    throw new Error(`开学基准日期无效：${termStartDate}`);
  }
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

export interface CourseWallClockOccurrence {
  week: number;
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

export function isCourseSchedulable(course: CourseItem): boolean {
  return (
    !course.parseWarning &&
    course.dayOfWeek >= 1 &&
    course.dayOfWeek <= 7 &&
    course.startSection >= 1 &&
    course.endSection >= course.startSection &&
    course.weeks.length > 0
  );
}

/**
 * Expand a course into timezone-independent Asia/Shanghai wall-clock occurrences
 * using UTC calendar arithmetic so device timezone abroad cannot shift dates.
 */
export function getCourseWallClockOccurrences(
  course: CourseItem,
  termStartDate: string,
  periods: PeriodTime[]
): CourseWallClockOccurrence[] {
  if (!isCourseSchedulable(course)) return [];
  const startMatch = String(termStartDate ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!startMatch) return [];
  const baseYear = parseInt(startMatch[1], 10);
  const baseMonth = parseInt(startMatch[2], 10);
  const baseDay = parseInt(startMatch[3], 10);
  const check = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay));
  if (
    check.getUTCFullYear() !== baseYear ||
    check.getUTCMonth() !== baseMonth - 1 ||
    check.getUTCDate() !== baseDay
  ) {
    return [];
  }

  const { startText, endText } = getCourseTimeSpan(course, periods);
  const [sh, sm] = startText.split(':').map((v) => parseInt(v, 10));
  const [eh, em] = endText.split(':').map((v) => parseInt(v, 10));

  return course.weeks.map((week) => {
    const dt = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay + (week - 1) * 7 + (course.dayOfWeek - 1)));
    return {
      week,
      year: dt.getUTCFullYear(),
      month: dt.getUTCMonth() + 1,
      day: dt.getUTCDate(),
      startHour: Number.isFinite(sh) ? sh : 8,
      startMinute: Number.isFinite(sm) ? sm : 10,
      endHour: Number.isFinite(eh) ? eh : 9,
      endMinute: Number.isFinite(em) ? em : 50,
    };
  });
}

/**
 * Expand a course into exact calendar Date ranges across all of its teaching weeks.
 * Skips unparsed/unschedulable courses cleanly.
 */
export function getCourseOccurrences(
  course: CourseItem,
  termStartDate: string,
  periods: PeriodTime[]
): CourseOccurrence[] {
  if (!isCourseSchedulable(course)) return [];
  if (!parseLocalDateStrict(termStartDate)) return [];
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
 * Find the earliest schedulable class for each day of the week (1..7) during a specific week.
 * Used for generating automatic smart morning wake-up alarms.
 */
export function getFirstClassPerDayInWeek(
  courses: CourseItem[],
  week: number
): Map<number, CourseItem> {
  const map = new Map<number, CourseItem>();
  const active = courses.filter((c) => isCourseSchedulable(c) && c.weeks.includes(week));
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
