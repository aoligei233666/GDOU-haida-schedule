import { GpaSummary, GradeItem } from '../types/models';

interface RawZfGrade {
  kcmc?: string;
  kch?: string;
  kch_id?: string;
  xf?: string | number;
  cj?: string | number;
  bfzcj?: string | number;
  jd?: string | number;
  kcxzmc?: string;
  kclbmc?: string;
  ksxz?: string;
  ksxzmc?: string;
  xnmmc?: string;
  xnm?: string;
  xqmmc?: string;
  xqm?: string;
  jsxm?: string;
  jxbmc?: string;
  sfxwkc?: string;
}

const TEXT_SCORE_MAP: Record<string, { score: number; gpa: number; passed: boolean }> = {
  优秀: { score: 95, gpa: 4.5, passed: true },
  优: { score: 95, gpa: 4.5, passed: true },
  良好: { score: 85, gpa: 3.5, passed: true },
  良: { score: 85, gpa: 3.5, passed: true },
  中等: { score: 75, gpa: 2.5, passed: true },
  中: { score: 75, gpa: 2.5, passed: true },
  及格: { score: 65, gpa: 1.5, passed: true },
  合格: { score: 80, gpa: 3.0, passed: true },
  通过: { score: 80, gpa: 3.0, passed: true },
  免修: { score: 85, gpa: 3.5, passed: true },
  不及格: { score: 50, gpa: 0, passed: false },
  不合格: { score: 50, gpa: 0, passed: false },
  未通过: { score: 50, gpa: 0, passed: false },
  缺考: { score: 0, gpa: 0, passed: false },
  缓考: { score: 0, gpa: 0, passed: false },
};

export function scoreToGdouGpa(score: number): number {
  if (!Number.isFinite(score) || score < 60) return 0;
  if (score >= 100) return 5.0;
  return Math.round(((score - 50) / 10) * 100) / 100;
}

function normalizeSemester(xqm?: string, xqmmc?: string): string {
  const m = String(xqmmc ?? '').trim();
  if (m === '1' || m === '2' || m === '3') return m;
  const raw = String(xqm ?? '').trim();
  if (raw === '3') return '1';
  if (raw === '12') return '2';
  if (raw === '16') return '3';
  return m || raw || '1';
}

function normalizeAcademicYear(xnm?: string, xnmmc?: string): string {
  const m = String(xnmmc ?? '').trim();
  if (m && m.includes('-')) return m;
  const y = parseInt(String(xnm ?? '').trim(), 10);
  if (Number.isFinite(y) && y > 2000) return `${y}-${y + 1}`;
  return m || '当前学年';
}

/**
 * Parse 正方教务 `/cjcx/cjcx_cxXsgrcj.html?doType=query` JSON response into GradeItem[].
 */
