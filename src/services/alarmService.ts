import * as IntentLauncher from 'expo-intent-launcher';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { DAY_FULL_LABELS, DAY_LABELS, getActivePeriods } from '../constants/gdouTimetable';
import { AlarmRule, AlarmSystemEngine, AppSettings, CourseItem, ExamItem } from '../types/models';
import {
  getEffectiveFirstClassPerDayInWeek,
  resolveEffectiveScheduleDate,
} from './academicCalendar';
import {
  buildClassAlarmDedupeKey,
  buildExamAlarmDedupeKey,
  buildWakeupAlarmDedupeKey,
  mergeAlarmsIdempotently,
  resolveAlarmDedupeKey,
} from './alarmDedupe';
import { generateSecureHex } from './cryptoAes';
import { parseExamIsoLocal } from './examParser';
import { invokeNativeBridge } from './gdouNativeBridge';
import {
  applyTimeToDate,
  getCourseTimeSpan,
  getDateForWeekAndDay,
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

export interface SystemAlarmCapabilities {
  platform: string;
  engine: AlarmSystemEngine;
  supported: boolean;
  authStatus: 'authorized' | 'denied' | 'notDetermined' | 'unsupported' | 'unknown';
  osVersion?: string;
}

export interface SystemClockAlarmSpec {
  id?: string;
  dedupeKey?: string;
  hour: number;
  minute: number;
  message: string;
  isoWeekdays?: number[]; // 1=Mon .. 7=Sun
  triggerEpochMs?: number;
  mode?: 'relative' | 'fixed';
  skipUi?: boolean;
}

export interface SystemClockBatchResult {
  ok: boolean;
  writtenCount: number;
  engine?: AlarmSystemEngine;
  supported?: boolean;
  authStatus?: string;
  alarmIds?: string[];
  scheduled?: Array<{ id: string; dedupeKey: string }>;
  error?: string;
}

function isoWeekdayToCalendarDay(isoDay: number): number {
  // ISO 1=Mon..7=Sun -> Java/Apple Calendar 1=Sun, 2=Mon..7=Sat
  return isoDay === 7 ? 1 : isoDay + 1;
}

const ALARM_PATH_TO_ACTION: Record<string, string> = {
  '/alarm-capabilities': 'alarm/capabilities',
  '/set-system-alarms': 'alarm/set',
  '/cancel-system-alarms': 'alarm/cancel',
  '/clear-system-alarms': 'alarm/clear',
  '/show-alarms': 'alarm/show',
};

async function fetchAlarmBridge(
  path: string,
  options?: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }
): Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }> {
  const action = ALARM_PATH_TO_ACTION[path] || `alarm${path}`;
  const res = await invokeNativeBridge({
    action,
    payload: options?.body,
    legacyUrl: `https://gdou-alarm-internal.local${path}`,
    legacyMethod: options?.method ?? 'POST',
    timeoutMs: options?.timeoutMs ?? 12_000,
  });
  return {
    ok: res.ok || typeof res.engine === 'string' || typeof res.supported === 'boolean',
    json: async () => res,
  };
}

export async function openAppSystemSettings(): Promise<boolean> {
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}

export async function getSystemAlarmCapabilities(): Promise<SystemAlarmCapabilities> {
  if (Platform.OS === 'android') {
    return {
      platform: 'android',
      engine: 'android_clock',
      supported: true,
      authStatus: 'authorized',
    };
  }
  if (Platform.OS === 'ios') {
    try {
      const resp = await fetchAlarmBridge('/alarm-capabilities', { method: 'GET', timeoutMs: 5000 });
      if (resp.ok) {
        const json = (await resp.json()) as {
          engine?: string;
          supported?: boolean;
          authStatus?: string;
          osVersion?: string;
        };
        const isAlarmKit = json.supported === true && json.engine === 'alarmkit';
        const authStatus =
          json.authStatus === 'authorized' ||
          json.authStatus === 'denied' ||
          json.authStatus === 'notDetermined' ||
          json.authStatus === 'unsupported'
            ? json.authStatus
            : 'unknown';
        return {
          platform: 'ios',
          engine: isAlarmKit ? 'ios_alarmkit' : 'notification',
          supported: isAlarmKit,
          authStatus,
          osVersion: json.osVersion,
        };
      }
    } catch {
      // Fallback below
    }
    return {
      platform: 'ios',
      engine: 'notification',
      supported: false,
      authStatus: 'unsupported',
    };
  }
  return {
    platform: Platform.OS,
    engine: 'notification',
    supported: false,
    authStatus: 'unsupported',
  };
}

