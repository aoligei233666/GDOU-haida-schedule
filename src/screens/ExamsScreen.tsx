import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  createExamAlarms,
  openAppSystemSettings,
  setNativeAndroidSystemClockAlarm,
} from '../services/alarmService';
import { openSystemClockOrGuide, showAlarmErrorAlert } from '../services/alarmUiHelper';
import { syncExamsToCalendar } from '../services/calendarService';
import { getExamCountdown, parseExamIsoLocal } from '../services/examParser';
import { COLORS } from '../theme/colors';
import { AlarmRule, AppSettings, ExamItem } from '../types/models';

interface Props {
  exams: ExamItem[];
  alarms: AlarmRule[];
  settings: AppSettings;
  onOpenSync: () => void;
  onAddManualExam: (exam: ExamItem) => void;
  onDeleteExam: (examId: string) => void;
  onAlarmsAdded: (alarms: AlarmRule[]) => void;
}

export const ExamsScreen: React.FC<Props> = ({
  exams,
  alarms,
  settings,
  onOpenSync,
  onAddManualExam,
  onDeleteExam,
  onAlarmsAdded,
}) => {
  const [filter, setFilter] = useState<'upcoming' | 'all'>('all');
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  // Manual exam form
  const [courseName, setCourseName] = useState('');
  const [dateText, setDateText] = useState('');
  const [startTimeText, setStartTimeText] = useState('09:00');
  const [endTimeText, setEndTimeText] = useState('11:00');
  const [location, setLocation] = useState('');
  const [seatNumber, setSeatNumber] = useState('');
  const [examType, setExamType] = useState('期末考试');

  const filteredExams = useMemo(() => {
    if (filter === 'all') return exams;
    return exams.filter((e) => getExamCountdown(e).status !== 'past');
  }, [exams, filter]);

  const upcomingCount = useMemo(
    () => exams.filter((e) => getExamCountdown(e).status !== 'past').length,
    [exams]
  );

  const handleSyncAllExamsToCalendar = async () => {
    if (exams.length === 0) {
      Alert.alert('暂无考试', '请先无痕同步教务或手动添加考试。');
      return;
    }
    setBusy(true);
    try {
      const res = await syncExamsToCalendar(exams);
      const total = res.eventsCreated + res.eventsUpdated;
      const failNote = res.failed > 0 ? `（另有 ${res.failed} 场写入失败）` : '';
      Alert.alert(
        '考试已导入系统日历',
        `已同步 ${total} 场考试至「${res.calendarTitle}」（新增 ${res.eventsCreated} 场，原位更新 ${res.eventsUpdated} 场，保留原有课程），均已设置考前 1 天 + 考前 1 小时双重提醒${failNote}。`
      );
    } catch (err) {
      Alert.alert('导入日历失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleScheduleAllExamAlarms = async () => {
    if (exams.length === 0) {
      Alert.alert('暂无考试', '请先同步教务或手动添加考试。');
      return;
    }
    setBusy(true);
    try {
      const {
        created,
        systemClockGroupsCount,
        systemEngine,
        replacedCount,
        skipped,
        failed,
        exactAlarmHint,
        fallbackReason,
      } = await createExamAlarms(exams, settings, alarms);
      if (created.length > 0) {
        onAlarmsAdded(created);
      }
      const dedupeNote = replacedCount > 0 ? `（已覆盖更新 ${replacedCount} 条旧记录）` : '';
      const failNote = failed > 0 ? `，另有 ${failed} 条创建失败` : '';
      const hintNote = exactAlarmHint ? `\n\n${exactAlarmHint}` : '';
      const fallbackNote =
        Platform.OS === 'ios' && systemEngine !== 'ios_alarmkit' && fallbackReason
          ? `\n\n说明：${fallbackReason}，已改用高优先级系统铃声提醒。`
          : '';
      const msg =
        Platform.OS === 'android' && systemClockGroupsCount > 0
          ? `已直接写入手机系统闹钟 ${systemClockGroupsCount} 场考前出发闹钟（考前 ${settings.examAdvanceMinutes} 分钟），并同步设置前晚 20:00 备考提醒${dedupeNote}${failNote}。`
          : Platform.OS === 'ios' && systemEngine === 'ios_alarmkit' && systemClockGroupsCount > 0
            ? `已通过 iOS 原生 AlarmKit 直接写入 ${systemClockGroupsCount} 条考前系统级闹钟（含前晚 20:00 与考前 ${settings.examAdvanceMinutes} 分钟出发闹钟，穿透静音/专注模式）${dedupeNote}${failNote}。`
            : created.length > 0
              ? `已配置 ${created.length} 条考前闹钟（含前晚 20:00 提醒 + 考前 ${settings.examAdvanceMinutes} 分钟出发闹钟）${dedupeNote}${
                  skipped > 0 ? `，已跳过 ${skipped} 场已结束或时间待定考试` : ''
                }${failNote}。${hintNote}${fallbackNote}`
              : '暂无可设置的未来考试提醒。';

      Alert.alert(
        systemEngine === 'ios_alarmkit' ? 'iOS 考试系统闹钟已写入' : '考试系统闹钟已配置',
        msg,
        Platform.OS === 'ios'
          ? [
              { text: '好的', style: 'cancel' },
              { text: '系统权限设置', onPress: () => void openAppSystemSettings() },
            ]
          : [
              { text: '好的', style: 'cancel' },
              {
                text: '打开系统闹钟查看',
                onPress: () => void openSystemClockOrGuide(false),
              },
            ]
      );
    } catch (err) {
      showAlarmErrorAlert('设定考试闹钟失败', err);
    } finally {
      setBusy(false);
    }
  };

  const handleSingleExamCalendar = async (exam: ExamItem) => {
    try {
      const res = await syncExamsToCalendar([exam]);
      if (res.eventsCreated + res.eventsUpdated > 0) {
        Alert.alert(
          '已同步到日历',
          `《${exam.courseName}》考试日程已${res.eventsUpdated > 0 ? '更新' : '写入'}至「${res.calendarTitle}」。`
        );
      } else {
        Alert.alert('时间待公布', '该考试尚无明确时间，暂无法写入日历。');
      }
    } catch (err) {
      Alert.alert('写入日历失败', err instanceof Error ? err.message : String(err));
    }
  };

  const handleSingleExamAlarm = async (exam: ExamItem) => {
    try {
      const { created, systemClockGroupsCount, systemEngine, fallbackReason } =
        await createExamAlarms([exam], settings, alarms);
      if (created.length > 0 || systemClockGroupsCount > 0) {
        if (created.length > 0) onAlarmsAdded(created);
        const isIosAlarmKit = Platform.OS === 'ios' && systemEngine === 'ios_alarmkit';
        const fallbackNote =
          Platform.OS === 'ios' && !isIosAlarmKit && fallbackReason
            ? `\n\n说明：${fallbackReason}，已改用高优先级系统铃声提醒。`
            : '';
        Alert.alert(
          Platform.OS === 'android' && systemClockGroupsCount > 0
            ? '已直接写入手机系统闹钟'
            : isIosAlarmKit
              ? '已直接写入 iOS 系统闹钟'
              : '考前闹钟已设定',
          Platform.OS === 'android' && systemClockGroupsCount > 0
            ? `已为《${exam.courseName}》在手机系统时钟创建考前 ${settings.examAdvanceMinutes} 分钟闹钟，并配置前晚提醒。`
            : isIosAlarmKit
              ? `已通过 iOS 原生 AlarmKit 为《${exam.courseName}》写入 ${systemClockGroupsCount} 条系统级考前闹钟（穿透静音/专注模式）。`
              : `已为《${exam.courseName}》配置 ${created.length} 条提醒闹钟（已自动去重）。${fallbackNote}`,
          Platform.OS === 'ios'
            ? [
                { text: '完成', style: 'cancel' },
                { text: '系统权限设置', onPress: () => void openAppSystemSettings() },
              ]
            : [
                { text: '完成', style: 'cancel' },
                { text: '打开系统闹钟', onPress: () => void openSystemClockOrGuide(false) },
              ]
        );
      } else {
        Alert.alert('无法设置', '该考试时间已过或时间待定。');
      }
    } catch (err) {
      showAlarmErrorAlert('设定失败', err);
    }
  };

  const handleAndroidExamClock = async (exam: ExamItem) => {
    if (!exam.startIso) return;
    const start = parseExamIsoLocal(exam.startIso);
    const trigger = new Date(start.getTime() - (settings.examAdvanceMinutes || 90) * 60 * 1000);
    await setNativeAndroidSystemClockAlarm({
      hour: trigger.getHours(),
      minute: trigger.getMinutes(),
      message: `考试：${exam.courseName} (${exam.location}${exam.seatNumber ? ` 座位${exam.seatNumber}` : ''})`,
      skipUi: false,
    });
  };

  const handleSaveManualExam = () => {
    if (!courseName.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(dateText.trim())) {
      Alert.alert('信息不完整', '请填写课程名称与正确的考试日期（格式：YYYY-MM-DD，例如 2026-12-28）。');
      return;
    }
    const d = dateText.trim();
    const st = startTimeText.trim() || '09:00';
    const et = endTimeText.trim() || '11:00';
    const newExam: ExamItem = {
      id: `manual-exam-${Date.now()}`,
      courseName: courseName.trim(),
      courseCode: '',
      examType: examType.trim() || '考试',
      dateText: d,
      startTimeText: st,
      endTimeText: et,
      startIso: `${d}T${st}:00`,
      endIso: `${d}T${et}:00`,
      rawTimeText: `${d}(${st}-${et})`,
      location: location.trim() || '待定考场',
      seatNumber: seatNumber.trim(),
      campus: '',
      invigilator: '',
      isManual: true,
    };
    onAddManualExam(newExam);
    setCourseName('');
    setDateText('');
    setLocation('');
    setSeatNumber('');
    setAddModalVisible(false);
  };

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>考试查询</Text>
            <Text style={styles.headerSub}>
              共 {exams.length} 场考试 · 待考 {upcomingCount} 场
            </Text>
          </View>
          <View style={styles.headerBtns}>
            <TouchableOpacity style={styles.iconPill} onPress={() => setAddModalVisible(true)}>
              <Ionicons name="add" size={18} color={COLORS.oceanDeep} />
              <Text style={styles.iconPillText}>手动录入</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconPill} onPress={onOpenSync}>
              <Ionicons name="sync" size={15} color={COLORS.oceanDeep} />
              <Text style={styles.iconPillText}>教务同步</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.batchRow}>
          <TouchableOpacity
            style={styles.batchBtn}
            onPress={handleSyncAllExamsToCalendar}
            disabled={busy}
          >
            <Ionicons name="calendar-outline" size={15} color={COLORS.white} />
            <Text style={styles.batchBtnText}>全部导入系统日历</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.batchBtn}
            onPress={handleScheduleAllExamAlarms}
            disabled={busy}
          >
            <Ionicons name="alarm-outline" size={15} color={COLORS.white} />
            <Text style={styles.batchBtnText}>
              {Platform.OS === 'android' ? '全部写入系统闹钟' : '全部设考前闹钟'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Filter Bar */}
      <View style={styles.filterBar}>
        <TouchableOpacity
          style={[styles.filterTab, filter === 'all' && styles.filterTabActive]}
          onPress={() => setFilter('all')}
        >
          <Text style={[styles.filterText, filter === 'all' && styles.filterTextActive]}>
            全部考试 ({exams.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterTab, filter === 'upcoming' && styles.filterTabActive]}
          onPress={() => setFilter('upcoming')}
        >
          <Text style={[styles.filterText, filter === 'upcoming' && styles.filterTextActive]}>
            仅看待考 ({upcomingCount})
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.listContent}>
        {filteredExams.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="document-text-outline" size={44} color={COLORS.textMuted} />
            <Text style={styles.emptyTitle}>当前暂无考试安排</Text>
            <Text style={styles.emptyDesc}>
              教务系统公布考试安排后，点击右上角「教务同步」即可一键获取考场和座位号；也可点击「手动录入」记录随堂测验。
            </Text>
          </View>
        ) : (
          filteredExams.map((exam) => {
            const cd = getExamCountdown(exam);
            const badgeStyle =
              cd.status === 'today'
                ? { bg: COLORS.dangerLight, color: COLORS.danger }
                : cd.status === 'upcoming'
                  ? { bg: COLORS.coralLight, color: COLORS.coral }
                  : cd.status === 'past'
                    ? { bg: COLORS.borderLight, color: COLORS.textMuted }
                    : { bg: COLORS.oceanLight, color: COLORS.oceanPrimary };

            return (
              <View key={exam.id} style={styles.examCard}>
                <View style={styles.examTop}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.examTitleRow}>
                      <Text style={styles.examName}>{exam.courseName}</Text>
                      <View style={styles.typeTag}>
                        <Text style={styles.typeTagText}>{exam.examType}</Text>
                      </View>
                    </View>
                    <Text style={styles.examTimeText}>
                      {exam.dateText
                        ? `${exam.dateText}  ${exam.startTimeText}-${exam.endTimeText}`
                        : exam.rawTimeText}
                    </Text>
                  </View>

                  <View style={[styles.cdBadge, { backgroundColor: badgeStyle.bg }]}>
                    <Text style={[styles.cdBadgeText, { color: badgeStyle.color }]}>
                      {cd.label}
                    </Text>
                  </View>
                </View>

                <View style={styles.examMetaGrid}>
                  <View style={styles.metaChip}>
                    <Ionicons name="location-outline" size={14} color={COLORS.oceanPrimary} />
                    <Text style={styles.metaChipText}>
                      {[exam.campus, exam.location].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  {exam.seatNumber ? (
                    <View style={[styles.metaChip, styles.seatChip]}>
                      <Ionicons name="grid-outline" size={14} color={COLORS.coral} />
                      <Text style={[styles.metaChipText, { color: COLORS.coral, fontWeight: '700' }]}>
                        座位号：{exam.seatNumber}
                      </Text>
                    </View>
                  ) : null}
                </View>

                <View style={styles.examActions}>
                  <TouchableOpacity
                    style={styles.smallActionBtn}
                    onPress={() => handleSingleExamCalendar(exam)}
                  >
                    <Ionicons name="calendar-outline" size={14} color={COLORS.oceanPrimary} />
                    <Text style={styles.smallActionText}>加日历</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.smallActionBtn}
                    onPress={() => handleSingleExamAlarm(exam)}
                  >
                    <Ionicons name="alarm-outline" size={14} color={COLORS.coral} />
                    <Text style={[styles.smallActionText, { color: COLORS.coral }]}>
                      {Platform.OS === 'android' ? '设系统闹钟' : '订闹钟'}
                    </Text>
                  </TouchableOpacity>
                  {Platform.OS === 'android' && exam.startIso && (
                    <TouchableOpacity
                      style={styles.smallActionBtn}
                      onPress={() => handleAndroidExamClock(exam)}
                    >
                      <Ionicons name="options-outline" size={14} color={COLORS.oceanDeep} />
                      <Text style={[styles.smallActionText, { color: COLORS.oceanDeep }]}>微调铃声</Text>
                    </TouchableOpacity>
                  )}
                  {exam.isManual && (
                    <TouchableOpacity
                      style={[styles.smallActionBtn, { marginLeft: 'auto' }]}
                      onPress={() => onDeleteExam(exam.id)}
                    >
                      <Ionicons name="trash-outline" size={14} color={COLORS.danger} />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Manual Exam Modal */}
      <Modal
        visible={addModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setAddModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>手动添加考试 / 测验</Text>
            <TextInput
              style={styles.input}
              placeholder="考试课程名称（如：概率论期中测验）"
              placeholderTextColor={COLORS.textMuted}
              value={courseName}
              onChangeText={setCourseName}
            />
            <TextInput
              style={styles.input}
              placeholder="考试日期 YYYY-MM-DD（如：2026-12-28）"
              placeholderTextColor={COLORS.textMuted}
              value={dateText}
              onChangeText={setDateText}
            />
            <View style={styles.row2}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="开始 09:00"
                placeholderTextColor={COLORS.textMuted}
                value={startTimeText}
                onChangeText={setStartTimeText}
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="结束 11:00"
                placeholderTextColor={COLORS.textMuted}
                value={endTimeText}
                onChangeText={setEndTimeText}
              />
            </View>
            <View style={styles.row2}>
              <TextInput
                style={[styles.input, { flex: 1.4 }]}
                placeholder="考场教室（如：钟海楼02018）"
                placeholderTextColor={COLORS.textMuted}
                value={location}
                onChangeText={setLocation}
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="座位号（选填）"
                placeholderTextColor={COLORS.textMuted}
                value={seatNumber}
                onChangeText={setSeatNumber}
              />
            </View>
            <TextInput
              style={styles.input}
              placeholder="性质（期末考试 / 期中 / 补考）"
              placeholderTextColor={COLORS.textMuted}
              value={examType}
              onChangeText={setExamType}
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalCancel]}
                onPress={() => setAddModalVisible(false)}
              >
                <Text style={styles.modalCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalSave]}
                onPress={handleSaveManualExam}
              >
                <Text style={styles.modalSaveText}>保存考试</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.white,
  },
  headerSub: {
    fontSize: 12,
    color: '#93C5FD',
    marginTop: 2,
  },
  headerBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  iconPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.oceanLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    gap: 4,
  },
  iconPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  batchRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  batchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 8,
    borderRadius: 10,
    gap: 5,
  },
  batchBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.white,
  },
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  filterTab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  filterTabActive: {
    backgroundColor: COLORS.oceanPrimary,
    borderColor: COLORS.oceanPrimary,
  },
  filterText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  filterTextActive: {
    color: COLORS.white,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 30,
    gap: 12,
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: 60,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginTop: 12,
  },
  emptyDesc: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 6,
  },
  examCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  examTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  examTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  examName: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  typeTag: {
    backgroundColor: COLORS.oceanTint,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  typeTagText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.oceanPrimary,
  },
  examTimeText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginTop: 4,
    fontWeight: '500',
  },
  cdBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  cdBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  examMetaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    gap: 5,
  },
  seatChip: {
    backgroundColor: COLORS.coralLight,
  },
  metaChipText: {
    fontSize: 12,
    color: COLORS.textPrimary,
  },
  examActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
  },
  smallActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    gap: 4,
  },
  smallActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.oceanPrimary,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'center',
    padding: 18,
  },
  modalCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 18,
    padding: 18,
    gap: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.oceanDeep,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 14,
    color: COLORS.textPrimary,
    backgroundColor: COLORS.bg,
  },
  row2: {
    flexDirection: 'row',
    gap: 8,
  },
  modalBtns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  modalBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancel: {
    backgroundColor: COLORS.borderLight,
  },
  modalCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  modalSave: {
    backgroundColor: COLORS.oceanPrimary,
  },
  modalSaveText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
});
