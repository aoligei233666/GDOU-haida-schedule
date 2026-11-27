import {
  CampusCourseSearchQuery,
  CampusCourseSearchResult,
  CourseItem,
  EmptyClassroomQueryParams,
  EmptyClassroomSnapshot,
  ExamItem,
  GradeItem,
  GraduationAuditReport,
  PeriodTime,
  SyncReceipt,
} from '../../types/models';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const OVERALL_SYNC_TIMEOUT_MS = 90_000;
export const NETCHECK_PROBE_TIMEOUT_MS = 6_000;
export const DIRECT_JW_PROBE_TIMEOUT_MS = 3_500;
export const OVERALL_TIMEOUT_REASON = 'GDOU_OVERALL_SYNC_TIMEOUT';
export const MAX_EXAM_QUERY_ATTEMPTS = 4;

export type GdouRoutePref = 'auto' | 'wfw' | 'campus';

export type AuxiliarySyncJob =
  | { kind: 'full_sync' }
  | { kind: 'empty_classroom'; params: EmptyClassroomQueryParams }
  | { kind: 'campus_search'; query: CampusCourseSearchQuery };

export interface AuthRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  userAgent?: string;
  job?: AuxiliarySyncJob;
}


export interface PreparedAuthSession {
  entryFinalUrl: string;
  authOrigin: string; // "https://authserver.gdou.edu.cn"
  jwBaseUrl: string; // "https://wfw.gdou.edu.cn/https://jw.gdou.edu.cn" or "https://jw.gdou.edu.cn"
  isWebVpn: boolean;
  serviceUrl: string;
  pwdEncryptSalt: string;
  execution: string;
  lt: string;
  ephemeralBfp: string; // per-session CSPRNG 32-char hex device fingerprint
  alreadyLoggedIn: boolean;
  preparedAtMs?: number;
}

export interface MfaChallengeState {
  required: true;
  reAuthUserId: string;
  serviceUrl: string;
  defaultReAuthType: '4' | '3'; // 4 = 企业微信验证码, 3 = 短信验证码
  credentialsPurged: boolean;
  session: PreparedAuthSession;
  previousSteps: string[];
}

/**
 * Off-campus WebVPN (`wfw.gdou.edu.cn`) sub-session auth handoff state after MFA passes.
 * Contains ZERO plaintext password (strict P0-5 zero-retention compliance).
 */
export interface WfwSubAuthState {
  required: true;
  username: string;
  salt2: string;
  execution2: string;
  lt2: string;
  needCaptcha: boolean;
  captchaImageUri?: string;
  session: PreparedAuthSession;
  previousSteps: string[];
}

export interface SyncResult {
  courses: CourseItem[];
  exams: ExamItem[];
  grades: GradeItem[];
  syncedPeriods?: PeriodTime[];
  detectedCampus?: string;
  graduationAudit?: GraduationAuditReport;
  emptyClassroomSnapshot?: EmptyClassroomSnapshot;
  campusSearchResult?: CampusCourseSearchResult;
  termLabel: string;
  academicYear: string;
  semesterCode: string;
  receipt: SyncReceipt;
}

export type OneShotSyncOutcome =
  | { status: 'completed'; result: SyncResult }
  | { status: 'mfa_required'; mfa: MfaChallengeState }
  | { status: 'wfw_subauth_required'; subAuth: WfwSubAuthState };

export type MfaCompletionOutcome =
  | { status: 'completed'; result: SyncResult }
  | { status: 'wfw_subauth_required'; subAuth: WfwSubAuthState }
  | { status: 'mfa_required'; mfa: MfaChallengeState };

export interface SyncTermOverride {
  xnm?: string;
  xqm?: string;
}

export interface CaptchaCheckResult {
  isNeed: boolean;
  imageDataUri?: string;
  checkFailed?: boolean;
  errorMessage?: string;
}

