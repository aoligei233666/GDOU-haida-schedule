import {
  buildCampusCourseSearchParams,
  buildEmptyClassroomQueryParams,
  buildExamParamVariants,
  buildGradeQueryParams,
  DEFAULT_DESKTOP_UA,
  GDOU_AUTH_PATHS,
  GDOU_AUTH_WFW_BASE,
  GDOU_JW_PATHS,
  GDOU_JW_PREFIXES,
  GDOU_JW_SSO_SERVICE,
  GDOU_WFW_ORIGIN,
  healWfwWrongSsoUrl,
  upgradeGdouHttpToHttps,
} from '../../constants/gdouEndpoints';
import { deriveCurrentTermParams } from '../../constants/gdouTimetable';
import {
  CampusCourseSearchQuery,
  CampusCourseSearchResult,
  CourseItem,
  EmptyClassroomQueryParams,
  EmptyClassroomSnapshot,
  ExamItem,
  GradeItem,
  GraduationAuditReport,
  PeriodTime,
} from '../../types/models';
import {
  buildLocalEstimatedGraduationAudit,
  OFFICIAL_CAMPUS_COURSE_SOURCE_LABEL,
  OFFICIAL_EMPTY_ROOM_SOURCE_LABEL,
  parseEmptyClassroomOptionsHtml,
  parseZfCampusCourseSearchResponse,
  parseZfEmptyClassroomsResponse,
  parseZfGraduationAuditResponse,
} from '../campusToolsParser';
import { parseZfExamResponse } from '../examParser';
import {
  OFFICIAL_GRADE_DETAIL_SOURCE_LABEL,
  parseZfGradesResponse,
  parseZfGradeSubScoresResponse,
} from '../gradeParser';
import {
  getTodayDayOfWeek,
  parseZfPeriodTimesResponse,
  parseZfScheduleResponse,
} from '../scheduleParser';
import { sanitizeEndpointUrl } from '../zeroRetentionSanitizer';
import {
  encodeFormBody,
  fetchWithTimeout,
  isAccountLockedMessage,
  parseSelectedOption,
  sleepAbortable,
} from './httpClient';
import {
  AuthRequestOptions,
  MAX_EXAM_QUERY_ATTEMPTS,
  PreparedAuthSession,
  SyncTermOverride,
} from './types';

export async function detectJwPrefixAndTerm(
  jwBaseUrl: string,
  override?: SyncTermOverride,
  options: AuthRequestOptions = {}
): Promise<{ prefix: string; xnm: string; xqm: string; termLabel: string }> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const derived = deriveCurrentTermParams();
  let chosenPrefix = '';
  let detectedXnm = override?.xnm || '';
  let detectedXqm = override?.xqm || '';

  for (const prefix of GDOU_JW_PREFIXES) {
    try {
      const url = `${jwBaseUrl}${prefix}${GDOU_JW_PATHS.scheduleIndex}`;
      const resp = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'User-Agent': ua },
        },
        options
      );
      if (!resp.ok) continue;
      const html = await resp.text();
      if (html.includes('pwdEncryptSalt') || html.includes('统一身份认证平台')) {
        continue;
      }
      if (html.includes('xnm') || html.includes('xskbcx') || html.includes('课表')) {
        chosenPrefix = prefix;
        if (!detectedXnm) {
          detectedXnm = parseSelectedOption(html, 'xnm') || '';
        }
        if (!detectedXqm) {
          detectedXqm = parseSelectedOption(html, 'xqm') || '';
        }
        break;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
    }
  }

  const xnm = detectedXnm || derived.xnm;
  const xqm = detectedXqm || derived.xqm;
  const semText =
    xqm === '3' ? '第1学期' : xqm === '12' ? '第2学期' : xqm === '16' ? '第3学期' : '当前学期';
  const yearNum = parseInt(xnm, 10);
  const termLabel = Number.isFinite(yearNum)
    ? `${yearNum}-${yearNum + 1}学年 ${semText}`
    : derived.label;

  return { prefix: chosenPrefix, xnm, xqm, termLabel };
}

