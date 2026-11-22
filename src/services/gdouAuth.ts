import {
  buildExamParamVariants,
  buildGradeQueryParams,
  DEFAULT_DESKTOP_UA,
  GDOU_AUTH_ORIGIN,
  GDOU_AUTH_PATHS,
  GDOU_JW_DIRECT_ORIGIN,
  GDOU_JW_PATHS,
  GDOU_JW_PREFIXES,
  GDOU_JW_SSO_SERVICE,
  GDOU_JW_WFW_BASE,
  GDOU_WFW_ORIGIN,
} from '../constants/gdouEndpoints';
import { deriveCurrentTermParams, GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import {
  CourseItem,
  EphemeralCredentials,
  ExamItem,
  GradeItem,
  LogoutVerificationDetails,
  SyncReceipt,
} from '../types/models';
import {
  areCredentialsPurged,
  encryptGdouPassword,
  generateSecureHex,
  purgeEphemeralCredentials,
} from './cryptoAes';
import { parseZfExamResponse } from './examParser';
import { parseZfGradesResponse } from './gradeParser';
import { parseZfScheduleResponse } from './scheduleParser';

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const OVERALL_SYNC_TIMEOUT_MS = 60_000;

export interface AuthRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  userAgent?: string;
}

/**
 * Legacy compatibility no-op: plaintext passwords are NEVER retained in any module-level global.
 */
export function clearPendingMfaSecret(): void {
  // Intentionally empty: zero module-level credential storage exists.
}

export interface PreparedAuthSession {
  entryFinalUrl: string;
  authOrigin: string; // "https://authserver.gdou.edu.cn"
  jwBaseUrl: string; // "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" or "https://jw.gdou.edu.cn"
  isWebVpn: boolean;
  serviceUrl: string;
  pwdEncryptSalt: string;
  execution: string;
  lt: string;
  ephemeralBfp: string; // per-session CSPRNG 32-char hex device fingerprint
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

export interface CaptchaCheckResult {
  isNeed: boolean;
  imageDataUri?: string;
  checkFailed?: boolean;
  errorMessage?: string;
}

export function isAccountLockedMessage(text: string): boolean {
  const s = String(text ?? '');
  return /冻结|锁定|已被锁|密码错误次数过多|账号异常|account\s*locked|temporarily\s*locked/i.test(s);
}

function createAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Unified bounded-timeout + cancellable fetch wrapper.
 * Every outbound HTTP request in gdouAuth passes through this guard so no request can hang indefinitely.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  options: AuthRequestOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const externalSignal = options.signal;

  if (externalSignal?.aborted) {
    throw createAbortError('已取消本次同步操作');
  }

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort();
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒），请检查网络连接或切换「官网无痕网页」`);
    }
    if (externalSignal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw createAbortError('已取消本次同步操作');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function createBoundedSyncController(externalSignal?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const overallTimer = setTimeout(() => controller.abort(), OVERALL_SYNC_TIMEOUT_MS);
  return {
    controller,
    cleanup: () => {
      clearTimeout(overallTimer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function extractHiddenInput(html: string, idOrName: string): string {
  const tagRegex = new RegExp(`<input[^>]+(?:id|name)=["']${idOrName}["'][^>]*>`, 'gi');
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
  return GDOU_JW_SSO_SERVICE;
}

export function extractAuthError(html: string): string {
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
 * Lightweight network route probe for both Direct and WebView modes:
 * checks whether `netcheck.gdou.edu.cn/go.php?code=jw` redirects to off-campus `wfw.gdou.edu.cn`
 * or stays on campus-direct `jw.gdou.edu.cn`.
 */
export async function probeGdouNetworkRoute(
  options: AuthRequestOptions = {}
): Promise<{ isWebVpn: boolean; finalUrl: string; html: string }> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const netResp = await fetchWithTimeout(
    GDOU_ENTRY_URL,
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
    { ...options, timeoutMs: options.timeoutMs ?? 15_000 }
  );

  const finalUrl = netResp.url || GDOU_ENTRY_URL;
  const html = await netResp.text();
  const isWebVpn = finalUrl.includes('wfw.gdou.edu.cn');
  return { isWebVpn, finalUrl, html };
}

/**
 * Step 1: Probe `netcheck.gdou.edu.cn/go.php?code=jw` to detect campus vs WebVPN route,
 * then fetch `https://authserver.gdou.edu.cn/authserver/login` tokens directly.
 */
export async function prepareGdouAuthSession(
  options: AuthRequestOptions = {}
): Promise<PreparedAuthSession> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const ephemeralBfp = generateSecureHex(16);

  const { isWebVpn, html: netHtml } = await probeGdouNetworkRoute(options);
  const jwBaseUrl = isWebVpn ? GDOU_JW_WFW_BASE : GDOU_JW_DIRECT_ORIGIN;

  // Off-campus WebVPN requires authenticating WFWSESSID via CAS service=https://wfw.gdou.edu.cn/
  const serviceUrl = isWebVpn
    ? `${GDOU_WFW_ORIGIN}/`
    : extractServiceUrl(netHtml) || GDOU_JW_SSO_SERVICE;
  const authOrigin = GDOU_AUTH_ORIGIN;
  const authLoginUrl = `${authOrigin}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(serviceUrl)}`;

  let authResp = await fetchWithTimeout(
    authLoginUrl,
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'X-Gdou-Reset-Cookies-Before': '1',
      },
    },
    options
  );

  let authHtml = await authResp.text();
  if ((authResp.url || '').includes('reAuthLoginView.do') || authHtml.includes('reAuthParams')) {
    try {
      await fetchWithTimeout(
        `${authOrigin}${GDOU_AUTH_PATHS.logout}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'User-Agent': ua, 'X-Gdou-Clear-Cookies-After': '1' },
        },
        { ...options, timeoutMs: 10_000 }
      );
    } catch {
      // Best-effort stale MFA session cleanup before re-fetching login page
    }
    authResp = await fetchWithTimeout(
      authLoginUrl,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      options
    );
    authHtml = await authResp.text();
  }

  // Register ephemeral per-session device fingerprint cookie after JSESSIONID & route are pinned
  try {
    await fetchWithTimeout(
      `${authOrigin}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${ephemeralBfp}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: { 'User-Agent': ua },
      },
      { ...options, timeoutMs: 10_000 }
    );
  } catch {
    // Non-fatal: BFP binding may fail on restricted networks without blocking login
  }

  const pwdEncryptSalt =
    extractHiddenInput(authHtml, 'pwdEncryptSalt') ||
    extractHiddenInput(netHtml, 'pwdEncryptSalt');
  const execution =
    extractHiddenInput(authHtml, 'execution') || extractHiddenInput(netHtml, 'execution');
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
    ephemeralBfp,
    alreadyLoggedIn: looksLikeJwPortal,
  };
}

