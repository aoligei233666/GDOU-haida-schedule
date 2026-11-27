import { GpaSummary, GradeItem } from '../types/models';

function csvCell(value: unknown): string {
  const s = String(value ?? '').replace(/\r\n|\r|\n/g, ' ');
  if (/[",]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Generate a sanitized, privacy-safe RFC 4180 CSV transcript (UTF-8 BOM for Excel Chinese support).
 * Strictly omits any student ID, name, or login credentials.
 */
export function buildSanitizedTranscriptCsv(grades: GradeItem[], summary: GpaSummary): string {
  const rows: string[] = [];
  rows.push(
    [
      '学期',
      '课程代码',
      '课程名称',
      '课程性质',
      '学分',
      '成绩',
      '百分制换算',
      '绩点(GPA)',
      '绩点来源',
      '考试性质',
      '是否通过',
      '分项明细',
    ]
      .map(csvCell)
      .join(',')
  );

  const sorted = [...grades].sort(
    (a, b) => b.termKey.localeCompare(a.termKey) || b.credit - a.credit
  );

  for (const g of sorted) {
    const subText =
      g.subScores && g.subScores.length > 0
        ? g.subScores
            .map((s) => `${s.itemName}${s.weightText ? `(${s.weightText})` : ''}:${s.scoreText}`)
            .join(' / ')
        : '';
    rows.push(
      [
        g.termKey,
        g.courseCode,
        g.courseName,
        g.courseCategory,
        g.credit,
        g.scoreText,
        g.numericScore ?? '',
        g.gpa.toFixed(2),
        g.gpaEstimated ? '本地估算' : '教务官方',
        g.examNature,
        g.passed ? '通过' : '未通过',
        subText,
      ]
        .map(csvCell)
        .join(',')
    );
  }

  rows.push('');
  rows.push(['汇总指标', '数值'].map(csvCell).join(','));
  rows.push(['总平均绩点 GPA', summary.weightedGpa.toFixed(3)].map(csvCell).join(','));
  rows.push(['必修课 GPA', summary.requiredGpa.toFixed(3)].map(csvCell).join(','));
  rows.push(['加权平均分', summary.weightedAvgScore.toFixed(2)].map(csvCell).join(','));
  rows.push(
    ['已获学分 / 修读学分', `${summary.totalCreditsEarned} / ${summary.totalCreditsAttempted}`]
      .map(csvCell)
      .join(',')
  );
  rows.push(
    ['课程通过率', `${summary.passRate.toFixed(1)}% (${summary.passedCourses}/${summary.totalCourses})`]
      .map(csvCell)
      .join(',')
  );

  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

export function buildSanitizedTranscriptText(grades: GradeItem[], summary: GpaSummary): string {
  const lines: string[] = [
    '========== 广东海洋大学 · 脱敏成绩单汇总 ==========',
    `总平均绩点 GPA：${summary.weightedGpa.toFixed(2)}  |  必修 GPA：${summary.requiredGpa.toFixed(2)}`,
    `加权均分：${summary.weightedAvgScore.toFixed(1)}  |  已获学分：${summary.totalCreditsEarned} / ${summary.totalCreditsAttempted}  |  通过率：${Math.round(summary.passRate)}%`,
    `共 ${summary.byTerm.length} 个学期 · ${summary.totalCourses} 门课程（不含学号与姓名）`,
    '',
  ];

  for (const term of summary.byTerm) {
    lines.push(
      `【${term.termKey}】GPA ${term.weightedGpa.toFixed(2)} · 均分 ${term.weightedAvgScore.toFixed(1)} · 学分 ${term.creditsEarned}/${term.creditsAttempted}`
    );
    const termCourses = grades
      .filter((g) => g.termKey === term.termKey)
      .sort((a, b) => b.credit - a.credit);
    for (const g of termCourses) {
      const est = g.gpaEstimated ? '(估)' : '';
      lines.push(
        `  - ${g.courseName} [${g.courseCategory || '课程'}]  学分:${g.credit}  成绩:${g.scoreText}  绩点:${g.gpa.toFixed(2)}${est}`
      );
    }
    lines.push('');
  }

  lines.push('导出自：海大课表（零留存本地脱敏导出）');
  return lines.join('\n');
}
