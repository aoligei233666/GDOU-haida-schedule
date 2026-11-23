import * as IntentLauncher from 'expo-intent-launcher';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { DAY_FULL_LABELS, getActivePeriods } from '../constants/gdouTimetable';
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
 * Cancels any existing OS notification for the same `(course.id, week)` before scheduling.
 */
export async function createClassAlarm(
  course: CourseItem,
  week: number,
  advanceMinutes: number,
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<AlarmRule> {
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

  const title = `⏰ 上课提醒：${course.name}`;
  const body = `${advanceMinutes} 分钟后上课（${startText}）· 地点：${course.location} · 教师：${course.teacher}`;
  const notificationId = await scheduleLocalAlarmNotification(title, body, triggerDate);

  return {
    id: `alarm-cls-${Date.now()}-${generateSecureHex(4)}`,
    dedupeKey,
    kind: 'class',
    title,
    body,
    targetId: course.id,
    triggerIso: triggerDate.toISOString(),
    weekday: course.dayOfWeek,
    hour: triggerDate.getHours(),
    minute: triggerDate.getMinutes(),
    advanceMinutes,
    enabled: true,
    notificationId,
  };
}

/**
 * Smart Morning Wake-Up Generator (idempotent transactional batch):
 * Cancels any pre-existing wakeup alarms for the same `(week, dayOfWeek)` before scheduling
 * so repeated taps update cleanly with zero duplicate OS notifications.
 */
export async function createWeeklyMorningWakeupAlarms(
  courses: CourseItem[],
  week: number,
  wakeupMinutesBefore: number,
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<{
  created: AlarmRule[];
  replacedCount: number;
  skippedPast: number;
  failed: number;
  exactAlarmHint?: string;
}> {
  if (!parseLocalDateStrict(settings.termStartDate)) {
    throw new Error(`开学基准日期无效（${settings.termStartDate}），请先在设置页修正`);
  }
  const { exactAlarmHint } = await ensureNotificationPermission();
  const periods = getActivePeriods(settings);
  const firstPerDay = getFirstClassPerDayInWeek(courses, week);
  const nowMs = Date.now();

  let skippedPast = 0;
  let replacedCount = 0;
  const tasks: {
    dayOfWeek: number;
    dedupeKey: string;
    firstCourse: CourseItem;
    triggerDate: Date;
    title: string;
    body: string;
  }[] = [];

  for (const [dayOfWeek, firstCourse] of firstPerDay.entries()) {
    const { startText } = getCourseTimeSpan(firstCourse, periods);
    const dayDate = getDateForWeekAndDay(settings.termStartDate, week, dayOfWeek);
    const classStart = applyTimeToDate(dayDate, startText);
    const triggerDate = new Date(classStart.getTime() - wakeupMinutesBefore * 60 * 1000);

    if (triggerDate.getTime() <= nowMs + 5000) {
      skippedPast++;
      continue;
    }

    const dayLabel = DAY_FULL_LABELS[dayOfWeek - 1] ?? `周${dayOfWeek}`;
    const title = `🌅 ${dayLabel}早起闹钟（首课 ${startText}）`;
    const body = `第 ${week} 周首节课：${firstCourse.name} · 教室 ${firstCourse.location}，距离上课还有 ${wakeupMinutesBefore} 分钟`;
    tasks.push({
      dayOfWeek,
      dedupeKey: buildWakeupAlarmDedupeKey(week, dayOfWeek),
      firstCourse,
      triggerDate,
      title,
      body,
    });
  }

  for (const t of tasks) {
    replacedCount += await cancelExistingByDedupeKey(existingAlarms, t.dedupeKey);
  }

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      const notificationId = await scheduleLocalAlarmNotification(t.title, t.body, t.triggerDate);
      const rule: AlarmRule = {
        id: `alarm-wake-${week}-${t.dayOfWeek}-${Date.now()}-${generateSecureHex(3)}`,
        dedupeKey: t.dedupeKey,
        kind: 'morning_wakeup',
        title: t.title,
        body: t.body,
        targetId: t.firstCourse.id,
        triggerIso: t.triggerDate.toISOString(),
        weekday: t.dayOfWeek,
        hour: t.triggerDate.getHours(),
        minute: t.triggerDate.getMinutes(),
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

  if (tasks.length > 0 && created.length === 0) {
    throw firstError instanceof Error ? firstError : new Error('系统闹钟通知注册失败');
  }

  return { created, replacedCount, skippedPast, failed, exactAlarmHint };
}

/**
 * Schedule dual exam alarms for each upcoming exam idempotently:
 * cancels any existing OS notifications for the same `(exam.id, eve|pre)` before rescheduling.
 */
export async function createExamAlarms(
  exams: ExamItem[],
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<{
  created: AlarmRule[];
  replacedCount: number;
  skipped: number;
  failed: number;
  exactAlarmHint?: string;
}> {
  const { exactAlarmHint } = await ensureNotificationPermission();
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

  for (const c of candidates) {
    replacedCount += await cancelExistingByDedupeKey(existingAlarms, c.dedupeKey);
  }

  const settled = await Promise.allSettled(
    candidates.map(async (c) => {
      const notificationId = await scheduleLocalAlarmNotification(c.title, c.body, c.triggerDate);
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

  if (candidates.length > 0 && created.length === 0) {
    await rollbackNotifications(scheduledIds);
    throw firstError instanceof Error ? firstError : new Error('系统考试闹钟注册失败');
  }

  return { created, replacedCount, skipped, failed, exactAlarmHint };
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

/**
 * Android Native Hardware Clock Integration (`android.intent.action.SET_ALARM`).
 * Writes directly into the phone's built-in Clock app so the alarm rings even
 * in Do-Not-Disturb mode or when the app is terminated.
 *
 * Android Calendar day constants: Sunday=1, Monday=2, ..., Saturday=7.
 */
export async function setNativeAndroidSystemClockAlarm(params: {
  hour: number;
  minute: number;
  message: string;
  isoWeekdays?: number[]; // 1=Mon .. 7=Sun
}): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }

  const extra: Record<string, unknown> = {
    'android.intent.extra.alarm.HOUR': params.hour,
    'android.intent.extra.alarm.MINUTES': params.minute,
    'android.intent.extra.alarm.MESSAGE': params.message,
    'android.intent.extra.alarm.SKIP_UI': false,
  };

  if (params.isoWeekdays && params.isoWeekdays.length > 0) {
    extra['android.intent.extra.alarm.DAYS'] = params.isoWeekdays.map((d) =>
      d === 7 ? 1 : d + 1
    );
  }

  await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
    extra,
  });
  return true;
}

export function formatHourMinute(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
