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
  gradeDetailQueries: [
    '/cjcx/cjcx_cxCjxqGjh.html?gnmkdm=N305005',
    '/cjcx/cjcx_cxXsgrcjDetail.html?gnmkdm=N305005',
  ] as const,
  curriculumIndex: '/xsxy/xsxyqk_cxXsxyqkIndex.html?gnmkdm=N105515&layout=default',
  curriculumTreeQueries: [
    '/xsxy/xsxyqk_cxJxzxjhxfyq.html?gnmkdm=N105515',
    '/xsxy/xsxyqk_cxXsxyqkIndex.html?doType=query&gnmkdm=N105515',
  ] as const,
  emptyClassroomIndex: '/cdjy/cdjy_cxKxcdlb.html?gnmkdm=N2155&layout=default',
  emptyClassroomQuery: '/cdjy/cdjy_cxKxcdlb.html?doType=query&gnmkdm=N2155',
  campusCourseQueries: [
    '/kbcx/qxxk_cxQxxk.html?doType=query&gnmkdm=N2156',
    '/rwlscx/rwlscx_cxRwls.html?doType=query&gnmkdm=N2199',
    '/kbdy/bjkbdy_cxBjKb.html?doType=query&gnmkdm=N214505',
    '/kbcx/xskbcx_cxXskbcx.html?doType=query&gnmkdm=N2151',
  ] as const,
  logoutSuffixes: ['/logout', '/jwglxt/logout'] as const,
};

/**
 * Compute Zhengfang bitmask for weeks (`zcd`) or sections (`jcd`):
 * index 1 => 2^0 = 1, index 2 => 2^1 = 2, [1, 2] => 3.
 */
export function buildZhengfangBitmask(indices: number[], maxIndex = 24): number {
  let mask = 0;
  for (const idx of indices) {
    if (Number.isInteger(idx) && idx >= 1 && idx <= maxIndex) {
      mask |= 1 << (idx - 1);
    }
  }
  return mask;
}

export function buildEmptyClassroomQueryParams(params: {
  xnm: string;
  xqm: string;
  campusId?: string;
  buildingId?: string;
  roomTypeId?: string;
  week: number;
  dayOfWeek: number;
  sections: number[];
  minSeats?: number;
  timestampMs?: number;
}): Record<string, string> {
  const zcdMask = buildZhengfangBitmask([params.week], 30);
  const jcdMask = buildZhengfangBitmask(params.sections, 16);
  return {
    fwzt: 'cx',
    xqh_id: params.campusId || '',
    xnm: params.xnm,
    xqm: params.xqm,
    cdlb_id: params.roomTypeId || '',
    cdejlb_id: '',
    qszws: params.minSeats && params.minSeats > 0 ? String(params.minSeats) : '',
    jszws: '',
    cdmc: '',
    lh: params.buildingId || '',
    jyfs: '0',
    cdjylx: '',
    sfbhkc: '',
    zcd: String(zcdMask),
    xqj: String(params.dayOfWeek),
    jcd: String(jcdMask),
    _search: 'false',
    nd: String(params.timestampMs ?? Date.now()),
    'queryModel.showCount': '200',
    'queryModel.currentPage': '1',
    'queryModel.sortName': 'cdbh',
    'queryModel.sortOrder': 'asc',
    time: '0',
  };
}

export function buildCampusCourseSearchParams(params: {
  xnm: string;
  xqm: string;
  keyword: string;
  teacher?: string;
  className?: string;
  dayOfWeek?: number;
  timestampMs?: number;
}): Record<string, string> {
  const kw = params.keyword.trim();
  const teacher = (params.teacher || '').trim();
  const className = (params.className || '').trim();
  return {
    xnm: params.xnm,
    xqm: params.xqm,
    kcmc: kw,
    kch: kw,
    jsxm: teacher,
    jxbmc: className,
    bjmc: className,
    xqj: params.dayOfWeek && params.dayOfWeek >= 1 && params.dayOfWeek <= 7 ? String(params.dayOfWeek) : '',
    _search: 'false',
    nd: String(params.timestampMs ?? Date.now()),
    'queryModel.showCount': '100',
    'queryModel.currentPage': '1',
    'queryModel.sortName': '',
    'queryModel.sortOrder': 'asc',
    time: '0',
  };
}

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
  if (match) {
    return `${GDOU_WFW_ORIGIN}${match[1]}`;
  }
  return null;
}

