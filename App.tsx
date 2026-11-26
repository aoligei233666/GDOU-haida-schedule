import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import React, { Component, ErrorInfo, ReactNode, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { EphemeralSyncModal } from './src/components/EphemeralSyncModal';
import {
  buildSampleGdouData,
  getDefaultTermStartDateForTerm,
  matchCampusPresetByName,
} from './src/constants/gdouTimetable';
import { AlarmsScreen } from './src/screens/AlarmsScreen';
import { ExamsScreen } from './src/screens/ExamsScreen';
import { GradesScreen } from './src/screens/GradesScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import {
  cancelAllScheduledAlarms,
  cancelScheduledAlarm,
  initializeAlarmEngine,
  mergeAlarmsIdempotently,
} from './src/services/alarmService';
import { buildSamplePartnerSchedule } from './src/services/coupleShareCodec';
import { AuxiliarySyncJob, SyncResult } from './src/services/gdouAuth';
import { syncNativeWidgetsAndLiveStatus } from './src/services/nativeWidgetBridge';
import { confirmActiveOtaBootIfNeeded } from './src/services/otaUpdateService';
import { computeScheduleDiff } from './src/services/scheduleDiff';
import {
  clearAllLocalData,
  createInitialAppData,
  loadPersistedData,
  savePersistedData,
} from './src/services/storageService';
import { COLORS } from './src/theme/colors';
import {
  AlarmRule,
  AppSettings,
  CampusCourseSearchQuery,
  CoupleScheduleProfile,
  CourseItem,
  EmptyClassroomQueryParams,
  ExamItem,
  PersistedAppData,
} from './src/types/models';

type TabKey = 'schedule' | 'exams' | 'grades' | 'alarms' | 'settings';

const TABS: {
  key: TabKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: 'schedule', label: '课表', icon: 'calendar-outline', activeIcon: 'calendar' },
  { key: 'exams', label: '考试', icon: 'school-outline', activeIcon: 'school' },
  { key: 'grades', label: '绩点学分', icon: 'ribbon-outline', activeIcon: 'ribbon' },
  { key: 'alarms', label: '闹钟日历', icon: 'alarm-outline', activeIcon: 'alarm' },
  { key: 'settings', label: '关于设置', icon: 'information-circle-outline', activeIcon: 'information-circle' },
];

class RootErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string; resetKey: number }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '', resetKey: 0 };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('RootErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorBoundary}>
          <Text style={styles.errorBoundaryTitle}>海大课表遇到异常已自动恢复保护</Text>
          <Text style={styles.errorBoundaryDesc}>{this.state.message}</Text>
          <TouchableOpacity
            style={styles.errorBoundaryBtn}
            onPress={() =>
              this.setState((prev) => ({
                hasError: false,
                message: '',
                resetKey: prev.resetKey + 1,
              }))
            }
          >
            <Text style={styles.errorBoundaryBtnText}>重新加载页面</Text>
          </TouchableOpacity>
          <Text style={styles.errorBoundaryFooter}>powered by 种果仁</Text>
        </View>
      );
    }
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

