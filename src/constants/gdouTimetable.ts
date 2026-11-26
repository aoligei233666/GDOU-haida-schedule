import {
  AppSettings,
  CampusPresetKey,
  CourseItem,
  ExamItem,
  GradeItem,
  PeriodTime,
  ScheduleAppearanceSettings,
  ScheduleWallpaperPreset,
} from '../types/models';

export const DEFAULT_SCHEDULE_APPEARANCE: ScheduleAppearanceSettings = {
  wallpaperPreset: 'none',
  customBackgroundUri: undefined,
  backgroundDimOpacity: 0.25,
  cardOpacity: 0.94,
};

export const WALLPAPER_PRESETS: Array<{
  key: Exclude<ScheduleWallpaperPreset, 'custom_photo'>;
  label: string;
  desc: string;
  bgColor: string;
  accentColor: string;
  gridTint: string;
  isDark?: boolean;
}> = [
  {
    key: 'none',
    label: '经典海大白',
    desc: '清爽高对比度',
    bgColor: '#F4F7FB',
    accentColor: '#0056D2',
    gridTint: 'rgba(255,255,255,0.92)',
  },
  {
    key: 'ocean_breeze',
    label: '湛蓝海风',
    desc: '湖光蔚蓝浅渐变',
    bgColor: '#E0F2FE',
    accentColor: '#0284C7',
    gridTint: 'rgba(240,249,255,0.72)',
  },
  {
    key: 'sunset_xiashan',
    label: '霞山落日',
    desc: '暖橘暮色护眼',
    bgColor: '#FFF7ED',
    accentColor: '#EA580C',
    gridTint: 'rgba(255,247,237,0.78)',
  },
  {
    key: 'mist_huguang',
    label: '湖光晨雾',
    desc: '青翠森林淡雅',
    bgColor: '#ECFDF5',
    accentColor: '#059669',
    gridTint: 'rgba(236,253,245,0.76)',
  },
  {
    key: 'sakura_couple',
    label: '樱粉甜柔',
    desc: '温柔浪漫浅粉',
    bgColor: '#FDF2F8',
    accentColor: '#DB2777',
    gridTint: 'rgba(253,242,248,0.78)',
  },
  {
    key: 'deep_sea',
    label: '深海夜色',
    desc: '护眼深蓝夜幕',
    bgColor: '#0F172A',
    accentColor: '#38BDF8',
    gridTint: 'rgba(15,23,42,0.82)',
    isDark: true,
  },
];

export const GDOU_ENTRY_URL = 'https://netcheck.gdou.edu.cn/go.php?code=jw';

export const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
export const DAY_FULL_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export const CAMPUS_PRESETS: Record<
  Exclude<CampusPresetKey, 'custom'>,
  { label: string; description: string; periods: PeriodTime[] }