export async function fetchJwScheduleJson(
  jwBaseUrl: string,
  prefix: string,
  xnm: string,
  xqm: string,
  options: AuthRequestOptions = {}
): Promise<unknown> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const url = `${jwBaseUrl}${prefix}${GDOU_JW_PATHS.scheduleQuery}`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body: encodeFormBody({ xnm, xqm, kzlx: 'ck', xsdm: '' }),
    },
    options
  );
  const text = await resp.text();
  const trimmed = text.trim();
  if (
    !resp.ok ||
    resp.status === 901 ||
    !trimmed ||
    trimmed.includes('统一身份认证') ||
    trimmed.includes('pwdEncryptSalt') ||
    trimmed.includes('reAuthParams') ||
    (!trimmed.startsWith('{') && !trimmed.startsWith('['))
  ) {
    throw new Error(`教务系统会话尚未激活 (HTTP ${resp.status})，请重试或切换“官网无痕网页同步”`);
  }
  return JSON.parse(trimmed);
}

export async function fetchJwExamJson(
  jwBaseUrl: string,
  prefix: string,
  xnm: string,
  xqm: string,
  options: AuthRequestOptions = {}
): Promise<{ data: unknown; queryWarning?: string }> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const endpoints = GDOU_JW_PATHS.examQueries.map((p) => `${jwBaseUrl}${prefix}${p}`);
  const paramVariants = buildExamParamVariants(xnm, xqm);
  let lastError: string | undefined;
  let attempts = 0;

  outer: for (const endpoint of endpoints) {
    for (const bodyParams of paramVariants) {
      if (attempts >= MAX_EXAM_QUERY_ATTEMPTS) break outer;
      if (attempts > 0) {
        await sleepAbortable(200, options.signal);
      }
      attempts++;
      try {
        const resp = await fetchWithTimeout(
          endpoint,
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'User-Agent': ua,
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest',
              Accept: 'application/json, text/javascript, */*; q=0.01',
            },
            body: encodeFormBody(bodyParams),
          },
          options
        );
        if (resp.status === 401 || resp.status === 403 || resp.status === 429 || resp.status === 901) {
          lastError = `HTTP ${resp.status}`;
          break outer;
        }
        if (!resp.ok) {
          lastError = `HTTP ${resp.status}`;
          continue;
        }
        const text = (await resp.text()).trim();
        if (isAccountLockedMessage(text)) {
          lastError = '检测到账号保护限制，已停止考试查询重试';
          break outer;
        }
        if (!text.startsWith('{') && !text.startsWith('[')) continue;
        const parsed = JSON.parse(text) as { items?: unknown[]; rows?: unknown[] };
        const count = Array.isArray(parsed.items)
          ? parsed.items.length
          : Array.isArray(parsed.rows)
            ? parsed.rows.length
            : 0;
        if (count > 0) return { data: parsed };
        lastError = undefined;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return {
    data: { items: [] },
    queryWarning: lastError ? `考试安排接口部分变体失败 (${lastError})` : undefined,
  };
}

export async function fetchJwPeriodTimesJson(
  jwBaseUrl: string,
  prefix: string,
  xnm: string,
  xqm: string,
  campusId?: string,
  options: AuthRequestOptions = {}
): Promise<PeriodTime[]> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const endpoint = `${jwBaseUrl}${prefix}${GDOU_JW_PATHS.periodTimes}`;
  const paramVariants: Record<string, string>[] = [
    { xnm, xqm, xqh_id: campusId || '1' },
    { xnm, xqm },
  ];

  for (const params of paramVariants) {
    try {
      const resp = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'User-Agent': ua,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
          },
          body: encodeFormBody(params),
        },
        { ...options, timeoutMs: Math.min(options.timeoutMs ?? 12_000, 12_000) }
      );
      if (!resp.ok) continue;
      const text = (await resp.text()).trim();
      if (!text.startsWith('{') && !text.startsWith('[')) continue;
      const parsed = parseZfPeriodTimesResponse(JSON.parse(text));
      if (parsed.length >= 8) {
        return parsed;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
    }
  }
  return [];
}

export async function fetchJwGradesJson(
  jwBaseUrl: string,
  prefix: string,
  options: AuthRequestOptions = {}
): Promise<{ data: unknown; queryWarning?: string }> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const endpoints = GDOU_JW_PATHS.gradeQueries.map((p) => `${jwBaseUrl}${prefix}${p}`);
  const body = encodeFormBody(buildGradeQueryParams());
  let lastError: string | undefined;

  for (const endpoint of endpoints) {
    try {
      const resp = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'User-Agent': ua,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
          },
          body,
        },
        options
      );
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        continue;
      }
      const text = (await resp.text()).trim();
      if (text.startsWith('{')) {
        return { data: JSON.parse(text) };
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    data: { items: [] },
    queryWarning: lastError ? `成绩查询接口未返回有效 JSON (${lastError})` : undefined,
  };
}


