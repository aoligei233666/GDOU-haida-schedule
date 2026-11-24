import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import appConfig from '../../app.json';
import {
  CAMPUS_PRESETS,
  GDOU_ENTRY_URL,
  getActivePeriods,
  isValidHHMM,
} from '../constants/gdouTimetable';
import { openAndroidExactAlarmSettings } from '../services/alarmService';
import {
  ActiveOtaState,
  clearOtaAndRollbackToEmbedded,
  downloadAndApplyGithubOtaUpdate,
  downloadAndOpenReleaseInstaller,
  readActiveOtaState,
  TransferProgressInfo,
  triggerNativeOtaReload,
} from '../services/otaUpdateService';
import { parseLocalDateStrict } from '../services/scheduleParser';
import { auditLocalStorageZeroCredentials } from '../services/storageService';
import {
  buildAltStoreDirectInstallUrl,
  buildLiveContainerDirectInstallUrl,
  buildSideStoreDirectInstallUrl,
  buildTrollStoreDirectInstallUrl,
  checkForAppUpdate,
  FEATHER_ADD_SOURCE_URL,
  formatBytesCompact,
  getPlatformVersionHighlights,
  GITHUB_RELEASES_PAGE_URL,
  IOS_ALTSTORE_SOURCE_URL,
  isTrustedGithubReleaseUrl,
  SIDESTORE_ADD_SOURCE_URL,
  UpdateCheckResult,
} from '../services/updateService';
import { COLORS } from '../theme/colors';
import { AppSettings, CampusPresetKey, PeriodTime, SyncReceipt } from '../types/models';

const APP_VERSION = appConfig.expo.version;
const APP_BUILD_NUMBER =
  Platform.OS === 'ios'
    ? String(appConfig.expo.ios.buildNumber)
    : String(appConfig.expo.android.versionCode);
const APP_DISTRIBUTION = (process.env.EXPO_PUBLIC_APP_DISTRIBUTION || 'sideload').toLowerCase();
const IS_APPLE_OFFICIAL_STORE =
  Platform.OS === 'ios' && (APP_DISTRIBUTION === 'testflight' || APP_DISTRIBUTION === 'appstore');

interface Props {
  settings: AppSettings;
  lastSyncReceipt: SyncReceipt | null;
  onUpdateSettings: (next: AppSettings) => void;
  onClearAllData: () => void;
  onOpenSync: () => void;
}