export async function cancelSystemAlarmsByIds(ids: string[]): Promise<number> {
  const validIds = ids.map((s) => String(s || '').trim()).filter(Boolean);
  if (Platform.OS !== 'ios' || validIds.length === 0) return 0;
  try {
    const resp = await fetchAlarmBridge('/cancel-system-alarms', {
      method: 'POST',
      body: { ids: validIds },
      timeoutMs: 6000,
    });
    if (resp.ok) {
      const json = (await resp.json()) as { cancelledCount?: number };
      return json.cancelledCount ?? 0;
    }
  } catch {
    // Best-effort cancellation
  }
  return 0;
}

export async function clearAllSystemAlarms(): Promise<number> {
  if (Platform.OS !== 'ios') return 0;
  try {
    const resp = await fetchAlarmBridge('/clear-system-alarms', {
      method: 'POST',
      body: {},
      timeoutMs: 6000,
    });
    if (resp.ok) {
      const json = (await resp.json()) as { cancelledCount?: number };
      return json.cancelledCount ?? 0;
    }
  } catch {
    // Best-effort clear
  }
  return 0;
}

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
  triggerDate: Date,
  options?: { weeklyIsoWeekday?: number; hour?: number; minute?: number }
): Promise<string> {
  await ensureNotificationPermission();

  const useWeekly =
    typeof options?.weeklyIsoWeekday === 'number' &&
    typeof options?.hour === 'number' &&
    typeof options?.minute === 'number';

  if (!useWeekly && triggerDate.getTime() <= Date.now() + 2000) {
    throw new Error('该提醒时间已过，请选择未来的周次或日期');
  }

  const trigger: Notifications.NotificationTriggerInput = useWeekly
    ? {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: isoWeekdayToCalendarDay(options!.weeklyIsoWeekday!),
        hour: options!.hour!,
        minute: options!.minute!,
        ...(Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : {}),
      }
    : {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
        ...(Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : {}),
      };

  const primaryContent: Notifications.NotificationContentInput =
    Platform.OS === 'ios'
      ? {
          title,
          body,
          sound: 'defaultRingtone',
          interruptionLevel: 'timeSensitive',
        }
      : {
          title,
          body,
          sound: 'default',
          priority: Notifications.AndroidNotificationPriority.MAX,
        };

  try {
    return await Notifications.scheduleNotificationAsync({
      content: primaryContent,
      trigger,
    });
  } catch (primaryErr) {
    if (Platform.OS === 'ios') {
      // Safe fallback for sideloaded profiles without time-sensitive entitlement or custom ringtone quirks
      return await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          interruptionLevel: 'active',
        },
        trigger,
      });
    }
    throw primaryErr;
  }
}

async function rollbackNotifications(notificationIds: string[]): Promise<void> {
  await Promise.allSettled(
    notificationIds.map((id) => Notifications.cancelScheduledNotificationAsync(id))
  );
}

async function cancelExistingByDedupeKey(
  existingAlarms: AlarmRule[] | undefined,
  dedupeKey: string
): Promise<{ count: number; cancelledSystemIds: string[] }> {
  if (!existingAlarms || existingAlarms.length === 0) {
    return { count: 0, cancelledSystemIds: [] };
  }
  const matched = existingAlarms.filter((a) => resolveAlarmDedupeKey(a) === dedupeKey);
  const cancelledSystemIds: string[] = [];
  for (const old of matched) {
    if (old.systemAlarmId) cancelledSystemIds.push(old.systemAlarmId);
    await cancelScheduledAlarm(old);
  }
  return { count: matched.length, cancelledSystemIds };
}

