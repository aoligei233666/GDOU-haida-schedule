import { deriveCurrentTermParams, GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import {
  CourseItem,
  EphemeralCredentials,
  ExamItem,
  GradeItem,
  SyncReceipt,
} from '../types/models';
import { encryptGdouPassword, purgeEphemeralCredentials } from './cryptoAes';
import { parseZfExamResponse } from './examParser';
import { parseZfGradesResponse } from './gradeParser';
import { parseZfScheduleResponse } from './scheduleParser';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface PreparedAuthSession {
  entryFinalUrl: string;
  authOrigin: string; // "https://authserver.gdou.edu.cn"
  jwBaseUrl: string; // "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" or "https://jw.gdou.edu.cn"
  isWebVpn: boolean;
  serviceUrl: string;
  pwdEncryptSalt: string;
  execution: string;
  lt: string;
  alreadyLoggedIn: boolean;
}

export interface MfaChallengeState {
  required: true;
  reAuthUserId: string;
  serviceUrl: string;
  defaultReAuthType: '4' | '3'; // 4 = 企业微信验证码, 3 = 短信验证码
  session: PreparedAuthSession;
  previousSteps: string[];
}

export interface SyncResult {
  courses: CourseItem[];
  exams: ExamItem[];
  grades: GradeItem[];
  termLabel: string;
  academicYear: string;
  semesterCode: string;
  receipt: SyncReceipt;
}

export type OneShotSyncOutcome =
  | { status: 'completed'; result: SyncResult }
  | { status: 'mfa_required'; mfa: MfaChallengeState };

export interface SyncTermOverride {
  xnm?: string;
  xqm?: string;
}

function extractHiddenInput(html: string, idOrName: string): string {
  const tagRegex = new RegExp(
    `<input[^>]+(?:id|name)=["']${idOrName}["'][^>]*>`,
    'gi'
  );
  const matches = html.match(tagRegex);
  if (!matches) return '';
  for (let i = matches.length - 1; i >= 0; i--) {
    const valMatch = matches[i].match(/value=["']([^"']*)["']/i);
    if (valMatch && valMatch[1]) {
      return valMatch[1];
    }
  }
  return '';
}

function extractServiceUrl(html: string): string {
  const m = html.match(/var\s+service\s*=\s*\[\s*["']([^"']+)["']\s*\]/);
  if (m && m[1]) {
    return m[1].replace(/\\\//g, '/');
  }
  return 'https://jw.gdou.edu.cn/sso/jziotlogin';
}

function extractAuthError(html: string): string {
  const patterns = [
    /id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/div>/gi,
    /id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/span>/gi,
    /id=["']formErrorTip2?["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const clean = (m[1] || '').replace(/<[^>]+>/g, '').trim();
      if (clean) return clean;
    }
  }
  return '';
}

/**
 * Step 1: Probe `netcheck.gdou.edu.cn/go.php?code=jw` to initialize WebVPN session (`wfw.gdou.edu.cn`)
 * if off-campus, then fetch `https://authserver.gdou.edu.cn/authserver/login` tokens directly.
 */
export async function prepareGdouAuthSession(): Promise<PreparedAuthSession> {
  const netResp = await fetch(GDOU_ENTRY_URL, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const netFinalUrl = netResp.url || GDOU_ENTRY_URL;
  const netHtml = await netResp.text();
  const isWebVpn = netFinalUrl.includes('wfw.gdou.edu.cn');
  const jwBaseUrl = isWebVpn
    ? 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn'
    : 'https://jw.gdou.edu.cn';

  const serviceUrl = extractServiceUrl(netHtml) || 'https://jw.gdou.edu.cn/sso/jziotlogin';
  const authOrigin = 'https://authserver.gdou.edu.cn';
  const authLoginUrl = `${authOrigin}/authserver/login?service=${encodeURIComponent(serviceUrl)}`;

  let authResp = await fetch(authLoginUrl, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  let authHtml = await authResp.text();
  // If a previous unfinished MFA session left an unverified CASTGC cookie, reset it cleanly
  if (
    (authResp.url || '').includes('reAuthLoginView.do') ||
    authHtml.includes('reAuthParams')
  ) {
    await fetch(`${authOrigin}/authserver/logout`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'User-Agent': DESKTOP_UA },
    }).catch(() => null);
    authResp = await fetch(authLoginUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    authHtml = await authResp.text();
  }

  // Register device browser fingerprint cookie (MULTIFACTOR_BROWSER_FINGERPRINT) AFTER JSESSIONID & route are pinned
  await fetch(`${authOrigin}/authserver/bfp/info?bfp=8F14E45FCEEA167A5A36DEDD4BEA2543`, {
    method: 'GET',
    credentials: 'include',
    headers: { 'User-Agent': DESKTOP_UA },
  }).catch(() => null);

  const pwdEncryptSalt =
    extractHiddenInput(authHtml, 'pwdEncryptSalt') ||
    extractHiddenInput(netHtml, 'pwdEncryptSalt');
  const execution =
    extractHiddenInput(authHtml, 'execution') ||
    extractHiddenInput(netHtml, 'execution');
  const lt = extractHiddenInput(authHtml, 'lt') || extractHiddenInput(netHtml, 'lt');

  const looksLikeJwPortal =
    !authHtml.includes('pwdEncryptSalt') &&
    (authHtml.includes('xskbcx') ||
      authHtml.includes('教学管理信息服务平台') ||
      authHtml.includes('index_initMenu'));

  return {
    entryFinalUrl: authLoginUrl,
    authOrigin,
    jwBaseUrl,
    isWebVpn,
    serviceUrl,
    pwdEncryptSalt,
    execution,
    lt,
    alreadyLoggedIn: looksLikeJwPortal,
  };
}

/**
 * Step 2: Check whether username requires graphic captcha.
 */
export async function checkGdouCaptcha(
  session: PreparedAuthSession,
  username: string
): Promise<{ isNeed: boolean; imageDataUri?: string }> {
  const trimmed = username.trim();
  if (!trimmed) return { isNeed: false };

  const checkUrl = `${session.authOrigin}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(
    trimmed
  )}&_=${Date.now()}`;

  try {
    const resp = await fetch(checkUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { 'User-Agent': DESKTOP_UA },
    });
    const data = (await resp.json()) as { isNeed?: boolean };
    if (!data?.isNeed) {
      return { isNeed: false };
    }
    const imageDataUri = await fetchGdouCaptchaImage(session);
    return { isNeed: true, imageDataUri };
  } catch {
    return { isNeed: false };
  }
}

export async function fetchGdouCaptchaImage(
  session: PreparedAuthSession
): Promise<string | undefined> {
  const imgUrl = `${session.authOrigin}/authserver/getCaptcha.htl?${Date.now()}`;
  const resp = await fetch(imgUrl, {
    method: 'GET',
    credentials: 'include',
    headers: { 'User-Agent': DESKTOP_UA },
  });
  if (!resp.ok) return undefined;
  const buf = await resp.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  return `data:${contentType};base64,${base64}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    result += chars[(triple >> 18) & 63];
    result += chars[(triple >> 12) & 63];
    result += i + 1 < bytes.length ? chars[(triple >> 6) & 63] : '=';
    result += i + 2 < bytes.length ? chars[triple & 63] : '=';
  }
  return result;
}

function encodeFormBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function parseSelectedOption(html: string, selectId: string): string | null {
  const selectRegex = new RegExp(
    `<select[^>]+id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    'i'
  );
  const m = html.match(selectRegex);
  if (!m) return null;
  const optMatch = m[1].match(
    /<option[^>]+selected[^>]*value=["']([^"']*)["']|<option[^>]+value=["']([^"']*)["'][^>]*selected/i
  );
  if (optMatch) {
    return (optMatch[1] || optMatch[2] || '').trim() || null;
  }
  return null;
}

async function detectJwPrefixAndTerm(
  jwBaseUrl: string,
  override?: SyncTermOverride
): Promise<{ prefix: string; xnm: string; xqm: string; termLabel: string }> {
  const derived = deriveCurrentTermParams();
  let chosenPrefix = '';
  let detectedXnm = override?.xnm || '';
  let detectedXqm = override?.xqm || '';

  for (const prefix of ['', '/jwglxt']) {
    try {
      const url = `${jwBaseUrl}${prefix}/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default`;
      const resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'User-Agent': DESKTOP_UA },
      });
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
    } catch {
      // Try next prefix
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

async function fetchJwScheduleJson(
  jwBaseUrl: string,
  prefix: string,
  xnm: string,
  xqm: string
): Promise<unknown> {
  const url = `${jwBaseUrl}${prefix}/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151`;
  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: encodeFormBody({ xnm, xqm, kzlx: 'ck', xsdm: '' }),
  });
  const text = await resp.text();
  const trimmed = text.trim();
  if (
    resp.status === 901 ||
    !trimmed ||
    trimmed.includes('统一身份认证') ||
    trimmed.includes('pwdEncryptSalt') ||
    trimmed.includes('reAuthParams') ||
    (!trimmed.startsWith('{') && !trimmed.startsWith('['))
  ) {
    throw new Error(`教务系统会话尚未激活 (HTTP ${resp.status})，请重试或切换“官方无痕网页同步”`);
  }
  return JSON.parse(trimmed);
}

