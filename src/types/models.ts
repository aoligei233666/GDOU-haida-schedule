export interface PeriodTime {
  section: number;
  start: string; // HH:mm
  end: string; // HH:mm
}

export type CampusPresetKey = 'huguang_0810' | 'huguang_0800' | 'yangjiang' | 'custom';

export interface CourseTodoItem {
  id: string;
  title: string;
  dueDate: string; // YYYY-MM-DD
  dueTime?: string; // HH:mm
  completed: boolean;
  createdAtIso: string;
  notificationId?: string;
}

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
  isManual?: boolean;
  isAudit?: boolean; // true when added via 全校/教师/班级课表搜索（旁听/蹭课）
  sourceLabel?: string;
  ownerTag?: 'mine' | 'partner';
  customNote?: string;
  customLocation?: string;
  customColorIndex?: number;
  todos?: CourseTodoItem[];
}

export type ThemePreference = 'system' | 'light' | 'dark';

export interface TermArchiveSnapshot {
  termKey: string; // e.g. "2025-12"
  termLabel: string;
  academicYear: string;
  semesterCode: string;
  termStartDate: string;
  courses: CourseItem[];
  exams: ExamItem[];
  updatedAtIso: string;
}

export type ScheduleViewMode = 'mine' | 'couple' | 'partner';

export interface CoupleScheduleProfile {
  partnerName: string;
  termLabel: string;
  termStartDate: string;
  courses: CourseItem[];
  updatedAtIso: string;
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

export interface GradeSubScoreItem {
  itemName: string; // e.g. "平时成绩" / "实验成绩" / "期末成绩" / "总评成绩"
  weightText: string; // e.g. "30%" / "70%"
  scoreText: string; // e.g. "92" / "85"
}

export type GradeDetailSource = 'official_zf_detail' | 'unavailable';

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
  jxbId?: string; // 正方教学班 ID (non-personal course class ID for sub-score query)
  rawXnm?: string; // e.g. "2025"
  rawXqm?: string; // e.g. "3" | "12"
  subScores?: GradeSubScoreItem[];
  subScoreSource?: GradeDetailSource;
  subScoreSourceLabel?: string; // Explicit source attribution shown in UI
  subScoreSyncedAtIso?: string;
}

export type CurriculumAuditSource = 'official_zf_curriculum' | 'local_grade_estimate';

export interface CurriculumModuleProgress {
  id: string;
  name: string;
  parentName?: string;
  requiredCredits: number | null;
  earnedCredits: number;
  inProgressCredits: number;
  remainingCredits: number | null;
  completedCourses: number;
  failedCourses: number;
  statusText?: string;
}

export interface GraduationAuditReport {
  source: CurriculumAuditSource;
  sourceLabel: string; // Explicit source attribution shown in UI
  syncedAtIso: string;
  programTitle?: string; // Major/curriculum title only (never student ID/name)
  totalRequiredCredits: number | null;
  totalEarnedCredits: number;
  totalInProgressCredits: number;
  totalRemainingCredits: number | null;
  modules: CurriculumModuleProgress[];
  note?: string;
}

export interface EmptyClassroomItem {
  id: string;
  roomName: string;
  roomCode: string;
  building: string;
  campus: string;
  roomType: string;
  seats: number;
  examSeats?: number;
  floor?: string;
}

export interface EmptyClassroomFilterOptions {
  campuses: Array<{ id: string; name: string }>;
  buildings: Array<{ id: string; name: string; campusId?: string }>;
  roomTypes: Array<{ id: string; name: string }>;
}

export interface EmptyClassroomQueryParams {
  xnm: string;
  xqm: string;
  campusId: string;
  buildingId: string;
  roomTypeId: string;
  week: number;
  dayOfWeek: number; // 1..7
  sections: number[]; // 1..12
  minSeats?: number;
}

export interface EmptyClassroomSnapshot {
  queriedAtIso: string;
  sourceLabel: string;
  params: EmptyClassroomQueryParams;
  campusName?: string;
  buildingName?: string;
  rooms: EmptyClassroomItem[];
  filterOptions?: EmptyClassroomFilterOptions;
}

export interface CampusCourseSearchQuery {
  xnm: string;
  xqm: string;
  keyword: string;
  teacher?: string;
  className?: string;
  dayOfWeek?: number; // 0 = all, 1..7
}

export interface CampusCourseSearchResult {
  queriedAtIso: string;
  sourceLabel: string;
  query: CampusCourseSearchQuery;
  courses: CourseItem[];
  endpointUsed?: string;
}

export type ScheduleDiffKind =
  | 'room_changed'
  | 'time_changed'
  | 'weeks_changed'
  | 'teacher_changed'
  | 'added'
  | 'removed';

export interface ScheduleDiffEntry {
  id: string;
  kind: ScheduleDiffKind;
  courseName: string;
  courseCode: string;
  summary: string;
  beforeText?: string;
  afterText?: string;
}

export interface ScheduleDiffReport {
  comparedAtIso: string;
  termLabel: string;
  entries: ScheduleDiffEntry[];
  dismissed?: boolean;
}

export type CalendarOverrideKind = 'holiday' | 'makeup' | 'event';

export interface CalendarDayOverride {
  date: string; // YYYY-MM-DD
  kind: CalendarOverrideKind;
  label: string;
  mappedDayOfWeek?: number; // 1..7 when kind === 'makeup'
  mappedWeek?: number; // optional target week override
  isPreset?: boolean;
}

export type ScheduleWallpaperPreset =
  | 'none'
  | 'ocean_breeze'
  | 'sunset_xiashan'
  | 'mist_huguang'
  | 'sakura_couple'
  | 'deep_sea'
  | 'custom_photo';

export interface ScheduleAppearanceSettings {
  wallpaperPreset: ScheduleWallpaperPreset;
  customBackgroundUri?: string;
  backgroundDimOpacity: number; // 0..0.75
  cardOpacity: number; // 0.65..1.0
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

export type AlarmSystemEngine = 'android_clock' | 'ios_alarmkit' | 'notification';

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
  systemAlarmId?: string;
  systemEngine?: AlarmSystemEngine;
  repeatsWeekly?: boolean;
}

export interface AppSettings {
  themePreference?: ThemePreference;
  campusPreset: CampusPresetKey;
  customPeriods: PeriodTime[];
  termStartDate: string; // YYYY-MM-DD (Monday of Week 1)
  totalWeeks: number;
  defaultCalendarReminderMinutes: number;
  defaultClassAlarmMinutes: number;
  defaultWakeupMinutes: number;
  examAdvanceMinutes: number;
  showNonCurrentWeekCourses: boolean;
  highlightCoupleFreeSlots: boolean;
  appearance: ScheduleAppearanceSettings;
  calendarOverrides: CalendarDayOverride[];
  enableWidgetSync: boolean;
  enableOngoingNotification: boolean;
  enableLiveActivity: boolean;
  dismissedUpdateVersion?: string;
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
  coupleSchedule: CoupleScheduleProfile | null;
  graduationAudit: GraduationAuditReport | null;
  lastScheduleDiff: ScheduleDiffReport | null;
  emptyClassroomSnapshot: EmptyClassroomSnapshot | null;
  campusSearchHistory: CampusCourseSearchResult | null;
  termLabel: string;
  academicYear: string; // e.g. "2025"
  semesterCode: string; // "3" (秋/第一学期) | "12" (春/第二学期) | "16" (第三学期)
  termArchives?: Record<string, TermArchiveSnapshot>;
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
