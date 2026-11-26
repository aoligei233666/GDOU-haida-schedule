import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
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
import { DAY_FULL_LABELS } from '../constants/gdouTimetable';
import { isCourseSchedulable } from '../services/scheduleParser';
import { COLORS } from '../theme/colors';
import {
  CampusCourseSearchQuery,
  CampusCourseSearchResult,
  CourseItem,
} from '../types/models';

interface Props {
  visible: boolean;
  lastResult: CampusCourseSearchResult | null;
  myCourses: CourseItem[];
  academicYear: string;
  semesterCode: string;
  onClose: () => void;
  onRequestLiveSearch: (query: CampusCourseSearchQuery) => void;
  onAddAuditCourse: (course: CourseItem) => void;
}

export const CampusCourseSearchModal: React.FC<Props> = ({
  visible,
  lastResult,
  myCourses,
  academicYear,
  semesterCode,
  onClose,
  onRequestLiveSearch,
  onAddAuditCourse,
}) => {
  const [keyword, setKeyword] = useState(lastResult?.query.keyword || '');
  const [teacher, setTeacher] = useState(lastResult?.query.teacher || '');
  const [className, setClassName] = useState(lastResult?.query.className || '');
  const [dayOfWeek, setDayOfWeek] = useState<number>(lastResult?.query.dayOfWeek || 0);

  const handleRunSearch = () => {
    if (!keyword.trim() && !teacher.trim() && !className.trim()) {
      Alert.alert('请输入检索条件', '请至少填写课程名、教师姓名或班级关键词中的一项。');
      return;
    }
    onRequestLiveSearch({
      xnm: academicYear,
      xqm: semesterCode,
      keyword: keyword.trim(),
      teacher: teacher.trim() || undefined,
      className: className.trim() || undefined,
      dayOfWeek: dayOfWeek > 0 ? dayOfWeek : undefined,
    });
  };

  const hasConflictWithMine = (candidate: CourseItem): CourseItem | null => {
    for (const c of myCourses) {
      if (!isCourseSchedulable(c)) continue;
      if (c.dayOfWeek !== candidate.dayOfWeek) continue;
      const secOverlap =
        c.startSection <= candidate.endSection && candidate.startSection <= c.endSection;
      if (!secOverlap) continue;
      const weekOverlap = candidate.weeks.some((w) => c.weeks.includes(w));
      if (weekOverlap) return c;
    }
    return null;
  };

  const alreadyInSchedule = (candidate: CourseItem): boolean =>
    myCourses.some(
      (c) =>
        c.name === candidate.name &&
        c.dayOfWeek === candidate.dayOfWeek &&
        c.startSection === candidate.startSection &&
        c.endSection === candidate.endSection &&
        c.location === candidate.location
    );

  const handleAddAudit = (candidate: CourseItem) => {
    if (alreadyInSchedule(candidate)) {
      Alert.alert('已在课表中', `《${candidate.name}》已存在于当前课表中。`);
      return;
    }
    const auditCourse: CourseItem = {
      ...candidate,
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      isManual: true,
      isAudit: true,
      sourceLabel: '全校课表旁听（蹭课）',
    };
    onAddAuditCourse(auditCourse);
    Alert.alert(
      '已加入旁听课表',
      `《${auditCourse.name}》（${DAY_FULL_LABELS[auditCourse.dayOfWeek - 1]} 第${auditCourse.startSection}-${auditCourse.endSection}节 @${auditCourse.location}）已添加至课表并标记为「旁听」。`
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>全校 / 教师 / 班级课表搜索</Text>
            <Text style={styles.headerSub}>蹭课神器 · 查开课时间地点、冲突检测、一键加入旁听</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={10}>
            <Ionicons name="close" size={24} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>课程名称 / 课程号</Text>
            <View style={styles.inputRow}>
              <Ionicons name="book-outline" size={16} color={COLORS.textMuted} />
              <TextInput
                style={styles.input}
                placeholder="例如：高等数学、Python、海洋生态学"
                placeholderTextColor={COLORS.textMuted}
                value={keyword}
                onChangeText={setKeyword}
              />
            </View>

            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>任课教师（选填）</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="person-outline" size={16} color={COLORS.textMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="教师姓名"
                    placeholderTextColor={COLORS.textMuted}
                    value={teacher}
                    onChangeText={setTeacher}
                  />
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>班级 / 教学班（选填）</Text>
                <View style={styles.inputRow}>
                  <Ionicons name="people-outline" size={16} color={COLORS.textMuted} />
                  <TextInput
                    style={styles.input}
                    placeholder="如 软工2402"
                    placeholderTextColor={COLORS.textMuted}
                    value={className}
                    onChangeText={setClassName}
                  />
                </View>
              </View>
            </View>

            <Text style={styles.fieldLabel}>按星期过滤</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[styles.miniChip, dayOfWeek === 0 && styles.miniChipActive]}
                onPress={() => setDayOfWeek(0)}
              >
                <Text style={[styles.miniChipText, dayOfWeek === 0 && styles.miniChipTextActive]}>
                  不限
                </Text>
              </TouchableOpacity>
              {DAY_FULL_LABELS.map((lbl, idx) => {
                const d = idx + 1;
                const active = dayOfWeek === d;
                return (
                  <TouchableOpacity
                    key={d}
                    style={[styles.miniChip, active && styles.miniChipActive]}
                    onPress={() => setDayOfWeek(d)}
                  >
                    <Text style={[styles.miniChipText, active && styles.miniChipTextActive]}>
                      {lbl}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity style={styles.primaryBtn} onPress={handleRunSearch}>
              <Ionicons name="search" size={18} color={COLORS.white} />
              <Text style={styles.primaryBtnText}>无痕检索教务全校课表</Text>
            </TouchableOpacity>
          </View>

          {lastResult ? (
            <View style={styles.card}>
              <View style={styles.sourceBadge}>
                <Ionicons name="shield-checkmark-outline" size={14} color="#065F46" />
                <Text style={styles.sourceBadgeText}>
                  {lastResult.sourceLabel} · 命中 {lastResult.courses.length} 条
                </Text>
              </View>

              {lastResult.courses.length === 0 ? (
                <Text style={styles.emptySmall}>
                  未检索到匹配课程（部分学院/学期教务可能限制全校课表接口权限，可尝试缩短课程名关键词或按教师名查询）。
                </Text>
              ) : (
                <View style={{ gap: 10 }}>
                  {lastResult.courses.map((c) => {
                    const conflict = hasConflictWithMine(c);
                    const added = alreadyInSchedule(c);
                    return (
                      <View key={c.id} style={styles.courseRow}>
                        <View style={{ flex: 1 }}>
                          <View style={styles.rowTitleWrap}>
                            <Text style={styles.courseName}>{c.name}</Text>
                            {conflict ? (
                              <View style={styles.conflictPill}>
                                <Text style={styles.conflictPillText}>
                                  与《{conflict.name.slice(0, 6)}》冲突
                                </Text>
                              </View>
                            ) : (
                              <View style={styles.freePill}>
                                <Text style={styles.freePillText}>时段空闲可蹭</Text>
                              </View>
                            )}
                          </View>
                          <Text style={styles.courseMeta}>
                            {DAY_FULL_LABELS[c.dayOfWeek - 1] || `周${c.dayOfWeek}`} 第{c.startSection}-
                            {c.endSection}节 · {c.weekText} · @{c.location}
                          </Text>
                          <Text style={styles.courseSub}>
                            教师：{c.teacher}
                            {c.classGroup ? ` · ${c.classGroup}` : ''}
                            {c.credit ? ` · ${c.credit}学分` : ''}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={[styles.auditAddBtn, added && styles.auditAddBtnDone]}
                          onPress={() => handleAddAudit(c)}
                          disabled={added}
                        >
                          <Ionicons
                            name={added ? 'checkmark' : 'add'}
                            size={15}
                            color={added ? COLORS.emerald : COLORS.white}
                          />
                          <Text style={[styles.auditAddText, added && { color: COLORS.emerald }]}>
                            {added ? '已加入' : '加旁听'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : (
            <View style={styles.emptyBox}>
              <Ionicons name="compass-outline" size={40} color={COLORS.textMuted} />
              <Text style={styles.emptyTitle}>输入关键词开始搜课蹭课</Text>
              <Text style={styles.emptyDesc}>
                通过一次性无痕会话查询海大正方教务全校/教师/班级开课记录，自动比对你现有课表提示是否撞课，并支持一键标记「旁听」加入周课表。
              </Text>
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
  fieldLabel: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary, marginBottom: 5, marginTop: 4 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
    gap: 6,
    marginBottom: 8,
  },
  input: { flex: 1, fontSize: 13.5, color: COLORS.textPrimary },
  twoCol: { flexDirection: 'row', gap: 10 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  miniChip: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  miniChipActive: { backgroundColor: COLORS.oceanPrimary, borderColor: COLORS.oceanPrimary },
  miniChipText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  miniChipTextActive: { color: COLORS.white },
  primaryBtn: {
    marginTop: 8,
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primaryBtnText: { fontSize: 14, fontWeight: '700', color: COLORS.white },
  sourceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.emeraldLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    marginBottom: 10,
  },
  sourceBadgeText: { fontSize: 11.5, fontWeight: '600', color: '#065F46', flex: 1 },
  courseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    padding: 11,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    gap: 10,
  },
  rowTitleWrap: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  courseName: { fontSize: 14.5, fontWeight: '700', color: COLORS.textPrimary },
  freePill: { backgroundColor: COLORS.emeraldLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  freePillText: { fontSize: 10.5, fontWeight: '700', color: '#065F46' },
  conflictPill: { backgroundColor: COLORS.amberLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  conflictPillText: { fontSize: 10.5, fontWeight: '700', color: '#B45309' },
  courseMeta: { fontSize: 12, color: COLORS.oceanPrimary, fontWeight: '600', marginTop: 4 },
  courseSub: { fontSize: 11.5, color: COLORS.textSecondary, marginTop: 2 },
  auditAddBtn: {
    backgroundColor: '#7C3AED',
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  auditAddBtnDone: { backgroundColor: COLORS.emeraldLight },
  auditAddText: { fontSize: 12, fontWeight: '700', color: COLORS.white },
  emptySmall: { fontSize: 12.5, color: COLORS.textMuted, textAlign: 'center', paddingVertical: 14, lineHeight: 19 },
  emptyBox: {
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: COLORS.textPrimary, marginTop: 8 },
  emptyDesc: { fontSize: 12.5, color: COLORS.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 19 },
});
