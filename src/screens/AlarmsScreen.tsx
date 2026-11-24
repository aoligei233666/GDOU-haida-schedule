import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { DAY_FULL_LABELS } from '../constants/gdouTimetable';
import {
  cancelAllScheduledAlarms,
  cancelScheduledAlarm,
  createWeeklyMorningWakeupAlarms,
  formatHourMinute,
  mergeAlarmsIdempotently,
  openNativeSystemClockApp,
  setNativeAndroidSystemClockAlarm,
  toggleAlarmEnabled,
} from '../services/alarmService';
import {
  deleteGdouCalendar,
  syncAllCoursesToCalendar,
  syncExamsToCalendar,
} from '../services/calendarService';
import { exportAndShareIcs } from '../services/icsExporter';
import { computeTermWeek } from '../services/scheduleParser';
import { COLORS } from '../theme/colors';
import { AlarmRule, AppSettings, CourseItem, ExamItem } from '../types/models';

interface Props {
  courses: CourseItem[];
  exams: ExamItem[];
  alarms: AlarmRule[];
  termLabel: string;
  settings: AppSettings;
  onAlarmsUpdated: (alarms: AlarmRule[]) => void;
}

const WAKEUP_PRESETS = [30, 45, 60, 75];

export const AlarmsScreen: React.FC<Props> = ({
  courses,
  exams,
  alarms,
  termLabel,
  settings,
  onAlarmsUpdated,
}) => {
  const currentWeek = useMemo(
    () => Math.min(settings.totalWeeks, Math.max(1, computeTermWeek(settings.termStartDate))),
    [settings.termStartDate, settings.totalWeeks]
  );
  const [targetWeek, setTargetWeek] = useState(currentWeek);
  const [wakeupMinutes, setWakeupMinutes] = useState(settings.defaultWakeupMinutes || 45);
  const [busy, setBusy] = useState<string | null>(null);

  const handleGenerateWakeup = async () => {
    if (courses.length === 0) {
      Alert.alert('暂无课表', '请先同步海大教务课表或加载示例课表。');
      return;
    }
    setBusy('wakeup');
    try {
      const { created, systemClockGroupsCount, replacedCount, skippedPast, failed, exactAlarmHint } =
        await createWeeklyMorningWakeupAlarms(
          courses,
          targetWeek,
          wakeupMinutes,
          settings,
          alarms
        );
      if (created.length > 0) {
        const { merged } = mergeAlarmsIdempotently(alarms, created);
        onAlarmsUpdated(merged);
      }
      const dedupeNote = replacedCount > 0 ? `（已更新 ${replacedCount} 条旧记录）` : '';
      const failNote = failed > 0 ? `（另有 ${failed} 条创建失败）` : '';
      const hintNote = exactAlarmHint ? `\n\n${exactAlarmHint}` : '';
      const bodyMsg =
        Platform.OS === 'android' && systemClockGroupsCount > 0
          ? `已直接写入手机「系统闹钟」${systemClockGroupsCount} 组（同唤醒时间点已自动合并星期，首节课提前 ${wakeupMinutes} 分钟）${dedupeNote}${failNote}。`
          : created.length > 0
            ? `已为第 ${targetWeek} 周自动安排 ${created.length} 个每日首课起床闹钟（首节课前 ${wakeupMinutes} 分钟）${dedupeNote}${
                skippedPast > 0 ? `，已跳过 ${skippedPast} 个过期时段` : ''
              }${failNote}。${hintNote}`
            : `第 ${targetWeek} 周所有首课时间均已过去，请切换到下一周再生成。`;

      Alert.alert('系统早起闹钟已更新', bodyMsg, [
        { text: '完成', style: 'cancel' },
        {
          text: '打开系统闹钟查看',
          onPress: () => void openNativeSystemClockApp(),
        },
      ]);
    } catch (err) {
      Alert.alert('写入系统闹钟失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleSyncAllCalendar = async () => {
    if (courses.length === 0 && exams.length === 0) {
      Alert.alert('暂无数据', '请先同步课表或考试后再导入系统日历。');
      return;
    }
    setBusy('cal');
    try {
      let courseCount = 0;
      let courseUpdated = 0;
      let examCount = 0;
      let examUpdated = 0;
      let totalFailed = 0;
      let calendarTitle = '海大课表 (GDOU)';
      let isDedicated = true;
      if (courses.length > 0) {
        const cRes = await syncAllCoursesToCalendar(courses, settings, { replaceExisting: true });
        courseCount = cRes.eventsCreated + cRes.eventsUpdated;
        courseUpdated = cRes.eventsUpdated;
        totalFailed += cRes.failed;
        calendarTitle = cRes.calendarTitle;
        isDedicated = cRes.isDedicated;
      }
      if (exams.length > 0) {
        const eRes = await syncExamsToCalendar(exams);
        examCount = eRes.eventsCreated + eRes.eventsUpdated;
        examUpdated = eRes.eventsUpdated;
        totalFailed += eRes.failed;
        calendarTitle = eRes.calendarTitle;
        isDedicated = eRes.isDedicated;
      }
      const modeHint = isDedicated ? '' : '\n（系统限制新建独立日历，已自动兼容写入默认日历并按标签隔离）';
      const updateNote =
        courseUpdated + examUpdated > 0 ? `\n• 原位更新：${courseUpdated + examUpdated} 条` : '';
      const failNote = totalFailed > 0 ? `\n• 写入失败：${totalFailed} 条` : '';
      Alert.alert(
        '系统日历同步成功',
        `已在系统日历「${calendarTitle}」中同步完成：${modeHint}\n• 上课日程：${courseCount} 条\n• 考试日程：${examCount} 条${updateNote}${failNote}`
      );
    } catch (err) {
      Alert.alert('日历同步失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleExportIcs = async () => {
    if (courses.length === 0 && exams.length === 0) {
      Alert.alert('暂无数据', '请先同步课表或考试后再导出 .ics 日历文件。');
      return;
    }
    setBusy('ics');
    try {
      await exportAndShareIcs(courses, exams, settings, termLabel);
    } catch (err) {
      Alert.alert('导出失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleClearGdouCalendar = async () => {
    Alert.alert(
      '移除海大课表日程',
      '将仅删除本应用创建的「海大课表 (GDOU)」专属日历及带海大课表标签的日程，绝不影响您的其他个人日程。确定继续？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '移除',
          style: 'destructive',
          onPress: async () => {
            try {
              const { removedCalendar, removedEvents } = await deleteGdouCalendar();
              if (removedCalendar || removedEvents > 0) {
                const parts = [
                  removedCalendar ? '已移除「海大课表 (GDOU)」专属日历' : '',
                  removedEvents > 0 ? `已清理兼容日历中的 ${removedEvents} 条海大日程` : '',
                ].filter(Boolean);
                Alert.alert('清理完成', `${parts.join('，')}。`);
              } else {
                Alert.alert('未找到数据', '系统中未发现已导入的海大课表日历或日程。');
              }
            } catch (err) {
              Alert.alert('移除失败', err instanceof Error ? err.message : String(err));
            }
          },
        },
      ]
    );
  };

  const handleToggleAlarm = async (alarm: AlarmRule, nextVal: boolean) => {
    try {
      const updated = await toggleAlarmEnabled(alarm, nextVal);
      onAlarmsUpdated(alarms.map((a) => (a.id === alarm.id ? updated : a)));
    } catch (err) {
      Alert.alert('切换失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteAlarm = async (alarm: AlarmRule) => {
    await cancelScheduledAlarm(alarm);
    onAlarmsUpdated(alarms.filter((a) => a.id !== alarm.id));
  };

  const handleClearAllAlarms = () => {
    Alert.alert('清空全部提醒闹钟', '确定取消并删除列表中的全部闹钟提醒吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '全部清空',
        style: 'destructive',
        onPress: async () => {
          await cancelAllScheduledAlarms();
          onAlarmsUpdated([]);
        },
      },
    ]);
  };

  const handleWriteAndroidClock = async (alarm: AlarmRule) => {
    if (Platform.OS === 'ios') {
      await openNativeSystemClockApp();
      return;
    }
    try {
      await setNativeAndroidSystemClockAlarm({
        hour: alarm.hour,
        minute: alarm.minute,
        isoWeekdays: [alarm.weekday],
        message: alarm.title.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, ''),
        skipUi: false,
      });
    } catch (err) {
      Alert.alert('打开系统闹钟失败', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>闹钟与日历中心</Text>
        <Text style={styles.headerSub}>
          {Platform.OS === 'ios'
            ? '当前系统：iOS · 系统日历 EventKit 与时效闹钟一键联动'
            : '当前系统：Android · 手机系统闹钟直写与系统日历一键联动'}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* System Calendar Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="calendar" size={20} color={COLORS.oceanPrimary} />
            <Text style={styles.cardTitle}>系统日历同步</Text>
          </View>
          <Text style={styles.cardDesc}>
            自动创建独立的「海大课表 (GDOU)」日历，一次性写入整学期所有周次课程与考试座位提醒，不弄乱您的个人日程。
          </Text>

          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[styles.primaryBtn, { flex: 1 }]}
              onPress={handleSyncAllCalendar}
              disabled={busy !== null}
            >
              <Ionicons name="sync-outline" size={17} color={COLORS.white} />
              <Text style={styles.primaryBtnText}>
                {busy === 'cal' ? '正在写入日历...' : '一键导入课表+考试到日历'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.secondaryRow}>
            <TouchableOpacity
              style={styles.outlineBtn}
              onPress={handleExportIcs}
              disabled={busy !== null}
            >
              <Ionicons name="share-outline" size={16} color={COLORS.oceanPrimary} />
              <Text style={styles.outlineBtnText}>
                {busy === 'ics' ? '生成中...' : '导出 .ics 通用日历'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.outlineBtn, { borderColor: COLORS.dangerLight }]}
              onPress={handleClearGdouCalendar}
            >
              <Ionicons name="trash-outline" size={15} color={COLORS.danger} />
              <Text style={[styles.outlineBtnText, { color: COLORS.danger }]}>移除专属日历</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Smart Morning Wake-up Alarm Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="alarm" size={20} color={COLORS.coral} />
            <Text style={styles.cardTitle}>智能每日首课起床闹钟</Text>
          </View>
          <Text style={styles.cardDesc}>
            自动识别指定周次每天最早的一节课（如早八 08:10 或下午 14:30），自动按提前量设定提醒闹钟。
          </Text>

          <View style={styles.weekPickRow}>
            <Text style={styles.inlineLabel}>目标周次</Text>
            <View style={styles.stepper}>
              <TouchableOpacity
                style={styles.stepBtn}
                onPress={() => setTargetWeek((w) => Math.max(1, w - 1))}
              >
                <Ionicons name="remove" size={16} color={COLORS.oceanDeep} />
              </TouchableOpacity>
              <Text style={styles.stepValue}>第 {targetWeek} 周</Text>
              <TouchableOpacity
                style={styles.stepBtn}
                onPress={() => setTargetWeek((w) => Math.min(settings.totalWeeks, w + 1))}
              >
                <Ionicons name="add" size={16} color={COLORS.oceanDeep} />
              </TouchableOpacity>
            </View>
          </View>

          <Text style={styles.inlineLabel}>首节课前提前唤醒</Text>
          <View style={styles.chipRow}>
            {WAKEUP_PRESETS.map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.chip, wakeupMinutes === m && styles.chipActive]}
                onPress={() => setWakeupMinutes(m)}
              >
                <Text style={[styles.chipText, wakeupMinutes === m && styles.chipTextActive]}>
                  提前 {m} 分钟
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: COLORS.coral, flex: 1 }]}
              onPress={handleGenerateWakeup}
              disabled={busy !== null}
            >
              <Ionicons name="sunny-outline" size={18} color={COLORS.white} />
              <Text style={styles.primaryBtnText}>
                {busy === 'wakeup'
                  ? '正在写入...'
                  : Platform.OS === 'android'
                    ? `直接写入第 ${targetWeek} 周系统起床闹钟`
                    : `生成第 ${targetWeek} 周每日起床闹钟`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.outlineBtn,
                { flex: 0, paddingHorizontal: 12, height: 44, borderColor: COLORS.coralLight },
              ]}
              onPress={() => void openNativeSystemClockApp()}
            >
              <Ionicons name="time-outline" size={16} color={COLORS.coral} />
              <Text style={[styles.outlineBtnText, { color: COLORS.coral }]}>系统闹钟</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.platformNote}>
            {Platform.OS === 'android'
              ? '提示：点击上方按钮将直接修改写入手机自带「系统闹钟」（相同唤醒时间自动合并星期，锁屏/后台杀进程/勿扰均准时响铃）。'
              : '提示：iOS 端自动注册系统高优先级时效提醒（Time-Sensitive），点击右侧「系统闹钟」可一键跳转苹果自带时钟 App。'}
          </Text>
        </View>

        {/* Scheduled Alarms List */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>已设定的闹钟（{alarms.length}）</Text>
          {alarms.length > 0 && (
            <TouchableOpacity onPress={handleClearAllAlarms}>
              <Text style={styles.clearAllText}>全部清空</Text>
            </TouchableOpacity>
          )}
        </View>

        {alarms.length === 0 ? (
          <View style={styles.emptyAlarms}>
            <Ionicons name="notifications-off-outline" size={32} color={COLORS.textMuted} />
            <Text style={styles.emptyAlarmsText}>
              暂未设置闹钟。可在上方一键生成本周起床闹钟，或在课表/考试页点击单条记录设定。
            </Text>
          </View>
        ) : (
          alarms.map((alarm) => {
            const dt = new Date(alarm.triggerIso);
            const dateStr = `${dt.getMonth() + 1}月${dt.getDate()}日 ${
              DAY_FULL_LABELS[alarm.weekday - 1] ?? ''
            }`;
            const isExpired = dt.getTime() < Date.now();
            return (
              <View key={alarm.id} style={styles.alarmItem}>
                <View style={styles.alarmTop}>
                  <View style={styles.timeBadge}>
                    <Text style={styles.timeBig}>{formatHourMinute(alarm.hour, alarm.minute)}</Text>
                    <Text style={styles.timeDate}>{dateStr}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.alarmTitle} numberOfLines={1}>
                      {alarm.title}
                    </Text>
                    <Text style={styles.alarmBody} numberOfLines={2}>
                      {alarm.body}
                    </Text>
                    {isExpired && <Text style={styles.expiredTag}>已触发 / 已过期</Text>}
                  </View>
                  <Switch
                    value={alarm.enabled && !isExpired}
                    disabled={isExpired}
                    onValueChange={(v) => handleToggleAlarm(alarm, v)}
                    trackColor={{ false: COLORS.border, true: COLORS.oceanLight }}
                    thumbColor={alarm.enabled ? COLORS.oceanPrimary : COLORS.textMuted}
                  />
                </View>

                <View style={styles.alarmFooter}>
                  <TouchableOpacity
                    style={styles.miniAction}
                    onPress={() => handleWriteAndroidClock(alarm)}
                  >
                    <Ionicons name="time-outline" size={14} color={COLORS.oceanPrimary} />
                    <Text style={styles.miniActionText}>
                      {Platform.OS === 'android' ? '在系统闹钟中编辑/修改' : '打开系统时钟'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.miniAction, { marginLeft: 'auto' }]}
                    onPress={() => handleDeleteAlarm(alarm)}
                  >
                    <Ionicons name="trash-outline" size={14} color={COLORS.danger} />
                    <Text style={[styles.miniActionText, { color: COLORS.danger }]}>删除</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    backgroundColor: COLORS.oceanDeep,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.white,
  },
  headerSub: {
    fontSize: 12,
    color: '#93C5FD',
    marginTop: 3,
  },
  content: {
    padding: 14,
    paddingBottom: 32,
    gap: 14,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  cardDesc: {
    fontSize: 12.5,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginBottom: 12,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    height: 44,
    borderRadius: 12,
    gap: 6,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  outlineBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    backgroundColor: COLORS.bg,
    gap: 5,
  },
  outlineBtnText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: COLORS.oceanPrimary,
  },
  weekPickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  inlineLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: 6,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 3,
    gap: 10,
  },
  stepBtn: {
    width: 30,
    height: 28,
    borderRadius: 7,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.oceanDeep,
    minWidth: 56,
    textAlign: 'center',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  chipActive: {
    backgroundColor: COLORS.coralLight,
    borderColor: COLORS.coral,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  chipTextActive: {
    color: COLORS.coral,
  },
  platformNote: {
    fontSize: 11.5,
    color: COLORS.textMuted,
    marginTop: 10,
    lineHeight: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  clearAllText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.danger,
  },
  emptyAlarms: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyAlarmsText: {
    fontSize: 12.5,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
  alarmItem: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  alarmTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  timeBadge: {
    backgroundColor: COLORS.oceanTint,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
    minWidth: 74,
  },
  timeBig: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.oceanDeep,
  },
  timeDate: {
    fontSize: 10,
    color: COLORS.oceanPrimary,
    marginTop: 2,
    fontWeight: '600',
  },
  alarmTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  alarmBody: {
    fontSize: 12,
    color: COLORS.textSecondary,
    marginTop: 2,
    lineHeight: 16,
  },
  expiredTag: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 3,
    fontWeight: '600',
  },
  alarmFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
    gap: 8,
  },
  miniAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
  },
  miniActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.oceanPrimary,
  },
});