/**
 * Step 2: Check whether username requires graphic captcha.
 * Fail-closed: reports `checkFailed: true` + `errorMessage` instead of silently hiding network errors.
 */
export async function checkGdouCaptcha(
  session: PreparedAuthSession,
  username: string,
  options: AuthRequestOptions = {}
): Promise<CaptchaCheckResult> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const trimmed = username.trim();
  if (!trimmed) return { isNeed: false };

  const checkUrl = `${session.authOrigin}${GDOU_AUTH_PATHS.checkNeedCaptcha}?username=${encodeURIComponent(
    trimmed
  )}&_=${Date.now()}`;

  try {
    const resp = await fetchWithTimeout(
      checkUrl,
      {
        method: 'GET',
        credentials: 'include',
        headers: { 'User-Agent': ua },
      },
      { ...options, timeoutMs: options.timeoutMs ?? 12_000 }
    );
    if (!resp.ok) {
      return {
        isNeed: false,
        checkFailed: true,
        errorMessage: `验证码状态探测返回 HTTP ${resp.status}`,
      };
    }
    const text = (await resp.text()).trim();
    if (!text.startsWith('{')) {
      return {
        isNeed: false,
        checkFailed: true,
        errorMessage: '验证码状态探测返回了非 JSON 响应，认证会话可能已过期',
      };
    }
    const data = JSON.parse(text) as { isNeed?: boolean };
    if (!data?.isNeed) {
      return { isNeed: false };
    }
    const imageDataUri = await fetchGdouCaptchaImage(session, options);
    if (!imageDataUri) {
      return {
        isNeed: true,
        checkFailed: true,
        errorMessage: '需要图形验证码，但拉取验证码图片失败，请点击刷新重试',
      };
    }
    return { isNeed: true, imageDataUri };
  } catch (err) {
    return {
      isNeed: false,
      checkFailed: true,
      errorMessage: `验证码状态检测失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function fetchGdouCaptchaImage(
  session: PreparedAuthSession,
  options: AuthRequestOptions = {}
): Promise<string | undefined> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const imgUrl = `${session.authOrigin}${GDOU_AUTH_PATHS.getCaptcha}?${Date.now()}`;
  const resp = await fetchWithTimeout(
    imgUrl,
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: session.entryFinalUrl,
      },
    },
    { ...options, timeoutMs: options.timeoutMs ?? 12_000 }
  );
  if (!resp.ok) return undefined;
  const buf = await resp.arrayBuffer();
  if (!buf || buf.byteLength < 64) return undefined;
  const base64 = arrayBufferToBase64(buf);
  const rawType = resp.headers.get('content-type') || 'image/jpeg';
  const mimeType = rawType.split(';')[0].trim() || 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
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

async function fetchJwScheduleJson(
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

async function fetchJwExamJson(
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

  for (const endpoint of endpoints) {
    for (const bodyParams of paramVariants) {
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
        if (!resp.ok) {
          lastError = `HTTP ${resp.status}`;
          continue;
        }
        const text = (await resp.text()).trim();
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

async function fetchJwGradesJson(
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

/**
 * Verify HTTP response status for logout endpoints (2xx or 3xx count as server acknowledgement; 4xx/5xx/network fail do not).
 */
function isLogoutResponseOk(resp: Response): boolean {
  return resp.ok || (resp.status >= 300 && resp.status < 400);
}

/**
 * Unconditionally terminate server-side sessions (JWXT + WebVPN + CAS Authserver) and flush native cookies.
 * Returns REAL verification results (never hardcoded `true`).
 */
export async function logoutEphemeralSession(
  jwBaseUrl: string,
  authOrigin: string,
  isWebVpn: boolean,
  detectedPrefix = '',
  options: AuthRequestOptions = {}
): Promise<LogoutVerificationDetails> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const logoutTimeout = Math.min(options.timeoutMs ?? 12_000, 12_000);

  const preLogoutUrls: string[] = [`${jwBaseUrl}${detectedPrefix}/logout`];
  if (isWebVpn) {
    preLogoutUrls.push(`${GDOU_WFW_ORIGIN}/logout`);
  }

  let attempted = 0;
  let succeeded = 0;
  const failedEndpoints: string[] = [];

  await Promise.all(
    preLogoutUrls.map(async (url) => {
      attempted++;
      try {
        const resp = await fetchWithTimeout(
          url,
          {
            method: 'GET',
            credentials: 'include',
            headers: { 'User-Agent': ua },
          },
          { timeoutMs: logoutTimeout, userAgent: ua }
        );
        if (isLogoutResponseOk(resp)) {
          succeeded++;
        } else {
          failedEndpoints.push(`${url} (HTTP ${resp.status})`);
        }
      } catch (err) {
        failedEndpoints.push(`${url} (${err instanceof Error ? err.message : 'network error'})`);
      }
    })
  );

  // Terminate CAS TGT and instruct native Android OkHttp / iOS GdouEphemeralURLProtocol to wipe all RAM + WebView cookies
  const casLogoutUrl = `${authOrigin}${GDOU_AUTH_PATHS.logout}`;
  attempted++;
  let casLoggedOut = false;
  try {
    const casResp = await fetchWithTimeout(
      casLogoutUrl,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          'X-Gdou-Clear-Cookies-After': '1',
        },
      },
      { timeoutMs: logoutTimeout, userAgent: ua }
    );
    if (isLogoutResponseOk(casResp)) {
      casLoggedOut = true;
      succeeded++;
    } else {
      failedEndpoints.push(`${casLogoutUrl} (HTTP ${casResp.status})`);
    }
  } catch (err) {
    failedEndpoints.push(`${casLogoutUrl} (${err instanceof Error ? err.message : 'network error'})`);
  }

  return {
    attempted,
    succeeded,
    casLoggedOut,
    failedEndpoints,
  };
}

/**
 * Trigger native Android/iOS ephemeral cookie & WebView storage flush (used after WebView sync/close).
 */
export async function flushNativeEphemeralCookies(
  authOrigin: string = GDOU_AUTH_ORIGIN,
  options: AuthRequestOptions = {}
): Promise<boolean> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  try {
    const resp = await fetchWithTimeout(
      `${authOrigin}${GDOU_AUTH_PATHS.logout}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          'X-Gdou-Clear-Cookies-After': '1',
        },
      },
      { timeoutMs: options.timeoutMs ?? 8_000, userAgent: ua }
    );
    return isLogoutResponseOk(resp);
  } catch {
    return false;
  }
}

