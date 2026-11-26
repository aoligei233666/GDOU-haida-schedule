import CryptoJS from 'crypto-js';
import appJson from '../app.json';
import pkgLockJson from '../package-lock.json';
import pkgJson from '../package.json';
import {
  buildCampusCourseSearchParams,
  buildEmptyClassroomQueryParams,
  buildZhengfangBitmask,
  ensureAuthLoginServiceParam,
  extractSafeHostname,
  GDOU_AUTH_WFW_BASE,
  GDOU_JW_SSO_SERVICE,
  GDOU_JW_WFW_SSO_SERVICE,
  healWfwWrongSsoUrl,
  isAllowedWebViewNavigationUrl,
  isTrustedWebViewMessageUrl,
  normalizeWfwAuthUrl,
  upgradeGdouHttpToHttps,
} from '../src/constants/gdouEndpoints';
import {
  buildSampleGdouData,
  CAMPUS_PRESETS,
  createDefaultSettings,
  getDefaultTermStartDateForTerm,
} from '../src/constants/gdouTimetable';
import {
  buildClassAlarmDedupeKey,
  buildExamAlarmDedupeKey,
  buildWakeupAlarmDedupeKey,
  mergeAlarmsIdempotently,
} from '../src/services/alarmDedupe';
import {
  areCredentialsPurged,
  encryptGdouPassword,
  generateSecureHex,
  purgeEphemeralCredentials,
} from '../src/services/cryptoAes';
import { getExamCountdown, parseExamDateTime, parseZfExamResponse } from '../src/services/examParser';
import {
  buildIncognitoWebViewPreloadScript,
  buildIncognitoWebViewSyncScript,
  checkGdouCaptcha,
  completeWfwSubAuthAndSync,
  fetchWithTimeout,
  isAccountLockedMessage,
  isNativeMobileRuntime,
  logoutEphemeralSession,
  MfaChallengeState,
  PreparedAuthSession,
  prepareGdouAuthSession,
  probeGdouNetworkRoute,
  submitGdouMfaAndCompleteSync,
} from '../src/services/gdouAuth';
import {
  buildGdouCalendarCountdowns,
  buildTodayLiveSnapshot,
  getCoursesForDate,
  resolveEffectiveScheduleDate,
} from '../src/services/academicCalendar';
import {
  buildLocalEstimatedGraduationAudit,
  parseEmptyClassroomOptionsHtml,
  parseZfCampusCourseSearchResponse,
  parseZfEmptyClassroomsResponse,
  parseZfGraduationAuditResponse,
} from '../src/services/campusToolsParser';
import {
  computeGpaSummary,
  computeScoreDistribution,
  computeTermBreakdowns,
  parseZfGradesResponse,
  parseZfGradeSubScoresResponse,
} from '../src/services/gradeParser';
import { computeScheduleDiff } from '../src/services/scheduleDiff';
import { buildSchedulePosterHtml } from '../src/services/schedulePosterBuilder';
import { buildGdouIcsContent, foldIcsLine } from '../src/services/icsBuilder';
import {
  getCourseOccurrences,
  getFirstClassPerDayInWeek,
  parseLocalDateStrict,
  parseSectionRange,
  parseWeekExpression,
  parseZfPeriodTimesResponse,
  parseZfScheduleResponse,
} from '../src/services/scheduleParser';
import {
  buildCoupleShareJsonFileContent,
  buildSamplePartnerSchedule,
  COUPLE_SHARE_PREFIX,
  decodeCoupleSharePayload,
  encodeCoupleShareCode,
} from '../src/services/coupleShareCodec';
import {
  buildTimetableClusters,
  computeCoupleScheduleInsights,
} from '../src/services/timetableCluster';
import {
  checkForAppUpdate,
  compareSemver,
  CURRENT_VERSION_HIGHLIGHTS,
  getPlatformVersionHighlights,
  GITHUB_RELEASES_PAGE_URL,
  isTrustedGithubReleaseUrl,
  selectPlatformOtaAssets,
  selectPlatformReleaseAsset,
  summarizeReleaseHighlights,
} from '../src/services/updateService';
import {
  containsSensitiveCredentialValue,
  findForbiddenCredentialKeys,
  sanitizeEndpointUrl,
  sanitizeForZeroRetention,
} from '../src/services/zeroRetentionSanitizer';
import { AlarmRule, EphemeralCredentials } from '../src/types/models';

