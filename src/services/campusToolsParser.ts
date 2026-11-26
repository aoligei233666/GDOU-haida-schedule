import { COURSE_PALETTE } from '../theme/colors';
import {
  CourseItem,
  CurriculumModuleProgress,
  EmptyClassroomFilterOptions,
  EmptyClassroomItem,
  GradeItem,
  GraduationAuditReport,
} from '../types/models';
import { computeGpaSummary } from './gradeParser';
import { parseDayOfWeek, parseSectionRange, parseWeekExpression } from './scheduleParser';

export const OFFICIAL_CURRICULUM_SOURCE_LABEL =
  '数据来源：广东海洋大学正方教务「学业情况 / 培养方案」官方同步';

export const LOCAL_ESTIMATE_CURRICULUM_SOURCE_LABEL =
  '数据来源：本地已修成绩按课程性质汇总（未获取到官方培养方案接口，要求学分仅供参考）';

export const OFFICIAL_EMPTY_ROOM_SOURCE_LABEL =
  '数据来源：广东海洋大学正方教务「空教室查询」接口';

export const OFFICIAL_CAMPUS_COURSE_SOURCE_LABEL =
  '数据来源：广东海洋大学正方教务「全校 / 班级课表」查询接口';

function decodeHtmlText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stableColorIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash % COURSE_PALETTE.length;
}