/**
 * Idempotently schedule an advance reminder alarm for a specific course in a specific week.
 * - Android: Directly writes/updates the native System Clock alarm (`AlarmClock.ACTION_SET_ALARM`)
 *   with `EXTRA_DAYS` and `EXTRA_SKIP_UI = true`, plus best-effort local notification backup.
 * - iOS 26+: Directly writes a native iOS System Alarm via `AlarmKit` (breaks Silent/Focus modes,
 *   full-screen lock screen alarm UI).
 * - iOS < 26 (or fallback): Schedules an iOS `defaultRingtone` notification (exact date or weekly repeat).
 */
export async function createClassAlarm(
  course: CourseItem,
  week: number,
  advanceMinutes: number,
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<AlarmRule & { systemClockWritten?: boolean; fallbackReason?: string }> {
  if (!isCourseSchedulable(course)) {
    throw new Error(`《${course.name}》缺少有效上课时间信息，无法设定闹钟`);
  }
  if (!parseLocalDateStrict(settings.termStartDate)) {
    throw new Error(`开学基准日期无效（${settings.termStartDate}），请先在设置页修正`);
  }

  const periods = getActivePeriods(settings);
  const { startText } = getCourseTimeSpan(course, periods);
  let targetDayOfWeek = course.dayOfWeek;
  let dayDate = getDateForWeekAndDay(settings.termStartDate, week, course.dayOfWeek);
  const resolvedNatural = resolveEffectiveScheduleDate(
    dayDate,
    settings.termStartDate,
    settings.totalWeeks,
    settings.calendarOverrides
  );
  if (resolvedNatural.isHoliday) {
    // Check if there is a makeup day in the same week mapped to this course's weekday
    let foundMakeupDay: { colDay: number; date: Date } | null = null;
    for (let d = 1; d <= 7; d++) {
      const candidateDate = getDateForWeekAndDay(settings.termStartDate, week, d);
      const candidateRes = resolveEffectiveScheduleDate(
        candidateDate,
        settings.termStartDate,
        settings.totalWeeks,
        settings.calendarOverrides
      );
      if (candidateRes.isMakeup && candidateRes.effectiveDayOfWeek === course.dayOfWeek) {
        foundMakeupDay = { colDay: d, date: candidateDate };
        break;
      }
    }
    if (foundMakeupDay) {
      targetDayOfWeek = foundMakeupDay.colDay;
      dayDate = foundMakeupDay.date;
    } else {
      throw new Error(
        `第 ${week} 周周${DAY_LABELS[course.dayOfWeek - 1] ?? course.dayOfWeek} 为「${
          resolvedNatural.override?.label || '法定节假日'
        }」停课，无需设置上课闹钟`
      );
    }
  }
  const effectiveLocation = course.customLocation?.trim() || course.location;
  const classStart = applyTimeToDate(dayDate, startText);
  const triggerDate = new Date(classStart.getTime() - advanceMinutes * 60 * 1000);
  const isFuture = triggerDate.getTime() > Date.now() + 2000;
  const dedupeKey = buildClassAlarmDedupeKey(course.id, week);

  const { cancelledSystemIds } = await cancelExistingByDedupeKey(existingAlarms, dedupeKey);

  const hour = triggerDate.getHours();
  const minute = triggerDate.getMinutes();
  const title = `⏰ 上课提醒：${course.name}`;
  const body = `${advanceMinutes} 分钟后上课（${startText}）· 地点：${effectiveLocation} · 教师：${course.teacher}`;

  let systemClockWritten = false;
  let systemAlarmId: string | undefined;
  let systemEngine: AlarmSystemEngine = 'notification';
  let fallbackReason: string | undefined;

  if (Platform.OS === 'android') {
    systemClockWritten = await setNativeAndroidSystemClockAlarm({
      hour,
      minute,
      message: `${course.name} (${effectiveLocation})`,
      isoWeekdays: [targetDayOfWeek],
      skipUi: true,
    });
    if (systemClockWritten) {
      systemEngine = 'android_clock';
    }
  } else if (Platform.OS === 'ios') {
    const sysRes = await setSystemClockAlarmsBatch(
      [
        {
          dedupeKey,
          hour,
          minute,
          message: `上课：${course.name} (${effectiveLocation})`,
          mode: isFuture ? 'fixed' : 'relative',
          triggerEpochMs: triggerDate.getTime(),
          isoWeekdays: isFuture ? undefined : [targetDayOfWeek],
        },
      ],
      cancelledSystemIds
    );
    if (sysRes.ok && sysRes.engine === 'ios_alarmkit') {
      systemClockWritten = true;
      systemEngine = 'ios_alarmkit';
      systemAlarmId = sysRes.alarmIds?.[0];
    } else if (sysRes.authStatus === 'denied') {
      throw new Error(
        sysRes.error || '未开启 iOS 系统闹钟权限，请在系统「设置 -> 海大课表 -> 闹钟」中允许后重试'
      );
    } else if (sysRes.error) {
      fallbackReason = sysRes.error;
    }
  }

  let notificationId: string | undefined;
  if (systemEngine !== 'ios_alarmkit') {
    try {
      notificationId = await scheduleLocalAlarmNotification(
        title,
        body,
        triggerDate,
        !isFuture
          ? { weeklyIsoWeekday: course.dayOfWeek, hour, minute }
          : undefined
      );
    } catch (notifErr) {
      if (!systemClockWritten) {
        throw notifErr;
      }
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
    systemAlarmId,
    systemEngine,
    repeatsWeekly: !isFuture,
    systemClockWritten,
    fallbackReason,
  };
}

/**
 * Smart Morning Wake-Up Generator:
 * - Android: Groups weekdays sharing the exact same wake-up `HH:mm` into merged multi-day
 *   System Clock alarms (`AlarmClock.ACTION_SET_ALARM` with `EXTRA_DAYS`).
 * - iOS 26+: Directly writes per-weekday repeating native iOS System Alarms via `AlarmKit`
 *   (so each weekday can be individually toggled/deleted inside the app while breaking Silent/Focus).
 * - iOS < 26 (or fallback): Schedules weekly repeating `defaultRingtone` notifications for every class day.
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
  systemEngine: AlarmSystemEngine;
  replacedCount: number;
  skippedPast: number;
  failed: number;
  exactAlarmHint?: string;
  fallbackReason?: string;
}> {
  if (!parseLocalDateStrict(settings.termStartDate)) {
    throw new Error(`开学基准日期无效（${settings.termStartDate}），请先在设置页修正`);
  }
  const periods = getActivePeriods(settings);
  const effectiveFirstPerDay = getEffectiveFirstClassPerDayInWeek(courses, week, settings);
  const nowMs = Date.now();

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

  for (const entry of effectiveFirstPerDay) {
    const { dayOfWeek, date: dayDate, course: firstCourse, resolved } = entry;
    const { startText } = getCourseTimeSpan(firstCourse, periods);
    const effectiveLocation = firstCourse.customLocation?.trim() || firstCourse.location;
    const classStart = applyTimeToDate(dayDate, startText);
    const triggerDate = new Date(classStart.getTime() - wakeupMinutesBefore * 60 * 1000);
    const isFutureInWeek = triggerDate.getTime() > nowMs + 5000;
    if (!isFutureInWeek) {
      skippedPast++;
    }

    const dayLabel = DAY_FULL_LABELS[dayOfWeek - 1] ?? `周${dayOfWeek}`;
    const makeupTag = resolved.isMakeup ? `·${resolved.badgeText || '调休补课'}` : '';
    const title = `🌅 ${dayLabel}早起闹钟${makeupTag}（首课 ${startText}）`;
    const body = `第 ${week} 周首节课：${firstCourse.name} · 教室 ${effectiveLocation}，距离上课还有 ${wakeupMinutesBefore} 分钟`;
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

  if (tasks.length === 0) {
    return {
      created: [],
      systemClockGroupsCount: 0,
      systemEngine: Platform.OS === 'android' ? 'android_clock' : 'notification',
      replacedCount: 0,
      skippedPast: 0,
      failed: 0,
    };
  }

  // Cancel any existing alarms for these dedupeKeys before creating fresh ones
  const cancelledSystemIds: string[] = [];
  for (const t of tasks) {
    const res = await cancelExistingByDedupeKey(existingAlarms, t.dedupeKey);
    replacedCount += res.count;
    cancelledSystemIds.push(...res.cancelledSystemIds);
  }

  let systemClockGroupsCount = 0;
  let systemEngine: AlarmSystemEngine = 'notification';
  let fallbackReason: string | undefined;
  const iosSystemIdByDedupeKey = new Map<string, string>();

  if (Platform.OS === 'android') {
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
      systemEngine = 'android_clock';
    } else {
      fallbackReason = sysRes.error;
    }
  } else if (Platform.OS === 'ios') {
    // Schedule 1 dedicated repeating AlarmKit system alarm per class weekday so each row in AlarmsScreen
    // can be toggled or deleted independently while still breaking Silent & Focus modes!
    const iosSpecs: SystemClockAlarmSpec[] = tasks.map((t) => {
      const dayShort = DAY_LABELS[t.dayOfWeek - 1] ?? String(t.dayOfWeek);
      return {
        dedupeKey: t.dedupeKey,
        hour: t.hour,
        minute: t.minute,
        isoWeekdays: [t.dayOfWeek],
        mode: 'relative',
        message: `海大早起 · 周${dayShort}首课${t.startText} ${t.firstCourse.name}`,
      };
    });

    const sysRes = await setSystemClockAlarmsBatch(iosSpecs, cancelledSystemIds);
    if (sysRes.ok && sysRes.engine === 'ios_alarmkit') {
      systemClockGroupsCount = sysRes.writtenCount;
      systemEngine = 'ios_alarmkit';
      if (Array.isArray(sysRes.scheduled)) {
        for (const item of sysRes.scheduled) {
          if (item.dedupeKey && item.id) {
            iosSystemIdByDedupeKey.set(item.dedupeKey, item.id);
          }
        }
      }
    } else if (sysRes.authStatus === 'denied') {
      throw new Error(
        sysRes.error || '未开启 iOS 系统闹钟权限，请在系统「设置 -> 海大课表 -> 闹钟」中允许后重试'
      );
    } else if (sysRes.error) {
      fallbackReason = sysRes.error;
    }
  }

  let exactAlarmHint: string | undefined;
  let canScheduleNotifications = false;
  if (systemEngine !== 'ios_alarmkit') {
    try {
      const perm = await ensureNotificationPermission();
      exactAlarmHint = perm.exactAlarmHint;
      canScheduleNotifications = true;
    } catch (permErr) {
      if (systemClockGroupsCount === 0) {
        throw permErr;
      }
    }
  }

  const settled = await Promise.allSettled(
    tasks.map(async (t) => {
      const iosAlarmId = iosSystemIdByDedupeKey.get(t.dedupeKey);
      let notificationId: string | undefined;
      if (systemEngine !== 'ios_alarmkit' && canScheduleNotifications) {
        if (Platform.OS === 'android') {
          if (t.isFutureInWeek) {
            notificationId = await scheduleLocalAlarmNotification(t.title, t.body, t.triggerDate);
          }
        } else {
          // iOS < 26 fallback: schedule weekly repeating ringtone alarm so past weekdays never fail
          notificationId = await scheduleLocalAlarmNotification(t.title, t.body, t.triggerDate, {
            weeklyIsoWeekday: t.dayOfWeek,
            hour: t.hour,
            minute: t.minute,
          });
        }
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
        systemAlarmId: iosAlarmId,
        systemEngine: iosAlarmId
          ? 'ios_alarmkit'
          : systemEngine === 'android_clock'
            ? 'android_clock'
            : 'notification',
        repeatsWeekly: true,
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
    systemEngine,
    replacedCount,
    skippedPast: systemEngine === 'notification' && Platform.OS !== 'ios' ? skippedPast : 0,
    failed,
    exactAlarmHint: systemClockGroupsCount > 0 ? undefined : exactAlarmHint,
    fallbackReason,
  };
}

/**
 * Schedule exam alarms idempotently:
 * - Android: Writes pre-exam departure alarms directly to Android System Clock (`ACTION_SET_ALARM`)
 *   plus pre-exam & eve reminders.
 * - iOS 26+: Writes exact-date pre-exam departure & eve alarms directly into native iOS `AlarmKit`.
 * - iOS < 26 (or fallback): Schedules `defaultRingtone` notifications for eve (20:00) and pre-exam departure.
 */
export async function createExamAlarms(
  exams: ExamItem[],
  settings: AppSettings,
  existingAlarms?: AlarmRule[]
): Promise<{
  created: AlarmRule[];
  systemClockGroupsCount: number;
  systemEngine: AlarmSystemEngine;
  replacedCount: number;
  skipped: number;
  failed: number;
  exactAlarmHint?: string;
  fallbackReason?: string;
}> {
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

  if (candidates.length === 0) {
    return {
      created: [],
      systemClockGroupsCount: 0,
      systemEngine: Platform.OS === 'android' ? 'android_clock' : 'notification',
      replacedCount: 0,
      skipped,
      failed: 0,
    };
  }

  const cancelledSystemIds: string[] = [];
  for (const c of candidates) {
    const res = await cancelExistingByDedupeKey(existingAlarms, c.dedupeKey);
    replacedCount += res.count;
    cancelledSystemIds.push(...res.cancelledSystemIds);
  }

  let systemClockGroupsCount = 0;
  let systemEngine: AlarmSystemEngine = 'notification';
  let fallbackReason: string | undefined;
  const iosSystemIdByDedupeKey = new Map<string, string>();

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
        systemEngine = 'android_clock';
      }
    }
  } else if (Platform.OS === 'ios') {
    const iosSpecs: SystemClockAlarmSpec[] = candidates.map((c) => ({
      dedupeKey: c.dedupeKey,
      hour: c.triggerDate.getHours(),
      minute: c.triggerDate.getMinutes(),
      mode: 'fixed',
      triggerEpochMs: c.triggerDate.getTime(),
      message:
        c.suffix === 'pre'
          ? `考前出发：${c.exam.courseName} (${c.exam.location}${
              c.exam.seatNumber ? ` 座位${c.exam.seatNumber}` : ''
            })`
          : `明日考试：${c.exam.courseName} (${c.exam.startTimeText})`,
    }));
    const sysRes = await setSystemClockAlarmsBatch(iosSpecs, cancelledSystemIds);
    if (sysRes.ok && sysRes.engine === 'ios_alarmkit') {
      systemClockGroupsCount = sysRes.writtenCount;
      systemEngine = 'ios_alarmkit';
      if (Array.isArray(sysRes.scheduled)) {
        for (const item of sysRes.scheduled) {
          if (item.dedupeKey && item.id) {
            iosSystemIdByDedupeKey.set(item.dedupeKey, item.id);
          }
        }
      }
    } else if (sysRes.authStatus === 'denied') {
      throw new Error(
        sysRes.error || '未开启 iOS 系统闹钟权限，请在系统「设置 -> 海大课表 -> 闹钟」中允许后重试'
      );
    } else if (sysRes.error) {
      fallbackReason = sysRes.error;
    }
  }

  let exactAlarmHint: string | undefined;
  let canScheduleNotifications = false;
  if (systemEngine !== 'ios_alarmkit') {
    try {
      const perm = await ensureNotificationPermission();
      exactAlarmHint = perm.exactAlarmHint;
      canScheduleNotifications = true;
    } catch (permErr) {
      if (systemClockGroupsCount === 0) {
        throw permErr;
      }
    }
  }

  const settled = await Promise.allSettled(
    candidates.map(async (c) => {
      const iosAlarmId = iosSystemIdByDedupeKey.get(c.dedupeKey);
      let notificationId: string | undefined;
      if (!iosAlarmId && canScheduleNotifications) {
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
        systemAlarmId: iosAlarmId,
        systemEngine: iosAlarmId
          ? 'ios_alarmkit'
          : systemEngine === 'android_clock' && c.suffix === 'pre'
            ? 'android_clock'
            : 'notification',
        repeatsWeekly: false,
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
    systemEngine,
    replacedCount,
    skipped,
    failed,
    exactAlarmHint: systemClockGroupsCount > 0 ? undefined : exactAlarmHint,
    fallbackReason,
  };
}

export async function cancelScheduledAlarm(alarm: AlarmRule): Promise<void> {
  if (alarm.systemAlarmId && Platform.OS === 'ios') {
    await cancelSystemAlarmsByIds([alarm.systemAlarmId]);
  }
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
    return {
      ...alarm,
      enabled: false,
      notificationId: undefined,
      systemAlarmId: undefined,
    };
  }

  const triggerDate = new Date(alarm.triggerIso);
  const isFuture = triggerDate.getTime() > Date.now() + 2000;
  const shouldRepeatWeekly = alarm.repeatsWeekly === true || (alarm.kind === 'morning_wakeup' && !isFuture);

  if (Platform.OS === 'ios') {
    const sysRes = await setSystemClockAlarmsBatch([
      {
        dedupeKey: resolveAlarmDedupeKey(alarm),
        hour: alarm.hour,
        minute: alarm.minute,
        message: alarm.title.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '') || alarm.title,
        mode: !shouldRepeatWeekly && isFuture ? 'fixed' : 'relative',
        triggerEpochMs: triggerDate.getTime(),
        isoWeekdays: shouldRepeatWeekly || !isFuture ? [alarm.weekday] : undefined,
      },
    ]);
    if (sysRes.ok && sysRes.engine === 'ios_alarmkit') {
      return {
        ...alarm,
        enabled: true,
        notificationId: undefined,
        systemAlarmId: sysRes.alarmIds?.[0],
        systemEngine: 'ios_alarmkit',
        repeatsWeekly: shouldRepeatWeekly || !isFuture,
      };
    }
    if (sysRes.authStatus === 'denied') {
      throw new Error(
        sysRes.error || '未开启 iOS 系统闹钟权限，请在系统「设置 -> 海大课表 -> 闹钟」中允许后重试'
      );
    }
  }

  const notificationId = await scheduleLocalAlarmNotification(
    alarm.title,
    alarm.body,
    triggerDate,
    shouldRepeatWeekly
      ? { weeklyIsoWeekday: alarm.weekday, hour: alarm.hour, minute: alarm.minute }
      : undefined
  );
  return {
    ...alarm,
    enabled: true,
    notificationId,
    systemEngine: 'notification',
    repeatsWeekly: shouldRepeatWeekly,
  };
}

