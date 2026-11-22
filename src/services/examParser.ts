import { ExamItem } from '../types/models';

interface RawZfExam {
  kcmc?: string;
  kch?: string;
  kch_id?: string;
  kssj?: string;
  ksrq?: string;
  qzsj?: string;
  cdmc?: string;
  jsmc?: string;
  ksdd?: string;
  zwh?: string;
  jsz?: string;
  cdbh?: string;
  ksxzmc?: string;
  ksfs?: string;
  ksmc?: string;
  xqmc?: string;
  cdxqmc?: string;
  xm?: string;
  jklsmc?: string;
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isValidHm(hhmm: string): boolean {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/**
 * Parse 正方考试时间 formats such as:
 * - "2026-06-18(09:00-11:00)"
 * - "2026-06-18 09:00-11:00"
 * - "2026年06月18日 14:30~16:30"
 * - Separate `ksrq`="2026-06-18" and `qzsj`="09:00-11:00"
 */
export function parseExamDateTime(
  kssj?: string,
  ksrq?: string,
  qzsj?: string
): {
  dateText: string;
  startTimeText: string;
  endTimeText: string;
  startIso: string | null;
  endIso: string | null;
} {
  const combined = `${kssj ?? ''} ${ksrq ?? ''} ${qzsj ?? ''}`
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/年|月/g, '-')
    .replace(/日/g, ' ')
    .trim();

  const dateMatch = combined.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  const timeMatch = combined.match(/(\d{1,2}:\d{2})\s*[-~至]\s*(\d{1,2}:\d{2})/);

  let dateText = '';
  if (dateMatch) {
    const y = parseInt(dateMatch[1], 10);
    const m = parseInt(dateMatch[2], 10);
    const d = parseInt(dateMatch[3], 10);
    if (isValidYmd(y, m, d)) {
      dateText = `${dateMatch[1]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const startTimeText = timeMatch && isValidHm(timeMatch[1]) ? padTime(timeMatch[1]) : '';
  const endTimeText = timeMatch && isValidHm(timeMatch[2]) ? padTime(timeMatch[2]) : '';

  const startIso = dateText && startTimeText ? `${dateText}T${startTimeText}:00` : null;
  const endIso = dateText && endTimeText ? `${dateText}T${endTimeText}:00` : null;

  return { dateText, startTimeText, endTimeText, startIso, endIso };
}

function padTime(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `${String(h || '00').padStart(2, '0')}:${String(m || '00').padStart(2, '0')}`;
}

/**
 * Parse 正方新教务系统 `/kwgl/kscx_cxXsksxxIndex.html?doType=query` JSON response.
 */
export function parseZfExamResponse(raw: unknown): ExamItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.items)
    ? (obj.items as RawZfExam[])
    : Array.isArray(obj.rows)
      ? (obj.rows as RawZfExam[])
      : Array.isArray(raw)
        ? (raw as RawZfExam[])
        : [];

  const seen = new Set<string>();
  const exams: ExamItem[] = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const courseName = String(item.kcmc ?? '').trim();
    if (!courseName) continue;

    // Properly fall back when kssj is empty string "" while ksrq/qzsj are provided
    const kssjClean = String(item.kssj ?? '').trim();
    const fallbackCombined = [item.ksrq, item.qzsj]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .join(' ');
    const { dateText, startTimeText, endTimeText, startIso, endIso } = parseExamDateTime(
      kssjClean || undefined,
      item.ksrq,
      item.qzsj
    );
    const derivedFormatted =
      dateText && startTimeText && endTimeText
        ? `${dateText}(${startTimeText}-${endTimeText})`
        : dateText;
    const rawTimeText = kssjClean || fallbackCombined || derivedFormatted;

    const location = String(item.cdmc ?? item.jsmc ?? item.ksdd ?? '考场待公布').trim();
    const seatNumber = String(item.zwh ?? item.jsz ?? '').trim();
    const examType =
      [item.ksfs, item.ksxzmc].map((v) => String(v ?? '').trim()).filter(Boolean).join(' · ') ||
      String(item.ksmc ?? '期末考试').trim();
    const courseCode = String(item.kch ?? item.kch_id ?? '').trim();
    const campus = String(item.cdxqmc ?? item.xqmc ?? '').trim();
    const invigilator = String(item.jklsmc ?? item.xm ?? '').trim();

    const dedup = `${courseName}|${rawTimeText}|${location}|${seatNumber}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    exams.push({
      id: `exam-${courseCode || courseName}-${dateText || i}-${i}`,
      courseName,
      courseCode,
      examType,
      dateText,
      startTimeText,
      endTimeText,
      startIso,
      endIso,
      rawTimeText: rawTimeText || '时间待公布',
      location,
      seatNumber,
      campus,
      invigilator,
    });
  }

  exams.sort((a, b) => {
    const ta = a.startIso ? parseExamIsoLocal(a.startIso).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.startIso ? parseExamIsoLocal(b.startIso).getTime() : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });

  return exams;
}

export interface ExamCountdown {
  status: 'upcoming' | 'today' | 'past' | 'tbd';
  daysLeft: number;
  label: string;
}

export function getExamCountdown(exam: ExamItem, now: Date = new Date()): ExamCountdown {
  if (!exam.startIso) {
    return { status: 'tbd', daysLeft: 999, label: '时间待定' };
  }
  const examStart = parseExamIsoLocal(exam.startIso);
  const examEnd = exam.endIso
    ? parseExamIsoLocal(exam.endIso)
    : new Date(examStart.getTime() + 2 * 3600 * 1000);

  if (now.getTime() > examEnd.getTime()) {
    return { status: 'past', daysLeft: -1, label: '已结束' };
  }

  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const examMidnight = new Date(
    examStart.getFullYear(),
    examStart.getMonth(),
    examStart.getDate()
  ).getTime();
  const diffDays = Math.round((examMidnight - todayMidnight) / (24 * 60 * 60 * 1000));

  if (diffDays <= 0) {
    return { status: 'today', daysLeft: 0, label: '今日考试' };
  }
  if (diffDays === 1) {
    return { status: 'upcoming', daysLeft: 1, label: '明天考试' };
  }
  return { status: 'upcoming', daysLeft: diffDays, label: `还有 ${diffDays} 天` };
}

export function parseExamIsoLocal(iso: string): Date {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return new Date(iso);
  return new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    0,
    0
  );
}