export const SettingsScreen: React.FC<Props> = ({
  settings,
  lastSyncReceipt,
  onUpdateSettings,
  onClearAllData,
  onOpenSync,
}) => {
  const [termDateInput, setTermDateInput] = useState(settings.termStartDate);
  const [auditInfo, setAuditInfo] = useState<{
    hasStoredData: boolean;
    byteSize: number;
    credentialKeysFound: string[];
  } | null>(null);

  // Bell schedule custom editor state
  const activePeriods = useMemo(() => getActivePeriods(settings), [settings]);
  const [editingPeriods, setEditingPeriods] = useState(false);
  const [draftPeriods, setDraftPeriods] = useState<PeriodTime[]>(() =>
    activePeriods.map((p) => ({ ...p }))
  );

  // GitHub Releases update checker & in-app downloader state
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [activeOta, setActiveOta] = useState<ActiveOtaState | null>(() => readActiveOtaState());
  const [downloadingMode, setDownloadingMode] = useState<'ota' | 'binary' | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<TransferProgressInfo | null>(null);
  const downloadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTermDateInput(settings.termStartDate);
  }, [settings.termStartDate]);

  useEffect(() => {
    if (!editingPeriods) {
      setDraftPeriods(activePeriods.map((p) => ({ ...p })));
    }
  }, [activePeriods, editingPeriods]);

  useEffect(() => {
    void runPrivacyAudit();
    setActiveOta(readActiveOtaState());
  }, [lastSyncReceipt]);

  const runPrivacyAudit = async () => {
    const res = await auditLocalStorageZeroCredentials();
    setAuditInfo(res);
  };

  const handleSelectCampus = (key: Exclude<CampusPresetKey, 'custom'>) => {
    setEditingPeriods(false);
    onUpdateSettings({
      ...settings,
      campusPreset: key,
    });
  };

  const handleUpdateDraftPeriod = (
    section: number,
    field: 'start' | 'end',
    value: string
  ) => {
    setDraftPeriods((prev) =>
      prev.map((p) => (p.section === section ? { ...p, [field]: value } : p))
    );
  };

  const handleSaveCustomPeriods = () => {
    const normalized: PeriodTime[] = [];
    for (const p of draftPeriods) {
      const start = p.start.trim();
      const end = p.end.trim();
      if (!isValidHHMM(start) || !isValidHHMM(end)) {
        Alert.alert(
          '时间格式错误',
          `第 ${p.section} 节的时间格式须为 HH:mm（例如 08:10），请检查后重试。`
        );
        return;
      }
      if (start >= end) {
        Alert.alert(
          '时间范围无效',
          `第 ${p.section} 节的开始时间（${start}）必须早于结束时间（${end}）。`
        );
        return;
      }
      normalized.push({ section: p.section, start, end });
    }
    onUpdateSettings({
      ...settings,
      campusPreset: 'custom',
      customPeriods: normalized,
    });
    setEditingPeriods(false);
    Alert.alert('作息时间已更新', '已应用自定义节次时间，课表、日历与闹钟均将按新时间计算。');
  };

  const handleOpenTrustedUrl = async (url: string) => {
    const target = isTrustedGithubReleaseUrl(url) ? url : GITHUB_RELEASES_PAGE_URL;
    try {
      await Linking.openURL(target);
    } catch (err) {
      Alert.alert(
        '无法打开浏览器',
        `请手动访问：\n${target}\n\n（${err instanceof Error ? err.message : String(err)}）`
      );
    }
  };

  const handleOpenCustomScheme = async (schemeUrl: string, appLabel: string) => {
    try {
      await Linking.openURL(schemeUrl);
    } catch {
      Alert.alert(
        `未检测到 ${appLabel}`,
        `当前设备未安装 ${appLabel}。你可以直接使用上方「⚡ 软件内直接下载并热更新（免重签）」或「📥 软件内直下 IPA 安装包」！`
      );
    }
  };

  const handleOpenFeatherSource = async () => {
    try {
      await Linking.openURL(FEATHER_ADD_SOURCE_URL);
    } catch {
      Alert.alert(
        '未检测到 Feather 客户端',
        `请先在手机端安装 Feather、轻松签（ESign）或 SideStore，然后在「软件源 → 添加」粘贴以下源地址即可免电脑拉取更新：\n\n${IOS_ALTSTORE_SOURCE_URL}`,
        [
          { text: '关闭', style: 'cancel' },
          { text: '分享/复制源地址', onPress: () => void handleShareIosSource() },
        ]
      );
    }
  };

  const handleShareIosSource = async () => {
    try {
      await Share.share({
        message: IOS_ALTSTORE_SOURCE_URL,
        title: '海大课表 iOS 软件源地址（Feather / 轻松签 / SideStore）',
      });
    } catch {
      Alert.alert('iOS 软件源地址', IOS_ALTSTORE_SOURCE_URL);
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const res = await checkForAppUpdate(APP_VERSION, Platform.OS);
      setUpdateResult(res);
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleCancelActiveDownload = () => {
    downloadAbortRef.current?.abort();
    downloadAbortRef.current = null;
    setDownloadingMode(null);
    setDownloadProgress(null);
  };

  const handleInAppOtaHotUpdate = async () => {
    if (!updateResult?.otaDownloadUrl) return;
    const ac = new AbortController();
    downloadAbortRef.current = ac;
    setDownloadingMode('ota');
    setDownloadProgress({ bytesWritten: 0, totalBytes: updateResult.otaSizeBytes || 0, fraction: 0 });
    setUpdateError(null);

    try {
      const res = await downloadAndApplyGithubOtaUpdate({
        targetVersion: updateResult.latestVersion,
        otaDownloadUrl: updateResult.otaDownloadUrl,
        otaManifestUrl: updateResult.otaManifestUrl,
        expectedSizeBytes: updateResult.otaSizeBytes,
        currentRunningVersion: APP_VERSION,
        fallbackNativeBuild: APP_BUILD_NUMBER,
        onProgress: (info) => setDownloadProgress(info),
        signal: ac.signal,
      });
      setActiveOta(readActiveOtaState());
      if (!res.reloadedAutomatically) {
        Alert.alert(
          `🎉 v${updateResult.latestVersion} 热更新包已就绪`,
          'SHA-256 完整性校验已通过！请点击「立即重载」或重新打开 App 即可生效（无需电脑、无需重新签名）。',
          [
            {
              text: '立即重载生效',
              onPress: () => void triggerNativeOtaReload(),
            },
          ]
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadAbortRef.current = null;
      setDownloadingMode(null);
      setDownloadProgress(null);
    }
  };

  const handleInAppBinaryDownload = async () => {
    if (!updateResult) return;
    const assetName =
      updateResult.assetName ||
      (Platform.OS === 'ios'
        ? `haida-schedule-v${updateResult.latestVersion}-ios-unsigned.ipa`
        : `haida-schedule-v${updateResult.latestVersion}-android.apk`);

    if (!isTrustedGithubReleaseUrl(updateResult.downloadUrl) || !updateResult.assetName) {
      await handleOpenTrustedUrl(updateResult.downloadUrl);
      return;
    }

    const ac = new AbortController();
    downloadAbortRef.current = ac;
    setDownloadingMode('binary');
    setDownloadProgress({
      bytesWritten: 0,
      totalBytes: updateResult.assetSizeBytes || 0,
      fraction: 0,
    });
    setUpdateError(null);

    try {
      const res = await downloadAndOpenReleaseInstaller({
        downloadUrl: updateResult.downloadUrl,
        assetName,
        expectedSizeBytes: updateResult.assetSizeBytes,
        onProgress: (info) => setDownloadProgress(info),
        signal: ac.signal,
      });

      if (!res.handedOff) {
        Alert.alert(
          '安装包已下载至本机',
          `文件已保存至：\n${res.fileUri}`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadAbortRef.current = null;
      setDownloadingMode(null);
      setDownloadProgress(null);
    }
  };

  const handleRollbackOta = () => {
    Alert.alert(
      '回退到内置初始包',
      '将清除本地下载的热更新包并恢复到当前安装包内置版本。确定继续？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认回退',
          style: 'destructive',
          onPress: async () => {
            await clearOtaAndRollbackToEmbedded();
            setActiveOta(null);
            Alert.alert('已清除热更包', '重新打开应用后即恢复内置初始包。');
          },
        },
      ]
    );
  };

  const handleSaveTermDate = () => {
    const trimmed = termDateInput.trim();
    if (!parseLocalDateStrict(trimmed)) {
      Alert.alert('日期格式错误', '请输入有效的 YYYY-MM-DD 开学第一周周一日期，例如 2026-09-07。');
      return;
    }
    onUpdateSettings({ ...settings, termStartDate: trimmed });
    Alert.alert('开学日期已保存', `第 1 周周一已更新为 ${trimmed}，课表周次、日历日期和闹钟将按此基准计算。`);
  };

  const handleConfirmClear = () => {
    Alert.alert(
      '清空全部本地缓存',
      '将删除本地保存的课表、情侣课表、考试和闹钟列表。确定继续？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认清空',
          style: 'destructive',
          onPress: () => {
            onClearAllData();
            setTimeout(() => void runPrivacyAudit(), 200);
          },
        },
      ]
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>设置与关于</Text>
        <Text style={styles.headerSub}>海大课表 · 作息校历 · 隐私核验 · powered by 种果仁</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* About Card: 海大课表 · powered by 种果仁 */}
        <View style={styles.aboutCard}>
          <View style={styles.aboutBadge}>
            <Ionicons name="school" size={24} color={COLORS.white} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.aboutAppName}>海大课表</Text>
            <Text style={styles.aboutPowered}>powered by 种果仁</Text>
            <Text style={styles.aboutDesc}>
              专为广东海洋大学学子打造 · 支持课表、情侣课表、考试、绩点学分、系统日历与智能早起闹钟（账号密码用完即删）
            </Text>
          </View>
        </View>

        {/* Version & Direct GitHub Update Card */}
        {IS_APPLE_OFFICIAL_STORE ? (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="checkmark-circle-outline" size={20} color={COLORS.oceanPrimary} />
              <Text style={styles.cardTitle}>
                版本信息（{APP_DISTRIBUTION === 'testflight' ? 'TestFlight 官方测试版' : 'App Store 正式版'}）
              </Text>
            </View>
            <Text style={styles.cardDesc}>
              当前版本：v{APP_VERSION}（Build {appConfig.expo.ios.buildNumber}）{'\n'}
              {APP_DISTRIBUTION === 'testflight'
                ? '新版本发布后将通过 Apple TestFlight 自动推送更新，无需手动下载或重新签名。'
                : '新版本发布后将通过 Apple App Store 自动推送更新。'}
            </Text>
          </View>
        ) : (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="cloud-download-outline" size={20} color={COLORS.oceanPrimary} />
              <Text style={styles.cardTitle}>检查更新与软件内直接下载（GitHub）</Text>
            </View>
            <Text style={styles.cardDesc}>
              当前版本：v{APP_VERSION} · 已自动识别系统：{Platform.OS === 'ios' ? 'iOS' : 'Android'}
              {activeOta ? `（⚡ 热更新已生效 · 底座 v${activeOta.baseNativeVersion}）` : ''}
              {'\n'}
              {Platform.OS === 'ios'
                ? '支持在软件内直接从 GitHub 下载免电脑免重签热更新包，或直下 IPA 导入签名工具安装。'
                : '支持在软件内直接从 GitHub 下载极速热更新包，或直接下载 APK 自动调起系统安装。'}
            </Text>

            {activeOta && (
              <View style={styles.activeOtaBanner}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.activeOtaText}>
                    ⚡ 当前运行 GitHub 热更包 v{activeOta.otaVersion}（SHA-256: {activeOta.sha256.slice(0, 10)}…）
                  </Text>
                </View>
                <TouchableOpacity onPress={handleRollbackOta} style={styles.rollbackBtn}>
                  <Text style={styles.rollbackBtnText}>重置内置包</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Current Version Concise Improvement Summary */}
            <View style={styles.currentChangelogBox}>
              <Text style={styles.currentChangelogTitle}>
                ✨ v{APP_VERSION} 本次更新与改进简述
              </Text>
              {getPlatformVersionHighlights(Platform.OS).map((line, i) => (
                <Text key={i} style={styles.changelogBullet}>
                  • {line}
                </Text>
              ))}
            </View>

            <View style={styles.updateBtnRow}>
              <TouchableOpacity
                style={[
                  styles.updatePrimaryBtn,
                  (checkingUpdate || downloadingMode !== null) && { opacity: 0.65 },
                ]}
                onPress={handleCheckUpdate}
                disabled={checkingUpdate || downloadingMode !== null}
              >
                {checkingUpdate ? (
                  <ActivityIndicator size="small" color={COLORS.white} />
                ) : (
                  <Ionicons name="refresh-outline" size={16} color={COLORS.white} />
                )}
                <Text style={styles.updatePrimaryBtnText}>
                  {checkingUpdate ? '正在连接 GitHub...' : '检查新版本'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.updateSecondaryBtn}
                onPress={() => void handleOpenTrustedUrl(GITHUB_RELEASES_PAGE_URL)}
              >
                <Ionicons name="open-outline" size={15} color={COLORS.oceanPrimary} />
                <Text style={styles.updateSecondaryBtnText}>GitHub 发布页</Text>
              </TouchableOpacity>
            </View>

            {/* Live In-App Download Progress Bar */}
            {downloadingMode && downloadProgress && (
              <View style={styles.progressBox}>
                <View style={styles.progressHeader}>
                  <Text style={styles.progressTitle}>
                    {downloadingMode === 'ota'
                      ? '⚡ 正在从 GitHub 下载免重签热更新包...'
                      : `📥 正在从 GitHub 直接下载 ${Platform.OS === 'ios' ? 'IPA' : 'APK'} 安装包...`}
                  </Text>
                  <TouchableOpacity onPress={handleCancelActiveDownload}>
                    <Text style={styles.progressCancel}>取消</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${Math.round(downloadProgress.fraction * 100)}%` },
                    ]}
                  />
                </View>
                <Text style={styles.progressMeta}>
                  {formatBytesCompact(downloadProgress.bytesWritten) || '0 KB'}
                  {downloadProgress.totalBytes > 0
                    ? ` / ${formatBytesCompact(downloadProgress.totalBytes)} (${Math.round(
                        downloadProgress.fraction * 100
                      )}%)`
                    : ''}
                </Text>
              </View>
            )}

            {updateError && (
              <View style={styles.updateErrorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={COLORS.danger} />
                <Text style={styles.updateErrorText}>{updateError}</Text>
              </View>
            )}

            {updateResult && (
              <View
                style={[
                  styles.updateResultBox,
                  updateResult.hasUpdate ? styles.updateResultHighlight : styles.updateResultUpToDate,
                ]}
              >
                <Text
                  style={[
                    styles.updateResultTitle,
                    { color: updateResult.hasUpdate ? '#9A3412' : '#065F46' },
                  ]}
                >
                  {updateResult.hasUpdate
                    ? `🎉 发现新版本 v${updateResult.latestVersion}（当前 v${updateResult.currentVersion}）`
                    : updateResult.statusNote ||
                      `✅ 当前 v${updateResult.currentVersion} 已是最新版本（远端 v${updateResult.latestVersion}）`}
                </Text>

                {/* Concise parsed highlights of the remote version */}
                {updateResult.conciseHighlights.length > 0 ? (
                  <View style={{ marginTop: 6, gap: 3 }}>
                    <Text style={styles.remoteSummaryLabel}>更新改进摘要：</Text>
                    {updateResult.conciseHighlights.map((item, idx) => (
                      <Text key={idx} style={styles.updateNotes}>
                        • {item}
                      </Text>
                    ))}
                  </View>
                ) : updateResult.releaseNotes ? (
                  <Text style={[styles.updateNotes, { marginTop: 6 }]} numberOfLines={5}>
                    {updateResult.releaseNotes}
                  </Text>
                ) : null}

                {updateResult.hasUpdate && (
                  <View style={{ marginTop: 10, gap: 8 }}>
                    {/* 1. Primary: In-App OTA Hot-Update (Zero Computer / Zero Re-signing on iOS!) */}
                    {updateResult.otaDownloadUrl && (
                      <TouchableOpacity
                        style={[
                          styles.otaHotUpdateBtn,
                          downloadingMode !== null && { opacity: 0.6 },
                        ]}
                        onPress={() => void handleInAppOtaHotUpdate()}
                        disabled={downloadingMode !== null}
                      >
                        <Ionicons name="flash" size={16} color={COLORS.white} />
                        <Text style={styles.downloadReleaseBtnText}>
                          {Platform.OS === 'ios'
                            ? `软件内直接下载并热更新 v${updateResult.latestVersion}（免电脑·免重签）`
                            : `软件内直接下载并极速热更新 v${updateResult.latestVersion}`}
                          {updateResult.otaSizeBytes
                            ? ` · ${formatBytesCompact(updateResult.otaSizeBytes)}`
                            : ''}
                        </Text>
                      </TouchableOpacity>
                    )}

                    {/* 2. Secondary: In-App Direct Binary IPA/APK Download & Handoff */}
                    <TouchableOpacity
                      style={[
                        styles.downloadReleaseBtn,
                        downloadingMode !== null && { opacity: 0.6 },
                      ]}
                      onPress={() => void handleInAppBinaryDownload()}
                      disabled={downloadingMode !== null}
                    >
                      <Ionicons name="download-outline" size={16} color={COLORS.white} />
                      <Text style={styles.downloadReleaseBtnText}>
                        {Platform.OS === 'ios'
                          ? `软件内直下 IPA 安装包并导入签名工具${
                              updateResult.assetSizeBytes
                                ? ` (${formatBytesCompact(updateResult.assetSizeBytes)})`
                                : ''
                            }`
                          : `软件内直接下载 APK 并调起系统安装${
                              updateResult.assetSizeBytes
                                ? ` (${formatBytesCompact(updateResult.assetSizeBytes)})`
                                : ''
                            }`}
                      </Text>
                    </TouchableOpacity>

                    {/* 3. iOS One-Tap Direct Signer Deep Links when IPA URL is available */}
                    {Platform.OS === 'ios' && isTrustedGithubReleaseUrl(updateResult.downloadUrl) && (
                      <View style={styles.iosDirectSchemeGrid}>
                        <TouchableOpacity
                          style={styles.iosSchemePill}
                          onPress={() =>
                            void handleOpenCustomScheme(
                              buildSideStoreDirectInstallUrl(updateResult.downloadUrl),
                              'SideStore'
                            )
                          }
                        >
                          <Ionicons name="sparkles-outline" size={13} color={COLORS.oceanPrimary} />
                          <Text style={styles.iosSchemePillText}>SideStore 直装</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.iosSchemePill}
                          onPress={() =>
                            void handleOpenCustomScheme(
                              buildTrollStoreDirectInstallUrl(updateResult.downloadUrl),
                              'TrollStore'
                            )
                          }
                        >
                          <Ionicons name="hammer-outline" size={13} color={COLORS.oceanPrimary} />
                          <Text style={styles.iosSchemePillText}>巨魔 TrollStore</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.iosSchemePill}
                          onPress={() =>
                            void handleOpenCustomScheme(
                              buildAltStoreDirectInstallUrl(updateResult.downloadUrl),
                              'AltStore'
                            )
                          }
                        >
                          <Ionicons name="layers-outline" size={13} color={COLORS.oceanPrimary} />
                          <Text style={styles.iosSchemePillText}>AltStore 直装</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.iosSchemePill}
                          onPress={() =>
                            void handleOpenCustomScheme(
                              buildLiveContainerDirectInstallUrl(updateResult.downloadUrl),
                              'LiveContainer'
                            )
                          }
                        >
                          <Ionicons name="cube-outline" size={13} color={COLORS.oceanPrimary} />
                          <Text style={styles.iosSchemePillText}>LiveContainer</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )}
              </View>
            )}

            {/* iOS On-Device Source (Feather / ESign / SideStore) — strictly rendered ONLY on iOS */}
            {Platform.OS === 'ios' && (
              <View style={styles.iosSourceBox}>
                <Text style={styles.iosSourceTitle}>
                  iOS 手机端免电脑软件源（SideStore / Feather / 轻松签）
                </Text>
                <Text style={styles.iosSourceDesc}>
                  除软件内直接热更新外，也可在手机签名工具订阅本源，底座大版本升级时免电脑拉取重签：
                </Text>
                <Text style={styles.iosSourceUrl} selectable>
                  {IOS_ALTSTORE_SOURCE_URL}
                </Text>
                <View style={styles.iosSourceBtnRow}>
                  <TouchableOpacity
                    style={styles.iosSourceBtn}
                    onPress={() => void handleOpenCustomScheme(SIDESTORE_ADD_SOURCE_URL, 'SideStore')}
                  >
                    <Ionicons name="add-circle-outline" size={14} color={COLORS.oceanPrimary} />
                    <Text style={styles.iosSourceBtnText}>SideStore 加源</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.iosSourceBtn}
                    onPress={() => void handleOpenFeatherSource()}
                  >
                    <Ionicons name="add-circle-outline" size={14} color={COLORS.oceanPrimary} />
                    <Text style={styles.iosSourceBtnText}>Feather 加源</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.iosSourceBtn}
                    onPress={() => void handleShareIosSource()}
                  >
                    <Ionicons name="copy-outline" size={14} color={COLORS.oceanPrimary} />
                    <Text style={styles.iosSourceBtnText}>复制源</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Privacy Zero-Retention Audit Card */}
        <View style={[styles.card, styles.auditCard]}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={20} color={COLORS.emerald} />
            <Text style={[styles.cardTitle, { color: '#065F46' }]}>
              账号密码「用完即删」实时核验
            </Text>
          </View>
          <Text style={styles.auditDesc}>
            目标入口：{GDOU_ENTRY_URL}
            {'\n'}数据模型层与持久化层已强制剔除 username / password / cookie / token 字段，仅保留课表与考试信息。
          </Text>

          <View style={styles.auditMetrics}>
            <View style={styles.metricBox}>
              <Text style={styles.metricValue}>
                {auditInfo ? auditInfo.credentialKeysFound.length : 0}
              </Text>
              <Text style={styles.metricLabel}>本地凭据键数</Text>
            </View>
            <View style={styles.metricBox}>
              <Text style={styles.metricValue}>
                {auditInfo ? `${(auditInfo.byteSize / 1024).toFixed(1)} KB` : '0 KB'}
              </Text>
              <Text style={styles.metricLabel}>课表缓存大小</Text>
            </View>
            <View style={styles.metricBox}>
              <Text
                style={[
                  styles.metricValue,
                  {
                    color:
                      !auditInfo || auditInfo.credentialKeysFound.length === 0
                        ? COLORS.emerald
                        : COLORS.danger,
                  },
                ]}
              >
                {!auditInfo || auditInfo.credentialKeysFound.length === 0 ? 'PASS' : 'FAIL'}
              </Text>
              <Text style={styles.metricLabel}>零留存检测</Text>
            </View>
          </View>

          {lastSyncReceipt && (
            <View style={styles.receiptBox}>
              <Text style={styles.receiptTitle}>
                最近同步回执（{new Date(lastSyncReceipt.syncedAtIso).toLocaleString()}）
              </Text>
              <Text
                style={[
                  styles.receiptLine,
                  {
                    fontWeight: '700',
                    color:
                      lastSyncReceipt.credentialsPurged &&
                      lastSyncReceipt.sessionLoggedOut &&
                      Boolean(lastSyncReceipt.storageCleaned) &&
                      Boolean(lastSyncReceipt.cookiesFlushed)
                        ? COLORS.emerald
                        : COLORS.coral,
                    marginBottom: 4,
                  },
                ]}
              >
                凭据释放：{lastSyncReceipt.credentialsPurged ? '已校验' : '未确认'} · 远端注销：
                {lastSyncReceipt.sessionLoggedOut
                  ? `已确认 (${lastSyncReceipt.logoutDetails?.succeeded ?? 1}/${
                      lastSyncReceipt.logoutDetails?.attempted ?? 1
                    })`
                  : `未完全确认 (${lastSyncReceipt.logoutDetails?.succeeded ?? 0}/${
                      lastSyncReceipt.logoutDetails?.attempted ?? 0
                    })`}
                {'\n'}存储清理：{lastSyncReceipt.storageCleaned ? '已校验' : '未确认'} · Cookie冲洗：
                {lastSyncReceipt.cookiesFlushed ? '已校验' : '未确认'}
              </Text>
              {lastSyncReceipt.steps.map((s, idx) => (
                <Text key={idx} style={styles.receiptLine}>
                  {s}
                </Text>
              ))}
              {lastSyncReceipt.warnings && lastSyncReceipt.warnings.length > 0 && (
                <Text style={[styles.receiptLine, { color: COLORS.coral, marginTop: 4 }]}>
                  告警：{lastSyncReceipt.warnings.join('；')}
                </Text>
              )}
            </View>
          )}

          <View style={styles.auditBtns}>
            <TouchableOpacity style={styles.auditBtn} onPress={runPrivacyAudit}>
              <Ionicons name="scan-outline" size={15} color="#065F46" />
              <Text style={styles.auditBtnText}>立即重新扫描本地存储</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.auditBtn} onPress={onOpenSync}>
              <Ionicons name="sync-outline" size={15} color={COLORS.oceanPrimary} />
              <Text style={[styles.auditBtnText, { color: COLORS.oceanPrimary }]}>重新无痕同步</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Term Week 1 Start Date */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="calendar-number-outline" size={20} color={COLORS.oceanPrimary} />
            <Text style={styles.cardTitle}>学期第一周（周一）开学日期</Text>
          </View>
          <Text style={styles.cardDesc}>
            用于把「第 X 周 周几」精确换算为公历日期，写入系统日历与定时闹钟。请核对广海当学期校历填写。
          </Text>
          <View style={styles.dateRow}>
            <TextInput
              style={styles.dateInput}
              value={termDateInput}
              onChangeText={setTermDateInput}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={COLORS.textMuted}
            />
            <TouchableOpacity style={styles.saveDateBtn} onPress={handleSaveTermDate}>
              <Text style={styles.saveDateBtnText}>保存</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Campus Bell Schedule Presets + Custom Period Time Editor */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="time-outline" size={20} color={COLORS.oceanPrimary} />
            <Text style={styles.cardTitle}>校区作息时间表</Text>
          </View>
          <Text style={styles.cardDesc}>
            同步课表时会自动尝试拉取教务官方节次时间；若需按所在校区或冬/夏令时微调，可在下方选择预设或直接修改每节起止时间。
          </Text>

          {(Object.keys(CAMPUS_PRESETS) as Exclude<CampusPresetKey, 'custom'>[]).map((key) => {
            const preset = CAMPUS_PRESETS[key];
            const selected = settings.campusPreset === key;
            return (
              <TouchableOpacity
                key={key}
                style={[styles.presetRow, selected && styles.presetRowActive]}
                onPress={() => handleSelectCampus(key)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.presetTitle, selected && { color: COLORS.oceanPrimary }]}>
                    {preset.label}
                  </Text>
                  <Text style={styles.presetDesc}>{preset.description}</Text>
                </View>
                <Ionicons
                  name={selected ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={selected ? COLORS.oceanPrimary : COLORS.textMuted}
                />
              </TouchableOpacity>
            );
          })}

          {settings.campusPreset === 'custom' && (
            <View style={[styles.presetRow, styles.presetRowActive]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.presetTitle, { color: COLORS.oceanPrimary }]}>
                  当前：教务同步 / 自定义作息时间（{activePeriods.length} 节）
                </Text>
                <Text style={styles.presetDesc}>
                  第1节 {activePeriods[0]?.start}-{activePeriods[0]?.end} · 第5节{' '}
                  {activePeriods[4]?.start}-{activePeriods[4]?.end} · 第9节{' '}
                  {activePeriods[8]?.start}-{activePeriods[8]?.end}
                </Text>
              </View>
              <Ionicons name="radio-button-on" size={20} color={COLORS.oceanPrimary} />
            </View>
          )}

          {/* Compact Read-Only Preview of Active Section Times */}
          {!editingPeriods ? (
            <>
              <View style={styles.periodPreviewGrid}>
                {activePeriods.slice(0, 12).map((p) => (
                  <View key={p.section} style={styles.periodPreviewCell}>
                    <Text style={styles.periodPreviewSec}>第{p.section}节</Text>
                    <Text style={styles.periodPreviewTime}>
                      {p.start}-{p.end}
                    </Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.auditBtn, { marginTop: 10, borderColor: COLORS.oceanLight }]}
                onPress={() => {
                  setDraftPeriods(activePeriods.map((p) => ({ ...p })));
                  setEditingPeriods(true);
                }}
              >
                <Ionicons name="create-outline" size={15} color={COLORS.oceanPrimary} />
                <Text style={[styles.auditBtnText, { color: COLORS.oceanPrimary }]}>
                  自定义微调每节课起止时间
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <View style={styles.periodEditorWrap}>
              <Text style={styles.periodEditorHint}>
                请输入 24 小时制 HH:mm（例如 08:10），修改后点击保存即可生效：
              </Text>
              {draftPeriods.map((p) => (
                <View key={p.section} style={styles.periodEditRow}>
                  <Text style={styles.periodEditLabel}>第 {p.section} 节</Text>
                  <TextInput
                    style={styles.periodEditInput}
                    value={p.start}
                    onChangeText={(v) => handleUpdateDraftPeriod(p.section, 'start', v)}
                    placeholder="08:10"
                    placeholderTextColor={COLORS.textMuted}
                    maxLength={5}
                  />
                  <Text style={styles.periodEditDash}>—</Text>
                  <TextInput
                    style={styles.periodEditInput}
                    value={p.end}
                    onChangeText={(v) => handleUpdateDraftPeriod(p.section, 'end', v)}
                    placeholder="08:55"
                    placeholderTextColor={COLORS.textMuted}
                    maxLength={5}
                  />
                </View>
              ))}
              <View style={styles.periodEditActions}>
                <TouchableOpacity
                  style={styles.periodCancelBtn}
                  onPress={() => {
                    setDraftPeriods(activePeriods.map((p) => ({ ...p })));
                    setEditingPeriods(false);
                  }}
                >
                  <Text style={styles.periodCancelBtnText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.periodSaveBtn} onPress={handleSaveCustomPeriods}>
                  <Text style={styles.periodSaveBtnText}>保存自定义作息</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Default Reminder Offsets */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="notifications-outline" size={20} color={COLORS.coral} />
            <Text style={styles.cardTitle}>默认提前提醒分钟数</Text>
          </View>

          <OffsetSelector
            label="系统日历课前提醒"
            value={settings.defaultCalendarReminderMinutes}
            options={[10, 15, 20, 30]}
            onSelect={(v) => onUpdateSettings({ ...settings, defaultCalendarReminderMinutes: v })}
          />
          <OffsetSelector
            label="每日首课起床闹钟"
            value={settings.defaultWakeupMinutes}
            options={[30, 45, 60, 75]}
            onSelect={(v) => onUpdateSettings({ ...settings, defaultWakeupMinutes: v })}
          />
          <OffsetSelector
            label="考前出发闹钟"
            value={settings.examAdvanceMinutes}
            options={[60, 90, 120]}
            onSelect={(v) => onUpdateSettings({ ...settings, examAdvanceMinutes: v })}
          />

          {Platform.OS === 'android' && Number(Platform.Version) >= 31 && (
            <TouchableOpacity
              style={[styles.auditBtn, { marginTop: 12, borderColor: COLORS.oceanLight }]}
              onPress={() => void openAndroidExactAlarmSettings()}
            >
              <Ionicons name="alarm-outline" size={15} color={COLORS.oceanPrimary} />
              <Text style={[styles.auditBtnText, { color: COLORS.oceanPrimary }]}>
                检查 Android 12+ 精确闹钟权限
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Danger Zone */}
        <TouchableOpacity style={styles.clearBtn} onPress={handleConfirmClear}>
          <Ionicons name="trash-outline" size={18} color={COLORS.danger} />
          <Text style={styles.clearBtnText}>清空本地全部课表、情侣课表、考试、成绩与闹钟数据</Text>
        </TouchableOpacity>

        <View style={styles.footerAbout}>
          <Text style={styles.footerTitle}>海大课表 v{APP_VERSION}</Text>
          <Text style={styles.footerPowered}>powered by 种果仁</Text>
        </View>
      </ScrollView>
    </View>
  );
};

const OffsetSelector: React.FC<{
  label: string;
  value: number;
  options: number[];
  onSelect: (val: number) => void;
}> = ({ label, value, options, onSelect }) => (
  <View style={styles.offsetBlock}>
    <Text style={styles.offsetLabel}>{label}</Text>
    <View style={styles.offsetRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={opt}
          style={[styles.offsetChip, value === opt && styles.offsetChipActive]}
          onPress={() => onSelect(opt)}
        >
          <Text style={[styles.offsetChipText, value === opt && styles.offsetChipTextActive]}>
            {opt} 分钟
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  </View>
);

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    backgroundColor: COLORS.oceanDeep,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.white,
  },
  headerSub: {
    fontSize: 12,
    color: '#93C5FD',
    marginTop: 3,
  },
  content: {
    padding: 14,
    paddingBottom: 34,
    gap: 14,
  },
  aboutCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.oceanDeep,
    borderRadius: 16,
    padding: 16,
    gap: 14,
  },
  aboutBadge: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: COLORS.oceanPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aboutAppName: {
    fontSize: 18,
    fontWeight: '800',
    color: COLORS.white,
  },
  aboutPowered: {
    fontSize: 13,
    fontWeight: '700',
    color: '#38BDF8',
    marginTop: 2,
  },
  aboutDesc: {
    fontSize: 11.5,
    color: '#CBD5E1',
    marginTop: 4,
    lineHeight: 16,
  },
  footerAbout: {
    alignItems: 'center',
    paddingVertical: 10,
    gap: 3,
  },
  footerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  footerPowered: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanPrimary,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  auditCard: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  cardDesc: {
    fontSize: 12.5,
    color: COLORS.textSecondary,
    lineHeight: 18,
    marginBottom: 10,
  },
  activeOtaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 10,
    gap: 8,
  },
  activeOtaText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#065F46',
  },
  rollbackBtn: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: '#6EE7B7',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  rollbackBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#047857',
  },
  currentChangelogBox: {
    backgroundColor: COLORS.oceanTint,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    padding: 10,
    marginBottom: 10,
    gap: 3,
  },
  currentChangelogTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
    marginBottom: 2,
  },
  changelogBullet: {
    fontSize: 11.2,
    color: COLORS.textSecondary,
    lineHeight: 16,
  },
  progressBox: {
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    padding: 10,
    marginTop: 10,
    gap: 6,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progressTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.oceanDeep,
    flex: 1,
  },
  progressCancel: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.danger,
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 999,
  },
  progressMeta: {
    fontSize: 11,
    color: COLORS.textSecondary,
    textAlign: 'right',
    fontWeight: '600',
  },
  remoteSummaryLabel: {
    fontSize: 11.5,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  otaHotUpdateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.emerald,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    gap: 6,
  },
  iosDirectSchemeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  iosSchemePill: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    borderRadius: 8,
    paddingVertical: 7,
    gap: 4,
  },
  iosSchemePillText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: COLORS.oceanPrimary,
  },
  auditDesc: {
    fontSize: 12,
    color: '#047857',
    lineHeight: 18,
    marginBottom: 10,
  },
  auditMetrics: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  metricBox: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DCFCE7',
  },
  metricValue: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.oceanDeep,
  },
  metricLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  receiptBox: {
    backgroundColor: COLORS.white,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#DCFCE7',
    marginBottom: 10,
  },
  receiptTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065F46',
    marginBottom: 4,
  },
  receiptLine: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    lineHeight: 17,
  },
  auditBtns: {
    flexDirection: 'row',
    gap: 8,
  },
  auditBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    gap: 5,
  },
  auditBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065F46',
  },
  dateRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dateInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: COLORS.textPrimary,
    backgroundColor: COLORS.bg,
  },
  saveDateBtn: {
    backgroundColor: COLORS.oceanPrimary,
    paddingHorizontal: 18,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveDateBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.white,
  },
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    backgroundColor: COLORS.bg,
    marginTop: 8,
    gap: 10,
  },
  presetRowActive: {
    backgroundColor: COLORS.oceanTint,
    borderColor: COLORS.oceanPrimary,
  },
  presetTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  presetDesc: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  offsetBlock: {
    marginTop: 10,
  },
  offsetLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: 6,
  },
  offsetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  offsetChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  offsetChipActive: {
    backgroundColor: COLORS.oceanLight,
    borderColor: COLORS.oceanPrimary,
  },
  offsetChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  offsetChipTextActive: {
    color: COLORS.oceanPrimary,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.dangerLight,
    height: 46,
    borderRadius: 12,
    gap: 6,
  },
  clearBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.danger,
  },
  updateBtnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  updatePrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanPrimary,
    borderRadius: 10,
    paddingVertical: 10,
    gap: 6,
  },
  updatePrimaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.white,
  },
  updateSecondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.oceanTint,
    borderRadius: 10,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
    gap: 5,
  },
  updateSecondaryBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.oceanPrimary,
  },
  updateErrorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.dangerLight,
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
    gap: 6,
  },
  updateErrorText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.danger,
    lineHeight: 17,
  },
  updateResultBox: {
    borderRadius: 10,
    padding: 10,
    marginTop: 10,
    borderWidth: 1,
  },
  updateResultHighlight: {
    backgroundColor: '#FFF7ED',
    borderColor: '#FDBA74',
  },
  updateResultUpToDate: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  updateResultTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    lineHeight: 18,
  },
  updateNotes: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    lineHeight: 16.5,
  },
  downloadReleaseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.coral,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 6,
  },
  downloadReleaseBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.white,
    textAlign: 'center',
    flexShrink: 1,
  },
  periodPreviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  periodPreviewCell: {
    width: '31%',
    backgroundColor: COLORS.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    paddingVertical: 6,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  periodPreviewSec: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  periodPreviewTime: {
    fontSize: 10.5,
    color: COLORS.textSecondary,
    marginTop: 2,
  },
  periodEditorWrap: {
    marginTop: 10,
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 6,
  },
  periodEditorHint: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    marginBottom: 4,
  },
  periodEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  periodEditLabel: {
    width: 54,
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  periodEditInput: {
    flex: 1,
    height: 36,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 13,
    color: COLORS.textPrimary,
    textAlign: 'center',
  },
  periodEditDash: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '700',
  },
  periodEditActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  periodCancelBtn: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  periodCancelBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textSecondary,
  },
  periodSaveBtn: {
    flex: 2,
    height: 40,
    borderRadius: 10,
    backgroundColor: COLORS.oceanPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  periodSaveBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.white,
  },
  iosSourceBox: {
    marginTop: 12,
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.borderLight,
    padding: 10,
  },
  iosSourceTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  iosSourceDesc: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    lineHeight: 16,
    marginTop: 3,
  },
  iosSourceUrl: {
    fontSize: 11,
    color: COLORS.oceanPrimary,
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginTop: 6,
  },
  iosSourceBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  iosSourceBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    height: 34,
    borderRadius: 9,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.oceanLight,
  },
  iosSourceBtnText: {
    fontSize: 11.5,
    fontWeight: '700',
    color: COLORS.oceanPrimary,
  },
});