function derivePreviousTerm(
  xnm: string,
  xqm: string
): { xnm: string; xqm: string; label: string } | null {
  const y = parseInt(xnm, 10);
  if (!Number.isFinite(y)) return null;
  if (xqm === '3') {
    return { xnm: String(y - 1), xqm: '12', label: `${y - 1}-${y}学年 第2学期` };
  }
  return { xnm: String(y), xqm: '3', label: `${y}-${y + 1}学年 第1学期` };
}

export async function fetchJwGradeSubScoresBatch(
  jwBaseUrl: string,
  prefix: string,
  grades: GradeItem[],
  options: AuthRequestOptions = {}
): Promise<GradeItem[]> {
  if (grades.length === 0) return grades;
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const nowIso = new Date().toISOString();
  // Cap to 16 most recent grades that have a `jxbId` so full sync stays fast & bounded
  const candidates = grades.filter((g) => Boolean(g.jxbId && g.rawXnm && g.rawXqm)).slice(0, 16);
  if (candidates.length === 0) return grades;

  const subScoreById = new Map<string, GradeItem['subScores']>();
  const BATCH_SIZE = 4;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    if (options.signal?.aborted) break;
    const chunk = candidates.slice(i, i + BATCH_SIZE);
    await Promise.all(
      chunk.map(async (grade) => {
        for (const detailPath of GDOU_JW_PATHS.gradeDetailQueries) {
          try {
            const resp = await fetchWithTimeout(
              `${jwBaseUrl}${prefix}${detailPath}`,
              {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'User-Agent': ua,
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest',
                  Accept: 'text/html,application/json,*/*;q=0.8',
                },
                body: encodeFormBody({
                  xnm: grade.rawXnm || '',
                  xqm: grade.rawXqm || '',
                  jxb_id: grade.jxbId || '',
                  kcmc: grade.courseName,
                }),
              },
              { ...options, timeoutMs: 6_000 }
            );
            if (!resp.ok) continue;
            const rawText = (await resp.text()).trim();
            if (!rawText || rawText.includes('pwdEncryptSalt')) continue;
            const parsed = parseZfGradeSubScoresResponse(rawText);
            if (parsed.length > 0) {
              subScoreById.set(grade.id, parsed);
              return;
            }
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
          }
        }
      })
    );
  }

  return grades.map((g) => {
    const found = subScoreById.get(g.id);
    if (found && found.length > 0) {
      return {
        ...g,
        subScores: found,
        subScoreSource: 'official_zf_detail' as const,
        subScoreSourceLabel: OFFICIAL_GRADE_DETAIL_SOURCE_LABEL,
        subScoreSyncedAtIso: nowIso,
      };
    }
    return g;
  });
}

