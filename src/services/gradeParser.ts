import {
  CreditCategorySummary,
  GpaSummary,
  GradeItem,
  GradeSubScoreItem,
  ScoreTierBucket,
  TermGradeBreakdown,
} from '../types/models';

export const OFFICIAL_GRADE_DETAIL_SOURCE_LABEL =
  '数据来源：广东海洋大学正方教务「成绩明细」官方接口';

interface RawZfGrade {
  kcmc?: string;
  kch?: string;
  kch_id?: string;
  jxb_id?: string;
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
  xmblmc?: string;
  xmcj?: string | number;
  cjfx?: string;
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
 * Marks `gpaEstimated` / `scoreEstimated` whenever official `jd`/`bfzcj` was absent and locally estimated.
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

    const scoreEstimated = !Number.isFinite(bfzNum) && Boolean(mapped);
    const numericScore = Number.isFinite(bfzNum)
      ? bfzNum
      : mapped
        ? mapped.score
        : null;

    const rawJd = parseFloat(String(item.jd ?? ''));
    let gpa = 0;
    let passed = false;
    let gpaEstimated = false;

    if (Number.isFinite(rawJd) && rawJd >= 0) {
      gpa = rawJd;
      passed = rawJd > 0 || (numericScore !== null && numericScore >= 60);
    } else if (mapped) {
      gpa = mapped.gpa;
      passed = mapped.passed;
      gpaEstimated = true;
    } else if (numericScore !== null) {
      gpa = scoreToGdouGpa(numericScore);
      passed = numericScore >= 60;
      gpaEstimated = true;
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

    const jxbId = String(item.jxb_id ?? '').trim() || undefined;
    const rawXnm = String(item.xnm ?? '').trim() || undefined;
    const rawXqm = String(item.xqm ?? '').trim() || undefined;

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
      gpaEstimated,
      scoreEstimated,
      courseCategory,
      examNature,
      teacher,
      passed,
      jxbId,
      rawXnm,
      rawXqm,
    });
  }

  grades.sort((a, b) => b.termKey.localeCompare(a.termKey) || b.credit - a.credit);
  return grades;
}

function stripHtmlTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse 正方教务成绩明细 (`/cjcx/cjcx_cxCjxqGjh.html` HTML table OR JSON array/items)
 * into explicit sub-score rows (e.g. 平时成绩 30% -> 92, 期末成绩 70% -> 86).
 * Strictly preserves official weights & scores; never invents missing weights.
 */
