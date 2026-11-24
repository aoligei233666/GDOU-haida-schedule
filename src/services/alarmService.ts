import * as IntentLauncher from 'expo-intent-launcher';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { DAY_FULL_LABELS, DAY_LABELS, getActivePeriods } from '../constants/gdouTimetable';
import { AlarmRule, AppSettings, CourseItem, ExamItem } from '../types/models';
import {
  buildClassAlarmDedupeKey,
  buildExamAlarmDedupeKey,
  buildWakeupAlarmDedupeKey,
  mergeAlarmsIdempotently,
  resolveAlarmDedupeKey,
} from './alarmDedupe';
import { generateSecureHex } from './cryptoAes';
import { parseExamIsoLocal } from './examParser';
import {
  applyTimeToDate,
  getCourseTimeSpan,
  getDateForWeekAndDay,
  getFirstClassPerDayInWeek,
  isCourseSchedulable,
  parseLocalDateStrict,
} from './scheduleParser';

export {
  buildClassAlarmDedupeKey,
  buildExamAlarmDedupeKey,
  buildWakeupAlarmDedupeKey,
  mergeAlarmsIdempotently,
  resolveAlarmDedupeKey,
};

export const ALARM_CHANNEL_ID = 'gdou-alarm-channel';

/**
 * Configure foreground notification behavior & Android high-priority alarm channel.
 */
export async function initializeAlarmEngine(): Promise<void> {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
        name: '海大课表与考试闹钟',
        description: '高优先级课前提醒、每日首课起床闹钟及考试倒计时提醒',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
        vibrationPattern: [0, 400, 200, 400, 200, 600],
        enableVibrate: true,
        bypassDnd: true,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
  } catch (err) {
    console.warn('Alarm engine initialization warning:', err);
  }
}

export async function ensureNotificationPermission(): Promise<{ exactAlarmHint?: string }> {
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const req = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowSound: true,
        allowBadge: true,
      },
    });
    status = req.status;
  }
  if (status !== 'granted') {
    throw new Error('未开启通知权限，请在系统设置中允许“海大课表”发送闹钟与提醒通知');
  }

  // Android 12+ (API 31+): SCHEDULE_EXACT_ALARM may require manual approval in Alarms & Reminders settings
  if (Platform.OS === 'android' && Number(Platform.Version) >= 31) {
    return {
      exactAlarmHint:
        '提示：Android 12+ 若发现提醒延迟，请在系统“设置 -> 应用 -> 海大课表 -> 闹钟和提醒”中允许精确闹钟权限。',
    };
  }
  return {};
}

export async function openAndroidExactAlarmSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync('android.settings.REQUEST_SCHEDULE_EXACT_ALARM', {
      data: 'package:cn.edu.gdou.schedule',
    });
  } catch {
    await IntentLauncher.startActivityAsync(
      IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
      { data: 'package:cn.edu.gdou.schedule' }
    );
  }
}

async function scheduleLocalAlarmNotification(
  title: string,
  body: string,
  triggerDate: Date
): Promise<string> {
  await ensureNotificationPermission();
  if (triggerDate.getTime() <= Date.now() + 2000) {
    throw new Error('该提醒时间已过，请选择未来的周次或日期');
  }

  return Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      priority: Notifications.AndroidNotificationPriority.MAX,
      interruptionLevel: 'timeSensitive',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: triggerDate,
      channelId: Platform.OS === 'android' ? ALARM_CHANNEL_ID : undefined,
    },
  });
}

async function rollbackNotifications(notificationIds: string[]): Promise<void> {
  await Promise.allSettled(
    notificationIds.map((id) => Notifications.cancelScheduledNotificationAsync(id))
  );
}

async function cancelExistingByDedupeKey(
  existingAlarms: AlarmRule[] | undefined,
  dedupeKey: string
): Promise<number> {
  if (!existingAlarms || existingAlarms.length === 0) return 0;
  const matched = existingAlarms.filter((a) => resolveAlarmDedupeKey(a) === dedupeKey);
  for (const old of matched) {
    await cancelScheduledAlarm(old);
  }
  return matched.length;
}