export async function fetchJwGraduationAudit(
  jwBaseUrl: string,
  prefix: string,
  grades: GradeItem[],
  options: AuthRequestOptions = {}
): Promise<GraduationAuditReport> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const nowIso = new Date().toISOString();

  // 1) Try official 正方 学业情况 / 培养方案 tree JSON endpoints first
  for (const treePath of GDOU_JW_PATHS.curriculumTreeQueries) {
    try {
      const resp = await fetchWithTimeout(
        `${jwBaseUrl}${prefix}${treePath}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'User-Agent': ua,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/html, */*;q=0.8',
          },
          body: encodeFormBody({
            xfyqjd_id: '',
            cjlrxn: '',
            cjlrxq: '',
            bkcjlrxn: '',
            bkcjlrxq: '',
            xscjcx: '1',
          }),
        },
        { ...options, timeoutMs: 8_000 }
      );
      if (!resp.ok) continue;
      const text = (await resp.text()).trim();
      if (!text || text.includes('pwdEncryptSalt')) continue;
      const parsed = parseZfGraduationAuditResponse(text, nowIso);
      if (parsed && (parsed.modules.length > 0 || parsed.totalRequiredCredits !== null)) {
        return parsed;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
    }
  }

  // 2) Fallback: GET `/xsxy/xsxyqk_cxXsxyqkIndex.html` HTML summary page
  try {
    const htmlResp = await fetchWithTimeout(
      `${jwBaseUrl}${prefix}${GDOU_JW_PATHS.curriculumIndex}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      },
      { ...options, timeoutMs: 8_000 }
    );
    if (htmlResp.ok) {
      const html = await htmlResp.text();
      if (html && !html.includes('pwdEncryptSalt')) {
        const parsed = parseZfGraduationAuditResponse(html, nowIso);
        if (parsed && (parsed.modules.length > 0 || parsed.totalRequiredCredits !== null)) {
          return parsed;
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }

  // 3) Honest, explicitly labeled local fallback from synced grades (never pretends to be official plan)
  return buildLocalEstimatedGraduationAudit(grades, nowIso);
}

export async function fetchJwEmptyClassrooms(
  jwBaseUrl: string,
  prefix: string,
  rawParams: EmptyClassroomQueryParams,
  options: AuthRequestOptions = {}
): Promise<EmptyClassroomSnapshot> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const nowIso = new Date().toISOString();
  let filterOptions: EmptyClassroomSnapshot['filterOptions'];

  // 1) Fetch filter dropdowns (campuses, buildings, room types) from `/cdjy/cdjy_cxKxcdlb.html`
  try {
    const indexResp = await fetchWithTimeout(
      `${jwBaseUrl}${prefix}${GDOU_JW_PATHS.emptyClassroomIndex}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      },
      { ...options, timeoutMs: 10_000 }
    );
    if (indexResp.ok) {
      const html = await indexResp.text();
      if (html && !html.includes('pwdEncryptSalt')) {
        filterOptions = parseEmptyClassroomOptionsHtml(html);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }

  const effectiveParams: EmptyClassroomQueryParams = {
    ...rawParams,
    campusId: rawParams.campusId || filterOptions?.campuses?.[0]?.id || '',
    sections: rawParams.sections.length > 0 ? rawParams.sections : [1, 2],
  };

  const queryBody = encodeFormBody(buildEmptyClassroomQueryParams(effectiveParams));
  const resp = await fetchWithTimeout(
    `${jwBaseUrl}${prefix}${GDOU_JW_PATHS.emptyClassroomQuery}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*;q=0.01',
      },
      body: queryBody,
    },
    { ...options, timeoutMs: 15_000 }
  );

  let rooms: EmptyClassroomSnapshot['rooms'] = [];
  if (resp.ok) {
    const text = (await resp.text()).trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        rooms = parseZfEmptyClassroomsResponse(JSON.parse(text));
      } catch {
        rooms = [];
      }
    }
  }

  const campusName = filterOptions?.campuses.find((c) => c.id === effectiveParams.campusId)?.name;
  const buildingName = filterOptions?.buildings.find((b) => b.id === effectiveParams.buildingId)?.name;

  return {
    queriedAtIso: nowIso,
    sourceLabel: OFFICIAL_EMPTY_ROOM_SOURCE_LABEL,
    params: effectiveParams,
    campusName,
    buildingName,
    rooms,
    filterOptions,
  };
}

