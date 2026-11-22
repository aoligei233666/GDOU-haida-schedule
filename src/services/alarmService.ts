import * as IntentLauncher from 'expo-intent-launcher';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { DAY_FULL_LABELS, getActivePeriods } from '../constants/gdouTimetable';
import { AlarmRule, AppSettings, CourseItem, ExamItem } from '../types/models';
import { parseExamIsoLocal } from './examParser';
import {
  applyTimeToDate,
  getCourseTimeSpan,
  getDateForWeekAndDay,
  getFirstClassPerDayInWeek,
} from './scheduleParser';

export const ALARM_CHANNEL_ID = 'gdou-alarm-channel';

/**
 * Configure foreground notification behavior & Android high-priority alarm channel.
 */
export async function initializeAlarmEngine(): Promise<void> {
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
      name: '广海课表与考试闹钟',
      description: '高优先级课前提醒、每日首课起床闹钟及考试倒计时提醒',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 400, 200, 400, 200, 600],
      enableVibrate: true,
      bypassDnd: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

export async function ensureNotificationPermission(): Promise<void> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === 'granted') return;
  const req = await Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowSound: true,
      allowBadge: true,
    },
  });
  if (req.status !== 'granted') {
    throw new Error('未开启通知权限，请在系统设置中允许“广海课表”发送闹钟与提醒通知');
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

/**
 * Schedule an advance reminder alarm for a specific course in a specific week.
 */
export async function createClassAlarm(
  course: CourseItem,
  week: number,
  advanceMinutes: number,
  settings: AppSettings
): Promise<AlarmRule> {
  const periods = getActivePeriods(settings);
  const { startText } = getCourseTimeSpan(course, periods);
  const dayDate = getDateForWeekAndDay(settings.termStartDate, week, course.dayOfWeek);
  const classStart = applyTimeToDate(dayDate, startText);
  const triggerDate = new Date(classStart.getTime() - advanceMinutes * 60 * 1000);

  const title = `⏰ 上课提醒：${course.name}`;
  const body = `${advanceMinutes} 分钟后上课（${startText}）· 地点：${course.location} · 教师：${course.teacher}`;
  const notificationId = await scheduleLocalAlarmNotification(title, body, triggerDate);

  return {
    id: `alarm-cls-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
 * Smart Morning Wake-Up Generator:
 * Scans the selected week, finds the earliest class for each day, and schedules
 * a wake-up alarm `wakeupMinutesBefore` minutes prior to that first class.
 */
export async function createWeeklyMorningWakeupAlarms(
  courses: CourseItem[],
  week: number,
  wakeupMinutesBefore: number,
  settings: AppSettings
): Promise<{ created: AlarmRule[]; skippedPast: number }> {
  await ensureNotificationPermission();
  const periods = getActivePeriods(settings);
  const firstPerDay = getFirstClassPerDayInWeek(courses, week);
  const nowMs = Date.now();

  const created: AlarmRule[] = [];
  let skippedPast = 0;

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
    const notificationId = await scheduleLocalAlarmNotification(title, body, triggerDate);

    created.push({
      id: `alarm-wake-${week}-${dayOfWeek}-${Date.now()}`,
      kind: 'morning_wakeup',
      title,
      body,
      targetId: firstCourse.id,
      triggerIso: triggerDate.toISOString(),
      weekday: dayOfWeek,
      hour: triggerDate.getHours(),
      minute: triggerDate.getMinutes(),
      advanceMinutes: wakeupMinutesBefore,
      enabled: true,
      notificationId,
    });
  }

  return { created, skippedPast };
}

/**
 * Schedule dual exam alarms for each upcoming exam:
 * 1) Eve reminder at 20:00 the day before the exam
 * 2) Exam-day departure alarm `examAdvanceMinutes` (default 90 min) before exam start
 */
export async function createExamAlarms(
  exams: ExamItem[],
  settings: AppSettings
): Promise<{ created: AlarmRule[]; skipped: number }> {
  await ensureNotificationPermission();
  const advanceMin = settings.examAdvanceMinutes || 90;
  const nowMs = Date.now();
  const created: AlarmRule[] = [];
  let skipped = 0;

  for (const exam of exams) {
    if (!exam.startIso) {
      skipped++;
      continue;
    }
    const examStart = parseExamIsoLocal(exam.startIso);
    const seatInfo = exam.seatNumber ? ` · 座位 ${exam.seatNumber}` : '';

    // 1. Eve 20:00 reminder
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
      const title = `📝 明日考试提醒：${exam.courseName}`;
      const body = `明天 ${exam.startTimeText} 开考 · 考场：${exam.location}${seatInfo}，请带好学生证/身份证与文具`;
      const notificationId = await scheduleLocalAlarmNotification(title, body, eve);
      created.push({
        id: `alarm-exam-eve-${exam.id}-${Date.now()}`,
        kind: 'exam',
        title,
        body,
        targetId: exam.id,
        triggerIso: eve.toISOString(),
        weekday: eve.getDay() === 0 ? 7 : eve.getDay(),
        hour: eve.getHours(),
        minute: eve.getMinutes(),
        advanceMinutes: 24 * 60,
        enabled: true,
        notificationId,
      });
    }

    // 2. Pre-exam countdown alarm
    const preExam = new Date(examStart.getTime() - advanceMin * 60 * 1000);
    if (preExam.getTime() > nowMs + 5000) {
      const title = `🚨 考前出发闹钟：${exam.courseName}`;
      const body = `距离开考还有 ${advanceMin} 分钟（${exam.startTimeText}）· 考场：${exam.location}${seatInfo}`;
      const notificationId = await scheduleLocalAlarmNotification(title, body, preExam);
      created.push({
        id: `alarm-exam-pre-${exam.id}-${Date.now()}`,
        kind: 'exam',
        title,
        body,
        targetId: exam.id,
        triggerIso: preExam.toISOString(),
        weekday: preExam.getDay() === 0 ? 7 : preExam.getDay(),
        hour: preExam.getHours(),
        minute: preExam.getMinutes(),
        advanceMinutes: advanceMin,
        enabled: true,
        notificationId,
      });
    } else {
      skipped++;
    }
  }

  return { created, skipped };
}

export async function cancelScheduledAlarm(alarm: AlarmRule): Promise<void> {
  if (alarm.notificationId) {
    try {
      await Notifications.cancelScheduledNotificationAsync(alarm.notificationId);
    } catch {
      // Ignore if already fired or dismissed
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
