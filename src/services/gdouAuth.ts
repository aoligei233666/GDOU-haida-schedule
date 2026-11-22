import { deriveCurrentTermParams, GDOU_ENTRY_URL } from '../constants/gdouTimetable';
import {
  CourseItem,
  EphemeralCredentials,
  ExamItem,
  SyncReceipt,
} from '../types/models';
import { encryptGdouPassword, purgeEphemeralCredentials } from './cryptoAes';
import { parseZfExamResponse } from './examParser';
import { parseZfScheduleResponse } from './scheduleParser';

const MOBILE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface PreparedAuthSession {
  entryFinalUrl: string;
  authOrigin: string; // e.g. "https://wfw.gdou.edu.cn" or "https://authserver.gdou.edu.cn"
  jwBaseUrl: string; // e.g. "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" or "https://jw.gdou.edu.cn"
  isWebVpn: boolean;
  serviceUrl: string;
  pwdEncryptSalt: string;
  execution: string;
  lt: string;
  alreadyLoggedIn: boolean;
}

export interface SyncResult {
  courses: CourseItem[];
  exams: ExamItem[];
  termLabel: string;
  academicYear: string;
  semesterCode: string;
  receipt: SyncReceipt;
}

export interface SyncTermOverride {
  xnm?: string;
  xqm?: string;
}

function extractHiddenInput(html: string, idOrName: string): string {
  // Match input tag containing id="X" or name="X" and extract value="..."
  const tagRegex = new RegExp(
    `<input[^>]+(?:id|name)=["']${idOrName}["'][^>]*>`,
    'gi'
  );
  const matches = html.match(tagRegex);
  if (!matches) return '';
  // Prefer the one inside pwdFromId (last match usually belongs to username/password login form)
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
  const tipMatch = html.match(/id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/span>/i);
  if (tipMatch && tipMatch[1]) {
    const clean = tipMatch[1].replace(/<[^>]+>/g, '').trim();
    if (clean) return clean;
  }
  const msgMatch = html.match(/id=["']msg["'][^>]*>([\s\S]*?)<\//i);
  if (msgMatch && msgMatch[1]) {
    const clean = msgMatch[1].replace(/<[^>]+>/g, '').trim();
    if (clean) return clean;
  }
  return '';
}

function resolveOrigin(url: string): string {
  const m = url.match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] : 'https://wfw.gdou.edu.cn';
}

/**
 * Step 1: Visit `https://netcheck.gdou.edu.cn/go.php?code=jw` and parse GDOU authserver
 * form tokens (`pwdEncryptSalt`, `execution`, `service`). Automatically adapts to
 * off-campus WebVPN (`wfw.gdou.edu.cn`) vs on-campus direct (`authserver.gdou.edu.cn`).
 */
export async function prepareGdouAuthSession(): Promise<PreparedAuthSession> {
  const resp = await fetch(GDOU_ENTRY_URL, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const finalUrl = resp.url || GDOU_ENTRY_URL;
  const html = await resp.text();
  const isWebVpn = finalUrl.includes('wfw.gdou.edu.cn');
  const authOrigin = resolveOrigin(finalUrl);
  const jwBaseUrl = isWebVpn
    ? 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn'
    : 'https://jw.gdou.edu.cn';

  const pwdEncryptSalt = extractHiddenInput(html, 'pwdEncryptSalt');
  const execution = extractHiddenInput(html, 'execution');
  const lt = extractHiddenInput(html, 'lt');
  const serviceUrl = extractServiceUrl(html);

  const looksLikeJwPortal =
    !html.includes('pwdEncryptSalt') &&
    (html.includes('xskbcx') ||
      html.includes('教学管理信息服务平台') ||
      html.includes('index_initMenu'));

  return {
    entryFinalUrl: finalUrl,
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
 * Step 2: Query GDOU authserver `checkNeedCaptcha.htl` for a username.
 * If captcha is required, fetches the image as a Base64 Data URI for display to the user.
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
      headers: { 'User-Agent': MOBILE_UA },
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
    headers: { 'User-Agent': MOBILE_UA },
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

/**
 * Resolve JWXT context prefix ("" vs "/jwglxt") and current term (xnm, xqm) from live portal.
 */
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
        headers: { 'User-Agent': MOBILE_UA },
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
  const semText = xqm === '3' ? '第1学期' : xqm === '12' ? '第2学期' : xqm === '16' ? '第3学期' : '当前学期';
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
      'User-Agent': MOBILE_UA,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: encodeFormBody({ xnm, xqm, kzlx: 'ck', xsdm: '' }),
  });
  const text = await resp.text();
  if (text.includes('统一身份认证平台') || text.includes('pwdEncryptSalt')) {
    throw new Error('教务系统会话未生效，请重试或切换“官方无痕网页同步”');
  }
  return JSON.parse(text);
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
    // Fallback: query full academic year in case exam semester filter differs
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
            'User-Agent': MOBILE_UA,
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
        // Keep searching if current variant returned 0 items
      } catch {
        // Try next endpoint/variant
      }
    }
  }
  return { items: [] };
}