async function fetchJwExamJson(
  jwBaseUrl: string,
  prefix: string,
  xnm: string,
  xqm: string
): Promise<unknown> {
  const endpoints = [
    `${jwBaseUrl}${prefix}/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105`,
    `${jwBaseUrl}${prefix}/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358110`,
    `${jwBaseUrl}${prefix}/kwgl/kscx_cxXsksxx.html?doType=query&gnmkdm=N358105`,
  ];

  const paramVariants: Record<string, string>[] = [
    {
      xnm,
      xqm,
      ksmcdmb_id: '',
      kch: '',
      kc: '',
      ksrq: '',
      kkbm_id: '',
      _search: 'false',
      nd: String(Date.now()),
      'queryModel.showCount': '100',
      'queryModel.currentPage': '1',
      'queryModel.sortName': '',
      'queryModel.sortOrder': 'asc',
      time: '0',
    },
    {
      xnm,
      xqm: '',
      'queryModel.showCount': '100',
      'queryModel.currentPage': '1',
    },
  ];

  for (const endpoint of endpoints) {
    for (const bodyParams of paramVariants) {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'User-Agent': DESKTOP_UA,
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01',
          },
          body: encodeFormBody(bodyParams),
        });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) continue;
        const parsed = JSON.parse(text) as { items?: unknown[]; rows?: unknown[] };
        const count = Array.isArray(parsed.items)
          ? parsed.items.length
          : Array.isArray(parsed.rows)
            ? parsed.rows.length
            : 0;
        if (count > 0) return parsed;
      } catch {
        // Try next
      }
    }
  }
  return { items: [] };
}

