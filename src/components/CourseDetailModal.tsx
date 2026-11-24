import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { DAY_FULL_LABELS, getActivePeriods } from '../constants/gdouTimetable';
import {
  createClassAlarm,
  openAppSystemSettings,
  setNativeAndroidSystemClockAlarm,
} from '../services/alarmService';
import { openSystemClockOrGuide, showAlarmErrorAlert } from '../services/alarmUiHelper';
import { addSingleCourseToCalendar } from '../services/calendarService';
import { getCourseTimeSpan } from '../services/scheduleParser';
import { COLORS, COURSE_PALETTE } from '../theme/colors';
import { AlarmRule, AppSettings, CourseItem } from '../types/models';

interface Props {
  courses: CourseItem[];
  selectedWeek: number;
  settings: AppSettings;
  partnerName?: string;
  existingAlarms?: AlarmRule[];
  onClose: () => void;
  onAlarmCreated: (alarm: AlarmRule) => void;
  onAddManualCourseInSlot?: (dayOfWeek: number, startSection: number, endSection: number) => void;
  onDeleteManualCourse?: (courseId: string) => void;
}

const LEAD_OPTIONS = [10, 15, 20, 30, 45];

const PARTNER_THEME = {
  bg: '#FDF2F8',
  border: '#EC4899',
  text: '#831843',
  subtext: '#BE185D',
};

