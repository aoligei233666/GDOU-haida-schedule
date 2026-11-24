/**
 * Single source of truth for all Guangdong Ocean University (GDOU)
 * CAS / WebVPN / 正方教务 (ZFSoft) endpoints, parameter variants, and host allowlists.
 * Shared identically by direct fetch sync and incognito WebView sync script.
 */

export const GDOU_AUTH_ORIGIN = 'https://authserver.gdou.edu.cn';
export const GDOU_WFW_ORIGIN = 'https://wfw.gdou.edu.cn';
export const GDOU_AUTH_WFW_BASE = 'https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn';
export const GDOU_JW_DIRECT_ORIGIN = 'https://jw.gdou.edu.cn';
export const GDOU_JW_WFW_BASE = 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn';
export const GDOU_JW_SSO_SERVICE = 'https://jw.gdou.edu.cn/sso/jziotlogin';
export const GDOU_JW_WFW_SSO_SERVICE =
  'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin';

export const DEFAULT_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const GDOU_JW_PREFIXES = ['', '/jwglxt'] as const;

export const GDOU_JW_PATHS = {
  scheduleIndex: '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default',
  scheduleQuery: '/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151',
  periodTimes: '/kbcx/xskbcx_cxRjc.html?gnmkdm=N2151',
  examQueries: [
    '/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358105',
    '/kwgl/kscx_cxXsksxxIndex.html?doType=query&gnmkdm=N358110',
    '/kwgl/kscx_cxXsksxx.html?doType=query&gnmkdm=N358105',
  ] as const,
  gradeQueries: [
    '/cjcx/cjcx_cxXsgrcj.html?doType=query&gnmkdm=N305005',
    '/cjcx/cjcx_cxDgXscj.html?doType=query&gnmkdm=N305005',
  ] as const,
  logoutSuffixes: ['/logout', '/jwglxt/logout'] as const,
};

export const GDOU_AUTH_PATHS = {
  login: '/authserver/login',
  logout: '/authserver/logout',
  bfpInfo: '/authserver/bfp/info',
  checkNeedCaptcha: '/authserver/checkNeedCaptcha.htl',
  getCaptcha: '/authserver/getCaptcha.htl',
  changeReAuthType: '/authserver/reAuthCheck/changeReAuthType.do',
  getReAuthCode: '/authserver/dynamicCode/getDynamicCodeByReauth.do',
  reAuthSubmit: '/authserver/reAuthCheck/reAuthSubmit.do',
} as const;

export const GDOU_WFW_LOGOUT_URLS = [
  `${GDOU_WFW_ORIGIN}/authserver/logout`,
  `${GDOU_WFW_ORIGIN}/logout`,
] as const;

export function buildExamParamVariants(
  xnm: string,
  xqm: string,
  timestampMs: number = Date.now()
): Record<string, string>[] {
  return [
    {
      xnm,
      xqm,
      ksmcdmb_id: '',
      kch: '',
      kc: '',
      ksrq: '',
      kkbm_id: '',
      _search: 'false',
      nd: String(timestampMs),
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
    {
      xnm: '',
      xqm: '',
      'queryModel.showCount': '100',
      'queryModel.currentPage': '1',
    },
  ];
}

export function buildGradeQueryParams(
  timestampMs: number = Date.now()
): Record<string, string> {
  return {
    xnm: '',
    xqm: '',
    _search: 'false',
    nd: String(timestampMs),
    'queryModel.showCount': '5000',
    'queryModel.currentPage': '1',
    'queryModel.sortName': '',
    'queryModel.sortOrder': 'asc',
    time: '0',
  };
}

export const ALLOWED_WEBVIEW_TRUSTED_HOSTS = [
  'netcheck.gdou.edu.cn',
  'authserver.gdou.edu.cn',
  'wfw.gdou.edu.cn',
  'jw.gdou.edu.cn',
] as const;

function isOfficialGdouHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'gdou.edu.cn' || host.endsWith('.gdou.edu.cn');
}

/**
 * If GDOU's reverse proxy emits a cleartext `http://*.gdou.edu.cn/...` redirect
 * (e.g. `http://authserver.gdou.edu.cn/authserver/reAuthCheck/reAuthLoginView.do?...`),
 * return the equivalent strict HTTPS URL so WebView can upgrade seamlessly without
 * ever permitting cleartext traffic. Returns `null` for non-HTTP or non-GDOU URLs.
 */