/**
 * Fetch all historical & current semester course grades, credits, and GPAs from
 * 正方教务 `/cjcx/cjcx_cxXsgrcj.html?doType=query&gnmkdm=N305005`.
 */
async function fetchJwGradesJson(jwBaseUrl: string, prefix: string): Promise<unknown> {
  const endpoints = [
    `${jwBaseUrl}${prefix}/cjcx/cjcx_cxXsgrcj.html?doType=query&gnmkdm=N305005`,
    `${jwBaseUrl}${prefix}/cjcx/cjcx_cxDgXscj.html?doType=query&gnmkdm=N305005`,
  ];

  const body = encodeFormBody({
    xnm: '',
    xqm: '',
    _search: 'false',
    nd: String(Date.now()),
    'queryModel.showCount': '5000',
    'queryModel.currentPage': '1',
    'queryModel.sortName': '',
    'queryModel.sortOrder': 'asc',
    time: '0',
  });

  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'User-Agent': DESKTOP_UA,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body,
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.trim().startsWith('{')) {
        return JSON.parse(text);
      }
    } catch {
      // Try next endpoint
    }
  }
  return { items: [] };
}

/**
 * Unconditionally terminate server-side sessions (JWXT + CAS Authserver + WebVPN).
 */
export async function logoutEphemeralSession(
  jwBaseUrl: string,
  authOrigin: string,
  isWebVpn: boolean
): Promise<boolean> {
  const logoutUrls = [
    `${jwBaseUrl}/logout`,
    `${jwBaseUrl}/jwglxt/logout`,
    `${authOrigin}/authserver/logout`,
  ];
  if (isWebVpn) {
    logoutUrls.push('https://wfw.gdou.edu.cn/authserver/logout');
    logoutUrls.push('https://wfw.gdou.edu.cn/logout');
  }

  let anySucceeded = false;
  await Promise.all(
    logoutUrls.map(async (url) => {
      try {
        await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { 'User-Agent': DESKTOP_UA },
        });
        anySucceeded = true;
      } catch {
        // Best-effort
      }
    })
  );
  return anySucceeded;
}

