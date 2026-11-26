import {
  buildCampusCourseSearchParams,
  buildEmptyClassroomQueryParams,
  buildExamParamVariants,
  buildGradeQueryParams,
  buildZhengfangBitmask,
  DEFAULT_DESKTOP_UA,
  extractSafeHostname,
  GDOU_AUTH_ORIGIN,
  GDOU_AUTH_PATHS,
  GDOU_AUTH_WFW_BASE,
  GDOU_JW_DIRECT_ORIGIN,
  GDOU_JW_PATHS,
  GDOU_JW_PREFIXES,
  GDOU_JW_SSO_SERVICE,
  GDOU_JW_WFW_BASE,
  GDOU_JW_WFW_SSO_SERVICE,
  GDOU_WFW_ORIGIN,
  healWfwWrongSsoUrl,
  upgradeGdouHttpToHttps,
} from '../constants/gdouEndpoints';
import { deriveCurrentTermParams, GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import {
  CampusCourseSearchQuery,
  CampusCourseSearchResult,
  CourseItem,
  EmptyClassroomQueryParams,
  EmptyClassroomSnapshot,
  EphemeralCredentials,
  ExamItem,
  GradeItem,
  GraduationAuditReport,
  LogoutVerificationDetails,
  PeriodTime,
  SyncReceipt,
} from '../types/models';
import {
  buildLocalEstimatedGraduationAudit,
  OFFICIAL_CAMPUS_COURSE_SOURCE_LABEL,
  OFFICIAL_EMPTY_ROOM_SOURCE_LABEL,
  parseEmptyClassroomOptionsHtml,
  parseZfCampusCourseSearchResponse,
  parseZfEmptyClassroomsResponse,
  parseZfGraduationAuditResponse,
} from './campusToolsParser';
import {
  areCredentialsPurged,
  encryptGdouPassword,
  generateSecureHex,
  purgeEphemeralCredentials,
} from './cryptoAes';
import { parseZfExamResponse } from './examParser';
import {
  OFFICIAL_GRADE_DETAIL_SOURCE_LABEL,
  parseZfGradesResponse,
  parseZfGradeSubScoresResponse,
} from './gradeParser';
import {
  getTodayDayOfWeek,
  parseZfPeriodTimesResponse,
  parseZfScheduleResponse,
} from './scheduleParser';
import { sanitizeEndpointUrl } from './zeroRetentionSanitizer';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const OVERALL_SYNC_TIMEOUT_MS = 90_000;
const NETCHECK_PROBE_TIMEOUT_MS = 6_000;
const DIRECT_JW_PROBE_TIMEOUT_MS = 3_500;
const OVERALL_TIMEOUT_REASON = 'GDOU_OVERALL_SYNC_TIMEOUT';
const MAX_EXAM_QUERY_ATTEMPTS = 4;

export type GdouRoutePref = 'auto' | 'wfw' | 'campus';

/**
 * Detect whether code is running inside the native React Native runtime (Android/iOS),
 * where our native OkHttp / URLProtocol interceptor is guaranteed to strip `X-Gdou-*`
 * internal control headers before any bytes hit the wire.
 */
export function isNativeMobileRuntime(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.product === 'string' &&
    navigator.product === 'ReactNative'
  );
}

function stripInternalControlHeaders(headers?: HeadersInit): HeadersInit | undefined {
  if (!headers) return headers;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const clean = new Headers();
    headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('x-gdou-')) {
        clean.append(key, value);
      }
    });
    return clean;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([key]) => !String(key).toLowerCase().startsWith('x-gdou-'));
  }
  const cleanObj: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.toLowerCase().startsWith('x-gdou-')) {
      cleanObj[key] = value;
    }
  }
  return cleanObj;
}

function buildHeadersWithOptionalNativeControl(
  base: Record<string, string>,
  controlHeader?:
    | 'X-Gdou-Reset-Cookies-Before'
    | 'X-Gdou-Clear-Cookies-After'
    | 'X-Gdou-Direct-Probe'
): Record<string, string> {
  if (controlHeader && isNativeMobileRuntime()) {
    return { ...base, [controlHeader]: '1' };
  }
  return base;
}

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw createAbortError('已取消本次同步操作');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError('已取消本次同步操作'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type AuxiliarySyncJob =
  | { kind: 'full_sync' }
  | { kind: 'empty_classroom'; params: EmptyClassroomQueryParams }
  | { kind: 'campus_search'; query: CampusCourseSearchQuery };

export interface AuthRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  userAgent?: string;
  job?: AuxiliarySyncJob;
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
  preparedAtMs?: number;
}

export interface MfaChallengeState {
  required: true;
  reAuthUserId: string;
  serviceUrl: string;
  defaultReAuthType: '4' | '3'; // 4 = 企业微信验证码, 3 = 短信验证码
  credentialsPurged: boolean;
  session: PreparedAuthSession;
  previousSteps: string[];
}

/**
 * Off-campus WebVPN (`wfw.gdou.edu.cn`) sub-session auth handoff state after MFA passes.
 * Contains ZERO plaintext password (strict P0-5 zero-retention compliance).
 */
export interface WfwSubAuthState {
  required: true;
  username: string;
  salt2: string;
  execution2: string;
  lt2: string;
  needCaptcha: boolean;
  captchaImageUri?: string;
  session: PreparedAuthSession;
  previousSteps: string[];
}

export interface SyncResult {
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
  receipt: SyncReceipt;
}

export type OneShotSyncOutcome =
  | { status: 'completed'; result: SyncResult }
  | { status: 'mfa_required'; mfa: MfaChallengeState }
  | { status: 'wfw_subauth_required'; subAuth: WfwSubAuthState };

