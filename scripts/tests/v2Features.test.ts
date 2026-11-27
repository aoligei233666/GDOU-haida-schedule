/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require('crypto') as {
  generateKeyPairSync(alg: string): {
    publicKey: { export(opts: { type: string; format: string }): Uint8Array };
    privateKey: unknown;
  };
  sign(alg: null, data: Uint8Array, key: unknown): { toString(enc: string): string };
};
const fs = require('fs') as {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: string): string;
};
const path = require('path') as {
  join(...parts: string[]): string;
};

const assert = {
  equal<T>(actual: T, expected: T, msg?: string) {
    if (actual !== expected) {
      throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  notEqual<T>(actual: T, expected: T, msg?: string) {
    if (actual === expected) {
      throw new Error(msg || `Expected value not equal to ${JSON.stringify(expected)}`);
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
import { lookupGdouBuildingGuide } from '../../src/constants/gdouBuildings';
import { createDefaultSettings, getDefaultTermStartDateForTerm } from '../../src/constants/gdouTimetable';
import {
  getEffectiveCourseWallClockOccurrences,
  getEffectiveFirstClassPerDayInWeek,
  setDynamicCalendarPresets,
} from '../../src/services/academicCalendar';
import {
  buildZeroRetentionBackupEnvelope,
  parseAndValidateBackupJson,
} from '../../src/services/backupCodec';
import { computeGpaSummary } from '../../src/services/gradeParser';
import { buildGdouIcsContent } from '../../src/services/icsBuilder';
import {
  buildCanonicalOtaManifestPayload,
  OTA_ED25519_PUBLIC_KEY_HEX,
  verifyOtaManifestSignature,
} from '../../src/services/otaCrypto';
import { validateRemoteCalendarPayload } from '../../src/services/remoteCalendarParser';
import {
  buildTermArchiveKey,
  createInitialAppData,
  mergeCourseCustomizations,
  snapshotActiveTermToArchive,
  switchToArchivedTerm,
} from '../../src/services/storageHelpers';
import {
  buildSanitizedTranscriptCsv,
  buildSanitizedTranscriptText,
} from '../../src/services/transcriptBuilder';
import { buildCampusMirrorDownloadUrls } from '../../src/services/updateService';
import { findForbiddenCredentialKeys } from '../../src/services/zeroRetentionSanitizer';
import { COURSE_PALETTE_DARK, DARK_COLORS, LIGHT_COLORS } from '../../src/theme/colors';
import { CourseItem, GradeItem } from '../../src/types/models';

export function runV2FeatureTests(allPluginSources: string): void {
  console.log('8d) Testing v2.0.0 P0–P3 features (holiday-aware calendar/alarms, Ed25519 OTA, Dark Mode, multi-term archive, DDL, transcript export, backup, deep links, remote calendar, buildings, modular arch)...');

  // --- P0.1: Holiday & Makeup unification across Calendar, ICS, and Wakeup Alarms ---
  const springSettings = {
    ...createDefaultSettings(new Date(2026, 3, 1)),
    termStartDate: '2026-03-02', // Week 1 Mon = 2026-03-02 -> Week 9 Fri = 2026-05-01 (May Day holiday!), Week 10 Sat = 2026-05-09 (makeup -> Tue!)
    totalWeeks: 20,
    calendarOverrides: [],
  };
  const friCourse: CourseItem = {
    id: 'c-fri-1',
    name: '海洋气象学',
    code: 'MET101',
    teacher: '陈老师',
    location: '钟海楼03012',
    campus: '湖光校区',
    dayOfWeek: 5, // Friday
    startSection: 1,
    endSection: 2,
    weeks: [8, 9, 10],
    weekText: '8-10周',
    credit: '2',
    classGroup: '大气1241',
    colorIndex: 0,
  };
  const tueCourse: CourseItem = {
    id: 'c-tue-1',
    name: '物理海洋学',
    code: 'OCN201',
    teacher: '林老师',
    location: '主楼305',
    campus: '湖光校区',
    dayOfWeek: 2, // Tuesday
    startSection: 3,
    endSection: 4,
    weeks: [9, 10],
    weekText: '9-10周',
    credit: '3',
    classGroup: '海科1241',
    colorIndex: 1,
  };

  const friOccs = getEffectiveCourseWallClockOccurrences(friCourse, springSettings);
  assert.ok(
    !friOccs.some((o) => o.dateStr === '2026-05-01'),
    'P0.1: May Day holiday 2026-05-01 must be skipped by effective course occurrences'
  );
  assert.ok(
    friOccs.some((o) => o.dateStr === '2026-04-24') && friOccs.some((o) => o.dateStr === '2026-05-08'),
    'P0.1: Non-holiday Fridays must remain scheduled'
  );

  const tueOccs = getEffectiveCourseWallClockOccurrences(tueCourse, springSettings);
  const makeupSat = tueOccs.find((o) => o.dateStr === '2026-05-09');
  assert.ok(
    makeupSat && makeupSat.isMakeup,
    'P0.1: Makeup Saturday 2026-05-09 (mapped to Tue) must appear in effective occurrences'
  );

  const icsWithHoliday = buildGdouIcsContent([friCourse, tueCourse], [], springSettings, '2025-2026 第2学期');
  assert.ok(!icsWithHoliday.includes('20260501T'), 'P0.1: .ics must NOT emit VEVENT on May Day holiday 2026-05-01');
  assert.ok(icsWithHoliday.includes('20260509T'), 'P0.1: .ics MUST emit shifted makeup VEVENT on 2026-05-09');
  assert.ok(icsWithHoliday.includes('[调休] 物理海洋学'), 'P0.1: .ics makeup event should carry [调休] prefix');

  const week9Wakeups = getEffectiveFirstClassPerDayInWeek([friCourse, tueCourse], 9, springSettings);
  assert.ok(
    !week9Wakeups.some((w) => w.dayOfWeek === 5),
    'P0.1: Week 9 wakeup alarms must skip May Day holiday (Fri 2026-05-01)'
  );
  const week10Wakeups = getEffectiveFirstClassPerDayInWeek([friCourse, tueCourse], 10, springSettings);
  assert.ok(
    week10Wakeups.some((w) => w.dayOfWeek === 6 && w.resolved.isMakeup && w.course.id === 'c-tue-1'),
    'P0.1: Week 10 wakeup alarms must include Saturday 2026-05-09 makeup Tuesday class'
  );

  // --- P0.2: Pure-TS RFC 8032 Ed25519 OTA signing verification & campus mirrors ---
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const testPubHex = Array.from(pubDer.slice(pubDer.length - 32))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  assert.equal(OTA_ED25519_PUBLIC_KEY_HEX.length, 64, 'Embedded Ed25519 public key must be 32-byte hex');
  const sampleManifest = {
    version: '2.0.0',
    minNativeRuntimeVersion: 4,
    iosSha256: '1'.repeat(64),
    iosSize: 3100000,
    androidSha256: '2'.repeat(64),
    androidSize: 2700000,
    iosIpaSha256: '3'.repeat(64),
    iosIpaSize: 12400000,
    androidApkSha256: '4'.repeat(64),
    androidApkSize: 21000000,
    signatureAlg: 'ed25519',
    signature: '',
  };
  const canonical = buildCanonicalOtaManifestPayload(sampleManifest);
  sampleManifest.signature = crypto
    .sign(null, new TextEncoder().encode(canonical), privateKey)
    .toString('hex');

  const validSig = verifyOtaManifestSignature(sampleManifest, testPubHex);
  assert.equal(validSig.valid, true, 'P0.2: Valid Ed25519 OTA manifest signature must pass');
  const tamperedSig = verifyOtaManifestSignature({ ...sampleManifest, iosSha256: 'f'.repeat(64) }, testPubHex);
  assert.equal(tamperedSig.valid, false, 'P0.2: Tampered SHA-256 must fail Ed25519 verification');
  const missingSig = verifyOtaManifestSignature({ ...sampleManifest, signature: undefined }, testPubHex);
  assert.equal(missingSig.valid, false, 'P0.2: Unsigned manifest must report valid=false');

  const mirrors = buildCampusMirrorDownloadUrls('https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/v2.0.0/test.jsbundle');
  assert.ok(mirrors.length >= 2 && mirrors.every((u) => u.startsWith('https://')), 'P0.2: Campus mirrors must produce HTTPS fallback URLs');

  // --- P0.3 & P0.4: CI Workflows ---
  const tfYml = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'ios-testflight.yml'), 'utf8');
  assert.ok(
    tfYml.includes('IOS_WIDGET_PROVISION_PROFILE_BASE64') && tfYml.includes('${EXPO_IOS_BUNDLE_ID}.widget'),
    'P0.3: ios-testflight.yml must configure separate Widget Extension provisioning profile'
  );
  const buildYml = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'build-mobile.yml'), 'utf8');
  assert.ok(
    buildYml.includes('publish-github-release') &&
      buildYml.includes('sign-ota-manifest.mjs') &&
      buildYml.includes('testDebugUnitTest') &&
      buildYml.includes('npm run lint'),
    'P0.4: build-mobile.yml must run lint, JUnit tests, Ed25519 manifest signing, and tag auto-release'
  );

  // --- P1.1: Dark Mode ---
  assert.notEqual(DARK_COLORS.bg, LIGHT_COLORS.bg, 'P1.1: Dark and Light background tokens must differ');
  assert.equal(COURSE_PALETTE_DARK.length, 10, 'P1.1: Dark course palette must have 10 swatches');
  const appJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'app.json'), 'utf8'));
  assert.equal(appJson.expo.userInterfaceStyle, 'automatic', 'P1.1: app.json must enable automatic userInterfaceStyle');
  assert.equal(appJson.expo.scheme, 'gdouschedule', 'P2.1: app.json must declare gdouschedule URL scheme');

  // --- P1.2 & P1.3: Multi-Term Archive & Custom Course Editing / DDL preservation ---
  const initData = createInitialAppData(new Date(2026, 3, 1));
  const customizedFri: CourseItem = {
    ...friCourse,
    customNote: '期末闭卷，考前划重点',
    customLocation: '钟海楼04008',
    customColorIndex: 5,
    todos: [
      {
        id: 'todo-1',
        title: '气象数据分析实验报告',
        dueDate: '2026-05-15',
        dueTime: '22:00',
        completed: false,
        createdAtIso: '2026-04-20T00:00:00Z',
      },
    ],
  };
  const mergedAfterResync = mergeCourseCustomizations([customizedFri], [friCourse]);
  assert.equal(mergedAfterResync[0].customNote, '期末闭卷，考前划重点', 'P1.3: Re-sync must preserve user customNote');
  assert.equal(mergedAfterResync[0].customLocation, '钟海楼04008', 'P1.3: Re-sync must preserve customLocation');
  assert.equal(mergedAfterResync[0].customColorIndex, 5, 'P1.3: Re-sync must preserve customColorIndex');
  assert.equal(mergedAfterResync[0].todos?.length, 1, 'P1.3: Re-sync must preserve course DDL todos');

  const stateWithTermA = {
    ...initData,
    academicYear: '2025',
    semesterCode: '12',
    termLabel: '2025-2026学年 第2学期',
    courses: [customizedFri],
  };
  const archives = snapshotActiveTermToArchive(stateWithTermA);
  const keyA = buildTermArchiveKey('2025', '12');
  const keyB = buildTermArchiveKey('2026', '3');
  const stateWithTwoTerms = {
    ...stateWithTermA,
    academicYear: '2026',
    semesterCode: '3',
    termLabel: '2026-2027学年 第1学期',
    courses: [tueCourse],
    termArchives: {
      ...archives,
      [keyB]: {
        termKey: keyB,
        termLabel: '2026-2027学年 第1学期',
        academicYear: '2026',
        semesterCode: '3',
        termStartDate: '2026-08-31',
        courses: [tueCourse],
        exams: [],
        updatedAtIso: '2026-09-01T00:00:00Z',
      },
    },
  };
  const switchedBack = switchToArchivedTerm(stateWithTwoTerms, keyA);
  assert.equal(switchedBack.academicYear, '2025', 'P1.2: Switching archive must restore academicYear');
  assert.equal(switchedBack.courses[0].id, 'c-fri-1', 'P1.2: Switching archive must restore term courses');

  // --- P1.4: Sanitized Transcript Export ONLY (zero PII / zero GPA simulator) ---
  const sampleGrades: GradeItem[] = [
    {
      id: 'g-1',
      courseName: '高等数学A,上',
      courseCode: 'MATH101',
      academicYear: '2025-2026',
      semester: '1',
      termKey: '2025-2026 第1学期',
      credit: 5,
      scoreText: '92',
      numericScore: 92,
      gpa: 4.2,
      courseCategory: '必修课',
      examNature: '正常考试',
      teacher: '张教授',
      passed: true,
    },
  ];
  const gpaSum = computeGpaSummary(sampleGrades);
  const csv = buildSanitizedTranscriptCsv(sampleGrades, gpaSum);
  assert.ok(csv.startsWith('\uFEFF'), 'P1.4: CSV must include UTF-8 BOM for Excel');
  assert.ok(csv.includes('"高等数学A,上"'), 'P1.4: CSV must RFC 4180 quote commas cleanly');
  const txt = buildSanitizedTranscriptText(sampleGrades, gpaSum);
  assert.ok(txt.includes('脱敏成绩单汇总') && txt.includes('4.20'), 'P1.4: Text transcript must include GPA summary');

  // --- P1.5: Pure Local Zero-Credential Backup & Restore ---
  const backupEnvelope = buildZeroRetentionBackupEnvelope(stateWithTwoTerms);
  assert.deepEqual(findForbiddenCredentialKeys(backupEnvelope), [], 'P1.5: Backup envelope must contain zero credential keys');
  const rawWithInjectedCreds = JSON.stringify({
    ...backupEnvelope,
    data: { ...backupEnvelope.data, password: 'LEAKED_PASSWORD', cookie: 'JSESSIONID=bad' },
  });
  const restored = parseAndValidateBackupJson(rawWithInjectedCreds);
  assert.deepEqual(findForbiddenCredentialKeys(restored.data), [], 'P1.5: Backup import must sanitize out any injected credentials');
  assert.equal(restored.summary.archivedTermsCount, 2, 'P1.5: Backup restore must preserve multi-term archives');

  // --- P2.1, P2.2, P2.3: Native Deep Links, Weekly Widget, AppIntents, Remote Calendar, Buildings ---
  assert.ok(
    allPluginSources.includes('GdouWeeklyWidgetProvider') &&
      allPluginSources.includes('GdouWidgetRefreshReceiver') &&
      allPluginSources.includes('gdouschedule://schedule') &&
      allPluginSources.includes('gdouschedule://exams') &&
      allPluginSources.includes('GetTodayGdouScheduleIntent') &&
      allPluginSources.includes('RefreshGdouLiveActivityIntent') &&
      allPluginSources.includes('BGTaskScheduler') &&
      allPluginSources.includes('GdouNativeCoreRegistry') &&
      allPluginSources.includes('GdouNativeCoreModule'),
    'P2.1 & P3.2: Modular plugins and local Expo module must include 4x4 Weekly Widget, deep links, AppIntents, BGTaskScheduler, and GdouNativeCore'
  );

  const remoteCalRaw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'campus-calendar.json'), 'utf8'));
  const validatedCal = validateRemoteCalendarPayload(remoteCalRaw);
  assert.ok(validatedCal && validatedCal.overrides.length >= 25, 'P2.2: campus-calendar.json must validate cleanly with 2026-2027 overrides');
  if (validatedCal) {
    setDynamicCalendarPresets(validatedCal.overrides);
  }
  assert.ok(getDefaultTermStartDateForTerm('2026', '3') === '2026-08-31', 'P2.2: Term start date derivation must align');

  const zhlGuide = lookupGdouBuildingGuide('钟海楼03012', '湖光校区');
  assert.ok(zhlGuide && zhlGuide.name === '钟海楼', 'P2.3: Offline building guide must resolve 钟海楼');
  const yjGuide = lookupGdouBuildingGuide('海纳楼205', '阳江校区');
  assert.ok(yjGuide && yjGuide.campus === '阳江校区', 'P2.3: Offline building guide must resolve 阳江海纳楼');

  // --- P3.1: Verify monolith decomposition ---
  const entryPluginLines = fs.readFileSync(path.join(process.cwd(), 'plugins', 'withGdouZeroRetention.js'), 'utf8').split('\n').length;
  assert.ok(entryPluginLines < 60, `P3.1: Entry plugin withGdouZeroRetention.js should be thin orchestrator (<60 lines, got ${entryPluginLines})`);
  assert.ok(
    fs.existsSync(path.join(process.cwd(), 'plugins', 'native', 'android', 'test', 'GdouEphemeralCookieJarTest.kt')),
    'P3.3: Android native JUnit zero-retention test must exist'
  );
  assert.ok(
    fs.existsSync(path.join(process.cwd(), 'src', 'services', 'auth', 'httpClient.ts')) &&
      fs.existsSync(path.join(process.cwd(), 'src', 'services', 'auth', 'jwDataClient.ts')) &&
      fs.existsSync(path.join(process.cwd(), 'src', 'services', 'auth', 'webviewScripts.ts')),
    'P3.1: gdouAuth.ts must be modularized into src/services/auth/*'
  );

  console.log('   OK: All v2.0.0 P0–P3 verification checks passed.');
}