function MainApp() {
  const [ready, setReady] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('schedule');
  const [visitedTabs, setVisitedTabs] = useState<Record<TabKey, boolean>>({
    schedule: true,
    exams: false,
    grades: false,
    alarms: false,
    settings: false,
  });
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncTargetMode, setSyncTargetMode] = useState<{
    target: 'self' | 'partner' | 'empty_classroom' | 'campus_search';
    partnerNickname: string;
    job?: AuxiliarySyncJob;
  }>({ target: 'self', partnerNickname: 'TA' });
  const [appData, setAppData] = useState<PersistedAppData>(() => createInitialAppData());

  // Tracks user-initiated mutations so useEffect persists outside React's state updater
  const dirtyVersionRef = useRef(0);
  const savedVersionRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await initializeAlarmEngine();
      } catch (err) {
        console.warn('Alarm init warning:', err);
      }
      try {
        const loaded = await loadPersistedData();
        if (mounted) {
          setAppData(loaded);
        }
      } catch (err) {
        console.warn('Load persisted data warning:', err);
      } finally {
        if (mounted) {
          setReady(true);
          confirmActiveOtaBootIfNeeded();
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Side-effect safe persistence outside setState updater (StrictMode compliant)
  useEffect(() => {
    if (!ready) return;
    const versionToSave = dirtyVersionRef.current;
    if (versionToSave === savedVersionRef.current) return;

    let cancelled = false;
    void savePersistedData(appData)
      .then(() => {
        if (!cancelled) {
          savedVersionRef.current = versionToSave;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          Alert.alert(
            '本地保存失败',
            `无法写入本地存储：${err instanceof Error ? err.message : String(err)}`
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appData, ready]);

  // Auto-sync sanitized today's schedule to Android AppWidget, Android Ongoing Notification,
  // iOS WidgetKit, and iOS Dynamic Island Live Activity whenever data changes or app returns to foreground.
  useEffect(() => {
    if (!ready) return;
    void syncNativeWidgetsAndLiveStatus(
      appData.courses,
      appData.exams,
      appData.settings,
      appData.termLabel
    );
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void syncNativeWidgetsAndLiveStatus(
          appData.courses,
          appData.exams,
          appData.settings,
          appData.termLabel
        );
      }
    });
    return () => sub.remove();
  }, [ready, appData.courses, appData.exams, appData.settings, appData.termLabel]);

  const mutateAppData = (updater: (prev: PersistedAppData) => PersistedAppData) => {
    dirtyVersionRef.current += 1;
    setAppData(updater);
  };

  const handleSelectTab = (key: TabKey) => {
    setActiveTab(key);
    setVisitedTabs((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  };

  const handleOpenSelfSync = () => {
    setSyncTargetMode({ target: 'self', partnerNickname: 'TA', job: { kind: 'full_sync' } });
    setSyncModalOpen(true);
  };

  const handleOpenPartnerSync = (partnerNickname: string) => {
    setSyncTargetMode({
      target: 'partner',
      partnerNickname: partnerNickname.trim() || 'TA',
      job: { kind: 'full_sync' },
    });
    setSyncModalOpen(true);
  };

  const handleRequestEmptyClassroomQuery = (params: EmptyClassroomQueryParams) => {
    setSyncTargetMode({
      target: 'empty_classroom',
      partnerNickname: 'TA',
      job: { kind: 'empty_classroom', params },
    });
    setSyncModalOpen(true);
  };

  const handleRequestCampusCourseSearch = (query: CampusCourseSearchQuery) => {
    setSyncTargetMode({
      target: 'campus_search',
      partnerNickname: 'TA',
      job: { kind: 'campus_search', query },
    });
    setSyncModalOpen(true);
  };

  const handleSyncSuccess = (result: SyncResult) => {
    // Auxiliary Job A: Empty classroom live query (never alters schedule/grades)
    if (syncTargetMode.target === 'empty_classroom') {
      if (result.emptyClassroomSnapshot) {
        const snap = result.emptyClassroomSnapshot;
        mutateAppData((prev) => ({
          ...prev,
          emptyClassroomSnapshot: snap,
          lastSyncReceipt: result.receipt,
        }));
        Alert.alert(
          '空教室无痕查询完成',
          `共查到 ${snap.rooms.length} 间可用空闲教室（第 ${snap.params.week} 周 · 周${snap.params.dayOfWeek} · 第 ${snap.params.sections.join(',')} 节）。\n请重新点开课表页顶部「空教室」查看并筛选（会话已核验注销）。`
        );
      }
      return;
    }

    // Auxiliary Job B: Campus-wide / teacher / class course search
    if (syncTargetMode.target === 'campus_search') {
      if (result.campusSearchResult) {
        const res = result.campusSearchResult;
        mutateAppData((prev) => ({
          ...prev,
          campusSearchHistory: res,
          lastSyncReceipt: result.receipt,
        }));
        Alert.alert(
          '全校课表检索完成',
          `共命中 ${res.courses.length} 条开课记录。\n请重新点开课表页顶部「蹭课搜课」查看详情并一键加入旁听（会话已核验注销）。`
        );
      }
      return;
    }

    // Partner-only ephemeral sync: saves ONLY partner's courses into `coupleSchedule`
    if (syncTargetMode.target === 'partner') {
      const nickname = syncTargetMode.partnerNickname || 'TA';
      const alignedStart =
        getDefaultTermStartDateForTerm(result.academicYear, result.semesterCode) ||
        appData.settings.termStartDate;

      mutateAppData((prev) => ({
        ...prev,
        coupleSchedule: {
          partnerName: nickname,
          termLabel: result.termLabel,
          termStartDate: alignedStart,
          courses: result.courses.map((c) => ({ ...c, ownerTag: 'partner' })),
          updatedAtIso: result.receipt.syncedAtIso,
        },
        lastSyncReceipt: result.receipt,
      }));

      Alert.alert(
        '💕 TA 的课表无痕拉取成功',
        `已绑定「${nickname}」的 ${result.courses.length} 项课程排课（不影响你自己的课表与成绩）。\n对方教务会话已核验注销，本地未留存任何账号密码！`
      );
      return;
    }

    const diffReport = computeScheduleDiff(
      appData.courses,
      result.courses,
      result.termLabel,
      result.receipt.syncedAtIso
    );

    mutateAppData((prev) => {
      const manualCourses = prev.courses.filter((c) => c.isManual);
      const manualExams = prev.exams.filter((e) => e.isManual);
      const nextSettings: AppSettings = { ...prev.settings };

      // 1. Apply authoritative section bell schedule fetched from 正方 /kbcx/xskbcx_cxRjc.html when available
      if (result.syncedPeriods && result.syncedPeriods.length >= 8) {
        nextSettings.customPeriods = result.syncedPeriods;
        nextSettings.campusPreset = 'custom';
      } else if (prev.settings.campusPreset !== 'custom') {
        const matchedPreset = matchCampusPresetByName(
          result.detectedCampus || result.courses.find((c) => c.campus)?.campus
        );
        if (matchedPreset) {
          nextSettings.campusPreset = matchedPreset;
        }
      }

      // 2. Align termStartDate automatically whenever the synced term changes (or first sync)
      const termChanged =
        prev.academicYear !== result.academicYear ||
        prev.semesterCode !== result.semesterCode ||
        prev.courses.length === 0;
      if (termChanged) {
        const alignedMonday = getDefaultTermStartDateForTerm(
          result.academicYear,
          result.semesterCode
        );
        if (alignedMonday) {
          nextSettings.termStartDate = alignedMonday;
        }
      }

      return {
        ...prev,
        courses: [...result.courses, ...manualCourses],
        exams: [...result.exams, ...manualExams],
        grades: result.grades.length > 0 ? result.grades : prev.grades,
        graduationAudit: result.graduationAudit ?? prev.graduationAudit,
        emptyClassroomSnapshot: result.emptyClassroomSnapshot ?? prev.emptyClassroomSnapshot,
        lastScheduleDiff: diffReport ?? prev.lastScheduleDiff,
        termLabel: result.termLabel,
        academicYear: result.academicYear,
        semesterCode: result.semesterCode,
        lastSyncedAt: result.receipt.syncedAtIso,
        lastSyncReceipt: result.receipt,
        settings: nextSettings,
      };
    });

    const { receipt } = result;
    const allVerified = Boolean(
      receipt.credentialsPurged &&
        receipt.sessionLoggedOut &&
        receipt.storageCleaned &&
        receipt.cookiesFlushed
    );
    const logoutText = receipt.sessionLoggedOut
      ? '教务与统一认证会话已通过 HTTP 校验注销。'
      : `远端注销仅确认 ${receipt.logoutDetails?.succeeded ?? 0}/${
          receipt.logoutDetails?.attempted ?? 0
        } 项（可能因网络超时），建议留意官网登录状态。`;
    const purgeText =
      receipt.credentialsPurged && receipt.storageCleaned && receipt.cookiesFlushed
        ? '本地未保存任何账号密码，WebStorage 与临时 Cookie 均已校验清理。'
        : `本地清理状态：凭据释放=${receipt.credentialsPurged ? '已校验' : '未确认'} · 存储清理=${
            receipt.storageCleaned ? '已校验' : '未确认'
          } · Cookie冲洗=${receipt.cookiesFlushed ? '已校验' : '未确认'}。`;
    const diffLine =
      diffReport && diffReport.entries.length > 0
        ? `\n• 课表变动 Diff：检测到 ${diffReport.entries.length} 处变动（已在课表顶部高亮提示）`
        : '';
    const auditLine =
      result.graduationAudit?.source === 'official_zf_curriculum'
        ? '\n• 培养方案学分：已同步官方学业核对进度'
        : '';
    const warningBlock =
      receipt.warnings && receipt.warnings.length > 0
        ? `\n\n注意事项：\n• ${receipt.warnings.slice(0, 3).join('\n• ')}`
        : '';

    Alert.alert(
      allVerified ? '同步完成 · 已核验注销' : '同步完成 · 请留意回执',
      `成功拉取：\n• 课程安排：${result.courses.length} 项\n• 考试日程：${result.exams.length} 场\n• 成绩与学分：${result.grades.length} 门${auditLine}${diffLine}\n（${result.termLabel}）\n\n${logoutText}\n${purgeText}${warningBlock}`
    );
  };

  const handleLoadSample = () => {
    const sample = buildSampleGdouData();
    const samplePartner = buildSamplePartnerSchedule(
      sample.termLabel,
      appData.settings.termStartDate
    );
    mutateAppData((prev) => ({
      ...prev,
      courses: sample.courses,
      exams: sample.exams,
      grades: sample.grades,
      coupleSchedule: prev.coupleSchedule ?? samplePartner,
      termLabel: sample.termLabel,
    }));
  };

  const handleSaveCoupleSchedule = (profile: CoupleScheduleProfile | null) => {
    mutateAppData((prev) => ({
      ...prev,
      coupleSchedule: profile,
    }));
  };

  const handleAddManualCourse = (course: CourseItem) => {
    mutateAppData((prev) => ({
      ...prev,
      courses: [...prev.courses, course],
    }));
  };

  const handleDeleteManualCourse = (courseId: string) => {
    mutateAppData((prev) => ({
      ...prev,
      courses: prev.courses.filter((c) => c.id !== courseId),
    }));
  };

  const handleAddAlarms = (newAlarms: AlarmRule[]) => {
    const incomingNotifIds = new Set(
      newAlarms.map((a) => a.notificationId).filter((id): id is string => Boolean(id))
    );
    let supersededToCancel: AlarmRule[] = [];
    mutateAppData((prev) => {
      const { merged, replaced } = mergeAlarmsIdempotently(prev.alarms, newAlarms);
      supersededToCancel = replaced.filter(
        (old) => old.notificationId && !incomingNotifIds.has(old.notificationId)
      );
      return {
        ...prev,
        alarms: merged,
      };
    });
    for (const old of supersededToCancel) {
      void cancelScheduledAlarm(old);
    }
  };

  const handleReplaceAlarms = (alarms: AlarmRule[]) => {
    mutateAppData((prev) => ({
      ...prev,
      alarms,
    }));
  };

  const handleAddManualExam = (exam: ExamItem) => {
    mutateAppData((prev) => ({
      ...prev,
      exams: [...prev.exams, exam],
    }));
  };

  const handleDeleteExam = (examId: string) => {
    mutateAppData((prev) => ({
      ...prev,
      exams: prev.exams.filter((e) => e.id !== examId),
    }));
  };

  const handleDismissScheduleDiff = () => {
    mutateAppData((prev) => ({
      ...prev,
      lastScheduleDiff: prev.lastScheduleDiff
        ? { ...prev.lastScheduleDiff, dismissed: true }
        : null,
    }));
  };

  const handleSyncWidgetsNow = async () => {
    const res = await syncNativeWidgetsAndLiveStatus(
      appData.courses,
      appData.exams,
      appData.settings,
      appData.termLabel
    );
    Alert.alert(
      '桌面小组件与实时状态已刷新',
      `桌面小组件推送：${res.widgetSynced ? '已同步' : '需安装含原生组件的新版安装包'}\n` +
        `常驻通知 / 灵动岛：${
          res.ongoingSynced || res.liveActivitySynced ? '已更新' : '未开启或待新版原生底座生效'
        }`
    );
  };

  const handleUpdateSettings = (settings: AppSettings) => {
    mutateAppData((prev) => ({
      ...prev,
      settings,
    }));
  };

  const handleClearAll = async () => {
    try {
      await cancelAllScheduledAlarms();
    } catch (err) {
      console.warn('Cancel alarms during clear warning:', err);
    }
    try {
      await clearAllLocalData();
      const fresh = createInitialAppData();
      savedVersionRef.current = dirtyVersionRef.current;
      setAppData(fresh);
      Alert.alert('已清空', '本地课表、情侣课表、考试、成绩和闹钟数据已全部清除。');
    } catch (err) {
      Alert.alert(
        '清空失败',
        `无法清除本地存储：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.splash}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={COLORS.oceanLight} />
        <Text style={styles.splashText}>海大课表</Text>
        <Text style={styles.splashPowered}>powered by 种果仁</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeRoot} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />

      {/* Keep visited tabs mounted (display toggle) to preserve scroll & filter state */}
      <View style={styles.screenContainer}>
        {visitedTabs.schedule && (
          <View style={[styles.tabPane, activeTab !== 'schedule' && styles.tabPaneHidden]}>
            <ScheduleScreen
              courses={appData.courses}
              exams={appData.exams}
              coupleSchedule={appData.coupleSchedule}
              alarms={appData.alarms}
              termLabel={appData.termLabel}
              academicYear={appData.academicYear}
              semesterCode={appData.semesterCode}
              settings={appData.settings}
              lastScheduleDiff={appData.lastScheduleDiff}
              emptyClassroomSnapshot={appData.emptyClassroomSnapshot}
              campusSearchHistory={appData.campusSearchHistory}
              onOpenSync={handleOpenSelfSync}
              onOpenPartnerSync={handleOpenPartnerSync}
              onLoadSampleData={handleLoadSample}
              onAlarmsAdded={handleAddAlarms}
              onUpdateSettings={handleUpdateSettings}
              onSaveCoupleSchedule={handleSaveCoupleSchedule}
              onAddManualCourse={handleAddManualCourse}
              onDeleteManualCourse={handleDeleteManualCourse}
              onDismissScheduleDiff={handleDismissScheduleDiff}
              onRequestEmptyClassroomQuery={handleRequestEmptyClassroomQuery}
              onRequestCampusCourseSearch={handleRequestCampusCourseSearch}
            />
          </View>
        )}

        {visitedTabs.exams && (
          <View style={[styles.tabPane, activeTab !== 'exams' && styles.tabPaneHidden]}>
            <ExamsScreen
              exams={appData.exams}
              alarms={appData.alarms}
              settings={appData.settings}
              onOpenSync={handleOpenSelfSync}
              onAddManualExam={handleAddManualExam}
              onDeleteExam={handleDeleteExam}
              onAlarmsAdded={handleAddAlarms}
            />
          </View>
        )}

        {visitedTabs.grades && (
          <View style={[styles.tabPane, activeTab !== 'grades' && styles.tabPaneHidden]}>
            <GradesScreen
              grades={appData.grades}
              graduationAudit={appData.graduationAudit}
              onOpenSync={handleOpenSelfSync}
            />
          </View>
        )}

        {visitedTabs.alarms && (
          <View style={[styles.tabPane, activeTab !== 'alarms' && styles.tabPaneHidden]}>
            <AlarmsScreen
              courses={appData.courses}
              exams={appData.exams}
              alarms={appData.alarms}
              termLabel={appData.termLabel}
              settings={appData.settings}
              onAlarmsUpdated={handleReplaceAlarms}
            />
          </View>
        )}

        {visitedTabs.settings && (
          <View style={[styles.tabPane, activeTab !== 'settings' && styles.tabPaneHidden]}>
            <SettingsScreen
              settings={appData.settings}
              lastSyncReceipt={appData.lastSyncReceipt}
              onUpdateSettings={handleUpdateSettings}
              onClearAllData={handleClearAll}
              onOpenSync={handleOpenSelfSync}
              onSyncWidgetsNow={handleSyncWidgetsNow}
            />
          </View>
        )}
      </View>

      {/* Bottom Tab Bar */}
      <SafeAreaView style={styles.tabBarSafe} edges={['bottom']}>
        <View style={styles.tabBar}>
          {TABS.map((tab) => {
            const focused = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={styles.tabItem}
                onPress={() => handleSelectTab(tab.key)}
              >
                <Ionicons
                  name={focused ? tab.activeIcon : tab.icon}
                  size={21}
                  color={focused ? COLORS.oceanPrimary : COLORS.textMuted}
                />
                <Text style={[styles.tabLabel, focused && styles.tabLabelActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </SafeAreaView>

      <EphemeralSyncModal
        visible={syncModalOpen}
        syncJob={syncTargetMode.job}
        customHeaderTitle={
          syncTargetMode.target === 'partner'
            ? `💕 无痕拉取「${syncTargetMode.partnerNickname}」的课表`
            : syncTargetMode.target === 'empty_classroom'
              ? '无痕实时查询教务空教室'
              : syncTargetMode.target === 'campus_search'
                ? '无痕检索全校 / 教师 / 班级课表'
                : undefined
        }
        onClose={() => setSyncModalOpen(false)}
        onSyncSuccess={handleSyncSuccess}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <RootErrorBoundary>
      <SafeAreaProvider>
        <MainApp />
      </SafeAreaProvider>
    </RootErrorBoundary>
  );
}

const styles = StyleSheet.create({
  safeRoot: {
    flex: 1,
    backgroundColor: COLORS.oceanDeep,
  },
  screenContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  tabPane: {
    flex: 1,
  },
  tabPaneHidden: {
    display: 'none',
  },
  splash: {
    flex: 1,
    backgroundColor: COLORS.oceanDeep,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  splashText: {
    fontSize: 20,
    color: COLORS.white,
    fontWeight: '800',
    marginTop: 6,
  },
  splashPowered: {
    fontSize: 12,
    color: '#38BDF8',
    fontWeight: '700',
  },
  tabBarSafe: {
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  tabBar: {
    flexDirection: 'row',
    height: 58,
    alignItems: 'center',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabLabel: {
    fontSize: 10.5,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: COLORS.oceanPrimary,
    fontWeight: '700',
  },
  errorBoundary: {
    flex: 1,
    backgroundColor: COLORS.oceanDeep,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  errorBoundaryTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.white,
    textAlign: 'center',
  },
  errorBoundaryDesc: {
    fontSize: 13,
    color: '#CBD5E1',
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 20,
  },
  errorBoundaryBtn: {
    backgroundColor: COLORS.oceanPrimary,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 12,
  },
  errorBoundaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
  errorBoundaryFooter: {
    fontSize: 12,
    color: '#38BDF8',
    marginTop: 24,
    fontWeight: '700',
  },
});