export function parseZfGradesResponse(raw: unknown): GradeItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.items)
    ? (obj.items as RawZfGrade[])
    : Array.isArray(obj.rows)
      ? (obj.rows as RawZfGrade[])
      : Array.isArray(raw)
        ? (raw as RawZfGrade[])
        : [];

  const grades: GradeItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const courseName = String(item.kcmc ?? '').trim();
    if (!courseName) continue;

    const courseCode = String(item.kch ?? item.kch_id ?? '').trim();
    const creditNum = parseFloat(String(item.xf ?? '0'));
    const credit = Number.isFinite(creditNum) && creditNum >= 0 ? creditNum : 0;

    const scoreText = String(item.cj ?? item.bfzcj ?? '').trim();
    const bfzNum = parseFloat(String(item.bfzcj ?? item.cj ?? ''));
    const mapped = TEXT_SCORE_MAP[scoreText];

    const numericScore = Number.isFinite(bfzNum)
      ? bfzNum
      : mapped
        ? mapped.score
        : null;

    const rawJd = parseFloat(String(item.jd ?? ''));
    let gpa = 0;
    let passed = false;

    if (Number.isFinite(rawJd) && rawJd >= 0) {
      gpa = rawJd;
      passed = rawJd > 0 || (numericScore !== null && numericScore >= 60);
    } else if (mapped) {
      gpa = mapped.gpa;
      passed = mapped.passed;
    } else if (numericScore !== null) {
      gpa = scoreToGdouGpa(numericScore);
      passed = numericScore >= 60;
    }

    const academicYear = normalizeAcademicYear(item.xnm, item.xnmmc);
    const semester = normalizeSemester(item.xqm, item.xqmmc);
    const termKey = `${academicYear} 第${semester}学期`;
    const courseCategory = String(item.kcxzmc ?? item.kclbmc ?? '普通课程').trim();
    const examNature = String(item.ksxz ?? item.ksxzmc ?? '正常考试').trim();
    const teacher = String(item.jsxm ?? '').trim();

    const dedup = `${courseCode || courseName}|${termKey}|${examNature}|${scoreText}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    grades.push({
      id: `grade-${i}-${courseCode || courseName}-${termKey}`,
      courseName,
      courseCode,
      academicYear,
      semester,
      termKey,
      credit,
      scoreText: scoreText || '-',
      numericScore,
      gpa,
      courseCategory,
      examNature,
      teacher,
      passed,
    });
  }

  grades.sort((a, b) => b.termKey.localeCompare(a.termKey) || b.credit - a.credit);
  return grades;
}

/**
 * Compute comprehensive GPA & Credit summary across all or filtered grades.
 * When a course has multiple attempts (e.g. retake/make-up), keeps the highest grade per course code/name
 * for cumulative credits & GPA calculation while also exposing course counts.
 */
export function computeGpaSummary(grades: GradeItem[]): GpaSummary {
  if (grades.length === 0) {
    return {
      totalCreditsEarned: 0,
      totalCreditsAttempted: 0,
      weightedGpa: 0,
      requiredGpa: 0,
      weightedAvgScore: 0,
      totalCourses: 0,
      passedCourses: 0,
      byCategory: [],
    };
  }

  // Deduplicate by courseCode/courseName keeping best attempt for GPA/credit summary
  const bestByCourse = new Map<string, GradeItem>();
  for (const g of grades) {
    const key = g.courseCode || g.courseName;
    const prev = bestByCourse.get(key);
    if (!prev || g.gpa > prev.gpa || (g.numericScore ?? 0) > (prev.numericScore ?? 0)) {
      bestByCourse.set(key, g);
    }
  }

  const effective = Array.from(bestByCourse.values());
  let totalCreditsEarned = 0;
  let totalCreditsAttempted = 0;
  let weightedGpaSum = 0;
  let gpaCreditsDenom = 0;

  let reqGpaSum = 0;
  let reqCreditsDenom = 0;

  let weightedScoreSum = 0;
  let scoreCreditsDenom = 0;
  let passedCourses = 0;

  const catMap = new Map<string, { credits: number; count: number }>();

  for (const g of effective) {
    totalCreditsAttempted += g.credit;
    if (g.passed) {
      totalCreditsEarned += g.credit;
      passedCourses++;

      const prevCat = catMap.get(g.courseCategory) ?? { credits: 0, count: 0 };
      catMap.set(g.courseCategory, {
        credits: Math.round((prevCat.credits + g.credit) * 100) / 100,
        count: prevCat.count + 1,
      });
    }

    if (g.credit > 0) {
      weightedGpaSum += g.gpa * g.credit;
      gpaCreditsDenom += g.credit;

      if (g.courseCategory.includes('必修')) {
        reqGpaSum += g.gpa * g.credit;
        reqCreditsDenom += g.credit;
      }

      if (g.numericScore !== null) {
        weightedScoreSum += g.numericScore * g.credit;
        scoreCreditsDenom += g.credit;
      }
    }
  }

  const byCategory = Array.from(catMap.entries())
    .map(([category, v]) => ({ category, credits: v.credits, count: v.count }))
    .sort((a, b) => b.credits - a.credits);

  return {
    totalCreditsEarned: Math.round(totalCreditsEarned * 100) / 100,
    totalCreditsAttempted: Math.round(totalCreditsAttempted * 100) / 100,
    weightedGpa:
      gpaCreditsDenom > 0 ? Math.round((weightedGpaSum / gpaCreditsDenom) * 100) / 100 : 0,
    requiredGpa:
      reqCreditsDenom > 0
        ? Math.round((reqGpaSum / reqCreditsDenom) * 100) / 100
        : gpaCreditsDenom > 0
          ? Math.round((weightedGpaSum / gpaCreditsDenom) * 100) / 100
          : 0,
    weightedAvgScore:
      scoreCreditsDenom > 0
        ? Math.round((weightedScoreSum / scoreCreditsDenom) * 100) / 100
        : 0,
    totalCourses: effective.length,
    passedCourses,
    byCategory,
  };
}
