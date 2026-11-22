export interface PeriodTime {
  section: number;
  start: string; // HH:mm
  end: string; // HH:mm
}

export type CampusPresetKey = 'huguang_0810' | 'huguang_0800' | 'yangjiang' | 'custom';

export interface CourseItem {
  id: string;
  name: string;
  code: string;
  teacher: string;
  location: string;
  campus: string;
  dayOfWeek: number; // 1 = Monday .. 7 = Sunday
  startSection: number; // 1 .. 12
  endSection: number; // 1 .. 12
  weeks: number[]; // sorted unique teaching week numbers
  weekText: string; // original display string e.g. "1-16周(单)"
  credit: string;
  classGroup: string;
  colorIndex: number;
}

export interface ExamItem {
  id: string;
  courseName: string;
  courseCode: string;
  examType: string; // e.g. 期末考试 / 补考 / 期中考试
  dateText: string; // YYYY-MM-DD
  startTimeText: string; // HH:mm
  endTimeText: string; // HH:mm
  startIso: string | null;
  endIso: string | null;
  rawTimeText: string;
  location: string;
  seatNumber: string;
  campus: string;
  invigilator: string;
  isManual?: boolean;
}

export interface GradeItem {
  id: string;
  courseName: string;
  courseCode: string;
  academicYear: string; // e.g. "2025-2026"
  semester: string; // "1" | "2" | "3"
  termKey: string; // e.g. "2025-2026 第1学期"
  credit: number; // xf
  scoreText: string; // cj raw text ("92", "优秀", "合格")
  numericScore: number | null; // bfzcj or converted numeric score
  gpa: number; // jd
  courseCategory: string; // kclbmc / kcxzmc e.g. "必修课", "专业核心课", "通识选修课"
  examNature: string; // ksxz e.g. "正常考试", "补考一", "重修"
  teacher: string;
  passed: boolean;
}

export interface GpaSummary {
  totalCreditsEarned: number;
  totalCreditsAttempted: number;
  weightedGpa: number;
  requiredGpa: number;
  weightedAvgScore: number;
  totalCourses: number;
  passedCourses: number;
  byCategory: { category: string; credits: number; count: number }[];
}

export type AlarmKind = 'class' | 'morning_wakeup' | 'exam';

export interface AlarmRule {
  id: string;
  kind: AlarmKind;
  title: string;
  body: string;
  targetId?: string;
  triggerIso: string; // exact trigger date-time ISO
  weekday: number; // 1..7
  hour: number; // 0..23
  minute: number; // 0..59
  advanceMinutes: number;
  enabled: boolean;
  notificationId?: string;
}

export interface AppSettings {
  campusPreset: CampusPresetKey;
  customPeriods: PeriodTime[];
  termStartDate: string; // YYYY-MM-DD (Monday of Week 1)
  totalWeeks: number;
  defaultCalendarReminderMinutes: number;
  defaultClassAlarmMinutes: number;
  defaultWakeupMinutes: number;
  examAdvanceMinutes: number;
}

export interface SyncReceipt {
  syncedAtIso: string;
  mode: 'direct' | 'webview';
  networkRoute: 'wfw-webvpn' | 'campus-direct' | 'webview-auto';
  termLabel: string;
  coursesCount: number;
  examsCount: number;
  gradesCount: number;
  credentialsPurged: true;
  sessionLoggedOut: boolean;
  steps: string[];
}

/**
 * Strictly credential-free persistence model.
 * Architecturally omits username, password, cookie, and session token fields.
 */
export interface PersistedAppData {
  schemaVersion: number;
  courses: CourseItem[];
  exams: ExamItem[];
  grades: GradeItem[];
  alarms: AlarmRule[];
  termLabel: string;
  academicYear: string; // e.g. "2025"
  semesterCode: string; // "3" (秋/第一学期) | "12" (春/第二学期) | "16" (第三学期)
  lastSyncedAt: string | null;
  lastSyncReceipt: SyncReceipt | null;
  settings: AppSettings;
}

/**
 * Ephemeral credentials object that exists ONLY inside an active login call
 * and is overwritten immediately after building the encrypted auth payload.
 */
export interface EphemeralCredentials {
  username: string;
  password: string;
  captcha?: string;
}
