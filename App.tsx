import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
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
import { buildSampleGdouData } from './src/constants/gdouTimetable';
import { AlarmsScreen } from './src/screens/AlarmsScreen';
import { ExamsScreen } from './src/screens/ExamsScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import {
  cancelAllScheduledAlarms,
  initializeAlarmEngine,
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

type TabKey = 'schedule' | 'exams' | 'alarms' | 'settings';

const TABS: {
  key: TabKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: 'schedule', label: '课表', icon: 'calendar-outline', activeIcon: 'calendar' },
  { key: 'exams', label: '考试', icon: 'school-outline', activeIcon: 'school' },
  { key: 'alarms', label: '闹钟日历', icon: 'alarm-outline', activeIcon: 'alarm' },
  { key: 'settings', label: '设置', icon: 'shield-checkmark-outline', activeIcon: 'shield-checkmark' },
];

function MainApp() {
  const [ready, setReady] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('schedule');
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [appData, setAppData] = useState<PersistedAppData>(() => createInitialAppData());

  useEffect(() => {
    let mounted = true;
    (async () => {
      await initializeAlarmEngine();
      const loaded = await loadPersistedData();
      if (mounted) {
        setAppData(loaded);
        setReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const persistUpdate = (updater: (prev: PersistedAppData) => PersistedAppData) => {
    setAppData((prev) => {
      const next = updater(prev);
      void savePersistedData(next);
      return next;
    });
  };

  const handleSyncSuccess = (result: SyncResult) => {
    persistUpdate((prev) => {
      // Preserve any manually added exams while replacing synced JWXT exams
      const manualExams = prev.exams.filter((e) => e.isManual);
      return {
        ...prev,
        courses: result.courses,
        exams: [...result.exams, ...manualExams],
        termLabel: result.termLabel,
        academicYear: result.academicYear,
        semesterCode: result.semesterCode,
        lastSyncedAt: result.receipt.syncedAtIso,
        lastSyncReceipt: result.receipt,
      };
    });

    Alert.alert(
      '同步完成 · 凭据已销毁',
      `成功拉取 ${result.courses.length} 项课程、${result.exams.length} 场考试（${result.termLabel}）。\n\n您的学号与密码已从内存中彻底清除，教务会话已注销，本地未保存任何登录凭据。`
    );
  };

  const handleLoadSample = () => {
    const sample = buildSampleGdouData();
    persistUpdate((prev) => ({
      ...prev,
      courses: sample.courses,
      exams: sample.exams,
      termLabel: sample.termLabel,
    }));
  };

  const handleAddAlarms = (newAlarms: AlarmRule[]) => {
    persistUpdate((prev) => ({
      ...prev,
      alarms: [...newAlarms, ...prev.alarms],
    }));
  };

  const handleReplaceAlarms = (alarms: AlarmRule[]) => {
    persistUpdate((prev) => ({
      ...prev,
      alarms,
    }));
  };

  const handleAddManualExam = (exam: ExamItem) => {
    persistUpdate((prev) => ({
      ...prev,
      exams: [...prev.exams, exam],
    }));
  };

  const handleDeleteExam = (examId: string) => {
    persistUpdate((prev) => ({
      ...prev,
      exams: prev.exams.filter((e) => e.id !== examId),
    }));
  };

  const handleUpdateSettings = (settings: AppSettings) => {
    persistUpdate((prev) => ({
      ...prev,
      settings,
    }));
  };

  const handleClearAll = async () => {
    await cancelAllScheduledAlarms();
    await clearAllLocalData();
    setAppData(createInitialAppData());
    Alert.alert('已清空', '本地课表、考试和闹钟数据已全部清除。');
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.splash}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={COLORS.oceanLight} />
        <Text style={styles.splashText}>正在初始化广海课表...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeRoot} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />

      <View style={styles.screenContainer}>
        {activeTab === 'schedule' && (
          <ScheduleScreen
            courses={appData.courses}
            termLabel={appData.termLabel}
            settings={appData.settings}
            onOpenSync={() => setSyncModalOpen(true)}
            onLoadSampleData={handleLoadSample}
            onAlarmsAdded={handleAddAlarms}
          />
        )}

        {activeTab === 'exams' && (
          <ExamsScreen
            exams={appData.exams}
            settings={appData.settings}
            onOpenSync={() => setSyncModalOpen(true)}
            onAddManualExam={handleAddManualExam}
            onDeleteExam={handleDeleteExam}
            onAlarmsAdded={handleAddAlarms}
          />
        )}

        {activeTab === 'alarms' && (
          <AlarmsScreen
            courses={appData.courses}
            exams={appData.exams}
            alarms={appData.alarms}
            termLabel={appData.termLabel}
            settings={appData.settings}
            onAlarmsUpdated={handleReplaceAlarms}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsScreen
            settings={appData.settings}
            lastSyncReceipt={appData.lastSyncReceipt}
            onUpdateSettings={handleUpdateSettings}
            onClearAllData={handleClearAll}
            onOpenSync={() => setSyncModalOpen(true)}
          />
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
                onPress={() => setActiveTab(tab.key)}
              >
                <Ionicons
                  name={focused ? tab.activeIcon : tab.icon}
                  size={22}
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
    <SafeAreaProvider>
      <MainApp />
    </SafeAreaProvider>
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
  splash: {
    flex: 1,
    backgroundColor: COLORS.oceanDeep,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  splashText: {
    fontSize: 14,
    color: COLORS.oceanLight,
    fontWeight: '600',
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
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: COLORS.oceanPrimary,
    fontWeight: '700',
  },
});