export type MfaCompletionOutcome =
  | { status: 'completed'; result: SyncResult }
  | { status: 'wfw_subauth_required'; subAuth: WfwSubAuthState }
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
    if (externalSignal.reason === OVERALL_TIMEOUT_REASON) {
      throw new Error(
        `整体同步超时（${Math.round(OVERALL_SYNC_TIMEOUT_MS / 1000)} 秒），请检查网络连接（若开启代理/VPN 请先关闭）或切换「官网无痕网页」`
      );
    }
    throw createAbortError('已取消本次同步操作');
  }

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const safeHeaders = isNativeMobileRuntime()
      ? init.headers
      : stripInternalControlHeaders(init.headers);
    return await fetch(url, {
      ...init,
      headers: safeHeaders,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      const host = extractSafeHostname(url);
      if (host === 'jw.gdou.edu.cn') {
        throw new Error(
          `请求超时（连接 jw.gdou.edu.cn 超过 ${secs} 秒）：校园网直连不可达，请切换上方「校外微门户」通道重试`
        );
      }
      if (host) {
        throw new Error(
          `请求超时（连接 ${host} 超过 ${secs} 秒），请检查网络连接（若开启 VPN/代理 请先关闭）或切换「官网无痕网页」`
        );
      }
      throw new Error(`请求超时（${secs} 秒），请检查网络连接或切换「官网无痕网页」`);
    }
    if (externalSignal?.aborted) {
      if (externalSignal.reason === OVERALL_TIMEOUT_REASON) {
        throw new Error(
          `整体同步超时（${Math.round(OVERALL_SYNC_TIMEOUT_MS / 1000)} 秒），请检查网络连接（若开启代理/VPN 请先关闭）或切换「官网无痕网页」`
        );
      }
      throw createAbortError('已取消本次同步操作');
    }
    if (err instanceof Error && err.name === 'AbortError') {
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
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const overallTimer = setTimeout(
    () => controller.abort(OVERALL_TIMEOUT_REASON),
    OVERALL_SYNC_TIMEOUT_MS
  );
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
 * Fast reachability check for campus-only `jw.gdou.edu.cn` (3.5s bounded timeout).
 * Uses `X-Gdou-Direct-Probe: 1` so native interceptors never rewrite this probe to `wfw`.
 * Prevents off-campus carrier IPs misclassified by `netcheck` from stalling for 20-30s on TCP SYN drop.
 */
async function probeDirectJwReachable(options: AuthRequestOptions = {}): Promise<boolean> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  try {
    const resp = await fetchWithTimeout(
      GDOU_JW_SSO_SERVICE,
      {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        headers: buildHeadersWithOptionalNativeControl(
          { 'User-Agent': ua },
          'X-Gdou-Direct-Probe'
        ),
      },
      { ...options, timeoutMs: DIRECT_JW_PROBE_TIMEOUT_MS }
    );
    return resp.status > 0 && resp.status < 500;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return false;
  }
}

/**
 * Lightweight, fail-safe network route probe for both Direct and WebView modes:
 * 1) Inspects `netcheck.gdou.edu.cn/go.php?code=jw` with `redirect: 'manual'` (fast 6s timeout, 1 hop).
 * 2) If `Location` points to `wfw.gdou.edu.cn`, immediately returns off-campus `isWebVpn: true` (~200ms).
 * 3) If `netcheck` points to campus `jw.gdou.edu.cn` OR times out/fails, verifies real reachability
 *    of `jw.gdou.edu.cn` within 3.5s and automatically falls back to `wfw.gdou.edu.cn` when unreachable
 *    so off-campus mobile networks never hang waiting on campus-only `jw.gdou.edu.cn`.
 */
export async function probeGdouNetworkRoute(
  options: AuthRequestOptions = {}
): Promise<{ isWebVpn: boolean; finalUrl: string; html: string }> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  try {
    const netResp = await fetchWithTimeout(
      GDOU_ENTRY_URL,
      {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        headers: {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      { ...options, timeoutMs: Math.min(options.timeoutMs ?? NETCHECK_PROBE_TIMEOUT_MS, 8_000) }
    );

    if (netResp.status >= 300 && netResp.status < 400) {
      const loc = (netResp.headers.get('location') || '').trim();
      if (loc.includes('wfw.gdou.edu.cn')) {
        return { isWebVpn: true, finalUrl: loc, html: '' };
      }
      if (loc.includes('jw.gdou.edu.cn')) {
        const directOk = await probeDirectJwReachable(options);
        return {
          isWebVpn: !directOk,
          finalUrl: directOk ? loc : GDOU_JW_WFW_BASE,
          html: '',
        };
      }
    }

    const finalUrl = netResp.url || GDOU_ENTRY_URL;
    const html = await netResp.text();
    if (finalUrl.includes('wfw.gdou.edu.cn') || html.includes('wfw.gdou.edu.cn')) {
      return { isWebVpn: true, finalUrl: finalUrl.includes('wfw.gdou.edu.cn') ? finalUrl : GDOU_JW_WFW_BASE, html };
    }
    const directOk = await probeDirectJwReachable(options);
    return {
      isWebVpn: !directOk,
      finalUrl: directOk ? finalUrl : GDOU_JW_WFW_BASE,
      html,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const directOk = await probeDirectJwReachable(options);
    return {
      isWebVpn: !directOk,
      finalUrl: directOk ? GDOU_JW_DIRECT_ORIGIN : GDOU_JW_WFW_BASE,
      html: '',
    };
  }
}

/**
 * Step 1: Resolve campus vs WebVPN route (supports explicit `routePref` override or fail-safe auto probe),
 * then fetch `https://authserver.gdou.edu.cn/authserver/login` tokens directly.
 */
export async function prepareGdouAuthSession(
  options: AuthRequestOptions & { routePref?: GdouRoutePref } = {}
): Promise<PreparedAuthSession> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const ephemeralBfp = generateSecureHex(16);
  const routePref: GdouRoutePref = options.routePref ?? 'auto';

  let isWebVpn: boolean;
  let netHtml = '';
  if (routePref === 'wfw') {
    isWebVpn = true;
  } else if (routePref === 'campus') {
    isWebVpn = false;
  } else {
    const probed = await probeGdouNetworkRoute(options);
    isWebVpn = probed.isWebVpn;
    netHtml = probed.html;
  }
  const jwBaseUrl = isWebVpn ? GDOU_JW_WFW_BASE : GDOU_JW_DIRECT_ORIGIN;

  // CRITICAL (Off-campus WebVPN): wfw.gdou.edu.cn requires authenticating WFWSESSID first
  // via real authserver.gdou.edu.cn with service=https://wfw.gdou.edu.cn/ before storing jw sessions.
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
      headers: buildHeadersWithOptionalNativeControl(
        {
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        'X-Gdou-Reset-Cookies-Before'
      ),
    },
    options
  );
  if (authResp.status === 403) {
    throw new Error('海大认证中心返回 HTTP 403，请关闭手机 VPN / 代理或切换 4G/5G 流量后重试');
  }

  let authHtml = await authResp.text();
  if ((authResp.url || '').includes('reAuthLoginView.do') || authHtml.includes('reAuthParams')) {
    try {
      await fetchWithTimeout(
        `${authOrigin}${GDOU_AUTH_PATHS.logout}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: buildHeadersWithOptionalNativeControl(
            { 'User-Agent': ua },
            'X-Gdou-Clear-Cookies-After'
          ),
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
    preparedAtMs: Date.now(),
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

async function fetchJwPeriodTimesJson(
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
    if (authOrigin !== GDOU_AUTH_ORIGIN) {
      preLogoutUrls.push(`${authOrigin}${GDOU_AUTH_PATHS.logout}`);
    }
  }

  let attempted = 0;
  let succeeded = 0;
  const failedEndpoints: string[] = [];

  await Promise.all(
    preLogoutUrls.map(async (url) => {
      const safeEndpoint = sanitizeEndpointUrl(url);
      attempted++;
      try {
        const resp = await fetchWithTimeout(
          url,
          {
            method: 'GET',
            credentials: 'include',
            headers: { 'User-Agent': ua },
          },
          { timeoutMs: logoutTimeout, userAgent: ua, signal: options.signal }
        );
        if (isLogoutResponseOk(resp)) {
          succeeded++;
        } else {
          failedEndpoints.push(`${safeEndpoint} (HTTP ${resp.status})`);
        }
      } catch (err) {
        failedEndpoints.push(`${safeEndpoint} (${err instanceof Error ? err.message : 'network error'})`);
      }
    })
  );

  // Terminate outer CAS TGT and instruct native Android OkHttp / iOS GdouEphemeralURLProtocol to wipe all RAM + WebView cookies
  const casLogoutUrl = `${GDOU_AUTH_ORIGIN}${GDOU_AUTH_PATHS.logout}`;
  const safeCasLogout = sanitizeEndpointUrl(casLogoutUrl);
  attempted++;
  let casLoggedOut = false;
  try {
    const casResp = await fetchWithTimeout(
      casLogoutUrl,
      {
        method: 'GET',
        credentials: 'include',
        headers: buildHeadersWithOptionalNativeControl(
          { 'User-Agent': ua },
          'X-Gdou-Clear-Cookies-After'
        ),
      },
      { timeoutMs: logoutTimeout, userAgent: ua, signal: options.signal }
    );
    if (isLogoutResponseOk(casResp)) {
      casLoggedOut = true;
      succeeded++;
    } else {
      failedEndpoints.push(`${safeCasLogout} (HTTP ${casResp.status})`);
    }
  } catch (err) {
    failedEndpoints.push(`${safeCasLogout} (${err instanceof Error ? err.message : 'network error'})`);
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
        headers: buildHeadersWithOptionalNativeControl(
          { 'User-Agent': ua },
          'X-Gdou-Clear-Cookies-After'
        ),
      },
      { timeoutMs: options.timeoutMs ?? 8_000, userAgent: ua, signal: options.signal }
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
 * Fetch a fresh graphic captcha image inside an active off-campus `wfw` proxy session.
 */
export async function fetchWfwSubAuthCaptchaImage(
  _session: PreparedAuthSession,
  options: AuthRequestOptions = {}
): Promise<string | undefined> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const imgUrl = `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.getCaptcha}?${Date.now()}`;
  const resp = await fetchWithTimeout(
    imgUrl,
    {
      method: 'GET',
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.login}`,
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

async function checkWfwSubAuthCaptcha(
  session: PreparedAuthSession,
  username: string,
  options: AuthRequestOptions = {}
): Promise<{ isNeed: boolean; imageDataUri?: string }> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const trimmed = username.trim();
  if (!trimmed) return { isNeed: false };
  try {
    const checkUrl = `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.checkNeedCaptcha}?username=${encodeURIComponent(
      trimmed
    )}&_=${Date.now()}`;
    const resp = await fetchWithTimeout(
      checkUrl,
      {
        method: 'GET',
        credentials: 'include',
        headers: { 'User-Agent': ua },
      },
      { ...options, timeoutMs: 10_000 }
    );
    if (!resp.ok) return { isNeed: false };
    const text = (await resp.text()).trim();
    if (!text.startsWith('{')) return { isNeed: false };
    const data = JSON.parse(text) as { isNeed?: boolean };
    if (!data?.isNeed) return { isNeed: false };
    const imageDataUri = await fetchWfwSubAuthCaptchaImage(session, options).catch(() => undefined);
    return { isNeed: true, imageDataUri };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return { isNeed: false };
  }
}

/**
 * Submit MFA dynamic code and complete the one-shot JWXT pull.
 * Zero plaintext password is ever retained across the MFA pause.
 * When off-campus `wfw` requires a separate proxied JWXT login after MFA succeeds,
 * keeps `WFWSESSID` alive and returns `{ status: 'wfw_subauth_required', subAuth }`
 * so the user can finish Step 2 seamlessly without ever caching plaintext passwords.
 */
export async function submitGdouMfaAndCompleteSync(
  mfa: MfaChallengeState,
  dynamicCode: string,
  reAuthType: '4' | '3',
  termOverride?: SyncTermOverride,
  onProgress?: (step: string) => void,
  options: AuthRequestOptions = {}
): Promise<MfaCompletionOutcome> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const { controller, cleanup } = createBoundedSyncController(options.signal);
  const reqOpts: AuthRequestOptions = { ...options, signal: controller.signal, userAgent: ua };

  const steps = [...mfa.previousSteps];
  const log = (msg: string) => {
    steps.push(msg);
    onProgress?.(msg);
  };

  let shouldLogoutSession = false;
  let keepSessionForSubAuth = false;
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

    let ephemeralCode = dynamicCode.trim();
    const mfaBody = encodeFormBody({
      service: mfa.serviceUrl,
      reAuthType,
      isMultifactor: 'true',
      password: '',
      dynamicCode: ephemeralCode,
      uuid: '',
      answer1: '',
      answer2: '',
      otpCode: '',
      skipTmpReAuth: 'true',
    });
    ephemeralCode = '';

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
        body: mfaBody,
      },
      reqOpts
    );

    const submitText = (await submitResp.text()).trim();
    if (submitResp.status === 403) {
      throw new Error('二次认证请求返回 HTTP 403，请关闭手机 VPN / 代理或切换 4G/5G 流量后重试');
    }
    if (!submitResp.ok) {
      throw new Error(`二次认证提交异常 (HTTP ${submitResp.status})，请重新获取验证码或切换「官网无痕网页」`);
    }
    if (submitText.includes('pwdEncryptSalt') && !submitText.startsWith('{')) {
      throw new Error('多因子验证会话已过期，请重新发起登录');
    }
    let data: { code?: string; msg?: string } = {};
    if (submitText.startsWith('{')) {
      try {
        data = JSON.parse(submitText) as { code?: string; msg?: string };
      } catch {
        // Non-JSON response
      }
    }
    if (
      data.code === 'reAuth_failed' ||
      data.code === 'reAuth_unauthorized' ||
      (data.code && !/success|ok/i.test(data.code))
    ) {
      throw new Error(data.msg || '二次认证验证码错误或已过期，请重新输入');
    }

    shouldLogoutSession = true;
    log('4. 多因子二次认证通过，正在激活教务系统票据...');

    // Ticket-only handoff (zero plaintext password retained across MFA!)
    const handoff = await completeCasToJwHandoff(
      mfa.session,
      mfa.session.isWebVpn,
      undefined,
      reqOpts,
      steps
    );
    if (handoff.status === 'mfa_required') {
      keepSessionForSubAuth = true;
      log('5. 校外教务通道要求完成多因子二次安全验证');
      return { status: 'mfa_required', mfa: handoff.mfa };
    }
    if (handoff.status === 'wfw_subauth_needed') {
      keepSessionForSubAuth = true;
      const cap = await checkWfwSubAuthCaptcha(mfa.session, mfa.reAuthUserId, reqOpts);
      log('5. 校外微门户 (wfw) 已就绪，需确认教务子会话（内存未留存密码，请重新输入一次密码）');
      return {
        status: 'wfw_subauth_required',
        subAuth: {
          required: true,
          username: mfa.reAuthUserId,
          salt2: handoff.salt2,
          execution2: handoff.execution2,
          lt2: handoff.lt2,
          needCaptcha: cap.isNeed,
          captchaImageUri: cap.imageDataUri,
          session: mfa.session,
          previousSteps: steps,
        },
      };
    }

    const pulled = await pullAllJwData(mfa.session, steps, log, termOverride, reqOpts);
    detectedPrefix = pulled.prefix;

    const logoutDetails = await logoutEphemeralSession(
      mfa.session.jwBaseUrl,
      mfa.session.authOrigin,
      mfa.session.isWebVpn,
      detectedPrefix,
      { userAgent: ua, signal: options.signal }
    );
    shouldLogoutSession = false;

    const credentialsPurged = Boolean(mfa.credentialsPurged) && ephemeralCode === '';
    const cookiesFlushed = logoutDetails.casLoggedOut;
    const storageCleaned = cookiesFlushed;
    const sessionLoggedOut =
      logoutDetails.casLoggedOut && logoutDetails.failedEndpoints.length === 0;
    const warnings = [...pulled.warnings];
    if (!sessionLoggedOut) {
      warnings.push(
        `部分远端注销请求未确认成功 (${logoutDetails.succeeded}/${logoutDetails.attempted})，请留意官网登录状态`
      );
      log(
        `8. 本地无痕清理已尝试，但远端注销仅确认 ${logoutDetails.succeeded}/${logoutDetails.attempted} 项（建议手动核对官网退出）`
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
        syncedPeriods: pulled.syncedPeriods,
        detectedCampus: pulled.detectedCampus,
        graduationAudit: pulled.graduationAudit,
        emptyClassroomSnapshot: pulled.emptyClassroomSnapshot,
        campusSearchResult: pulled.campusSearchResult,
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
          credentialsPurged,
          sessionLoggedOut,
          storageCleaned,
          cookiesFlushed,
          logoutDetails,
          warnings: warnings.length > 0 ? warnings : undefined,
          steps,
        },
      },
    };
  } finally {
    cleanup();
    if (shouldLogoutSession && !keepSessionForSubAuth) {
      await logoutEphemeralSession(
        mfa.session.jwBaseUrl,
        mfa.session.authOrigin,
        mfa.session.isWebVpn,
        detectedPrefix,
        { userAgent: ua, timeoutMs: 5_000 }
      );
    }
  }
}

