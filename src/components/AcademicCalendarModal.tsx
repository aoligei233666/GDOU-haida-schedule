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
import { DAY_FULL_LABELS, DAY_LABELS } from '../constants/gdouTimetable';
import {
  buildGdouCalendarCountdowns,
  formatIsoLocalDate,
  getEffectiveCalendarOverrides,
  resolveEffectiveScheduleDate,
} from '../services/academicCalendar';
import { getDateForWeekAndDay, parseLocalDateStrict } from '../services/scheduleParser';
import { COLORS } from '../theme/colors';
import {
  AppSettings,
  CalendarDayOverride,
  CalendarOverrideKind,
  ExamItem,
} from '../types/models';

interface Props {
  visible: boolean;
  termLabel: string;
  exams: ExamItem[];
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => void;
  onJumpToWeek: (week: number) => void;
  onClose: () => void;
}

export const AcademicCalendarModal: React.FC<Props> = ({
  visible,
  termLabel,
  exams,
  settings,
  onUpdateSettings,
  onJumpToWeek,
  onClose,
}) => {
  const [dateInput, setDateInput] = useState<string>(() => formatIsoLocalDate(new Date()));
  const [kind, setKind] = useState<CalendarOverrideKind>('makeup');
  const [labelInput, setLabelInput] = useState<string>('');
  const [mappedDay, setMappedDay] = useState<number>(3);

  const summary = useMemo(
    () =>
      buildGdouCalendarCountdowns(
        settings.termStartDate,
        settings.totalWeeks,
        exams,
        settings.calendarOverrides
      ),
    [settings.termStartDate, settings.totalWeeks, exams, settings.calendarOverrides]
  );

  const effectiveOverrides = useMemo(
    () => getEffectiveCalendarOverrides(settings.calendarOverrides),
    [settings.calendarOverrides]
  );

  const examDatesSet = useMemo(() => new Set(exams.map((e) => e.dateText).filter(Boolean)), [exams]);
  const todayStr = formatIsoLocalDate(new Date());

  const termWeeks = useMemo(() => {
    return Array.from({ length: settings.totalWeeks }, (_, wIdx) => {
      const weekNum = wIdx + 1;
      const days = Array.from({ length: 7 }, (_, dIdx) => {
        const dt = getDateForWeekAndDay(settings.termStartDate, weekNum, dIdx + 1);
        const resolved = resolveEffectiveScheduleDate(
          dt,
          settings.termStartDate,
          settings.totalWeeks,
          settings.calendarOverrides
        );
        return {
          dt,
          dateStr: resolved.dateStr,
          dayNum: dt.getDate(),
          monthNum: dt.getMonth() + 1,
          isToday: resolved.dateStr === todayStr,
          hasExam: examDatesSet.has(resolved.dateStr),
          resolved,
        };
      });
      return { weekNum, days };
    });
  }, [settings.termStartDate, settings.totalWeeks, settings.calendarOverrides, examDatesSet, todayStr]);

  const handleSaveOverride = () => {
    const cleanDate = dateInput.trim();
    if (!parseLocalDateStrict(cleanDate)) {
      Alert.alert('日期格式无效', '请输入 YYYY-MM-DD 格式日期，例如 2026-10-10。');
      return;
    }
    const defaultLabel =
      kind === 'holiday'
        ? '节假日放假'
        : kind === 'makeup'
          ? `调休补${DAY_FULL_LABELS[mappedDay - 1]}课`
          : '校历重要日程';
    const nextRule: CalendarDayOverride = {
      date: cleanDate,
      kind,
      label: labelInput.trim() || defaultLabel,
      mappedDayOfWeek: kind === 'makeup' ? mappedDay : undefined,
      isPreset: false,
    };
    const filtered = (settings.calendarOverrides ?? []).filter((o) => o.date !== cleanDate);
    onUpdateSettings({
      ...settings,
      calendarOverrides: [...filtered, nextRule],
    });
    setLabelInput('');
    Alert.alert('校历调休映射已保存', `${cleanDate} 已设为「${nextRule.label}」，课表网格、今日看板与桌面小组件已即时生效。`);
  };

  const handleRemoveOverride = (item: CalendarDayOverride) => {
    const filtered = (settings.calendarOverrides ?? []).filter((o) => o.date !== item.date);
    if (item.isPreset) {
      // Suppress built-in preset cleanly via __CLEAR__ sentinel
      onUpdateSettings({
        ...settings,
        calendarOverrides: [
          ...filtered,
          { date: item.date, kind: 'event', label: '__CLEAR__', isPreset: false },
        ],
      });
    } else {
      onUpdateSettings({
        ...settings,
        calendarOverrides: filtered,
      });
    }
  };

  const handleTapCalendarDay = (dateStr: string, weekNum: number) => {
    setDateInput(dateStr);
    const existing = effectiveOverrides.find((o) => o.date === dateStr);
    if (existing) {
      setKind(existing.kind);
      setLabelInput(existing.label);
      if (existing.mappedDayOfWeek) setMappedDay(existing.mappedDayOfWeek);
    } else {
      setLabelInput('');
    }
    Alert.alert(
      `${dateStr}（第 ${weekNum} 周）`,
      existing
        ? `当前标注：${existing.label}\n已填入下方调休编辑器，可直接修改或跳转查看该周课表。`
        : '已选中该日期填入下方调休编辑器，可设为放假停课或调休补课，也可直接跳至该周课表。',
      [
        { text: '留在校历编辑', style: 'cancel' },
        {
          text: `查看第 ${weekNum} 周课表`,
          onPress: () => {
            onJumpToWeek(weekNum);
            onClose();
          },
        },
      ]
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>海大校历 & 节假日调休映射</Text>
            <Text style={styles.headerSub}>
              {termLabel} · 第 {summary.currentWeek}/{settings.totalWeeks} 周（学期进度 {summary.progressPercent}%）
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Term Progress & Countdowns */}
          <View style={styles.card}>
            <View style={styles.progressHeader}>
              <Text style={styles.cardTitle}>学期进度条</Text>
              <Text style={styles.progressPct}>{summary.progressPercent}%</Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${summary.progressPercent}%` }]} />
            </View>

            {summary.countdowns.length > 0 && (
              <View style={styles.countdownGrid}>
                {summary.countdowns.map((cd, i) => (
                  <View key={i} style={styles.countdownPill}>
                    <Text style={styles.countdownLabel} numberOfLines={1}>
                      {cd.label}
                    </Text>
                    <Text style={styles.countdownDays}>
                      {cd.daysLeft === 0 ? '就是今天' : `还有 ${cd.daysLeft} 天`}
                    </Text>
                    <Text style={styles.countdownDate}>{cd.dateStr}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          {/* Holiday & Makeup-Day Mapping Editor */}
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Ionicons name="swap-horizontal" size={17} color={COLORS.oceanPrimary} />
              <Text style={styles.cardTitle}>新增 / 修改节假日与调休映射</Text>
            </View>
            <Text style={styles.helpText}>
              设置「放假停课」后当日小组件与今日课表自动免课；设置「调休补课」（如周日补周三课）后当日自动按目标星期展示课程。
            </Text>

            <View style={styles.kindRow}>
              {(
                [
                  { key: 'makeup', label: '调休补课' },
                  { key: 'holiday', label: '放假停课' },
                  { key: 'event', label: '校历备注' },
                ] as { key: CalendarOverrideKind; label: string }[]
              ).map((item) => {
                const active = kind === item.key;
                return (
                  <TouchableOpacity
                    key={item.key}
                    style={[styles.kindBtn, active && styles.kindBtnActive]}
                    onPress={() => setKind(item.key)}
                  >
                    <Text style={[styles.kindBtnText, active && styles.kindBtnTextActive]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}>
                <Text style={styles.miniLabel}>目标日期 (YYYY-MM-DD)</Text>
                <TextInput
                  style={styles.input}
                  value={dateInput}
                  onChangeText={setDateInput}
                  placeholder="2026-10-10"
                  placeholderTextColor={COLORS.textMuted}
                />
              </View>
              <View style={{ flex: 1.2 }}>
                <Text style={styles.miniLabel}>名称标注（选填）</Text>
                <TextInput
                  style={styles.input}
                  value={labelInput}
                  onChangeText={setLabelInput}
                  placeholder={kind === 'makeup' ? '如 国庆调休补周三' : '如 国庆放假'}
                  placeholderTextColor={COLORS.textMuted}
                />
              </View>
            </View>

            {kind === 'makeup' && (
              <>
                <Text style={styles.miniLabel}>当天实际按星期几上课？</Text>
                <View style={styles.dayPickRow}>
                  {DAY_FULL_LABELS.map((lbl, idx) => {
                    const d = idx + 1;
                    const active = mappedDay === d;
                    return (
                      <TouchableOpacity
                        key={d}
                        style={[styles.dayPickChip, active && styles.dayPickChipActive]}
                        onPress={() => setMappedDay(d)}
                      >
                        <Text style={[styles.dayPickText, active && styles.dayPickTextActive]}>
                          {lbl}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}

            <TouchableOpacity style={styles.saveBtn} onPress={handleSaveOverride}>
              <Ionicons name="checkmark-circle-outline" size={17} color={COLORS.white} />
              <Text style={styles.saveBtnText}>应用校历 / 调休规则</Text>
            </TouchableOpacity>
          </View>

          {/* Full Semester Week-by-Week Grid */}
          <View style={styles.card}>
            <View style={styles.sectionHeader}>
              <Ionicons name="calendar" size={17} color={COLORS.oceanPrimary} />
              <Text style={styles.cardTitle}>全学期教学周历（点击任意日期编辑/跳转）</Text>
            </View>

            <View style={styles.calHeaderRow}>
              <Text style={[styles.calWeekCol, styles.calHeaderText]}>周次</Text>
              {DAY_LABELS.map((d) => (
                <Text key={d} style={[styles.calDayCol, styles.calHeaderText]}>
                  {d}
                </Text>
              ))}
            </View>

            {termWeeks.map((w) => {
              const isCurWeek = w.weekNum === summary.currentWeek;
              return (
                <View key={w.weekNum} style={[styles.calRow, isCurWeek && styles.calRowCurrent]}>
                  <TouchableOpacity
                    style={styles.calWeekCol}
                    onPress={() => {
                      onJumpToWeek(w.weekNum);
                      onClose();
                    }}
                  >
                    <Text style={[styles.calWeekNum, isCurWeek && { color: COLORS.oceanPrimary }]}>
                      {w.weekNum}周
                    </Text>
                  </TouchableOpacity>
                  {w.days.map((cell) => {
                    const isHol = cell.resolved.isHoliday;
                    const isMak = cell.resolved.isMakeup;
                    return (
                      <TouchableOpacity
                        key={cell.dateStr}
                        style={[
                          styles.calDayCell,
                          cell.isToday && styles.calDayToday,
                          isHol && styles.calDayHoliday,
                          isMak && styles.calDayMakeup,
                        ]}
                        onPress={() => handleTapCalendarDay(cell.dateStr, w.weekNum)}
                      >
                        <Text
                          style={[
                            styles.calDayText,
                            cell.isToday && styles.calDayTextToday,
                            isHol && { color: '#B91C1C', fontWeight: '700' },
                            isMak && { color: '#B45309', fontWeight: '700' },
                          ]}
                        >
                          {cell.dayNum === 1 ? `${cell.monthNum}月` : cell.dayNum}
                        </Text>
                        {isHol ? (
                          <Text style={styles.calTinyHol}>休</Text>
                        ) : isMak ? (
                          <Text style={styles.calTinyMak}>
                            补{DAY_LABELS[(cell.resolved.effectiveDayOfWeek || 1) - 1]}
                          </Text>
                        ) : cell.hasExam ? (
                          <Text style={styles.calTinyExam}>考</Text>
                        ) : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
          </View>

          {/* Active Rules List */}
          {effectiveOverrides.length > 0 && (
            <View style={styles.card}>
              <Text style={[styles.cardTitle, { marginBottom: 8 }]}>
                已生效节假日与调休列表（{effectiveOverrides.length} 项）
              </Text>
              {effectiveOverrides.slice(0, 20).map((item) => (
                <View key={item.date} style={styles.ruleRow}>
                  <View
                    style={[
                      styles.ruleTag,
                      item.kind === 'holiday'
                        ? { backgroundColor: '#FEE2E2' }
                        : item.kind === 'makeup'
                          ? { backgroundColor: '#FEF3C7' }
                          : { backgroundColor: COLORS.oceanLight },
                    ]}
                  >
                    <Text
                      style={[
                        styles.ruleTagText,
                        item.kind === 'holiday'
                          ? { color: '#B91C1C' }
                          : item.kind === 'makeup'
                            ? { color: '#B45309' }
                            : { color: COLORS.oceanDeep },
                      ]}
                    >
                      {item.kind === 'holiday' ? '放假' : item.kind === 'makeup' ? '调休' : '日程'}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.ruleLabel}>{item.label}</Text>
                    <Text style={styles.ruleDate}>
                      {item.date}
                      {item.kind === 'makeup' && item.mappedDayOfWeek
                        ? ` · 映射为 ${DAY_FULL_LABELS[item.mappedDayOfWeek - 1]}`
                        : ''}
                      {item.isPreset ? ' · 内置法定预设' : ' · 自定义'}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => handleRemoveOverride(item)} hitSlop={8}>
                    <Ionicons name="trash-outline" size={16} color={COLORS.textMuted} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: Platform.OS === 'ios' ? 18 : 16,
    paddingBottom: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.oceanDeep },
  headerSub: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  closeBtn: { padding: 4 },
  content: { padding: 14, paddingBottom: 40, gap: 12 },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  cardTitle: { fontSize: 14.5, fontWeight: '700', color: COLORS.textPrimary },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  progressPct: { fontSize: 14, fontWeight: '800', color: COLORS.oceanPrimary },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: COLORS.borderLight, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: COLORS.oceanPrimary, borderRadius: 4 },
  countdownGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  countdownPill: {
    flex: 1,
    minWidth: 100,
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    padding: 9,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
  },
  countdownLabel: { fontSize: 11.5, color: COLORS.textSecondary, fontWeight: '600' },
  countdownDays: { fontSize: 14, fontWeight: '800', color: COLORS.oceanDeep, marginTop: 3 },
  countdownDate: { fontSize: 10.5, color: COLORS.textMuted, marginTop: 1 },
  helpText: { fontSize: 12, color: COLORS.textSecondary, lineHeight: 17, marginBottom: 10 },
  kindRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  kindBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  kindBtnActive: { backgroundColor: COLORS.oceanPrimary, borderColor: COLORS.oceanPrimary },
  kindBtnText: { fontSize: 12.5, fontWeight: '600', color: COLORS.textSecondary },
  kindBtnTextActive: { color: COLORS.white },
  twoCol: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  miniLabel: { fontSize: 11.5, fontWeight: '600', color: COLORS.textSecondary, marginBottom: 4 },
  input: {
    height: 38,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 9,
    paddingHorizontal: 10,
    fontSize: 13,
    color: COLORS.textPrimary,
  },
  dayPickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  dayPickChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dayPickChipActive: { backgroundColor: COLORS.amberLight, borderColor: '#D97706' },
  dayPickText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  dayPickTextActive: { color: '#B45309', fontWeight: '700' },
  saveBtn: {
    marginTop: 4,
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 10,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  saveBtnText: { fontSize: 13.5, fontWeight: '700', color: COLORS.white },
  calHeaderRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: COLORS.borderLight },
  calHeaderText: { fontSize: 11, fontWeight: '700', color: COLORS.textMuted, textAlign: 'center' },
  calWeekCol: { width: 38, alignItems: 'center', justifyContent: 'center' },
  calDayCol: { flex: 1, textAlign: 'center' },
  calRow: { flexDirection: 'row', paddingVertical: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.borderLight },
  calRowCurrent: { backgroundColor: '#EFF6FF' },
  calWeekNum: { fontSize: 11, fontWeight: '700', color: COLORS.textSecondary },
  calDayCell: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 4, borderRadius: 6 },
  calDayToday: { backgroundColor: COLORS.oceanPrimary },
  calDayHoliday: { backgroundColor: '#FEE2E2' },
  calDayMakeup: { backgroundColor: '#FEF3C7' },
  calDayText: { fontSize: 11.5, color: COLORS.textPrimary },
  calDayTextToday: { color: COLORS.white, fontWeight: '800' },
  calTinyHol: { fontSize: 8.5, color: '#DC2626', fontWeight: '800' },
  calTinyMak: { fontSize: 8.5, color: '#B45309', fontWeight: '800' },
  calTinyExam: { fontSize: 8.5, color: '#7C3AED', fontWeight: '800' },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderLight,
  },
  ruleTag: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  ruleTagText: { fontSize: 11, fontWeight: '700' },
  ruleLabel: { fontSize: 13, fontWeight: '600', color: COLORS.textPrimary },
  ruleDate: { fontSize: 11, color: COLORS.textMuted, marginTop: 1 },
});
