import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { CoupleScheduleModal } from '../components/CoupleScheduleModal';
import { CourseDetailModal } from '../components/CourseDetailModal';
import { ManualCourseModal } from '../components/ManualCourseModal';
import {
  DAY_LABELS,
  getActivePeriods,
} from '../constants/gdouTimetable';
import {
  createWeeklyMorningWakeupAlarms,
  openAppSystemSettings,
} from '../services/alarmService';
import { openSystemClockOrGuide, showAlarmErrorAlert } from '../services/alarmUiHelper';
import { syncAllCoursesToCalendar } from '../services/calendarService';
import {
  computeTermWeek,
  formatShortDate,
  getCourseTimeSpan,
  getDateForWeekAndDay,
  getTodayDayOfWeek,
  isCourseSchedulable,
} from '../services/scheduleParser';
import {
  buildTimetableClusters,
  computeCoupleScheduleInsights,
  TimetableSlotCluster,
} from '../services/timetableCluster';
import { COLORS, COURSE_PALETTE } from '../theme/colors';
import {
  AlarmRule,
  AppSettings,
  CoupleScheduleProfile,
  CourseItem,
  ScheduleViewMode,
} from '../types/models';

const TIME_COL_WIDTH = 46;
const ROW_HEIGHT = 62;
const MIN_VISIBLE_SECTIONS = 12;

const NON_CURRENT_THEME = {
  bg: '#F1F5F9',
  border: '#94A3B8',
  text: '#475569',
  subtext: '#64748B',
};

const PARTNER_CURRENT_THEME = {
  bg: '#FCE7F3',
  border: '#EC4899',
  text: '#831843',
  subtext: '#BE185D',
};

const COUPLE_TOGETHER_THEME = {
  bg: '#FFF1F2',
  border: '#E11D48',
  text: '#881337',
  subtext: '#BE123C',
};

interface Props {
  courses: CourseItem[];
  coupleSchedule: CoupleScheduleProfile | null;
  alarms: AlarmRule[];
  termLabel: string;
  settings: AppSettings;
  onOpenSync: () => void;
  onOpenPartnerSync: (partnerNickname: string) => void;
  onLoadSampleData: () => void;
  onAlarmsAdded: (alarms: AlarmRule[]) => void;
  onUpdateSettings: (next: AppSettings) => void;
  onSaveCoupleSchedule: (profile: CoupleScheduleProfile | null) => void;
  onAddManualCourse: (course: CourseItem) => void;
  onDeleteManualCourse: (courseId: string) => void;
}

