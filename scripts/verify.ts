import CryptoJS from 'crypto-js';
import { buildSampleGdouData, createDefaultSettings } from '../src/constants/gdouTimetable';
import { encryptGdouPassword, purgeEphemeralCredentials } from '../src/services/cryptoAes';
import { getExamCountdown, parseExamDateTime, parseZfExamResponse } from '../src/services/examParser';
import { checkGdouCaptcha, prepareGdouAuthSession } from '../src/services/gdouAuth';
import { buildGdouIcsContent } from '../src/services/icsBuilder';
import {
  getCourseOccurrences,
  getFirstClassPerDayInWeek,
  parseSectionRange,
  parseWeekExpression,
  parseZfScheduleResponse,
} from '../src/services/scheduleParser';
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
};

const FORBIDDEN_KEYS = new Set([
  'username',
  'password',
  'pwd',
  'passwd',
  'cookie',
  'cookies',
  'token',
  'jsessionid',
  'wfwsessid',
  'tgc',
  'pwdEncryptSalt',
  'execution',
  'salt',
]);

function checkZeroCredentialSanitizer(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase()) || FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

async function run() {
  console.log('1) Testing GDOU AES-128-CBC-PKCS7 password encryption...');
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
  console.log('   OK: AES-CBC round-trip verified ->', cipher.slice(0, 28) + '...');

  console.log('2) Testing ephemeral credential purge...');
  const creds: EphemeralCredentials = { username: '202411701101', password: 'SecretPassword', captcha: '1234' };
  purgeEphemeralCredentials(creds);
  assert.equal(creds.username, '');
  assert.equal(creds.password, '');
  assert.equal(creds.captcha, '');
  const sanitized = checkZeroCredentialSanitizer({
    courses: [],
    username: '202411701101',
    password: 'SecretPassword',
    cookie: 'JSESSIONID=abc',
  });
  assert.deepEqual(Object.keys(sanitized), ['courses']);
  console.log('   OK: Credentials zeroed & forbidden keys stripped.');

  console.log('3) Testing 正方 week/section/schedule parser...');
  assert.deepEqual(parseWeekExpression('1-4周(单),6-8周(双),11周'), [1, 3, 6, 8, 11]);
  assert.deepEqual(parseSectionRange('3-4节'), { startSection: 3, endSection: 4 });
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
    ],
  });
  assert.equal(parsedKb.courses.length, 2);
  assert.equal(parsedKb.termLabel, '2026-2027学年 第1学期');
  assert.deepEqual(parsedKb.courses[0].weeks, [1, 3, 5, 7, 9, 11, 13, 15]);
  const firstPerDay = getFirstClassPerDayInWeek(parsedKb.courses, 1);
  assert.equal(firstPerDay.get(2)?.name, '海洋气象学');
  const settings = createDefaultSettings(new Date('2026-09-10T08:00:00'));
  const occs = getCourseOccurrences(parsedKb.courses[0], settings.termStartDate, settings.customPeriods);
  assert.equal(occs.length, 8);
  assert.equal(occs[0].start.getHours(), 8);
  assert.equal(occs[0].start.getMinutes(), 10);
  console.log('   OK: Schedule parser & occurrence generator verified.');

  console.log('4) Testing 正方 exam parser & countdown...');
  const parsedDt = parseExamDateTime('2026-12-28(09:00-11:00)');
  assert.equal(parsedDt.dateText, '2026-12-28');
  assert.equal(parsedDt.startTimeText, '09:00');
  assert.equal(parsedDt.endTimeText, '11:00');
  const parsedExams = parseZfExamResponse({
    items: [
      {
        kcmc: '高等数学（上）',
        kch: 'SX110201',
        kssj: '2026-12-28(09:00-11:00)',
        cdmc: '钟海楼02018',
        zwh: '24',
        ksxzmc: '期末考试',
        cdxqmc: '湖光校区',
      },
    ],
  });
  assert.equal(parsedExams.length, 1);
  assert.equal(parsedExams[0].seatNumber, '24');
  const cd = getExamCountdown(parsedExams[0], new Date('2026-12-20T10:00:00'));
  assert.equal(cd.daysLeft, 8);
  assert.equal(cd.label, '还有 8 天');
  console.log('   OK: Exam parser & countdown verified.');

  console.log('5) Testing RFC 5545 .ics calendar exporter...');
  const sample = buildSampleGdouData(new Date('2026-11-22T10:00:00'));
  const ics = buildGdouIcsContent(sample.courses, sample.exams, settings, sample.termLabel);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
  assert.ok(ics.includes('SUMMARY:海洋科学导论'));
  assert.ok(ics.includes('SUMMARY:【期末考试】高等数学（上）'));
  assert.ok(ics.includes('TRIGGER:-PT15M'));
  assert.ok(ics.includes('TRIGGER:-P1D'));
  assert.ok(ics.endsWith('END:VCALENDAR'));
  console.log('   OK: ICS generated cleanly ->', ics.length, 'bytes.');

  console.log('6) Testing LIVE GDOU entry handshake (https://netcheck.gdou.edu.cn/go.php?code=jw)...');
  const liveSession = await prepareGdouAuthSession();
  console.log('   LIVE route:', liveSession.isWebVpn ? 'wfw-webvpn' : 'campus-direct');
  console.log('   LIVE finalUrl:', liveSession.entryFinalUrl);
  console.log('   LIVE salt len:', liveSession.pwdEncryptSalt.length, 'execution:', liveSession.execution);
  assert.ok(liveSession.pwdEncryptSalt.length >= 16, 'Expected 16-byte pwdEncryptSalt from live GDOU authserver');
  assert.ok(liveSession.execution.length > 0, 'Expected execution token from live GDOU authserver');
  assert.ok(liveSession.serviceUrl.includes('jw.gdou.edu.cn'), 'Expected jw.gdou.edu.cn service URL');
  const captchaRes = await checkGdouCaptcha(liveSession, '202411701101');
  console.log('   LIVE checkNeedCaptcha:', JSON.stringify({ isNeed: captchaRes.isNeed }));

  console.log('\nALL VERIFICATION CHECKS PASSED!');
}

run().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
