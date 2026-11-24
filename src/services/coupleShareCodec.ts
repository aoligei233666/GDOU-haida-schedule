import CryptoJS from 'crypto-js';
import { COURSE_PALETTE } from '../theme/colors';
import { CoupleScheduleProfile, CourseItem } from '../types/models';
import { sanitizeForZeroRetention } from './zeroRetentionSanitizer';

export const COUPLE_SHARE_PREFIX = 'GDOU-COUPLE-V1:';
const MAX_IMPORTED_COURSES = 120;

interface CompactCourseWire {
  n: string; // name
  c?: string; // code
  t?: string; // teacher
  l?: string; // location
  p?: string; // campus
  d: number; // dayOfWeek
  s: number; // startSection
  e: number; // endSection
  w: number[]; // weeks
  wt?: string; // weekText
  cr?: string; // credit
  g?: string; // classGroup
  ci?: number; // colorIndex
}

interface CompactCoupleWire {
  v: 1;
  pn: string; // partnerName
  tl: string; // termLabel
  ts: string; // termStartDate
  cs: CompactCourseWire[];
}

function stableColorIndex(courseName: string): number {
  let hash = 0;
  for (let i = 0; i < courseName.length; i++) {
    hash = (hash * 31 + courseName.charCodeAt(i)) >>> 0;
  }
  return hash % COURSE_PALETTE.length;
}

function toUrlSafeBase64(utf8Text: string): string {
  const b64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(utf8Text));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromUrlSafeBase64(token: string): string {
  let b64 = token.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  return CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(b64));
}

function normalizeImportedCourse(raw: unknown, idx: number): CourseItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  // Accept both compact wire keys (`n`, `d`, `s`, `e`, `w`) and full CourseItem keys
  const name = String(obj.n ?? obj.name ?? '').trim().slice(0, 60);
  if (!name) return null;

  const dayOfWeek = Number(obj.d ?? obj.dayOfWeek ?? 0);
  const startSection = Number(obj.s ?? obj.startSection ?? 0);
  const endSection = Number(obj.e ?? obj.endSection ?? 0);
  if (
    !Number.isInteger(dayOfWeek) ||
    dayOfWeek < 1 ||
    dayOfWeek > 7 ||
    !Number.isInteger(startSection) ||
    startSection < 1 ||
    startSection > 16 ||
    !Number.isInteger(endSection) ||
    endSection < startSection ||
    endSection > 16
  ) {
    return null;
  }

  const rawWeeks = Array.isArray(obj.w ?? obj.weeks) ? ((obj.w ?? obj.weeks) as unknown[]) : [];
  const weeks = Array.from(
    new Set(
      rawWeeks
        .map((w) => Number(w))
        .filter((w) => Number.isInteger(w) && w >= 1 && w <= 30)
    )
  ).sort((a, b) => a - b);
  if (weeks.length === 0) return null;

  const code = String(obj.c ?? obj.code ?? '').trim().slice(0, 30);
  const teacher = String(obj.t ?? obj.teacher ?? '待定教师').trim().slice(0, 40) || '待定教师';
  const location = String(obj.l ?? obj.location ?? '待定教室').trim().slice(0, 50) || '待定教室';
  const campus = String(obj.p ?? obj.campus ?? '').trim().slice(0, 30);
  const weekText =
    String(obj.wt ?? obj.weekText ?? '').trim().slice(0, 40) ||
    `${weeks[0]}-${weeks[weeks.length - 1]}周`;
  const credit = String(obj.cr ?? obj.credit ?? '').trim().slice(0, 10);
  const classGroup = String(obj.g ?? obj.classGroup ?? '').trim().slice(0, 40);
  const rawColor = Number(obj.ci ?? obj.colorIndex);
  const colorIndex = Number.isInteger(rawColor) && rawColor >= 0
    ? rawColor % COURSE_PALETTE.length
    : stableColorIndex(name);

  return {
    id: `partner-${code || colorIndex}-${dayOfWeek}-${startSection}-${endSection}-${idx}`,
    name,
    code,
    teacher,
    location,
    campus,
    dayOfWeek,
    startSection,
    endSection,
    weeks,
    weekText,
    credit,
    classGroup,
    colorIndex,
    ownerTag: 'partner',
  };
}