const assert = {
  equal<T>(actual: T, expected: T, msg?: string) {
    if (actual !== expected) {
      throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, msg?: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  ok(cond: unknown, msg?: string) {
    if (!cond) {
      throw new Error(msg || 'Assertion failed');
    }
  },
  throws(fn: () => unknown, pattern: RegExp, msg?: string) {
    let threw = false;
    try {
      fn();
    } catch (err) {
      threw = true;
      const text = err instanceof Error ? err.message : String(err);
      if (!pattern.test(text)) {
        throw new Error(msg || `Expected error matching ${pattern}, got: ${text}`);
      }
    }
    if (!threw) {
      throw new Error(msg || `Expected function to throw matching ${pattern}`);
    }
  },
};

function makeMockResponse(status: number, body: string, url = 'https://authserver.gdou.edu.cn/'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

async function run() {
  const runLive = process.argv.includes('--live');

  console.log('1) Testing CSPRNG AES-128-CBC-PKCS7 password encryption & fail-closed salt guard...');
  const salt = 'ALUprp04LpFDxESE';
  const prefix64 = 'A'.repeat(64);
  const iv16 = 'B'.repeat(16);
  const cipher = encryptGdouPassword('TestPass#2026', salt, { prefix64, iv16 });
  const decrypted = CryptoJS.AES.decrypt(cipher, CryptoJS.enc.Utf8.parse(salt), {
    iv: CryptoJS.enc.Utf8.parse(iv16),
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString(CryptoJS.enc.Utf8);
  assert.equal(decrypted, prefix64 + 'TestPass#2026');
  const randomCipher1 = encryptGdouPassword('TestPass#2026', salt);
  const randomCipher2 = encryptGdouPassword('TestPass#2026', salt);
  assert.ok(randomCipher1 !== randomCipher2, 'CSPRNG encryptions must produce unique IV/prefix');
  assert.throws(() => encryptGdouPassword('TestPass#2026', ''), /pwdEncryptSalt/);
  assert.throws(() => encryptGdouPassword('TestPass#2026', 'short'), /pwdEncryptSalt/);
  console.log('   OK: AES-CBC CSPRNG round-trip & missing-salt fail-closed verified.');

  console.log('2) Testing recursive key + value-level zero-retention sanitizer & credential purge...');
  const creds: EphemeralCredentials = { username: 'TEST_STUDENT_001', password: 'SecretPassword', captcha: '1234' };
  assert.equal(areCredentialsPurged(creds), false);
  purgeEphemeralCredentials(creds);
  assert.equal(areCredentialsPurged(creds), true);
  const dirtyPayload = {
    courses: [{ name: '海洋科学', password: 'leak', nested: { token: 'abc', castgc: 'tgt', ok: 1 } }],
    username: 'TEST_STUDENT_001',
    password: 'SecretPassword',
    cookie: 'JSESSIONID=abc',
    receiptNote: 'Failed url https://authserver.gdou.edu.cn/logout?ticket=ST-99999&JSESSIONID=SECRET123',
    meta: { pwdEncryptSalt: 'salt123456789012', execution: 'e1s1', keep: true },
  };
  assert.ok(containsSensitiveCredentialValue(dirtyPayload.receiptNote));
  assert.ok(findForbiddenCredentialKeys({ leak: 'Cookie: CASTGC=TGT-12345' }).length > 0);
  const sanitized = sanitizeForZeroRetention(dirtyPayload);
  assert.ok(sanitized.receiptNote.includes('[REDACTED]'), 'Sensitive string value must be redacted');
  assert.ok(!sanitized.receiptNote.includes('SECRET123'), 'Raw JSESSIONID value must not survive');
  assert.ok(!sanitized.receiptNote.includes('ST-99999'), 'Raw ST ticket must not survive');
  assert.deepEqual(
    findForbiddenCredentialKeys({
      courses: sanitized.courses,
      meta: sanitized.meta,
    }),
    []
  );
  assert.equal(
    sanitizeEndpointUrl('https://authserver.gdou.edu.cn/authserver/logout?ticket=ST-abc#top'),
    'https://authserver.gdou.edu.cn/authserver/logout'
  );
  assert.equal(sanitized.courses[0].name, '海洋科学');
  assert.equal((sanitized.courses[0].nested as { ok: number }).ok, 1);
  assert.equal((sanitized.meta as { keep: boolean }).keep, true);
  console.log('   OK: Production recursive key + value-level sanitizer & URL redaction verified.');

  console.log('3) Testing gdouAuth timeout, X-Gdou header guard, verified logout & WebView guards...');
  assert.equal(isNativeMobileRuntime(), false, 'Node verification runs outside React Native runtime');
  const originalFetch = globalThis.fetch;
  try {
    // 3a. Timeout enforcement + verify X-Gdou-* headers are stripped outside RN native runtime
    const observedHeaders: Record<string, string>[] = [];
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      observedHeaders.push((init?.headers as Record<string, string>) || {});
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as typeof fetch;

    let timedOutCaught = false;
    let timedOutHostIncluded = false;
    try {
      await fetchWithTimeout(
        'https://authserver.gdou.edu.cn/test',
        {
          headers: {
            'User-Agent': 'test',
            'X-Gdou-Reset-Cookies-Before': '1',
            'X-Gdou-Clear-Cookies-After': '1',
          },
        },
        { timeoutMs: 40 }
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      timedOutCaught = m.includes('请求超时');
      timedOutHostIncluded = m.includes('authserver.gdou.edu.cn');
    }
    assert.ok(timedOutCaught, 'fetchWithTimeout must abort hanging requests');
    assert.ok(timedOutHostIncluded, 'fetchWithTimeout error must include safe target hostname');
    let jwTimeoutGuided = false;
    try {
      await fetchWithTimeout('https://jw.gdou.edu.cn/sso/jziotlogin?ticket=SECRET', {}, { timeoutMs: 30 });
    } catch (err) {
      const m = err instanceof Error ? err.message : '';
      jwTimeoutGuided = m.includes('校外微门户') && !m.includes('SECRET');
    }
    assert.ok(jwTimeoutGuided, 'Bare jw timeout must guide to 校外微门户 without leaking ticket');
    assert.equal(
      Object.keys(observedHeaders[0] || {}).some((k) => k.toLowerCase().startsWith('x-gdou-')),
      false,
      'Internal X-Gdou-* headers must NEVER be sent outside React Native runtime'
    );

    // 3b. Real verified logout (success case vs failure case + query stripping on failedEndpoints)
    globalThis.fetch = (async () => makeMockResponse(200, 'ok')) as typeof fetch;
    const logoutOk = await logoutEphemeralSession(
      'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn',
      'https://authserver.gdou.edu.cn',
      true,
      ''
    );
    assert.equal(logoutOk.casLoggedOut, true);
    assert.equal(logoutOk.attempted, 3);
    assert.equal(logoutOk.succeeded, 3);
    assert.equal(logoutOk.failedEndpoints.length, 0);

    globalThis.fetch = (async () => makeMockResponse(503, 'Service Unavailable')) as typeof fetch;
    const logoutFail = await logoutEphemeralSession(
      'https://jw.gdou.edu.cn?ticket=ST-secret',
      'https://authserver.gdou.edu.cn',
      false,
      ''
    );
    assert.equal(logoutFail.casLoggedOut, false);
    assert.equal(logoutFail.succeeded, 0);
    assert.equal(logoutFail.failedEndpoints.length, 2);
    assert.ok(
      logoutFail.failedEndpoints.every((ep) => !ep.includes('ST-secret')),
      'failedEndpoints must strip query parameters'
    );

    // 3c. Fail-closed captcha check on HTTP 503
    const mockSession: PreparedAuthSession = {
      entryFinalUrl: 'https://authserver.gdou.edu.cn/authserver/login',
      authOrigin: 'https://authserver.gdou.edu.cn',
      jwBaseUrl: 'https://jw.gdou.edu.cn',
      isWebVpn: false,
      serviceUrl: 'https://jw.gdou.edu.cn/sso/jziotlogin',
      pwdEncryptSalt: salt,
      execution: 'e1s1',
      lt: '',
      ephemeralBfp: generateSecureHex(16),
      alreadyLoggedIn: false,
    };
    const captchaErr = await checkGdouCaptcha(mockSession, 'TEST_STUDENT_001');
    assert.equal(captchaErr.checkFailed, true);
    assert.ok(Boolean(captchaErr.errorMessage), 'checkGdouCaptcha must surface HTTP error');

    // 3d. Lockout detector & WebView origin allowlists + HTTP->HTTPS auto-upgrade + bridge token + storage cleanup verification
    assert.equal(isAccountLockedMessage('您的账号已被冻结，请稍后再试'), true);
    assert.equal(isAccountLockedMessage('密码错误'), false);
    assert.equal(isAllowedWebViewNavigationUrl('https://authserver.gdou.edu.cn/authserver/login'), true);
    assert.equal(isAllowedWebViewNavigationUrl('http://authserver.gdou.edu.cn/authserver/login'), false);
    assert.equal(isAllowedWebViewNavigationUrl('https://evil.example.com/phish'), false);
    assert.equal(
      upgradeGdouHttpToHttps(
        'http://authserver.gdou.edu.cn/authserver/reAuthCheck/reAuthLoginView.do?isMultifactor=true'
      ),
      'https://authserver.gdou.edu.cn/authserver/reAuthCheck/reAuthLoginView.do?isMultifactor=true'
    );
    assert.equal(upgradeGdouHttpToHttps('https://authserver.gdou.edu.cn/authserver/login'), null);
    assert.equal(upgradeGdouHttpToHttps('http://evil.example.com/phish'), null);
    assert.equal(upgradeGdouHttpToHttps('http://gdou.edu.cn.evil.com/phish'), null);
    assert.equal(upgradeGdouHttpToHttps('javascript:alert(1)'), null);
    assert.equal(
      normalizeWfwAuthUrl(
        'https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/authserver/reAuthCheck/reAuthLoginView.do?isMultifactor=true'
      ),
      'https://wfw.gdou.edu.cn/authserver/reAuthCheck/reAuthLoginView.do?isMultifactor=true'
    );
    assert.equal(
      normalizeWfwAuthUrl(
        'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/authserver/login?type=dynamicLogin'
      ),
      'https://wfw.gdou.edu.cn/authserver/login?type=dynamicLogin'
    );
    assert.equal(normalizeWfwAuthUrl('https://wfw.gdou.edu.cn/authserver/login'), null);
    assert.equal(
      healWfwWrongSsoUrl(
        'https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/sso/jziotlogin?ticket=ST-98765'
      ),
      'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-98765'
    );
    assert.equal(
      healWfwWrongSsoUrl('https://wfw.gdou.edu.cn/sso/jziotlogin?ticket=ST-111'),
      'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-111'
    );
    assert.equal(
      healWfwWrongSsoUrl(
        'https://wfw.gdou.edu.cn/authserver/login?service=https%3A%2F%2Fjw.gdou.edu.cn%2Fsso%2Fjziotlogin'
      ),
      null,
      'Must NEVER mangle campus service=https://jw.gdou.edu.cn/sso/jziotlogin (causes CAS INVALID_SERVICE)'
    );
    assert.equal(
      healWfwWrongSsoUrl('https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-222', true),
      'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-222',
      'Off-campus bare jw.gdou.edu.cn callback must be wrapped inside wfw'
    );
    assert.equal(
      healWfwWrongSsoUrl('https://jw.gdou.edu.cn:443/sso/jziotlogin?ticket=ST-333', true),
      'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-333',
      'Off-campus bare jw.gdou.edu.cn:443 callback must strip default port and wrap inside wfw'
    );
    assert.equal(
      healWfwWrongSsoUrl('https://jw.gdou.edu.cn?ticket=ST-444', true),
      'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/?ticket=ST-444',
      'Off-campus bare jw.gdou.edu.cn?query callback must normalize leading slash inside wfw'
    );
    assert.equal(
      healWfwWrongSsoUrl('https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-222', false),
      null,
      'Campus direct mode must leave jw.gdou.edu.cn untouched'
    );
    assert.equal(
      extractSafeHostname('https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/sso/jziotlogin?ticket=ST-SECRET'),
      'wfw.gdou.edu.cn'
    );
    assert.equal(extractSafeHostname('not-a-valid-url'), '');
    assert.equal(
      ensureAuthLoginServiceParam(
        'https://authserver.gdou.edu.cn/authserver/login',
        'https://wfw.gdou.edu.cn/'
      ),
      'https://authserver.gdou.edu.cn/authserver/login?service=https%3A%2F%2Fwfw.gdou.edu.cn%2F'
    );
    assert.equal(
      ensureAuthLoginServiceParam(
        'https://authserver.gdou.edu.cn/authserver/login?service=https%3A%2F%2Fjw.gdou.edu.cn%2Fsso%2Fjziotlogin',
        'https://wfw.gdou.edu.cn/'
      ),
      'https://authserver.gdou.edu.cn/authserver/login?service=https%3A%2F%2Fjw.gdou.edu.cn%2Fsso%2Fjziotlogin'
    );
    assert.equal(isTrustedWebViewMessageUrl('https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn'), true);
    assert.equal(isTrustedWebViewMessageUrl('https://evil.example.com'), false);
    const preloadScript = buildIncognitoWebViewPreloadScript();
    assert.ok(preloadScript.includes('upgrade-insecure-requests'), 'Preload script must inject HTTPS upgrade CSP');
    assert.ok(preloadScript.includes('XMLHttpRequest.prototype.open'), 'Preload script must hook XHR for wfw /authserver/ cookies');
    assert.ok(preloadScript.includes('window.__GDOU_RAW_FETCH__'), 'Preload script must expose unpatched raw fetch for urlss priming');
    // Syntax-validate both injected WebView scripts so malformed escapes fail fast
    new Function(preloadScript);
    const token = generateSecureHex(16);
    const injected = buildIncognitoWebViewSyncScript(undefined, token, 'https://wfw.gdou.edu.cn/');
    new Function(injected);
    assert.ok(injected.includes(token), 'WebView script must embed bridgeToken');
    assert.ok(injected.includes('upgrade-insecure-requests'), 'WebView script must inject HTTPS upgrade CSP');
    assert.ok(injected.includes('__gdou_wfw_step2_banner__'), 'WebView script must render Step 2 guidance banner on wfw auth');
    assert.ok(injected.includes('__gdou_404_healed__'), 'WebView script must auto-heal stale urlss 404');
    assert.ok(injected.includes(GDOU_AUTH_WFW_BASE), 'WebView script must embed GDOU_AUTH_WFW_BASE for urlss priming & logout');
    assert.ok(injected.includes('/authserver/index.do'), 'WebView script must auto-recover from CAS index.do');
    assert.ok(injected.includes('xskbcx_cxRjc.html'), 'WebView script must query official section period times');
    assert.ok(injected.includes('sessionStorage.clear()'), 'WebView script must clear sessionStorage');
    assert.ok(injected.includes('storageCleaned: storageCleaned'), 'WebView script must report verified storageCleaned');
    assert.ok(injected.includes('Promise.race'), 'WebView timedFetch must have Promise.race timeout fallback');
    assert.ok(injected.includes("xnm: '', xqm: ''"), 'WebView script must include 3rd exam query variant');
    assert.ok(
      injected.includes(GDOU_JW_SSO_SERVICE),
      'WebView script must embed campus GDOU_JW_SSO_SERVICE so jw serviceValidate succeeds'
    );

    // 3e-0. Phase-2 MFA on GDOU_AUTH_WFW_BASE -> campus GDOU_JW_SSO_SERVICE ticket -> JWXT sync!
    const phase2Urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      phase2Urls.push(url);
      if (url.includes('reAuthSubmit.do')) {
        return makeMockResponse(200, JSON.stringify({ code: 'reAuth_success', msg: '认证成功' }), url);
      }
      if (
        url.startsWith(`${GDOU_AUTH_WFW_BASE}/authserver/login`) &&
        url.includes(encodeURIComponent(GDOU_JW_SSO_SERVICE))
      ) {
        return makeMockResponse(
          200,
          '<html><body>教学管理信息服务平台 index_initMenu</body></html>',
          'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/xtgl/index_initMenu.html'
        );
      }
      if (url.includes('xskbcx_cxXskbcxIndex.html')) {
        return makeMockResponse(
          200,
          '<select id="xnm"><option value="2026" selected>2026</option></select><select id="xqm"><option value="3" selected>1</option></select>',
          url
        );
      }
      if (url.includes('xskbcx_cxXsgrkb.html')) {
        return makeMockResponse(
          200,
          JSON.stringify({
            kbList: [{ kcmc: '二阶段多因子直通测试课', xqj: '1', jcs: '1-2', zcd: '1-16周', xqh_id: '1', xqmc: '湖光校区' }],
          }),
          url
        );
      }
      if (url.includes('xskbcx_cxRjc.html')) {
        return makeMockResponse(200, JSON.stringify([]), url);
      }
      if (url.includes('kscx_cxXsksxx') || url.includes('cjcx_cx')) {
        return makeMockResponse(200, JSON.stringify({ items: [] }), url);
      }
      return makeMockResponse(200, 'ok', url);
    }) as typeof fetch;

    const phase2WfwMfa: MfaChallengeState = {
      required: true,
      reAuthUserId: 'TEST_STUDENT_001',
      serviceUrl: GDOU_JW_SSO_SERVICE,
      defaultReAuthType: '3',
      credentialsPurged: true,
      session: {
        ...mockSession,
        authOrigin: GDOU_AUTH_WFW_BASE,
        jwBaseUrl: 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn',
        isWebVpn: true,
        serviceUrl: GDOU_JW_SSO_SERVICE,
      },
      previousSteps: ['1. init', '2. enc', '3. mfa', '5c. wfw-mfa'],
    };
    const phase2Res = await submitGdouMfaAndCompleteSync(phase2WfwMfa, '654321', '3');
    assert.equal(phase2Res.status, 'completed', 'Phase-2 wfw MFA must complete directly without 901');
    if (phase2Res.status === 'completed') {
      assert.equal(phase2Res.result.courses[0]?.name, '二阶段多因子直通测试课');
    }
    assert.ok(
      phase2Urls.some((u) => u.startsWith(`${GDOU_AUTH_WFW_BASE}/authserver/logout`)) &&
        phase2Urls.some((u) => u.startsWith('https://authserver.gdou.edu.cn/authserver/logout')),
      'Phase-2 completion must log out BOTH proxied wfw authserver and outer authserver'
    );

    // 3e. Off-campus wfw Phase-1 MFA -> Step 2 sub-session auth keeps WFWSESSID alive with ZERO retained password
    let logoutCalledDuringMfaHandoff = false;
    let observedSubAuthPostUrl = '';
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/logout')) {
        logoutCalledDuringMfaHandoff = true;
        return makeMockResponse(200, 'ok', url);
      }
      if (url.includes('reAuthSubmit.do')) {
        return makeMockResponse(200, JSON.stringify({ code: 'reAuth_success', msg: '认证成功' }), url);
      }
      if (url === 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn') {
        return makeMockResponse(
          200,
          '<input id="pwdEncryptSalt" value="WFW2Salt12345678"/><input name="execution" value="e2s1"/>',
          url
        );
      }
      if (url.startsWith(`${GDOU_AUTH_WFW_BASE}/authserver/login`) && (!init?.method || init.method === 'GET')) {
        return makeMockResponse(
          200,
          '<input id="pwdEncryptSalt" value="WFW2FreshSalt789"/><input name="execution" value="e2s2"/>',
          url
        );
      }
      if (url.startsWith(`${GDOU_AUTH_WFW_BASE}/authserver/login`) && init?.method === 'POST') {
        observedSubAuthPostUrl = url;
        return makeMockResponse(
          200,
          '<html><body>教学管理信息服务平台 index_initMenu</body></html>',
          'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn/xtgl/index_initMenu.html'
        );
      }
      if (url.includes('checkNeedCaptcha.htl')) {
        return makeMockResponse(200, JSON.stringify({ isNeed: false }), url);
      }
      if (url.includes('xskbcx_cxXskbcxIndex.html')) {
        return makeMockResponse(
          200,
          '<select id="xnm"><option value="2026" selected>2026</option></select><select id="xqm"><option value="3" selected>1</option></select>',
          url
        );
      }
      if (url.includes('xskbcx_cxXsgrkb.html')) {
        return makeMockResponse(
          200,
          JSON.stringify({
            kbList: [{ kcmc: '测试课', xqj: '1', jcs: '1-2', zcd: '1-16周', xqh_id: '1', xqmc: '湖光校区' }],
          }),
          url
        );
      }
      if (url.includes('xskbcx_cxRjc.html')) {
        return makeMockResponse(
          200,
          JSON.stringify([
            { jcdm: '1', qssj: '08:10', jssj: '08:55' },
            { jcdm: '2', qssj: '09:00', jssj: '09:45' },
            { jcdm: '3', qssj: '10:15', jssj: '11:00' },
            { jcdm: '4', qssj: '11:05', jssj: '11:50' },
            { jcdm: '5', qssj: '14:30', jssj: '15:15' },
            { jcdm: '6', qssj: '15:20', jssj: '16:05' },
            { jcdm: '7', qssj: '16:30', jssj: '17:15' },
            { jcdm: '8', qssj: '17:20', jssj: '18:05' },
          ]),
          url
        );
      }
      if (url.includes('kscx_cxXsksxx') || url.includes('cjcx_cx')) {
        return makeMockResponse(200, JSON.stringify({ items: [] }), url);
      }
      return makeMockResponse(200, 'ok', url);
    }) as typeof fetch;

    const mockWfwMfa: MfaChallengeState = {
      required: true,
      reAuthUserId: 'TEST_STUDENT_001',
      serviceUrl: 'https://wfw.gdou.edu.cn/',
      defaultReAuthType: '3',
      credentialsPurged: areCredentialsPurged(creds),
      session: {
        ...mockSession,
        jwBaseUrl: 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn',
        isWebVpn: true,
        serviceUrl: 'https://wfw.gdou.edu.cn/',
      },
      previousSteps: ['1. init', '2. enc', '3. mfa'],
    };
    const mfaOutcome = await submitGdouMfaAndCompleteSync(mockWfwMfa, '123456', '3');
    assert.equal(mfaOutcome.status, 'wfw_subauth_required');
    assert.equal(logoutCalledDuringMfaHandoff, false, 'Must NOT log out WFWSESSID while awaiting Step 2');
    if (mfaOutcome.status === 'wfw_subauth_required') {
      assert.equal(mfaOutcome.subAuth.salt2, 'WFW2FreshSalt789', 'Must use fresh synchronized salt2 from GDOU_AUTH_WFW_BASE');
      assert.equal('password' in mfaOutcome.subAuth, false, 'WfwSubAuthState must never carry password');
      const step2Creds: EphemeralCredentials = { username: 'TEST_STUDENT_001', password: 'TempPassword123' };
      const finalOutcome = await completeWfwSubAuthAndSync(mfaOutcome.subAuth, step2Creds);
      assert.equal(areCredentialsPurged(step2Creds), true, 'Step 2 credentials must be purged');
      assert.equal(
        observedSubAuthPostUrl,
        `${GDOU_AUTH_WFW_BASE}/authserver/login?service=${encodeURIComponent(GDOU_JW_SSO_SERVICE)}`,
        'Step 2 POST must target explicit GDOU_AUTH_WFW_BASE with campus GDOU_JW_SSO_SERVICE'
      );
      assert.equal(finalOutcome.status, 'completed');
      if (finalOutcome.status === 'completed') {
        assert.equal(finalOutcome.result.courses.length, 1);
        assert.equal(finalOutcome.result.syncedPeriods?.length, 8);
        assert.equal(finalOutcome.result.syncedPeriods?.[1].start, '09:00');
        assert.equal(finalOutcome.result.receipt.sessionLoggedOut, true);
      }
      assert.equal(logoutCalledDuringMfaHandoff, true, 'Must log out after Step 2 completes');
    }

    // 3f. Fast 1-hop netcheck route probe + unreachable jw.gdou.edu.cn auto-fallback to wfw + explicit routePref
    const probeHits: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      probeHits.push(url);
      if (url.includes('netcheck.gdou.edu.cn')) {
        return {
          ok: false,
          status: 302,
          url,
          headers: new Headers({ location: 'https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn' }),
          text: async () => '',
        } as unknown as Response;
      }
      throw new Error('Unexpected fetch during fast wfw netcheck: ' + url);
    }) as typeof fetch;
    const fastWfwProbe = await probeGdouNetworkRoute({ timeoutMs: 2000 });
    assert.equal(fastWfwProbe.isWebVpn, true, '302 to wfw must immediately resolve isWebVpn=true');
    assert.equal(probeHits.length, 1, 'Fast 1-hop wfw netcheck must not follow extra redirects');

    // Misclassified carrier IP: netcheck says campus jw, but direct jw TCP fails -> must auto-fallback to wfw!
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('netcheck.gdou.edu.cn')) {
        return {
          ok: false,
          status: 302,
          url,
          headers: new Headers({ location: 'https://jw.gdou.edu.cn/sso/jziotlogin' }),
          text: async () => '',
        } as unknown as Response;
      }
      if (url.includes('jw.gdou.edu.cn')) {
        throw new Error('TCP SYN timeout');
      }
      return makeMockResponse(200, 'ok', url);
    }) as typeof fetch;
    const misclassifiedProbe = await probeGdouNetworkRoute({ timeoutMs: 2000 });
    assert.equal(
      misclassifiedProbe.isWebVpn,
      true,
      'Unreachable bare jw.gdou.edu.cn must override netcheck and fall back to wfw'
    );

    // Explicit routePref='wfw' skips netcheck completely
    let netcheckTouched = false;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('netcheck.gdou.edu.cn')) {
        netcheckTouched = true;
        throw new Error('netcheck should be skipped when routePref=wfw');
      }
      if (url.startsWith('https://authserver.gdou.edu.cn/authserver/login')) {
        return makeMockResponse(
          200,
          '<input id="pwdEncryptSalt" value="DirectWfwSalt123"/><input name="execution" value="e9s1"/>',
          url
        );
      }
      return makeMockResponse(200, 'ok', url);
    }) as typeof fetch;
    const forcedWfwSession = await prepareGdouAuthSession({ routePref: 'wfw' });
    assert.equal(netcheckTouched, false, 'Explicit routePref=wfw must skip netcheck');
    assert.equal(forcedWfwSession.isWebVpn, true);
    assert.equal(forcedWfwSession.pwdEncryptSalt, 'DirectWfwSalt123');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('   OK: Timeout, X-Gdou guard, verified logout, fail-closed captcha & WebView guards verified.');

  console.log('4) Testing 正方 week/section/schedule/period-time parser & GDOU bell schedule...');
  assert.deepEqual(parseWeekExpression('1-4周(单),6-8周(双),11周'), [1, 3, 6, 8, 11]);
  assert.deepEqual(parseSectionRange('3-4节'), { startSection: 3, endSection: 4 });
  assert.deepEqual(parseSectionRange('1,2,3节'), { startSection: 1, endSection: 3 });
  assert.deepEqual(parseSectionRange(undefined, undefined, undefined, '3'), { startSection: 1, endSection: 2 });
  assert.equal(parseSectionRange('未知节次'), null);
  assert.equal(parseLocalDateStrict('2026-02-31'), null);
  assert.ok(parseLocalDateStrict('2026-09-07') !== null);
  assert.equal(getDefaultTermStartDateForTerm('2026', '3'), '2026-08-31');
  assert.equal(getDefaultTermStartDateForTerm('2025', '3'), '2025-09-01');
  assert.equal(getDefaultTermStartDateForTerm('2025', '12'), '2026-03-02');
  assert.equal(CAMPUS_PRESETS.huguang_0810.periods[1].start, '09:00');
  assert.equal(CAMPUS_PRESETS.huguang_0810.periods[1].end, '09:45');
  assert.equal(CAMPUS_PRESETS.huguang_0810.periods[2].start, '10:15');
  assert.equal(CAMPUS_PRESETS.huguang_0810.periods[5].start, '15:20');
  assert.equal(CAMPUS_PRESETS.huguang_0810.periods[6].start, '16:30');
  const parsedRjc = parseZfPeriodTimesResponse({
    items: [
      { jcdm: '01', qssj: '8:10:00', jssj: '8:55:00' },
      { jcdm: '02', sj: '09:00-09:45' },
    ],
  });
  assert.deepEqual(parsedRjc, [
    { section: 1, start: '08:10', end: '08:55' },
    { section: 2, start: '09:00', end: '09:45' },
  ]);

  const parsedKb = parseZfScheduleResponse({
    xsxx: { XH: 'TEST_STUDENT_001', XM: '测试同学', XNMC: '2026-2027', XQMMC: '1' },
    kbList: [
      {
        kcmc: '海洋气象学',
        kch: 'HY301',
        xm: '张教授',
        cdmc: '钟海楼02018',
        xqmc: '湖光校区',
        xqj: '2',
        jc: '1-2节',
        zcd: '1-16周(单)',
        xf: '3.0',
      },
      {
        kcmc: '海洋流体力学',
        kch: 'HY302',
        xm: '李教授',
        cdmc: '主教学楼305',
        xqmc: '湖光校区',
        xqj: '2',
        jc: '5-6节',
        zcd: '1-16周',
      },
      {
        kcmc: '未排课实践课',
        kch: 'HY399',
        xm: '王教授',
        cdmc: '待定',
        xqj: '',
        jc: '',
        zcd: '',
      },
    ],
  });
  assert.equal(parsedKb.courses.length, 3);
  assert.equal(parsedKb.warnings.length, 1);
  assert.equal(parsedKb.termLabel, '2026-2027学年 第1学期');
  const unparsed = parsedKb.courses.find((c) => c.name === '未排课实践课');
  assert.ok(Boolean(unparsed?.parseWarning), 'Malformed course must carry parseWarning');
  assert.deepEqual(unparsed?.weeks, []);
  const settings = createDefaultSettings(new Date('2026-09-10T08:00:00'));
  assert.equal(getCourseOccurrences(unparsed!, settings.termStartDate, settings.customPeriods).length, 0);
  const validCourse = parsedKb.courses.find((c) => c.name === '海洋气象学')!;
  const occs = getCourseOccurrences(validCourse, settings.termStartDate, settings.customPeriods);
  assert.equal(occs.length, 8);
  assert.equal(occs[0].start.getHours(), 8);
  assert.equal(occs[0].start.getMinutes(), 10);
  const firstPerDay = getFirstClassPerDayInWeek(parsedKb.courses, 1);
  assert.equal(firstPerDay.get(2)?.name, '海洋气象学');
  console.log('   OK: Schedule parser, unparsed warnings & occurrence generator verified.');

  console.log('5) Testing 正方 exam & multi-term GPA/Credit overview breakdown...');
  const parsedGrades = parseZfGradesResponse({
    items: [
      { kcmc: '高等数学（上）', kch: 'SX110201', xf: '5.0', cj: '90', jd: '4.0', kcxzmc: '公共必修课', xnmmc: '2025-2026', xqmmc: '1' },
      { kcmc: '海洋科学导论', kch: 'HY100101', xf: '3.0', cj: '优秀', kcxzmc: '专业必修课', xnmmc: '2025-2026', xqmmc: '1' },
      { kcmc: '概率论与数理统计', kch: 'SX200501', xf: '3.0', cj: '82', jd: '3.2', kcxzmc: '公共必修课', xnmmc: '2025-2026', xqmmc: '2' },
      { kcmc: '海洋物理实验', kch: 'HY200901', xf: '1.0', cj: '55', jd: '0', kcxzmc: '专业选修课', xnmmc: '2025-2026', xqmmc: '2' },
    ],
  });
  const mathGrade = parsedGrades.find((g) => g.courseCode === 'SX110201')!;
  const oceanGrade = parsedGrades.find((g) => g.courseCode === 'HY100101')!;
  assert.equal(mathGrade.gpaEstimated, false);
  assert.equal(oceanGrade.gpaEstimated, true);
  const gpaSummary = computeGpaSummary(parsedGrades);
  assert.equal(gpaSummary.totalCreditsEarned, 11);
  assert.equal(gpaSummary.totalCreditsAttempted, 12);
  assert.equal(gpaSummary.failedCourses, 1);
  assert.equal(gpaSummary.passRate, 75);
  assert.equal(gpaSummary.hasEstimatedItems, true);
  assert.equal(gpaSummary.byTerm.length, 2);
  assert.equal(gpaSummary.byTerm[0].termKey, '2025-2026 第2学期');
  assert.equal(gpaSummary.byTerm[0].failedCount, 1);
  assert.equal(gpaSummary.byTerm[1].termKey, '2025-2026 第1学期');
  assert.equal(gpaSummary.byTerm[1].weightedGpa, 4.19);
  const termDirect = computeTermBreakdowns(parsedGrades);
  assert.equal(termDirect.length, 2);
  const dist = computeScoreDistribution(parsedGrades);
  assert.equal(dist.find((b) => b.key === 'excellent')?.count, 2);
  assert.equal(dist.find((b) => b.key === 'good')?.count, 1);
  assert.equal(dist.find((b) => b.key === 'fail')?.count, 1);

  const parsedDt = parseExamDateTime('2026-12-28(09:00-11:00)');
  assert.equal(parsedDt.dateText, '2026-12-28');
  assert.equal(parsedDt.startTimeText, '09:00');
  assert.equal(parsedDt.endTimeText, '11:00');
  const parsedExams = parseZfExamResponse({
    items: [
      {
        kcmc: '高等数学（上）',
        kch: 'SX110201',
        kssj: '',
        ksrq: '2026-12-28',
        qzsj: '09:00-11:00',
        cdmc: '钟海楼02018',
        zwh: '24',
        ksxzmc: '期末考试',
        cdxqmc: '湖光校区',
      },
    ],
  });
  assert.equal(parsedExams.length, 1);
  assert.equal(parsedExams[0].rawTimeText, '2026-12-28 09:00-11:00');
  assert.equal(parsedExams[0].startIso, '2026-12-28T09:00:00');
  const cd = getExamCountdown(parsedExams[0], new Date('2026-12-20T10:00:00'));
  assert.equal(cd.daysLeft, 8);
  assert.equal(cd.label, '还有 8 天');
  console.log('   OK: Exam parser, per-term GPA overview & score distribution verified.');

  console.log('6) Testing idempotent alarm deduplication engine...');
  const alarmA: AlarmRule = {
    id: 'a1',
    dedupeKey: buildWakeupAlarmDedupeKey(5, 1),
    kind: 'morning_wakeup',
    title: '周一早起',
    body: '旧闹钟',
    targetId: 'course-1',
    triggerIso: '2026-10-05T07:25:00.000Z',
    weekday: 1,
    hour: 7,
    minute: 25,
    advanceMinutes: 45,
    enabled: true,
    notificationId: 'notif-old-1',
  };
  const alarmB: AlarmRule = {
    ...alarmA,
    id: 'a2',
    body: '新闹钟',
    notificationId: 'notif-new-2',
  };
  const examAlarm: AlarmRule = {
    id: 'e1',
    dedupeKey: buildExamAlarmDedupeKey('exam-1', 'pre'),
    kind: 'exam',
    title: '考试提醒',
    body: '高数',
    targetId: 'exam-1',
    triggerIso: '2026-12-28T07:30:00.000Z',
    weekday: 1,
    hour: 7,
    minute: 30,
    advanceMinutes: 90,
    enabled: true,
    notificationId: 'notif-exam-1',
  };
  assert.equal(buildClassAlarmDedupeKey('c1', 3), 'class:c1:w3');
  const mergedRes = mergeAlarmsIdempotently([alarmA, examAlarm], [alarmB]);
  assert.equal(mergedRes.merged.length, 2, 'Duplicate alarm key must replace existing alarm');
  assert.equal(mergedRes.replaced.length, 1);
  assert.equal(mergedRes.replaced[0].notificationId, 'notif-old-1');
  assert.equal(mergedRes.merged[0].notificationId, 'notif-new-2');
  console.log('   OK: Alarm dedupe keys & idempotent replacement verified.');

  console.log('7) Testing RFC 5545 .ics calendar exporter (75-octet folding, UTC DTSTAMP, stable UIDs)...');
  const sample = buildSampleGdouData(new Date('2026-11-22T10:00:00'));
  sample.courses[0].teacher = '张三丰教授\r第二行备注';
  sample.courses[0].weekText = '1-4周,6-12周(双),15周';
  const fixedNow = new Date('2026-11-23T02:00:00Z');
  const ics1 = buildGdouIcsContent(sample.courses, sample.exams, settings, sample.termLabel, fixedNow);
  const ics2 = buildGdouIcsContent(sample.courses, sample.exams, settings, sample.termLabel, fixedNow);
  assert.equal(ics1, ics2, 'Deterministic ICS UIDs must be stable across repeated exports');
  assert.ok(ics1.startsWith('BEGIN:VCALENDAR'));
  assert.ok(ics1.endsWith('END:VCALENDAR'));
  assert.ok(ics1.includes('DTSTAMP:20261123T020000Z'), 'DTSTAMP must be UTC ending with Z');
  assert.ok(!ics1.includes('\uFFFD'), 'Folded UTF-8 must not contain broken characters');
  const encoder = new TextEncoder();
  const physicalLines = ics1.split('\r\n');
  for (const line of physicalLines) {
    assert.ok(!line.includes('\r'), 'No bare CR allowed inside folded ICS lines');
    const octets = encoder.encode(line).length;
    assert.ok(octets <= 75, `RFC 5545 violation: line length ${octets} > 75 bytes -> ${line}`);
  }
  const unfolded = ics1.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:海洋科学导论'));
  assert.ok(unfolded.includes('SUMMARY:【期末考试】高等数学（上）'));
  assert.ok(unfolded.includes('张三丰教授\\n第二行备注'));
  const longFolded = foldIcsLine('DESCRIPTION:教师: 张三丰教授 | 第3-4节 | 第11周 (1-4周,6-12周(双),15周)');
  assert.ok(longFolded.includes('\r\n '), '86-octet description must be folded');
  console.log('   OK: RFC 5545 ICS (all', physicalLines.length, 'lines <= 75 octets) verified.');

  console.log('8) Testing Expo SDK 58 expo-calendar/legacy guard, GitHub Releases updater & version consistency...');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as { readFileSync: (p: string, enc: string) => string };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as { join: (...parts: string[]) => string };
  const calSvcSource = nodeFs.readFileSync(
    nodePath.join(process.cwd(), 'src', 'services', 'calendarService.ts'),
    'utf8'
  );
  assert.ok(
    calSvcSource.includes("from 'expo-calendar/legacy'"),
    'calendarService.ts must import from expo-calendar/legacy (bare expo-calendar throws in SDK 58)'
  );
  assert.ok(
    !calSvcSource.includes("from 'expo-calendar';"),
    'calendarService.ts must NOT import deprecated *Async stubs from bare expo-calendar'
  );

  // GitHub Releases update checker (offline mocked)
  assert.equal(compareSemver('1.3.1', '1.3.0'), 1);
  assert.equal(compareSemver('v1.10.0', '1.2.9'), 1);
  assert.equal(compareSemver('1.3.1', 'v1.3.1'), 0);
  assert.equal(compareSemver('1.4.0-beta.1', '1.4.0'), -1);
  assert.equal(isTrustedGithubReleaseUrl(GITHUB_RELEASES_PAGE_URL), true);
  assert.equal(isTrustedGithubReleaseUrl('https://evil.example.com/app.apk'), false);
  const pickedApk = selectPlatformReleaseAsset(
    [
      { name: 'haida-schedule-v1.4.0-android-unsigned.apk', browser_download_url: 'https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v1.4.0/haida-schedule-v1.4.0-android-unsigned.apk', size: 25000000 },
      { name: 'haida-schedule-v1.4.0-android.apk', browser_download_url: 'https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v1.4.0/haida-schedule-v1.4.0-android.apk', size: 26000000 },
      { name: 'haida-schedule-v1.4.0-ios.ipa', browser_download_url: 'https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v1.4.0/haida-schedule-v1.4.0-ios.ipa', size: 20000000 },
    ],
    'android'
  );
  assert.equal(pickedApk?.name, 'haida-schedule-v1.4.0-android.apk', 'Android updater must prefer signed APK');

  const origFetchForUpdate = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      makeMockResponse(
        200,
        JSON.stringify({
          tag_name: 'v1.4.0',
          name: '海大课表 v1.4.0',
          body: '修复若干问题',
          html_url: 'https://github.com/aoligei233666/GDOU-haida-schedule/releases/tag/v1.4.0',
          published_at: '2026-11-24T00:00:00Z',
          assets: [
            {
              name: 'haida-schedule-v1.4.0-android.apk',
              browser_download_url:
                'https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v1.4.0/haida-schedule-v1.4.0-android.apk',
              size: 26214400,
            },
          ],
        })
      )) as typeof fetch;
    const upd = await checkForAppUpdate('1.3.1', 'android');
    assert.equal(upd.hasUpdate, true);
    assert.equal(upd.latestVersion, '1.4.0');
    assert.equal(upd.assetName, 'haida-schedule-v1.4.0-android.apk');
  } finally {
    globalThis.fetch = origFetchForUpdate;
  }

  assert.equal(pkgJson.version, appJson.expo.version, 'package.json and app.json versions must match');
  assert.equal(pkgLockJson.version, appJson.expo.version, 'package-lock.json root version must match app.json');
  assert.equal(
    (pkgLockJson.packages as Record<string, { version?: string }>)['']?.version,
    appJson.expo.version,
    'package-lock.json packages[""].version must match app.json'
  );
  assert.ok(
    (appJson.expo.plugins as unknown[]).includes('./plugins/withGdouZeroRetention'),
    'app.json must register ./plugins/withGdouZeroRetention'
  );
  // Verify AltStore / Feather / ESign iOS software source JSON matches app.json
  const iosSourceRaw = nodeFs.readFileSync(
    nodePath.join(process.cwd(), 'altstore-source.json'),
    'utf8'
  );
  const iosSource = JSON.parse(iosSourceRaw) as {
    apps: Array<{
      bundleIdentifier: string;
      version: string;
      buildVersion: string;
      downloadURL: string;
      versions: Array<{ version: string; buildVersion: string; downloadURL: string; size: number }>;
    }>;
  };
  assert.ok(Array.isArray(iosSource.apps) && iosSource.apps.length >= 1, 'altstore-source.json must list app');
  const iosAppEntry = iosSource.apps[0];
  assert.equal(iosAppEntry.bundleIdentifier, appJson.expo.ios.bundleIdentifier);
  assert.equal(iosAppEntry.version, appJson.expo.version);
  assert.equal(iosAppEntry.buildVersion, appJson.expo.ios.buildNumber);
  assert.equal(iosAppEntry.versions[0]?.version, appJson.expo.version);
  assert.equal(iosAppEntry.versions[0]?.buildVersion, appJson.expo.ios.buildNumber);
  assert.equal(isTrustedGithubReleaseUrl(iosAppEntry.downloadURL), true);
  assert.equal(isTrustedGithubReleaseUrl(iosAppEntry.versions[0]?.downloadURL), true);
  assert.ok((iosAppEntry.versions[0]?.size ?? 0) > 1000000, 'altstore-source.json size must be realistic');

  // Verify dynamic app.config.js switches cleanly between sideload and TestFlight/AppStore compliance modes
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dynamicConfigFn = require('../app.config.js') as () => {
    expo: {
      ios: {
        bundleIdentifier: string;
        infoPlist: Record<string, unknown>;
      };
    };
  };
  const prevDist = process.env.EXPO_PUBLIC_APP_DISTRIBUTION;
  try {
    process.env.EXPO_PUBLIC_APP_DISTRIBUTION = 'sideload';
    const sideloadCfg = dynamicConfigFn();
    assert.equal(sideloadCfg.expo.ios.bundleIdentifier, 'cn.edu.gdou.schedule');
    assert.equal(sideloadCfg.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
    assert.equal(sideloadCfg.expo.ios.infoPlist.NSUserTrackingUsageDescription, undefined);
    assert.ok(Array.isArray(sideloadCfg.expo.ios.infoPlist.LSApplicationQueriesSchemes));

    process.env.EXPO_PUBLIC_APP_DISTRIBUTION = 'testflight';
    const tfCfg = dynamicConfigFn();
    assert.equal(tfCfg.expo.ios.bundleIdentifier, 'com.aoligei233666.haidaschedule');
    assert.equal(tfCfg.expo.ios.infoPlist.LSApplicationQueriesSchemes, undefined);
    assert.equal(tfCfg.expo.ios.infoPlist.NSUserTrackingUsageDescription, undefined);
    assert.equal(tfCfg.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
  } finally {
    if (prevDist === undefined) {
      delete process.env.EXPO_PUBLIC_APP_DISTRIBUTION;
    } else {
      process.env.EXPO_PUBLIC_APP_DISTRIBUTION = prevDist;
    }
  }
  const privacyHtml = nodeFs.readFileSync(
    nodePath.join(process.cwd(), 'docs', 'privacy.html'),
    'utf8'
  );
  assert.ok(privacyHtml.includes('Data Not Collected'), 'docs/privacy.html must exist for TestFlight review');

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pluginFn = require('../plugins/withGdouZeroRetention.js') as unknown;
  assert.equal(typeof pluginFn, 'function', 'Config plugin must export a function');
  const pluginSrc = nodeFs.readFileSync(
    nodePath.join(process.cwd(), 'plugins', 'withGdouZeroRetention.js'),
    'utf8'
  );
  assert.ok(
    pluginSrc.includes('ExpoFetchCustomExtension.setCustomURLSessionConfigurationProvider'),
    'iOS plugin must hook Expo SDK 58 ExpoFetchCustomExtension so global fetch uses GdouEphemeralURLProtocol'
  );
  assert.ok(
    pluginSrc.includes('readBodyStream') && pluginSrc.includes('if didRedirect {'),
    'iOS GdouEphemeralURLProtocol must materialize httpBodyStream and guard didRedirect callbacks'
  );
  assert.ok(
    pluginSrc.includes('wfw.gdou.edu.cn'),
    'Native cookie stores must pin route cookie on wfw.gdou.edu.cn as well as authserver'
  );
  assert.ok(
    pluginSrc.includes('GdouOtaBundle') && pluginSrc.includes('resolveBundleURL'),
    'Native plugin must include GdouOtaBundle for iOS & Android in-app GitHub hot-updates'
  );
  assert.ok(
    pluginSrc.includes('gdouConnectionPool') &&
      pluginSrc.includes('retryOnConnectionFailure(true)') &&
      pluginSrc.includes('hasWfwSession') &&
      pluginSrc.includes('X-Gdou-Direct-Probe'),
    'Native plugin must configure short-TTL OkHttp ConnectionPool, retryOnConnectionFailure, hasWfwSession guard & X-Gdou-Direct-Probe stripping'
  );
  const modalSrc = nodeFs.readFileSync(
    nodePath.join(process.cwd(), 'src', 'components', 'EphemeralSyncModal.tsx'),
    'utf8'
  );
  assert.ok(
    !modalSrc.includes('setActiveWebViewUri'),
    'EphemeralSyncModal must NOT mutate WebView source prop during onShouldStartLoadWithRequest (causes iOS 302 race)'
  );
  assert.ok(
    modalSrc.includes('injectedJavaScriptBeforeContentLoaded={preloadedWebViewJs}') &&
      modalSrc.includes('onLoadStart={') &&
      modalSrc.includes('onHttpError={') &&
      modalSrc.includes('handleSelectDirectRoute'),
    'EphemeralSyncModal must pass document-start preload script, Direct Mode route selector, onLoadStart bare-jw slip guard & onHttpError handler'
  );

  console.log('8b) Testing v1.4.0 multi-course overlap clustering, non-current-week view, Couple Schedule & OTA updater...');
  assert.ok(CURRENT_VERSION_HIGHLIGHTS.length >= 4, 'Current version must expose concise highlights');
  const sampleForCluster = buildSampleGdouData(new Date('2026-11-22T10:00:00'));
  // Wed 9-10 has BOTH sample-5 (even weeks) and sample-8 (odd weeks)!
  const week1CurrentOnly = buildTimetableClusters({
    myCourses: sampleForCluster.courses,
    selectedWeek: 1,
    showNonCurrentWeek: false,
    viewMode: 'mine',
  });
  const wed910Week1Only = week1CurrentOnly.find((c) => c.dayOfWeek === 3 && c.startSection === 9);
  assert.ok(Boolean(wed910Week1Only), 'Odd-week course must appear in Week 1');
  assert.equal(wed910Week1Only?.items.length, 1, 'Non-current-week course hidden when showNonCurrentWeek=false');

  const week1WithNonCurrent = buildTimetableClusters({
    myCourses: sampleForCluster.courses,
    selectedWeek: 1,
    showNonCurrentWeek: true,
    viewMode: 'mine',
  });
  const wed910Combined = week1WithNonCurrent.find((c) => c.dayOfWeek === 3 && c.startSection === 9);
  assert.equal(wed910Combined?.items.length, 2, 'Both odd & even week courses must cluster in same slot when showNonCurrentWeek=true');
  assert.equal(wed910Combined?.primary.isCurrentWeek, true, 'Current-week course MUST take primary priority over non-current-week');
  assert.equal(wed910Combined?.primary.course.name, '海洋遥感与测绘实验');
  assert.equal(wed910Combined?.hasSameWeekConflict, false);

  // Even week (Week 2): even-week course (数据结构实验) must flip to primary!
  const week2WithNonCurrent = buildTimetableClusters({
    myCourses: sampleForCluster.courses,
    selectedWeek: 2,
    showNonCurrentWeek: true,
    viewMode: 'mine',
  });
  const wed910Week2 = week2WithNonCurrent.find((c) => c.dayOfWeek === 3 && c.startSection === 9);
  assert.equal(wed910Week2?.primary.isCurrentWeek, true);
  assert.equal(wed910Week2?.primary.course.name, '数据结构实验');

  // Non-current-week courses MUST NEVER bridge separate current-week courses or trigger `hasSameWeekConflict`!
  const nonBridgeCourses = [
    {
      ...sampleForCluster.courses[0],
      id: 'nb-cur-12',
      name: '高等数学A',
      dayOfWeek: 4,
      startSection: 1,
      endSection: 2,
      weeks: [1],
      weekText: '1-16周(单)',
    },
    {
      ...sampleForCluster.courses[0],
      id: 'nb-cur-34',
      name: '大学英语',
      dayOfWeek: 4,
      startSection: 3,
      endSection: 4,
      weeks: [1],
      weekText: '1-16周(单)',
    },
    {
      ...sampleForCluster.courses[0],
      id: 'nb-noncur-14',
      name: '综合海洋大实验',
      dayOfWeek: 4,
      startSection: 1,
      endSection: 4,
      weeks: [2],
      weekText: '2-16周(双)',
    },
  ];
  const nonBridgeClusters = buildTimetableClusters({
    myCourses: nonBridgeCourses,
    selectedWeek: 1,
    showNonCurrentWeek: true,
    viewMode: 'mine',
  });
  const thuClusters = nonBridgeClusters.filter((c) => c.dayOfWeek === 4);
  assert.equal(
    thuClusters.length,
    2,
    'Non-current-week 1-4节 course must NEVER merge separate current-week 1-2节 and 3-4节 courses'
  );
  assert.ok(
    thuClusters.every((c) => c.hasSameWeekConflict === false),
    'Non-current-week courses must NEVER be marked as conflicts (撞课)'
  );

  // Split-week segments of identical course/room/teacher/slot merge cleanly in parseZfScheduleResponse
  const mergedSegmentsKb = parseZfScheduleResponse({
    kbList: [
      { kcmc: '航海学', kch: 'HH101', xm: '陈船长', cdmc: '航海楼201', xqj: '5', jc: '1-2节', zcd: '1-4周' },
      { kcmc: '航海学', kch: 'HH101', xm: '陈船长', cdmc: '航海楼201', xqj: '5', jc: '1-2节', zcd: '6-8周' },
    ],
  });
  assert.equal(mergedSegmentsKb.courses.length, 1, 'Split week segments of identical course must merge');
  assert.deepEqual(mergedSegmentsKb.courses[0]?.weeks, [1, 2, 3, 4, 6, 7, 8]);

  // Verify Native System Clock & iOS 26 AlarmKit bridges + OS auto-detection + zero-squeeze card layout guards
  assert.ok(
    pluginSrc.includes('GdouSystemAlarmBridge') &&
      pluginSrc.includes('AlarmClock.ACTION_SET_ALARM') &&
      pluginSrc.includes('putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS') &&
      pluginSrc.includes('GdouIosAlarmBridge') &&
      pluginSrc.includes('canImport(AlarmKit)') &&
      pluginSrc.includes('#available(iOS 26.0, *)') &&
      pluginSrc.includes('#available(iOS 26.1, *)') &&
      pluginSrc.includes('AlarmManager.shared') &&
      pluginSrc.includes('NSAlarmKitUsageDescription') &&
      pluginSrc.includes('extractWfwInnerUrl') &&
      pluginSrc.includes('extractWfwInnerPath'),
    'Native plugin must include Android GdouSystemAlarmBridge, iOS 26 AlarmKit GdouIosAlarmBridge & inner wfw cookie path matching'
  );
  assert.ok(
    Boolean(appJson.expo.ios?.infoPlist?.NSAlarmKitUsageDescription),
    'app.json must declare NSAlarmKitUsageDescription for iOS 26 AlarmKit'
  );
  const scheduleScreenSrc = nodeFs.readFileSync(
    nodePath.join(process.cwd(), 'src', 'screens', 'ScheduleScreen.tsx'),
    'utf8'
  );
  assert.ok(
    !scheduleScreenSrc.includes('paddingRight: 26') &&
      !scheduleScreenSrc.includes('multiCornerBadge') &&
      scheduleScreenSrc.includes('otherWeekFooterPill'),
    'ScheduleScreen must place 含他周 in bottom footer pill and NEVER horizontally squeeze cardName with paddingRight: 26'
  );
  const settingsScreenSrc = nodeFs.readFileSync(
    nodePath.join(process.cwd(), 'src', 'screens', 'SettingsScreen.tsx'),
    'utf8'
  );
  assert.ok(
    settingsScreenSrc.includes("Platform.OS === 'ios' && (\n              <View style={styles.iosSourceBox}>") ||
      settingsScreenSrc.includes("Platform.OS === 'ios' && ("),
    'SettingsScreen must hide iosSourceBox on Android'
  );
  const androidHighlights = getPlatformVersionHighlights('android').join('\n');
  assert.ok(
    !androidHighlights.includes('SideStore') &&
      !androidHighlights.includes('Feather') &&
      !androidHighlights.includes('IPA') &&
      !androidHighlights.includes('iOS 软件源'),
    'Android version highlights must not contain iOS software source / IPA wording'
  );

  // Same-week real conflict detection (2 courses both active in Week 1 on Mon 1-2)
  const conflictCourses = [
    ...sampleForCluster.courses,
    {
      ...sampleForCluster.courses[0],
      id: 'conflict-extra',
      name: '重修线性代数',
    },
  ];
  const conflictClusters = buildTimetableClusters({
    myCourses: conflictCourses,
    selectedWeek: 1,
    showNonCurrentWeek: false,
    viewMode: 'mine',
  });
  const monConflict = conflictClusters.find((c) => c.dayOfWeek === 1 && c.startSection === 1);
  assert.equal(monConflict?.items.length, 2);
  assert.equal(monConflict?.hasSameWeekConflict, true);

  // Couple Schedule share code round-trip, chat-message extraction, zero-credential check & insights
  const samplePartner = buildSamplePartnerSchedule(sampleForCluster.termLabel, settings.termStartDate);
  const shareCode = encodeCoupleShareCode({
    partnerName: '小海',
    termLabel: sampleForCluster.termLabel,
    termStartDate: settings.termStartDate,
    courses: samplePartner.courses,
  });
  assert.ok(shareCode.startsWith(COUPLE_SHARE_PREFIX));
  const decodedFromWeChatMsg = decodeCoupleSharePayload(
    `【海大课表】快复制这条消息绑定情侣课表吧：\n${shareCode}\n谢谢！`
  );
  assert.equal(decodedFromWeChatMsg.partnerName, '小海');
  assert.equal(decodedFromWeChatMsg.courses.length, samplePartner.courses.length);
  assert.ok(decodedFromWeChatMsg.courses.every((c) => c.ownerTag === 'partner'));
  assert.deepEqual(findForbiddenCredentialKeys(decodedFromWeChatMsg), []);

  const coupleJsonFile = buildCoupleShareJsonFileContent({
    partnerName: '小海',
    termLabel: sampleForCluster.termLabel,
    termStartDate: settings.termStartDate,
    courses: samplePartner.courses,
  });
  const decodedFromJson = decodeCoupleSharePayload(coupleJsonFile, '宝宝');
  assert.equal(decodedFromJson.partnerName, '宝宝');
  assert.equal(decodedFromJson.courses.length, samplePartner.courses.length);

  const coupleClusters = buildTimetableClusters({
    myCourses: sampleForCluster.courses,
    partnerCourses: samplePartner.courses,
    selectedWeek: 1,
    showNonCurrentWeek: true,
    viewMode: 'couple',
  });
  const monTogether = coupleClusters.find((c) => c.dayOfWeek === 1 && c.startSection === 1);
  assert.equal(monTogether?.isSameCourseTogether, true, 'Mon 1-2 shared 海洋科学导论 must be marked together');
  const tueOverlap = coupleClusters.find((c) => c.dayOfWeek === 2 && c.startSection === 3);
  assert.equal(tueOverlap?.hasBothPartnersInWeek, true);
  assert.equal(tueOverlap?.items.length, 2);

  const insights = computeCoupleScheduleInsights({
    myCourses: sampleForCluster.courses,
    partnerCourses: samplePartner.courses,
    partnerName: '小海',
    selectedWeek: 1,
    currentWeek: 1,
    periods: CAMPUS_PRESETS.huguang_0810.periods,
    now: new Date('2026-09-02T12:30:00'),
  });
  assert.ok(insights.togetherSessionsCount >= 1);
  assert.ok(insights.sameBuildingSessionsCount >= 1);
  assert.ok(insights.sharedFreeBlocks.length > 0);

  // OTA asset selector, concise release summary parser & 403/429 campus fallback
  const otaPicked = selectPlatformOtaAssets(
    [
      {
        name: 'haida-schedule-v1.5.0-ios-ota.jsbundle',
        browser_download_url: 'https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v1.5.0/haida-schedule-v1.5.0-ios-ota.jsbundle',
        size: 1450000,
      },
      {
        name: 'haida-schedule-v1.5.0-ota-manifest.json',
        browser_download_url: 'https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v1.5.0/haida-schedule-v1.5.0-ota-manifest.json',
        size: 512,
      },
    ],
    'ios'
  );
  assert.equal(otaPicked.bundleAsset?.name, 'haida-schedule-v1.5.0-ios-ota.jsbundle');
  assert.equal(otaPicked.manifestAsset?.name, 'haida-schedule-v1.5.0-ota-manifest.json');

  const highlights = summarizeReleaseHighlights(
    '## 海大课表 v1.5.0\n### 1. 新增情侣课表\n- **双人同屏**：支持共同空闲标记\n- 修复课表重叠遮挡\n## 安装指南\n- 先下载爱思助手'
  );
  assert.ok(highlights.some((h) => h.includes('新增情侣课表')));
  assert.ok(highlights.some((h) => h.includes('双人同屏')));
  assert.ok(!highlights.some((h) => h.includes('爱思助手')), 'Must stop before install tutorial');

  const origFetchForRateLimit = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return makeMockResponse(403, 'rate limit exceeded', url);
      }
      return makeMockResponse(
        200,
        JSON.stringify({
          apps: [
            {
              version: '1.5.0',
              versionDate: '2026-11-25',
              versionDescription: '- 支持软件内直接热更新\n- 新增情侣课表',
              downloadURL:
                'https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v1.5.0/haida-schedule-v1.5.0-ios-unsigned.ipa',
              size: 12000000,
            },
          ],
        }),
        url
      );
    }) as typeof fetch;
    const fbUpd = await checkForAppUpdate('1.4.0', 'ios');
    assert.equal(fbUpd.hasUpdate, true);
    assert.equal(fbUpd.latestVersion, '1.5.0');
    assert.equal(fbUpd.otaAssetName, 'haida-schedule-v1.5.0-ios-ota.jsbundle');
  } finally {
    globalThis.fetch = origFetchForRateLimit;
  }

  console.log(`   OK: Calendar legacy guard, updater, v1.4.0 overlap/couple/OTA checks, single-source version v${appJson.expo.version} & config plugin verified.`);

  console.log('8c) Testing empty classrooms, graduation audit & sub-score source labels, diff alerts, campus search, calendar makeup, HD poster & native widgets...');
  // 1. Empty classrooms bitmask, options HTML & rooms JSON parser
  assert.equal(buildZhengfangBitmask([1, 2]), 3);
  assert.equal(buildZhengfangBitmask([9, 10]), 768);
  const ecQuery = buildEmptyClassroomQueryParams({
    xnm: '2026',
    xqm: '3',
    campusId: '1',
    buildingId: 'ZH',
    week: 5,
    dayOfWeek: 3,
    sections: [1, 2],
    minSeats: 60,
  });
  assert.equal(ecQuery.zcd, '16');
  assert.equal(ecQuery.jcd, '3');
  assert.equal(ecQuery.qszws, '60');
  const ecOpts = parseEmptyClassroomOptionsHtml(
    '<select id="xqh_id"><option value="">全部</option><option value="1">湖光校区</option><option value="4">阳江校区</option></select>' +
      '<select id="lh"><option value="ZH">钟海楼</option><option value="ZL">主教学楼</option></select>' +
      '<select id="cdlb_id"><option value="01">多媒体教室</option></select>'
  );
  assert.equal(ecOpts.campuses.length, 2);
  assert.equal(ecOpts.buildings[0]?.name, '钟海楼');
  const parsedRooms = parseZfEmptyClassroomsResponse({
    items: [
      { cdbh: 'ZH02018', cdmc: '钟海楼02018', jxlmc: '钟海楼', xqmc: '湖光校区', cdlbmc: '多媒体教室', zws: '120' },
      { cdbh: 'ZL402', cdmc: '主教学楼402', xqmc: '湖光校区', cdlbmc: '普通教室', zws: '80' },
    ],
  });
  assert.equal(parsedRooms.length, 2);
  assert.equal(parsedRooms.find((r) => r.roomCode === 'ZH02018')?.seats, 120);

  // 2. Graduation curriculum audit (explicit source attribution for official vs local estimate)
  const officialAudit = parseZfGraduationAuditResponse({
    items: [
      { xfyqmc: '毕业总学分要求', yqzdxf: '165', yhxf: '120', zxxf: '18', zymc: '软件工程' },
      { xfyqmc: '通识教育必修课', yqzdxf: '42', yhxf: '42', zxxf: '0', ytgms: '14' },
      { xfyqmc: '专业核心课', yqzdxf: '58', yhxf: '40', zxxf: '12', ytgms: '11' },
    ],
  });
  assert.ok(Boolean(officialAudit), 'Official curriculum audit must parse');
  assert.equal(officialAudit?.source, 'official_zf_curriculum');
  assert.ok(officialAudit?.sourceLabel.includes('正方教务'), 'Official audit must label 正方教务 source');
  assert.equal(officialAudit?.totalRequiredCredits, 165);
  assert.equal(officialAudit?.totalRemainingCredits, 45);
  const localEstAudit = buildLocalEstimatedGraduationAudit(parsedGrades);
  assert.equal(localEstAudit.source, 'local_grade_estimate');
  assert.ok(localEstAudit.sourceLabel.includes('本地已修成绩'), 'Fallback audit must honestly label local estimate');

  // 3. Grade sub-scores (平时分 / 实验 / 期末卷面占比) HTML & JSON parsing
  const subFromHtml = parseZfGradeSubScoresResponse(
    '<table id="subtab"><tr><td>【 平时(30%) 】</td><td>94</td></tr><tr><td>【 期末(70%) 】</td><td>86</td></tr></table>'
  );
  assert.equal(subFromHtml.length, 2);
  assert.equal(subFromHtml[0]?.itemName, '平时');
  assert.equal(subFromHtml[0]?.weightText, '30%');
  assert.equal(subFromHtml[0]?.scoreText, '94');
  const subFromJson = parseZfGradeSubScoresResponse({
    items: [
      { xmblmc: '平时成绩(30%)', xmcj: '95' },
      { xmblmc: '实验成绩(20%)', xmcj: '90' },
      { xmblmc: '期末成绩(50%)', xmcj: '88' },
    ],
  });
  assert.equal(subFromJson.length, 3);
  assert.equal(subFromJson[2]?.weightText, '50%');

  // 4. Schedule diff engine (room_changed, time_changed, added, removed; ignores manual/audit)
  const diffBase = sampleForCluster.courses.slice(0, 3);
  const diffNext = [
    { ...diffBase[0], location: '海博楼105' }, // room_changed
    { ...diffBase[1], dayOfWeek: 4, startSection: 7, endSection: 8 }, // time_changed
    // diffBase[2] removed
    { ...diffBase[0], id: 'new-c', name: '海洋遥感概论', code: 'HY409', dayOfWeek: 5, startSection: 1, endSection: 2 },
    { ...diffBase[0], id: 'audit-ignore', name: '旁听课', isManual: true, isAudit: true },
  ];
  const diffReport = computeScheduleDiff(diffBase, diffNext, '2026-2027学年 第1学期');
  assert.ok(Boolean(diffReport), 'Schedule diff must detect changes');
  assert.ok(diffReport?.entries.some((e) => e.kind === 'room_changed' && e.afterText === '海博楼105'));
  assert.ok(diffReport?.entries.some((e) => e.kind === 'time_changed'));
  assert.ok(diffReport?.entries.some((e) => e.kind === 'removed'));
  assert.ok(diffReport?.entries.some((e) => e.kind === 'added' && e.courseName === '海洋遥感概论'));
  assert.equal(
    diffReport?.entries.some((e) => e.courseName === '旁听课'),
    false,
    'Manual/audit courses must be ignored by official diff engine'
  );
  assert.equal(computeScheduleDiff([], diffNext, '2026-2027学年 第1学期'), null, 'First sync must not emit diff');

  // 5. Campus-wide / teacher / class course search parser
  const campusSearchParams = buildCampusCourseSearchParams({
    xnm: '2026',
    xqm: '3',
    keyword: '海洋',
    teacher: '陈海明',
  });
  assert.equal(campusSearchParams.kcmc, '海洋');
  assert.equal(campusSearchParams.jsxm, '陈海明');
  const campusFound = parseZfCampusCourseSearchResponse({
    items: [
      {
        kcmc: '海洋物理概论',
        kch: 'HY2201',
        jsxm: '陈海明',
        sksj: '星期一第1-2节{1-16周};星期三第5-6节{2-16周(双)}',
        jxdd: '钟海楼02018;科技楼305',
        xqmc: '湖光校区',
        xf: '3.0',
        jxbmc: '海洋2401',
      },
    ],
  });
  assert.equal(campusFound.length, 2, 'Multi-segment sksj campus course must split into 2 scheduled slots');
  assert.equal(campusFound[0]?.isAudit, true);
  assert.equal(campusFound[1]?.dayOfWeek, 3);
  assert.equal(campusFound[1]?.location, '科技楼305');

  // 6. GDOU Academic Calendar & Holiday / Makeup-Day mapping
  const holResolved = resolveEffectiveScheduleDate(new Date('2026-10-01T09:00:00'), '2026-08-31', 20);
  assert.equal(holResolved.isHoliday, true, '2026-10-01 National Day must resolve as holiday');
  const holCourses = getCoursesForDate(sampleForCluster.courses, new Date('2026-10-01T09:00:00'), {
    ...settings,
    termStartDate: '2026-08-31',
  });
  assert.equal(holCourses.courses.length, 0, 'Holiday must suspend regular classes');
  const makeupResolved = resolveEffectiveScheduleDate(new Date('2026-10-10T09:00:00'), '2026-08-31', 20);
  assert.equal(makeupResolved.isMakeup, true, '2026-10-10 makeup day must resolve as makeup');
  assert.equal(makeupResolved.effectiveDayOfWeek, 3, '2026-10-10 makeup maps to Wednesday');
  const makeupCourses = getCoursesForDate(sampleForCluster.courses, new Date('2026-10-10T09:00:00'), {
    ...settings,
    termStartDate: '2026-08-31',
  });
  assert.ok(makeupCourses.courses.length > 0, 'Makeup day must load Wednesday courses');
  const todayLiveSnap = buildTodayLiveSnapshot(sampleForCluster.courses, { ...settings, termStartDate: '2026-08-31' }, new Date('2026-09-07T08:30:00'));
  assert.equal(todayLiveSnap.state, 'ongoing', '08:30 Monday during 08:10-09:45 class must report ongoing');
  const calCountdowns = buildGdouCalendarCountdowns('2026-08-31', 20, sampleForCluster.exams, [], new Date('2026-09-10T09:00:00'));
  assert.ok(calCountdowns.countdowns.length >= 2);

  // 7. HD Schedule Poster HTML generator & WebView auxiliary jobs syntax validation
  const posterHtml = buildSchedulePosterHtml({
    courses: sampleForCluster.courses,
    coupleSchedule: null,
    selectedWeek: 1,
    termLabel: sampleForCluster.termLabel,
    viewMode: 'mine',
    settings,
  });
  assert.ok(posterHtml.includes('width="1240"') && posterHtml.includes('POSTER_READY'));
  new Function(
    buildIncognitoWebViewSyncScript(undefined, 'verify-bridge-nonce', 'https://wfw.gdou.edu.cn/', {
      kind: 'empty_classroom',
      params: {
        xnm: '2026',
        xqm: '3',
        campusId: '1',
        buildingId: '',
        roomTypeId: '',
        week: 1,
        dayOfWeek: 1,
        sections: [1, 2],
      },
    })
  );
  new Function(
    buildIncognitoWebViewSyncScript(undefined, 'verify-bridge-nonce', 'https://wfw.gdou.edu.cn/', {
      kind: 'campus_search',
      query: { xnm: '2026', xqm: '3', keyword: '高等数学' },
    })
  );

  // 8. Zero-retention check on all new persisted objects + native plugin Widget/Ongoing/Dynamic Island/SAF assertions
  assert.deepEqual(
    findForbiddenCredentialKeys({
      graduationAudit: officialAudit,
      lastScheduleDiff: diffReport,
      emptyClassroomSnapshot: { rooms: parsedRooms, params: ecQuery },
      campusSearchHistory: { courses: campusFound },
    }),
    [],
    'All new persisted structures must contain ZERO forbidden credential keys or values'
  );
  assert.ok(
    pluginSrc.includes('GdouScheduleWidgetProvider') &&
      pluginSrc.includes('GdouOngoingNotificationHelper') &&
      pluginSrc.includes('GdouMediaPickerActivity') &&
      pluginSrc.includes('GdouMediaSaver') &&
      pluginSrc.includes('GdouScheduleActivityAttributes') &&
      pluginSrc.includes('GdouScheduleWidgetBundle') &&
      pluginSrc.includes('DynamicIsland') &&
      pluginSrc.includes('NSSupportsLiveActivities') &&
      pluginSrc.includes('GdouIosWidgetBridge') &&
      pluginSrc.includes('PHPickerViewController') &&
      pluginSrc.includes('com.apple.security.application-groups') &&
      pluginSrc.includes('GdouScheduleWidgetExtension'),
    'Native plugin must contain Android AppWidget, Ongoing Notification, Zero-Permission SAF Picker/MediaStore, iOS WidgetKit, Dynamic Island & PHPicker'
  );
  console.log('   OK: All 9 new feature engines, source attributions, zero-retention & native widget plugins verified.');

  if (runLive) {
    console.log('9) [--live] Testing LIVE GDOU entry handshake (read-only, zero credentials)...');
    const liveSession = await prepareGdouAuthSession();
    console.log('   LIVE route:', liveSession.isWebVpn ? 'wfw-webvpn' : 'campus-direct');
    console.log('   LIVE salt len:', liveSession.pwdEncryptSalt.length, 'execution:', liveSession.execution);
    assert.ok(liveSession.pwdEncryptSalt.length >= 16, 'Expected 16-byte pwdEncryptSalt');
    assert.ok(liveSession.execution.length > 0, 'Expected execution token');
  } else {
    console.log('9) Live network handshake skipped (offline mode; pass --live to run).');
  }

  console.log('\nALL VERIFICATION CHECKS PASSED!');
}

run().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