export async function cancelAllScheduledAlarms(): Promise<void> {
  if (Platform.OS === 'ios') {
    await clearAllSystemAlarms();
  }
  await Notifications.cancelAllScheduledNotificationsAsync();
}

/**
 * Batch-write alarms directly into the native OS system alarm engine:
 * - Android: `AlarmClock.ACTION_SET_ALARM` via `MainApplication.kt` (`GdouSystemAlarmBridge`),
 *   falling back to `IntentLauncher` if running outside the custom native build.
 * - iOS 26+: `AlarmKit` (`AlarmManager.shared.schedule`) via `GdouEphemeralNetworking.swift`
 *   (`GdouIosAlarmBridge`). On iOS < 26, returns `{ ok: false, supported: false }` so callers
 *   cleanly fall back to `UNUserNotificationCenter` ringtone notifications.
 */
export async function setSystemClockAlarmsBatch(
  specs: SystemClockAlarmSpec[],
  cancelIds?: string[]
): Promise<SystemClockBatchResult> {
  if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || specs.length === 0) {
    return { ok: false, writtenCount: 0, supported: false };
  }

  const alarmsPayload = specs.map((s) => ({
    ...(s.id ? { id: s.id } : {}),
    ...(s.dedupeKey ? { dedupeKey: s.dedupeKey } : {}),
    hour: s.hour,
    minute: s.minute,
    message: s.message,
    skipUi: s.skipUi !== false,
    vibrate: true,
    mode: s.mode ?? (s.isoWeekdays && s.isoWeekdays.length > 0 ? 'relative' : 'fixed'),
    ...(typeof s.triggerEpochMs === 'number' ? { triggerEpochMs: s.triggerEpochMs } : {}),
    days:
      s.isoWeekdays && s.isoWeekdays.length > 0
        ? s.isoWeekdays.map(isoWeekdayToCalendarDay)
        : [],
  }));

  try {
    const resp = await fetchAlarmBridge('/set-system-alarms', {
      method: 'POST',
      body: {
        alarms: alarmsPayload,
        ...(cancelIds && cancelIds.length > 0 ? { cancelIds } : {}),
      },
      timeoutMs: Platform.OS === 'ios' ? 32_000 : 10_000,
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        ok?: boolean;
        count?: number;
        engine?: string;
        supported?: boolean;
        authStatus?: string;
        alarmIds?: string[];
        scheduled?: Array<{ id: string; dedupeKey: string }>;
        error?: string;
      };
      const resolvedEngine: AlarmSystemEngine =
        Platform.OS === 'android'
          ? 'android_clock'
          : json.engine === 'alarmkit'
            ? 'ios_alarmkit'
            : 'notification';
      if (json.ok && (json.count ?? 0) > 0) {
        return {
          ok: true,
          writtenCount: json.count ?? specs.length,
          engine: resolvedEngine,
          supported: json.supported ?? true,
          authStatus: json.authStatus,
          alarmIds: json.alarmIds,
          scheduled: json.scheduled,
        };
      }
      return {
        ok: false,
        writtenCount: 0,
        engine: resolvedEngine,
        supported: json.supported,
        authStatus: json.authStatus,
        error: json.error || undefined,
      };
    }
  } catch (bridgeErr) {
    if (Platform.OS === 'ios') {
      return {
        ok: false,
        writtenCount: 0,
        engine: 'notification',
        supported: false,
        error: bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr),
      };
    }
    // Android falls back to IntentLauncher below
  }

  if (Platform.OS === 'android') {
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
      return { ok: true, writtenCount: 1, engine: 'android_clock', supported: true };
    } catch (err) {
      return {
        ok: false,
        writtenCount: 0,
        engine: 'android_clock',
        supported: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { ok: false, writtenCount: 0, supported: false };
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
 * Open the phone's native System Clock Alarms screen:
 * - Android: `AlarmClock.ACTION_SHOW_ALARMS`
 * - iOS: tries `clock-alarm://` via native `UIApplication.shared.open` (returns `false` honestly
 *   on iOS 18/26 where Apple blocks third-party Clock URL schemes so callers can offer Settings).
 */
export async function openNativeSystemClockApp(): Promise<boolean> {
  if (Platform.OS === 'android') {
    try {
      const resp = await fetchAlarmBridge('/show-alarms', { method: 'POST', timeoutMs: 5000 });
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
      const resp = await fetchAlarmBridge('/show-alarms', { method: 'POST', timeoutMs: 5000 });
      if (resp.ok) {
        const json = (await resp.json()) as { ok?: boolean };
        return json.ok === true;
      }
    } catch {
      // Fallback to Linking below
    }
    try {
      const can = await Linking.canOpenURL('clock-alarm://');
      if (!can) return false;
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