export function upgradeGdouHttpToHttps(rawUrl: string): string | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return null;
    if (!isOfficialGdouHost(parsed.hostname)) return null;
    parsed.protocol = 'https:';
    if (parsed.port === '80') {
      parsed.port = '';
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Normalize GDOU off-campus WebVPN (`wfw.gdou.edu.cn`) proxied authserver URLs such as
 * `https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/authserver/...` or
 * `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/authserver/...` back to
 * `https://wfw.gdou.edu.cn/authserver/...`.
 *
 * Why: `wfw.gdou.edu.cn` emits `JSESSIONID` and `route` with `Path=/authserver`.
 * Requests whose path starts with `/https://...` omit both cookies, causing captcha,
 * SMS dynamic codes, and MFA (`reAuthLoginView.do`) to lose session and reset to login.
 */
export function normalizeWfwAuthUrl(rawUrl: string): string | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /^https?:\/\/wfw\.gdou\.edu\.cn\/https?:\/\/(?:authserver|jw)\.gdou\.edu\.cn(\/authserver\/.*)$/i
  );
  if (!match) return null;
  return `${GDOU_WFW_ORIGIN}${match[1]}`;
}

/**
 * Heal broken off-campus WebVPN (`wfw.gdou.edu.cn`) SSO callback URLs:
 * 1. `https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/sso/jziotlogin*` (HTTP 404 on authserver)
 * 2. `https://wfw.gdou.edu.cn/sso/jziotlogin*` (HTTP 500/404 when urlss!=jw)
 * -> `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin*`.
 * 3. On `wfw.gdou.edu.cn/.../authserver/login?service=https://jw.gdou.edu.cn/sso/jziotlogin`,
 *    upgrade the unproxied campus `service` param to `GDOU_JW_WFW_SSO_SERVICE`.
 */
export function healWfwWrongSsoUrl(rawUrl: string): string | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;

  const wrongSsoMatch = trimmed.match(
    /^https?:\/\/wfw\.gdou\.edu\.cn(?:\/https?:\/\/authserver\.gdou\.edu\.cn)?\/sso\/jziotlogin([?#].*)?$/i
  );
  if (wrongSsoMatch) {
    return `${GDOU_JW_WFW_SSO_SERVICE}${wrongSsoMatch[1] || ''}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() === 'wfw.gdou.edu.cn') {
      const svc = parsed.searchParams.get('service');
      if (svc && /^https?:\/\/jw\.gdou\.edu\.cn\/sso\/jziotlogin/i.test(svc)) {
        const suffix = svc.replace(/^https?:\/\/jw\.gdou\.edu\.cn\/sso\/jziotlogin/i, '');
        parsed.searchParams.set('service', `${GDOU_JW_WFW_SSO_SERVICE}${suffix}`);
        return parsed.toString();
      }
    }
  } catch {
    // Ignore malformed URLs
  }
  return null;
}

/**
 * Ensure bare GDOU CAS `/authserver/login` bounces (e.g. after expired MFA redirect)
 * preserve the target `?service=` query parameter so the user never lands stranded on
 * CAS personal center instead of redirecting back into `wfw` or `jw`.
 */
export function ensureAuthLoginServiceParam(rawUrl: string, fallbackServiceUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || !fallbackServiceUrl) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const isAuthLoginPath =
      parsed.pathname === GDOU_AUTH_PATHS.login ||
      parsed.pathname === `/https://authserver.gdou.edu.cn${GDOU_AUTH_PATHS.login}` ||
      parsed.pathname === `/https://jw.gdou.edu.cn${GDOU_AUTH_PATHS.login}`;
    if (
      parsed.protocol === 'https:' &&
      (host === 'authserver.gdou.edu.cn' || host === 'wfw.gdou.edu.cn') &&
      isAuthLoginPath
    ) {
      const curSvc = parsed.searchParams.get('service');
      if (!curSvc) {
        parsed.searchParams.set('service', fallbackServiceUrl);
        return parsed.toString();
      }
      if (host === 'wfw.gdou.edu.cn' && /^https?:\/\/jw\.gdou\.edu\.cn\/sso\/jziotlogin/i.test(curSvc)) {
        const suffix = curSvc.replace(/^https?:\/\/jw\.gdou\.edu\.cn\/sso\/jziotlogin/i, '');
        parsed.searchParams.set('service', `${GDOU_JW_WFW_SSO_SERVICE}${suffix}`);
        return parsed.toString();
      }
    }
  } catch {
    // Return original string if URL parsing fails
  }
  return trimmed;
}

/**
 * Strictly validate WebView navigation URLs:
 * only allow `about:blank` or HTTPS URLs under `*.gdou.edu.cn`.
 */
export function isAllowedWebViewNavigationUrl(rawUrl: string): boolean {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || trimmed === 'about:blank') return true;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    return isOfficialGdouHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Strictly validate WebView `onMessage` sender URL against trusted GDOU auth/JW origins.
 */
export function isTrustedWebViewMessageUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (ALLOWED_WEBVIEW_TRUSTED_HOSTS as readonly string[]).includes(host);
  } catch {
    return false;
  }
}