/**
 * Send MFA verification code (企业微信验证码 `4` or 短信验证码 `3`) when GDOU requires reAuth.
 */
export async function requestGdouMfaDynamicCode(
  mfa: MfaChallengeState,
  reAuthType: '4' | '3'
): Promise<string> {
  const origin = mfa.session.authOrigin;
  // Switch reAuthType first if needed
  await fetch(`${origin}/authserver/reAuthCheck/changeReAuthType.do`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: encodeFormBody({
      isMultifactor: 'true',
      reAuthType,
      service: mfa.serviceUrl,
    }),
  }).catch(() => null);

  const authCodeTypeName =
    reAuthType === '4' ? 'reAuthWChatDynamicCodeType' : 'reAuthDynamicCodeType';

  const resp = await fetch(`${origin}/authserver/dynamicCode/getDynamicCodeByReauth.do`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: encodeFormBody({
      userName: mfa.reAuthUserId,
      authCodeTypeName,
    }),
  });

  const rawText = await resp.text();
  let data: { res?: string; returnMessage?: string; mobile?: string } = {};
  try {
    if (rawText.trim().startsWith('{')) {
      data = JSON.parse(rawText.trim()) as {
        res?: string;
        returnMessage?: string;
        mobile?: string;
      };
    }
  } catch {
    // Fallback message below
  }
  return (
    [data.returnMessage, data.mobile].filter(Boolean).join(' ') ||
    (reAuthType === '4' ? '企业微信验证码已发送，请查收' : '短信验证码已发送，请查收')
  );
}

/**
 * Submit MFA dynamic code and complete the one-shot JWXT schedule/exam/grade pull.
 */
export async function submitGdouMfaAndCompleteSync(
  mfa: MfaChallengeState,
  dynamicCode: string,
  reAuthType: '4' | '3',
  termOverride?: SyncTermOverride,
  onProgress?: (step: string) => void
): Promise<SyncResult> {
  const steps = [...mfa.previousSteps];
  const log = (msg: string) => {
    steps.push(msg);
    onProgress?.(msg);
  };

  let shouldLogoutSession = false;

  try {
    const origin = mfa.session.authOrigin;
    // Ensure device fingerprint is bound to the current MFA session (matches common-header.js on reAuthLoginView.do)
    await fetch(`${origin}/authserver/bfp/info?bfp=8F14E45FCEEA167A5A36DEDD4BEA2543`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'User-Agent': DESKTOP_UA },
    }).catch(() => null);

    const submitResp = await fetch(`${origin}/authserver/reAuthCheck/reAuthSubmit.do`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'User-Agent': DESKTOP_UA,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: encodeFormBody({
        service: mfa.serviceUrl,
        reAuthType,
        isMultifactor: 'true',
        password: '',
        dynamicCode: dynamicCode.trim(),
        uuid: '',
        answer1: '',
        answer2: '',
        otpCode: '',
        skipTmpReAuth: 'true',
      }),
    });

    const submitText = (await submitResp.text()).trim();
    let data: { code?: string; msg?: string } = {};
    if (submitText.startsWith('{')) {
      try {
        data = JSON.parse(submitText) as { code?: string; msg?: string };
      } catch {
        // Ignore parse error if non-JSON
      }
    }
    if (data.code === 'reAuth_failed' || data.code === 'reAuth_unauthorized') {
      throw new Error(data.msg || '二次认证验证码错误或已过期，请重新输入');
    }

    shouldLogoutSession = true;
    log('4. 多因子二次认证通过，正在激活教务系统票据...');

    await completeCasToJwHandoff(mfa.session);
    return await pullAllJwDataAndBuildResult(mfa.session, steps, log, termOverride);
  } finally {
    if (shouldLogoutSession) {
      await logoutEphemeralSession(
        mfa.session.jwBaseUrl,
        mfa.session.authOrigin,
        mfa.session.isWebVpn
      );
      log('8. 服务端会话已注销，本地未写入任何账号/密码/验证码/Cookie（用完即删完成）');
    }
  }
}