/**
 * Encode a student's course list into a compact, credential-free share string (`GDOU-COUPLE-V1:...`)
 * suitable for pasting directly in WeChat / QQ / SMS.
 */
export function encodeCoupleShareCode(input: {
  partnerName: string;
  termLabel: string;
  termStartDate: string;
  courses: CourseItem[];
}): string {
  const cleanCourses: CompactCourseWire[] = input.courses
    .filter(
      (c) =>
        !c.parseWarning &&
        c.dayOfWeek >= 1 &&
        c.dayOfWeek <= 7 &&
        c.startSection >= 1 &&
        c.endSection >= c.startSection &&
        c.weeks.length > 0
    )
    .slice(0, MAX_IMPORTED_COURSES)
    .map((c) => {
      const wire: CompactCourseWire = {
        n: c.name,
        d: c.dayOfWeek,
        s: c.startSection,
        e: c.endSection,
        w: c.weeks,
      };
      if (c.code) wire.c = c.code;
      if (c.teacher) wire.t = c.teacher;
      if (c.location) wire.l = c.location;
      if (c.campus) wire.p = c.campus;
      if (c.weekText) wire.wt = c.weekText;
      if (c.credit) wire.cr = c.credit;
      if (c.classGroup) wire.g = c.classGroup;
      wire.ci = c.colorIndex;
      return wire;
    });

  if (cleanCourses.length === 0) {
    throw new Error('当前没有可导出的有效排课，请先同步课表后再生成情侣分享码');
  }

  const payload: CompactCoupleWire = sanitizeForZeroRetention({
    v: 1,
    pn: String(input.partnerName || 'TA').trim().slice(0, 20) || 'TA',
    tl: String(input.termLabel || '').trim().slice(0, 40),
    ts: String(input.termStartDate || '').trim().slice(0, 12),
    cs: cleanCourses,
  });

  return `${COUPLE_SHARE_PREFIX}${toUrlSafeBase64(JSON.stringify(payload))}`;
}

/**
 * Build a human-readable JSON file payload for sharing via AirDrop / WeChat file / system share.
 */
export function buildCoupleShareJsonFileContent(input: {
  partnerName: string;
  termLabel: string;
  termStartDate: string;
  courses: CourseItem[];
}): string {
  const code = encodeCoupleShareCode(input);
  return JSON.stringify(
    sanitizeForZeroRetention({
      format: 'gdou-couple-schedule-v1',
      partnerName: String(input.partnerName || 'TA').trim().slice(0, 20) || 'TA',
      termLabel: input.termLabel,
      termStartDate: input.termStartDate,
      exportedAtIso: new Date().toISOString(),
      shareCode: code,
      courses: input.courses.filter((c) => !c.parseWarning && c.weeks.length > 0),
    }),
    null,
    2
  );
}

/**
 * Decode either:
 * 1) A `GDOU-COUPLE-V1:...` share code (even if surrounded by WeChat chat text!), OR
 * 2) A `.json` file exported by `buildCoupleShareJsonFileContent`.
 */
