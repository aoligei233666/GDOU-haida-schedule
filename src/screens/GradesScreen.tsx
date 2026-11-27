import { Ionicons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { buildLocalEstimatedGraduationAudit } from '../services/campusToolsParser';
import {
  computeGpaSummary,
  OFFICIAL_GRADE_DETAIL_SOURCE_LABEL,
} from '../services/gradeParser';
import { exportSanitizedTranscript } from '../services/transcriptExporter';
import { AppColorPalette, COLORS } from '../theme/colors';
import { useAppTheme } from '../theme/ThemeContext';
import { GradeItem, GraduationAuditReport, ScoreTierBucket } from '../types/models';

interface Props {
  grades: GradeItem[];
  graduationAudit: GraduationAuditReport | null;
  onOpenSync: () => void;
}

type ViewTab = 'overview' | 'audit' | 'details';
type SortMode = 'term' | 'gpa' | 'credit';

function getTierColors(
  isDark: boolean
): Record<ScoreTierBucket['key'], { bar: string; bg: string; text: string }> {
  if (isDark) {
    return {
      excellent: { bar: '#34D399', bg: '#064E3B', text: '#A7F3D0' },
      good: { bar: '#38BDF8', bg: '#0C4A6E', text: '#BAE6FD' },
      medium: { bar: '#60A5FA', bg: '#1E3A8A', text: '#BFDBFE' },
      pass: { bar: '#FBBF24', bg: '#451A03', text: '#FDE68A' },
      fail: { bar: '#F87171', bg: '#450A0A', text: '#FECACA' },
    };
  }
  return {
    excellent: { bar: '#059669', bg: '#D1FAE5', text: '#065F46' },
    good: { bar: '#0284C7', bg: '#E0F2FE', text: '#075985' },
    medium: { bar: '#2563EB', bg: '#DBEAFE', text: '#1E40AF' },
    pass: { bar: '#D97706', bg: '#FEF3C7', text: '#92400E' },
    fail: { bar: '#DC2626', bg: '#FEE2E2', text: '#991B1B' },
  };
}

function getGpaColor(gpa: number, colors: AppColorPalette): { bg: string; text: string } {
  if (gpa >= 4.0) return { bg: colors.emeraldLight, text: colors.emerald };
  if (gpa >= 3.0) return { bg: colors.oceanLight, text: colors.oceanPrimary };
  if (gpa >= 2.0) return { bg: colors.amberLight, text: colors.amber };
  return { bg: colors.dangerLight, text: colors.danger };
}

export const GradesScreen: React.FC<Props> = ({ grades, graduationAudit, onOpenSync }) => {
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const tierColors = useMemo(() => getTierColors(isDark), [isDark]);
  const [viewTab, setViewTab] = useState<ViewTab>('overview');
  const [exporting, setExporting] = useState(false);
  const [selectedTerm, setSelectedTerm] = useState<string>('ALL');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortMode, setSortMode] = useState<SortMode>('term');
  const [onlyFailed, setOnlyFailed] = useState<boolean>(false);
  const [expandedGradeId, setExpandedGradeId] = useState<string | null>(null);

  const overallSummary = useMemo(() => computeGpaSummary(grades), [grades]);
  const effectiveAudit = useMemo<GraduationAuditReport | null>(() => {
    if (graduationAudit) return graduationAudit;
    if (grades.length > 0) return buildLocalEstimatedGraduationAudit(grades);
    return null;
  }, [graduationAudit, grades]);

  const terms = useMemo(() => overallSummary.byTerm.map((t) => t.termKey), [overallSummary.byTerm]);

  const categories = useMemo(
    () => overallSummary.byCategory.map((c) => c.category),
    [overallSummary.byCategory]
  );

  // Scope for detail list & hero summary when in detail tab
  const termScopedGrades = useMemo(() => {
    if (selectedTerm === 'ALL') return grades;
    return grades.filter((g) => g.termKey === selectedTerm);
  }, [grades, selectedTerm]);

  const detailGrades = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = termScopedGrades.filter((g) => {
      if (selectedCategory !== 'ALL' && g.courseCategory !== selectedCategory) return false;
      if (onlyFailed && g.passed) return false;
      if (q) {
        const hay = `${g.courseName} ${g.courseCode} ${g.teacher} ${g.courseCategory}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sorted = [...list];
    if (sortMode === 'gpa') {
      sorted.sort((a, b) => b.gpa - a.gpa || (b.numericScore ?? 0) - (a.numericScore ?? 0));
    } else if (sortMode === 'credit') {
      sorted.sort((a, b) => b.credit - a.credit || b.gpa - a.gpa);
    } else {
      sorted.sort((a, b) => b.termKey.localeCompare(a.termKey) || b.credit - a.credit);
    }
    return sorted;
  }, [termScopedGrades, selectedCategory, onlyFailed, searchQuery, sortMode]);

  const activeSummary = useMemo(
    () => (viewTab === 'overview' ? overallSummary : computeGpaSummary(termScopedGrades)),
    [viewTab, overallSummary, termScopedGrades]
  );

  const failedGrades = useMemo(() => grades.filter((g) => !g.passed), [grades]);

  const topCourses = useMemo(() => {
    return [...grades]
      .filter((g) => g.passed && g.credit > 0)
      .sort((a, b) => b.gpa - a.gpa || b.credit - a.credit)
      .slice(0, 3);
  }, [grades]);

  const requiredVsElective = useMemo(() => {
    let requiredCredits = 0;
    let otherCredits = 0;
    for (const c of overallSummary.byCategory) {
      if (c.category.includes('必修')) requiredCredits += c.credits;
      else otherCredits += c.credits;
    }
    return {
      required: Math.round(requiredCredits * 100) / 100,
      other: Math.round(otherCredits * 100) / 100,
    };
  }, [overallSummary.byCategory]);

  const jumpToTermDetails = (termKey: string) => {
    setSelectedTerm(termKey);
    setSelectedCategory('ALL');
    setOnlyFailed(false);
    setViewTab('details');
  };

  const jumpToCategoryDetails = (category: string) => {
    setSelectedTerm('ALL');
    setSelectedCategory(category);
    setOnlyFailed(false);
    setViewTab('details');
  };

  const handleExportTranscript = () => {
    if (grades.length === 0) {
      Alert.alert('暂无可导出成绩', '请先点击「教务同步」拉取历年成绩单。');
      return;
    }
    const runExport = async (format: 'csv' | 'txt') => {
      setExporting(true);
      try {
        const res = await exportSanitizedTranscript(grades, overallSummary, format);
        if (!res.shared) {
          Alert.alert('脱敏成绩单已生成', `文件已保存至：${res.fileUri}`);
        }
      } catch (err) {
        Alert.alert('导出成绩单失败', err instanceof Error ? err.message : String(err));
      } finally {
        setExporting(false);
      }
    };
    Alert.alert(
      '导出脱敏成绩单',
      '所有导出文件均严格不含学号与姓名，方便保存备份、发给导师或导入 Excel 分析：',
      [
        { text: '取消', style: 'cancel' },
        { text: '表格文件 (.csv / Excel)', onPress: () => void runExport('csv') },
        { text: '汇总文本 (.txt)', onPress: () => void runExport('txt') },
      ]
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {/* Ocean Header + Hero KPI Dashboard */}
      <View style={[styles.header, { backgroundColor: colors.oceanDeep }]}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>成绩与学分总览</Text>
            <Text style={styles.headerSub} numberOfLines={1}>
              {grades.length > 0
                ? `共 ${overallSummary.byTerm.length} 学期 · ${overallSummary.totalCourses} 门课 · 已获 ${overallSummary.totalCreditsEarned}/${overallSummary.totalCreditsAttempted} 学分`
                : '同步海大教务成绩单，自动汇总各学期绩点与学分'}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {grades.length > 0 && (
              <TouchableOpacity
                style={[styles.syncPill, { backgroundColor: 'rgba(255,255,255,0.16)' }]}
                onPress={handleExportTranscript}
                disabled={exporting}
                accessibilityRole="button"
                accessibilityLabel="导出脱敏成绩单"
              >
                <Ionicons name="share-outline" size={14} color={COLORS.white} />
                <Text style={[styles.syncPillText, { color: COLORS.white }]}>
                  {exporting ? '导出中' : '导出'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.syncPill}
              onPress={onOpenSync}
              accessibilityRole="button"
              accessibilityLabel="同步海大教务成绩"
            >
              <Ionicons name="sync" size={15} color={COLORS.oceanDeep} />
              <Text style={styles.syncPillText}>教务同步</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.heroGrid}>
          <View style={styles.heroCardPrimary}>
            <Text style={styles.heroValueBig}>{activeSummary.weightedGpa.toFixed(2)}</Text>
            <Text style={styles.heroLabelPrimary}>
              {viewTab === 'overview' || selectedTerm === 'ALL' ? '总平均绩点 GPA' : '本学期 GPA'}
            </Text>
            <Text style={styles.heroMiniSub}>均分 {activeSummary.weightedAvgScore.toFixed(1)}</Text>
          </View>

          <View style={styles.heroCard}>
            <Text style={styles.heroValue}>{activeSummary.totalCreditsEarned}</Text>
            <Text style={styles.heroLabel}>已获学分</Text>
            <Text style={styles.heroMiniSub}>修读 {activeSummary.totalCreditsAttempted}</Text>
          </View>

          <View style={styles.heroCard}>
            <Text style={styles.heroValue}>{activeSummary.requiredGpa.toFixed(2)}</Text>
            <Text style={styles.heroLabel}>必修 GPA</Text>
            <Text style={styles.heroMiniSub}>必修 {requiredVsElective.required}分</Text>
          </View>

          <View style={styles.heroCard}>
            <Text style={styles.heroValue}>
              {activeSummary.totalCourses > 0 ? `${Math.round(activeSummary.passRate)}%` : '0%'}
            </Text>
            <Text style={styles.heroLabel}>通过率</Text>
            <Text style={styles.heroMiniSub}>
              {activeSummary.passedCourses}/{activeSummary.totalCourses} 门
            </Text>
          </View>
        </View>
      </View>

      {/* Segmented View Toggle: Overview vs Curriculum Audit vs Details */}
      {(grades.length > 0 || graduationAudit) && (
        <View style={styles.segmentWrap}>
          <TouchableOpacity
            style={[styles.segmentBtn, viewTab === 'overview' && styles.segmentBtnActive]}
            onPress={() => setViewTab('overview')}
          >
            <Ionicons
              name="stats-chart"
              size={14}
              color={viewTab === 'overview' ? COLORS.white : colors.textSecondary}
            />
            <Text style={[styles.segmentText, viewTab === 'overview' && styles.segmentTextActive]}>
              成绩总览
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.segmentBtn, viewTab === 'audit' && styles.segmentBtnActive]}
            onPress={() => setViewTab('audit')}
          >
            <Ionicons
              name="school-outline"
              size={15}
              color={viewTab === 'audit' ? COLORS.white : colors.textSecondary}
            />
            <Text style={[styles.segmentText, viewTab === 'audit' && styles.segmentTextActive]}>
              培养方案
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.segmentBtn, viewTab === 'details' && styles.segmentBtnActive]}
            onPress={() => setViewTab('details')}
          >
            <Ionicons
              name="list"
              size={15}
              color={viewTab === 'details' ? COLORS.white : colors.textSecondary}
            />
            <Text style={[styles.segmentText, viewTab === 'details' && styles.segmentTextActive]}>
              成绩明细 ({grades.length})
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {grades.length === 0 && !graduationAudit ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.emptyBox}>
            <Ionicons name="ribbon-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>暂无成绩与学分数据</Text>
            <Text style={styles.emptyDesc}>
              点击右上角「教务同步」登录海大教务系统，即可一次性拉取全部学期的成绩单、分项明细（平时分/卷面占比）与培养方案毕业学分进度（账号密码用完即删）。
            </Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={onOpenSync}>
              <Ionicons name="cloud-download-outline" size={18} color={COLORS.white} />
              <Text style={styles.emptyBtnText}>立即无痕同步成绩与学分</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : viewTab === 'audit' && effectiveAudit ? (
        /* ==================== GRADUATION CREDIT / CURRICULUM AUDIT ==================== */
        <ScrollView contentContainerStyle={styles.content}>
          <View
            style={[
              styles.sourceCard,
              effectiveAudit.source === 'official_zf_curriculum'
                ? styles.sourceCardOfficial
                : styles.sourceCardEstimate,
            ]}
          >
            <Ionicons
              name={
                effectiveAudit.source === 'official_zf_curriculum'
                  ? 'shield-checkmark'
                  : 'information-circle'
              }
              size={18}
              color={
                effectiveAudit.source === 'official_zf_curriculum'
                  ? isDark
                    ? colors.emerald
                    : '#065F46'
                  : isDark
                    ? colors.amber
                    : '#B45309'
              }
            />
            <View style={{ flex: 1 }}>
              <Text
                style={[
                  styles.sourceCardTitle,
                  effectiveAudit.source === 'official_zf_curriculum'
                    ? { color: isDark ? '#A7F3D0' : '#065F46' }
                    : { color: isDark ? '#FDE68A' : '#92400E' },
                ]}
              >
                {effectiveAudit.sourceLabel}
              </Text>
              <Text style={styles.sourceCardSub}>
                {effectiveAudit.programTitle ? `培养方案：${effectiveAudit.programTitle} · ` : ''}
                同步时间：
                {new Date(effectiveAudit.syncedAtIso).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Text>
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="school-outline" size={18} color={colors.oceanPrimary} />
              <Text style={styles.cardTitle}>毕业学分进度核对</Text>
              <Text style={styles.cardHeaderRight}>
                {effectiveAudit.totalRequiredCredits !== null
                  ? `${effectiveAudit.totalEarnedCredits} / ${effectiveAudit.totalRequiredCredits} 学分`
                  : `已获 ${effectiveAudit.totalEarnedCredits} 学分`}
              </Text>
            </View>

            <View style={styles.creditSummaryRow}>
              <View style={styles.creditStatPill}>
                <Text style={styles.creditStatVal}>
                  {effectiveAudit.totalRequiredCredits !== null
                    ? effectiveAudit.totalRequiredCredits
                    : '--'}
                </Text>
                <Text style={styles.creditStatLbl}>方案要求学分</Text>
              </View>
              <View style={styles.creditStatPill}>
                <Text style={[styles.creditStatVal, { color: colors.emerald }]}>
                  {effectiveAudit.totalEarnedCredits}
                </Text>
                <Text style={styles.creditStatLbl}>已获学分</Text>
              </View>
              <View style={styles.creditStatPill}>
                <Text style={[styles.creditStatVal, { color: colors.oceanPrimary }]}>
                  {effectiveAudit.totalInProgressCredits}
                </Text>
                <Text style={styles.creditStatLbl}>在修学分</Text>
              </View>
              <View style={styles.creditStatPill}>
                <Text
                  style={[
                    styles.creditStatVal,
                    {
                      color:
                        (effectiveAudit.totalRemainingCredits ?? 0) > 0
                          ? colors.coral
                          : colors.emerald,
                    },
                  ]}
                >
                  {effectiveAudit.totalRemainingCredits !== null
                    ? effectiveAudit.totalRemainingCredits
                    : '--'}
                </Text>
                <Text style={styles.creditStatLbl}>尚缺学分</Text>
              </View>
            </View>

            {effectiveAudit.totalRequiredCredits !== null &&
              effectiveAudit.totalRequiredCredits > 0 && (
                <View style={{ marginTop: 10 }}>
                  <View style={styles.barLabelRow}>
                    <Text style={styles.subSectionHint}>总体毕业学分完成率</Text>
                    <Text style={styles.barValue}>
                      {Math.min(
                        100,
                        Math.round(
                          (effectiveAudit.totalEarnedCredits /
                            effectiveAudit.totalRequiredCredits) *
                            100
                        )
                      )}
                      %
                    </Text>
                  </View>
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${Math.min(
                            100,
                            Math.round(
                              (effectiveAudit.totalEarnedCredits /
                                effectiveAudit.totalRequiredCredits) *
                                100
                            )
                          )}%`,
                          backgroundColor: colors.oceanPrimary,
                        },
                      ]}
                    />
                  </View>
                </View>
              )}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="layers-outline" size={18} color={colors.oceanPrimary} />
              <Text style={styles.cardTitle}>各模块修读进度（{effectiveAudit.modules.length} 项）</Text>
            </View>

            {effectiveAudit.modules.map((mod) => {
              const pct =
                mod.requiredCredits && mod.requiredCredits > 0
                  ? Math.min(100, Math.round((mod.earnedCredits / mod.requiredCredits) * 100))
                  : 100;
              const satisfied =
                mod.requiredCredits !== null && mod.earnedCredits >= mod.requiredCredits;
              return (
                <View key={mod.id} style={styles.auditModRow}>
                  <View style={styles.barLabelRow}>
                    <Text style={styles.auditModName} numberOfLines={1}>
                      {mod.name}
                    </Text>
                    <View
                      style={[
                        styles.auditStatusPill,
                        satisfied
                          ? { backgroundColor: colors.emeraldLight }
                          : mod.remainingCredits !== null && mod.remainingCredits > 0
                            ? { backgroundColor: colors.amberLight }
                            : { backgroundColor: colors.oceanLight },
                      ]}
                    >
                      <Text
                        style={[
                          styles.auditStatusText,
                          satisfied
                            ? { color: isDark ? '#A7F3D0' : '#065F46' }
                            : mod.remainingCredits !== null && mod.remainingCredits > 0
                              ? { color: isDark ? '#FDE68A' : '#B45309' }
                              : { color: isDark ? '#BAE6FD' : COLORS.oceanDeep },
                        ]}
                      >
                        {satisfied
                          ? '已修满'
                          : mod.remainingCredits !== null
                            ? `差 ${mod.remainingCredits} 分`
                            : mod.statusText || '已修汇总'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.auditModMeta}>
                    已获 {mod.earnedCredits} 分
                    {mod.requiredCredits !== null ? ` / 要求 ${mod.requiredCredits} 分` : ''}
                    {mod.inProgressCredits > 0 ? ` · 在修 ${mod.inProgressCredits} 分` : ''}
                    {mod.completedCourses > 0 ? ` · 通过 ${mod.completedCourses} 门` : ''}
                    {mod.failedCourses > 0 ? ` · 挂科 ${mod.failedCourses} 门` : ''}
                  </Text>
                  {mod.requiredCredits !== null && (
                    <View style={[styles.progressTrack, { marginTop: 5 }]}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            width: `${Math.max(4, pct)}%`,
                            backgroundColor: satisfied ? colors.emerald : colors.oceanPrimary,
                          },
                        ]}
                      />
                    </View>
                  )}
                </View>
              );
            })}

            {effectiveAudit.note && <Text style={styles.auditFootnote}>{effectiveAudit.note}</Text>}
          </View>
        </ScrollView>
      ) : viewTab === 'overview' ? (
        /* ==================== OVERVIEW DASHBOARD ==================== */
        <ScrollView contentContainerStyle={styles.content}>
          {/* 1. Credit Progress Banner */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="ribbon-outline" size={18} color={colors.oceanPrimary} />
              <Text style={styles.cardTitle}>学分完成总览</Text>
              <Text style={styles.cardHeaderRight}>
                {overallSummary.totalCreditsEarned} / {overallSummary.totalCreditsAttempted} 学分
              </Text>
            </View>

            <View style={styles.creditSummaryRow}>
              <View style={styles.creditStatPill}>
                <Text style={styles.creditStatVal}>{overallSummary.totalCreditsEarned}</Text>
                <Text style={styles.creditStatLbl}>累计实得学分</Text>
              </View>
              <View style={styles.creditStatPill}>
                <Text style={[styles.creditStatVal, { color: colors.oceanPrimary }]}>
                  {requiredVsElective.required}
                </Text>
                <Text style={styles.creditStatLbl}>必修课学分</Text>
              </View>
              <View style={styles.creditStatPill}>
                <Text style={[styles.creditStatVal, { color: colors.emerald }]}>
                  {requiredVsElective.other}
                </Text>
                <Text style={styles.creditStatLbl}>选修/其他学分</Text>
              </View>
              <View style={styles.creditStatPill}>
                <Text
                  style={[
                    styles.creditStatVal,
                    { color: overallSummary.failedCourses > 0 ? colors.danger : colors.emerald },
                  ]}
                >
                  {overallSummary.failedCourses}
                </Text>
                <Text style={styles.creditStatLbl}>未通过门数</Text>
              </View>
            </View>

            {/* Category Breakdown Bars */}
            {overallSummary.byCategory.length > 0 && (
              <View style={styles.barSection}>
                <Text style={styles.subSectionHint}>按课程性质分布（点击任意行筛选明细）</Text>
                {overallSummary.byCategory.map((cat) => {
                  const pct = Math.round(cat.share * 100);
                  const widthPct = Math.max(4, Math.min(100, pct));
                  return (
                    <TouchableOpacity
                      key={cat.category}
                      style={styles.barRow}
                      onPress={() => jumpToCategoryDetails(cat.category)}
                    >
                      <View style={styles.barLabelRow}>
                        <Text style={styles.barName} numberOfLines={1}>
                          {cat.category}
                        </Text>
                        <Text style={styles.barValue}>
                          {cat.credits} 学分 · {cat.count} 门 ({pct}%)
                        </Text>
                      </View>
                      <View style={styles.progressTrack}>
                        <View
                          style={[
                            styles.progressFill,
                            {
                              width: `${widthPct}%`,
                              backgroundColor: cat.category.includes('必修')
                                ? colors.oceanPrimary
                                : colors.emerald,
                            },
                          ]}
                        />
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

          {/* 2. Term-by-Term GPA & Credits Overview Table */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="calendar-outline" size={18} color={colors.oceanPrimary} />
              <Text style={styles.cardTitle}>各学期绩点与学分总览</Text>
              <Text style={styles.cardHeaderRight}>点击学期看明细</Text>
            </View>

            <View style={styles.termTableHeader}>
              <Text style={[styles.termColLabel, { flex: 1.8 }]}>学期</Text>
              <Text style={[styles.termColLabel, { flex: 0.9, textAlign: 'center' }]}>GPA</Text>
              <Text style={[styles.termColLabel, { flex: 0.85, textAlign: 'center' }]}>均分</Text>
              <Text style={[styles.termColLabel, { flex: 1.1, textAlign: 'right' }]}>学分 / 门</Text>
            </View>

            {overallSummary.byTerm.map((t) => {
              const badge = getGpaColor(t.weightedGpa, colors);
              const gpaBarPct = Math.max(6, Math.min(100, Math.round((t.weightedGpa / 5) * 100)));
              return (
                <TouchableOpacity
                  key={t.termKey}
                  style={styles.termRow}
                  onPress={() => jumpToTermDetails(t.termKey)}
                >
                  <View style={{ flex: 1.8, paddingRight: 6 }}>
                    <Text style={styles.termRowName} numberOfLines={1}>
                      {t.termKey}
                    </Text>
                    <View style={styles.miniGpaTrack}>
                      <View
                        style={[
                          styles.miniGpaFill,
                          { width: `${gpaBarPct}%`, backgroundColor: badge.text },
                        ]}
                      />
                    </View>
                  </View>

                  <View style={{ flex: 0.9, alignItems: 'center' }}>
                    <View style={[styles.gpaPill, { backgroundColor: badge.bg }]}>
                      <Text style={[styles.gpaPillText, { color: badge.text }]}>
                        {t.weightedGpa.toFixed(2)}
                      </Text>
                    </View>
                  </View>

                  <Text style={[styles.termRowAvg, { flex: 0.85 }]}>
                    {t.weightedAvgScore.toFixed(1)}
                  </Text>

                  <View style={{ flex: 1.1, alignItems: 'flex-end' }}>
                    <Text style={styles.termRowCredits}>{t.creditsEarned} 分</Text>
                    <Text style={styles.termRowSub}>
                      {t.passedCount}/{t.coursesCount} 门
                      {t.failedCount > 0 ? ` · ${t.failedCount}挂` : ''}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* 3. Score Tier Distribution */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="bar-chart-outline" size={18} color={colors.oceanPrimary} />
              <Text style={styles.cardTitle}>成绩分段分布</Text>
              <Text style={styles.cardHeaderRight}>共 {overallSummary.totalCourses} 门</Text>
            </View>

            <View style={{ gap: 9 }}>
              {overallSummary.scoreDistribution.map((bucket) => {
                const palette = tierColors[bucket.key];
                const pct = Math.round(bucket.ratio * 100);
                const widthPct = bucket.count > 0 ? Math.max(4, pct) : 0;
                return (
                  <View key={bucket.key} style={styles.tierRow}>
                    <View style={[styles.tierBadge, { backgroundColor: palette.bg }]}>
                      <Text style={[styles.tierBadgeText, { color: palette.text }]}>
                        {bucket.label}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.barLabelRow}>
                        <Text style={styles.tierRange}>{bucket.rangeText}</Text>
                        <Text style={styles.barValue}>
                          {bucket.count} 门 · {bucket.credits} 学分 ({pct}%)
                        </Text>
                      </View>
                      <View style={styles.progressTrack}>
                        <View
                          style={[
                            styles.progressFill,
                            { width: `${widthPct}%`, backgroundColor: palette.bar },
                          ]}
                        />
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>

          {/* 4. Attention / Failed Courses Alert (if any) */}
          {failedGrades.length > 0 && (
            <View style={[styles.card, styles.failedCard]}>
              <View style={styles.cardHeader}>
                <Ionicons name="alert-circle" size={18} color={colors.danger} />
                <Text style={[styles.cardTitle, { color: colors.danger }]}>
                  未通过 / 待关注课程 ({failedGrades.length} 门)
                </Text>
              </View>
              {failedGrades.map((g) => (
                <View key={g.id} style={styles.highlightRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.highlightName}>{g.courseName}</Text>
                    <Text style={styles.highlightMeta}>
                      {g.termKey} · {g.credit} 学分 · {g.examNature}
                    </Text>
                  </View>
                  <Text style={[styles.highlightScore, { color: colors.danger }]}>
                    {g.scoreText}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* 5. Top GPA Courses Highlight */}
          {topCourses.length > 0 && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="trophy-outline" size={18} color={colors.amber} />
                <Text style={styles.cardTitle}>高分优势课程 Top {topCourses.length}</Text>
              </View>
              {topCourses.map((g, idx) => (
                <View key={g.id} style={styles.highlightRow}>
                  <View style={styles.rankCircle}>
                    <Text style={styles.rankText}>{idx + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.highlightName} numberOfLines={1}>
                      {g.courseName}
                    </Text>
                    <Text style={styles.highlightMeta}>
                      {g.termKey} · {g.credit} 学分 · {g.courseCategory}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.highlightScore, { color: colors.emerald }]}>
                      {g.scoreText}
                    </Text>
                    <Text style={styles.highlightGpa}>GPA {g.gpa.toFixed(2)}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {overallSummary.hasEstimatedItems && (
            <View style={styles.estimateBanner}>
              <Ionicons name="information-circle-outline" size={16} color={colors.amber} />
              <Text style={styles.estimateText}>
                注：部分课程因教务未返回官方绩点/百分制字段，已按五级制与海大常规规则估算，仅供参考，以教务系统官方成绩单为准。
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.viewAllBtn}
            onPress={() => {
              setSelectedTerm('ALL');
              setSelectedCategory('ALL');
              setOnlyFailed(false);
              setViewTab('details');
            }}
          >
            <Text style={styles.viewAllBtnText}>查看全部 {grades.length} 门课程明细</Text>
            <Ionicons name="arrow-forward" size={16} color={colors.oceanPrimary} />
          </TouchableOpacity>
        </ScrollView>
      ) : (
        /* ==================== DETAILS VIEW ==================== */
        <>
          {/* Term Filter Chips */}
          <View style={styles.filterSection}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.termBar}
            >
              <TouchableOpacity
                style={[styles.termChip, selectedTerm === 'ALL' && styles.termChipActive]}
                onPress={() => setSelectedTerm('ALL')}
              >
                <Text
                  style={[styles.termChipText, selectedTerm === 'ALL' && styles.termChipTextActive]}
                >
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

            {/* Search & Sort Controls */}
            <View style={styles.searchRow}>
              <View style={styles.searchInputWrap}>
                <Ionicons name="search-outline" size={15} color={colors.textMuted} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="搜索课程名 / 课程号 / 任课教师..."
                  placeholderTextColor={colors.textMuted}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
                    <Ionicons name="close-circle" size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                )}
              </View>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sortBar}
            >
              {(
                [
                  { key: 'term', label: '按学期' },
                  { key: 'gpa', label: '按绩点↓' },
                  { key: 'credit', label: '按学分↓' },
                ] as { key: SortMode; label: string }[]
              ).map((opt) => (
                <TouchableOpacity
                  key={opt.key}
                  style={[styles.miniChip, sortMode === opt.key && styles.miniChipActive]}
                  onPress={() => setSortMode(opt.key)}
                >
                  <Text
                    style={[styles.miniChipText, sortMode === opt.key && styles.miniChipTextActive]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}

              {categories.length > 1 && (
                <>
                  <TouchableOpacity
                    style={[styles.miniChip, selectedCategory === 'ALL' && styles.miniChipActiveAlt]}
                    onPress={() => setSelectedCategory('ALL')}
                  >
                    <Text
                      style={[
                        styles.miniChipText,
                        selectedCategory === 'ALL' && styles.miniChipTextActiveAlt,
                      ]}
                    >
                      全部性质
                    </Text>
                  </TouchableOpacity>
                  {categories.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[
                        styles.miniChip,
                        selectedCategory === cat && styles.miniChipActiveAlt,
                      ]}
                      onPress={() => setSelectedCategory(selectedCategory === cat ? 'ALL' : cat)}
                    >
                      <Text
                        style={[
                          styles.miniChipText,
                          selectedCategory === cat && styles.miniChipTextActiveAlt,
                        ]}
                      >
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {failedGrades.length > 0 && (
                <TouchableOpacity
                  style={[
                    styles.miniChip,
                    onlyFailed && { backgroundColor: colors.dangerLight, borderColor: colors.danger },
                  ]}
                  onPress={() => setOnlyFailed((v) => !v)}
                >
                  <Text style={[styles.miniChipText, onlyFailed && { color: colors.danger }]}>
                    仅看未通过 ({failedGrades.length})
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {activeSummary.hasEstimatedItems && (
              <View style={styles.estimateBanner}>
                <Ionicons name="information-circle-outline" size={16} color={colors.amber} />
                <Text style={styles.estimateText}>
                  注：标注「估算」的课程因教务未返回官方绩点/百分制字段，已按五级制与海大常规规则估算，仅供参考。
                </Text>
              </View>
            )}

            {detailGrades.length === 0 ? (
              <View style={styles.emptyFilterBox}>
                <Ionicons name="filter-outline" size={32} color={colors.textMuted} />
                <Text style={styles.emptyFilterText}>没有符合当前筛选条件的课程成绩</Text>
                <TouchableOpacity
                  style={styles.resetFilterBtn}
                  onPress={() => {
                    setSelectedTerm('ALL');
                    setSelectedCategory('ALL');
                    setSearchQuery('');
                    setOnlyFailed(false);
                  }}
                >
                  <Text style={styles.resetFilterText}>重置筛选条件</Text>
                </TouchableOpacity>
              </View>
            ) : (
              detailGrades.map((item) => {
                const scoreBadge = !item.passed
                  ? { bg: colors.dangerLight, color: colors.danger }
                  : item.gpa >= 4.0
                    ? { bg: colors.emeraldLight, color: colors.emerald }
                    : item.gpa >= 3.0
                      ? { bg: colors.oceanLight, color: colors.oceanPrimary }
                      : { bg: colors.amberLight, color: colors.amber };
                const isExpanded = expandedGradeId === item.id;
                const hasSubScores = Boolean(item.subScores && item.subScores.length > 0);

                return (
                  <TouchableOpacity
                    key={item.id}
                    activeOpacity={0.85}
                    onPress={() => setExpandedGradeId(isExpanded ? null : item.id)}
                    style={styles.gradeCard}
                  >
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
                            <Text style={styles.tagText}>
                              绩点 {item.gpa.toFixed(2)}
                              {item.gpaEstimated ? ' (估算)' : ''}
                            </Text>
                          </View>
                          {hasSubScores && (
                            <View style={[styles.tag, { backgroundColor: colors.emeraldLight }]}>
                              <Text
                                style={[
                                  styles.tagText,
                                  { color: isDark ? '#A7F3D0' : '#065F46' },
                                ]}
                              >
                                分项明细▾
                              </Text>
                            </View>
                          )}
                          {item.examNature && item.examNature !== '正常考试' && (
                            <View style={[styles.tag, { backgroundColor: colors.coralLight }]}>
                              <Text style={[styles.tagText, { color: colors.coral }]}>
                                {item.examNature}
                              </Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.termSubText}>
                          {item.termKey}
                          {item.courseCode ? ` · 代码 ${item.courseCode}` : ''}
                          {item.teacher ? ` · ${item.teacher}` : ''}
                          {' · 点击查看平时/期末分项'}
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

                    {isExpanded && (
                      <View style={styles.subScoreBox}>
                        {hasSubScores && item.subScores ? (
                          <>
                            <View style={styles.subScoreSourceRow}>
                              <Ionicons
                                name="shield-checkmark-outline"
                                size={13}
                                color={isDark ? '#A7F3D0' : '#065F46'}
                              />
                              <Text style={styles.subScoreSourceText}>
                                {item.subScoreSourceLabel || OFFICIAL_GRADE_DETAIL_SOURCE_LABEL}
                              </Text>
                            </View>
                            <View style={styles.subScoreHeader}>
                              <Text style={[styles.subScoreCol, { flex: 1.5 }]}>考核分项</Text>
                              <Text style={[styles.subScoreCol, { flex: 0.9, textAlign: 'center' }]}>
                                占比
                              </Text>
                              <Text style={[styles.subScoreCol, { flex: 0.9, textAlign: 'right' }]}>
                                成绩
                              </Text>
                            </View>
                            {item.subScores.map((sub, sIdx) => (
                              <View key={`${item.id}-sub-${sIdx}`} style={styles.subScoreRow}>
                                <Text style={[styles.subScoreVal, { flex: 1.5 }]}>
                                  {sub.itemName}
                                </Text>
                                <Text
                                  style={[
                                    styles.subScoreVal,
                                    { flex: 0.9, textAlign: 'center', color: colors.oceanPrimary },
                                  ]}
                                >
                                  {sub.weightText}
                                </Text>
                                <Text
                                  style={[
                                    styles.subScoreVal,
                                    { flex: 0.9, textAlign: 'right', fontWeight: '700' },
                                  ]}
                                >
                                  {sub.scoreText}
                                </Text>
                              </View>
                            ))}
                          </>
                        ) : (
                          <Text style={styles.subScoreEmpty}>
                            来源说明：广东海洋大学正方教务未返回该课程的平时分/卷面占比明细（可能教务未公开该课程分项或属于较早学期；点右上角「教务同步」可尝试拉取最新学期分项明细）。
                          </Text>
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        </>
      )}
    </View>
  );
};

const createStyles = (colors: AppColorPalette, isDark: boolean) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    header: {
      backgroundColor: colors.oceanDeep,
      paddingHorizontal: 14,
      paddingTop: 12,
      paddingBottom: 14,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: COLORS.white,
    },
    headerSub: {
      fontSize: 11.5,
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
      gap: 7,
      marginTop: 12,
    },
    heroCardPrimary: {
      flex: 1.35,
      backgroundColor: COLORS.oceanPrimary,
      borderRadius: 12,
      paddingVertical: 9,
      paddingHorizontal: 8,
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
      marginTop: 1,
      fontWeight: '600',
    },
    heroCard: {
      flex: 1,
      backgroundColor: 'rgba(255,255,255,0.12)',
      borderRadius: 12,
      paddingVertical: 9,
      paddingHorizontal: 5,
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
      color: '#E2E8F0',
      marginTop: 1,
      fontWeight: '600',
    },
    heroMiniSub: {
      fontSize: 9.5,
      color: '#BAE6FD',
      marginTop: 2,
    },
    segmentWrap: {
      flexDirection: 'row',
      backgroundColor: colors.surface,
      paddingHorizontal: 14,
      paddingVertical: 8,
      gap: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    segmentBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      height: 36,
      borderRadius: 10,
      backgroundColor: isDark ? colors.surfaceElevated : colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 6,
    },
    segmentBtnActive: {
      backgroundColor: COLORS.oceanPrimary,
      borderColor: COLORS.oceanPrimary,
    },
    segmentText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    segmentTextActive: {
      color: COLORS.white,
    },
    content: {
      padding: 14,
      paddingBottom: 32,
      gap: 12,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
    },
    failedCard: {
      borderColor: isDark ? '#7F1D1D' : '#FCA5A5',
      backgroundColor: isDark ? '#2B1114' : '#FFF5F5',
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 10,
    },
    cardTitle: {
      fontSize: 14.5,
      fontWeight: '700',
      color: isDark ? colors.textPrimary : colors.oceanDeep,
      flex: 1,
    },
    cardHeaderRight: {
      fontSize: 11.5,
      fontWeight: '600',
      color: colors.textMuted,
    },
    creditSummaryRow: {
      flexDirection: 'row',
      gap: 7,
      marginBottom: 12,
    },
    creditStatPill: {
      flex: 1,
      backgroundColor: isDark ? colors.surfaceElevated : colors.bg,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 4,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    creditStatVal: {
      fontSize: 15,
      fontWeight: '800',
      color: isDark ? colors.textPrimary : colors.oceanDeep,
    },
    creditStatLbl: {
      fontSize: 10,
      color: colors.textSecondary,
      marginTop: 2,
      fontWeight: '600',
    },
    barSection: {
      gap: 9,
    },
    subSectionHint: {
      fontSize: 11,
      color: colors.textMuted,
      marginBottom: 2,
    },
    barRow: {
      gap: 4,
    },
    barLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    barName: {
      fontSize: 12.5,
      fontWeight: '700',
      color: colors.textPrimary,
      flex: 1,
    },
    barValue: {
      fontSize: 11.5,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    progressTrack: {
      height: 7,
      borderRadius: 999,
      backgroundColor: colors.borderLight,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 999,
    },
    termTableHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingBottom: 7,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
      marginBottom: 4,
    },
    termColLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
    },
    termRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 9,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    termRowName: {
      fontSize: 12.5,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    miniGpaTrack: {
      height: 4,
      borderRadius: 999,
      backgroundColor: colors.borderLight,
      marginTop: 5,
      overflow: 'hidden',
    },
    miniGpaFill: {
      height: '100%',
      borderRadius: 999,
    },
    gpaPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 8,
    },
    gpaPillText: {
      fontSize: 12.5,
      fontWeight: '800',
    },
    termRowAvg: {
      fontSize: 12.5,
      fontWeight: '700',
      color: colors.textPrimary,
      textAlign: 'center',
    },
    termRowCredits: {
      fontSize: 12.5,
      fontWeight: '800',
      color: isDark ? colors.textPrimary : colors.oceanDeep,
    },
    termRowSub: {
      fontSize: 10,
      color: colors.textMuted,
      marginTop: 1,
    },
    tierRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
    },
    tierBadge: {
      width: 48,
      paddingVertical: 5,
      borderRadius: 8,
      alignItems: 'center',
    },
    tierBadgeText: {
      fontSize: 11.5,
      fontWeight: '800',
    },
    tierRange: {
      fontSize: 11.5,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    highlightRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 7,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderLight,
      gap: 10,
    },
    rankCircle: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.amberLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rankText: {
      fontSize: 12,
      fontWeight: '800',
      color: colors.amber,
    },
    highlightName: {
      fontSize: 13.5,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    highlightMeta: {
      fontSize: 11,
      color: colors.textMuted,
      marginTop: 2,
    },
    highlightScore: {
      fontSize: 16,
      fontWeight: '800',
    },
    highlightGpa: {
      fontSize: 10.5,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    viewAllBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.oceanTint,
      borderWidth: 1,
      borderColor: colors.oceanLight,
      borderRadius: 12,
      height: 44,
      gap: 6,
    },
    viewAllBtnText: {
      fontSize: 13.5,
      fontWeight: '700',
      color: colors.oceanPrimary,
    },
    filterSection: {
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      paddingBottom: 8,
    },
    termBar: {
      paddingHorizontal: 14,
      paddingTop: 9,
      paddingBottom: 6,
      gap: 6,
    },
    termChip: {
      paddingHorizontal: 11,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: isDark ? colors.surfaceElevated : colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      marginRight: 6,
    },
    termChipActive: {
      backgroundColor: COLORS.oceanPrimary,
      borderColor: COLORS.oceanPrimary,
    },
    termChipText: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    termChipTextActive: {
      color: COLORS.white,
    },
    searchRow: {
      paddingHorizontal: 14,
      paddingVertical: 4,
    },
    searchInputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: isDark ? colors.surfaceElevated : colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 10,
      height: 36,
      gap: 6,
    },
    searchInput: {
      flex: 1,
      fontSize: 13,
      color: colors.textPrimary,
      paddingVertical: 0,
    },
    sortBar: {
      paddingHorizontal: 14,
      paddingTop: 6,
      gap: 6,
    },
    miniChip: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 8,
      backgroundColor: isDark ? colors.surfaceElevated : colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
      marginRight: 6,
    },
    miniChipActive: {
      backgroundColor: colors.oceanLight,
      borderColor: colors.oceanPrimary,
    },
    miniChipActiveAlt: {
      backgroundColor: colors.emeraldLight,
      borderColor: colors.emerald,
    },
    miniChipText: {
      fontSize: 11.5,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    miniChipTextActive: {
      color: colors.oceanPrimary,
    },
    miniChipTextActiveAlt: {
      color: colors.emerald,
    },
    emptyBox: {
      alignItems: 'center',
      paddingVertical: 54,
      paddingHorizontal: 24,
    },
    emptyTitle: {
      fontSize: 17,
      fontWeight: '700',
      color: colors.textPrimary,
      marginTop: 12,
    },
    emptyDesc: {
      fontSize: 13,
      color: colors.textSecondary,
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
    emptyFilterBox: {
      alignItems: 'center',
      paddingVertical: 38,
      gap: 10,
    },
    emptyFilterText: {
      fontSize: 13.5,
      color: colors.textSecondary,
    },
    resetFilterBtn: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 999,
      backgroundColor: colors.oceanLight,
    },
    resetFilterText: {
      fontSize: 12.5,
      fontWeight: '700',
      color: colors.oceanPrimary,
    },
    estimateBanner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: colors.amberLight,
      borderRadius: 10,
      paddingHorizontal: 11,
      paddingVertical: 8,
      gap: 6,
    },
    estimateText: {
      flex: 1,
      fontSize: 11.5,
      color: isDark ? '#FDE68A' : '#92400E',
      lineHeight: 16,
    },
    gradeCard: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 13,
      borderWidth: 1,
      borderColor: colors.border,
    },
    gradeMain: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    courseName: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    tagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 6,
    },
    tag: {
      backgroundColor: isDark ? colors.surfaceElevated : colors.bg,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    tagText: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    termSubText: {
      fontSize: 11,
      color: colors.textMuted,
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
    sourceCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      padding: 11,
      borderRadius: 12,
      borderWidth: 1,
      marginBottom: 10,
    },
    sourceCardOfficial: {
      backgroundColor: colors.emeraldLight,
      borderColor: isDark ? '#065F46' : '#A7F3D0',
    },
    sourceCardEstimate: {
      backgroundColor: colors.amberLight,
      borderColor: isDark ? '#78350F' : '#FDE68A',
    },
    sourceCardTitle: {
      fontSize: 12.5,
      fontWeight: '700',
      lineHeight: 17,
    },
    sourceCardSub: {
      fontSize: 11,
      color: colors.textSecondary,
      marginTop: 3,
    },
    auditModRow: {
      paddingVertical: 9,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    auditModName: {
      fontSize: 13.5,
      fontWeight: '700',
      color: colors.textPrimary,
      flex: 1,
      paddingRight: 8,
    },
    auditStatusPill: {
      paddingHorizontal: 8,
      paddingVertical: 2.5,
      borderRadius: 6,
    },
    auditStatusText: {
      fontSize: 11,
      fontWeight: '700',
    },
    auditModMeta: {
      fontSize: 11.5,
      color: colors.textSecondary,
      marginTop: 3,
    },
    auditFootnote: {
      fontSize: 11.5,
      color: colors.textMuted,
      marginTop: 10,
      lineHeight: 17,
    },
    subScoreBox: {
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      gap: 5,
    },
    subScoreSourceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: colors.emeraldLight,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 7,
      marginBottom: 4,
    },
    subScoreSourceText: {
      fontSize: 11,
      fontWeight: '600',
      color: isDark ? '#A7F3D0' : '#065F46',
      flex: 1,
    },
    subScoreHeader: {
      flexDirection: 'row',
      paddingBottom: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    subScoreCol: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textMuted,
    },
    subScoreRow: {
      flexDirection: 'row',
      paddingVertical: 3,
    },
    subScoreVal: {
      fontSize: 12.5,
      color: colors.textPrimary,
    },
    subScoreEmpty: {
      fontSize: 11.5,
      color: colors.textMuted,
      lineHeight: 17,
    },
  });
