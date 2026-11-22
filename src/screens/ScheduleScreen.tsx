import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  Alert,
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { CourseDetailModal } from '../components/CourseDetailModal';
import {
  DAY_LABELS,
  getActivePeriods,
} from '../constants/gdouTimetable';
import { createWeeklyMorningWakeupAlarms } from '../services/alarmService';
import { syncAllCoursesToCalendar } from '../services/calendarService';
import {
  computeTermWeek,
  formatShortDate,
  getCourseTimeSpan,
  getDateForWeekAndDay,
  getTodayDayOfWeek,
} from '../services/scheduleParser';
import { COLORS, COURSE_PALETTE } from '../theme/colors';
import { AlarmRule, AppSettings, CourseItem } from '../types/models';

const SCREEN_WIDTH = Dimensions.get('window').width;
const TIME_COL_WIDTH = 44;
const ROW_HEIGHT = 60;
const VISIBLE_SECTIONS = 12;

interface Props {
  courses: CourseItem[];
  termLabel: string;
  settings: AppSettings;
  onOpenSync: () => void;
  onLoadSampleData: () => void;
  onAlarmsAdded: (alarms: AlarmRule[]) => void;
}

export const ScheduleScreen: React.FC<Props> = ({
  courses,
  termLabel,
  settings,
  onOpenSync,
  onLoadSampleData,
  onAlarmsAdded,
}) => {
  const currentWeek = useMemo(
    () => Math.min(settings.totalWeeks, Math.max(1, computeTermWeek(settings.termStartDate))),
    [settings.termStartDate, settings.totalWeeks]
  );
  const [selectedWeek, setSelectedWeek] = useState<number>(currentWeek);
  const [activeCourse, setActiveCourse] = useState<CourseItem | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const periods = useMemo(() => getActivePeriods(settings), [settings]);
  const todayDow = getTodayDayOfWeek();
  const colWidth = Math.floor((SCREEN_WIDTH - TIME_COL_WIDTH - 12) / 7);

  const weekDates = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        getDateForWeekAndDay(settings.termStartDate, selectedWeek, i + 1)
      ),
    [settings.termStartDate, selectedWeek]
  );

  const weekCourses = useMemo(
    () => courses.filter((c) => c.weeks.includes(selectedWeek)),
    [courses, selectedWeek]
  );

  const todayCourses = useMemo(
    () =>
      courses
        .filter((c) => c.weeks.includes(currentWeek) && c.dayOfWeek === todayDow)
        .sort((a, b) => a.startSection - b.startSection),
    [courses, currentWeek, todayDow]
  );

  const handleQuickCalendarSync = async () => {
    if (courses.length === 0) {
      Alert.alert('暂无课表', '请先同步广海教务课表或加载示例预览。');
      return;
    }
    setBusyAction('calendar');
    try {
      const res = await syncAllCoursesToCalendar(courses, settings, { replaceExisting: true });
      Alert.alert(
        '整学期课表已导入系统日历',
        `已创建「广海课表 (GDOU)」专属日历并写入 ${res.eventsCreated} 条上课日程，均已配置课前 ${settings.defaultCalendarReminderMinutes} 分钟提醒。`
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
      const { created, skippedPast } = await createWeeklyMorningWakeupAlarms(
        courses,
        selectedWeek,
        settings.defaultWakeupMinutes,
        settings
      );
      if (created.length > 0) {
        onAlarmsAdded(created);
      }
      Alert.alert(
        '早起闹钟生成完成',
        created.length > 0
          ? `已为第 ${selectedWeek} 周生成 ${created.length} 个每日首课起床闹钟（提前 ${settings.defaultWakeupMinutes} 分钟响铃）${
              skippedPast > 0 ? `，已自动跳过 ${skippedPast} 个过去时段` : ''
            }。`
          : `第 ${selectedWeek} 周的所有课程时间均已过去，请切换到未来周次后生成。`
      );
    } catch (err) {
      Alert.alert('生成闹钟失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <View style={styles.root}>
      {/* Top Ocean Header */}
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <View>
            <Text style={styles.termSub}>{termLabel}</Text>
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
            <Ionicons name="shield-checkmark-outline" size={16} color={COLORS.oceanDeep} />
            <Text style={styles.syncHeaderBtnText}>无痕同步</Text>
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
              {busyAction === 'alarm' ? '生成中...' : '一键本周早起闹钟'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {courses.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="school-outline" size={44} color={COLORS.oceanPrimary} />
          </View>
          <Text style={styles.emptyTitle}>欢迎使用广海课表</Text>
          <Text style={styles.emptyDesc}>
            支持一键同步广东海洋大学教务课表与考试安排。登录账号密码仅在拉取时临时验证，拉取完成立即销毁，本地零留存。
          </Text>
          <TouchableOpacity style={styles.emptyPrimaryBtn} onPress={onOpenSync}>
            <Ionicons name="cloud-download-outline" size={19} color={COLORS.white} />
            <Text style={styles.emptyPrimaryText}>登录广海教务同步课表（用完即删）</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.emptySecondaryBtn} onPress={onLoadSampleData}>
            <Ionicons name="sparkles-outline" size={17} color={COLORS.oceanPrimary} />
            <Text style={styles.emptySecondaryText}>加载广海示例课表体验日历与闹钟功能</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Today's Spotlight */}
          {todayCourses.length > 0 && (
            <View style={styles.todayBanner}>
              <View style={styles.todayBadge}>
                <Text style={styles.todayBadgeText}>今日 {todayCourses.length} 节</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {todayCourses.map((c) => {
                  const span = getCourseTimeSpan(c, periods);
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={styles.todayChip}
                      onPress={() => setActiveCourse(c)}
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
                {Array.from({ length: VISIBLE_SECTIONS }, (_, i) => {
                  const sec = i + 1;
                  const p = periods.find((item) => item.section === sec);
                  return (
                    <View key={sec} style={styles.timeCell}>
                      <Text style={styles.sectionNum}>{sec}</Text>
                      <Text style={styles.sectionTime}>{p?.start ?? ''}</Text>
                    </View>
                  );
                })}
              </View>

              {/* 7-Day Columns */}
              <View style={styles.columnsWrap}>
                {/* Background Grid Lines */}
                {Array.from({ length: VISIBLE_SECTIONS }, (_, i) => (
                  <View
                    key={`line-${i}`}
                    style={[
                      styles.gridRowLine,
                      { top: i * ROW_HEIGHT, height: ROW_HEIGHT },
                    ]}
                  />
                ))}

                {/* Course Cards */}
                {weekCourses.map((course) => {
                  const theme = COURSE_PALETTE[course.colorIndex % COURSE_PALETTE.length];
                  const top = (course.startSection - 1) * ROW_HEIGHT + 2;
                  const spanCount = Math.max(1, course.endSection - course.startSection + 1);
                  const height = spanCount * ROW_HEIGHT - 4;
                  const left = (course.dayOfWeek - 1) * colWidth + 2;
                  const width = colWidth - 4;

                  return (
                    <TouchableOpacity
                      key={course.id}
                      activeOpacity={0.85}
                      onPress={() => setActiveCourse(course)}
                      style={[
                        styles.courseCard,
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
                      <Text style={[styles.cardName, { color: theme.text }]} numberOfLines={3}>
                        {course.name}
                      </Text>
                      <Text style={[styles.cardRoom, { color: theme.subtext }]} numberOfLines={2}>
                        @{course.location}
                      </Text>
                      {spanCount >= 2 && (
                        <Text style={[styles.cardTeacher, { color: theme.subtext }]} numberOfLines={1}>
                          {course.teacher}
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </ScrollView>
        </>
      )}

      <CourseDetailModal
        course={activeCourse}
        selectedWeek={selectedWeek}
        settings={settings}
        onClose={() => setActiveCourse(null)}
        onAlarmCreated={(alarm) => onAlarmsAdded([alarm])}
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
    paddingBottom: 12,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.white,
  },
  backToNowBtn: {
    backgroundColor: COLORS.coral,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginLeft: 4,
  },
  backToNowText: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.white,
  },
  syncHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.oceanLight,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    gap: 5,
  },
  syncHeaderBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  quickRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  quickPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 7,
    borderRadius: 10,
    gap: 5,
  },
  quickPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.white,
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
    marginBottom: 22,
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
    paddingVertical: 8,
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
    fontSize: 9,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  columnsWrap: {
    flex: 1,
    position: 'relative',
    height: VISIBLE_SECTIONS * ROW_HEIGHT,
  },
  gridRowLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderLight,
  },
  courseCard: {
    position: 'absolute',
    borderRadius: 8,
    borderLeftWidth: 3,
    padding: 4,
    overflow: 'hidden',
  },
  cardName: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 14,
  },
  cardRoom: {
    fontSize: 9.5,
    marginTop: 3,
    lineHeight: 12,
  },
  cardTeacher: {
    fontSize: 9,
    marginTop: 2,
    opacity: 0.85,
  },
});
