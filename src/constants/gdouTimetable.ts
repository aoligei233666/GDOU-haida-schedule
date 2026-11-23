import { AppSettings, CampusPresetKey, CourseItem, ExamItem, GradeItem, PeriodTime } from '../types/models';

export const GDOU_ENTRY_URL = 'https://netcheck.gdou.edu.cn/go.php?code=jw';

export const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
export const DAY_FULL_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const CAMPUS_PRESETS: Record<
  Exclude<CampusPresetKey, 'custom'>,
  { label: string; description: string; periods: PeriodTime[] }
> = {
  huguang_0810: {
    label: '湖光校区（08:10 标准版）',
    description: '上午 08:10 起 · 下午 14:30 起 · 晚上 19:30 起',
    periods: [
      { section: 1, start: '08:10', end: '08:55' },
      { section: 2, start: '09:05', end: '09:50' },
      { section: 3, start: '10:10', end: '10:55' },
      { section: 4, start: '11:05', end: '11:50' },
      { section: 5, start: '14:30', end: '15:15' },
      { section: 6, start: '15:25', end: '16:10' },
      { section: 7, start: '16:25', end: '17:10' },
      { section: 8, start: '17:20', end: '18:05' },
      { section: 9, start: '19:30', end: '20:15' },
      { section: 10, start: '20:25', end: '21:10' },
      { section: 11, start: '21:20', end: '22:05' },
      { section: 12, start: '22:10', end: '22:55' },
    ],
  },
  huguang_0800: {
    label: '湖光校区（08:00 常规版）',
    description: '上午 08:00 起 · 下午 14:30 起 · 晚上 19:30 起',
    periods: [
      { section: 1, start: '08:00', end: '08:45' },
      { section: 2, start: '08:55', end: '09:40' },
      { section: 3, start: '10:00', end: '10:45' },
      { section: 4, start: '10:55', end: '11:40' },
      { section: 5, start: '14:30', end: '15:15' },
      { section: 6, start: '15:25', end: '16:10' },
      { section: 7, start: '16:20', end: '17:05' },
      { section: 8, start: '17:15', end: '18:00' },
      { section: 9, start: '19:30', end: '20:15' },
      { section: 10, start: '20:25', end: '21:10' },
      { section: 11, start: '21:20', end: '22:05' },
      { section: 12, start: '22:10', end: '22:55' },
    ],
  },
  yangjiang: {
    label: '阳江 / 海滨校区（08:20 版）',
    description: '上午 08:20 起 · 下午 14:30 起 · 晚上 19:30 起',
    periods: [
      { section: 1, start: '08:20', end: '09:05' },
      { section: 2, start: '09:15', end: '10:00' },
      { section: 3, start: '10:20', end: '11:05' },
      { section: 4, start: '11:15', end: '12:00' },
      { section: 5, start: '14:30', end: '15:15' },
      { section: 6, start: '15:25', end: '16:10' },
      { section: 7, start: '16:25', end: '17:10' },
      { section: 8, start: '17:20', end: '18:05' },
      { section: 9, start: '19:30', end: '20:15' },
      { section: 10, start: '20:25', end: '21:10' },
      { section: 11, start: '21:20', end: '22:05' },
      { section: 12, start: '22:10', end: '22:55' },
    ],
  },
};

export function getActivePeriods(settings: AppSettings): PeriodTime[] {
  if (settings.campusPreset === 'custom' && settings.customPeriods.length >= 10) {
    return settings.customPeriods;
  }
  const key = settings.campusPreset === 'custom' ? 'huguang_0810' : settings.campusPreset;
  return CAMPUS_PRESETS[key].periods;
}

/**
 * Derive a reasonable default Monday for the current academic term.
 * Fall semester usually starts on the first Monday of September;
 * Spring semester usually starts around late February / first Monday of March.
 */
export function getDefaultTermStartDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1..12
  let anchor: Date;
  if (month >= 8 || month === 1) {
    const fallYear = month === 1 ? year - 1 : year;
    anchor = new Date(fallYear, 8, 1); // Sep 1
  } else {
    anchor = new Date(year, 2, 1); // Mar 1
  }
  // Snap to Monday of that week (or next Monday if Sat/Sun)
  const dow = anchor.getDay(); // 0 Sun .. 6 Sat
  const diff = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  anchor.setDate(anchor.getDate() + diff);
  const y = anchor.getFullYear();
  const m = String(anchor.getMonth() + 1).padStart(2, '0');
  const d = String(anchor.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function deriveCurrentTermParams(now: Date = new Date()): {
  xnm: string;
  xqm: string;
  label: string;
} {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month >= 8) {
    return { xnm: String(year), xqm: '3', label: `${year}-${year + 1}学年 第1学期` };
  }
  if (month === 1) {
    return { xnm: String(year - 1), xqm: '3', label: `${year - 1}-${year}学年 第1学期` };
  }
  return { xnm: String(year - 1), xqm: '12', label: `${year - 1}-${year}学年 第2学期` };
}