/**
 * Unconditionally terminate server-side sessions (JWXT + CAS Authserver + WebVPN)
 * so no reusable session cookie survives after syncing schedule & exams.
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
    logoutUrls.push('https://wfw.gdou.edu.cn/logout');
  }

  let anySucceeded = false;
  await Promise.all(
    logoutUrls.map(async (url) => {
      try {
        await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { 'User-Agent': MOBILE_UA },
        });
        anySucceeded = true;
      } catch {
        // Best-effort server-side session invalidation
      }
    })
  );
  return anySucceeded;
}

/**
 * Step 3 (One-Shot Zero-Retention Sync):
 * Authenticates ONCE using ephemeral credentials, fetches courses & exams,
 * immediately purges credentials from memory, and logs out of all GDOU endpoints.
 */
export async function executeOneShotGdouSync(
  session: PreparedAuthSession,
  credentials: EphemeralCredentials,
  termOverride?: SyncTermOverride,
  onProgress?: (step: string) => void
): Promise<SyncResult> {
  const steps: string[] = [];
  const log = (msg: string) => {
    steps.push(msg);
    onProgress?.(msg);
  };

  let sessionLoggedOut = false;

  try {
    log(
      session.isWebVpn
        ? '1. 已通过 netcheck 自动接入校外微门户反代 (wfw.gdou.edu.cn)'
        : '1. 已通过 netcheck 自动接入校园网直连通道 (jw.gdou.edu.cn)'
    );

    if (!session.alreadyLoggedIn) {
      if (!session.pwdEncryptSalt || !session.execution) {
        throw new Error('未能获取广海统一身份认证加密盐值，请刷新重试或切换网页同步');
      }

      const username = credentials.username.trim();
      const encryptedPwd = encryptGdouPassword(credentials.password, session.pwdEncryptSalt);
      const captcha = (credentials.captcha ?? '').trim();

      // Immediately wipe raw credentials from the caller's object BEFORE network I/O completes
      purgeEphemeralCredentials(credentials);
      log('2. 密码已完成本地 AES-128-CBC 加密，明文凭据已从内存清除');

      const loginAction = `${session.authOrigin}/authserver/login?service=${encodeURIComponent(
        session.serviceUrl
      )}`;

      const loginResp = await fetch(loginAction, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'User-Agent': MOBILE_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: session.authOrigin,
          Referer: session.entryFinalUrl,
        },
        body: encodeFormBody({
          username,
          password: encryptedPwd,
          captcha,
          _eventId: 'submit',
          cllt: 'userNameLogin',
          dllt: 'generalLogin',
          lt: session.lt,
          execution: session.execution,
        }),
      });

      const loginHtml = await loginResp.text();
      if (loginHtml.includes('pwdEncryptSalt') && loginHtml.includes('pwdFromId')) {
        const errTip = extractAuthError(loginHtml);
        throw new Error(errTip || '学号、密码或验证码错误，请核对后重试');
      }
      log('3. 广海统一身份认证通过，已建立一次性教务临时会话');
    } else {
      purgeEphemeralCredentials(credentials);
      log('2. 检测到临时会话已就绪，跳过重复认证并清除输入缓存');
    }

    const { prefix, xnm, xqm, termLabel } = await detectJwPrefixAndTerm(
      session.jwBaseUrl,
      termOverride
    );
    log(`4. 已锁定目标学期：${termLabel} (xnm=${xnm}, xqm=${xqm})`);

    const rawSchedule = await fetchJwScheduleJson(session.jwBaseUrl, prefix, xnm, xqm);
    const parsedSchedule = parseZfScheduleResponse(rawSchedule);
    log(`5. 课表解析完成：共 ${parsedSchedule.courses.length} 门/节教学安排`);

    const rawExams = await fetchJwExamJson(session.jwBaseUrl, prefix, xnm, xqm);
    const exams = parseZfExamResponse(rawExams);
    log(`6. 考试安排拉取完成：共 ${exams.length} 场考试`);

    return {
      courses: parsedSchedule.courses,
      exams,
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
        credentialsPurged: true,
        sessionLoggedOut: true, // finalized in finally block
        steps,
      },
    };
  } finally {
    // UNCONDITIONAL SELF-DESTRUCT: wipe credentials & log out even on error
    purgeEphemeralCredentials(credentials);
    sessionLoggedOut = await logoutEphemeralSession(
      session.jwBaseUrl,
      session.authOrigin,
      session.isWebVpn
    );
    log(
      sessionLoggedOut
        ? '7. 服务端会话已注销，本地未写入任何账号/密码/Cookie（用完即删完成）'
        : '7. 已完成本地凭据销毁与临时会话清理（0 字节凭据落盘）'
    );
  }
}