async function completeCasToJwHandoff(session: PreparedAuthSession): Promise<void> {
  // Request CAS service ticket for jw.gdou.edu.cn/sso/jziotlogin.
  // On Android, MainApplication.kt rewrites `Location: https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-...`
  // to `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-...`, authenticating JWXT in 1 hop.
  // NEVER call `/sso/jziotlogin` a second time without `?ticket=...`, as that resets the JWXT session!
  const jwSsoService = 'https://jw.gdou.edu.cn/sso/jziotlogin';
  const ticketReqUrl = `${session.authOrigin}/authserver/login?service=${encodeURIComponent(
    jwSsoService
  )}`;
  await fetch(ticketReqUrl, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  }).catch(() => null);
}

async function pullAllJwDataAndBuildResult(
  session: PreparedAuthSession,
  steps: string[],
  log: (msg: string) => void,
  termOverride?: SyncTermOverride
): Promise<SyncResult> {
  const { prefix, xnm, xqm, termLabel } = await detectJwPrefixAndTerm(
    session.jwBaseUrl,
    termOverride
  );
  log(`5. 已锁定目标学期：${termLabel} (xnm=${xnm}, xqm=${xqm})`);

  const rawSchedule = await fetchJwScheduleJson(session.jwBaseUrl, prefix, xnm, xqm);
  const parsedSchedule = parseZfScheduleResponse(rawSchedule);
  log(`6. 课表解析完成：共 ${parsedSchedule.courses.length} 项教学安排`);

  const rawExams = await fetchJwExamJson(session.jwBaseUrl, prefix, xnm, xqm);
  const exams = parseZfExamResponse(rawExams);

  const rawGrades = await fetchJwGradesJson(session.jwBaseUrl, prefix);
  const grades = parseZfGradesResponse(rawGrades);
  log(`7. 考试与成绩拉取完成：考试 ${exams.length} 场、成绩/学分记录 ${grades.length} 门`);

  return {
    courses: parsedSchedule.courses,
    exams,
    grades,
    termLabel: parsedSchedule.termLabel || termLabel,
    academicYear: xnm,
    semesterCode: xqm,
    receipt: {
      syncedAtIso: new Date().toISOString(),
      mode: 'direct',
      networkRoute: session.isWebVpn ? 'wfw-webvpn' : 'campus-direct',
      termLabel: parsedSchedule.termLabel || termLabel,
      coursesCount: parsedSchedule.courses.length,
      examsCount: exams.length,
      gradesCount: grades.length,
      credentialsPurged: true,
      sessionLoggedOut: true,
      steps,
    },
  };
}

/**
 * Step 3 (One-Shot Zero-Retention Sync):
 * Authenticates ONCE using ephemeral credentials. If GDOU triggers MFA (`reAuthLoginView.do`),
 * pauses and returns `{ status: 'mfa_required', mfa }` (while still purging raw password immediately!);
 * otherwise fetches courses, exams, and grades/GPA and logs out immediately.
 */