> = {
  huguang_0810: {
    label: '湖光 / 海滨校区（08:10 官方标准版）',
    description: '上午 08:10-11:50（小课间5分）· 下午 14:30-18:05 · 晚上 19:30 起',
    periods: [
      { section: 1, start: '08:10', end: '08:55' },
      { section: 2, start: '09:00', end: '09:45' },
      { section: 3, start: '10:15', end: '11:00' },
      { section: 4, start: '11:05', end: '11:50' },
      { section: 5, start: '14:30', end: '15:15' },
      { section: 6, start: '15:20', end: '16:05' },
      { section: 7, start: '16:30', end: '17:15' },
      { section: 8, start: '17:20', end: '18:05' },
      { section: 9, start: '19:30', end: '20:15' },
      { section: 10, start: '20:25', end: '21:10' },
      { section: 11, start: '21:20', end: '22:05' },
      { section: 12, start: '22:10', end: '22:55' },
    ],
  },
  huguang_0800: {
    label: '湖光校区（08:00 常规版）',
    description: '上午 08:00-11:40 · 下午 14:30-18:00 · 晚上 19:30 起',
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
    label: '阳江校区（08:20 版）',
    description: '上午 08:20-12:00 · 下午 14:30-18:05 · 晚上 19:30 起',
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

export function isValidHHMM(value: string): boolean {
  const m = String(value ?? '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

export function matchCampusPresetByName(
  campusName?: string
): Exclude<CampusPresetKey, 'custom'> | null {
  const s = String(campusName ?? '').trim();
  if (!s) return null;
  if (s.includes('阳江')) return 'yangjiang';
  if (s.includes('湖光') || s.includes('海滨') || s.includes('霞山')) return 'huguang_0810';
  return null;
}

export function getActivePeriods(settings: AppSettings): PeriodTime[] {
  if (settings.campusPreset === 'custom' && settings.customPeriods.length >= 8) {
    return settings.customPeriods;
  }
  const key = settings.campusPreset === 'custom' ? 'huguang_0810' : settings.campusPreset;
  return CAMPUS_PRESETS[key].periods;
}

function snapAnchorToTermMonday(anchor: Date): string {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  const diff = dow === 0 ? 1 : dow === 6 ? 2 : 1 - dow;
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Derive GDOU Week 1 Monday for a specific Zhengfang term `(xnm, xqm)`:
 * - `xqm='3'` (Fall term): Monday of the week of Sep 1 of `xnm` (e.g. 2025-3 -> 2025-09-01, 2026-3 -> 2026-08-31)
 * - `xqm='12'` (Spring term): first Monday of Mar of `xnm + 1` (e.g. 2025-12 -> 2026-03-02)
 */
export function getDefaultTermStartDateForTerm(xnm: string, xqm: string): string | null {
  const startYear = parseInt(String(xnm ?? '').trim(), 10);
  if (!Number.isFinite(startYear) || startYear < 2000 || startYear > 2100) return null;
  const sem = String(xqm ?? '').trim();
  if (sem === '3' || sem === '1') {
    return snapAnchorToTermMonday(new Date(startYear, 8, 1));
  }
  if (sem === '12' || sem === '2') {
    return snapAnchorToTermMonday(new Date(startYear + 1, 2, 1));
  }
  if (sem === '16') {
    return snapAnchorToTermMonday(new Date(startYear + 1, 6, 1));
  }
  return null;
}

/**
 * Derive a reasonable default Monday for the current academic term.
 * Fall semester usually starts on the Monday of Sep 1 week;
 * Spring semester usually starts on the first Monday of March.
 */
export function getDefaultTermStartDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1..12
  if (month >= 8 || month === 1) {
    const fallYear = month === 1 ? year - 1 : year;
    return snapAnchorToTermMonday(new Date(fallYear, 8, 1));
  }
  return snapAnchorToTermMonday(new Date(year, 2, 1));
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
    showNonCurrentWeekCourses: true,
    highlightCoupleFreeSlots: true,
    appearance: { ...DEFAULT_SCHEDULE_APPEARANCE },
    calendarOverrides: [],
    enableWidgetSync: true,
    enableOngoingNotification: false,
    enableLiveActivity: false,
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
    {
      id: 'sample-8',
      name: '海洋遥感与测绘实验',
      code: 'HY200804',
      teacher: '郑海涛',
      location: '钟海楼机房04012',
      campus: '湖光校区',
      dayOfWeek: 3,
      startSection: 9,
      endSection: 10,
      weeks: [1, 3, 5, 7, 9, 11, 13, 15],
      weekText: '1-15周(单)',
      credit: '1.0',
      classGroup: '海洋2401',
      colorIndex: 6,
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
      subScores: [
        { itemName: '平时成绩', weightText: '30%', scoreText: '95' },
        { itemName: '实验成绩', weightText: '10%', scoreText: '92' },
        { itemName: '期末卷面成绩', weightText: '60%', scoreText: '90.5' },
      ],
      subScoreSource: 'official_zf_detail',
      subScoreSourceLabel: '数据来源：海大示例预览数据（同步后自动替换为正方教务官方明细）',
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
      subScores: [
        { itemName: '平时成绩', weightText: '30%', scoreText: '94' },
        { itemName: '期末卷面成绩', weightText: '70%', scoreText: '85.4' },
      ],
      subScoreSource: 'official_zf_detail',
      subScoreSourceLabel: '数据来源：海大示例预览数据（同步后自动替换为正方教务官方明细）',
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