export const ScheduleScreen: React.FC<Props> = ({
  courses,
  coupleSchedule,
  alarms,
  termLabel,
  settings,
  onOpenSync,
  onOpenPartnerSync,
  onLoadSampleData,
  onAlarmsAdded,
  onUpdateSettings,
  onSaveCoupleSchedule,
  onAddManualCourse,
  onDeleteManualCourse,
}) => {
  const { width: screenWidth } = useWindowDimensions();
  const currentWeek = useMemo(
    () => Math.min(settings.totalWeeks, Math.max(1, computeTermWeek(settings.termStartDate))),
    [settings.termStartDate, settings.totalWeeks]
  );
  const [selectedWeek, setSelectedWeek] = useState<number>(currentWeek);
  const [viewMode, setViewMode] = useState<ScheduleViewMode>('mine');
  const [activeModalCourses, setActiveModalCourses] = useState<CourseItem[]>([]);
  const [coupleModalOpen, setCoupleModalOpen] = useState(false);
  const [manualModalState, setManualModalState] = useState<{
    visible: boolean;
    dayOfWeek: number;
    startSection: number;
    endSection: number;
  }>({ visible: false, dayOfWeek: 1, startSection: 1, endSection: 2 });
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    setSelectedWeek(currentWeek);
  }, [currentWeek]);

  // Automatically revert to 'mine' if partner schedule is unbound while in couple/partner mode
  useEffect(() => {
    if (!coupleSchedule && viewMode !== 'mine') {
      setViewMode('mine');
    }
  }, [coupleSchedule, viewMode]);

  const partnerName = coupleSchedule?.partnerName || 'TA';
  const partnerCourses = coupleSchedule?.courses ?? [];
  const showNonCurrentWeek = settings.showNonCurrentWeekCourses !== false;

  const periods = useMemo(() => getActivePeriods(settings), [settings]);
  const visibleSections = useMemo(() => {
    const allCourses = [...courses, ...partnerCourses];
    const maxCourseSec = allCourses.reduce((acc, c) => Math.max(acc, c.endSection || 0), 0);
    const maxPeriodSec = periods.reduce((acc, p) => Math.max(acc, p.section || 0), 0);
    return Math.max(MIN_VISIBLE_SECTIONS, maxCourseSec, maxPeriodSec);
  }, [courses, partnerCourses, periods]);

  const todayDow = getTodayDayOfWeek();
  const colWidth = Math.max(38, Math.floor((screenWidth - TIME_COL_WIDTH - 12) / 7));

  const weekDates = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        getDateForWeekAndDay(settings.termStartDate, selectedWeek, i + 1)
      ),
    [settings.termStartDate, selectedWeek]
  );

  const weekCourses = useMemo(
    () => courses.filter((c) => isCourseSchedulable(c) && c.weeks.includes(selectedWeek)),
    [courses, selectedWeek]
  );

  const clusters = useMemo(
    () =>
      buildTimetableClusters({
        myCourses: courses,
        partnerCourses,
        selectedWeek,
        showNonCurrentWeek,
        viewMode,
      }),
    [courses, partnerCourses, selectedWeek, showNonCurrentWeek, viewMode]
  );

  const coupleInsights = useMemo(() => {
    if (!coupleSchedule) return null;
    return computeCoupleScheduleInsights({
      myCourses: courses,
      partnerCourses,
      partnerName,
      selectedWeek,
      currentWeek,
      periods,
    });
  }, [coupleSchedule, courses, partnerCourses, partnerName, selectedWeek, currentWeek, periods]);

  const unparsedCourses = useMemo(
    () => courses.filter((c) => !isCourseSchedulable(c)),
    [courses]
  );

  const todayCourses = useMemo(() => {
    const base = viewMode === 'partner' ? partnerCourses : courses;
    return base
      .filter(
        (c) =>
          isCourseSchedulable(c) && c.weeks.includes(currentWeek) && c.dayOfWeek === todayDow
      )
      .sort((a, b) => a.startSection - b.startSection)
      .map((c) => ({ ...c, ownerTag: viewMode === 'partner' ? ('partner' as const) : ('mine' as const) }));
  }, [courses, partnerCourses, viewMode, currentWeek, todayDow]);

  const handleToggleNonCurrentWeek = () => {
    onUpdateSettings({
      ...settings,
      showNonCurrentWeekCourses: !showNonCurrentWeek,
    });
  };

  const handlePressCoupleModeBtn = (targetMode: ScheduleViewMode) => {
    if (!coupleSchedule && targetMode !== 'mine') {
      setCoupleModalOpen(true);
      return;
    }
    setViewMode(targetMode);
  };

  const handleQuickCalendarSync = async () => {
    if (courses.length === 0) {
      Alert.alert('暂无课表', '请先同步海大教务课表或加载示例预览。');
      return;
    }
    setBusyAction('calendar');
    try {
      const res = await syncAllCoursesToCalendar(courses, settings, { replaceExisting: true });
      const totalWritten = res.eventsCreated + res.eventsUpdated;
      const modeNote = res.isDedicated
        ? `专属日历「${res.calendarTitle}」`
        : `系统日历「${res.calendarTitle}」（系统限制新建独立日历，已自动兼容写入并按标签隔离）`;
      const extra = [
        res.eventsUpdated > 0 ? `原位更新 ${res.eventsUpdated} 条` : '',
        res.eventsRemoved > 0 ? `清理旧日程 ${res.eventsRemoved} 条` : '',
        res.skippedUnparsed > 0 ? `已跳过 ${res.skippedUnparsed} 门时间未解析课程` : '',
        res.failed > 0 ? `有 ${res.failed} 条日程写入失败` : '',
      ]
        .filter(Boolean)
        .join('；');
      Alert.alert(
        '整学期课表已导入系统日历',
        `已同步至${modeNote}（保留原有考试安排），共处理 ${totalWritten} 条上课日程（新增 ${res.eventsCreated} 条），均已配置课前 ${settings.defaultCalendarReminderMinutes} 分钟提醒。${
          extra ? `\n\n详情：${extra}` : ''
        }`
      );
    } catch (err) {
      Alert.alert('同步日历失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleQuickWakeupAlarms = async () => {
    if (weekCourses.length === 0) {
      Alert.alert('本周无课程', `第 ${selectedWeek} 周暂无排课，无法生成起床闹钟。`);
      return;
    }
    setBusyAction('alarm');
    try {
      const {
        created,
        systemClockGroupsCount,
        systemEngine,
        replacedCount,
        skippedPast,
        failed,
        exactAlarmHint,
        fallbackReason,
      } = await createWeeklyMorningWakeupAlarms(
        courses,
        selectedWeek,
        settings.defaultWakeupMinutes,
        settings,
        alarms
      );
      if (created.length > 0) {
        onAlarmsAdded(created);
      }
      const dedupeNote = replacedCount > 0 ? `（已自动更新 ${replacedCount} 条旧记录）` : '';
      const failNote = failed > 0 ? `（另有 ${failed} 条创建失败）` : '';
      const hintNote = exactAlarmHint ? `\n\n${exactAlarmHint}` : '';
      const fallbackNote =
        Platform.OS === 'ios' && systemEngine !== 'ios_alarmkit' && fallbackReason
          ? `\n\n说明：${fallbackReason}，已改用每周循环系统铃声提醒。`
          : '';
      const sysMsg =
        Platform.OS === 'android' && systemClockGroupsCount > 0
          ? `已直接写入手机系统闹钟 ${systemClockGroupsCount} 组（同唤醒时间点已自动合并星期，首节课提前 ${settings.defaultWakeupMinutes} 分钟响铃）${dedupeNote}${failNote}。`
          : Platform.OS === 'ios' && systemEngine === 'ios_alarmkit' && systemClockGroupsCount > 0
            ? `已直接写入 iOS 原生系统级闹钟（AlarmKit）${systemClockGroupsCount} 条（每周循环、锁屏全屏响铃并穿透静音/专注模式，首节课提前 ${settings.defaultWakeupMinutes} 分钟）${dedupeNote}${failNote}。`
            : created.length > 0
              ? `已为第 ${selectedWeek} 周配置 ${created.length} 个每日首课起床闹钟（提前 ${settings.defaultWakeupMinutes} 分钟响铃）${dedupeNote}${
                  skippedPast > 0 ? `，已跳过 ${skippedPast} 个过去时段` : ''
                }${failNote}。${hintNote}${fallbackNote}`
              : `第 ${selectedWeek} 周暂无排课，请切换到有课周次后生成。`;

      Alert.alert(
        systemEngine === 'ios_alarmkit' ? 'iOS 系统早起闹钟已写入' : '系统早起闹钟设置完成',
        sysMsg,
        Platform.OS === 'ios'
          ? [
              { text: '好的', style: 'cancel' },
              {
                text: '系统权限设置',
                onPress: () => void openAppSystemSettings(),
              },
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
      showAlarmErrorAlert('设置系统闹钟失败', err);
    } finally {
      setBusyAction(null);
    }
  };

  const renderClusterCard = (cluster: TimetableSlotCluster) => {
    const { primary, items, startSection, endSection, dayOfWeek } = cluster;
    const spanCount = Math.max(1, endSection - startSection + 1);
    const top = (startSection - 1) * ROW_HEIGHT + 2;
    const height = spanCount * ROW_HEIGHT - 4;
    const left = (dayOfWeek - 1) * colWidth + 2;
    const width = colWidth - 4;
    const totalInSlot = items.length;

    let theme = COURSE_PALETTE[primary.course.colorIndex % COURSE_PALETTE.length];
    if (!primary.isCurrentWeek) {
      theme = NON_CURRENT_THEME;
    } else if (cluster.isSameCourseTogether && viewMode === 'couple') {
      theme = COUPLE_TOGETHER_THEME;
    } else if (primary.owner === 'partner') {
      theme = PARTNER_CURRENT_THEME;
    }

    // In Couple Split Mode, check if BOTH mine & partner have courses in this cluster
    const myTopItem = items.find((i) => i.owner === 'mine');
    const partnerTopItem = items.find((i) => i.owner === 'partner');
    const showDualPartnerRows =
      viewMode === 'couple' &&
      Boolean(myTopItem) &&
      Boolean(partnerTopItem) &&
      !cluster.isSameCourseTogether;

    const secondCurrentWeekItem = cluster.hasSameWeekConflict
      ? items.find((i, idx) => idx > 0 && i.isCurrentWeek) ?? null
      : null;

    // Normal-flow status indicators (ZERO absolute overlay & ZERO horizontal paddingRight squeezing!):
    // - Urgent/multi-course badges (`同堂`, `撞课N`, couple `N节▾`) render as slim full-width top pills
    //   above the course title so the title always keeps 100% of the card width.
    // - Non-current-week companion hint (`含他周`) renders as a slim bottom footer pill (`marginTop: 'auto'`)
    //   so current-week course name & room stay cleanly anchored at full width at the top.
    // - Standalone non-current-week multi-course slots fold count directly into the prefix tag (`非本周·N门`).
    let topBadgeText: string | null = null;
    let topBadgeBg = COLORS.oceanPrimary;
    let topBadgeTextColor = COLORS.white;
    let bottomOtherWeekText: string | null = null;

    if (cluster.isSameCourseTogether && viewMode === 'couple') {
      topBadgeText = cluster.currentWeekCount > 2 ? `同堂·${cluster.currentWeekCount}` : '💞同堂';
      topBadgeBg = '#E11D48';
    } else if (cluster.hasSameWeekConflict) {
      topBadgeText = `撞课${cluster.currentWeekCount}`;
      topBadgeBg = COLORS.coral;
    } else if (viewMode === 'couple' && cluster.hasBothPartnersInWeek && totalInSlot > 2) {
      topBadgeText = `${cluster.currentWeekCount}节▾`;
      topBadgeBg = '#DB2777';
    } else if (primary.isCurrentWeek && cluster.nonCurrentWeekCount > 0) {
      bottomOtherWeekText =
        cluster.nonCurrentWeekCount > 1 ? `他周+${cluster.nonCurrentWeekCount}` : '含他周';
    }

    const nameMaxLines = secondCurrentWeekItem
      ? 2
      : spanCount >= 3
        ? 4
        : spanCount === 2
          ? topBadgeText
            ? 2
            : 3
          : 2;

    return (
      <TouchableOpacity
        key={cluster.id}
        activeOpacity={0.84}
        onPress={() => setActiveModalCourses(items.map((i) => i.course))}
        style={[
          styles.courseCard,
          !primary.isCurrentWeek && styles.courseCardNonCurrent,
          cluster.hasSameWeekConflict && styles.courseCardStacked,
          {
            top,
            left,
            width,
            height,
            backgroundColor: theme.bg,
            borderLeftColor: theme.border,
          },
        ]}
      >
        {/* Slim normal-flow top status pill (never floats over or horizontally squeezes title) */}
        {topBadgeText && (
          <View style={[styles.inlineTopBadge, { backgroundColor: topBadgeBg }]}>
            <Text
              style={[styles.inlineTopBadgeText, { color: topBadgeTextColor }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.1}
            >
              {topBadgeText}
            </Text>
          </View>
        )}

        {showDualPartnerRows && myTopItem && partnerTopItem ? (
          <View style={styles.dualPartnerWrap}>
            <View style={[styles.dualHalfBox, !myTopItem.isCurrentWeek && { opacity: 0.65 }]}>
              <Text style={styles.dualMineTag} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                我{!myTopItem.isCurrentWeek ? '(非)' : ''}
              </Text>
              <Text
                style={styles.dualMineName}
                numberOfLines={spanCount >= 3 ? 2 : 1}
                maxFontSizeMultiplier={1.1}
              >
                {myTopItem.course.name}
              </Text>
              <Text style={styles.dualRoomText} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                @{myTopItem.course.location}
              </Text>
            </View>
            <View style={styles.dualDivider} />
            <View style={[styles.dualHalfBox, !partnerTopItem.isCurrentWeek && { opacity: 0.65 }]}>
              <Text style={styles.dualPartnerTag} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                {partnerName}{!partnerTopItem.isCurrentWeek ? '(非)' : ''}
              </Text>
              <Text
                style={styles.dualPartnerName}
                numberOfLines={spanCount >= 3 ? 2 : 1}
                maxFontSizeMultiplier={1.1}
              >
                {partnerTopItem.course.name}
              </Text>
              <Text style={styles.dualRoomText} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                @{partnerTopItem.course.location}
              </Text>
            </View>
          </View>
        ) : (
          <>
            {/* Owner / Non-current-week prefix tag */}
            {(!primary.isCurrentWeek || viewMode === 'couple') && (
              <Text
                style={[
                  styles.prefixTagText,
                  {
                    color: !primary.isCurrentWeek
                      ? '#64748B'
                      : primary.owner === 'partner'
                        ? '#BE185D'
                        : '#0369A1',
                  },
                ]}
                numberOfLines={1}
                maxFontSizeMultiplier={1.1}
              >
                {viewMode === 'couple'
                  ? cluster.isSameCourseTogether
                    ? '我+TA'
                    : primary.owner === 'partner'
                      ? `${partnerName}${!primary.isCurrentWeek ? '·非本周' : ''}`
                      : `我${!primary.isCurrentWeek ? '·非本周' : ''}`
                  : totalInSlot >= 2
                    ? `非本周·${totalInSlot}门`
                    : '非本周'}
              </Text>
            )}

            <Text
              style={[styles.cardName, { color: theme.text }]}
              numberOfLines={nameMaxLines}
              maxFontSizeMultiplier={1.15}
            >
              {primary.course.name}
            </Text>

            <Text
              style={[styles.cardRoom, { color: theme.subtext }]}
              numberOfLines={spanCount >= 3 ? 2 : 1}
              maxFontSizeMultiplier={1.1}
            >
              @{primary.course.location}
            </Text>

            {!primary.isCurrentWeek && !secondCurrentWeekItem && (
              <Text style={styles.nonWeekRangeText} numberOfLines={1} maxFontSizeMultiplier={1.1}>
                {primary.course.weekText}
              </Text>
            )}

            {primary.isCurrentWeek &&
              !secondCurrentWeekItem &&
              (spanCount >= 3 || (spanCount >= 2 && !topBadgeText)) && (
                <Text
                  style={[styles.cardTeacher, { color: theme.subtext }]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.1}
                >
                  {primary.course.teacher}
                </Text>
              )}

            {/* Preview strip ONLY when >= 2 courses are BOTH taught in the current selectedWeek */}
            {secondCurrentWeekItem && spanCount >= 2 && (
              <View style={styles.secondCourseStrip}>
                <Text
                  style={styles.secondCourseStripText}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.1}
                >
                  +{secondCurrentWeekItem.course.name}
                </Text>
              </View>
            )}

            {/* Bottom slim indicator when another week's course shares this slot (zero squeeze on title!) */}
            {bottomOtherWeekText && !secondCurrentWeekItem && (
              <View style={styles.otherWeekFooterPill}>
                <Text
                  style={styles.otherWeekFooterText}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.05}
                >
                  {bottomOtherWeekText}
                </Text>
              </View>
            )}
          </>
        )}
      </TouchableOpacity>
    );
  };

  const hasAnyCourses = courses.length > 0 || Boolean(coupleSchedule);

  return (
    <View style={styles.root}>
      {/* Top Ocean / Couple Header */}
      <View style={[styles.header, viewMode !== 'mine' && styles.headerCoupleTint]}>
        <View style={styles.headerTopRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.termSub}>
              {viewMode === 'partner' && coupleSchedule
                ? `${partnerName}的课表 · ${coupleSchedule.termLabel}`
                : termLabel}
            </Text>
            <View style={styles.weekNavRow}>
              <TouchableOpacity
                onPress={() => setSelectedWeek((w) => Math.max(1, w - 1))}
                style={styles.weekArrow}
              >
                <Ionicons name="chevron-back" size={18} color={COLORS.white} />
              </TouchableOpacity>
              <Text style={styles.weekTitle}>
                第 {selectedWeek} 周{selectedWeek === currentWeek ? ' · 本周' : ''}
              </Text>
              <TouchableOpacity
                onPress={() => setSelectedWeek((w) => Math.min(settings.totalWeeks, w + 1))}
                style={styles.weekArrow}
              >
                <Ionicons name="chevron-forward" size={18} color={COLORS.white} />
              </TouchableOpacity>
              {selectedWeek !== currentWeek && (
                <TouchableOpacity
                  onPress={() => setSelectedWeek(currentWeek)}
                  style={styles.backToNowBtn}
                >
                  <Text style={styles.backToNowText}>回本周</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <TouchableOpacity style={styles.syncHeaderBtn} onPress={onOpenSync}>
            <Ionicons name="shield-checkmark-outline" size={15} color={COLORS.oceanDeep} />
            <Text style={styles.syncHeaderBtnText}>无痕同步</Text>
          </TouchableOpacity>
        </View>

        {/* Mode & View Switcher Bar: Non-Current-Week + Couple Mode + Manual Add */}
        <View style={styles.modeFilterBar}>
          {/* Couple Mode Segment */}
          <View style={styles.coupleSegment}>
            <TouchableOpacity
              style={[styles.segBtn, viewMode === 'mine' && styles.segBtnActive]}
              onPress={() => handlePressCoupleModeBtn('mine')}
            >
              <Text style={[styles.segBtnText, viewMode === 'mine' && styles.segBtnTextActive]}>
                我的
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segBtn, viewMode === 'couple' && styles.segBtnCoupleActive]}
              onPress={() => handlePressCoupleModeBtn('couple')}
            >
              <Ionicons
                name="heart"
                size={11}
                color={viewMode === 'couple' ? '#BE185D' : '#FBCFE8'}
              />
              <Text
                style={[
                  styles.segBtnText,
                  viewMode === 'couple' && styles.segBtnTextCoupleActive,
                ]}
              >
                情侣同屏
              </Text>
            </TouchableOpacity>
            {coupleSchedule && (
              <TouchableOpacity
                style={[styles.segBtn, viewMode === 'partner' && styles.segBtnCoupleActive]}
                onPress={() => handlePressCoupleModeBtn('partner')}
              >
                <Text
                  style={[
                    styles.segBtnText,
                    viewMode === 'partner' && styles.segBtnTextCoupleActive,
                  ]}
                  numberOfLines={1}
                >
                  {partnerName}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.coupleGearBtn}
              onPress={() => setCoupleModalOpen(true)}
              hitSlop={6}
            >
              <Ionicons name="options-outline" size={14} color="#FCE7F3" />
            </TouchableOpacity>
          </View>

          {/* Non-current-week toggle */}
          <TouchableOpacity
            style={[
              styles.filterTogglePill,
              showNonCurrentWeek && styles.filterTogglePillActive,
            ]}
            onPress={handleToggleNonCurrentWeek}
          >
            <Ionicons
              name={showNonCurrentWeek ? 'eye' : 'eye-off-outline'}
              size={13}
              color={showNonCurrentWeek ? COLORS.oceanDeep : '#CBD5E1'}
            />
            <Text
              style={[
                styles.filterToggleText,
                showNonCurrentWeek && styles.filterToggleTextActive,
              ]}
            >
              非本周
            </Text>
          </TouchableOpacity>

          {/* Manual add course quick button */}
          <TouchableOpacity
            style={styles.addCourseHeaderPill}
            onPress={() =>
              setManualModalState({
                visible: true,
                dayOfWeek: todayDow,
                startSection: 1,
                endSection: 2,
              })
            }
          >
            <Ionicons name="add" size={15} color={COLORS.white} />
            <Text style={styles.addCourseHeaderText}>加课</Text>
          </TouchableOpacity>
        </View>

        {/* Quick Action Pills */}
        <View style={styles.quickRow}>
          <TouchableOpacity
            style={styles.quickPill}
            onPress={handleQuickCalendarSync}
            disabled={busyAction !== null}
          >
            <Ionicons name="calendar-outline" size={14} color={COLORS.white} />
            <Text style={styles.quickPillText}>
              {busyAction === 'calendar' ? '写入中...' : '全学期导入日历'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.quickPill}
            onPress={handleQuickWakeupAlarms}
            disabled={busyAction !== null}
          >
            <Ionicons name="alarm-outline" size={14} color={COLORS.white} />
            <Text style={styles.quickPillText}>
              {busyAction === 'alarm' ? '写入中...' : '一键本周系统早起闹钟'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {!hasAnyCourses ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="school-outline" size={44} color={COLORS.oceanPrimary} />
          </View>
          <Text style={styles.emptyTitle}>欢迎使用海大课表</Text>
          <Text style={styles.emptyDesc}>
            支持一键同步广东海洋大学教务课表、考试安排、绩点学分与情侣双人课表。账号密码仅在拉取时临时验证，拉取完成立即销毁，本地零留存。
          </Text>
          <TouchableOpacity style={styles.emptyPrimaryBtn} onPress={onOpenSync}>
            <Ionicons name="cloud-download-outline" size={19} color={COLORS.white} />
            <Text style={styles.emptyPrimaryText}>登录海大教务同步数据（用完即删）</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.emptySecondaryBtn} onPress={onLoadSampleData}>
            <Ionicons name="sparkles-outline" size={17} color={COLORS.oceanPrimary} />
            <Text style={styles.emptySecondaryText}>加载海大示例数据体验课表 / 情侣同屏 / 绩点</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.emptySecondaryBtn, { borderColor: '#FBCFE8', backgroundColor: '#FDF2F8' }]}
            onPress={() => setCoupleModalOpen(true)}
          >
            <Ionicons name="heart-outline" size={17} color="#DB2777" />
            <Text style={[styles.emptySecondaryText, { color: '#DB2777' }]}>
              开启情侣课表（口令互传 / 面对面代拉取）
            </Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 16, fontWeight: '600' }}>
            powered by 种果仁
          </Text>
        </View>
      ) : (
        <>
          {/* Couple Live Status & Weekly Insights Banner */}
          {viewMode !== 'mine' && coupleSchedule && coupleInsights && (
            <TouchableOpacity
              style={styles.coupleInsightBanner}
              activeOpacity={0.85}
              onPress={() => setCoupleModalOpen(true)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.coupleHeadline} numberOfLines={1}>
                  {coupleInsights.liveHeadline}
                </Text>
                <Text style={styles.coupleSubline} numberOfLines={1}>
                  {coupleInsights.liveSubline}
                  {coupleInsights.togetherSessionsCount > 0
                    ? ` · 同堂 ${coupleInsights.togetherSessionsCount} 节`
                    : ''}
                  {coupleInsights.sameBuildingSessionsCount > 0
                    ? ` · 同楼 ${coupleInsights.sameBuildingSessionsCount} 次`
                    : ''}
                </Text>
              </View>
              <View style={styles.coupleManageBadge}>
                <Text style={styles.coupleManageText}>管理</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Unparsed courses explicit warning banner */}
          {viewMode === 'mine' && unparsedCourses.length > 0 && (
            <View style={styles.unparsedBanner}>
              <Ionicons name="warning-outline" size={14} color={COLORS.amber} />
              <Text style={{ flex: 1, fontSize: 11, color: '#92400E' }} numberOfLines={2}>
                有 {unparsedCourses.length} 门课程缺少星期/节次/周次（
                {unparsedCourses.map((c) => c.name).slice(0, 2).join('、')}
                ），已跳过网格与日历导出。
              </Text>
            </View>
          )}

          {/* Today's Spotlight */}
          {viewMode !== 'couple' && todayCourses.length > 0 && (
            <View style={styles.todayBanner}>
              <View style={styles.todayBadge}>
                <Text style={styles.todayBadgeText}>
                  {viewMode === 'partner' ? `${partnerName}今日` : '今日'} {todayCourses.length} 节
                </Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {todayCourses.map((c) => {
                  const span = getCourseTimeSpan(c, periods);
                  const overlappingToday = todayCourses.filter(
                    (other) =>
                      other.startSection <= c.endSection && c.startSection <= other.endSection
                  );
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.todayChip}
                      onPress={() => setActiveModalCourses(overlappingToday)}
                    >
                      <Text style={styles.todayChipTitle} numberOfLines={1}>
                        {span.startText} {c.name}
                      </Text>
                      <Text style={styles.todayChipSub} numberOfLines={1}>
                        {c.location}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          )}

          {/* Weekday Header Row */}
          <View style={styles.dayHeaderRow}>
            <View style={{ width: TIME_COL_WIDTH, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={styles.monthLabel}>
                {weekDates[0].getMonth() + 1}月
              </Text>
            </View>
            {DAY_LABELS.map((label, idx) => {
              const isToday = selectedWeek === currentWeek && idx + 1 === todayDow;
              return (
                <View
                  key={label}
                  style={[
                    styles.dayHeaderCell,
                    { width: colWidth },
                    isToday && styles.dayHeaderCellToday,
                  ]}
                >
                  <Text style={[styles.dayHeaderText, isToday && styles.dayHeaderTextToday]}>
                    周{label}
                  </Text>
                  <Text style={[styles.dayDateText, isToday && styles.dayDateTextToday]}>
                    {formatShortDate(weekDates[idx])}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Timetable Grid */}
          <ScrollView style={styles.gridScroll} contentContainerStyle={{ paddingBottom: 24 }}>
            <View style={styles.gridBody}>
              {/* Left Period Column */}
              <View style={{ width: TIME_COL_WIDTH }}>
                {Array.from({ length: visibleSections }, (_, i) => {
                  const sec = i + 1;
                  const p = periods.find((item) => item.section === sec);
                  return (
                    <View key={sec} style={styles.timeCell}>
                      <Text style={styles.sectionNum}>{sec}</Text>
                      <Text style={styles.sectionTime}>{p?.start ?? ''}</Text>
                      {p?.end ? <Text style={styles.sectionEndTime}>{p.end}</Text> : null}
                    </View>
                  );
                })}
              </View>

              {/* 7-Day Columns */}
              <View style={[styles.columnsWrap, { height: visibleSections * ROW_HEIGHT }]}>
                {/* Interactive Empty Grid Cells (tap any slot to add custom course) */}
                {Array.from({ length: visibleSections }, (_, sIdx) => (
                  <View
                    key={`row-${sIdx}`}
                    style={[
                      styles.gridRowLine,
                      { top: sIdx * ROW_HEIGHT, height: ROW_HEIGHT, flexDirection: 'row' },
                    ]}
                  >
                    {Array.from({ length: 7 }, (__, dIdx) => (
                      <TouchableOpacity
                        key={`empty-${dIdx}-${sIdx}`}
                        activeOpacity={0.5}
                        style={{
                          width: colWidth,
                          height: ROW_HEIGHT,
                          borderRightWidth: StyleSheet.hairlineWidth,
                          borderRightColor: COLORS.borderLight,
                        }}
                        onPress={() => {
                          const startSec = sIdx + 1;
                          const endSec = Math.min(visibleSections, startSec + 1);
                          setManualModalState({
                            visible: true,
                            dayOfWeek: dIdx + 1,
                            startSection: startSec,
                            endSection: endSec,
                          });
                        }}
                      />
                    ))}
                  </View>
                ))}

                {/* Couple Mode Shared Free Slot Hints */}
                {viewMode === 'couple' &&
                  coupleInsights &&
                  settings.highlightCoupleFreeSlots !== false &&
                  coupleInsights.sharedFreeBlocks.map((free) => {
                    // Skip drawing free hint if a non-current-week course is occupying that spot
                    const occupiedByNonCurrent = clusters.some(
                      (cl) =>
                        cl.dayOfWeek === free.dayOfWeek &&
                        cl.startSection <= free.endSection &&
                        cl.endSection >= free.startSection
                    );
                    if (occupiedByNonCurrent) return null;
                    const top = (free.startSection - 1) * ROW_HEIGHT + 3;
                    const height = (free.endSection - free.startSection + 1) * ROW_HEIGHT - 6;
                    const left = (free.dayOfWeek - 1) * colWidth + 3;
                    const width = colWidth - 6;
                    return (
                      <View
                        key={`free-${free.dayOfWeek}-${free.startSection}`}
                        pointerEvents="none"
                        style={[styles.coupleFreeCard, { top, left, width, height }]}
                      >
                        <Text style={styles.coupleFreeText}>♡ 共同没课</Text>
                        <Text style={styles.coupleFreeSub}>{free.startText}</Text>
                      </View>
                    );
                  })}

                {/* Clustered Course Cards */}
                {clusters.map(renderClusterCard)}
              </View>
            </View>
          </ScrollView>
        </>
      )}

      <CourseDetailModal
        courses={activeModalCourses}
        selectedWeek={selectedWeek}
        settings={settings}
        partnerName={partnerName}
        existingAlarms={alarms}
        onClose={() => setActiveModalCourses([])}
        onAlarmCreated={(alarm) => onAlarmsAdded([alarm])}
        onAddManualCourseInSlot={(day, startSec, endSec) =>
          setManualModalState({
            visible: true,
            dayOfWeek: day,
            startSection: startSec,
            endSection: endSec,
          })
        }
        onDeleteManualCourse={onDeleteManualCourse}
      />

      <ManualCourseModal
        visible={manualModalState.visible}
        initialDayOfWeek={manualModalState.dayOfWeek}
        initialStartSection={manualModalState.startSection}
        initialEndSection={manualModalState.endSection}
        totalWeeks={settings.totalWeeks}
        onClose={() => setManualModalState((s) => ({ ...s, visible: false }))}
        onSave={onAddManualCourse}
      />

      <CoupleScheduleModal
        visible={coupleModalOpen}
        myCourses={courses}
        termLabel={termLabel}
        settings={settings}
        coupleSchedule={coupleSchedule}
        onClose={() => setCoupleModalOpen(false)}
        onSaveCoupleSchedule={(profile) => {
          onSaveCoupleSchedule(profile);
          if (profile) {
            setViewMode('couple');
          }
        }}
        onUpdateSettings={onUpdateSettings}
        onOpenPartnerEphemeralSync={onOpenPartnerSync}
      />
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
    paddingTop: 10,
    paddingBottom: 11,
  },
  headerCoupleTint: {
    backgroundColor: '#3B0764',
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  termSub: {
    fontSize: 11,
    color: '#93C5FD',
    fontWeight: '600',
  },
  weekNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
    gap: 6,
  },
  weekArrow: {
    padding: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  weekTitle: {
    fontSize: 17.5,
    fontWeight: '700',
    color: COLORS.white,
  },
  backToNowBtn: {
    backgroundColor: COLORS.coral,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginLeft: 2,
  },
  backToNowText: {
    fontSize: 10.5,
    fontWeight: '700',
    color: COLORS.white,
  },
  syncHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.oceanLight,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    gap: 4,
  },
  syncHeaderBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  modeFilterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 9,
    gap: 6,
  },
  coupleSegment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    padding: 2,
  },
  segBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4.5,
    paddingHorizontal: 6,
    borderRadius: 999,
    gap: 3,
  },
  segBtnActive: {
    backgroundColor: COLORS.white,
  },
  segBtnCoupleActive: {
    backgroundColor: '#FCE7F3',
  },
  segBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.85)',
  },
  segBtnTextActive: {
    color: COLORS.oceanDeep,
  },
  segBtnTextCoupleActive: {
    color: '#9D174D',
  },
  coupleGearBtn: {
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  filterTogglePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 5.5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    gap: 4,
  },
  filterTogglePillActive: {
    backgroundColor: '#BAE6FD',
  },
  filterToggleText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#CBD5E1',
  },
  filterToggleTextActive: {
    color: COLORS.oceanDeep,
  },
  addCourseHeaderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5.5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
    gap: 2,
  },
  addCourseHeaderText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.white,
  },
  quickRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  quickPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 6.5,
    borderRadius: 10,
    gap: 5,
  },
  quickPillText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: COLORS.white,
  },
  coupleInsightBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FDF2F8',
    borderBottomWidth: 1,
    borderBottomColor: '#FBCFE8',
    paddingHorizontal: 12,
    paddingVertical: 7,
    gap: 8,
  },
  coupleHeadline: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#831843',
  },
  coupleSubline: {
    fontSize: 11,
    color: '#9D174D',
    marginTop: 1,
  },
  coupleManageBadge: {
    backgroundColor: '#FCE7F3',
    borderWidth: 1,
    borderColor: '#F9A8D4',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  coupleManageText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#BE185D',
  },
  unparsedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.amberLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  emptyIconCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: COLORS.oceanLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  emptyDesc: {
    fontSize: 13,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 8,
    marginBottom: 20,
  },
  emptyPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    paddingHorizontal: 20,
    height: 48,
    borderRadius: 14,
    width: '100%',
    gap: 8,
  },
  emptyPrimaryText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
  emptySecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    paddingHorizontal: 18,
    height: 44,
    borderRadius: 12,
    width: '100%',
    marginTop: 10,
    gap: 6,
  },
  emptySecondaryText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.oceanPrimary,
  },
  todayBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 8,
  },
  todayBadge: {
    backgroundColor: COLORS.oceanTint,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  todayBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.oceanPrimary,
  },
  todayChip: {
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 8,
    maxWidth: 185,
  },
  todayChipTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  todayChipSub: {
    fontSize: 11,
    color: COLORS.textMuted,
  },
  dayHeaderRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingVertical: 6,
    paddingRight: 12,
  },
  monthLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  dayHeaderCell: {
    alignItems: 'center',
    paddingVertical: 3,
    borderRadius: 8,
  },
  dayHeaderCellToday: {
    backgroundColor: COLORS.oceanPrimary,
  },
  dayHeaderText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  dayHeaderTextToday: {
    color: COLORS.white,
  },
  dayDateText: {
    fontSize: 10,
    color: COLORS.textMuted,
    marginTop: 1,
  },
  dayDateTextToday: {
    color: '#E0F2FE',
  },
  gridScroll: {
    flex: 1,
  },
  gridBody: {
    flexDirection: 'row',
    paddingRight: 12,
  },
  timeCell: {
    height: ROW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderLight,
  },
  sectionNum: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  sectionTime: {
    fontSize: 8.5,
    color: COLORS.textSecondary,
    marginTop: 1,
    fontWeight: '600',
  },
  sectionEndTime: {
    fontSize: 8,
    color: COLORS.textMuted,
    marginTop: 0.5,
  },
  columnsWrap: {
    flex: 1,
    position: 'relative',
  },
  gridRowLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderLight,
  },
  coupleFreeCard: {
    position: 'absolute',
    borderRadius: 7,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#F9A8D4',
    backgroundColor: 'rgba(253, 242, 248, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  coupleFreeText: {
    fontSize: 9.5,
    fontWeight: '700',
    color: '#DB2777',
    textAlign: 'center',
  },
  coupleFreeSub: {
    fontSize: 8.5,
    color: '#EC4899',
    marginTop: 1,
  },
  courseCard: {
    position: 'absolute',
    borderRadius: 8,
    borderLeftWidth: 3,
    paddingHorizontal: 3.5,
    paddingVertical: 3.5,
    overflow: 'hidden',
  },
  courseCardNonCurrent: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderLeftWidth: 3,
    opacity: 0.88,
  },
  courseCardStacked: {
    borderBottomWidth: 2.5,
    borderBottomColor: 'rgba(15, 23, 42, 0.16)',
  },
  inlineTopBadge: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    marginBottom: 2,
  },
  inlineTopBadgeText: {
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '800',
    color: COLORS.white,
  },
  otherWeekFooterPill: {
    marginTop: 'auto',
    alignSelf: 'stretch',
    backgroundColor: 'rgba(100, 116, 139, 0.14)',
    borderRadius: 4,
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  otherWeekFooterText: {
    fontSize: 7.5,
    lineHeight: 9.5,
    fontWeight: '700',
    color: '#475569',
    textAlign: 'center',
  },
  prefixTagText: {
    fontSize: 8.5,
    lineHeight: 10.5,
    fontWeight: '800',
    marginBottom: 1,
  },
  cardName: {
    fontSize: 10.5,
    fontWeight: '700',
    lineHeight: 13,
  },
  cardRoom: {
    fontSize: 9,
    marginTop: 1.5,
    lineHeight: 11,
  },
  nonWeekRangeText: {
    fontSize: 8.5,
    color: '#64748B',
    marginTop: 1.5,
  },
  cardTeacher: {
    fontSize: 8.5,
    marginTop: 1.5,
    opacity: 0.85,
  },
  secondCourseStrip: {
    marginTop: 'auto',
    backgroundColor: 'rgba(15, 23, 42, 0.07)',
    borderRadius: 4,
    paddingHorizontal: 3,
    paddingVertical: 1.5,
  },
  secondCourseStripText: {
    fontSize: 8.5,
    fontWeight: '700',
    color: '#334155',
  },
  dualPartnerWrap: {
    flex: 1,
    justifyContent: 'space-between',
  },
  dualHalfBox: {
    flex: 1,
    justifyContent: 'center',
  },
  dualDivider: {
    height: 1,
    backgroundColor: 'rgba(236, 72, 153, 0.22)',
    marginVertical: 2,
  },
  dualMineTag: {
    fontSize: 8,
    fontWeight: '800',
    color: '#0369A1',
  },
  dualMineName: {
    fontSize: 9.5,
    fontWeight: '700',
    color: '#0C4A6E',
    lineHeight: 11.5,
  },
  dualPartnerTag: {
    fontSize: 8,
    fontWeight: '800',
    color: '#BE185D',
  },
  dualPartnerName: {
    fontSize: 9.5,
    fontWeight: '700',
    color: '#831843',
    lineHeight: 11.5,
  },
  dualRoomText: {
    fontSize: 8,
    color: '#64748B',
  },
});