export function createDefaultSettings(now: Date = new Date()): AppSettings {
  return {
    campusPreset: 'huguang_0810',
    customPeriods: CAMPUS_PRESETS.huguang_0810.periods.map((p) => ({ ...p })),
    termStartDate: getDefaultTermStartDate(now),
    totalWeeks: 20,
    defaultCalendarReminderMinutes: 15,
    defaultClassAlarmMinutes: 20,
    defaultWakeupMinutes: 45,
    examAdvanceMinutes: 90,
  };
}

/**
 * Sample GDOU schedule & exams so users can test calendar sync, alarms,
 * and UI navigation before authenticating with real JWXT credentials.
 */
export function buildSampleGdouData(now: Date = new Date()): {
  courses: CourseItem[];
  exams: ExamItem[];
  grades: GradeItem[];
  termLabel: string;
} {
  const term = deriveCurrentTermParams(now);
  const plusDays = (days: number): string => {
    const dt = new Date(now);
    dt.setDate(dt.getDate() + days);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const courses: CourseItem[] = [
    {
      id: 'sample-1',
      name: '海洋科学导论',
      code: 'HY100101',
      teacher: '陈海明',
      location: '钟海楼02018',
      campus: '湖光校区',
      dayOfWeek: 1,
      startSection: 1,
      endSection: 2,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '3.0',
      classGroup: '海洋2401',
      colorIndex: 0,
    },
    {
      id: 'sample-2',
      name: '高等数学（上）',
      code: 'SX110201',
      teacher: '林志强',
      location: '主教学楼402',
      campus: '湖光校区',
      dayOfWeek: 1,
      startSection: 5,
      endSection: 6,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '5.0',
      classGroup: '海洋2401',
      colorIndex: 1,
    },
    {
      id: 'sample-3',
      name: '数据结构与算法',
      code: 'JS200305',
      teacher: '王晓东',
      location: '科技楼308',
      campus: '湖光校区',
      dayOfWeek: 2,
      startSection: 3,
      endSection: 4,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '3.5',
      classGroup: '软工2402',
      colorIndex: 2,
    },
    {
      id: 'sample-4',
      name: '大学英语（三）',
      code: 'WY100303',
      teacher: '周丽华',
      location: '广学楼305',
      campus: '湖光校区',
      dayOfWeek: 3,
      startSection: 1,
      endSection: 2,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '2.0',
      classGroup: '英语B班',
      colorIndex: 3,
    },
    {
      id: 'sample-5',
      name: '数据结构实验',
      code: 'JS200306',
      teacher: '王晓东',
      location: '科技楼机房506',
      campus: '湖光校区',
      dayOfWeek: 3,
      startSection: 9,
      endSection: 10,
      weeks: [2, 4, 6, 8, 10, 12, 14, 16],
      weekText: '2-16周(双)',
      credit: '1.0',
      classGroup: '软工2402',
      colorIndex: 2,
    },
    {
      id: 'sample-6',
      name: '计算机组成原理',
      code: 'JS210402',
      teacher: '刘建国',
      location: '钟海楼03025',
      campus: '湖光校区',
      dayOfWeek: 4,
      startSection: 5,
      endSection: 6,
      weeks: Array.from({ length: 16 }, (_, i) => i + 1),
      weekText: '1-16周',
      credit: '3.5',
      classGroup: '软工2402',
      colorIndex: 4,
    },
    {
      id: 'sample-7',
      name: '概率论与数理统计',
      code: 'SX200501',
      teacher: '黄文静',
      location: '兴农楼205',
      campus: '湖光校区',
      dayOfWeek: 5,
      startSection: 3,
      endSection: 4,
      weeks: Array.from({ length: 15 }, (_, i) => i + 1),
      weekText: '1-15周',
      credit: '3.0',
      classGroup: '海洋2401',
      colorIndex: 5,
    },
  ];

  const examDate1 = plusDays(5);
  const examDate2 = plusDays(9);
  const examDate3 = plusDays(14);

  const exams: ExamItem[] = [
    {
      id: 'sample-exam-1',
      courseName: '高等数学（上）',
      courseCode: 'SX110201',
      examType: '期末考试',
      dateText: examDate1,
      startTimeText: '09:00',
      endTimeText: '11:00',
      startIso: `${examDate1}T09:00:00`,
      endIso: `${examDate1}T11:00:00`,
      rawTimeText: `${examDate1}(09:00-11:00)`,
      location: '钟海楼02018',
      seatNumber: '24',
      campus: '湖光校区',
      invigilator: '林志强',
    },
    {
      id: 'sample-exam-2',
      courseName: '数据结构与算法',
      courseCode: 'JS200305',
      examType: '期末考试',
      dateText: examDate2,
      startTimeText: '14:30',
      endTimeText: '16:30',
      startIso: `${examDate2}T14:30:00`,
      endIso: `${examDate2}T16:30:00`,
      rawTimeText: `${examDate2}(14:30-16:30)`,
      location: '主教学楼402',
      seatNumber: '09',
      campus: '湖光校区',
      invigilator: '王晓东',
    },
    {
      id: 'sample-exam-3',
      courseName: '大学英语（三）',
      courseCode: 'WY100303',
      examType: '期末考试',
      dateText: examDate3,
      startTimeText: '09:00',
      endTimeText: '11:00',
      startIso: `${examDate3}T09:00:00`,
      endIso: `${examDate3}T11:00:00`,
      rawTimeText: `${examDate3}(09:00-11:00)`,
      location: '广学楼305',
      seatNumber: '37',
      campus: '湖光校区',
      invigilator: '周丽华',
    },
  ];

  const grades: GradeItem[] = [
    {
      id: 'sample-grade-1',
      courseName: '海洋科学导论',
      courseCode: 'HY100101',
      academicYear: '2025-2026',
      semester: '1',
      termKey: '2025-2026 第1学期',
      credit: 3.0,
      scoreText: '92',
      numericScore: 92,
      gpa: 4.2,
      courseCategory: '专业必修课',
      examNature: '正常考试',
      teacher: '陈海明',
      passed: true,
    },
    {
      id: 'sample-grade-2',
      courseName: '高等数学（上）',
      courseCode: 'SX110201',
      academicYear: '2025-2026',
      semester: '1',
      termKey: '2025-2026 第1学期',
      credit: 5.0,
      scoreText: '88',
      numericScore: 88,
      gpa: 3.8,
      courseCategory: '公共必修课',
      examNature: '正常考试',
      teacher: '林志强',
      passed: true,
    },
    {
      id: 'sample-grade-3',
      courseName: '数据结构与算法',
      courseCode: 'JS200305',
      academicYear: '2025-2026',
      semester: '1',
      termKey: '2025-2026 第1学期',
      credit: 3.5,
      scoreText: '95',
      numericScore: 95,
      gpa: 4.5,
      courseCategory: '专业必修课',
      examNature: '正常考试',
      teacher: '王晓东',
      passed: true,
    },
    {
      id: 'sample-grade-4',
      courseName: '大学英语（三）',
      courseCode: 'WY100303',
      academicYear: '2025-2026',
      semester: '1',
      termKey: '2025-2026 第1学期',
      credit: 2.0,
      scoreText: '86',
      numericScore: 86,
      gpa: 3.6,
      courseCategory: '公共必修课',
      examNature: '正常考试',
      teacher: '周丽华',
      passed: true,
    },
    {
      id: 'sample-grade-5',
      courseName: '海洋文化概论',
      courseCode: 'TS100802',
      academicYear: '2025-2026',
      semester: '1',
      termKey: '2025-2026 第1学期',
      credit: 2.0,
      scoreText: '优秀',
      numericScore: 95,
      gpa: 4.5,
      courseCategory: '通识选修课',
      examNature: '正常考试',
      teacher: '赵海峰',
      passed: true,
    },
    {
      id: 'sample-grade-6',
      courseName: '概率论与数理统计',
      courseCode: 'SX200501',
      academicYear: '2025-2026',
      semester: '2',
      termKey: '2025-2026 第2学期',
      credit: 3.0,
      scoreText: '91',
      numericScore: 91,
      gpa: 4.1,
      courseCategory: '公共必修课',
      examNature: '正常考试',
      teacher: '黄文静',
      passed: true,
    },
    {
      id: 'sample-grade-7',
      courseName: '计算机组成原理',
      courseCode: 'JS210402',
      academicYear: '2025-2026',
      semester: '2',
      termKey: '2025-2026 第2学期',
      credit: 3.5,
      scoreText: '84',
      numericScore: 84,
      gpa: 3.4,
      courseCategory: '专业必修课',
      examNature: '正常考试',
      teacher: '刘建国',
      passed: true,
    },
    {
      id: 'sample-grade-8',
      courseName: '人工智能应用实践',
      courseCode: 'JS290101',
      academicYear: '2025-2026',
      semester: '2',
      termKey: '2025-2026 第2学期',
      credit: 2.0,
      scoreText: '良好',
      numericScore: 85,
      gpa: 3.5,
      courseCategory: '专业选修课',
      examNature: '正常考试',
      teacher: '吴明轩',
      passed: true,
    },
  ];

  return { courses, exams, grades, termLabel: `${term.label}（示例预览）` };
}