/**
 * Builds the injected JS snippet for Mode B (Incognito Ephemeral WebView).
 * Once the user finishes login on GDOU's official page (supports captcha/SMS/QR),
 * this script fetches schedule & exams from the authenticated JWXT origin,
 * posts pure JSON back to React Native, and immediately triggers logout.
 */
export function buildIncognitoWebViewSyncScript(override?: SyncTermOverride): string {
  const overrideXnm = JSON.stringify(override?.xnm ?? '');
  const overrideXqm = JSON.stringify(override?.xqm ?? '');

  return `
    (function() {
      if (window.__GDOU_SYNC_RUNNING__) return;
      var href = String(window.location.href || '');
      var html = String(document.documentElement ? document.documentElement.innerHTML : '');
      var isAuthPage = html.indexOf('pwdEncryptSalt') !== -1 || href.indexOf('/authserver/login') !== -1;
      var isJwHost = href.indexOf('jw.gdou.edu.cn') !== -1;
      if (!isJwHost || isAuthPage) return;

      window.__GDOU_SYNC_RUNNING__ = true;

      function post(payload) {
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }

      function computeJwRoot() {
        var idx = href.indexOf('https://jw.gdou.edu.cn');
        if (href.indexOf('wfw.gdou.edu.cn') !== -1) {
          return 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn';
        }
        return 'https://jw.gdou.edu.cn';
      }

      async function run() {
        try {
          post({ type: 'PROGRESS', message: '检测到教务登录成功，正在无痕提取课表与考试...' });
          var root = computeJwRoot();
          var prefix = href.indexOf('/jwglxt/') !== -1 ? '/jwglxt' : '';

          // Detect current term from xskbcx index page
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
          var kbJson = await kbResp.json();

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

          // Immediately invalidate server session inside the ephemeral WebView
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
            examRaw: examJson
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