export async function executeOneShotGdouSync(
  session: PreparedAuthSession,
  credentials: EphemeralCredentials,
  termOverride?: SyncTermOverride,
  onProgress?: (step: string) => void
): Promise<OneShotSyncOutcome> {
  const steps: string[] = [];
  const log = (msg: string) => {
    steps.push(msg);
    onProgress?.(msg);
  };

  let keepSessionForMfa = false;

  try {
    log(
      session.isWebVpn
        ? '1. 已接入广海认证中心与校外微门户通道 (wfw.gdou.edu.cn)'
        : '1. 已接入广海校园网直连通道 (jw.gdou.edu.cn)'
    );

    const username = credentials.username.trim();
    const rawPassword = credentials.password;
    const captcha = (credentials.captcha ?? '').trim();

    // Immediately wipe raw credentials from caller's object BEFORE network I/O
    purgeEphemeralCredentials(credentials);

    const loginAction = `${session.authOrigin}/authserver/login?service=${encodeURIComponent(
      session.serviceUrl
    )}`;

    // Fetch fresh salt & execution immediately prior to POST so session & token are 100% synchronized
    let preLoginResp = await fetch(loginAction, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    let preLoginHtml = await preLoginResp.text();
    if (
      (preLoginResp.url || '').includes('reAuthLoginView.do') ||
      preLoginHtml.includes('reAuthParams')
    ) {
      await fetch(`${session.authOrigin}/authserver/logout`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'User-Agent': DESKTOP_UA },
      }).catch(() => null);
      preLoginResp = await fetch(loginAction, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      preLoginHtml = await preLoginResp.text();
    }

    // Bind device fingerprint to active login session (matches common-header.js on /authserver/login)
    await fetch(`${session.authOrigin}/authserver/bfp/info?bfp=8F14E45FCEEA167A5A36DEDD4BEA2543`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'User-Agent': DESKTOP_UA },
    }).catch(() => null);

    const activeSalt = extractHiddenInput(preLoginHtml, 'pwdEncryptSalt') || session.pwdEncryptSalt;
    const activeExecution = extractHiddenInput(preLoginHtml, 'execution') || session.execution;
    const activeLt = extractHiddenInput(preLoginHtml, 'lt') || session.lt;

    const encryptedPwd = encryptGdouPassword(rawPassword, activeSalt);
    log('2. 密码已完成本地 AES-128-CBC 加密，明文密码已从内存清除');

    const loginResp = await fetch(loginAction, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'User-Agent': DESKTOP_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: session.authOrigin,
        Referer: loginAction,
      },
      body: encodeFormBody({
        username,
        password: encryptedPwd,
        captcha,
        _eventId: 'submit',
        cllt: 'userNameLogin',
        dllt: 'generalLogin',
        lt: activeLt,
        execution: activeExecution,
      }),
    });

    const loginFinalUrl = loginResp.url || '';
    const loginHtml = await loginResp.text();

    // Check if GDOU redirected to Multi-Factor Re-Authentication (reAuthLoginView.do)
    if (
      loginFinalUrl.includes('reAuthLoginView.do') ||
      loginHtml.includes('reAuthParams') ||
      loginHtml.includes('多因子认证')
    ) {
      keepSessionForMfa = true;
      // Bind device fingerprint on reAuthLoginView.do (matches common-header.js on reAuthLoginView.do)
      await fetch(`${session.authOrigin}/authserver/bfp/info?bfp=8F14E45FCEEA167A5A36DEDD4BEA2543`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'User-Agent': DESKTOP_UA },
      }).catch(() => null);
      const userIdMatch = loginHtml.match(/"reAuthUserId"\s*:\s*"([^"]+)"/);
      const typeMatch = loginHtml.match(/"reAuthType"\s*:\s*"([34])"/);
      log('3. 账号密码验证通过！广海安全策略要求首次设备完成多因子验证码校验');
      return {
        status: 'mfa_required',
        mfa: {
          required: true,
          reAuthUserId: userIdMatch ? userIdMatch[1] : username,
          serviceUrl: session.serviceUrl,
          defaultReAuthType: (typeMatch?.[1] as '4' | '3') || '4',
          session,
          previousSteps: steps,
        },
      };
    }

    if (loginHtml.includes('pwdEncryptSalt') && (loginHtml.includes('pwdFromId') || loginHtml.includes('loginFromId'))) {
      const errTip = extractAuthError(loginHtml);
      throw new Error(errTip || '学号、密码或验证码错误，请核对后重试');
    }

    log('3. 广海统一身份认证通过，已建立一次性教务临时会话');
    await completeCasToJwHandoff(session);
    const result = await pullAllJwDataAndBuildResult(session, steps, log, termOverride);
    return { status: 'completed', result };
  } finally {
    purgeEphemeralCredentials(credentials);
    if (!keepSessionForMfa) {
      await logoutEphemeralSession(session.jwBaseUrl, session.authOrigin, session.isWebVpn);
      log('8. 服务端会话已注销，本地未写入任何账号/密码/Cookie（用完即删完成）');
    }
  }
}

