import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { DAY_FULL_LABELS, getActivePeriods } from '../constants/gdouTimetable';
import {
  createClassAlarm,
  setNativeAndroidSystemClockAlarm,
} from '../services/alarmService';
import { addSingleCourseToCalendar } from '../services/calendarService';
import { getCourseTimeSpan } from '../services/scheduleParser';
import { COLORS, COURSE_PALETTE } from '../theme/colors';
import { AlarmRule, AppSettings, CourseItem } from '../types/models';

interface Props {
  course: CourseItem | null;
  selectedWeek: number;
  settings: AppSettings;
  onClose: () => void;
  onAlarmCreated: (alarm: AlarmRule) => void;
}

const LEAD_OPTIONS = [10, 15, 20, 30, 45];

export const CourseDetailModal: React.FC<Props> = ({
  course,
  selectedWeek,
  settings,
  onClose,
  onAlarmCreated,
}) => {
  const [leadMinutes, setLeadMinutes] = useState(settings.defaultClassAlarmMinutes || 20);
  const [busy, setBusy] = useState(false);

  if (!course) return null;

  const theme = COURSE_PALETTE[course.colorIndex % COURSE_PALETTE.length];
  const periods = getActivePeriods(settings);
  const { startText, endText } = getCourseTimeSpan(course, periods);
  const dayLabel = DAY_FULL_LABELS[course.dayOfWeek - 1] ?? `周${course.dayOfWeek}`;

  const handleAddToCalendar = async () => {
    setBusy(true);
    try {
      const res = await addSingleCourseToCalendar(course, settings);
      Alert.alert(
        '已添加到系统日历',
        `已将《${course.name}》的全部 ${res.eventsCreated} 次上课安排更新至「海大课表 (GDOU)」日历（已自动去重），并附带课前 ${settings.defaultCalendarReminderMinutes} 分钟提醒。`
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
        : course.weeks[0] ?? selectedWeek;
      const rule = await createClassAlarm(course, targetWeek, leadMinutes, settings);
      onAlarmCreated(rule);
      Alert.alert(
        '课前闹钟已设定',
        `将在第 ${targetWeek} 周 ${dayLabel} 上课前 ${leadMinutes} 分钟（${String(
          rule.hour
        ).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}）响铃提醒。`
      );
    } catch (err) {
      Alert.alert('设定闹钟失败', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAndroidSystemClock = async () => {
    const [hStr, mStr] = startText.split(':');
    const totalMinutes = parseInt(hStr, 10) * 60 + parseInt(mStr, 10) - leadMinutes;
    const normalized = ((totalMinutes % 1440) + 1440) % 1440;
    const hour = Math.floor(normalized / 60);
    const minute = normalized % 60;
    try {
      await setNativeAndroidSystemClockAlarm({
        hour,
        minute,
        message: `${course.name} (${course.location})`,
        isoWeekdays: [course.dayOfWeek],
      });
    } catch (err) {
      Alert.alert('唤起系统时钟失败', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal visible={Boolean(course)} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.sheet} activeOpacity={1}>
          <View style={[styles.banner, { backgroundColor: theme.bg, borderColor: theme.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.courseTitle, { color: theme.text }]}>{course.name}</Text>
              {course.code ? (
                <Text style={[styles.courseCode, { color: theme.subtext }]}>
                  课程号：{course.code}{course.credit ? ` · ${course.credit} 学分` : ''}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close-circle" size={26} color={theme.subtext} />
            </TouchableOpacity>
          </View>

          <View style={styles.metaList}>
            <MetaRow icon="time-outline" label="上课时间" value={`${dayLabel} 第 ${course.startSection}-${course.endSection} 节（${startText} - ${endText}）`} />
            <MetaRow icon="location-outline" label="上课地点" value={[course.campus, course.location].filter(Boolean).join(' · ')} />
            <MetaRow icon="person-outline" label="授课教师" value={course.teacher} />
            <MetaRow icon="calendar-outline" label="教学周次" value={`${course.weekText}（共 ${course.weeks.length} 周）`} />
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
              <Text style={styles.actionBtnText}>设第 {selectedWeek} 周课前闹钟</Text>
            </TouchableOpacity>

            {Platform.OS === 'android' && (
              <TouchableOpacity
                style={[styles.actionBtn, styles.sysClockBtn]}
                onPress={handleAndroidSystemClock}
                disabled={busy}
              >
                <Ionicons name="time" size={18} color={COLORS.oceanDeep} />
                <Text style={[styles.actionBtnText, { color: COLORS.oceanDeep }]}>
                  写入 Android 系统时钟闹钟
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

const MetaRow: React.FC<{ icon: keyof typeof Ionicons.glyphMap; label: string; value: string }> = ({
  icon,
  label,
  value,
}) => (
  <View style={styles.metaRow}>
    <Ionicons name={icon} size={17} color={COLORS.oceanPrimary} />
    <Text style={styles.metaLabel}>{label}</Text>
    <Text style={styles.metaValue}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 18,
    paddingBottom: Platform.OS === 'ios' ? 32 : 20,
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
    gap: 10,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 46,
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
});