/**
 * Send MFA verification code (企业微信验证码 `4` or 短信验证码 `3`) when GDOU requires reAuth.
 */
export async function requestGdouMfaDynamicCode(
  mfa: MfaChallengeState,
  reAuthType: '4' | '3',
  options: AuthRequestOptions = {}
): Promise<string> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const origin = mfa.session.authOrigin;

  try {
    await fetchWithTimeout(
      `${origin}${GDOU_AUTH_PATHS.changeReAuthType}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: encodeFormBody({
          isMultifactor: 'true',
          reAuthType,
          service: mfa.serviceUrl,
        }),
      },
      options
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
  }

  const authCodeTypeName =
    reAuthType === '4' ? 'reAuthWChatDynamicCodeType' : 'reAuthDynamicCodeType';

  const resp = await fetchWithTimeout(
    `${origin}${GDOU_AUTH_PATHS.getReAuthCode}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: encodeFormBody({
        userName: mfa.reAuthUserId,
        authCodeTypeName,
      }),
    },
    options
  );

  if (!resp.ok) {
    throw new Error(`发送多因子验证码失败 (HTTP ${resp.status})`);
  }

  const rawText = (await resp.text()).trim();
  let data: { res?: string; returnMessage?: string; mobile?: string } = {};
  if (rawText.startsWith('{')) {
    try {
      data = JSON.parse(rawText) as { res?: string; returnMessage?: string; mobile?: string };
    } catch {
      // Non-JSON response fallback
    }
  }
  return (
    [data.returnMessage, data.mobile].filter(Boolean).join(' ') ||
    (reAuthType === '4' ? '企业微信验证码已发送，请查收' : '短信验证码已发送，请查收')
  );
}

/**
 * Submit MFA dynamic code and complete the one-shot JWXT pull.
 * Zero plaintext password is ever retained across the MFA pause.
 */
export async function submitGdouMfaAndCompleteSync(
  mfa: MfaChallengeState,
  dynamicCode: string,
  reAuthType: '4' | '3',
  termOverride?: SyncTermOverride,
  onProgress?: (step: string) => void,
  options: AuthRequestOptions = {}
): Promise<SyncResult> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const { controller, cleanup } = createBoundedSyncController(options.signal);
  const reqOpts: AuthRequestOptions = { ...options, signal: controller.signal, userAgent: ua };

  const steps = [...mfa.previousSteps];
  const log = (msg: string) => {
    steps.push(msg);
    onProgress?.(msg);
  };

  let shouldLogoutSession = false;
  let detectedPrefix = '';

  try {
    const origin = mfa.session.authOrigin;
    try {
      await fetchWithTimeout(
        `${origin}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${mfa.session.ephemeralBfp}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'User-Agent': ua },
        },
        { ...reqOpts, timeoutMs: 10_000 }
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
    }

    const submitResp = await fetchWithTimeout(
      `${origin}${GDOU_AUTH_PATHS.reAuthSubmit}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
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
      },
      reqOpts
    );

    const submitText = (await submitResp.text()).trim();
    let data: { code?: string; msg?: string } = {};
    if (submitText.startsWith('{')) {
      try {
        data = JSON.parse(submitText) as { code?: string; msg?: string };
      } catch {
        // Non-JSON response
      }
    }
    if (data.code === 'reAuth_failed' || data.code === 'reAuth_unauthorized') {
      throw new Error(data.msg || '二次认证验证码错误或已过期，请重新输入');
    }

    shouldLogoutSession = true;
    log('4. 多因子二次认证通过，正在激活教务系统票据...');

    // Ticket-only handoff (zero plaintext password retained across MFA!)
    await completeCasToJwHandoff(mfa.session, mfa.session.isWebVpn, undefined, reqOpts);

    const pulled = await pullAllJwData(mfa.session, steps, log, termOverride, reqOpts);
    detectedPrefix = pulled.prefix;

    const logoutDetails = await logoutEphemeralSession(
      mfa.session.jwBaseUrl,
      mfa.session.authOrigin,
      mfa.session.isWebVpn,
      detectedPrefix,
      { userAgent: ua }
    );
    shouldLogoutSession = false;

    const sessionLoggedOut =
      logoutDetails.casLoggedOut && logoutDetails.failedEndpoints.length === 0;
    const warnings = [...pulled.warnings];
    if (!sessionLoggedOut) {
      warnings.push(
        `部分远端注销请求未确认成功 (${logoutDetails.succeeded}/${logoutDetails.attempted})，请留意官网登录状态`
      );
      log(
        `8. 本地无痕清理完成，但远端注销仅确认 ${logoutDetails.succeeded}/${logoutDetails.attempted} 项（建议手动核对官网退出）`
      );
    } else {
      log(
        `8. 服务端会话已确认注销（${logoutDetails.succeeded}/${logoutDetails.attempted} 项 HTTP 确认），本地零凭据落盘`
      );
    }

    return {
      courses: pulled.courses,
      exams: pulled.exams,
      grades: pulled.grades,
      termLabel: pulled.termLabel,
      academicYear: pulled.academicYear,
      semesterCode: pulled.semesterCode,
      receipt: {
        syncedAtIso: new Date().toISOString(),
        mode: 'direct',
        networkRoute: mfa.session.isWebVpn ? 'wfw-webvpn' : 'campus-direct',
        termLabel: pulled.termLabel,
        coursesCount: pulled.courses.length,
        examsCount: pulled.exams.length,
        gradesCount: pulled.grades.length,
        credentialsPurged: true,
        sessionLoggedOut,
        logoutDetails,
        warnings: warnings.length > 0 ? warnings : undefined,
        steps,
      },
    };
  } finally {
    cleanup();
    if (shouldLogoutSession) {
      await logoutEphemeralSession(
        mfa.session.jwBaseUrl,
        mfa.session.authOrigin,
        mfa.session.isWebVpn,
        detectedPrefix,
        { userAgent: ua }
      );
    }
  }
}