export async function fetchJwCampusCourses(
  jwBaseUrl: string,
  prefix: string,
  query: CampusCourseSearchQuery,
  options: AuthRequestOptions = {}
): Promise<CampusCourseSearchResult> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const nowIso = new Date().toISOString();
  const body = encodeFormBody(buildCampusCourseSearchParams(query));

  for (const endpoint of GDOU_JW_PATHS.campusCourseQueries) {
    try {
      const resp = await fetchWithTimeout(
        `${jwBaseUrl}${prefix}${endpoint}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'User-Agent': ua,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*;q=0.01',
          },
          body,
        },
        { ...options, timeoutMs: 15_000 }
      );
      if (!resp.ok) continue;
      const text = (await resp.text()).trim();
      if (!text || (!text.startsWith('{') && !text.startsWith('['))) continue;
      const parsedJson = JSON.parse(text);
      const courses = parseZfCampusCourseSearchResponse(parsedJson);
      if (courses.length > 0) {
        return {
          queriedAtIso: nowIso,
          sourceLabel: OFFICIAL_CAMPUS_COURSE_SOURCE_LABEL,
          query,
          courses,
          endpointUsed: sanitizeEndpointUrl(endpoint),
        };
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
    }
  }

  return {
    queriedAtIso: nowIso,
    sourceLabel: OFFICIAL_CAMPUS_COURSE_SOURCE_LABEL,
    query,
    courses: [],
  };
}

export function guessCurrentSectionBlock(): number[] {
  const h = new Date().getHours();
  if (h < 10) return [1, 2];
  if (h < 12) return [3, 4];
  if (h < 16) return [5, 6];
  if (h < 18) return [7, 8];
  return [9, 10];
}

export async function pullAllJwData(
  session: PreparedAuthSession,
  steps: string[],
  log: (msg: string) => void,
  termOverride?: SyncTermOverride,
  options: AuthRequestOptions = {}
): Promise<{
  prefix: string;
  courses: CourseItem[];
  exams: ExamItem[];
  grades: GradeItem[];
  syncedPeriods?: PeriodTime[];
  detectedCampus?: string;
  graduationAudit?: GraduationAuditReport;
  emptyClassroomSnapshot?: EmptyClassroomSnapshot;
  campusSearchResult?: CampusCourseSearchResult;
  termLabel: string;
  academicYear: string;
  semesterCode: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const job = options.job;
  let { prefix, xnm, xqm, termLabel } = await detectJwPrefixAndTerm(
    session.jwBaseUrl,
    termOverride,
    options
  );
  log(`5. 已锁定目标学期：${termLabel} (xnm=${xnm}, xqm=${xqm})`);

  // Auxiliary Job A: On-demand ephemeral Empty Classroom Query
  if (job?.kind === 'empty_classroom') {
    const queryParams: EmptyClassroomQueryParams = {
      ...job.params,
      xnm: job.params.xnm || xnm,
      xqm: job.params.xqm || xqm,
    };
    log(
      `6. 正在查询第 ${queryParams.week} 周 · 周${queryParams.dayOfWeek} · 第 ${queryParams.sections.join(',')} 节空教室...`
    );
    const snapshot = await fetchJwEmptyClassrooms(session.jwBaseUrl, prefix, queryParams, options);
    log(`7. 空教室查询完成：共找到 ${snapshot.rooms.length} 间可用空闲教室`);
    return {
      prefix,
      courses: [],
      exams: [],
      grades: [],
      emptyClassroomSnapshot: snapshot,
      termLabel,
      academicYear: xnm,
      semesterCode: xqm,
      warnings,
    };
  }

  // Auxiliary Job B: On-demand ephemeral Campus-Wide / Teacher / Class Course Search
  if (job?.kind === 'campus_search') {
    const query: CampusCourseSearchQuery = {
      ...job.query,
      xnm: job.query.xnm || xnm,
      xqm: job.query.xqm || xqm,
    };
    log(`6. 正在检索全校/教师/班级课表（关键词：${query.keyword || query.teacher || query.className || '全部'}）...`);
    const searchRes = await fetchJwCampusCourses(session.jwBaseUrl, prefix, query, options);
    log(`7. 全校课表检索完成：命中 ${searchRes.courses.length} 条开课记录`);
    return {
      prefix,
      courses: [],
      exams: [],
      grades: [],
      campusSearchResult: searchRes,
      termLabel,
      academicYear: xnm,
      semesterCode: xqm,
      warnings,
    };
  }

  let rawSchedule: unknown;
  try {
    rawSchedule = await fetchJwScheduleJson(session.jwBaseUrl, prefix, xnm, xqm, options);
  } catch (firstErr) {
    if (firstErr instanceof Error && firstErr.name === 'AbortError') throw firstErr;
    // Automatic 1-shot CAS->JWXT ticket recovery if JWXT returned HTTP 901 before cookie settled
    const retryCasBase = session.isWebVpn
      ? session.authOrigin === GDOU_AUTH_WFW_BASE
        ? GDOU_AUTH_WFW_BASE
        : GDOU_WFW_ORIGIN
      : session.authOrigin;
    const retryResp = await fetchWithTimeout(
      `${retryCasBase}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(GDOU_JW_SSO_SERVICE)}`,
      {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual',
        headers: {
          'User-Agent': options.userAgent ?? DEFAULT_DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      options
    );
    if (retryResp.status >= 300 && retryResp.status < 400) {
      const retryLoc = (retryResp.headers.get('location') || '').trim();
      if (retryLoc) {
        const up = upgradeGdouHttpToHttps(retryLoc) ?? retryLoc;
        const wrapped = session.isWebVpn ? healWfwWrongSsoUrl(up, true) ?? up : up;
        await fetchWithTimeout(
          wrapped,
          {
            method: 'GET',
            credentials: 'include',
            headers: {
              'User-Agent': options.userAgent ?? DEFAULT_DESKTOP_UA,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          },
          options
        );
      }
    }
    const redetected = await detectJwPrefixAndTerm(session.jwBaseUrl, termOverride, options);
    prefix = redetected.prefix;
    xnm = redetected.xnm;
    xqm = redetected.xqm;
    termLabel = redetected.termLabel;
    rawSchedule = await fetchJwScheduleJson(session.jwBaseUrl, prefix, xnm, xqm, options);
  }
  let parsedSchedule = parseZfScheduleResponse(rawSchedule);

  // If current default term hasn't published courses yet and user didn't force a term, auto-fallback to previous term
  if (parsedSchedule.courses.length === 0 && !termOverride?.xnm && !termOverride?.xqm) {
    const prev = derivePreviousTerm(xnm, xqm);
    if (prev) {
      try {
        const prevRaw = await fetchJwScheduleJson(
          session.jwBaseUrl,
          prefix,
          prev.xnm,
          prev.xqm,
          options
        );
        const prevParsed = parseZfScheduleResponse(prevRaw);
        if (prevParsed.courses.length > 0) {
          xnm = prev.xnm;
          xqm = prev.xqm;
          termLabel = prevParsed.termLabel || prev.label;
          rawSchedule = prevRaw;
          parsedSchedule = prevParsed;
          log(`5b. 当前默认学期暂无排课，已自动切换至上一学期：${termLabel}`);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
      }
    }
  }
  if (parsedSchedule.warnings.length > 0) {
    warnings.push(...parsedSchedule.warnings);
  }

  const syncedPeriods = await fetchJwPeriodTimesJson(
    session.jwBaseUrl,
    prefix,
    xnm,
    xqm,
    parsedSchedule.campusId,
    options
  );
  log(
    syncedPeriods.length >= 8
      ? `6. 课表解析完成：共 ${parsedSchedule.courses.length} 项教学安排（已同步教务官方 ${syncedPeriods.length} 节作息时间）`
      : `6. 课表解析完成：共 ${parsedSchedule.courses.length} 项教学安排`
  );

  const examRes = await fetchJwExamJson(session.jwBaseUrl, prefix, xnm, xqm, options);
  if (examRes.queryWarning) warnings.push(examRes.queryWarning);
  const exams = parseZfExamResponse(examRes.data);

  const gradeRes = await fetchJwGradesJson(session.jwBaseUrl, prefix, options);
  if (gradeRes.queryWarning) warnings.push(gradeRes.queryWarning);
  const baseGrades = parseZfGradesResponse(gradeRes.data);

  // Best-effort parallel pull of Grade Sub-scores, Graduation Curriculum Audit, and Today's Empty Room Snapshot
  const [grades, graduationAudit, emptyClassroomSnapshot] = await Promise.all([
    fetchJwGradeSubScoresBatch(session.jwBaseUrl, prefix, baseGrades, options).catch(
      () => baseGrades
    ),
    fetchJwGraduationAudit(session.jwBaseUrl, prefix, baseGrades, options).catch(() =>
      buildLocalEstimatedGraduationAudit(baseGrades)
    ),
    fetchJwEmptyClassrooms(
      session.jwBaseUrl,
      prefix,
      {
        xnm,
        xqm,
        campusId: parsedSchedule.campusId || '',
        buildingId: '',
        roomTypeId: '',
        week: 1,
        dayOfWeek: getTodayDayOfWeek(),
        sections: guessCurrentSectionBlock(),
      },
      { ...options, timeoutMs: 8_000 }
    ).catch(() => undefined),
  ]);

  const detailCount = grades.filter((g) => g.subScores && g.subScores.length > 0).length;
  log(
    `7. 考试与成绩拉取完成：考试 ${exams.length} 场、成绩 ${grades.length} 门${
      detailCount > 0 ? `（含 ${detailCount} 门分项明细）` : ''
    }${graduationAudit.source === 'official_zf_curriculum' ? '、已同步培养方案学分进度' : ''}`
  );

  return {
    prefix,
    courses: parsedSchedule.courses,
    exams,
    grades,
    syncedPeriods: syncedPeriods.length >= 8 ? syncedPeriods : undefined,
    detectedCampus: parsedSchedule.campusName,
    graduationAudit,
    emptyClassroomSnapshot:
      emptyClassroomSnapshot && emptyClassroomSnapshot.rooms.length > 0
        ? emptyClassroomSnapshot
        : undefined,
    termLabel: parsedSchedule.termLabel || termLabel,
    academicYear: xnm,
    semesterCode: xqm,
    warnings,
  };
}
