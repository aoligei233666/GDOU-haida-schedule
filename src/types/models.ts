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
  dayOfWeek: number; // 1 = Monday .. 7 = Sunday (0 if unparsed)
  startSection: number; // 1 .. 16 (0 if unparsed)
  endSection: number; // 1 .. 16 (0 if unparsed)
  weeks: number[]; // sorted unique teaching week numbers (empty if unparsed)
  weekText: string; // original display string e.g. "1-16周(单)"
  credit: string;
  classGroup: string;
  colorIndex: number;
  parseWarning?: string;
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
  gpaEstimated?: boolean; // true when jd was absent and mapped locally
  scoreEstimated?: boolean; // true when numericScore was mapped from text label
  courseCategory: string; // kclbmc / kcxzmc e.g. "必修课", "专业核心课", "通识选修课"
  examNature: string; // ksxz e.g. "正常考试", "补考一", "重修"
  teacher: string;
  passed: boolean;
}

export interface TermGradeBreakdown {
  termKey: string;
  academicYear: string;
  semester: string;
  coursesCount: number;
  passedCount: number;
  failedCount: number;
  creditsEarned: number;
  creditsAttempted: number;
  weightedGpa: number;
  weightedAvgScore: number;
}

export interface ScoreTierBucket {
  key: 'excellent' | 'good' | 'medium' | 'pass' | 'fail';
  label: string;
  rangeText: string;
  count: number;
  credits: number;
  ratio: number; // 0..1
}

export interface CreditCategorySummary {
  category: string;
  credits: number;
  attemptedCredits: number;
  count: number;
  share: number; // 0..1
}

export interface GpaSummary {
  totalCreditsEarned: number;
  totalCreditsAttempted: number;
  weightedGpa: number;
  requiredGpa: number;
  weightedAvgScore: number;
  totalCourses: number;
  passedCourses: number;
  failedCourses: number;
  passRate: number; // 0..100
  hasEstimatedItems: boolean;
  byCategory: CreditCategorySummary[];
  byTerm: TermGradeBreakdown[];
  scoreDistribution: ScoreTierBucket[];
}

export type AlarmKind = 'class' | 'morning_wakeup' | 'exam';

export interface AlarmRule {
  id: string;
  dedupeKey?: string;
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

export interface LogoutVerificationDetails {
  attempted: number;
  succeeded: number;
  casLoggedOut: boolean;
  failedEndpoints: string[];
}

export interface SyncReceipt {
  syncedAtIso: string;
  mode: 'direct' | 'webview';
  networkRoute: 'wfw-webvpn' | 'campus-direct' | 'webview-auto';
  termLabel: string;
  coursesCount: number;
  examsCount: number;
  gradesCount: number;
  credentialsPurged: boolean;
  sessionLoggedOut: boolean;
  storageCleaned: boolean;
  cookiesFlushed: boolean;
  logoutDetails?: LogoutVerificationDetails;
  warnings?: string[];
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
 * and has its references cleared immediately after constructing the encrypted payload.
 */
export interface EphemeralCredentials {
  username: string;
  password: string;
  captcha?: string;
}
