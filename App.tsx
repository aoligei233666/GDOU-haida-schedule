import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import React, { Component, ErrorInfo, ReactNode, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { SyncResult } from './src/services/gdouAuth';
import {
  clearAllLocalData,
  createInitialAppData,
  loadPersistedData,
  savePersistedData,
} from './src/services/storageService';
import { COLORS } from './src/theme/colors';
import { AlarmRule, AppSettings, ExamItem, PersistedAppData } from './src/types/models';

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

  const mutateAppData = (updater: (prev: PersistedAppData) => PersistedAppData) => {
    dirtyVersionRef.current += 1;
    setAppData(updater);
  };

  const handleSelectTab = (key: TabKey) => {
    setActiveTab(key);
    setVisitedTabs((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  };

  const handleSyncSuccess = (result: SyncResult) => {
    mutateAppData((prev) => {
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
        courses: result.courses,
        exams: [...result.exams, ...manualExams],
        grades: result.grades.length > 0 ? result.grades : prev.grades,
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
    const warningBlock =
      receipt.warnings && receipt.warnings.length > 0
        ? `\n\n注意事项：\n• ${receipt.warnings.slice(0, 3).join('\n• ')}`
        : '';

    Alert.alert(
      allVerified ? '同步完成 · 已核验注销' : '同步完成 · 请留意回执',
      `成功拉取：\n• 课程安排：${result.courses.length} 项\n• 考试日程：${result.exams.length} 场\n• 成绩与学分：${result.grades.length} 门\n（${result.termLabel}）\n\n${logoutText}\n${purgeText}${warningBlock}`
    );
  };

  const handleLoadSample = () => {
    const sample = buildSampleGdouData();
    mutateAppData((prev) => ({
      ...prev,
      courses: sample.courses,
      exams: sample.exams,
      grades: sample.grades,
      termLabel: sample.termLabel,
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
      Alert.alert('已清空', '本地课表、考试、成绩和闹钟数据已全部清除。');
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
              alarms={appData.alarms}
              termLabel={appData.termLabel}
              settings={appData.settings}
              onOpenSync={() => setSyncModalOpen(true)}
              onLoadSampleData={handleLoadSample}
              onAlarmsAdded={handleAddAlarms}
            />
          </View>
        )}

        {visitedTabs.exams && (
          <View style={[styles.tabPane, activeTab !== 'exams' && styles.tabPaneHidden]}>
            <ExamsScreen
              exams={appData.exams}
              alarms={appData.alarms}
              settings={appData.settings}
              onOpenSync={() => setSyncModalOpen(true)}
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
              onOpenSync={() => setSyncModalOpen(true)}
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
              onOpenSync={() => setSyncModalOpen(true)}
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