/**
 * Step 2 for off-campus `wfw` after MFA: uses fresh user-supplied ephemeral password
 * (encrypted immediately with `salt2` and purged BEFORE network I/O) to authenticate
 * the proxied `jw.gdou.edu.cn` sub-session inside the already-authenticated `WFWSESSID`,
 * supports Phase-2 MFA seamlessly if triggered, pulls all JWXT data, and logs out all sessions.
 */
export async function completeWfwSubAuthAndSync(
  subAuth: WfwSubAuthState,
  credentials: EphemeralCredentials,
  termOverride?: SyncTermOverride,
  onProgress?: (step: string) => void,
  options: AuthRequestOptions = {}
): Promise<OneShotSyncOutcome> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;
  const { controller, cleanup } = createBoundedSyncController(options.signal);
  const reqOpts: AuthRequestOptions = { ...options, signal: controller.signal, userAgent: ua };

  const steps = [...subAuth.previousSteps];
  const log = (msg: string) => {
    steps.push(msg);
    onProgress?.(msg);
  };

  let keepSessionForMfa = false;
  let logoutCompleted = false;
  let detectedPrefix = '';
  let rawPassword = credentials.password;
  const username = (credentials.username || subAuth.username).trim();
  const captcha = (credentials.captcha ?? '').trim();

  try {
    // Purge caller credential object immediately BEFORE network I/O
    purgeEphemeralCredentials(credentials);

    // Bind already MFA-trusted ephemeralBfp via explicit GDOU_AUTH_WFW_BASE (never bare /authserver/, which 404s when urlss=jw)
    try {
      await fetchWithTimeout(
        `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${subAuth.session.ephemeralBfp}`,
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

    const encryptedPwd2 = encryptGdouPassword(rawPassword, subAuth.salt2);
    rawPassword = '';
    log('5b. 教务子会话密码已本地加密并释放内存引用，正在激活校外教务通道...');

    // MUST post to GDOU_AUTH_WFW_BASE with campus GDOU_JW_SSO_SERVICE so jw.gdou.edu.cn serviceValidate matches!
    const wfwAuthPostUrl =
      `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.login}?service=` +
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
          Referer: wfwAuthPostUrl,
        },
        body: encodeFormBody({
          username,
          password: encryptedPwd2,
          captcha,
          _eventId: 'submit',
          cllt: 'userNameLogin',
          dllt: 'generalLogin',
          lt: subAuth.lt2,
          execution: subAuth.execution2,
        }),
      },
      reqOpts
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
      keepSessionForMfa = true;
      try {
        await fetchWithTimeout(
          `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${subAuth.session.ephemeralBfp}`,
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
      const userIdMatch = wfwPostHtml.match(/"reAuthUserId"\s*:\s*"([^"]+)"/);
      const typeMatch = wfwPostHtml.match(/"reAuthType"\s*:\s*"([34])"/);
      log('5c. 校外教务子通道要求完成二次安全验证（短信 / 企业微信）');
      return {
        status: 'mfa_required',
        mfa: {
          required: true,
          reAuthUserId: userIdMatch ? userIdMatch[1] : username,
          serviceUrl: GDOU_JW_SSO_SERVICE,
          defaultReAuthType: (typeMatch?.[1] as '4' | '3') || '4',
          credentialsPurged: areCredentialsPurged(credentials) && rawPassword === '',
          session: {
            ...subAuth.session,
            authOrigin: GDOU_AUTH_WFW_BASE,
            serviceUrl: GDOU_JW_SSO_SERVICE,
          },
          previousSteps: steps,
        },
      };
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
          ? `校外教务子会话验证未通过：${tip}（可切换「官网无痕网页」登录）`
          : `校外教务子会话验证未通过 (HTTP ${wfwPostResp.status})，请核对密码/验证码或切换顶部「官网无痕网页」同步`
      );
    }
    if (!wfwPostResp.ok) {
      throw new Error(
        `校外教务子会话通道异常 (HTTP ${wfwPostResp.status})，请重试或切换顶部「官网无痕网页」同步`
      );
    }

    const pulled = await pullAllJwData(subAuth.session, steps, log, termOverride, reqOpts);
    detectedPrefix = pulled.prefix;

    const logoutDetails = await logoutEphemeralSession(
      subAuth.session.jwBaseUrl,
      subAuth.session.authOrigin,
      subAuth.session.isWebVpn,
      detectedPrefix,
      { userAgent: ua, signal: options.signal }
    );
    logoutCompleted = true;

    const credentialsPurged = areCredentialsPurged(credentials) && rawPassword === '';
    const cookiesFlushed = logoutDetails.casLoggedOut;
    const storageCleaned = cookiesFlushed;
    const sessionLoggedOut =
      logoutDetails.casLoggedOut && logoutDetails.failedEndpoints.length === 0;
    const warnings = [...pulled.warnings];
    if (!sessionLoggedOut) {
      warnings.push(
        `部分远端注销请求未确认成功 (${logoutDetails.succeeded}/${logoutDetails.attempted})，请留意官网登录状态`
      );
      log(
        `8. 本地无痕清理已尝试，但远端注销仅确认 ${logoutDetails.succeeded}/${logoutDetails.attempted} 项（建议手动核对官网退出）`
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
        syncedPeriods: pulled.syncedPeriods,
        detectedCampus: pulled.detectedCampus,
        graduationAudit: pulled.graduationAudit,
        emptyClassroomSnapshot: pulled.emptyClassroomSnapshot,
        campusSearchResult: pulled.campusSearchResult,
        termLabel: pulled.termLabel,
        academicYear: pulled.academicYear,
        semesterCode: pulled.semesterCode,
        receipt: {
          syncedAtIso: new Date().toISOString(),
          mode: 'direct',
          networkRoute: 'wfw-webvpn',
          termLabel: pulled.termLabel,
          coursesCount: pulled.courses.length,
          examsCount: pulled.exams.length,
          gradesCount: pulled.grades.length,
          credentialsPurged,
          sessionLoggedOut,
          storageCleaned,
          cookiesFlushed,
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
        subAuth.session.jwBaseUrl,
        subAuth.session.authOrigin,
        subAuth.session.isWebVpn,
        detectedPrefix,
        { userAgent: ua, timeoutMs: 5_000 }
      );
    }
  }
}

type CasHandoffOutcome =
  | { status: 'ready' }
  | { status: 'wfw_subauth_needed'; salt2: string; execution2: string; lt2: string }
  | { status: 'mfa_required'; mfa: MfaChallengeState };

