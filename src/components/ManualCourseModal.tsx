import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { DAY_FULL_LABELS } from '../constants/gdouTimetable';
import { parseWeekExpression } from '../services/scheduleParser';
import { COLORS, COURSE_PALETTE } from '../theme/colors';
import { CourseItem } from '../types/models';

interface Props {
  visible: boolean;
  initialDayOfWeek?: number;
  initialStartSection?: number;
  initialEndSection?: number;
  totalWeeks: number;
  onClose: () => void;
  onSave: (course: CourseItem) => void;
}

const WEEK_PRESETS = ['1-16周', '1-16周(单)', '2-16周(双)', '1-8周', '9-16周'];

export const ManualCourseModal: React.FC<Props> = ({
  visible,
  initialDayOfWeek = 1,
  initialStartSection = 1,
  initialEndSection = 2,
  totalWeeks,
  onClose,
  onSave,
}) => {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [teacher, setTeacher] = useState('');
  const [dayOfWeek, setDayOfWeek] = useState(initialDayOfWeek);
  const [startSection, setStartSection] = useState(String(initialStartSection));
  const [endSection, setEndSection] = useState(String(initialEndSection));
  const [weekText, setWeekText] = useState('1-16周');

  useEffect(() => {
    if (visible) {
      setDayOfWeek(initialDayOfWeek || 1);
      setStartSection(String(initialStartSection || 1));
      setEndSection(String(Math.max(initialStartSection || 1, initialEndSection || 2)));
    }
  }, [visible, initialDayOfWeek, initialStartSection, initialEndSection]);

  const handleConfirm = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('请填写课程名称', '例如：海洋选修 / 线性代数重修 / 实验室组会');
      return;
    }
    const sSec = parseInt(startSection.trim(), 10);
    const eSec = parseInt(endSection.trim(), 10);
    if (!Number.isInteger(sSec) || sSec < 1 || sSec > 16 || !Number.isInteger(eSec) || eSec < sSec || eSec > 16) {
      Alert.alert('节次范围无效', '请输入 1 至 16 之间的节次，且结束节次不小于开始节次。');
      return;
    }
    const weeks = parseWeekExpression(weekText).filter((w) => w <= Math.max(totalWeeks, 25));
    if (weeks.length === 0) {
      Alert.alert('周次格式无效', '请输入如 1-16周、1-15周(单)、2-16周(双) 或 3,5,7周。');
      return;
    }

    let hash = 0;
    for (let i = 0; i < trimmedName.length; i++) {
      hash = (hash * 31 + trimmedName.charCodeAt(i)) >>> 0;
    }

    const created: CourseItem = {
      id: `manual-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      name: trimmedName,
      code: '',
      teacher: teacher.trim() || '自定义',
      location: location.trim() || '待定教室',
      campus: '',
      dayOfWeek,
      startSection: sSec,
      endSection: eSec,
      weeks,
      weekText: weekText.trim(),
      credit: '',
      classGroup: '',
      colorIndex: hash % COURSE_PALETTE.length,
      isManual: true,
    };

    setName('');
    setLocation('');
    setTeacher('');
    onSave(created);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>手动添加课程（支持同时间多节课）</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close-circle" size={26} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>课程名称 *</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="例如：海洋生态选修 / 旁听课 / 社团培训"
              placeholderTextColor={COLORS.textMuted}
            />

            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>上课教室</Text>
                <TextInput
                  style={styles.input}
                  value={location}
                  onChangeText={setLocation}
                  placeholder="例如：钟海楼02018"
                  placeholderTextColor={COLORS.textMuted}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>授课教师</Text>
                <TextInput
                  style={styles.input}
                  value={teacher}
                  onChangeText={setTeacher}
                  placeholder="选填"
                  placeholderTextColor={COLORS.textMuted}
                />
              </View>
            </View>

            <Text style={styles.label}>上课星期</Text>
            <View style={styles.dayRow}>
              {DAY_FULL_LABELS.map((dLabel, idx) => {
                const d = idx + 1;
                const active = dayOfWeek === d;
                return (
                  <TouchableOpacity
                    key={d}
                    style={[styles.dayChip, active && styles.dayChipActive]}
                    onPress={() => setDayOfWeek(d)}
                  >
                    <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                      {dLabel}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>开始节次 (1-16)</Text>
                <TextInput
                  style={styles.input}
                  value={startSection}
                  onChangeText={setStartSection}
                  keyboardType="number-pad"
                  maxLength={2}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>结束节次 (1-16)</Text>
                <TextInput
                  style={styles.input}
                  value={endSection}
                  onChangeText={setEndSection}
                  keyboardType="number-pad"
                  maxLength={2}
                />
              </View>
            </View>

            <Text style={styles.label}>教学周次（支持单双周/分段）</Text>
            <TextInput
              style={styles.input}
              value={weekText}
              onChangeText={setWeekText}
              placeholder="例如 1-16周 或 1-15周(单)"
              placeholderTextColor={COLORS.textMuted}
            />
            <View style={styles.presetRow}>
              {WEEK_PRESETS.map((preset) => (
                <TouchableOpacity
                  key={preset}
                  style={[styles.presetChip, weekText === preset && styles.presetChipActive]}
                  onPress={() => setWeekText(preset)}
                >
                  <Text
                    style={[
                      styles.presetChipText,
                      weekText === preset && styles.presetChipTextActive,
                    ]}
                  >
                    {preset}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={styles.saveBtn} onPress={handleConfirm}>
              <Ionicons name="checkmark-circle" size={18} color={COLORS.white} />
              <Text style={styles.saveBtnText}>保存到我的课表</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

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
    maxHeight: '86%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: {
    fontSize: 16.5,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  body: {
    gap: 10,
  },
  label: {
    fontSize: 12.5,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  input: {
    height: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 12,
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  twoCol: {
    flexDirection: 'row',
    gap: 10,
  },
  dayRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  dayChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dayChipActive: {
    backgroundColor: COLORS.oceanPrimary,
    borderColor: COLORS.oceanPrimary,
  },
  dayChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  dayChipTextActive: {
    color: COLORS.white,
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  presetChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  presetChipActive: {
    backgroundColor: COLORS.oceanLight,
    borderColor: COLORS.oceanPrimary,
  },
  presetChipText: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  presetChipTextActive: {
    color: COLORS.oceanPrimary,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    height: 46,
    borderRadius: 12,
    marginTop: 6,
    gap: 6,
  },
  saveBtnText: {
    fontSize: 14.5,
    fontWeight: '700',
    color: COLORS.white,
  },
});