export function decodeCoupleSharePayload(
  rawInput: string,
  overridePartnerName?: string
): CoupleScheduleProfile {
  const text = String(rawInput ?? '').trim();
  if (!text) {
    throw new Error('粘贴内容为空，请粘贴对方发来的「GDOU-COUPLE-V1:...」情侣分享码');
  }

  // 1. Check if text contains GDOU-COUPLE-V1:<base64url> anywhere inside chat message
  const prefixMatch = text.match(/GDOU-COUPLE-V1:([A-Za-z0-9+/_=-]+)/);
  let decodedObj: Record<string, unknown> | null = null;

  if (prefixMatch) {
    try {
      const jsonStr = fromUrlSafeBase64(prefixMatch[1]);
      decodedObj = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      throw new Error('情侣课表分享码已损坏或复制不完整，请让对方重新点击复制完整口令');
    }
  } else if (text.startsWith('{')) {
    try {
      const parsedJson = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsedJson.shareCode === 'string' && parsedJson.shareCode.includes(COUPLE_SHARE_PREFIX)) {
        return decodeCoupleSharePayload(parsedJson.shareCode, overridePartnerName);
      }
      decodedObj = parsedJson;
    } catch {
      throw new Error('课表文件内容不是有效的 JSON 格式');
    }
  } else {
    throw new Error('未识别到有效的情侣课表口令（须包含 GDOU-COUPLE-V1: 开头）');
  }

  if (!decodedObj || typeof decodedObj !== 'object') {
    throw new Error('无法解析情侣课表数据');
  }

  const rawList = Array.isArray(decodedObj.cs)
    ? decodedObj.cs
    : Array.isArray(decodedObj.courses)
      ? decodedObj.courses
      : [];

  const courses: CourseItem[] = [];
  for (let i = 0; i < Math.min(rawList.length, MAX_IMPORTED_COURSES); i++) {
    const normalized = normalizeImportedCourse(rawList[i], i);
    if (normalized) {
      courses.push(normalized);
    }
  }

  if (courses.length === 0) {
    throw new Error('分享码中不包含任何有效课程排课');
  }

  const partnerName =
    String(overridePartnerName ?? '').trim().slice(0, 20) ||
    String(decodedObj.pn ?? decodedObj.partnerName ?? 'TA').trim().slice(0, 20) ||
    'TA';

  const sanitized = sanitizeForZeroRetention({
    partnerName,
    termLabel: String(decodedObj.tl ?? decodedObj.termLabel ?? '当前学期').trim().slice(0, 40),
    termStartDate: String(decodedObj.ts ?? decodedObj.termStartDate ?? '').trim().slice(0, 12),
    courses,
    updatedAtIso: new Date().toISOString(),
  });

  return sanitized;
}

/**
 * Sample partner schedule for instant preview alongside `buildSampleGdouData`.
 */
export function buildSamplePartnerSchedule(
  termLabel: string,
  termStartDate: string
): CoupleScheduleProfile {
  const courses: CourseItem[] = [
    {
      id: 'partner-sample-1',
      name: '海洋科学导论', // Same course together on Mon 1-2!
      code: 'HY100101',
      teacher: '陈海明',
      location: '钟海楼02018',
      campus: '湖光校区',
      dayOfWeek: 1,
      startSection: 1,
      endSection: 2,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '3.0',
      classGroup: '海洋2401',
      colorIndex: 4,
      ownerTag: 'partner',
    },
    {
      id: 'partner-sample-2',
      name: '食品营养与卫生学',
      code: 'SP201102',
      teacher: '林雅琴',
      location: '兴农楼308',
      campus: '湖光校区',
      dayOfWeek: 1,
      startSection: 3,
      endSection: 4,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '2.5',
      classGroup: '食品2401',
      colorIndex: 4,
      ownerTag: 'partner',
    },
    {
      id: 'partner-sample-3',
      name: '有机化学实验', // Overlaps Tue 3-4 with user's 数据结构与算法!
      code: 'HX102304',
      teacher: '周敏',
      location: '科技楼202',
      campus: '湖光校区',
      dayOfWeek: 2,
      startSection: 3,
      endSection: 4,
      weeks: Array.from({ length: 14 }, (_, i) => i + 1),
      weekText: '1-14周',
      credit: '1.5',
      classGroup: '食品2401',
      colorIndex: 4,
      ownerTag: 'partner',
    },
    {
      id: 'partner-sample-4',
      name: '大学英语（三）',
      code: 'WY100303',
      teacher: '吴婷婷',
      location: '广学楼312', // Same building (广学楼) on Wed 1-2!
      campus: '湖光校区',
      dayOfWeek: 3,
      startSection: 1,
      endSection: 2,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '2.0',
      classGroup: '英语A班',
      colorIndex: 4,
      ownerTag: 'partner',
    },
    {
      id: 'partner-sample-5',
      name: '微生物学基础',
      code: 'SW200401',
      teacher: '唐国强',
      location: '钟海楼03012',
      campus: '湖光校区',
      dayOfWeek: 4,
      startSection: 1,
      endSection: 2,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '3.0',
      classGroup: '食品2401',
      colorIndex: 4,
      ownerTag: 'partner',
    },
  ];

  return {
    partnerName: '小海',
    termLabel,
    termStartDate,
    courses,
    updatedAtIso: new Date().toISOString(),
  };
}
