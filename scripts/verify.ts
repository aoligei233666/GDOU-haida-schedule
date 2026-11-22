import CryptoJS from 'crypto-js';
import appJson from '../app.json';
import pkgJson from '../package.json';
import {
  isAllowedWebViewNavigationUrl,
  isTrustedWebViewMessageUrl,
} from '../src/constants/gdouEndpoints';
import { buildSampleGdouData, createDefaultSettings } from '../src/constants/gdouTimetable';
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
  fetchWithTimeout,
  isAccountLockedMessage,
  logoutEphemeralSession,
  PreparedAuthSession,
  prepareGdouAuthSession,
} from '../src/services/gdouAuth';
import { computeGpaSummary, parseZfGradesResponse } from '../src/services/gradeParser';
import { buildGdouIcsContent, foldIcsLine } from '../src/services/icsBuilder';
import {
  getCourseOccurrences,
  getFirstClassPerDayInWeek,
  parseLocalDateStrict,
  parseSectionRange,
  parseWeekExpression,
  parseZfScheduleResponse,
} from '../src/services/scheduleParser';
import {
  findForbiddenCredentialKeys,
  sanitizeForZeroRetention,
} from '../src/services/zeroRetentionSanitizer';
import { EphemeralCredentials } from '../src/types/models';

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

  console.log('2) Testing real recursive zero-retention sanitizer & credential purge...');
  const creds: EphemeralCredentials = { username: '202411701101', password: 'SecretPassword', captcha: '1234' };
  assert.equal(areCredentialsPurged(creds), false);
  purgeEphemeralCredentials(creds);
  assert.equal(areCredentialsPurged(creds), true);
  const dirtyPayload = {
    courses: [{ name: '海洋科学', password: 'leak', nested: { token: 'abc', castgc: 'tgt', ok: 1 } }],
    username: '202411701101',
    password: 'SecretPassword',
    cookie: 'JSESSIONID=abc',
    meta: { pwdEncryptSalt: 'salt123456789012', execution: 'e1s1', keep: true },
  };
  const sanitized = sanitizeForZeroRetention(dirtyPayload);
  assert.deepEqual(findForbiddenCredentialKeys(sanitized), []);
  assert.equal(sanitized.courses[0].name, '海洋科学');
  assert.equal((sanitized.courses[0].nested as { ok: number }).ok, 1);
  assert.equal((sanitized.meta as { keep: boolean }).keep, true);
  console.log('   OK: Production recursive sanitizer stripped all top-level & nested credential keys.');

  console.log('3) Testing gdouAuth timeout, fail-closed captcha, verified logout & WebView guards (mocked)...');
  const originalFetch = globalThis.fetch;
  try {
    // 3a. Timeout enforcement
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as typeof fetch;

    let timedOutCaught = false;
    try {
      await fetchWithTimeout('https://authserver.gdou.edu.cn/test', {}, { timeoutMs: 40 });
    } catch (err) {
      timedOutCaught = (err instanceof Error ? err.message : '').includes('请求超时');
    }
    assert.ok(timedOutCaught, 'fetchWithTimeout must abort hanging requests');

    // 3b. Real verified logout (success case vs failure case)
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
      'https://jw.gdou.edu.cn',
      'https://authserver.gdou.edu.cn',
      false,
      ''
    );
    assert.equal(logoutFail.casLoggedOut, false);
    assert.equal(logoutFail.succeeded, 0);
    assert.equal(logoutFail.failedEndpoints.length, 2);

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
    const captchaErr = await checkGdouCaptcha(mockSession, '20240001');
    assert.equal(captchaErr.checkFailed, true);
    assert.ok(Boolean(captchaErr.errorMessage), 'checkGdouCaptcha must surface HTTP error');

    // 3d. Lockout detector & WebView origin allowlists + bridge token
    assert.equal(isAccountLockedMessage('您的账号已被冻结，请稍后再试'), true);
    assert.equal(isAccountLockedMessage('密码错误'), false);
    assert.equal(isAllowedWebViewNavigationUrl('https://authserver.gdou.edu.cn/authserver/login'), true);
    assert.equal(isAllowedWebViewNavigationUrl('http://authserver.gdou.edu.cn/authserver/login'), false);
    assert.equal(isAllowedWebViewNavigationUrl('https://evil.example.com/phish'), false);
    assert.equal(isTrustedWebViewMessageUrl('https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn'), true);
    assert.equal(isTrustedWebViewMessageUrl('https://evil.example.com'), false);
    const token = generateSecureHex(16);
    const injected = buildIncognitoWebViewSyncScript(undefined, token);
    assert.ok(injected.includes(token), 'WebView script must embed bridgeToken');
    assert.ok(injected.includes('sessionStorage.clear()'), 'WebView script must clear sessionStorage');
    assert.ok(injected.includes("xnm: '', xqm: ''"), 'WebView script must include 3rd exam query variant');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('   OK: Timeout, verified logout, fail-closed captcha, lockout breaker & WebView guards verified.');

  console.log('4) Testing 正方 week/section/schedule parser & explicit unparsed warnings...');
  assert.deepEqual(parseWeekExpression('1-4周(单),6-8周(双),11周'), [1, 3, 6, 8, 11]);
  assert.deepEqual(parseSectionRange('3-4节'), { startSection: 3, endSection: 4 });
  assert.equal(parseSectionRange('未知节次'), null);
  assert.equal(parseLocalDateStrict('2026-02-31'), null);
  assert.ok(parseLocalDateStrict('2026-09-07') !== null);

  const parsedKb = parseZfScheduleResponse({
    xsxx: { XH: '20240001', XM: '测试同学', XNMC: '2026-2027', XQMMC: '1' },
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

  console.log('5) Testing 正方 exam & GPA/Credit parser (including empty kssj & estimation flags)...');
  const parsedGrades = parseZfGradesResponse({
    items: [
      { kcmc: '高等数学（上）', kch: 'SX110201', xf: '5.0', cj: '90', jd: '4.0', kcxzmc: '公共必修课', xnmmc: '2025-2026', xqmmc: '1' },
      { kcmc: '海洋科学导论', kch: 'HY100101', xf: '3.0', cj: '优秀', kcxzmc: '专业必修课', xnmmc: '2025-2026', xqmmc: '1' },
    ],
  });
  assert.equal(parsedGrades[0].gpaEstimated, false);
  assert.equal(parsedGrades[1].gpaEstimated, true);
  const gpaSummary = computeGpaSummary(parsedGrades);
  assert.equal(gpaSummary.totalCreditsEarned, 8);
  assert.equal(gpaSummary.weightedGpa, 4.19);
  assert.equal(gpaSummary.hasEstimatedItems, true);

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
  console.log('   OK: Exam parser (empty kssj fallback) & GPA estimation flags verified.');

  console.log('6) Testing RFC 5545 .ics calendar exporter (75-octet folding, UTC DTSTAMP, stable UIDs)...');
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
  // Verify folding preserves full content when unfolded per RFC 5545
  const unfolded = ics1.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:海洋科学导论'));
  assert.ok(unfolded.includes('SUMMARY:【期末考试】高等数学（上）'));
  assert.ok(unfolded.includes('张三丰教授\\n第二行备注'));
  const longFolded = foldIcsLine('DESCRIPTION:教师: 张三丰教授 | 第3-4节 | 第11周 (1-4周,6-12周(双),15周)');
  assert.ok(longFolded.includes('\r\n '), '86-octet description must be folded');
  console.log('   OK: RFC 5545 ICS (all', physicalLines.length, 'lines <= 75 octets) verified.');

  console.log('7) Testing version consistency & Expo config plugin registration...');
  assert.equal(pkgJson.version, appJson.expo.version, 'package.json and app.json versions must match');
  assert.ok(
    (appJson.expo.plugins as unknown[]).includes('./plugins/withGdouZeroRetention'),
    'app.json must register ./plugins/withGdouZeroRetention'
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pluginFn = require('../plugins/withGdouZeroRetention.js') as unknown;
  assert.equal(typeof pluginFn, 'function', 'Config plugin must export a function');
  console.log(`   OK: Single-source version v${appJson.expo.version} & config plugin verified.`);

  if (runLive) {
    console.log('8) [--live] Testing LIVE GDOU entry handshake (read-only, zero credentials)...');
    const liveSession = await prepareGdouAuthSession();
    console.log('   LIVE route:', liveSession.isWebVpn ? 'wfw-webvpn' : 'campus-direct');
    console.log('   LIVE salt len:', liveSession.pwdEncryptSalt.length, 'execution:', liveSession.execution);
    assert.ok(liveSession.pwdEncryptSalt.length >= 16, 'Expected 16-byte pwdEncryptSalt');
    assert.ok(liveSession.execution.length > 0, 'Expected execution token');
  } else {
    console.log('8) Live network handshake skipped (offline mode; pass --live to run).');
  }

  console.log('\nALL VERIFICATION CHECKS PASSED!');
}

run().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
