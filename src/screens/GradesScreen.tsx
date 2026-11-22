import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { computeGpaSummary } from '../services/gradeParser';
import { COLORS } from '../theme/colors';
import { GradeItem } from '../types/models';

interface Props {
  grades: GradeItem[];
  onOpenSync: () => void;
}

export const GradesScreen: React.FC<Props> = ({ grades, onOpenSync }) => {
  const [selectedTerm, setSelectedTerm] = useState<string>('ALL');

  const terms = useMemo(() => {
    const set = new Set<string>();
    for (const g of grades) {
      if (g.termKey) set.add(g.termKey);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [grades]);

  const filteredGrades = useMemo(() => {
    if (selectedTerm === 'ALL') return grades;
    return grades.filter((g) => g.termKey === selectedTerm);
  }, [grades, selectedTerm]);

  const summary = useMemo(() => computeGpaSummary(filteredGrades), [filteredGrades]);
  const overallSummary = useMemo(() => computeGpaSummary(grades), [grades]);

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>绩点与学分查询</Text>
            <Text style={styles.headerSub}>
              累计已获 {overallSummary.totalCreditsEarned} 学分 · 总平均绩点 {overallSummary.weightedGpa.toFixed(2)}
            </Text>
          </View>
          <TouchableOpacity style={styles.syncPill} onPress={onOpenSync}>
            <Ionicons name="sync" size={15} color={COLORS.oceanDeep} />
            <Text style={styles.syncPillText}>教务同步</Text>
          </TouchableOpacity>
        </View>

        {/* GPA & Credits Hero Dashboard */}
        <View style={styles.heroGrid}>
          <View style={styles.heroCardPrimary}>
            <Text style={styles.heroValueBig}>{summary.weightedGpa.toFixed(2)}</Text>
            <Text style={styles.heroLabelPrimary}>
              {selectedTerm === 'ALL' ? '总平均绩点 (GPA)' : '本学期平均绩点'}
            </Text>
          </View>
          <View style={styles.heroCard}>
            <Text style={styles.heroValue}>{summary.totalCreditsEarned}</Text>
            <Text style={styles.heroLabel}>已获学分</Text>
          </View>
          <View style={styles.heroCard}>
            <Text style={styles.heroValue}>{summary.weightedAvgScore.toFixed(1)}</Text>
            <Text style={styles.heroLabel}>加权平均分</Text>
          </View>
          <View style={styles.heroCard}>
            <Text style={styles.heroValue}>{summary.requiredGpa.toFixed(2)}</Text>
            <Text style={styles.heroLabel}>必修课绩点</Text>
          </View>
        </View>
      </View>

      {/* Term Filter Bar */}
      {terms.length > 0 && (
        <View style={styles.termBarWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.termBar}
          >
            <TouchableOpacity
              style={[styles.termChip, selectedTerm === 'ALL' && styles.termChipActive]}
              onPress={() => setSelectedTerm('ALL')}
            >
              <Text style={[styles.termChipText, selectedTerm === 'ALL' && styles.termChipTextActive]}>
                全部学期 ({grades.length})
              </Text>
            </TouchableOpacity>
            {terms.map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.termChip, selectedTerm === t && styles.termChipActive]}
                onPress={() => setSelectedTerm(t)}
              >
                <Text style={[styles.termChipText, selectedTerm === t && styles.termChipTextActive]}>
                  {t}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content}>
        {grades.length === 0 ? (
          <View style={styles.emptyBox}>
            <Ionicons name="ribbon-outline" size={46} color={COLORS.textMuted} />
            <Text style={styles.emptyTitle}>暂无成绩与学分数据</Text>
            <Text style={styles.emptyDesc}>
              点击右上角「教务同步」登录海大教务系统，即可一次性拉取全部学期的课程成绩、学分与平均学分绩点（账号密码用完即删）。
            </Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={onOpenSync}>
              <Ionicons name="cloud-download-outline" size={18} color={COLORS.white} />
              <Text style={styles.emptyBtnText}>立即无痕同步成绩与学分</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {/* Credit Category Breakdown */}
            {summary.byCategory.length > 0 && (
              <View style={styles.catCard}>
                <View style={styles.catHeader}>
                  <Ionicons name="pie-chart-outline" size={17} color={COLORS.oceanPrimary} />
                  <Text style={styles.catTitle}>
                    学分构成统计（通过 {summary.passedCourses}/{summary.totalCourses} 门 · 修读 {summary.totalCreditsAttempted} 学分）
                  </Text>
                </View>
                <View style={styles.catGrid}>
                  {summary.byCategory.map((item) => (
                    <View key={item.category} style={styles.catPill}>
                      <Text style={styles.catName}>{item.category}</Text>
                      <Text style={styles.catValue}>
                        {item.credits} 学分 ({item.count}门)
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Course Grade Items */}
            {filteredGrades.map((item) => {
              const scoreBadge = !item.passed
                ? { bg: COLORS.dangerLight, color: COLORS.danger }
                : item.gpa >= 4.0
                  ? { bg: COLORS.emeraldLight, color: COLORS.emerald }
                  : item.gpa >= 3.0
                    ? { bg: COLORS.oceanLight, color: COLORS.oceanPrimary }
                    : { bg: COLORS.amberLight, color: COLORS.amber };

              return (
                <View key={item.id} style={styles.gradeCard}>
                  <View style={styles.gradeMain}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.courseName}>{item.courseName}</Text>
                      <View style={styles.tagRow}>
                        <View style={styles.tag}>
                          <Text style={styles.tagText}>{item.courseCategory}</Text>
                        </View>
                        <View style={styles.tag}>
                          <Text style={styles.tagText}>{item.credit} 学分</Text>
                        </View>
                        <View style={styles.tag}>
                          <Text style={styles.tagText}>绩点 {item.gpa.toFixed(2)}</Text>
                        </View>
                        {item.examNature && item.examNature !== '正常考试' && (
                          <View style={[styles.tag, { backgroundColor: COLORS.coralLight }]}>
                            <Text style={[styles.tagText, { color: COLORS.coral }]}>
                              {item.examNature}
                            </Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.termSubText}>
                        {item.termKey}
                        {item.courseCode ? ` · 代码 ${item.courseCode}` : ''}
                        {item.teacher ? ` · ${item.teacher}` : ''}
                      </Text>
                    </View>

                    <View style={[styles.scoreBadge, { backgroundColor: scoreBadge.bg }]}>
                      <Text style={[styles.scoreText, { color: scoreBadge.color }]}>
                        {item.scoreText}
                      </Text>
                      <Text style={[styles.gpaMini, { color: scoreBadge.color }]}>
                        GPA {item.gpa.toFixed(1)}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </>
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
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
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
  syncPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.oceanLight,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    gap: 4,
  },
  syncPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  heroGrid: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  heroCardPrimary: {
    flex: 1.35,
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroValueBig: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.white,
  },
  heroLabelPrimary: {
    fontSize: 10.5,
    color: '#E0F2FE',
    marginTop: 2,
    fontWeight: '600',
  },
  heroCard: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroValue: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.white,
  },
  heroLabel: {
    fontSize: 10.5,
    color: '#CBD5E1',
    marginTop: 2,
    fontWeight: '600',
  },
  termBarWrap: {
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  termBar: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 8,
  },
  termChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginRight: 6,
  },
  termChipActive: {
    backgroundColor: COLORS.oceanPrimary,
    borderColor: COLORS.oceanPrimary,
  },
  termChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  termChipTextActive: {
    color: COLORS.white,
  },
  content: {
    padding: 14,
    paddingBottom: 32,
    gap: 10,
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: 54,
    paddingHorizontal: 24,
  },
  emptyTitle: {
    fontSize: 17,
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
    marginBottom: 18,
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    paddingHorizontal: 20,
    height: 46,
    borderRadius: 12,
    gap: 8,
  },
  emptyBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
  catCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 2,
  },
  catHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  catTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  catGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  catPill: {
    backgroundColor: COLORS.oceanTint,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
  },
  catName: {
    fontSize: 11,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  catValue: {
    fontSize: 13,
    color: COLORS.oceanDeep,
    fontWeight: '800',
    marginTop: 1,
  },
  gradeCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  gradeMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  courseName: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  tag: {
    backgroundColor: COLORS.bg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  tagText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  termSubText: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 6,
  },
  scoreBadge: {
    minWidth: 66,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreText: {
    fontSize: 18,
    fontWeight: '800',
  },
  gpaMini: {
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
});