async function completeCasToJwHandoff(
  session: PreparedAuthSession,
  needWfwActivation: boolean,
  ephemeralForWfw?: { username: string; password: string },
  options: AuthRequestOptions = {}
): Promise<void> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;

  if (session.isWebVpn) {
    if (needWfwActivation) {
      const wfwTicketUrl = `${session.authOrigin}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
        `${GDOU_WFW_ORIGIN}/`
      )}`;
      try {
        await fetchWithTimeout(
          wfwTicketUrl,
          {
            method: 'GET',
            credentials: 'include',
            headers: {
              'User-Agent': ua,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          },
          options
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
      }
    }

    // Request proxied jw entry inside authenticated WFWSESSID
    const jwEntryResp = await fetchWithTimeout(
      GDOU_JW_WFW_BASE,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      options
    );
    const jwEntryHtml = await jwEntryResp.text();
    const salt2 = extractHiddenInput(jwEntryHtml, 'pwdEncryptSalt');
    const exe2 = extractHiddenInput(jwEntryHtml, 'execution');
    const lt2 = extractHiddenInput(jwEntryHtml, 'lt');

    if (!salt2 || !exe2) {
      // Already inside JWXT portal without needing a second proxied login
      return;
    }

    if (!ephemeralForWfw?.username || !ephemeralForWfw?.password) {
      throw new Error(
        '多因子认证已通过，但校外微门户 (wfw) 要求教务子会话独立鉴权。为确保密码绝不驻留内存，请切换顶部「官网无痕网页」完成同步'
      );
    }

    try {
      await fetchWithTimeout(
        `${GDOU_WFW_ORIGIN}/${GDOU_AUTH_ORIGIN}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${session.ephemeralBfp}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'User-Agent': ua },
        },
        { ...options, timeoutMs: 10_000 }
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
    }

    const encryptedPwd2 = encryptGdouPassword(ephemeralForWfw.password, salt2);
    const wfwAuthPostUrl =
      `${GDOU_WFW_ORIGIN}/${GDOU_AUTH_ORIGIN}${GDOU_AUTH_PATHS.login}?service=` +
      encodeURIComponent(GDOU_JW_SSO_SERVICE);

    const wfwPostResp = await fetchWithTimeout(
      wfwAuthPostUrl,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: GDOU_WFW_ORIGIN,
          Referer: GDOU_JW_WFW_BASE,
        },
        body: encodeFormBody({
          username: ephemeralForWfw.username,
          password: encryptedPwd2,
          captcha: '',
          _eventId: 'submit',
          cllt: 'userNameLogin',
          dllt: 'generalLogin',
          lt: lt2,
          execution: exe2,
        }),
      },
      options
    );
    if (wfwPostResp.status === 429) {
      throw new Error('认证请求过于频繁，请等待 30 秒后再试');
    }
    const wfwPostUrl = wfwPostResp.url || '';
    const wfwPostHtml = await wfwPostResp.text();
    if (isAccountLockedMessage(wfwPostHtml)) {
      throw new Error(
        '检测到海大账号已触发临时锁定/冻结保护，已立即熔断停止所有请求。请等待 15–30 分钟自动解冻或前往官方找回密码页面自助解冻。'
      );
    }
    if (
      wfwPostUrl.includes('reAuthLoginView.do') ||
      wfwPostHtml.includes('reAuthParams') ||
      wfwPostHtml.includes('多因子认证')
    ) {
      throw new Error('校外教务通道触发了二次安全验证，请切换顶部「官网无痕网页」完成本次登录');
    }
    if (wfwPostHtml.includes('pwdEncryptSalt')) {
      const tip = extractAuthError(wfwPostHtml);
      if (isAccountLockedMessage(tip)) {
        throw new Error(
          `海大认证提示：${tip}。已立即熔断禁止自动重试，请等待冷却后使用「官网无痕网页」手机验证码登录。`
        );
      }
      throw new Error(
        tip
          ? `校外教务通道二次握手提示：${tip}（为防误锁账号已停止重试，建议切换顶部「官网无痕网页」同步）`
          : '校外教务通道二次握手未通过，建议切换顶部「官网无痕网页」同步'
      );
    }
    return;
  }

  // Campus direct network: CAS redirects straight to https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-...
  const ticketReqUrl = `${session.authOrigin}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
    GDOU_JW_SSO_SERVICE
  )}`;
  await fetchWithTimeout(
    ticketReqUrl,
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    },
    options
  );
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

async function pullAllJwData(
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
  termLabel: string;
  academicYear: string;
  semesterCode: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  let { prefix, xnm, xqm, termLabel } = await detectJwPrefixAndTerm(
    session.jwBaseUrl,
    termOverride,
    options
  );
  log(`5. 已锁定目标学期：${termLabel} (xnm=${xnm}, xqm=${xqm})`);

  let rawSchedule = await fetchJwScheduleJson(session.jwBaseUrl, prefix, xnm, xqm, options);
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
  log(`6. 课表解析完成：共 ${parsedSchedule.courses.length} 项教学安排`);

  const examRes = await fetchJwExamJson(session.jwBaseUrl, prefix, xnm, xqm, options);
  if (examRes.queryWarning) warnings.push(examRes.queryWarning);
  const exams = parseZfExamResponse(examRes.data);

  const gradeRes = await fetchJwGradesJson(session.jwBaseUrl, prefix, options);
  if (gradeRes.queryWarning) warnings.push(gradeRes.queryWarning);
  const grades = parseZfGradesResponse(gradeRes.data);
  log(`7. 考试与成绩拉取完成：考试 ${exams.length} 场、成绩/学分记录 ${grades.length} 门`);

  return {
    prefix,
    courses: parsedSchedule.courses,
    exams,
    grades,
    termLabel: parsedSchedule.termLabel || termLabel,
    academicYear: xnm,
    semesterCode: xqm,
    warnings,
  };
}

/**
 * Step 3 (One-Shot Zero-Retention Sync):
 * Authenticates ONCE using ephemeral credentials, supports AbortSignal cancellation + bounded timeout,
 * enforces lockout circuit breaker, NEVER retains plaintext password in module globals,
 * and computes real verified logout & credential-purge status in SyncReceipt.
 */
export async function executeOneShotGdouSync(
  session: PreparedAuthSession,
  credentials: EphemeralCredentials,
  termOverride?: SyncTermOverride,
  onProgress?: (step: string) => void,
  options: AuthRequestOptions = {}
): Promise<OneShotSyncOutcome> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const { controller, cleanup } = createBoundedSyncController(options.signal);
  const reqOpts: AuthRequestOptions = { ...options, signal: controller.signal, userAgent: ua };

  const steps: string[] = [];
  const log = (msg: string) => {
    steps.push(msg);
    onProgress?.(msg);
  };

  let keepSessionForMfa = false;
  let logoutCompleted = false;
  let detectedPrefix = '';
  let rawPassword = credentials.password;

  try {
    log(
      session.isWebVpn
        ? '1. 已接入海大认证中心与校外微门户通道 (wfw.gdou.edu.cn)'
        : '1. 已接入海大校园网直连通道 (jw.gdou.edu.cn)'
    );

    const username = credentials.username.trim();
    const captcha = (credentials.captcha ?? '').trim();

    // Immediately clear caller's credential object BEFORE network I/O
    purgeEphemeralCredentials(credentials);

    const loginAction = `${session.authOrigin}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
      session.serviceUrl
    )}`;

    let activeSalt = session.pwdEncryptSalt;
    let activeExecution = session.execution;
    let activeLt = session.lt;

    if (!captcha || !activeSalt || !activeExecution) {
      let preLoginResp = await fetchWithTimeout(
        loginAction,
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'User-Agent': ua,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
        reqOpts
      );
      let preLoginHtml = await preLoginResp.text();
      if (
        (preLoginResp.url || '').includes('reAuthLoginView.do') ||
        preLoginHtml.includes('reAuthParams')
      ) {
        try {
          await fetchWithTimeout(
            `${session.authOrigin}${GDOU_AUTH_PATHS.logout}`,
            {
              method: 'GET',
              credentials: 'include',
              headers: { 'User-Agent': ua, 'X-Gdou-Clear-Cookies-After': '1' },
            },
            { ...reqOpts, timeoutMs: 10_000 }
          );
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
        }
        preLoginResp = await fetchWithTimeout(
          loginAction,
          {
            method: 'GET',
            credentials: 'include',
            headers: {
              'User-Agent': ua,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          },
          reqOpts
        );
        preLoginHtml = await preLoginResp.text();
      }
      activeSalt = extractHiddenInput(preLoginHtml, 'pwdEncryptSalt') || activeSalt;
      activeExecution = extractHiddenInput(preLoginHtml, 'execution') || activeExecution;
      activeLt = extractHiddenInput(preLoginHtml, 'lt') || activeLt;

      try {
        await fetchWithTimeout(
          `${session.authOrigin}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${session.ephemeralBfp}`,
          {
            method: 'GET',
            credentials: 'include',
            headers: { 'User-Agent': ua },
          },
          { ...reqOpts, timeoutMs: 10_000 }
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
      }
    }

    // Fail-closed: throws if activeSalt is missing or invalid (NEVER sends plaintext)
    const encryptedPwd = encryptGdouPassword(rawPassword, activeSalt);
    log('2. 密码已完成本地 AES-128-CBC (CSPRNG) 加密，正在提交统一身份认证...');

    const loginResp = await fetchWithTimeout(
      loginAction,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'User-Agent': ua,
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
      },
      reqOpts
    );

    const loginFinalUrl = loginResp.url || '';
    const loginHtml = await loginResp.text();

    // Multi-Factor Re-Authentication (reAuthLoginView.do) — immediately drop rawPassword (zero retention!)
    if (
      loginFinalUrl.includes('reAuthLoginView.do') ||
      loginHtml.includes('reAuthParams') ||
      loginHtml.includes('多因子认证')
    ) {
      keepSessionForMfa = true;
      rawPassword = '';
      try {
        await fetchWithTimeout(
          `${session.authOrigin}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${session.ephemeralBfp}`,
          {
            method: 'GET',
            credentials: 'include',
            headers: { 'User-Agent': ua },
          },
          { ...reqOpts, timeoutMs: 10_000 }
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
      }
      const userIdMatch = loginHtml.match(/"reAuthUserId"\s*:\s*"([^"]+)"/);
      const typeMatch = loginHtml.match(/"reAuthType"\s*:\s*"([34])"/);
      log('3. 账号密码验证通过（密码引用已立即释放）！海大安全策略要求完成多因子验证码校验');
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

    if (isAccountLockedMessage(loginHtml)) {
      rawPassword = '';
      throw new Error(
        '检测到海大账号已触发临时锁定/冻结保护，已立即熔断停止请求。请等待 15–30 分钟自动解冻，或通过海大官方找回密码入口自助解冻。'
      );
    }

    if (
      loginResp.status === 429 ||
      loginHtml.includes('频繁') ||
      loginHtml.includes('Too Many Requests')
    ) {
      rawPassword = '';
      throw new Error('认证请求过于频繁，请等待 30 秒后再试');
    }

    if (
      loginHtml.includes('pwdEncryptSalt') &&
      (loginHtml.includes('pwdFromId') || loginHtml.includes('loginFromId'))
    ) {
      rawPassword = '';
      const errTip = extractAuthError(loginHtml);
      if (isAccountLockedMessage(errTip)) {
        throw new Error(
          `海大认证提示：${errTip}。已立即熔断停止请求，请等待冷却后重试或改用「官网无痕网页」短信验证码登录。`
        );
      }
      throw new Error(errTip || '学号、密码或验证码错误，请核对后重试');
    }

    log('3. 海大统一身份认证通过，正在激活教务系统会话...');
    const needWfwActivation = session.isWebVpn && !loginFinalUrl.includes('wfw.gdou.edu.cn');
    const handoffSecret = session.isWebVpn ? { username, password: rawPassword } : undefined;
    rawPassword = '';
    try {
      await completeCasToJwHandoff(session, needWfwActivation, handoffSecret, reqOpts);
    } finally {
      if (handoffSecret) {
        handoffSecret.username = '';
        handoffSecret.password = '';
      }
    }
    log('4. 教务通道已打通，凭据引用已从内存释放');

    const pulled = await pullAllJwData(session, steps, log, termOverride, reqOpts);
    detectedPrefix = pulled.prefix;

    const logoutDetails = await logoutEphemeralSession(
      session.jwBaseUrl,
      session.authOrigin,
      session.isWebVpn,
      detectedPrefix,
      { userAgent: ua }
    );
    logoutCompleted = true;

    const credentialsPurged = areCredentialsPurged(credentials) && rawPassword === '';
    const sessionLoggedOut =
      logoutDetails.casLoggedOut && logoutDetails.failedEndpoints.length === 0;
    const warnings = [...pulled.warnings];
    if (!sessionLoggedOut) {
      warnings.push(
        `部分远端注销请求未确认成功 (${logoutDetails.succeeded}/${logoutDetails.attempted})，请留意官网登录状态`
      );
      log(
        `8. 本地清理完成，但远端注销仅确认 ${logoutDetails.succeeded}/${logoutDetails.attempted} 项（建议手动确认退出）`
      );
    } else {
      log(
        `8. 服务端会话已确认注销（${logoutDetails.succeeded}/${logoutDetails.attempted} 项 HTTP 确认），本地零凭据落盘`
      );
    }

    return {
      status: 'completed',
      result: {
        courses: pulled.courses,
        exams: pulled.exams,
        grades: pulled.grades,
        termLabel: pulled.termLabel,
        academicYear: pulled.academicYear,
        semesterCode: pulled.semesterCode,
        receipt: {
          syncedAtIso: new Date().toISOString(),
          mode: 'direct',
          networkRoute: session.isWebVpn ? 'wfw-webvpn' : 'campus-direct',
          termLabel: pulled.termLabel,
          coursesCount: pulled.courses.length,
          examsCount: pulled.exams.length,
          gradesCount: pulled.grades.length,
          credentialsPurged,
          sessionLoggedOut,
          logoutDetails,
          warnings: warnings.length > 0 ? warnings : undefined,
          steps,
        },
      },
    };
  } finally {
    rawPassword = '';
    purgeEphemeralCredentials(credentials);
    cleanup();
    if (!keepSessionForMfa && !logoutCompleted) {
      await logoutEphemeralSession(
        session.jwBaseUrl,
        session.authOrigin,
        session.isWebVpn,
        detectedPrefix,
        { userAgent: ua }
      );
    }
  }
}

/**
 * Injected JS for Mode B (Incognito Ephemeral WebView).
 * Shares the EXACT endpoint paths and 3-variant exam query params from `gdouEndpoints.ts`,
 * includes per-session `bridgeToken` authentication, enforces fetch timeouts, clears
 * sessionStorage/localStorage, and reports real HTTP-verified logout status.
 */
export function buildIncognitoWebViewSyncScript(
  override?: SyncTermOverride,
  bridgeToken = ''
): string {
  const overrideXnm = JSON.stringify(override?.xnm ?? '');
  const overrideXqm = JSON.stringify(override?.xqm ?? '');
  const tokenJson = JSON.stringify(bridgeToken);
  const prefixesJson = JSON.stringify(GDOU_JW_PREFIXES);
  const pathsJson = JSON.stringify(GDOU_JW_PATHS);
  const originsJson = JSON.stringify({
    auth: GDOU_AUTH_ORIGIN,
    wfw: GDOU_WFW_ORIGIN,
    jwDirect: GDOU_JW_DIRECT_ORIGIN,
    jwWfw: GDOU_JW_WFW_BASE,
    authLogin: GDOU_AUTH_PATHS.login,
    authLogout: GDOU_AUTH_PATHS.logout,
  });

  return `
    (function() {
      var href = String(window.location.href || '');
      var host = String(window.location.hostname || '');
      var html = String(document.documentElement ? document.documentElement.innerHTML : '');
      var BRIDGE_TOKEN = ${tokenJson};
      var JW_PREFIXES = ${prefixesJson};
      var JW_PATHS = ${pathsJson};
      var ORIGINS = ${originsJson};

      // Idempotency guard per page URL to prevent double execution
      if (window.__GDOU_INJECTED_HREF__ === href && window.__GDOU_SYNC_RUNNING__) return;
      window.__GDOU_INJECTED_HREF__ = href;

      function post(payload) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          payload.bridgeToken = BRIDGE_TOKEN;
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }

      async function timedFetch(url, opts, timeoutMs) {
        var ms = timeoutMs || 20000;
        if (typeof AbortController === 'function') {
          var ac = new AbortController();
          var timer = setTimeout(function() { ac.abort(); }, ms);
          try {
            var merged = Object.assign({}, opts || {}, { signal: ac.signal });
            return await fetch(url, merged);
          } finally {
            clearTimeout(timer);
          }
        }
        return await fetch(url, opts || {});
      }

      function encodeForm(obj) {
        return Object.keys(obj).map(function(k) {
          return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
        }).join('&');
      }

      // 1. Mobile UI adaptation for GDOU authserver & WebVPN pages
      (function adaptMobileLayout() {
        try {
          if (host === 'authserver.gdou.edu.cn' || html.indexOf('pwdEncryptSalt') !== -1 || html.indexOf('reAuthParams') !== -1) {
            var vp = document.querySelector('meta[name="viewport"]');
            if (!vp) {
              vp = document.createElement('meta');
              vp.name = 'viewport';
              document.head && document.head.appendChild(vp);
            }
            vp.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no';

            if (!document.getElementById('__gdou_mobile_fit__')) {
              var style = document.createElement('style');
              style.id = '__gdou_mobile_fit__';
              style.textContent = [
                'html, body { max-width: 100vw !important; min-height: 100vh !important; overflow-x: hidden !important; overflow-y: auto !important; background: #ffffff !important; margin: 0 !important; padding: 0 !important; }',
                '.login-header, .header, .school-logo, .top-logo, .logo-box, .banner, .footer, .copyright, .login-footer { display: none !important; height: 0 !important; margin: 0 !important; padding: 0 !important; }',
                '.index_login { margin: 0 20px !important; padding-top: 8px !important; }',
                '.main, .login-main, .login-box, .auth_page_wrapper, .m-login, .content, #app { padding-top: 6px !important; margin-top: 0 !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; }',
                'form, .loginFromClass { width: 100% !important; max-width: 440px !important; margin: 0 auto !important; box-sizing: border-box !important; }',
                'input[type="text"], input[type="password"], input[type="tel"], input[type="number"] { font-size: 16px !important; }',
                '.btn_login, .login-btn, #login_submit, button[type="submit"] { border-radius: 12px !important; min-height: 46px !important; font-size: 16px !important; }',
                '.background_bj_gray { position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 9998 !important; }',
                '.slidercaptcha-fluid { position: fixed !important; top: 50% !important; left: 50% !important; bottom: auto !important; right: auto !important; transform: translate(-50%, -50%) !important; -webkit-transform: translate(-50%, -50%) !important; width: 320px !important; max-width: 94vw !important; height: auto !important; z-index: 9999 !important; padding: 0 !important; margin: 0 !important; }',
                '.slidercaptcha { left: 0 !important; top: 0 !important; width: 100% !important; max-width: 320px !important; margin: 0 auto !important; touch-action: none !important; }',
                '.slidercaptcha .card-body { padding: 14px 10px 18px !important; }',
                '#sliderDiv { width: 280px !important; margin: 0 auto !important; touch-action: none !important; }',
                '.sliderContainer, .slider, .sliderMask, .sliderbg { touch-action: none !important; }'
              ].join('\\n');
              (document.head || document.documentElement).appendChild(style);
            }
          }
        } catch (e) {}
      })();

      if (window.__GDOU_SYNC_RUNNING__) return;

      var wfwAuthed = false;
      try { wfwAuthed = sessionStorage.getItem('__gdou_wfw_authed__') === '1'; } catch (e) {}

      var isWfwSplash =
        host === 'wfw.gdou.edu.cn' &&
        (html.indexOf('正在跳转到统一认证') !== -1 ||
          html.indexOf('authserver.gdou.edu.cn/authserver/login') !== -1 ||
          document.title.indexOf('正在跳转') !== -1);
      if (isWfwSplash) {
        post({ type: 'PROGRESS', message: '正在打开海大统一身份认证...' });
        return;
      }

      if (!wfwAuthed && href.indexOf('wfw.gdou.edu.cn/https://authserver.gdou.edu.cn') !== -1) {
        post({ type: 'PROGRESS', message: '正在跳转海大官方统一身份认证...' });
        window.location.replace(ORIGINS.auth + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.wfw + '/'));
        return;
      }

      if (host === 'authserver.gdou.edu.cn') {
        if (href.indexOf('reAuthLoginView') !== -1 || html.indexOf('reAuthParams') !== -1) {
          post({ type: 'PROGRESS', message: '第 1 步：请完成海大多因子安全验证（短信 / 企业微信）' });
        } else {
          post({ type: 'PROGRESS', message: '第 1 步：请完成海大统一身份认证（支持滑块验证 / 手机验证码登录）' });
        }
        return;
      }

      if (
        host === 'wfw.gdou.edu.cn' &&
        (href.indexOf('/https://authserver.gdou.edu.cn') !== -1 ||
          href.indexOf('/authserver/login') !== -1 ||
          (href.indexOf('/https://jw.gdou.edu.cn') !== -1 && html.indexOf('pwdEncryptSalt') !== -1))
      ) {
        try {
          if (window.jQuery && window.jQuery.ajaxPrefilter && !window.__gdou_auth_prefilter_fixed__) {
            window.__gdou_auth_prefilter_fixed__ = true;
            window.jQuery.ajaxPrefilter(function(opts) {
              if (opts && typeof opts.url === 'string') {
                var idx = opts.url.indexOf('/authserver/');
                if (idx !== -1 && opts.url.indexOf('wfw.gdou.edu.cn/https://jw.gdou.edu.cn/authserver/') !== -1) {
                  opts.url = opts.url.substring(idx);
                }
              }
            });
          }
        } catch (e) {}
        post({ type: 'PROGRESS', message: '第 2 步：校外通道已激活，请再点一次登录进入教务系统即可自动同步' });
        return;
      }

      var isWfwHome =
        host === 'wfw.gdou.edu.cn' &&
        !isWfwSplash &&
        href.indexOf('jw.gdou.edu.cn') === -1 &&
        href.indexOf('authserver') === -1 &&
        html.indexOf('pwdEncryptSalt') === -1 &&
        html.indexOf('reAuthParams') === -1 &&
        html.indexOf('统一身份认证') === -1;

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

      if (!isWfwHome && (!isJwHost || isAuthPage || !isAuthenticatedJwPortal)) return;

      window.__GDOU_SYNC_RUNNING__ = true;

      function computeJwRoot() {
        return href.indexOf('wfw.gdou.edu.cn') !== -1 ? ORIGINS.jwWfw : ORIGINS.jwDirect;
      }

      async function run() {
        try {
          if (isWfwHome) {
            try { sessionStorage.setItem('__gdou_wfw_authed__', '1'); } catch (e) {}
            post({ type: 'PROGRESS', message: '校外通道已认证，正在检查教务系统会话...' });
          } else {
            post({ type: 'PROGRESS', message: '检测到教务登录成功，正在无痕提取课表、考试与绩点学分...' });
          }

          var root = computeJwRoot();
          var isWebVpn = root === ORIGINS.jwWfw;
          var prefix = href.indexOf('/jwglxt/') !== -1 ? '/jwglxt' : '';

          var xnm = ${overrideXnm};
          var xqm = ${overrideXqm};
          var jwReady = false;
          var prefixesToTry = prefix ? [prefix, ''] : JW_PREFIXES.slice();
          for (var i = 0; i < prefixesToTry.length; i++) {
            var p = prefixesToTry[i];
            try {
              var idxResp = await timedFetch(root + p + JW_PATHS.scheduleIndex, { credentials: 'include' }, 15000);
              if (!idxResp.ok) continue;
              var idxHtml = await idxResp.text();
              if (idxHtml.indexOf('pwdEncryptSalt') !== -1 || idxHtml.indexOf('统一身份认证') !== -1) continue;
              if (idxHtml.indexOf('xnm') !== -1) {
                prefix = p;
                jwReady = true;
                var doc = new DOMParser().parseFromString(idxHtml, 'text/html');
                var xnmEl = doc.querySelector('#xnm');
                var xqmEl = doc.querySelector('#xqm');
                if (!xnm && xnmEl && xnmEl.value) xnm = xnmEl.value;
                if (!xqm && xqmEl && xqmEl.value) xqm = xqmEl.value;
                break;
              }
            } catch (e) {}
          }

          if (!jwReady && isWfwHome) {
            window.__GDOU_SYNC_RUNNING__ = false;
            post({ type: 'PROGRESS', message: '校外通道已激活，正在进入教务登录页...' });
            window.location.href = ORIGINS.jwWfw;
            return;
          }

          if (!xnm || !xqm) {
            var now = new Date();
            var y = now.getFullYear();
            var m = now.getMonth() + 1;
            if (!xnm) xnm = String(m >= 8 ? y : y - 1);
            if (!xqm) xqm = (m >= 8 || m === 1) ? '3' : '12';
          }

          post({ type: 'PROGRESS', message: '正在拉取 ' + xnm + ' 学年课表数据...' });
          var kbResp = await timedFetch(root + prefix + JW_PATHS.scheduleQuery, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: encodeForm({ xnm: xnm, xqm: xqm, kzlx: 'ck', xsdm: '' })
          }, 20000);
          var kbText = (await kbResp.text()).trim();
          if (!kbResp.ok || !kbText || kbText.charAt(0) !== '{') {
            window.__GDOU_SYNC_RUNNING__ = false;
            if (isWfwHome) {
              window.location.href = ORIGINS.jwWfw;
            }
            return;
          }
          var kbJson = JSON.parse(kbText);
          if ((!kbJson.kbList || kbJson.kbList.length === 0) && !${overrideXnm} && !${overrideXqm}) {
            var yNum = parseInt(xnm, 10);
            if (!isNaN(yNum)) {
              var prevXnm = xqm === '3' ? String(yNum - 1) : String(yNum);
              var prevXqm = xqm === '3' ? '12' : '3';
              try {
                var prevResp = await timedFetch(root + prefix + JW_PATHS.scheduleQuery, {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  body: encodeForm({ xnm: prevXnm, xqm: prevXqm, kzlx: 'ck', xsdm: '' })
                }, 15000);
                var prevText = (await prevResp.text()).trim();
                if (prevResp.ok && prevText && prevText.charAt(0) === '{') {
                  var prevJson = JSON.parse(prevText);
                  if (prevJson.kbList && prevJson.kbList.length > 0) {
                    kbJson = prevJson;
                    xnm = prevXnm;
                    xqm = prevXqm;
                  }
                }
              } catch (e) {}
            }
          }

          post({ type: 'PROGRESS', message: '正在拉取考试安排与考场座位...' });
          var examJson = { items: [] };
          var examVariants = [
            { xnm: xnm, xqm: xqm, ksmcdmb_id: '', kch: '', kc: '', ksrq: '', kkbm_id: '', _search: 'false', nd: String(Date.now()), 'queryModel.showCount': '100', 'queryModel.currentPage': '1', 'queryModel.sortName': '', 'queryModel.sortOrder': 'asc', time: '0' },
            { xnm: xnm, xqm: '', 'queryModel.showCount': '100', 'queryModel.currentPage': '1' },
            { xnm: '', xqm: '', 'queryModel.showCount': '100', 'queryModel.currentPage': '1' }
          ];
          for (var u = 0; u < JW_PATHS.examQueries.length && (!examJson.items || examJson.items.length === 0); u++) {
            for (var b = 0; b < examVariants.length; b++) {
              try {
                var exResp = await timedFetch(root + prefix + JW_PATHS.examQueries[u], {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  body: encodeForm(examVariants[b])
                }, 15000);
                if (!exResp.ok) continue;
                var exText = (await exResp.text()).trim();
                if (exText.charAt(0) === '{') {
                  var parsed = JSON.parse(exText);
                  if ((parsed.items && parsed.items.length > 0) || (parsed.rows && parsed.rows.length > 0)) {
                    examJson = parsed;
                    break;
                  }
                }
              } catch (e) {}
            }
          }

          post({ type: 'PROGRESS', message: '正在拉取全部学期成绩、绩点与学分...' });
          var gradeJson = { items: [] };
          var gradeBody = encodeForm({
            xnm: '', xqm: '', _search: 'false', nd: String(Date.now()),
            'queryModel.showCount': '5000', 'queryModel.currentPage': '1',
            'queryModel.sortName': '', 'queryModel.sortOrder': 'asc', time: '0'
          });
          for (var g = 0; g < JW_PATHS.gradeQueries.length; g++) {
            try {
              var grResp = await timedFetch(root + prefix + JW_PATHS.gradeQueries[g], {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                body: gradeBody
              }, 15000);
              if (!grResp.ok) continue;
              var grText = (await grResp.text()).trim();
              if (grText.charAt(0) === '{') {
                var grParsed = JSON.parse(grText);
                if ((grParsed.items && grParsed.items.length > 0) || (grParsed.rows && grParsed.rows.length > 0)) {
                  gradeJson = grParsed;
                  break;
                }
              }
            } catch (e) {}
          }

          // Real HTTP-verified logout + web storage cleanup
          var logoutTargets = [root + prefix + '/logout'];
          if (isWebVpn) logoutTargets.push(ORIGINS.wfw + '/logout');
          var casLogoutUrl = ORIGINS.auth + ORIGINS.authLogout;
          var logoutAttempted = 0;
          var logoutSucceeded = 0;
          var failedEndpoints = [];
          var casLoggedOut = false;

          for (var li = 0; li < logoutTargets.length; li++) {
            logoutAttempted++;
            try {
              var lr = await timedFetch(logoutTargets[li], { credentials: 'include' }, 8000);
              if (lr.ok || (lr.status >= 300 && lr.status < 400)) logoutSucceeded++;
              else failedEndpoints.push(logoutTargets[li] + ' (HTTP ' + lr.status + ')');
            } catch (e) {
              failedEndpoints.push(logoutTargets[li]);
            }
          }
          logoutAttempted++;
          try {
            var casResp = await timedFetch(casLogoutUrl, { credentials: 'include' }, 8000);
            if (casResp.ok || (casResp.status >= 300 && casResp.status < 400)) {
              casLoggedOut = true;
              logoutSucceeded++;
            } else {
              failedEndpoints.push(casLogoutUrl + ' (HTTP ' + casResp.status + ')');
            }
          } catch (e) {
            failedEndpoints.push(casLogoutUrl);
          }

          try { sessionStorage.clear(); } catch (e) {}
          try { localStorage.clear(); } catch (e) {}

          post({
            type: 'SYNC_COMPLETE',
            xnm: xnm,
            xqm: xqm,
            isWebVpn: isWebVpn,
            scheduleRaw: kbJson,
            examRaw: examJson,
            gradeRaw: gradeJson,
            logoutDetails: {
              attempted: logoutAttempted,
              succeeded: logoutSucceeded,
              casLoggedOut: casLoggedOut,
              failedEndpoints: failedEndpoints
            }
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