export function parseZfGradeSubScoresResponse(raw: unknown): GradeSubScoreItem[] {
  const out: GradeSubScoreItem[] = [];
  const seen = new Set<string>();

  const pushUnique = (itemName: string, weightText: string, scoreText: string) => {
    const cleanName = itemName.trim();
    const cleanWeight = weightText.trim();
    const cleanScore = scoreText.trim();
    if (!cleanName || (!cleanScore && !cleanWeight)) return;
    if (/成绩分项|分项名称|课程名称|学号|姓名/i.test(cleanName)) return;
    const key = `${cleanName}|${cleanWeight}|${cleanScore}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      itemName: cleanName,
      weightText: cleanWeight || '-',
      scoreText: cleanScore || '-',
    });
  };

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseZfGradeSubScoresResponse(JSON.parse(trimmed));
      } catch {
        // Fall through to HTML table parser
      }
    }
    // Parse standard 正方 `<table id="subtab">` rows:
    // <tr><td>【 平时(30%) 】</td><td>92</td></tr>  OR  <tr><td>平时成绩</td><td>30%</td><td>92</td></tr>
    const rowMatches = trimmed.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const rowHtml of rowMatches) {
      const cells = Array.from(rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((m) =>
        stripHtmlTags(m[1] || '')
      );
      if (cells.length < 2) continue;
      if (cells.length === 2) {
        const left = cells[0].replace(/[【】\[\]]/g, '').trim();
        const right = cells[1];
        const weightMatch = left.match(/^(.+?)\s*[（(]\s*([0-9.]+%?)\s*[）)]$/);
        if (weightMatch) {
          pushUnique(weightMatch[1], weightMatch[2].endsWith('%') ? weightMatch[2] : `${weightMatch[2]}%`, right);
        } else {
          pushUnique(left, '-', right);
        }
      } else {
        // 3+ columns: could be [分项, 比例, 成绩] or [课程, 分项, 比例, 成绩]
        const lastIdx = cells.length - 1;
        const scoreCell = cells[lastIdx];
        const secondLast = cells[lastIdx - 1];
        const thirdLast = cells[lastIdx - 2];
        if (/%/.test(secondLast) || /^\d+(?:\.\d+)?$/.test(secondLast)) {
          pushUnique(thirdLast, secondLast.includes('%') ? secondLast : `${secondLast}%`, scoreCell);
        } else {
          const weightMatch = secondLast.match(/^(.+?)\s*[（(]\s*([0-9.]+%?)\s*[）)]$/);
          if (weightMatch) {
            pushUnique(weightMatch[1], weightMatch[2], scoreCell);
          } else {
            pushUnique(secondLast, '-', scoreCell);
          }
        }
      }
    }
    return out;
  }

  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(obj.items)
        ? obj.items
        : Array.isArray(obj.rows)
          ? obj.rows
          : Array.isArray(obj.data)
            ? obj.data
            : [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const rawName = String(rec.xmblmc ?? rec.cjfx ?? rec.xmbmc ?? rec.fxmc ?? rec.name ?? '').trim();
      const rawWeight = String(rec.xmbl ?? rec.bl ?? rec.qz ?? rec.weight ?? '').trim();
      const rawScore = String(rec.xmcj ?? rec.cj ?? rec.score ?? rec.fxcj ?? '').trim();
      if (!rawName) continue;
      const inlineMatch = rawName.match(/^(.+?)\s*[（(]\s*([0-9.]+%?)\s*[）)]$/);
      if (inlineMatch) {
        pushUnique(
          inlineMatch[1],
          rawWeight || (inlineMatch[2].endsWith('%') ? inlineMatch[2] : `${inlineMatch[2]}%`),
          rawScore
        );
      } else {
        pushUnique(
          rawName,
          rawWeight ? (rawWeight.includes('%') ? rawWeight : `${rawWeight}%`) : '-',
          rawScore
        );
      }
    }
  }

  return out;
}

function deduplicateBestAttempts(grades: GradeItem[]): GradeItem[] {
  const bestByCourse = new Map<string, GradeItem>();
  for (const g of grades) {
    const key = g.courseCode || g.courseName;
    const prev = bestByCourse.get(key);
    if (!prev || g.gpa > prev.gpa || (g.numericScore ?? 0) > (prev.numericScore ?? 0)) {
      bestByCourse.set(key, g);
    }
  }
  return Array.from(bestByCourse.values());
}

/**
 * Compute per-semester GPA, weighted average score, and earned/attempted credits breakdown
 * sorted from latest semester to earliest so students can compare term performance at a glance.
 */
export function computeTermBreakdowns(grades: GradeItem[]): TermGradeBreakdown[] {
  const grouped = new Map<string, GradeItem[]>();
  for (const g of grades) {
    const key = g.termKey || `${g.academicYear} 第${g.semester}学期`;
    const list = grouped.get(key) ?? [];
    list.push(g);
    grouped.set(key, list);
  }

  const breakdowns: TermGradeBreakdown[] = [];
  for (const [termKey, items] of grouped.entries()) {
    const effective = deduplicateBestAttempts(items);
    let creditsEarned = 0;
    let creditsAttempted = 0;
    let passedCount = 0;
    let failedCount = 0;
    let gpaSum = 0;
    let gpaDenom = 0;
    let scoreSum = 0;
    let scoreDenom = 0;

    for (const g of effective) {
      creditsAttempted += g.credit;
      if (g.passed) {
        creditsEarned += g.credit;
        passedCount++;
      } else {
        failedCount++;
      }
      if (g.credit > 0) {
        gpaSum += g.gpa * g.credit;
        gpaDenom += g.credit;
        if (g.numericScore !== null) {
          scoreSum += g.numericScore * g.credit;
          scoreDenom += g.credit;
        }
      }
    }

    breakdowns.push({
      termKey,
      academicYear: items[0]?.academicYear || '',
      semester: items[0]?.semester || '',
      coursesCount: effective.length,
      passedCount,
      failedCount,
      creditsEarned: Math.round(creditsEarned * 100) / 100,
      creditsAttempted: Math.round(creditsAttempted * 100) / 100,
      weightedGpa: gpaDenom > 0 ? Math.round((gpaSum / gpaDenom) * 100) / 100 : 0,
      weightedAvgScore: scoreDenom > 0 ? Math.round((scoreSum / scoreDenom) * 100) / 100 : 0,
    });
  }

  breakdowns.sort((a, b) => b.termKey.localeCompare(a.termKey));
  return breakdowns;
}

/**
 * Compute 5-tier score distribution (90+, 80-89, 70-79, 60-69, <60) across deduplicated courses.
 */
export function computeScoreDistribution(effectiveGrades: GradeItem[]): ScoreTierBucket[] {
  const buckets: ScoreTierBucket[] = [
    { key: 'excellent', label: '优秀', rangeText: '90-100 / GPA≥4.0', count: 0, credits: 0, ratio: 0 },
    { key: 'good', label: '良好', rangeText: '80-89 / GPA 3.0-3.9', count: 0, credits: 0, ratio: 0 },
    { key: 'medium', label: '中等', rangeText: '70-79 / GPA 2.0-2.9', count: 0, credits: 0, ratio: 0 },
    { key: 'pass', label: '及格', rangeText: '60-69 / GPA 1.0-1.9', count: 0, credits: 0, ratio: 0 },
    { key: 'fail', label: '未通过', rangeText: '<60 / 挂科待修', count: 0, credits: 0, ratio: 0 },
  ];

  for (const g of effectiveGrades) {
    let idx = 4;
    if (!g.passed) {
      idx = 4;
    } else if ((g.numericScore !== null && g.numericScore >= 90) || g.gpa >= 4.0) {
      idx = 0;
    } else if ((g.numericScore !== null && g.numericScore >= 80) || g.gpa >= 3.0) {
      idx = 1;
    } else if ((g.numericScore !== null && g.numericScore >= 70) || g.gpa >= 2.0) {
      idx = 2;
    } else {
      idx = 3;
    }
    buckets[idx].count += 1;
    buckets[idx].credits = Math.round((buckets[idx].credits + g.credit) * 100) / 100;
  }

  const total = effectiveGrades.length;
  if (total > 0) {
    for (const b of buckets) {
      b.ratio = Math.round((b.count / total) * 1000) / 1000;
    }
  }
  return buckets;
}

/**
 * Compute comprehensive GPA & Credit summary across all or filtered grades.
 * When a course has multiple attempts (e.g. retake/make-up), keeps the highest grade per course code/name
 * for cumulative credits & GPA calculation while also exposing per-term and tier distributions.
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
      failedCourses: 0,
      passRate: 0,
      hasEstimatedItems: false,
      byCategory: [],
      byTerm: [],
      scoreDistribution: computeScoreDistribution([]),
    };
  }

  const effective = deduplicateBestAttempts(grades);
  let totalCreditsEarned = 0;
  let totalCreditsAttempted = 0;
  let weightedGpaSum = 0;
  let gpaCreditsDenom = 0;

  let reqGpaSum = 0;
  let reqCreditsDenom = 0;

  let weightedScoreSum = 0;
  let scoreCreditsDenom = 0;
  let passedCourses = 0;
  let failedCourses = 0;
  let hasEstimatedItems = false;

  const catMap = new Map<string, { credits: number; attemptedCredits: number; count: number }>();

  for (const g of effective) {
    if (g.gpaEstimated || g.scoreEstimated) {
      hasEstimatedItems = true;
    }
    totalCreditsAttempted += g.credit;

    const prevCat = catMap.get(g.courseCategory) ?? {
      credits: 0,
      attemptedCredits: 0,
      count: 0,
    };
    prevCat.attemptedCredits = Math.round((prevCat.attemptedCredits + g.credit) * 100) / 100;
    prevCat.count += 1;

    if (g.passed) {
      totalCreditsEarned += g.credit;
      passedCourses++;
      prevCat.credits = Math.round((prevCat.credits + g.credit) * 100) / 100;
    } else {
      failedCourses++;
    }
    catMap.set(g.courseCategory, prevCat);

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

  const roundedEarned = Math.round(totalCreditsEarned * 100) / 100;
  const byCategory: CreditCategorySummary[] = Array.from(catMap.entries())
    .map(([category, v]) => ({
      category,
      credits: v.credits,
      attemptedCredits: v.attemptedCredits,
      count: v.count,
      share: roundedEarned > 0 ? Math.round((v.credits / roundedEarned) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.credits - a.credits || b.attemptedCredits - a.attemptedCredits);

  return {
    totalCreditsEarned: roundedEarned,
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
    failedCourses,
    passRate:
      effective.length > 0 ? Math.round((passedCourses / effective.length) * 1000) / 10 : 0,
    hasEstimatedItems,
    byCategory,
    byTerm: computeTermBreakdowns(grades),
    scoreDistribution: computeScoreDistribution(effective),
  };
}
