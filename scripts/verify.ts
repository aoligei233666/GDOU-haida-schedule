import CryptoJS from 'crypto-js';
import appJson from '../app.json';
import pkgLockJson from '../package-lock.json';
import pkgJson from '../package.json';
import {
  isAllowedWebViewNavigationUrl,
  isTrustedWebViewMessageUrl,
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
  submitGdouMfaAndCompleteSync,
} from '../src/services/gdouAuth';
import {
  computeGpaSummary,
  computeScoreDistribution,
  computeTermBreakdowns,
  parseZfGradesResponse,
} from '../src/services/gradeParser';
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
  checkForAppUpdate,
  compareSemver,
  GITHUB_RELEASES_PAGE_URL,
  isTrustedGithubReleaseUrl,
  selectPlatformReleaseAsset,
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
      timedOutCaught = (err instanceof Error ? err.message : '').includes('请求超时');
    }
    assert.ok(timedOutCaught, 'fetchWithTimeout must abort hanging requests');
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
    assert.equal(isTrustedWebViewMessageUrl('https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn'), true);
    assert.equal(isTrustedWebViewMessageUrl('https://evil.example.com'), false);
    const token = generateSecureHex(16);
    const injected = buildIncognitoWebViewSyncScript(undefined, token);
    assert.ok(injected.includes(token), 'WebView script must embed bridgeToken');
    assert.ok(injected.includes('upgrade-insecure-requests'), 'WebView script must inject HTTPS upgrade CSP');
    assert.ok(injected.includes('xskbcx_cxRjc.html'), 'WebView script must query official section period times');
    assert.ok(injected.includes('sessionStorage.clear()'), 'WebView script must clear sessionStorage');
    assert.ok(injected.includes('storageCleaned: storageCleaned'), 'WebView script must report verified storageCleaned');
    assert.ok(injected.includes('Promise.race'), 'WebView timedFetch must have Promise.race timeout fallback');
    assert.ok(injected.includes("xnm: '', xqm: ''"), 'WebView script must include 3rd exam query variant');

    // 3e. Off-campus wfw MFA -> Step 2 sub-session auth keeps WFWSESSID alive with ZERO retained password
    let logoutCalledDuringMfaHandoff = false;
    globalThis.fetch = (async (input: unknown) => {
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
      assert.equal(mfaOutcome.subAuth.salt2, 'WFW2Salt12345678');
      assert.equal('password' in mfaOutcome.subAuth, false, 'WfwSubAuthState must never carry password');
      const step2Creds: EphemeralCredentials = { username: 'TEST_STUDENT_001', password: 'TempPassword123' };
      const finalSync = await completeWfwSubAuthAndSync(mfaOutcome.subAuth, step2Creds);
      assert.equal(areCredentialsPurged(step2Creds), true, 'Step 2 credentials must be purged');
      assert.equal(finalSync.courses.length, 1);
      assert.equal(finalSync.syncedPeriods?.length, 8);
      assert.equal(finalSync.syncedPeriods?.[1].start, '09:00');
      assert.equal(finalSync.receipt.sessionLoggedOut, true);
      assert.equal(logoutCalledDuringMfaHandoff, true, 'Must log out after Step 2 completes');
    }
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pluginFn = require('../plugins/withGdouZeroRetention.js') as unknown;
  assert.equal(typeof pluginFn, 'function', 'Config plugin must export a function');
  console.log(`   OK: Calendar legacy guard, updater, single-source version v${appJson.expo.version} & config plugin verified.`);

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