function extractSelectOptions(html: string, idOrName: string): Array<{ id: string; name: string }> {
  const selectRe = new RegExp(
    `<select[^>]*(?:id|name)=["']${idOrName}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    'i'
  );
  const match = html.match(selectRe);
  if (!match) return [];
  const options: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  const optRe = /<option[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(match[1])) !== null) {
    const id = (m[1] || '').trim();
    const name = decodeHtmlText(m[2] || '');
    if (!id || !name || /全部|请选择|--/i.test(name) || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, name });
  }
  return options;
}

/**
 * Parse 正方 `/cdjy/cdjy_cxKxcdlb.html` filter HTML for campuses, buildings, and room types.
 */
export function parseEmptyClassroomOptionsHtml(html: string): EmptyClassroomFilterOptions {
  const campuses = extractSelectOptions(html, 'xqh_id');
  const buildings = extractSelectOptions(html, 'lh');
  const roomTypes = extractSelectOptions(html, 'cdlb_id');
  return { campuses, buildings, roomTypes };
}

interface RawZfEmptyRoom {
  cd_id?: string;
  cdbh?: string;
  cdmc?: string;
  jxlmc?: string;
  lh?: string;
  xqmc?: string;
  cdlbmc?: string;
  zws?: string | number;
  kszws1?: string | number;
  lch?: string | number;
}

/**
 * Parse 正方 `/cdjy/cdjy_cxKxcdlb.html?doType=query` JSON response into EmptyClassroomItem[].
 */
export function parseZfEmptyClassroomsResponse(raw: unknown): EmptyClassroomItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.items)
    ? (obj.items as RawZfEmptyRoom[])
    : Array.isArray(obj.rows)
      ? (obj.rows as RawZfEmptyRoom[])
      : Array.isArray(raw)
        ? (raw as RawZfEmptyRoom[])
        : [];

  const out: EmptyClassroomItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || typeof r !== 'object') continue;
    const roomName = String(r.cdmc ?? r.cdbh ?? '').trim();
    if (!roomName) continue;
    const roomCode = String(r.cdbh ?? r.cd_id ?? roomName).trim();
    if (seen.has(roomCode)) continue;
    seen.add(roomCode);

    const seatsNum = parseInt(String(r.zws ?? '0'), 10);
    const examSeatsNum = parseInt(String(r.kszws1 ?? ''), 10);
    const building =
      String(r.jxlmc ?? r.lh ?? '').trim() ||
      (roomName.match(/^([\u4e00-\u9fa5A-Za-z]+)/)?.[1] ?? '教学楼');

    out.push({
      id: `room-${roomCode}-${i}`,
      roomName,
      roomCode,
      building,
      campus: String(r.xqmc ?? '').trim() || '湖光校区',
      roomType: String(r.cdlbmc ?? '').trim() || '普通教室',
      seats: Number.isFinite(seatsNum) && seatsNum >= 0 ? seatsNum : 0,
      examSeats: Number.isFinite(examSeatsNum) && examSeatsNum > 0 ? examSeatsNum : undefined,
      floor: r.lch !== undefined && String(r.lch).trim() ? String(r.lch).trim() : undefined,
    });
  }

  out.sort(
    (a, b) =>
      a.building.localeCompare(b.building, 'zh-Hans-CN') ||
      a.roomName.localeCompare(b.roomName, 'zh-Hans-CN')
  );
  return out;
}

function parseNumOrNull(val: unknown): number | null {
  if (val === undefined || val === null || String(val).trim() === '') return null;
  const n = parseFloat(String(val).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseNumOrZero(val: unknown): number {
  return parseNumOrNull(val) ?? 0;
}

/**
 * Parse 正方教务「学业情况 / 培养方案」响应（支持 JSON 树或 HTML 学分要求摘要）为带明确来源标注的毕业学分报告。
 * Note: Intentionally strips any personal identifiers (student ID / student name).
 */
export function parseZfGraduationAuditResponse(
  rawPayload: unknown,
  syncedAtIso: string = new Date().toISOString()
): GraduationAuditReport | null {
  const modules: CurriculumModuleProgress[] = [];
  const seen = new Set<string>();
  let programTitle: string | undefined;
  let totalRequired: number | null = null;
  let totalEarned = 0;
  let totalInProgress = 0;

  const pushModule = (mod: CurriculumModuleProgress) => {
    const key = mod.name.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    modules.push(mod);
  };

  if (rawPayload && typeof rawPayload === 'object') {
    const obj = rawPayload as Record<string, unknown>;
    const list = Array.isArray(rawPayload)
      ? rawPayload
      : Array.isArray(obj.items)
        ? obj.items
        : Array.isArray(obj.rows)
          ? obj.rows
          : Array.isArray(obj.list)
            ? obj.list
            : Array.isArray(obj.data)
              ? obj.data
              : [];

    for (let i = 0; i < list.length; i++) {
      const rec = list[i] as Record<string, unknown>;
      if (!rec || typeof rec !== 'object') continue;
      const name = String(
        rec.xfyqmc ?? rec.kcxzmc ?? rec.kclbmc ?? rec.mc ?? rec.title ?? rec.name ?? ''
      ).trim();
      if (!name) continue;
      if (!programTitle && rec.zymc) {
        programTitle = String(rec.zymc).trim();
      }
      const req = parseNumOrNull(
        rec.yqzdxf ?? rec.xfyq ?? rec.yqxf ?? rec.zxf ?? rec.requiredCredits
      );
      const earned = parseNumOrZero(
        rec.yhxf ?? rec.yxxf ?? rec.hdxf ?? rec.yx ?? rec.earnedCredits
      );
      const inProg = parseNumOrZero(
        rec.zxxf ?? rec.xzzxf ?? rec.inProgressCredits
      );
      const remExplicit = parseNumOrNull(rec.hcyqxf ?? rec.sxxf ?? rec.qxf ?? rec.remainingCredits);
      const rem =
        remExplicit !== null
          ? Math.max(0, remExplicit)
          : req !== null
            ? Math.max(0, Math.round((req - earned) * 100) / 100)
            : null;
      const completedCourses = Math.max(0, parseInt(String(rec.ytgms ?? rec.tgms ?? '0'), 10) || 0);
      const failedCourses = Math.max(0, parseInt(String(rec.wtgms ?? rec.gkms ?? '0'), 10) || 0);
      const statusText =
        String(rec.sfwc ?? rec.zt ?? '').trim() ||
        (req !== null ? (earned >= req ? '已修满' : earned + inProg >= req ? '在修可达标' : '未修满') : undefined);

      // Detect total/root summary row vs category row
      if (/总学分|培养方案总要求|毕业总学分|计划总学分/.test(name)) {
        if (req !== null) totalRequired = req;
        if (earned > totalEarned) totalEarned = earned;
        if (inProg > totalInProgress) totalInProgress = inProg;
        continue;
      }

      pushModule({
        id: `mod-${i}-${name}`,
        name,
        parentName: String(rec.fxfyqmc ?? rec.parentName ?? '').trim() || undefined,
        requiredCredits: req,
        earnedCredits: earned,
        inProgressCredits: inProg,
        remainingCredits: rem,
        completedCourses,
        failedCourses,
        statusText,
      });
    }
  } else if (typeof rawPayload === 'string' && rawPayload.trim()) {
    const html = rawPayload;
    // Try JSON string first
    const trimmed = html.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseZfGraduationAuditResponse(JSON.parse(trimmed), syncedAtIso);
      } catch {
        // Parse HTML below
      }
    }

    // Extract program/major name without student personal info
    const majorMatch = html.match(/(?:专业名称|培养方案)[：:]\s*([^\s<,"']+)/);
    if (majorMatch && majorMatch[1]) {
      programTitle = decodeHtmlText(majorMatch[1]);
    }

    // Match 正方 `xsxyqk` accordion/summary nodes:
    // e.g. "通识教育必修课 ... 要求学分: 38.5 ... 已获得学分: 32 ... 未获得学分: 6.5"
    const blockRe =
      /([\u4e00-\u9fa5A-Za-z0-9（()）]{2,28}(?:必修|选修|核心|实践|通识|平台|模块|环节|课程|拓展|素质))[\s\S]{0,160}?(?:要求(?:最低)?学分|计划学分|应修学分)[^0-9]{0,12}(\d+(?:\.\d+)?)[\s\S]{0,160}?(?:已获得?学分|已修学分|实得学分)[^0-9]{0,12}(\d+(?:\.\d+)?)/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = blockRe.exec(html)) !== null) {
      const name = decodeHtmlText(m[1] || '');
      const req = parseNumOrNull(m[2]);
      const earned = parseNumOrZero(m[3]);
      if (!name || req === null) continue;
      const rem = Math.max(0, Math.round((req - earned) * 100) / 100);
      pushModule({
        id: `mod-html-${idx++}-${name}`,
        name,
        requiredCredits: req,
        earnedCredits: earned,
        inProgressCredits: 0,
        remainingCredits: rem,
        completedCourses: 0,
        failedCourses: 0,
        statusText: earned >= req ? '已修满' : '未修满',
      });
    }

    const totalReqMatch = html.match(/(?:毕业|计划)?(?:总|要求最低)学分[^0-9]{0,14}(\d+(?:\.\d+)?)/);
    const totalEarnedMatch = html.match(/(?:累计|总)?已获得?学分[^0-9]{0,14}(\d+(?:\.\d+)?)/);
    if (totalReqMatch) totalRequired = parseNumOrNull(totalReqMatch[1]);
    if (totalEarnedMatch) totalEarned = parseNumOrZero(totalEarnedMatch[1]);
  }

  if (modules.length === 0 && totalRequired === null) {
    return null;
  }

  if (totalRequired === null && modules.some((m) => m.requiredCredits !== null)) {
    totalRequired =
      Math.round(modules.reduce((acc, m) => acc + (m.requiredCredits ?? 0), 0) * 100) / 100;
  }
  if (totalEarned === 0 && modules.length > 0) {
    totalEarned = Math.round(modules.reduce((acc, m) => acc + m.earnedCredits, 0) * 100) / 100;
  }
  if (totalInProgress === 0 && modules.length > 0) {
    totalInProgress =
      Math.round(modules.reduce((acc, m) => acc + m.inProgressCredits, 0) * 100) / 100;
  }

  const totalRemaining =
    totalRequired !== null
      ? Math.max(0, Math.round((totalRequired - totalEarned) * 100) / 100)
      : null;

  return {
    source: 'official_zf_curriculum',
    sourceLabel: OFFICIAL_CURRICULUM_SOURCE_LABEL,
    syncedAtIso,
    programTitle,
    totalRequiredCredits: totalRequired,
    totalEarnedCredits: totalEarned,
    totalInProgressCredits: totalInProgress,
    totalRemainingCredits: totalRemaining,
    modules,
    note: '具体毕业审核结论以广东海洋大学教务处正式学业审核结果为准。',
  };
}

/**
 * Fallback graduation progress breakdown derived strictly from locally synced grades
 * when the official 正方 `xsxyqk` curriculum endpoint is unavailable or permission-gated.
 * Explicitly labeled `local_grade_estimate` so the user ALWAYS sees the exact data source.
 */
export function buildLocalEstimatedGraduationAudit(
  grades: GradeItem[],
  syncedAtIso: string = new Date().toISOString()
): GraduationAuditReport {
  const summary = computeGpaSummary(grades);
  const failedByCat = new Map<string, number>();
  const passedByCat = new Map<string, number>();
  for (const g of grades) {
    const cat = g.courseCategory || '普通课程';
    if (g.passed) {
      passedByCat.set(cat, (passedByCat.get(cat) ?? 0) + 1);
    } else {
      failedByCat.set(cat, (failedByCat.get(cat) ?? 0) + 1);
    }
  }

  const modules: CurriculumModuleProgress[] = summary.byCategory.map((c, idx) => ({
    id: `est-${idx}-${c.category}`,
    name: c.category,
    requiredCredits: null,
    earnedCredits: c.credits,
    inProgressCredits: 0,
    remainingCredits: null,
    completedCourses: passedByCat.get(c.category) ?? c.count,
    failedCourses: failedByCat.get(c.category) ?? 0,
    statusText: '按已出成绩汇总',
  }));

  return {
    source: 'local_grade_estimate',
    sourceLabel: LOCAL_ESTIMATE_CURRICULUM_SOURCE_LABEL,
    syncedAtIso,
    totalRequiredCredits: null,
    totalEarnedCredits: summary.totalCreditsEarned,
    totalInProgressCredits: 0,
    totalRemainingCredits: null,
    modules,
    note: '当前展示的是已同步成绩单的本地分类学分汇总；重新执行「无痕同步」若教务开放学业情况接口将自动升级为官方培养方案要求核对。',
  };
}

interface RawCampusCourse {
  kcmc?: string;
  kch?: string;
  kch_id?: string;
  jsxm?: string;
  xm?: string;
  cdmc?: string;
  jxdd?: string;
  xqmc?: string;
  sksj?: string;
  xqj?: string | number;
  xqjmc?: string;
  jc?: string;
  jcs?: string;
  jcor?: string;
  zcd?: string;
  xf?: string | number;
  jxbmc?: string;
  skbj?: string;
  bjmc?: string;
}

/**
 * Parse 正方全校/推荐/任务落实课表 JSON 响应为 CourseItem[]（支持合并字符串如
 * `sksj="星期一第1-2节{1-16周};星期三第3-4节{1-16周}"` 与 `jxdd="钟海楼02018;钟海楼02018"`）。
 */
export function parseZfCampusCourseSearchResponse(raw: unknown): CourseItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.items)
    ? (obj.items as RawCampusCourse[])
    : Array.isArray(obj.kbList)
      ? (obj.kbList as RawCampusCourse[])
      : Array.isArray(obj.rows)
        ? (obj.rows as RawCampusCourse[])
        : Array.isArray(raw)
          ? (raw as RawCampusCourse[])
          : [];

  const results: CourseItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const name = String(item.kcmc ?? '').trim();
    if (!name) continue;
    const code = String(item.kch ?? item.kch_id ?? '').trim();
    const teacher = String(item.jsxm ?? item.xm ?? '待定教师').trim();
    const campus = String(item.xqmc ?? '').trim() || '湖光校区';
    const credit = String(item.xf ?? '').trim();
    const classGroup = String(item.jxbmc ?? item.bjmc ?? item.skbj ?? '').trim();

    // Case 1: Combined `sksj` string (e.g. "星期一第1-2节{1-16周};星期三第5-6节{2-16周(双)}")
    const rawSksj = String(item.sksj ?? '').trim();
    const rawJxdd = String(item.jxdd ?? item.cdmc ?? '').trim();
    if (rawSksj && !item.xqj) {
      const timeSegs = rawSksj
        .replace(/<br\s*\/?>/gi, ';')
        .split(/[;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const roomSegs = rawJxdd
        .replace(/<br\s*\/?>/gi, ';')
        .split(/[;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      timeSegs.forEach((seg, segIdx) => {
        const segMatch = seg.match(
          /(星期[一二三四五六日天]|周[一二三四五六日天])[^0-9]*(\d+(?:[-~至]\d+)?)节?\s*(?:\{([^}]+)\}|（([^）]+)）|\(([^)]+)\))/
        );
        const dow = segMatch ? parseDayOfWeek(segMatch[1]) : parseDayOfWeek(seg.slice(0, 3));
        const secRange = segMatch ? parseSectionRange(segMatch[2]) : parseSectionRange(seg);
        const weekText = (segMatch?.[3] || segMatch?.[4] || segMatch?.[5] || '').trim();
        const weeks = parseWeekExpression(weekText);
        const location = roomSegs[segIdx] || roomSegs[0] || '待定教室';

        if (!dow || !secRange || weeks.length === 0) return;
        const dedup = `${name}|${teacher}|${dow}|${secRange.startSection}-${secRange.endSection}|${weekText}|${location}`;
        if (seen.has(dedup)) return;
        seen.add(dedup);

        results.push({
          id: `campus-${code || i}-${dow}-${secRange.startSection}-${secRange.endSection}-${segIdx}`,
          name,
          code,
          teacher,
          location,
          campus,
          dayOfWeek: dow,
          startSection: secRange.startSection,
          endSection: secRange.endSection,
          weeks,
          weekText: weekText || '1-16周',
          credit,
          classGroup,
          colorIndex: stableColorIndex(name),
          isManual: true,
          isAudit: true,
          sourceLabel: OFFICIAL_CAMPUS_COURSE_SOURCE_LABEL,
        });
      });
      continue;
    }

    // Case 2: Discrete `xqj`, `jcs`/`jc`, `zcd` fields (standard kbList format)
    const dow = parseDayOfWeek(item.xqj ?? item.xqjmc);
    const secRange = parseSectionRange(item.jc, item.jcs, item.jcor);
    const weekText = String(item.zcd ?? '').trim();
    const weeks = parseWeekExpression(weekText);
    const location = rawJxdd || '待定教室';
    if (!dow || !secRange || weeks.length === 0) continue;

    const dedup = `${name}|${teacher}|${dow}|${secRange.startSection}-${secRange.endSection}|${weekText}|${location}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    results.push({
      id: `campus-${code || i}-${dow}-${secRange.startSection}-${secRange.endSection}`,
      name,
      code,
      teacher,
      location,
      campus,
      dayOfWeek: dow,
      startSection: secRange.startSection,
      endSection: secRange.endSection,
      weeks,
      weekText: weekText || '1-16周',
      credit,
      classGroup,
      colorIndex: stableColorIndex(name),
      isManual: true,
      isAudit: true,
      sourceLabel: OFFICIAL_CAMPUS_COURSE_SOURCE_LABEL,
    });
  }

  return results;
}