/**
 * When off-campus WebVPN (`wfw.gdou.edu.cn`) 1-step auth is active, keep bare
 * `http(s)://authserver.gdou.edu.cn/authserver/...` redirects/tabs inside
 * `https://wfw.gdou.edu.cn/authserver/...` so `WFWSESSID` and `Path=/authserver`
 * `JSESSIONID`/`route` cookies remain attached throughout login, SMS dynamic login, and MFA.
 */
export function keepAuthInsideWfw(rawUrl: string, isOffCampusWfw = false): string | null {
  if (!isOffCampusWfw) return null;
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;
  const bareAuthMatch = trimmed.match(
    /^https?:\/\/authserver\.gdou\.edu\.cn(?::(?:80|443))?(\/authserver\/.*)$/i
  );
  if (!bareAuthMatch) return null;
  // Do not rewrite explicit outer wfw-root portal ticket requests
  if (trimmed.includes(encodeURIComponent(`${GDOU_WFW_ORIGIN}/`))) {
    return null;
  }
  return `${GDOU_WFW_ORIGIN}${bareAuthMatch[1]}`;
}

/**
 * Heal broken off-campus WebVPN (`wfw.gdou.edu.cn`) SSO callback & leaked campus URLs:
 * 1. `https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/sso/jziotlogin*` (HTTP 404 on authserver)
 * 2. `https://wfw.gdou.edu.cn/sso/jziotlogin*` (HTTP 500/404 when urlss!=jw)
 * -> `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin*`.
 * 3. When off-campus WebVPN is active (`isOffCampusWfw = true`), wrap bare `http(s)://jw.gdou.edu.cn/...`
 *    callbacks (e.g. post-Step-2 `https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-...`) into
 *    `https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/...` so the ticket is exchanged inside `WFWSESSID`!
 *
 * IMPORTANT: Never rewrite `?service=https://jw.gdou.edu.cn/sso/jziotlogin` into `wfw/...`,
 * because campus `jw.gdou.edu.cn` validates `ST-...` tickets strictly against `https://jw.gdou.edu.cn/sso/jziotlogin`.
 */
export function healWfwWrongSsoUrl(rawUrl: string, isOffCampusWfw = false): string | null {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return null;

  const wrongSsoMatch = trimmed.match(
    /^https?:\/\/wfw\.gdou\.edu\.cn(?:\/https?:\/\/authserver\.gdou\.edu\.cn)?\/sso\/jziotlogin([?#].*)?$/i
  );
  if (wrongSsoMatch) {
    return `${GDOU_JW_WFW_SSO_SERVICE}${wrongSsoMatch[1] || ''}`;
  }

  if (isOffCampusWfw) {
    const bareJwMatch = trimmed.match(/^https?:\/\/jw\.gdou\.edu\.cn(?::(?:80|443))?([/?#].*)?$/i);
    if (bareJwMatch) {
      const rest = bareJwMatch[1] || '';
      const normalizedRest = rest && !rest.startsWith('/') ? `/${rest}` : rest;
      return `${GDOU_JW_WFW_BASE}${normalizedRest}`;
    }
  }

  return null;
}

/**
 * Extract only the lowercase hostname from a URL for safe error/timeout diagnostics
 * (never leaks path params, query tickets, or credentials).
 */
export function extractSafeHostname(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return '';
  }
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
      isAuthLoginPath &&
      !parsed.searchParams.get('service')
    ) {
      parsed.searchParams.set('service', fallbackServiceUrl);
      return parsed.toString();
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
