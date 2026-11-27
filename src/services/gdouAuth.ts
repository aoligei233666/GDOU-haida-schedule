import {
  DEFAULT_DESKTOP_UA,
  extractSafeHostname,
  GDOU_AUTH_ORIGIN,
  GDOU_AUTH_PATHS,
  GDOU_AUTH_WFW_BASE,
  GDOU_JW_DIRECT_ORIGIN,
  GDOU_JW_SSO_SERVICE,
  GDOU_JW_WFW_BASE,
  GDOU_JW_WFW_SSO_SERVICE,
  GDOU_WFW_ORIGIN,
  healWfwWrongSsoUrl,
  upgradeGdouHttpToHttps,
} from '../constants/gdouEndpoints';
import { GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import {
  EphemeralCredentials,
  LogoutVerificationDetails,
  SyncReceipt,
} from '../types/models';
import {
  areCredentialsPurged,
  encryptGdouPassword,
  generateSecureHex,
  purgeEphemeralCredentials,
} from './cryptoAes';
import { sanitizeEndpointUrl } from './zeroRetentionSanitizer';
import {
  arrayBufferToBase64,
  buildHeadersWithOptionalNativeControl,
  clearPendingMfaSecret,
  createAbortError,
  createBoundedSyncController,
  encodeFormBody,
  extractAuthError,
  extractHiddenInput,
  extractServiceUrl,
  fetchWithTimeout,
  isAccountLockedMessage,
  isNativeMobileRuntime,
  sleepAbortable,
} from './auth/httpClient';
import { pullAllJwData } from './auth/jwDataClient';
import {
  AuthRequestOptions,
  AuxiliarySyncJob,
  CaptchaCheckResult,
  DIRECT_JW_PROBE_TIMEOUT_MS,
  GdouRoutePref,
  MfaChallengeState,
  MfaCompletionOutcome,
  NETCHECK_PROBE_TIMEOUT_MS,
  OneShotSyncOutcome,
  PreparedAuthSession,
  SyncResult,
  SyncTermOverride,
  WfwSubAuthState,
} from './auth/types';
import {
  buildIncognitoWebViewPreloadScript,
  buildIncognitoWebViewSyncScript,
} from './auth/webviewScripts';

export {
  buildIncognitoWebViewPreloadScript,
  buildIncognitoWebViewSyncScript,
  clearPendingMfaSecret,
  extractAuthError,
  fetchWithTimeout,
  isAccountLockedMessage,
  isNativeMobileRuntime,
};
export type {
  AuthRequestOptions,
  AuxiliarySyncJob,
  CaptchaCheckResult,
  GdouRoutePref,
  MfaChallengeState,
  MfaCompletionOutcome,
  OneShotSyncOutcome,
  PreparedAuthSession,
  SyncResult,
  SyncTermOverride,
  WfwSubAuthState,
};

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

  // TRUE 1-STEP OFF-CAMPUS AUTH:
  // `wfw.gdou.edu.cn/authserver/login?service=https://jw.gdou.edu.cn/sso/jziotlogin` directly issues
  // `WFWSESSID` (Path=/), `JSESSIONID` & `route` (Path=/authserver) and authenticates straight into
  // `jw.gdou.edu.cn` via campus `GDOU_JW_SSO_SERVICE` in ONE single login (ZERO wfw portal detour,
  // ZERO second password, ZERO second MFA).
  const serviceUrl = isWebVpn
    ? GDOU_JW_SSO_SERVICE
    : extractServiceUrl(netHtml) || GDOU_JW_SSO_SERVICE;
  const authOrigin = isWebVpn ? GDOU_WFW_ORIGIN : GDOU_AUTH_ORIGIN;
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

  // Defensive fallback: if wfw `/authserver/login` ever returned 404 or missed login tokens,
  // prime `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn` directly (official netcheck target).
  if (isWebVpn && (!authResp.ok || !extractHiddenInput(authHtml, 'pwdEncryptSalt'))) {
    const primeResp = await fetchWithTimeout(
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
    if (primeResp.status === 403) {
      throw new Error('海大校外微门户返回 HTTP 403，请关闭手机 VPN / 代理或切换 4G/5G 流量后重试');
    }
    const primeHtml = await primeResp.text();
    if (extractHiddenInput(primeHtml, 'pwdEncryptSalt')) {
      authResp = primeResp;
      authHtml = primeHtml;
    }
  }

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
      authHtml.includes('教务管理系统') ||
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

function isJwPortalReadyResponse(url: string, html: string): boolean {
  if (
    html.includes('pwdEncryptSalt') ||
    html.includes('reAuthParams') ||
    html.includes('统一身份认证平台')
  ) {
    return false;
  }
  return (
    url.includes('index_initMenu') ||
    url.includes('/xtgl/') ||
    html.includes('index_initMenu') ||
    html.includes('教学管理信息服务平台') ||
    html.includes('教务管理系统') ||
    html.includes('xskbcx') ||
    html.includes('xnm')
  );
}

async function completeCasToJwHandoff(
  session: PreparedAuthSession,
  needWfwActivation: boolean,
  ephemeralForWfw?: { username: string; password: string },
  options: AuthRequestOptions = {},
  previousSteps: string[] = []
): Promise<CasHandoffOutcome> {
  const ua = options.userAgent ?? DEFAULT_DESKTOP_UA;

  if (session.isWebVpn) {
    // 1-STEP OFF-CAMPUS WFW AUTH (`session.authOrigin === GDOU_WFW_ORIGIN` or `GDOU_AUTH_WFW_BASE`):
    // User already authenticated directly on `wfw.gdou.edu.cn/authserver/login?service=https://jw.gdou.edu.cn/sso/jziotlogin`
    // (including single MFA if prompted). Mint/follow the `ST-...` ticket straight into `wfw/https://jw.gdou.edu.cn`!
    if (session.authOrigin === GDOU_WFW_ORIGIN || session.authOrigin === GDOU_AUTH_WFW_BASE) {
      const p1TicketUrl = `${session.authOrigin}${GDOU_AUTH_PATHS.login}?service=${encodeURIComponent(
        GDOU_JW_SSO_SERVICE
      )}`;
      const ticketResp = await fetchWithTimeout(
        p1TicketUrl,
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

      if (ticketResp.status >= 300 && ticketResp.status < 400) {
        const rawLoc = (ticketResp.headers.get('location') || '').trim();
        if (rawLoc) {
          const upgradedLoc = upgradeGdouHttpToHttps(rawLoc) ?? rawLoc;
          if (upgradedLoc.includes('reAuthLoginView.do')) {
            const mfaUrl = upgradedLoc.replace(
              /^https:\/\/authserver\.gdou\.edu\.cn(\/authserver\/)/i,
              `${GDOU_WFW_ORIGIN}$1`
            );
            const mfaViewResp = await fetchWithTimeout(
              mfaUrl,
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
                    authOrigin: GDOU_WFW_ORIGIN,
                    serviceUrl: GDOU_JW_SSO_SERVICE,
                  },
                  previousSteps,
                },
              };
            }
          } else {
            const wrappedJwTicketUrl = healWfwWrongSsoUrl(upgradedLoc, true) ?? upgradedLoc;
            await fetchWithTimeout(
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
            return { status: 'ready' };
          }
        }
      } else if (ticketResp.ok) {
        const ticketHtml = await ticketResp.text();
        if (
          (ticketResp.url || '').includes('reAuthLoginView.do') ||
          ticketHtml.includes('reAuthParams') ||
          ticketHtml.includes('多因子认证')
        ) {
          const userIdMatch = ticketHtml.match(/"reAuthUserId"\s*:\s*"([^"]+)"/);
          const typeMatch = ticketHtml.match(/"reAuthType"\s*:\s*"([34])"/);
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
                authOrigin: session.authOrigin,
                serviceUrl: GDOU_JW_SSO_SERVICE,
              },
              previousSteps,
            },
          };
        }
        if (!ticketHtml.includes('pwdEncryptSalt')) {
          return { status: 'ready' };
        }
      }
      if (session.authOrigin === GDOU_AUTH_WFW_BASE) {
        return { status: 'ready' };
      }
    }

    // Legacy Phase 1 -> Activate WFWSESSID on wfw.gdou.edu.cn via outer CAS service=https://wfw.gdou.edu.cn/
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

    // Legacy Phase 1.5 -> Outer CAS SSO ticket bridge (kept as resilient fallback when authOrigin is outer authserver)
    if (session.authOrigin === GDOU_AUTH_ORIGIN) {
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
                  isJwPortalReadyResponse(exchangeResp.url || '', exchangeHtml)
                ) {
                  return { status: 'ready' };
                }
              }
            }
          }
        } else if (outerResp.ok) {
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
          if (isJwPortalReadyResponse(bridgeUrl, bridgeHtml)) {
            return { status: 'ready' };
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        // Non-fatal: gracefully fall back to proxied wfw sub-auth discovery below
      }
    }

    // Phase 2 -> Fallback: probe proxied jw entry inside active WFWSESSID
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
      isJwPortalReadyResponse(jwEntryResp.url || '', jwEntryHtml)
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
      isJwPortalReadyResponse(loginFinalUrl, loginHtml) ||
      (loginFinalUrl.includes('jw.gdou.edu.cn') &&
        !loginHtml.includes('pwdEncryptSalt') &&
        !loginHtml.includes('reAuthParams'));
    const needWfwActivation =
      session.isWebVpn &&
      session.authOrigin === GDOU_AUTH_ORIGIN &&
      !loginFinalUrl.includes('wfw.gdou.edu.cn');
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