/**
 * Injected JS for Mode B (Incognito Ephemeral WebView).
 * Pulls schedule, exams, AND grades/GPA/credits from the authenticated JWXT origin,
 * posts pure JSON back to React Native, and immediately logs out.
 */
export function buildIncognitoWebViewSyncScript(override?: SyncTermOverride): string {
  const overrideXnm = JSON.stringify(override?.xnm ?? '');
  const overrideXqm = JSON.stringify(override?.xqm ?? '');

  return `
    (function() {
      if (window.__GDOU_SYNC_RUNNING__) return;
      var href = String(window.location.href || '');
      var html = String(document.documentElement ? document.documentElement.innerHTML : '');
      var isAuthPage =
        html.indexOf('pwdEncryptSalt') !== -1 ||
        html.indexOf('reAuthParams') !== -1 ||
        html.indexOf('统一身份认证') !== -1 ||
        href.indexOf('/authserver/login') !== -1 ||
        href.indexOf('reAuthLoginView') !== -1;
      var isAuthenticatedJwPortal =
        href.indexOf('index_initMenu') !== -1 ||
        html.indexOf('index_initMenu') !== -1 ||
        html.indexOf('教学管理信息服务平台') !== -1 ||
        html.indexOf('xskbcx') !== -1;
      var isJwHost = href.indexOf('jw.gdou.edu.cn') !== -1;
      if (!isJwHost || isAuthPage || !isAuthenticatedJwPortal) return;

      window.__GDOU_SYNC_RUNNING__ = true;

      function post(payload) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }

      function computeJwRoot() {
        if (href.indexOf('wfw.gdou.edu.cn') !== -1) {
          return 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn';
        }
        return 'https://jw.gdou.edu.cn';
      }

      async function run() {
        try {
          post({ type: 'PROGRESS', message: '检测到教务登录成功，正在无痕提取课表、考试与绩点学分...' });
          var root = computeJwRoot();
          var prefix = href.indexOf('/jwglxt/') !== -1 ? '/jwglxt' : '';

          var xnm = ${overrideXnm};
          var xqm = ${overrideXqm};
          var prefixesToTry = prefix ? [prefix, ''] : ['', '/jwglxt'];
          for (var i = 0; i < prefixesToTry.length; i++) {
            var p = prefixesToTry[i];
            try {
              var idxResp = await fetch(root + p + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default', { credentials: 'include' });
              if (!idxResp.ok) continue;
              var idxHtml = await idxResp.text();
              if (idxHtml.indexOf('pwdEncryptSalt') !== -1) continue;
              if (idxHtml.indexOf('xnm') !== -1) {
                prefix = p;
                var doc = new DOMParser().parseFromString(idxHtml, 'text/html');
                var xnmEl = doc.querySelector('#xnm');
                var xqmEl = doc.querySelector('#xqm');
                if (!xnm && xnmEl && xnmEl.value) xnm = xnmEl.value;
                if (!xqm && xqmEl && xqmEl.value) xqm = xqmEl.value;
                break;
              }
            } catch (e) {}
          }

          if (!xnm || !xqm) {
            var now = new Date();
            var y = now.getFullYear();
            var m = now.getMonth() + 1;
            if (!xnm) xnm = String(m >= 8 ? y : y - 1);
            if (!xqm) xqm = (m >= 8 || m === 1) ? '3' : '12';
          }

          post({ type: 'PROGRESS', message: '正在拉取 ' + xnm + ' 学年课表数据...' });
          var kbResp = await fetch(root + prefix + '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: 'xnm=' + encodeURIComponent(xnm) + '&xqm=' + encodeURIComponent(xqm) + '&kzlx=ck&xsdm='
          });
          var kbText = (await kbResp.text()).trim();
          if (!kbText || kbText.charAt(0) !== '{') {
            window.__GDOU_SYNC_RUNNING__ = false;
            return;
          }
          var kbJson = JSON.parse(kbText);

          post({ type: 'PROGRESS', message: '正在拉取考试安排与考场座位...' });
          var examJson = { items: [] };
          var examUrls = [
            root + prefix + '/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105',
            root + prefix + '/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358110',
            root + prefix + '/kwgl/kscx_cxXsksxx.html?doType=query&gnmkdm=N358105'
          ];
          for (var u = 0; u < examUrls.length; u++) {
            try {
              var exResp = await fetch(examUrls[u], {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                body: 'xnm=' + encodeURIComponent(xnm) + '&xqm=' + encodeURIComponent(xqm) + '&queryModel.showCount=100&queryModel.currentPage=1'
              });
              if (!exResp.ok) continue;
              var exText = await exResp.text();
              if (exText.trim().charAt(0) === '{') {
                var parsed = JSON.parse(exText);
                if ((parsed.items && parsed.items.length > 0) || (parsed.rows && parsed.rows.length > 0)) {
                  examJson = parsed;
                  break;
                }
              }
            } catch (e) {}
          }

          post({ type: 'PROGRESS', message: '正在拉取全部学期成绩、绩点与学分...' });
          var gradeJson = { items: [] };
          var gradeUrls = [
            root + prefix + '/cjcx/cjcx_cxXsgrcj.html?doType=query&gnmkdm=N305005',
            root + prefix + '/cjcx/cjcx_cxDgXscj.html?doType=query&gnmkdm=N305005'
          ];
          for (var g = 0; g < gradeUrls.length; g++) {
            try {
              var grResp = await fetch(gradeUrls[g], {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                body: 'xnm=&xqm=&_search=false&queryModel.showCount=5000&queryModel.currentPage=1&time=0'
              });
              if (!grResp.ok) continue;
              var grText = await grResp.text();
              if (grText.trim().charAt(0) === '{') {
                var grParsed = JSON.parse(grText);
                if ((grParsed.items && grParsed.items.length > 0) || (grParsed.rows && grParsed.rows.length > 0)) {
                  gradeJson = grParsed;
                  break;
                }
              }
            } catch (e) {}
          }

          try { await fetch(root + prefix + '/logout', { credentials: 'include' }); } catch (e) {}
          try {
            var authLogout = href.indexOf('wfw.gdou.edu.cn') !== -1
              ? 'https://wfw.gdou.edu.cn/authserver/logout'
              : 'https://authserver.gdou.edu.cn/authserver/logout';
            await fetch(authLogout, { credentials: 'include' });
          } catch (e) {}

          post({
            type: 'SYNC_COMPLETE',
            xnm: xnm,
            xqm: xqm,
            scheduleRaw: kbJson,
            examRaw: examJson,
            gradeRaw: gradeJson
          });
        } catch (err) {
          window.__GDOU_SYNC_RUNNING__ = false;
          post({ type: 'SYNC_ERROR', message: String(err && err.message ? err.message : err) });
        }
      }
      run();
    })();
    true;
  `;
}