/**
 * Idempotently schedule an advance reminder alarm for a specific course in a specific week.
 * - On Android: Directly writes/updates the native System Clock alarm (`AlarmClock.ACTION_SET_ALARM`)
 *   with `EXTRA_DAYS` and `EXTRA_SKIP_UI = true`, plus best-effort local notification backup.
 * - On iOS: Schedules a `timeSensitive` notification and supports 1-tap handoff to System Clock.
 */
export async function createClassAlarm(
  course: CourseItem,
  week: number,
  advanceMinutes: number,
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<AlarmRule & { systemClockWritten?: boolean }> {
  if (!isCourseSchedulable(course)) {
    throw new Error(`《${course.name}》缺少有效上课时间信息，无法设定闹钟`);
  }
  if (!parseLocalDateStrict(settings.termStartDate)) {
    throw new Error(`开学基准日期无效（${settings.termStartDate}），请先在设置页修正`);
  }

  const periods = getActivePeriods(settings);
  const { startText } = getCourseTimeSpan(course, periods);
  const dayDate = getDateForWeekAndDay(settings.termStartDate, week, course.dayOfWeek);
  const classStart = applyTimeToDate(dayDate, startText);
  const triggerDate = new Date(classStart.getTime() - advanceMinutes * 60 * 1000);
  const dedupeKey = buildClassAlarmDedupeKey(course.id, week);

  await cancelExistingByDedupeKey(existingAlarms, dedupeKey);

  const hour = triggerDate.getHours();
  const minute = triggerDate.getMinutes();
  const title = `⏰ 上课提醒：${course.name}`;
  const body = `${advanceMinutes} 分钟后上课（${startText}）· 地点：${course.location} · 教师：${course.teacher}`;

  let systemClockWritten = false;
  if (Platform.OS === 'android') {
    systemClockWritten = await setNativeAndroidSystemClockAlarm({
      hour,
      minute,
      message: `${course.name} (${course.location})`,
      isoWeekdays: [course.dayOfWeek],
      skipUi: true,
    });
  }

  let notificationId: string | undefined;
  try {
    notificationId = await scheduleLocalAlarmNotification(title, body, triggerDate);
  } catch (notifErr) {
    if (!systemClockWritten) {
      throw notifErr;
    }
  }

  return {
    id: `alarm-cls-${Date.now()}-${generateSecureHex(4)}`,
    dedupeKey,
    kind: 'class',
    title,
    body,
    targetId: course.id,
    triggerIso: triggerDate.toISOString(),
    weekday: course.dayOfWeek,
    hour,
    minute,
    advanceMinutes,
    enabled: true,
    notificationId,
    systemClockWritten,
  };
}

/**
 * Smart Morning Wake-Up Generator (directly writes to System Clock on Android):
 * - Groups weekdays sharing the exact same wake-up `HH:mm` into merged multi-day System Clock alarms
 *   so e.g. Mon/Wed/Fri 08:10 classes produce ONE clean `07:25 (周一、三、五)` System Clock alarm!
 * - Also maintains idempotent local notification backup for future occurrences in `week`.
 */
export async function createWeeklyMorningWakeupAlarms(
  courses: CourseItem[],
  week: number,
  wakeupMinutesBefore: number,
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<{
  created: AlarmRule[];
  systemClockGroupsCount: number;
  replacedCount: number;
  skippedPast: number;
  failed: number;
  exactAlarmHint?: string;
}> {
  if (!parseLocalDateStrict(settings.termStartDate)) {
    throw new Error(`开学基准日期无效（${settings.termStartDate}），请先在设置页修正`);
  }
  const periods = getActivePeriods(settings);
  const firstPerDay = getFirstClassPerDayInWeek(courses, week);
  const nowMs = Date.now();

  let exactAlarmHint: string | undefined;
  let canScheduleNotifications = false;
  try {
    const perm = await ensureNotificationPermission();
    exactAlarmHint = perm.exactAlarmHint;
    canScheduleNotifications = true;
  } catch (permErr) {
    if (Platform.OS !== 'android') {
      throw permErr;
    }
  }

  let skippedPast = 0;
  let replacedCount = 0;
  const tasks: {
    dayOfWeek: number;
    dedupeKey: string;
    firstCourse: CourseItem;
    startText: string;
    triggerDate: Date;
    hour: number;
    minute: number;
    isFutureInWeek: boolean;
    title: string;
    body: string;
  }[] = [];

  for (const [dayOfWeek, firstCourse] of firstPerDay.entries()) {
    const { startText } = getCourseTimeSpan(firstCourse, periods);
    const dayDate = getDateForWeekAndDay(settings.termStartDate, week, dayOfWeek);
    const classStart = applyTimeToDate(dayDate, startText);
    const triggerDate = new Date(classStart.getTime() - wakeupMinutesBefore * 60 * 1000);
    const isFutureInWeek = triggerDate.getTime() > nowMs + 5000;

    if (!isFutureInWeek && Platform.OS !== 'android') {
      skippedPast++;
      continue;
    }
    if (!isFutureInWeek) {
      skippedPast++;
    }

    const dayLabel = DAY_FULL_LABELS[dayOfWeek - 1] ?? `周${dayOfWeek}`;
    const title = `🌅 ${dayLabel}早起闹钟（首课 ${startText}）`;
    const body = `第 ${week} 周首节课：${firstCourse.name} · 教室 ${firstCourse.location}，距离上课还有 ${wakeupMinutesBefore} 分钟`;
    tasks.push({
      dayOfWeek,
      dedupeKey: buildWakeupAlarmDedupeKey(week, dayOfWeek),
      firstCourse,
      startText,
      triggerDate,
      hour: triggerDate.getHours(),
      minute: triggerDate.getMinutes(),
      isFutureInWeek,
      title,
      body,
    });
  }

  // Directly write merged weekday wake-up alarms into Android System Clock!
  let systemClockGroupsCount = 0;
  if (Platform.OS === 'android' && tasks.length > 0) {
    const byTimeKey = new Map<
      string,
      { hour: number; minute: number; startText: string; days: number[]; names: string[] }
    >();
    for (const t of tasks) {
      const key = `${t.hour}:${t.minute}`;
      const existing = byTimeKey.get(key);
      if (existing) {
        if (!existing.days.includes(t.dayOfWeek)) existing.days.push(t.dayOfWeek);
        if (!existing.names.includes(t.firstCourse.name)) existing.names.push(t.firstCourse.name);
      } else {
        byTimeKey.set(key, {
          hour: t.hour,
          minute: t.minute,
          startText: t.startText,
          days: [t.dayOfWeek],
          names: [t.firstCourse.name],
        });
      }
    }

    const batchSpecs: SystemClockAlarmSpec[] = Array.from(byTimeKey.values()).map((grp) => {
      const sortedDays = [...grp.days].sort((a, b) => a - b);
      const dayText = sortedDays.map((d) => DAY_LABELS[d - 1] ?? String(d)).join('/');
      return {
        hour: grp.hour,
        minute: grp.minute,
        isoWeekdays: sortedDays,
        message: `海大早起 · 周${dayText}首课${grp.startText}`,
        skipUi: true,
      };
    });

    const sysRes = await setSystemClockAlarmsBatch(batchSpecs);
    if (sysRes.ok) {
      systemClockGroupsCount = sysRes.writtenCount;
    } else if (!canScheduleNotifications) {
      throw new Error(sysRes.error || '写入手机系统闹钟失败，请检查系统时钟应用权限');
    }
  }

  for (const t of tasks) {
    replacedCount += await cancelExistingByDedupeKey(existingAlarms, t.dedupeKey);
  }

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      let notificationId: string | undefined;
      if (canScheduleNotifications && t.isFutureInWeek) {
        notificationId = await scheduleLocalAlarmNotification(t.title, t.body, t.triggerDate);
      } else if (Platform.OS !== 'android') {
        notificationId = await scheduleLocalAlarmNotification(t.title, t.body, t.triggerDate);
      }
      const rule: AlarmRule = {
        id: `alarm-wake-${week}-${t.dayOfWeek}-${Date.now()}-${generateSecureHex(3)}`,
        dedupeKey: t.dedupeKey,
        kind: 'morning_wakeup',
        title: t.title,
        body: t.body,
        targetId: t.firstCourse.id,
        triggerIso: t.triggerDate.toISOString(),
        weekday: t.dayOfWeek,
        hour: t.hour,
        minute: t.minute,
        advanceMinutes: wakeupMinutesBefore,
        enabled: true,
        notificationId,
      };
      return rule;
    })
  );

  const created: AlarmRule[] = [];
  let failed = 0;
  let firstError: unknown = null;
  for (const res of settled) {
    if (res.status === 'fulfilled') {
      created.push(res.value);
    } else {
      failed++;
      if (!firstError) firstError = res.reason;
    }
  }

  if (tasks.length > 0 && created.length === 0 && systemClockGroupsCount === 0) {
    throw firstError instanceof Error ? firstError : new Error('系统闹钟注册失败');
  }

  return {
    created,
    systemClockGroupsCount,
    replacedCount,
    skippedPast,
    failed,
    exactAlarmHint: systemClockGroupsCount > 0 ? undefined : exactAlarmHint,
  };
}