async function completeCasToJwHandoff(
  session: PreparedAuthSession,
  needWfwActivation: boolean,
  ephemeralForWfw?: { username: string; password: string },
  options: AuthRequestOptions = {},
  previousSteps: string[] = []
): Promise<CasHandoffOutcome> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;

  if (session.isWebVpn) {
    // Phase 2 MFA completion: authOrigin is already GDOU_AUTH_WFW_BASE -> mint campus GDOU_JW_SSO_SERVICE ticket directly!
    if (session.authOrigin === GDOU_AUTH_WFW_BASE) {
      const p2TicketUrl = `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
        GDOU_JW_SSO_SERVICE
      )}`;
      await fetchWithTimeout(
        p2TicketUrl,
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
      return { status: 'ready' };
    }

    // Phase 1 -> Activate WFWSESSID on wfw.gdou.edu.cn via outer CAS service=https://wfw.gdou.edu.cn/
    if (needWfwActivation && session.serviceUrl !== GDOU_JW_SSO_SERVICE) {
      const wfwTicketUrl = `${GDOU_AUTH_ORIGIN}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
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

    // Phase 1.5 -> ONE-PASSWORD OUTER CAS SSO TICKET BRIDGE!
    // We ALREADY hold a valid, MFA-verified `CASTGC` on `authserver.gdou.edu.cn` AND `WFWSESSID` on `wfw.gdou.edu.cn`.
    // Requesting a Service Ticket directly from `authserver.gdou.edu.cn` for `GDOU_JW_SSO_SERVICE` reuses `CASTGC`
    // without prompting for password a second time, then delivers `ST-...` through `wfw.gdou.edu.cn/https://jw.gdou.edu.cn`!
    try {
      const outerJwTicketUrl = `${GDOU_AUTH_ORIGIN}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
        GDOU_JW_SSO_SERVICE
      )}`;
      const outerResp = await fetchWithTimeout(
        outerJwTicketUrl,
        {
          method: 'GET',
          credentials: 'include',
          redirect: 'manual',
          headers: {
            'User-Agent': ua,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        },
        options
      );

      if (outerResp.status >= 300 && outerResp.status < 400) {
        const rawLoc = (outerResp.headers.get('location') || '').trim();
        if (rawLoc) {
          const upgradedLoc = upgradeGdouHttpToHttps(rawLoc) ?? rawLoc;
          if (upgradedLoc.includes('reAuthLoginView.do')) {
            const mfaViewResp = await fetchWithTimeout(
              upgradedLoc,
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
            const mfaHtml = await mfaViewResp.text();
            if (mfaHtml.includes('reAuthParams') || mfaHtml.includes('多因子认证')) {
              const userIdMatch = mfaHtml.match(/"reAuthUserId"\s*:\s*"([^"]+)"/);
              const typeMatch = mfaHtml.match(/"reAuthType"\s*:\s*"([34])"/);
              return {
                status: 'mfa_required',
                mfa: {
                  required: true,
                  reAuthUserId: userIdMatch ? userIdMatch[1] : ephemeralForWfw?.username || '',
                  serviceUrl: GDOU_JW_SSO_SERVICE,
                  defaultReAuthType: (typeMatch?.[1] as '4' | '3') || '4',
                  credentialsPurged: true,
                  session: {
                    ...session,
                    authOrigin: GDOU_AUTH_ORIGIN,
                    serviceUrl: GDOU_JW_SSO_SERVICE,
                  },
                  previousSteps,
                },
              };
            }
          } else {
            const wrappedJwTicketUrl = healWfwWrongSsoUrl(upgradedLoc, true) ?? upgradedLoc;
            if (
              wrappedJwTicketUrl.includes('wfw.gdou.edu.cn/https://jw.gdou.edu.cn') ||
              wrappedJwTicketUrl.includes('ticket=')
            ) {
              const exchangeResp = await fetchWithTimeout(
                wrappedJwTicketUrl,
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
              const exchangeHtml = await exchangeResp.text();
              if (
                exchangeResp.ok &&
                !exchangeHtml.includes('pwdEncryptSalt') &&
                !exchangeHtml.includes('reAuthParams') &&
                (exchangeHtml.includes('index_initMenu') ||
                  exchangeHtml.includes('教学管理信息服务平台') ||
                  exchangeHtml.includes('xskbcx') ||
                  exchangeHtml.includes('xnm'))
              ) {
                return { status: 'ready' };
              }
            }
          }
        }
      } else if (outerResp.ok) {
        // React Native fetch may auto-follow 302 through native GdouEphemeralURLProtocol / OkHttp wfw rewriter
        const bridgeUrl = outerResp.url || '';
        const bridgeHtml = await outerResp.text();
        if (
          bridgeUrl.includes('reAuthLoginView.do') ||
          bridgeHtml.includes('reAuthParams') ||
          bridgeHtml.includes('多因子认证')
        ) {
          const userIdMatch = bridgeHtml.match(/"reAuthUserId"\s*:\s*"([^"]+)"/);
          const typeMatch = bridgeHtml.match(/"reAuthType"\s*:\s*"([34])"/);
          return {
            status: 'mfa_required',
            mfa: {
              required: true,
              reAuthUserId: userIdMatch ? userIdMatch[1] : ephemeralForWfw?.username || '',
              serviceUrl: GDOU_JW_SSO_SERVICE,
              defaultReAuthType: (typeMatch?.[1] as '4' | '3') || '4',
              credentialsPurged: true,
              session: {
                ...session,
                authOrigin: GDOU_AUTH_ORIGIN,
                serviceUrl: GDOU_JW_SSO_SERVICE,
              },
              previousSteps,
            },
          };
        }
        if (
          !bridgeHtml.includes('pwdEncryptSalt') &&
          (bridgeHtml.includes('index_initMenu') ||
            bridgeHtml.includes('教学管理信息服务平台') ||
            bridgeHtml.includes('xskbcx') ||
            bridgeHtml.includes('xnm'))
        ) {
          return { status: 'ready' };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      // Non-fatal: gracefully fall back to proxied wfw sub-auth discovery below
    }

    // Phase 2 -> Fallback: probe proxied jw entry inside authenticated WFWSESSID
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
    if (jwEntryResp.status === 403) {
      throw new Error('校外微门户 (wfw.gdou.edu.cn) 返回 HTTP 403，请关闭手机 VPN / 代理或切换 4G/5G 流量后重试');
    }
    const jwEntryHtml = await jwEntryResp.text();
    let salt2 = extractHiddenInput(jwEntryHtml, 'pwdEncryptSalt');
    let exe2 = extractHiddenInput(jwEntryHtml, 'execution');
    let lt2 = extractHiddenInput(jwEntryHtml, 'lt');

    if (
      !salt2 &&
      jwEntryResp.ok &&
      (jwEntryHtml.includes('index_initMenu') ||
        jwEntryHtml.includes('教学管理信息服务平台') ||
        jwEntryHtml.includes('xskbcx') ||
        jwEntryHtml.includes('xnm'))
    ) {
      return { status: 'ready' };
    }

    // Synchronize proxied authserver session on GDOU_AUTH_WFW_BASE so urlss="https://authserver.gdou.edu.cn"
    // and JSESSIONID / route / execution2 match the exact POST target!
    try {
      const authWfwLoginUrl = `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
        GDOU_JW_SSO_SERVICE
      )}`;
      const authWfwResp = await fetchWithTimeout(
        authWfwLoginUrl,
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
      if (authWfwResp.status === 403) {
        throw new Error('校外微门户认证通道返回 HTTP 403，请关闭手机 VPN / 代理或切换 4G/5G 流量后重试');
      }
      if (authWfwResp.ok) {
        const authWfwHtml = await authWfwResp.text();
        const freshSalt = extractHiddenInput(authWfwHtml, 'pwdEncryptSalt');
        const freshExe = extractHiddenInput(authWfwHtml, 'execution');
        const freshLt = extractHiddenInput(authWfwHtml, 'lt');
        if (freshSalt && freshExe) {
          salt2 = freshSalt;
          exe2 = freshExe;
          lt2 = freshLt;
        } else if (
          authWfwHtml.includes('index_initMenu') ||
          authWfwHtml.includes('教学管理信息服务平台') ||
          authWfwHtml.includes('xskbcx')
        ) {
          return { status: 'ready' };
        }
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('HTTP 403'))) {
        throw err;
      }
    }

    if (!salt2 || !exe2) {
      return { status: 'ready' };
    }

    if (!ephemeralForWfw?.username || !ephemeralForWfw?.password) {
      return {
        status: 'wfw_subauth_needed',
        salt2,
        execution2: exe2,
        lt2,
      };
    }

    // If proxied wfw authserver requires graphic captcha for Step 2, surface captcha UI instead of posting empty captcha
    const step2Cap = await checkWfwSubAuthCaptcha(session, ephemeralForWfw.username, options);
    if (step2Cap.isNeed) {
      return {
        status: 'wfw_subauth_needed',
        salt2,
        execution2: exe2,
        lt2,
      };
    }

    try {
      await fetchWithTimeout(
        `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${session.ephemeralBfp}`,
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
      `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.login}?service=` +
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
          Referer: wfwAuthPostUrl,
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
      try {
        await fetchWithTimeout(
          `${GDOU_AUTH_WFW_BASE}${GDOU_AUTH_PATHS.bfpInfo}?bfp=${session.ephemeralBfp}`,
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
      const userIdMatch = wfwPostHtml.match(/"reAuthUserId"\s*:\s*"([^"]+)"/);
      const typeMatch = wfwPostHtml.match(/"reAuthType"\s*:\s*"([34])"/);
      return {
        status: 'mfa_required',
        mfa: {
          required: true,
          reAuthUserId: userIdMatch ? userIdMatch[1] : ephemeralForWfw.username,
          serviceUrl: GDOU_JW_SSO_SERVICE,
          defaultReAuthType: (typeMatch?.[1] as '4' | '3') || '4',
          credentialsPurged: true,
          session: {
            ...session,
            authOrigin: GDOU_AUTH_WFW_BASE,
            serviceUrl: GDOU_JW_SSO_SERVICE,
          },
          previousSteps,
        },
      };
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
          : `校外教务通道二次握手未通过 (HTTP ${wfwPostResp.status})，建议切换顶部「官网无痕网页」同步`
      );
    }
    if (!wfwPostResp.ok) {
      throw new Error(
        `校外教务通道二次握手返回异常 (HTTP ${wfwPostResp.status})，建议切换顶部「官网无痕网页」同步`
      );
    }
    return { status: 'ready' };
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
  return { status: 'ready' };
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

async function fetchJwGradeSubScoresBatch(
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

async function fetchJwGraduationAudit(
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

async function fetchJwEmptyClassrooms(
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

async function fetchJwCampusCourses(
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

function guessCurrentSectionBlock(): number[] {
  const h = new Date().getHours();
  if (h < 10) return [1, 2];
  if (h < 12) return [3, 4];
  if (h < 16) return [5, 6];
  if (h < 18) return [7, 8];
  return [9, 10];
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
    const retryCasBase = session.isWebVpn ? GDOU_AUTH_WFW_BASE : session.authOrigin;
    await fetchWithTimeout(
      `${retryCasBase}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(GDOU_JW_SSO_SERVICE)}`,
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
    const isPreparedFresh =
      typeof session.preparedAtMs === 'number' && Date.now() - session.preparedAtMs < 90_000;

    if (!activeSalt || !activeExecution || (!captcha && !isPreparedFresh)) {
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
              headers: buildHeadersWithOptionalNativeControl(
                { 'User-Agent': ua },
                'X-Gdou-Clear-Cookies-After'
              ),
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
      const mfaCredentialsPurged = areCredentialsPurged(credentials) && rawPassword === '';
      log('3. 账号密码验证通过（密码引用已立即释放）！海大安全策略要求完成多因子验证码校验');
      return {
        status: 'mfa_required',
        mfa: {
          required: true,
          reAuthUserId: userIdMatch ? userIdMatch[1] : username,
          serviceUrl: session.serviceUrl,
          defaultReAuthType: (typeMatch?.[1] as '4' | '3') || '4',
          credentialsPurged: mfaCredentialsPurged,
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
    const alreadyLandedOnJw =
      loginFinalUrl.includes('jw.gdou.edu.cn') &&
      !loginHtml.includes('pwdEncryptSalt') &&
      !loginHtml.includes('reAuthParams');
    const needWfwActivation = session.isWebVpn && !loginFinalUrl.includes('wfw.gdou.edu.cn');
    const handoffSecret = session.isWebVpn ? { username, password: rawPassword } : undefined;
    rawPassword = '';
    let handoffOutcome: CasHandoffOutcome = { status: 'ready' };
    try {
      if (!alreadyLandedOnJw) {
        handoffOutcome = await completeCasToJwHandoff(
          session,
          needWfwActivation,
          handoffSecret,
          reqOpts,
          steps
        );
      }
    } finally {
      if (handoffSecret) {
        handoffSecret.username = '';
        handoffSecret.password = '';
      }
    }
    if (handoffOutcome.status === 'mfa_required') {
      keepSessionForMfa = true;
      log('4. 校外教务通道要求完成多因子二次安全验证');
      return { status: 'mfa_required', mfa: handoffOutcome.mfa };
    }
    if (handoffOutcome.status === 'wfw_subauth_needed') {
      keepSessionForMfa = true;
      const cap = await checkWfwSubAuthCaptcha(session, username, reqOpts);
      log('4. 校外教务子通道要求图形验证码校验（密码引用已释放，请确认后继续）');
      return {
        status: 'wfw_subauth_required',
        subAuth: {
          required: true,
          username,
          salt2: handoffOutcome.salt2,
          execution2: handoffOutcome.execution2,
          lt2: handoffOutcome.lt2,
          needCaptcha: cap.isNeed,
          captchaImageUri: cap.imageDataUri,
          session,
          previousSteps: steps,
        },
      };
    }
    log('4. 教务通道已打通，凭据引用已从内存释放');

    const pulled = await pullAllJwData(session, steps, log, termOverride, reqOpts);
    detectedPrefix = pulled.prefix;

    const logoutDetails = await logoutEphemeralSession(
      session.jwBaseUrl,
      session.authOrigin,
      session.isWebVpn,
      detectedPrefix,
      { userAgent: ua, signal: options.signal }
    );
    logoutCompleted = true;

    const credentialsPurged = areCredentialsPurged(credentials) && rawPassword === '';
    const cookiesFlushed = logoutDetails.casLoggedOut;
    const storageCleaned = cookiesFlushed;
    const sessionLoggedOut =
      logoutDetails.casLoggedOut && logoutDetails.failedEndpoints.length === 0;
    const warnings = [...pulled.warnings];
    if (!sessionLoggedOut) {
      warnings.push(
        `部分远端注销请求未确认成功 (${logoutDetails.succeeded}/${logoutDetails.attempted})，请留意官网登录状态`
      );
      log(
        `8. 本地清理已尝试，但远端注销仅确认 ${logoutDetails.succeeded}/${logoutDetails.attempted} 项（建议手动确认退出）`
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
        syncedPeriods: pulled.syncedPeriods,
        detectedCampus: pulled.detectedCampus,
        graduationAudit: pulled.graduationAudit,
        emptyClassroomSnapshot: pulled.emptyClassroomSnapshot,
        campusSearchResult: pulled.campusSearchResult,
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
          storageCleaned,
          cookiesFlushed,
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
        { userAgent: ua, timeoutMs: 5_000 }
      );
    }
  }
}

/**
 * Document-start preload script for Mode B (Incognito Ephemeral WebView).
 * Runs via `injectedJavaScriptBeforeContentLoaded` BEFORE GDOU's own `login.js`,
 * `common-header.js`, or `wfw.gdou.edu.cn`'s `toProxy` script execute:
 * 1. Injects CSP `upgrade-insecure-requests` immediately on `*.gdou.edu.cn` so
 *    same-origin forms/XHR/subresources upgrade to HTTPS before any cleartext load.
 * 2. On `wfw.gdou.edu.cn`, normalizes `/https://(jw|authserver).gdou.edu.cn/authserver/...`
 *    back to `/authserver/...` across XHR, `fetch`, `<a>` clicks, and `<form>` submits
 *    so `Path=/authserver` cookies (`JSESSIONID` & `route`) are ALWAYS attached.
 */
export function buildIncognitoWebViewPreloadScript(): string {
  return `
    (function() {
      if (window.__GDOU_PRELOAD_INSTALLED__) return;
      window.__GDOU_PRELOAD_INSTALLED__ = true;
      var host = String(window.location.hostname || '').toLowerCase();
      var isGdou = host === 'gdou.edu.cn' || host.slice(-12) === '.gdou.edu.cn';
      if (!isGdou) return;

      function ensureUpgradeCsp() {
        try {
          if (document.getElementById('__gdou_upgrade_https__')) return;
          var parent = document.head || document.documentElement;
          if (!parent) return;
          var csp = document.createElement('meta');
          csp.id = '__gdou_upgrade_https__';
          csp.httpEquiv = 'Content-Security-Policy';
          csp.content = 'upgrade-insecure-requests';
          parent.appendChild(csp);
        } catch (e) {}
      }
      ensureUpgradeCsp();
      document.addEventListener('DOMContentLoaded', ensureUpgradeCsp, { once: true });

      function rewriteGdouUrl(raw) {
        if (typeof raw !== 'string' || !raw) return raw;
        var out = raw;
        if (/^http:\\/\\/(?:[a-z0-9-]+\\.)*gdou\\.edu\\.cn(?:[:/?#]|$)/i.test(out)) {
          out = out.replace(/^http:\\/\\//i, 'https://');
        }
        if (host === 'wfw.gdou.edu.cn') {
          var wrongSso = out.match(/^(?:https?:\\/\\/wfw\\.gdou\\.edu\\.cn)?(?:\\/https?:\\/\\/authserver\\.gdou\\.edu\\.cn)?\\/sso\\/jziotlogin([?#].*)?$/i);
          if (wrongSso) {
            return 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin' + (wrongSso[1] || '');
          }
          var bareJw = out.match(/^https?:\\/\\/jw\\.gdou\\.edu\\.cn(?::(?:80|443))?([/?#].*)?$/i);
          if (bareJw) {
            var jwRest = bareJw[1] || '';
            if (jwRest && jwRest.charAt(0) !== '/') jwRest = '/' + jwRest;
            return 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn' + jwRest;
          }
          // ONLY rewrite /https://authserver.../authserver/... -> /authserver/... when already inside /authserver/
          // so urlss="https://authserver.gdou.edu.cn" is guaranteed active (never breaking urlss priming or logout!).
          if (String(window.location.pathname || '').indexOf('/authserver/') === 0) {
            var m = out.match(/^(?:https?:\\/\\/wfw\\.gdou\\.edu\\.cn)?\\/https?:\\/\\/(?:jw|authserver)\\.gdou\\.edu\\.cn(\\/authserver\\/.*)$/i);
            if (m && m[1]) {
              out = m[1];
            }
          }
        }
        return out;
      }

      try {
        if (window.XMLHttpRequest && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
          var origOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url) {
            var args = Array.prototype.slice.call(arguments);
            if (typeof args[1] === 'string') {
              args[1] = rewriteGdouUrl(args[1]);
            }
            return origOpen.apply(this, args);
          };
        }
      } catch (e) {}

      try {
        if (typeof window.fetch === 'function') {
          var origFetch = window.fetch;
          window.__GDOU_RAW_FETCH__ = origFetch;
          window.fetch = function(input, init) {
            if (typeof input === 'string') {
              return origFetch.call(this, rewriteGdouUrl(input), init);
            }
            return origFetch.call(this, input, init);
          };
        }
      } catch (e) {}

      try {
        document.addEventListener('click', function(ev) {
          var el = ev.target;
          while (el && el.tagName !== 'A') el = el.parentElement;
          if (!el || !el.getAttribute) return;
          var hrefAttr = el.getAttribute('href') || '';
          var fixed = rewriteGdouUrl(hrefAttr);
          if (fixed && fixed !== hrefAttr) {
            el.setAttribute('href', fixed);
          }
        }, true);
      } catch (e) {}

      try {
        document.addEventListener('submit', function(ev) {
          var form = ev.target;
          if (!form || !form.getAttribute) return;
          var act = form.getAttribute('action') || '';
          var fixed = rewriteGdouUrl(act);
          if (fixed && fixed !== act) {
            form.setAttribute('action', fixed);
          }
        }, true);
      } catch (e) {}
    })();
    true;
  `;
}

/**
 * Injected JS for Mode B (Incognito Ephemeral WebView).
 * Shares the EXACT endpoint paths and 3-variant exam query params from `gdouEndpoints.ts`,
 * includes per-session `bridgeToken` authentication, enforces fetch timeouts, clears
 * sessionStorage/localStorage, and reports real HTTP-verified logout status.
 */
export function buildIncognitoWebViewSyncScript(
  override?: SyncTermOverride,
  bridgeToken = '',
  expectedServiceUrl: string = `${GDOU_WFW_ORIGIN}/`,
  job?: AuxiliarySyncJob,
  preferSmsLogin = false
): string {
  const overrideXnm = JSON.stringify(override?.xnm ?? '');
  const overrideXqm = JSON.stringify(override?.xqm ?? '');
  const tokenJson = JSON.stringify(bridgeToken);
  const preferSmsJson = JSON.stringify(Boolean(preferSmsLogin));
  const prefixesJson = JSON.stringify(GDOU_JW_PREFIXES);
  const pathsJson = JSON.stringify(GDOU_JW_PATHS);
  const jobJson = JSON.stringify(
    job?.kind === 'empty_classroom'
      ? {
          kind: 'empty_classroom',
          params: job.params,
          formParams: buildEmptyClassroomQueryParams(job.params),
        }
      : job?.kind === 'campus_search'
        ? {
            kind: 'campus_search',
            query: job.query,
            formParams: buildCampusCourseSearchParams(job.query),
          }
        : { kind: 'full_sync' }
  );
  const todayEmptyMaskJson = JSON.stringify({
    weekMask: String(buildZhengfangBitmask([1], 30)),
    dayOfWeek: String(getTodayDayOfWeek()),
    sectionMask: String(buildZhengfangBitmask(guessCurrentSectionBlock(), 16)),
  });
  const originsJson = JSON.stringify({
    auth: GDOU_AUTH_ORIGIN,
    wfw: GDOU_WFW_ORIGIN,
    authWfw: GDOU_AUTH_WFW_BASE,
    jwDirect: GDOU_JW_DIRECT_ORIGIN,
    jwWfw: GDOU_JW_WFW_BASE,
    jwSsoService: GDOU_JW_SSO_SERVICE,
    jwWfwSsoService: GDOU_JW_WFW_SSO_SERVICE,
    expectedService: expectedServiceUrl || `${GDOU_WFW_ORIGIN}/`,
    authLogin: GDOU_AUTH_PATHS.login,
    authLogout: GDOU_AUTH_PATHS.logout,
  });

  return `
    (function() {
      var href = String(window.location.href || '');
      var host = String(window.location.hostname || '').toLowerCase();
      var pathname = String(window.location.pathname || '');
      var html = String(document.documentElement ? document.documentElement.innerHTML : '');
      var BRIDGE_TOKEN = ${tokenJson};
      var JW_PREFIXES = ${prefixesJson};
      var JW_PATHS = ${pathsJson};
      var ORIGINS = ${originsJson};
      var SYNC_JOB = ${jobJson};
      var TODAY_EMPTY_MASK = ${todayEmptyMaskJson};
      var PREFER_SMS_LOGIN = ${preferSmsJson};

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
        var rawFetch = window.__GDOU_RAW_FETCH__ || window.fetch;
        if (typeof AbortController === 'function') {
          var ac = new AbortController();
          var timer = setTimeout(function() { ac.abort(); }, ms);
          try {
            var merged = Object.assign({}, opts || {}, { signal: ac.signal });
            return await rawFetch.call(window, url, merged);
          } finally {
            clearTimeout(timer);
          }
        }
        return await Promise.race([
          rawFetch.call(window, url, opts || {}),
          new Promise(function(_, reject) {
            setTimeout(function() { reject(new Error('请求超时')); }, ms);
          })
        ]);
      }

      function stripUrlQuery(u) {
        return String(u || '').split('#')[0].split('?')[0];
      }

      function encodeForm(obj) {
        return Object.keys(obj).map(function(k) {
          return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
        }).join('&');
      }

      function normalizeWfwAuthHref(u) {
        if (typeof u !== 'string' || !u) return u;
        var out = u.replace(/^http:\\/\\/((?:[a-z0-9-]+\\.)*gdou\\.edu\\.cn)/i, 'https://$1');
        var m = out.match(/^(?:https?:\\/\\/wfw\\.gdou\\.edu\\.cn)?\\/https?:\\/\\/(?:jw|authserver)\\.gdou\\.edu\\.cn(\\/authserver\\/.*)$/i);
        return (m && m[1]) ? m[1] : out;
      }

      // 1. Mobile UI adaptation + automatic HTTPS upgrade for GDOU authserver & WebVPN pages
      (function adaptMobileLayout() {
        try {
          if (host === 'gdou.edu.cn' || host.slice(-12) === '.gdou.edu.cn') {
            if (!document.getElementById('__gdou_upgrade_https__') && document.head) {
              var csp = document.createElement('meta');
              csp.id = '__gdou_upgrade_https__';
              csp.httpEquiv = 'Content-Security-Policy';
              csp.content = 'upgrade-insecure-requests';
              document.head.appendChild(csp);
            }
            var forms = document.querySelectorAll('form[action]');
            for (var fi = 0; fi < forms.length; fi++) {
              var act = forms[fi].getAttribute('action') || '';
              var fixedAct = normalizeWfwAuthHref(act);
              if (fixedAct && fixedAct !== act) {
                forms[fi].setAttribute('action', fixedAct);
              }
            }
          }
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

      var isWfwSplash =
        host === 'wfw.gdou.edu.cn' &&
        (html.indexOf('正在跳转到统一认证') !== -1 ||
          document.title.indexOf('正在跳转') !== -1 ||
          (html.indexOf('authserver.gdou.edu.cn/authserver/login') !== -1 &&
            html.indexOf('pwdEncryptSalt') === -1 &&
            html.indexOf('reAuthParams') === -1));
      if (isWfwSplash) {
        post({ type: 'PROGRESS', message: '正在打开海大统一身份认证...' });
        return;
      }

      if (host === 'authserver.gdou.edu.cn') {
        // If user already authenticated into CAS personal portal (no ?service=), mint ticket immediately
        if (
          pathname.indexOf('/authserver/index.do') !== -1 ||
          pathname.indexOf('/personalInfo') !== -1 ||
          (html.indexOf('pwdEncryptSalt') === -1 &&
            html.indexOf('reAuthParams') === -1 &&
            html.indexOf('reAuthLoginView') === -1 &&
            html.indexOf('安全退出') !== -1)
        ) {
          post({ type: 'PROGRESS', message: '第 1 步认证已完成，正在跳转目标通道...' });
          window.location.replace(
            ORIGINS.auth + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.expectedService)
          );
          return;
        }
        // If GDOU bounced back to bare /authserver/login without ?service=, repair form action & tab links in place
        if (pathname === ORIGINS.authLogin && href.indexOf('service=') === -1) {
          try {
            var encodedSvc = encodeURIComponent(ORIGINS.expectedService);
            var loginForms = document.querySelectorAll('form#loginFromId, form.loginFromClass');
            for (var lf = 0; lf < loginForms.length; lf++) {
              var curAct = loginForms[lf].getAttribute('action') || ORIGINS.authLogin;
              if (curAct.indexOf('service=') === -1) {
                loginForms[lf].setAttribute(
                  'action',
                  curAct + (curAct.indexOf('?') === -1 ? '?' : '&') + 'service=' + encodedSvc
                );
              }
            }
            var tabLinks = document.querySelectorAll('#mobileTab, #accountTab');
            for (var tl = 0; tl < tabLinks.length; tl++) {
              var curHref = tabLinks[tl].getAttribute('href') || '';
              if (curHref && curHref.indexOf('service=') === -1) {
                tabLinks[tl].setAttribute(
                  'href',
                  curHref + (curHref.indexOf('?') === -1 ? '?' : '&') + 'service=' + encodedSvc
                );
              }
            }
          } catch (e) {}
        }
        if (href.indexOf('reAuthLoginView') !== -1 || html.indexOf('reAuthParams') !== -1) {
          post({ type: 'PROGRESS', message: '请完成海大多因子安全验证（短信 / 企业微信）' });
        } else {
          // If user chose 1-tap passwordless SMS login, auto-switch to #dynamicLogin_a tab once
          if (PREFER_SMS_LOGIN && href.indexOf('type=dynamicLogin') === -1) {
            try {
              if (!sessionStorage.getItem('__gdou_sms_tab_clicked__')) {
                var dynTab = document.getElementById('dynamicLogin_a');
                if (dynTab) {
                  sessionStorage.setItem('__gdou_sms_tab_clicked__', '1');
                  dynTab.click();
                }
              }
            } catch (e) {}
          }
          post({ type: 'PROGRESS', message: '只需登录一次：支持短信验证码免密 / 企微扫码 / 账号密码，通过后自动同步' });
        }
        return;
      }

      var hasAuthForm =
        html.indexOf('pwdEncryptSalt') !== -1 ||
        html.indexOf('reAuthParams') !== -1 ||
        Boolean(document.querySelector('#loginFromId, #pwdFromId'));

      var isAuthenticatedJwPortal =
        !hasAuthForm &&
        (href.indexOf('index_initMenu') !== -1 ||
          html.indexOf('index_initMenu') !== -1 ||
          html.indexOf('教学管理信息服务平台') !== -1 ||
          html.indexOf('xskbcx') !== -1);

      // If wfw followed Step 2 POST redirect server-side into JWXT while address bar stayed on /authserver/*,
      // jump straight to ORIGINS.jwWfw instead of trapping the user on the Step 2 login banner!
      if (
        host === 'wfw.gdou.edu.cn' &&
        isAuthenticatedJwPortal &&
        (pathname.indexOf('/authserver/') === 0 || href.indexOf('/https://authserver.gdou.edu.cn') !== -1)
      ) {
        post({ type: 'PROGRESS', message: '教务通道已激活，正在进入课表页面...' });
        window.location.replace(ORIGINS.jwWfw);
        return;
      }

      if (
        host === 'wfw.gdou.edu.cn' &&
        !isAuthenticatedJwPortal &&
        (href.indexOf('/https://authserver.gdou.edu.cn') !== -1 ||
          pathname.indexOf('/authserver/') === 0 ||
          (href.indexOf('/https://jw.gdou.edu.cn') !== -1 &&
            (html.indexOf('pwdEncryptSalt') !== -1 || html.indexOf('reAuthParams') !== -1)))
      ) {
        // Auto-recover if wfw /authserver/* ever returned HTTP 404 due to stale urlss="https://jw.gdou.edu.cn"
        if (
          (html.indexOf('404 Not Found') !== -1 || document.title.indexOf('404') !== -1) &&
          !sessionStorage.getItem('__gdou_404_healed__')
        ) {
          try { sessionStorage.setItem('__gdou_404_healed__', '1'); } catch (e) {}
          post({ type: 'PROGRESS', message: '正在自动校准校外教务认证路由...' });
          (async function() {
            try {
              await timedFetch(
                ORIGINS.authWfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService),
                { credentials: 'include' },
                8000
              );
            } catch (e) {}
            window.location.replace(
              ORIGINS.wfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService)
            );
          })();
          return;
        }

        // If wfw loaded /https://authserver.gdou.edu.cn/authserver/... (HTTP 200), urlss is NOW set to authserver.
        // Switch address bar ONCE to /authserver/... so WebView attaches Path=/authserver JSESSIONID & route cookies!
        if (
          href.indexOf('/https://authserver.gdou.edu.cn/authserver/') !== -1 &&
          html.indexOf('404 Not Found') === -1 &&
          !sessionStorage.getItem('__gdou_wfw_auth_norm__')
        ) {
          var normAfterPrime = normalizeWfwAuthHref(href);
          if (normAfterPrime && normAfterPrime.indexOf('/authserver/') === 0) {
            try { sessionStorage.setItem('__gdou_wfw_auth_norm__', '1'); } catch (e) {}
            window.location.replace(ORIGINS.wfw + normAfterPrime);
            return;
          }
        }

        // If Step 2 CAS landed on wfw /authserver/index.do, immediately enter JWXT
        if (
          pathname.indexOf('/authserver/index.do') !== -1 ||
          (html.indexOf('pwdEncryptSalt') === -1 &&
            html.indexOf('reAuthParams') === -1 &&
            html.indexOf('安全退出') !== -1)
        ) {
          post({ type: 'PROGRESS', message: '校外教务通道已激活，正在进入教务系统...' });
          window.location.replace(ORIGINS.jwWfw);
          return;
        }

        // Reinforce /authserver/ path normalization for jQuery & anchor links (defeats wfw toProxy)
        try {
          if (window.jQuery && window.jQuery.ajaxPrefilter && !window.__gdou_auth_prefilter_fixed__) {
            window.__gdou_auth_prefilter_fixed__ = true;
            window.jQuery.ajaxPrefilter(function(opts) {
              if (opts && typeof opts.url === 'string') {
                opts.url = normalizeWfwAuthHref(opts.url);
              }
            });
          }
          var fixAuthLinks = function() {
            var links = document.querySelectorAll('a[href*="/authserver/"]');
            for (var li = 0; li < links.length; li++) {
              var rawH = links[li].getAttribute('href') || '';
              var fixedH = normalizeWfwAuthHref(rawH);
              if (fixedH && fixedH !== rawH) {
                links[li].setAttribute('href', fixedH);
              }
            }
          };
          fixAuthLinks();
          setTimeout(fixAuthLinks, 400);
        } catch (e) {}

        // Show clear in-page guidance banner on wfw auth/MFA pages
        try {
          var isAfterStep1 = false;
          try { isAfterStep1 = sessionStorage.getItem('__gdou_wfw_authed__') === '1'; } catch (e) {}
          if (!document.getElementById('__gdou_wfw_step2_banner__') && document.body) {
            var banner = document.createElement('div');
            banner.id = '__gdou_wfw_step2_banner__';
            banner.style.cssText =
              'margin:10px 16px 6px;padding:10px 12px;border-radius:10px;background:#ECFDF5;border:1px solid #6EE7B7;color:#065F46;font-size:13px;line-height:1.5;font-weight:600;box-sizing:border-box;';
            banner.textContent =
              href.indexOf('reAuthLoginView') !== -1 || html.indexOf('reAuthParams') !== -1
                ? '请完成海大多因子二次安全验证（短信 / 企业微信），验证通过后将自动拉取课表与成绩。'
                : isAfterStep1
                  ? '第 1 步校外微门户已认证通过！请再登录一次以进入教务系统，通过后自动同步。'
                  : '已接入海大校外教务直通通道（支持账号密码或手机验证码登录），验证通过后自动同步课表与成绩。';
            document.body.insertBefore(banner, document.body.firstChild);
          }
        } catch (e) {}

        post({
          type: 'PROGRESS',
          message:
            href.indexOf('reAuthLoginView') !== -1 || html.indexOf('reAuthParams') !== -1
              ? '请完成海大多因子二次安全验证（短信 / 企业微信）'
              : '请完成海大统一身份认证（验证通过后自动同步）',
        });
        return;
      }

      var hasAuthUrl =
        hasAuthForm ||
        href.indexOf('/authserver/login') !== -1 ||
        href.indexOf('reAuthLoginView') !== -1;

      var isWfwHome =
        host === 'wfw.gdou.edu.cn' &&
        !isWfwSplash &&
        !hasAuthUrl &&
        !isAuthenticatedJwPortal &&
        href.indexOf('jw.gdou.edu.cn') === -1 &&
        pathname.indexOf('/authserver') !== 0;

      var isJwHost =
        href.indexOf('jw.gdou.edu.cn') !== -1 ||
        (host === 'wfw.gdou.edu.cn' && isAuthenticatedJwPortal);

      if (!isWfwHome && (!isJwHost || hasAuthUrl || !isAuthenticatedJwPortal)) return;

      window.__GDOU_SYNC_RUNNING__ = true;

      function computeJwRoot() {
        return href.indexOf('wfw.gdou.edu.cn') !== -1 ? ORIGINS.jwWfw : ORIGINS.jwDirect;
      }

      async function run() {
        try {
          if (isWfwHome) {
            try { sessionStorage.setItem('__gdou_wfw_authed__', '1'); } catch (e) {}
            post({ type: 'PROGRESS', message: '第 1 步校外微门户已通过，正在检测教务子通道...' });
          } else {
            post({ type: 'PROGRESS', message: '检测到教务登录成功，正在无痕提取课表、考试与绩点学分...' });
          }

          var root = computeJwRoot();
          var isWebVpn = root === ORIGINS.jwWfw;
          var prefix = href.indexOf('/jwglxt/') !== -1 ? '/jwglxt' : '';

          var xnm = ${overrideXnm};
          var xqm = ${overrideXqm};
          var jwReady = false;
          var sawJwAuthBounce = false;
          var prefixesToTry = prefix ? [prefix, ''] : JW_PREFIXES.slice();
          for (var i = 0; i < prefixesToTry.length; i++) {
            var p = prefixesToTry[i];
            try {
              var idxResp = await timedFetch(
                root + p + JW_PATHS.scheduleIndex,
                { credentials: 'include' },
                isWfwHome ? 8000 : 20000
              );
              if (!idxResp.ok) continue;
              var idxHtml = await idxResp.text();
              if (idxHtml.indexOf('pwdEncryptSalt') !== -1 || idxHtml.indexOf('统一身份认证') !== -1) {
                sawJwAuthBounce = true;
                if (isWfwHome) break;
                continue;
              }
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
            } catch (e) {
              if (isWfwHome) break;
            }
          }

          if (!jwReady && isWfwHome) {
            // 1) ONE-PASSWORD CAS SSO TICKET BRIDGE:
            //    Reuse the already-authenticated CASTGC on authserver.gdou.edu.cn to mint a JWXT ticket directly!
            //    WebView onShouldStartLoadWithRequest wraps the 302 Location (https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-...)
            //    into https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-... so user NEVER logs in twice!
            var outerSsoTried = false;
            try { outerSsoTried = sessionStorage.getItem('__gdou_outer_sso_tried__') === '1'; } catch (e) {}
            if (!outerSsoTried) {
              try { sessionStorage.setItem('__gdou_outer_sso_tried__', '1'); } catch (e) {}
              window.__GDOU_SYNC_RUNNING__ = false;
              post({ type: 'PROGRESS', message: '微门户已认证，正在自动复用统一认证票据免密直通教务...' });
              window.location.replace(
                ORIGINS.auth + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService)
              );
              return;
            }
            // 2) Fallback ONLY if outer CASTGC ticket bridge did not activate JWXT:
            if (!sawJwAuthBounce) {
              try {
                var primeResp = await timedFetch(ORIGINS.jwWfw, { credentials: 'include' }, 8000);
                if (primeResp && primeResp.ok) {
                  var primeHtml = await primeResp.text();
                  if (
                    primeHtml.indexOf('pwdEncryptSalt') === -1 &&
                    (primeHtml.indexOf('index_initMenu') !== -1 || primeHtml.indexOf('教学管理信息服务平台') !== -1)
                  ) {
                    window.__GDOU_SYNC_RUNNING__ = false;
                    post({ type: 'PROGRESS', message: '教务通道已免密打通，正在进入课表页面...' });
                    window.location.replace(ORIGINS.jwWfw);
                    return;
                  }
                }
              } catch (e) {}
            }
            // 3) Prime urlss="https://authserver.gdou.edu.cn" + Path=/authserver cookies before fallback auth
            try {
              await timedFetch(
                ORIGINS.authWfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService),
                { credentials: 'include' },
                6000
              );
            } catch (e) {}
            window.__GDOU_SYNC_RUNNING__ = false;
            post({ type: 'PROGRESS', message: '正在进入校外教务兜底认证页...' });
            window.location.replace(
              ORIGINS.wfw + ORIGINS.authLogin + '?service=' + encodeURIComponent(ORIGINS.jwSsoService)
            );
            return;
          }

          if (!xnm || !xqm) {
            var now = new Date();
            var y = now.getFullYear();
            var m = now.getMonth() + 1;
            if (!xnm) xnm = String(m >= 8 ? y : y - 1);
            if (!xqm) xqm = (m >= 8 || m === 1) ? '3' : '12';
          }

          var kbJson = { kbList: [] };
          var periodTimesJson = null;
          var examJson = { items: [] };
          var gradeJson = { items: [] };
          var gradeSubScoresRaw = {};
          var curriculumRaw = null;
          var emptyClassroomOptionsHtml = '';
          var emptyClassroomRaw = null;
          var campusSearchRaw = null;

          if (SYNC_JOB && SYNC_JOB.kind === 'empty_classroom') {
            post({ type: 'PROGRESS', message: '正在拉取教务空教室筛选选项与实时空闲列表...' });
            try {
              var optResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomIndex, { credentials: 'include' }, 10000);
              if (optResp && optResp.ok) {
                emptyClassroomOptionsHtml = await optResp.text();
              }
            } catch (e) {}
            try {
              var ecForm = Object.assign({}, SYNC_JOB.formParams || {});
              if (!ecForm.xnm) ecForm.xnm = xnm;
              if (!ecForm.xqm) ecForm.xqm = xqm;
              var ecResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomQuery, {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                body: encodeForm(ecForm)
              }, 15000);
              if (ecResp && ecResp.ok) {
                var ecText = (await ecResp.text()).trim();
                if (ecText.charAt(0) === '{' || ecText.charAt(0) === '[') {
                  emptyClassroomRaw = JSON.parse(ecText);
                }
              }
            } catch (e) {}
          } else if (SYNC_JOB && SYNC_JOB.kind === 'campus_search') {
            post({ type: 'PROGRESS', message: '正在无痕检索全校 / 教师 / 班级课表...' });
            var csForm = Object.assign({}, SYNC_JOB.formParams || {});
            if (!csForm.xnm) csForm.xnm = xnm;
            if (!csForm.xqm) csForm.xqm = xqm;
            for (var csi = 0; csi < JW_PATHS.campusCourseQueries.length && !campusSearchRaw; csi++) {
              try {
                var csResp = await timedFetch(root + prefix + JW_PATHS.campusCourseQueries[csi], {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  body: encodeForm(csForm)
                }, 15000);
                if (!csResp || !csResp.ok) continue;
                var csText = (await csResp.text()).trim();
                if (csText.charAt(0) === '{' || csText.charAt(0) === '[') {
                  var csParsed = JSON.parse(csText);
                  var csArr = Array.isArray(csParsed) ? csParsed : (csParsed.items || csParsed.kbList || csParsed.rows || []);
                  if (Array.isArray(csArr) && csArr.length > 0) {
                    campusSearchRaw = csParsed;
                  }
                }
              } catch (e) {}
            }
          } else {
            post({ type: 'PROGRESS', message: '正在拉取 ' + xnm + ' 学年课表数据...' });
            var kbResp = await timedFetch(root + prefix + JW_PATHS.scheduleQuery, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest'
              },
              body: encodeForm({ xnm: xnm, xqm: xqm, kzlx: 'ck', xsdm: '' })
            }, 25000);
            var kbText = (await kbResp.text()).trim();
            if (!kbResp.ok || !kbText || kbText.charAt(0) !== '{') {
              window.__GDOU_SYNC_RUNNING__ = false;
              if (isWfwHome) {
                window.location.href = ORIGINS.jwWfw;
              }
              return;
            }
            kbJson = JSON.parse(kbText);
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

            try {
              var xqhId = (kbJson.kbList && kbJson.kbList[0] && kbJson.kbList[0].xqh_id) ? String(kbJson.kbList[0].xqh_id) : '1';
              var rjcBodies = [
                encodeForm({ xnm: xnm, xqm: xqm, xqh_id: xqhId }),
                encodeForm({ xnm: xnm, xqm: xqm })
              ];
              for (var ri = 0; ri < rjcBodies.length && !periodTimesJson; ri++) {
                try {
                  var rjcResp = await timedFetch(root + prefix + JW_PATHS.periodTimes, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: rjcBodies[ri]
                  }, 10000);
                  if (!rjcResp.ok) continue;
                  var rjcText = (await rjcResp.text()).trim();
                  if (rjcText.charAt(0) === '{' || rjcText.charAt(0) === '[') {
                    var rjcParsed = JSON.parse(rjcText);
                    var arr = Array.isArray(rjcParsed) ? rjcParsed : (rjcParsed.items || rjcParsed.rows || rjcParsed.rjcList || rjcParsed.sjdList || []);
                    if (Array.isArray(arr) && arr.length >= 8) {
                      periodTimesJson = rjcParsed;
                    }
                  }
                } catch (e) {}
              }
            } catch (e) {}

            post({ type: 'PROGRESS', message: '正在拉取考试安排与考场座位...' });
            var examVariants = [
              { xnm: xnm, xqm: xqm, ksmcdmb_id: '', kch: '', kc: '', ksrq: '', kkbm_id: '', _search: 'false', nd: String(Date.now()), 'queryModel.showCount': '100', 'queryModel.currentPage': '1', 'queryModel.sortName': '', 'queryModel.sortOrder': 'asc', time: '0' },
              { xnm: xnm, xqm: '', 'queryModel.showCount': '100', 'queryModel.currentPage': '1' },
              { xnm: '', xqm: '', 'queryModel.showCount': '100', 'queryModel.currentPage': '1' }
            ];
            var examAttempts = 0;
            var examAbortedEarly = false;
            for (var u = 0; u < JW_PATHS.examQueries.length && (!examJson.items || examJson.items.length === 0) && !examAbortedEarly && examAttempts < 4; u++) {
              for (var b = 0; b < examVariants.length && examAttempts < 4; b++) {
                examAttempts++;
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
                  if (exResp.status === 401 || exResp.status === 403 || exResp.status === 429 || exResp.status === 901) {
                    examAbortedEarly = true;
                    break;
                  }
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

            post({ type: 'PROGRESS', message: '正在拉取全部学期成绩、分项明细与培养方案...' });
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

            // Best-effort grade sub-scores (recent 12 courses with jxb_id)
            try {
              var gList = (gradeJson.items || gradeJson.rows || []).filter(function(it) {
                return it && it.jxb_id && it.xnm && it.xqm;
              }).slice(0, 12);
              for (var gi = 0; gi < gList.length; gi++) {
                var git = gList[gi];
                try {
                  var sdResp = await timedFetch(root + prefix + JW_PATHS.gradeDetailQueries[0], {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: encodeForm({ xnm: String(git.xnm), xqm: String(git.xqm), jxb_id: String(git.jxb_id), kcmc: String(git.kcmc || '') })
                  }, 5000);
                  if (sdResp && sdResp.ok) {
                    var sdTxt = (await sdResp.text()).trim();
                    if (sdTxt && sdTxt.indexOf('pwdEncryptSalt') === -1) {
                      gradeSubScoresRaw[String(git.jxb_id)] = sdTxt;
                    }
                  }
                } catch (e) {}
              }
            } catch (e) {}

            // Best-effort official graduation curriculum audit
            try {
              for (var ci = 0; ci < JW_PATHS.curriculumTreeQueries.length && !curriculumRaw; ci++) {
                try {
                  var curResp = await timedFetch(root + prefix + JW_PATHS.curriculumTreeQueries[ci], {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                      'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: encodeForm({ xfyqjd_id: '', xscjcx: '1' })
                  }, 7000);
                  if (curResp && curResp.ok) {
                    var curTxt = (await curResp.text()).trim();
                    if (curTxt && curTxt.indexOf('pwdEncryptSalt') === -1) {
                      curriculumRaw = curTxt;
                    }
                  }
                } catch (e) {}
              }
              if (!curriculumRaw) {
                var curHtmlResp = await timedFetch(root + prefix + JW_PATHS.curriculumIndex, { credentials: 'include' }, 7000);
                if (curHtmlResp && curHtmlResp.ok) {
                  var curHtml = await curHtmlResp.text();
                  if (curHtml && curHtml.indexOf('pwdEncryptSalt') === -1) {
                    curriculumRaw = curHtml;
                  }
                }
              }
            } catch (e) {}

            // Best-effort today's empty classroom snapshot
            try {
              var snapOptResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomIndex, { credentials: 'include' }, 6000);
              if (snapOptResp && snapOptResp.ok) {
                emptyClassroomOptionsHtml = await snapOptResp.text();
              }
              var snapXqh = (kbJson.kbList && kbJson.kbList[0] && kbJson.kbList[0].xqh_id) ? String(kbJson.kbList[0].xqh_id) : '';
              var snapResp = await timedFetch(root + prefix + JW_PATHS.emptyClassroomQuery, {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                body: encodeForm({
                  fwzt: 'cx', xqh_id: snapXqh, xnm: xnm, xqm: xqm,
                  cdlb_id: '', cdejlb_id: '', qszws: '', jszws: '', cdmc: '', lh: '', jyfs: '0',
                  cdjylx: '', sfbhkc: '', zcd: TODAY_EMPTY_MASK.weekMask, xqj: TODAY_EMPTY_MASK.dayOfWeek,
                  jcd: TODAY_EMPTY_MASK.sectionMask, _search: 'false', nd: String(Date.now()),
                  'queryModel.showCount': '150', 'queryModel.currentPage': '1',
                  'queryModel.sortName': 'cdbh', 'queryModel.sortOrder': 'asc', time: '0'
                })
              }, 7000);
              if (snapResp && snapResp.ok) {
                var snapTxt = (await snapResp.text()).trim();
                if (snapTxt.charAt(0) === '{' || snapTxt.charAt(0) === '[') {
                  emptyClassroomRaw = JSON.parse(snapTxt);
                }
              }
            } catch (e) {}
          }

          // Real HTTP-verified logout + web storage cleanup
          // Use explicit authWfw (/https://authserver.gdou.edu.cn/authserver/logout) under wfw so urlss=jw never 404s
          var logoutTargets = [root + prefix + '/logout'];
          if (isWebVpn) logoutTargets.push(ORIGINS.wfw + '/logout');
          var casLogoutUrl = (isWebVpn ? ORIGINS.authWfw : ORIGINS.auth) + ORIGINS.authLogout;
          var logoutAttempted = 0;
          var logoutSucceeded = 0;
          var failedEndpoints = [];
          var casLoggedOut = false;

          for (var li = 0; li < logoutTargets.length; li++) {
            logoutAttempted++;
            try {
              var lr = await timedFetch(logoutTargets[li], { credentials: 'include' }, 8000);
              if (lr.ok || (lr.status >= 300 && lr.status < 400)) logoutSucceeded++;
              else failedEndpoints.push(stripUrlQuery(logoutTargets[li]) + ' (HTTP ' + lr.status + ')');
            } catch (e) {
              failedEndpoints.push(stripUrlQuery(logoutTargets[li]));
            }
          }
          logoutAttempted++;
          try {
            var casResp = await timedFetch(casLogoutUrl, { credentials: 'include' }, 8000);
            if (casResp.ok || (casResp.status >= 300 && casResp.status < 400)) {
              casLoggedOut = true;
              logoutSucceeded++;
            } else {
              failedEndpoints.push(stripUrlQuery(casLogoutUrl) + ' (HTTP ' + casResp.status + ')');
            }
          } catch (e) {
            failedEndpoints.push(stripUrlQuery(casLogoutUrl));
          }

          var storageCleaned = false;
          try {
            sessionStorage.clear();
            localStorage.clear();
            storageCleaned = sessionStorage.length === 0 && localStorage.length === 0;
          } catch (e) {
            storageCleaned = false;
          }

          post({
            type: 'SYNC_COMPLETE',
            jobKind: SYNC_JOB ? SYNC_JOB.kind : 'full_sync',
            xnm: xnm,
            xqm: xqm,
            isWebVpn: isWebVpn,
            scheduleRaw: kbJson,
            periodTimesRaw: periodTimesJson,
            examRaw: examJson,
            gradeRaw: gradeJson,
            gradeSubScoresRaw: gradeSubScoresRaw,
            curriculumRaw: curriculumRaw,
            emptyClassroomOptionsHtml: emptyClassroomOptionsHtml,
            emptyClassroomRaw: emptyClassroomRaw,
            campusSearchRaw: campusSearchRaw,
            storageCleaned: storageCleaned,
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