export const CourseDetailModal: React.FC<Props> = ({
  courses,
  selectedWeek,
  settings,
  partnerName = 'TA',
  existingAlarms,
  onClose,
  onAlarmCreated,
  onAddManualCourseInSlot,
  onDeleteManualCourse,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [leadMinutes, setLeadMinutes] = useState(settings.defaultClassAlarmMinutes || 20);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setActiveIndex(0);
  }, [courses]);

  if (!courses || courses.length === 0) return null;

  const safeIndex = Math.min(activeIndex, courses.length - 1);
  const course = courses[safeIndex];
  const isPartnerCourse = course.ownerTag === 'partner';
  const isCurrentWeek = course.weeks.includes(selectedWeek);
  const theme = isPartnerCourse
    ? PARTNER_THEME
    : COURSE_PALETTE[course.colorIndex % COURSE_PALETTE.length];

  const periods = getActivePeriods(settings);
  const { startText, endText } = getCourseTimeSpan(course, periods);
  const dayLabel = DAY_FULL_LABELS[course.dayOfWeek - 1] ?? `周${course.dayOfWeek}`;

  const myCurrentWeekItems = courses.filter(
    (c) => c.ownerTag !== 'partner' && c.weeks.includes(selectedWeek)
  );
  const partnerCurrentWeekItems = courses.filter(
    (c) => c.ownerTag === 'partner' && c.weeks.includes(selectedWeek)
  );
  const hasPairOverlap = (list: CourseItem[]) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (
          list[i].startSection <= list[j].endSection &&
          list[j].startSection <= list[i].endSection
        ) {
          return true;
        }
      }
    }
    return false;
  };
  // Non-current-week courses are NEVER conflicts (`撞课`); only >=2 overlapping courses BOTH in selectedWeek count!
  const hasRealConflict =
    hasPairOverlap(myCurrentWeekItems) || hasPairOverlap(partnerCurrentWeekItems);
  const hasBothPartners =
    courses.some((c) => c.ownerTag !== 'partner') &&
    courses.some((c) => c.ownerTag === 'partner');

  const handleAddToCalendar = async () => {
    setBusy(true);
    try {
      const targetCourse = isPartnerCourse
        ? { ...course, name: `[${partnerName}] ${course.name}` }
        : course;
      const res = await addSingleCourseToCalendar(targetCourse, settings);
      const total = res.eventsCreated + res.eventsUpdated;
      Alert.alert(
        '已同步到系统日历',
        `已将《${targetCourse.name}》的全部 ${total} 次上课安排同步至「${res.calendarTitle}」（新增 ${res.eventsCreated} 条，更新 ${res.eventsUpdated} 条），并附带课前 ${settings.defaultCalendarReminderMinutes} 分钟提醒。`
      );
    } catch (err) {
      Alert.alert('写入日历失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleScheduleNotificationAlarm = async () => {
    setBusy(true);
    try {
      const targetWeek = course.weeks.includes(selectedWeek)
        ? selectedWeek
        : course.weeks.find((w) => w > selectedWeek) ?? course.weeks[0] ?? selectedWeek;
      const targetCourse = isPartnerCourse
        ? { ...course, name: `[${partnerName}] ${course.name}` }
        : course;
      const rule = await createClassAlarm(
        targetCourse,
        targetWeek,
        leadMinutes,
        settings,
        existingAlarms
      );
      onAlarmCreated(rule);
      const hhmm = `${String(rule.hour).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`;
      const isIosAlarmKit = Platform.OS === 'ios' && rule.systemEngine === 'ios_alarmkit';
      const fallbackNote =
        Platform.OS === 'ios' && !isIosAlarmKit && rule.fallbackReason
          ? `\n\n说明：${rule.fallbackReason}，已改用高优先级系统铃声提醒。`
          : '';
      const alertTitle =
        Platform.OS === 'android' && rule.systemClockWritten
          ? '已直接写入手机系统闹钟'
          : isIosAlarmKit
            ? '已直接写入 iOS 系统闹钟'
            : '课前闹钟已设定';
      const alertBody =
        Platform.OS === 'android' && rule.systemClockWritten
          ? `已在手机自带「系统时钟」创建/更新 ${dayLabel} ${hhmm} 课前闹钟（提前 ${leadMinutes} 分钟 · ${targetCourse.name}）。`
          : isIosAlarmKit
            ? `已通过 iOS 原生 AlarmKit 写入 ${rule.repeatsWeekly ? `每周${dayLabel.replace('周', '')}` : `第 ${targetWeek} 周 ${dayLabel}`} ${hhmm} 系统级闹钟（提前 ${leadMinutes} 分钟 · ${targetCourse.name}，支持锁屏全屏响铃与穿透静音/专注模式）。`
            : `将在${rule.repeatsWeekly ? `每周${dayLabel.replace('周', '')}` : `第 ${targetWeek} 周 ${dayLabel}`}上课前 ${leadMinutes} 分钟（${hhmm}）响铃提醒。${fallbackNote}`;

      Alert.alert(
        alertTitle,
        alertBody,
        Platform.OS === 'ios'
          ? [
              { text: '完成', style: 'cancel' },
              {
                text: '系统权限设置',
                onPress: () => void openAppSystemSettings(),
              },
            ]
          : [
              { text: '完成', style: 'cancel' },
              {
                text: '打开系统闹钟',
                onPress: () => void openSystemClockOrGuide(false),
              },
            ]
      );
    } catch (err) {
      showAlarmErrorAlert('设定系统闹钟失败', err);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenSystemClockEditor = async () => {
    if (Platform.OS === 'android') {
      const [hStr, mStr] = startText.split(':');
      const totalMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) - leadMinutes;
      const normalized = ((totalMinutes % 1440) + 1440) % 1440;
      const hour = Math.floor(normalized / 60);
      const minute = normalized % 60;
      await setNativeAndroidSystemClockAlarm({
        hour,
        minute,
        message: `${isPartnerCourse ? `[${partnerName}] ` : ''}${course.name} (${course.location})`,
        isoWeekdays: [course.dayOfWeek],
        skipUi: false,
      });
      return;
    }
    await openSystemClockOrGuide(true);
  };

  const handleConfirmDeleteManual = () => {
    if (!onDeleteManualCourse) return;
    Alert.alert('删除手动添加课程', `确定从课表中移除《${course.name}》吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '确认删除',
        style: 'destructive',
        onPress: () => {
          onDeleteManualCourse(course.id);
          if (courses.length <= 1) {
            onClose();
          } else {
            setActiveIndex(0);
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={courses.length > 0} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1}>
          {/* Multi-Course Overlap Switcher Header when >= 2 courses occupy this slot */}
          {courses.length > 1 && (
            <View style={styles.multiWrap}>
              <View style={styles.multiTopRow}>
                <View style={styles.multiTitleRow}>
                  <Ionicons
                    name={hasRealConflict ? 'warning' : hasBothPartners ? 'heart' : 'calendar-outline'}
                    size={15}
                    color={
                      hasRealConflict
                        ? COLORS.coral
                        : hasBothPartners
                          ? '#DB2777'
                          : COLORS.oceanPrimary
                    }
                  />
                  <Text
                    style={[
                      styles.multiTitleText,
                      hasRealConflict && { color: '#C2410C' },
                    ]}
                  >
                    {hasRealConflict
                      ? `第 ${selectedWeek} 周该时段有同周重课 · 点击切换（${safeIndex + 1}/${courses.length}）`
                      : hasBothPartners
                        ? `我与 ${partnerName} 该时段排课（${safeIndex + 1}/${courses.length}）`
                        : `该时段不同周次排课共 ${courses.length} 门（本周不撞课 · ${safeIndex + 1}/${courses.length}）`}
                  </Text>
                </View>

                <View style={styles.multiPagerBtns}>
                  <TouchableOpacity
                    style={styles.pagerBtn}
                    onPress={() =>
                      setActiveIndex((idx) => (idx - 1 + courses.length) % courses.length)
                    }
                  >
                    <Ionicons name="chevron-back" size={15} color={COLORS.oceanPrimary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pagerBtn}
                    onPress={() => setActiveIndex((idx) => (idx + 1) % courses.length)}
                  >
                    <Ionicons name="chevron-forward" size={15} color={COLORS.oceanPrimary} />
                  </TouchableOpacity>
                </View>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.multiTabsScroll}
              >
                {courses.map((item, idx) => {
                  const selected = idx === safeIndex;
                  const itemInWeek = item.weeks.includes(selectedWeek);
                  const itemIsPartner = item.ownerTag === 'partner';
                  return (
                    <TouchableOpacity
                      key={`${item.id}-${idx}`}
                      style={[
                        styles.multiTabChip,
                        selected && styles.multiTabChipActive,
                        selected && itemIsPartner && styles.multiTabChipPartnerActive,
                      ]}
                      onPress={() => setActiveIndex(idx)}
                    >
                      <View style={styles.multiTabBadges}>
                        {courses.some((c) => c.ownerTag === 'partner') && (
                          <View
                            style={[
                              styles.ownerMiniBadge,
                              itemIsPartner ? styles.ownerMiniPartner : styles.ownerMiniMine,
                            ]}
                          >
                            <Text
                              style={[
                                styles.ownerMiniText,
                                { color: itemIsPartner ? '#BE185D' : '#0369A1' },
                              ]}
                            >
                              {itemIsPartner ? partnerName : '我'}
                            </Text>
                          </View>
                        )}
                        <View
                          style={[
                            styles.weekMiniBadge,
                            itemInWeek ? styles.weekMiniCurrent : styles.weekMiniNonCurrent,
                          ]}
                        >
                          <Text
                            style={[
                              styles.weekMiniText,
                              { color: itemInWeek ? '#065F46' : '#64748B' },
                            ]}
                          >
                            {itemInWeek ? '本周' : '非本周'}
                          </Text>
                        </View>
                      </View>
                      <Text
                        style={[
                          styles.multiTabName,
                          selected && { color: itemIsPartner ? '#9D174D' : COLORS.oceanDeep },
                        ]}
                        numberOfLines={1}
                      >
                        {item.name}
                      </Text>
                      <Text style={styles.multiTabSec} numberOfLines={1}>
                        第{item.startSection}-{item.endSection}节 · {item.weekText}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {/* Course Title Banner */}
          <View style={[styles.banner, { backgroundColor: theme.bg, borderColor: theme.border }]}>
            <View style={{ flex: 1 }}>
              <View style={styles.bannerTagRow}>
                {isPartnerCourse && (
                  <View style={styles.partnerPill}>
                    <Ionicons name="heart" size={10} color={COLORS.white} />
                    <Text style={styles.partnerPillText}>{partnerName} 的课程</Text>
                  </View>
                )}
                <View
                  style={[
                    styles.weekStatusPill,
                    isCurrentWeek ? styles.weekStatusActive : styles.weekStatusInactive,
                  ]}
                >
                  <Text
                    style={[
                      styles.weekStatusText,
                      { color: isCurrentWeek ? '#065F46' : '#475569' },
                    ]}
                  >
                    {isCurrentWeek
                      ? `第 ${selectedWeek} 周上课`
                      : `第 ${selectedWeek} 周无课（非本周）`}
                  </Text>
                </View>
                {course.isManual && (
                  <View style={styles.manualPill}>
                    <Text style={styles.manualPillText}>手动添加</Text>
                  </View>
                )}
              </View>

              <Text style={[styles.courseTitle, { color: theme.text }]}>{course.name}</Text>
              {course.code || course.credit ? (
                <Text style={[styles.courseCode, { color: theme.subtext }]}>
                  {course.code ? `课程号：${course.code}` : '自定义课程'}
                  {course.credit ? ` · ${course.credit} 学分` : ''}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close-circle" size={26} color={theme.subtext} />
            </TouchableOpacity>
          </View>

          <View style={styles.metaList}>
            <MetaRow
              icon="time-outline"
              label="上课时间"
              value={`${dayLabel} ${
                course.startSection === course.endSection
                  ? `第 ${course.startSection} 节`
                  : `第 ${course.startSection}-${course.endSection} 节`
              }（${startText} - ${endText}）`}
            />
            <MetaRow
              icon="location-outline"
              label="上课地点"
              value={[course.campus, course.location].filter(Boolean).join(' · ')}
            />
            <MetaRow icon="person-outline" label="授课教师" value={course.teacher} />
            <MetaRow
              icon="calendar-outline"
              label="教学周次"
              value={`${course.weekText}（共 ${course.weeks.length} 周）`}
            />
            {course.classGroup ? (
              <MetaRow icon="people-outline" label="教学班级" value={course.classGroup} />
            ) : null}
          </View>

          <Text style={styles.leadTitle}>闹钟提前时间</Text>
          <View style={styles.leadRow}>
            {LEAD_OPTIONS.map((m) => (
              <TouchableOpacity
                key={m}
                style={[styles.leadChip, leadMinutes === m && styles.leadChipActive]}
                onPress={() => setLeadMinutes(m)}
              >
                <Text style={[styles.leadChipText, leadMinutes === m && styles.leadChipTextActive]}>
                  提前 {m} 分
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.calendarBtn]}
              onPress={handleAddToCalendar}
              disabled={busy}
            >
              <Ionicons name="calendar" size={18} color={COLORS.white} />
              <Text style={styles.actionBtnText}>添加到系统日历</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.alarmBtn]}
              onPress={handleScheduleNotificationAlarm}
              disabled={busy}
            >
              <Ionicons name="alarm" size={18} color={COLORS.white} />
              <Text style={styles.actionBtnText}>
                {Platform.OS === 'android'
                  ? `直接设为手机系统闹钟（提前 ${leadMinutes} 分）`
                  : `直接设为 iOS 系统闹钟（提前 ${leadMinutes} 分）`}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.sysClockBtn]}
              onPress={handleOpenSystemClockEditor}
              disabled={busy}
            >
              <Ionicons name="time" size={18} color={COLORS.oceanDeep} />
              <Text style={[styles.actionBtnText, { color: COLORS.oceanDeep }]}>
                {Platform.OS === 'android'
                  ? '打开系统闹钟面板手动微调铃声'
                  : '检查 iOS 系统闹钟说明与权限'}
              </Text>
            </TouchableOpacity>

            <View style={styles.bottomSubRow}>
              {onAddManualCourseInSlot && (
                <TouchableOpacity
                  style={styles.subSlotBtn}
                  onPress={() => {
                    const d = course.dayOfWeek;
                    const s = course.startSection;
                    const e = course.endSection;
                    onClose();
                    onAddManualCourseInSlot(d, s, e);
                  }}
                >
                  <Ionicons name="add-circle-outline" size={15} color={COLORS.oceanPrimary} />
                  <Text style={styles.subSlotBtnText}>在此时段再加一节课</Text>
                </TouchableOpacity>
              )}

              {course.isManual && !isPartnerCourse && onDeleteManualCourse && (
                <TouchableOpacity style={styles.deleteManualBtn} onPress={handleConfirmDeleteManual}>
                  <Ionicons name="trash-outline" size={15} color={COLORS.danger} />
                  <Text style={styles.deleteManualText}>删除此手动课程</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const MetaRow: React.FC<{
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}> = ({ icon, label, value }) => (
  <View style={styles.metaRow}>
    <Ionicons name={icon} size={17} color={COLORS.oceanPrimary} />
    <Text style={styles.metaLabel}>{label}</Text>
    <Text style={styles.metaValue}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.48)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 18,
    paddingBottom: Platform.OS === 'ios' ? 32 : 20,
    maxHeight: '88%',
  },
  multiWrap: {
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 12,
  },
  multiTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  multiTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flex: 1,
  },
  multiTitleText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  multiPagerBtns: {
    flexDirection: 'row',
    gap: 6,
  },
  pagerBtn: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  multiTabsScroll: {
    gap: 8,
  },
  multiTabChip: {
    width: 148,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  multiTabChipActive: {
    backgroundColor: COLORS.oceanTint,
    borderColor: COLORS.oceanPrimary,
    borderWidth: 1.5,
  },
  multiTabChipPartnerActive: {
    backgroundColor: '#FDF2F8',
    borderColor: '#EC4899',
  },
  multiTabBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 3,
  },
  ownerMiniBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  ownerMiniMine: {
    backgroundColor: '#E0F2FE',
  },
  ownerMiniPartner: {
    backgroundColor: '#FCE7F3',
  },
  ownerMiniText: {
    fontSize: 9.5,
    fontWeight: '800',
  },
  weekMiniBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  weekMiniCurrent: {
    backgroundColor: '#D1FAE5',
  },
  weekMiniNonCurrent: {
    backgroundColor: '#F1F5F9',
  },
  weekMiniText: {
    fontSize: 9.5,
    fontWeight: '700',
  },
  multiTabName: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  multiTabSec: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 14,
    gap: 10,
  },
  bannerTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  partnerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#EC4899',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  partnerPillText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: COLORS.white,
  },
  weekStatusPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  weekStatusActive: {
    backgroundColor: '#D1FAE5',
  },
  weekStatusInactive: {
    backgroundColor: '#E2E8F0',
  },
  weekStatusText: {
    fontSize: 10.5,
    fontWeight: '700',
  },
  manualPill: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  manualPillText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: '#92400E',
  },
  courseTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  courseCode: {
    fontSize: 12,
    marginTop: 4,
  },
  metaList: {
    gap: 10,
    marginBottom: 14,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metaLabel: {
    fontSize: 13,
    color: COLORS.textMuted,
    width: 64,
  },
  metaValue: {
    flex: 1,
    fontSize: 14,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  leadTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: 8,
  },
  leadRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  leadChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  leadChipActive: {
    backgroundColor: COLORS.oceanLight,
    borderColor: COLORS.oceanPrimary,
  },
  leadChipText: {
    fontSize: 12,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  leadChipTextActive: {
    color: COLORS.oceanPrimary,
  },
  actions: {
    gap: 9,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 44,
    borderRadius: 12,
    gap: 8,
  },
  calendarBtn: {
    backgroundColor: COLORS.oceanPrimary,
  },
  alarmBtn: {
    backgroundColor: COLORS.coral,
  },
  sysClockBtn: {
    backgroundColor: COLORS.oceanTint,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
  },
  actionBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
  bottomSubRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
    gap: 8,
  },
  subSlotBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
    borderRadius: 10,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 5,
  },
  subSlotBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.oceanPrimary,
  },
  deleteManualBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: COLORS.dangerLight,
    gap: 4,
  },
  deleteManualText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.danger,
  },
});
