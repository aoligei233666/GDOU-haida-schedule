/**
 * Single source of truth for all Guangdong Ocean University (GDOU)
 * CAS / WebVPN / 正方教务 (ZFSoft) endpoints, parameter variants, and host allowlists.
 * Shared identically by direct fetch sync and incognito WebView sync script.
 */

export const GDOU_AUTH_ORIGIN = 'https://authserver.gdou.edu.cn';
export const GDOU_WFW_ORIGIN = 'https://wfw.gdou.edu.cn';
export const GDOU_JW_DIRECT_ORIGIN = 'https://jw.gdou.edu.cn';
export const GDOU_JW_WFW_BASE = 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn';
export const GDOU_JW_SSO_SERVICE = 'https://jw.gdou.edu.cn/sso/jziotlogin';

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