/**
 * Schedule exam alarms idempotently:
 * - On Android: Directly writes pre-exam departure alarms into the native System Clock (`ACTION_SET_ALARM`),
 *   plus schedules pre-exam & eve reminders.
 * - On iOS: Schedules `timeSensitive` notifications for both eve (20:00) and pre-exam departure.
 */
export async function createExamAlarms(
  exams: ExamItem[],
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<{
  created: AlarmRule[];
  systemClockGroupsCount: number;
  replacedCount: number;
  skipped: number;
  failed: number;
  exactAlarmHint?: string;
}> {
  let exactAlarmHint: string | undefined;
  let canScheduleNotifications = false;
  try {
    const perm = await ensureNotificationPermission();
    exactAlarmHint = perm.exactAlarmHint;
    canScheduleNotifications = true;
  } catch (permErr) {
    if (Platform.OS !== 'android') {
      throw permErr;
    }
  }

  const advanceMin = settings.examAdvanceMinutes || 90;
  const nowMs = Date.now();
  let skipped = 0;
  let replacedCount = 0;

  interface ExamAlarmCandidate {
    exam: ExamItem;
    suffix: 'eve' | 'pre';
    dedupeKey: string;
    triggerDate: Date;
    title: string;
    body: string;
    advanceMinutes: number;
  }

  const candidates: ExamAlarmCandidate[] = [];

  for (const exam of exams) {
    if (!exam.startIso) {
      skipped++;
      continue;
    }
    const examStart = parseExamIsoLocal(exam.startIso);
    const seatInfo = exam.seatNumber ? ` · 座位 ${exam.seatNumber}` : '';

    const eve = new Date(
      examStart.getFullYear(),
      examStart.getMonth(),
      examStart.getDate() - 1,
      20,
      0,
      0,
      0
    );
    if (eve.getTime() > nowMs + 5000) {
      candidates.push({
        exam,
        suffix: 'eve',
        dedupeKey: buildExamAlarmDedupeKey(exam.id, 'eve'),
        triggerDate: eve,
        title: `📝 明日考试提醒：${exam.courseName}`,
        body: `明天 ${exam.startTimeText} 开考 · 考场：${exam.location}${seatInfo}，请带好学生证/身份证与文具`,
        advanceMinutes: 24 * 60,
      });
    }

    const preExam = new Date(examStart.getTime() - advanceMin * 60 * 1000);
    if (preExam.getTime() > nowMs + 5000) {
      candidates.push({
        exam,
        suffix: 'pre',
        dedupeKey: buildExamAlarmDedupeKey(exam.id, 'pre'),
        triggerDate: preExam,
        title: `🚨 考前出发闹钟：${exam.courseName}`,
        body: `距离开考还有 ${advanceMin} 分钟（${exam.startTimeText}）· 考场：${exam.location}${seatInfo}`,
        advanceMinutes: advanceMin,
      });
    } else {
      skipped++;
    }
  }

  // Write pre-exam departure alarms directly to Android System Clock
  let systemClockGroupsCount = 0;
  if (Platform.OS === 'android') {
    const preCandidates = candidates.filter((c) => c.suffix === 'pre');
    if (preCandidates.length > 0) {
      const specs: SystemClockAlarmSpec[] = preCandidates.map((c) => {
        const dow = c.triggerDate.getDay() === 0 ? 7 : c.triggerDate.getDay();
        const isWithin7Days = c.triggerDate.getTime() - nowMs <= 7 * 24 * 3600 * 1000;
        return {
          hour: c.triggerDate.getHours(),
          minute: c.triggerDate.getMinutes(),
          isoWeekdays: isWithin7Days ? [dow] : undefined,
          message: `考试：${c.exam.courseName} (${c.exam.location}${
            c.exam.seatNumber ? ` 座位${c.exam.seatNumber}` : ''
          })`,
          skipUi: true,
        };
      });
      const sysRes = await setSystemClockAlarmsBatch(specs);
      if (sysRes.ok) {
        systemClockGroupsCount = sysRes.writtenCount;
      }
    }
  }

  for (const c of candidates) {
    replacedCount += await cancelExistingByDedupeKey(existingAlarms, c.dedupeKey);
  }

  const settled = await Promise.allSettled(
    candidates.map(async (c) => {
      let notificationId: string | undefined;
      if (canScheduleNotifications) {
        notificationId = await scheduleLocalAlarmNotification(c.title, c.body, c.triggerDate);
      } else if (Platform.OS !== 'android') {
        notificationId = await scheduleLocalAlarmNotification(c.title, c.body, c.triggerDate);
      }
      const rule: AlarmRule = {
        id: `alarm-exam-${c.suffix}-${c.exam.id}-${Date.now()}-${generateSecureHex(3)}`,
        dedupeKey: c.dedupeKey,
        kind: 'exam',
        title: c.title,
        body: c.body,
        targetId: c.exam.id,
        triggerIso: c.triggerDate.toISOString(),
        weekday: c.triggerDate.getDay() === 0 ? 7 : c.triggerDate.getDay(),
        hour: c.triggerDate.getHours(),
        minute: c.triggerDate.getMinutes(),
        advanceMinutes: c.advanceMinutes,
        enabled: true,
        notificationId,
      };
      return rule;
    })
  );

  const created: AlarmRule[] = [];
  const scheduledIds: string[] = [];
  let failed = 0;
  let firstError: unknown = null;

  for (const res of settled) {
    if (res.status === 'fulfilled') {
      created.push(res.value);
      if (res.value.notificationId) scheduledIds.push(res.value.notificationId);
    } else {
      failed++;
      if (!firstError) firstError = res.reason;
    }
  }

  if (candidates.length > 0 && created.length === 0 && systemClockGroupsCount === 0) {
    await rollbackNotifications(scheduledIds);
    throw firstError instanceof Error ? firstError : new Error('系统考试闹钟注册失败');
  }

  return {
    created,
    systemClockGroupsCount,
    replacedCount,
    skipped,
    failed,
    exactAlarmHint: systemClockGroupsCount > 0 ? undefined : exactAlarmHint,
  };
}

export async function cancelScheduledAlarm(alarm: AlarmRule): Promise<void> {
  if (alarm.notificationId) {
    try {
      await Notifications.cancelScheduledNotificationAsync(alarm.notificationId);
    } catch (err) {
      console.warn('Cancel scheduled alarm warning:', err);
    }
  }
}

export async function toggleAlarmEnabled(alarm: AlarmRule, enable: boolean): Promise<AlarmRule> {
  if (!enable) {
    await cancelScheduledAlarm(alarm);
    return { ...alarm, enabled: false, notificationId: undefined };
  }
  const triggerDate = new Date(alarm.triggerIso);
  const notificationId = await scheduleLocalAlarmNotification(
    alarm.title,
    alarm.body,
    triggerDate
  );
  return { ...alarm, enabled: true, notificationId };
}

export async function cancelAllScheduledAlarms(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

export interface SystemClockAlarmSpec {
  hour: number;
  minute: number;
  message: string;
  isoWeekdays?: number[]; // 1=Mon .. 7=Sun
  skipUi?: boolean;
}

/**
 * Batch-write alarms directly into the Android native System Clock (`AlarmClock.ACTION_SET_ALARM`)
 * via our `MainApplication.kt` native bridge (with genuine `ArrayList<Integer>` `EXTRA_DAYS` and
 * `EXTRA_SKIP_UI`), falling back to `IntentLauncher` if running outside custom native build.
 */
export async function setSystemClockAlarmsBatch(
  specs: SystemClockAlarmSpec[]
): Promise<{ ok: boolean; writtenCount: number; error?: string }> {
  if (Platform.OS !== 'android' || specs.length === 0) {
    return { ok: false, writtenCount: 0 };
  }

  const alarmsPayload = specs.map((s) => ({
    hour: s.hour,
    minute: s.minute,
    message: s.message,
    skipUi: s.skipUi !== false,
    vibrate: true,
    days:
      s.isoWeekdays && s.isoWeekdays.length > 0
        ? s.isoWeekdays.map((d) => (d === 7 ? 1 : d + 1))
        : [],
  }));

  try {
    const resp = await fetch('https://gdou-alarm-internal.local/set-system-alarms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alarms: alarmsPayload }),
    });
    if (resp.ok) {
      const json = (await resp.json()) as { ok?: boolean; count?: number; error?: string };
      if (json.ok && (json.count ?? 0) > 0) {
        return { ok: true, writtenCount: json.count ?? specs.length };
      }
      if (json.error) {
        return { ok: false, writtenCount: 0, error: json.error };
      }
    }
  } catch {
    // Fallback to IntentLauncher for first item below
  }

  try {
    const first = specs[0];
    await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
      extra: {
        'android.intent.extra.alarm.HOUR': first.hour,
        'android.intent.extra.alarm.MINUTES': first.minute,
        'android.intent.extra.alarm.MESSAGE': first.message,
        'android.intent.extra.alarm.SKIP_UI': first.skipUi !== false,
      },
    });
    return { ok: true, writtenCount: 1 };
  } catch (err) {
    return {
      ok: false,
      writtenCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Android Native Hardware Clock Integration (`android.intent.action.SET_ALARM`).
 * Writes directly into the phone's built-in Clock app so the alarm rings even
 * in Do-Not-Disturb mode or when the app is terminated.
 */
export async function setNativeAndroidSystemClockAlarm(params: {
  hour: number;
  minute: number;
  message: string;
  isoWeekdays?: number[]; // 1=Mon .. 7=Sun
  skipUi?: boolean;
}): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }
  const res = await setSystemClockAlarmsBatch([
    {
      hour: params.hour,
      minute: params.minute,
      message: params.message,
      isoWeekdays: params.isoWeekdays,
      skipUi: params.skipUi ?? true,
    },
  ]);
  return res.ok;
}

/**
 * Open the phone's native System Clock Alarms screen directly:
 * - Android: `AlarmClock.ACTION_SHOW_ALARMS`
 * - iOS: `clock-alarm://` (built-in Apple Clock app Alarm tab)
 */
export async function openNativeSystemClockApp(): Promise<boolean> {
  if (Platform.OS === 'android') {
    try {
      const resp = await fetch('https://gdou-alarm-internal.local/show-alarms', {
        method: 'POST',
      });
      if (resp.ok) {
        const json = (await resp.json()) as { ok?: boolean };
        if (json.ok) return true;
      }
    } catch {
      // Fallback below
    }
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.SHOW_ALARMS');
      return true;
    } catch {
      return false;
    }
  }

  if (Platform.OS === 'ios') {
    try {
      await Linking.openURL('clock-alarm://');
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export function formatHourMinute(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
