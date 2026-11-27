import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  downloadAndApplyGithubOtaUpdate,
  downloadAndOpenReleaseInstaller,
  detectInstalledIosSigners,
  fetchOptionalOtaManifest,
  InstalledIosSigner,
  NATIVE_OTA_RUNTIME_VERSION,
  openIosInAppStoreSheet,
  OtaApplyStage,
  RemoteOtaManifest,
  TransferProgressInfo,
  triggerNativeOtaReload,
} from '../services/otaUpdateService';
import {
  formatBytesCompact,
  GITHUB_RELEASES_PAGE_URL,
  isTrustedGithubReleaseUrl,
  UpdateCheckResult,
} from '../services/updateService';
import { COLORS } from '../theme/colors';

interface Props {
  visible: boolean;
  updateResult: UpdateCheckResult | null;
  currentRunningVersion: string;
  fallbackNativeBuild: string;
  isAppleOfficialStore: boolean;
  appStoreId?: string;
  onClose: () => void;
  onDismissVersion: (version: string) => void;
  onOtaApplied?: () => void;
}

const STAGE_LABEL_MAP: Record<OtaApplyStage, string> = {
  checking: '正在校验更新包元数据与底座兼容性...',
  downloading: '正在软件内极速下载更新包...',
  verifying: '正在执行 SHA-256 完整性校验...',
  applying: '正在写入更新包并配置防白屏回滚保护...',
  reloading: '更新校验通过，正在原地无感重启生效...',
};

export const InAppUpdateModal: React.FC<Props> = ({
  visible,
  updateResult,
  currentRunningVersion,
  fallbackNativeBuild,
  isAppleOfficialStore,
  appStoreId,
  onClose,
  onDismissVersion,
  onOtaApplied,
}) => {
  const [manifest, setManifest] = useState<RemoteOtaManifest | null>(null);
  const [checkingManifest, setCheckingManifest] = useState(false);
  const [installedSigners, setInstalledSigners] = useState<InstalledIosSigner[]>([]);
  const [downloadingMode, setDownloadingMode] = useState<'ota' | 'binary' | null>(null);
  const [otaStage, setOtaStage] = useState<OtaApplyStage>('downloading');
  const [progress, setProgress] = useState<TransferProgressInfo | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [manualReadyReload, setManualReadyReload] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!visible || !updateResult) {
      abortRef.current?.abort();
      abortRef.current = null;
      setDownloadingMode(null);
      setProgress(null);
      setErrorText(null);
      setManualReadyReload(false);
      setShowMoreOptions(false);
      return;
    }

    let cancelled = false;
    setErrorText(null);
    setManualReadyReload(false);
    setShowMoreOptions(false);

    if (updateResult.otaManifestUrl) {
      setCheckingManifest(true);
      void fetchOptionalOtaManifest(updateResult.otaManifestUrl)
        .then((res) => {
          if (!cancelled) setManifest(res?.manifest ?? null);
        })
        .catch(() => {
          if (!cancelled) setManifest(null);
        })
        .finally(() => {
          if (!cancelled) setCheckingManifest(false);
        });
    } else {
      setManifest(null);
      setCheckingManifest(false);
    }

    if (Platform.OS === 'ios' && !isAppleOfficialStore) {
      void detectInstalledIosSigners().then((list) => {
        if (!cancelled) setInstalledSigners(list);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [visible, updateResult, isAppleOfficialStore]);

  const requiresNativeUpgrade = useMemo(() => {
    if (isAppleOfficialStore) return true;
    if (!updateResult?.otaDownloadUrl) return true;
    if (
      manifest?.minNativeRuntimeVersion &&
      manifest.minNativeRuntimeVersion > NATIVE_OTA_RUNTIME_VERSION
    ) {
      return true;
    }
    return false;
  }, [isAppleOfficialStore, updateResult, manifest]);

  const canDirectOta = !requiresNativeUpgrade && Boolean(updateResult?.otaDownloadUrl);

  const primarySigner = useMemo(
    () => installedSigners.find((s) => Boolean(s.buildInstallUrl)) ?? null,
    [installedSigners]
  );

  const highlights = useMemo(() => {
    if (manifest?.highlights && manifest.highlights.length > 0) {
      return manifest.highlights;
    }
    if (updateResult?.conciseHighlights && updateResult.conciseHighlights.length > 0) {
      return updateResult.conciseHighlights;
    }
    return ['修复已知问题并优化课表、小组件与登录同步体验'];
  }, [manifest, updateResult]);

  if (!updateResult) return null;

  const handleCancelDownload = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setDownloadingMode(null);
    setProgress(null);
  };

  const handleRequestClose = () => {
    if (downloadingMode) {
      handleCancelDownload();
    }
    onClose();
  };

  const handlePrimaryUpdate = async () => {
    setErrorText(null);

    // 1. Official App Store / TestFlight build -> Native SKStoreProductViewController in-app sheet
    if (isAppleOfficialStore) {
      const storeId = (appStoreId || '').trim();
      if (storeId) {
        const opened = await openIosInAppStoreSheet(storeId);
        if (opened) {
          onClose();
          return;
        }
      }
      Alert.alert(
        '请前往 TestFlight / App Store 更新',
        '打开 TestFlight 或 App Store 即可一键覆盖升级至最新版本，本地课表与设置会自动保留。'
      );
      return;
    }

    // 2. Seamless In-App OTA Hot-Update (stays 100% inside the app, zero re-signing on iOS!)
    if (canDirectOta && updateResult.otaDownloadUrl) {
      const ac = new AbortController();
      abortRef.current = ac;
      setDownloadingMode('ota');
      setOtaStage('checking');
      setProgress({
        bytesWritten: 0,
        totalBytes: updateResult.otaSizeBytes || 0,
        fraction: 0,
      });

      try {
        const res = await downloadAndApplyGithubOtaUpdate({
          targetVersion: updateResult.latestVersion,
          otaDownloadUrl: updateResult.otaDownloadUrl,
          otaManifestUrl: updateResult.otaManifestUrl,
          expectedSizeBytes: updateResult.otaSizeBytes,
          currentRunningVersion,
          fallbackNativeBuild,
          onStage: (stage) => setOtaStage(stage),
          onProgress: (info) => setProgress(info),
          signal: ac.signal,
        });
        onOtaApplied?.();
        if (!res.reloadedAutomatically) {
          setManualReadyReload(true);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setErrorText(err instanceof Error ? err.message : String(err));
      } finally {
        abortRef.current = null;
        setDownloadingMode(null);
        setProgress(null);
      }
      return;
    }

    // 3. Native runtime upgrade (Android direct APK install / iOS direct IPA download or 1-tap signer handoff)
    await handleDirectBinaryInstall();
  };

  const handleDirectBinaryInstall = async () => {
    setErrorText(null);
    const assetName =
      updateResult.assetName ||
      (Platform.OS === 'ios'
        ? `haida-schedule-v${updateResult.latestVersion}-ios-unsigned.ipa`
        : `haida-schedule-v${updateResult.latestVersion}-android.apk`);

    if (!isTrustedGithubReleaseUrl(updateResult.downloadUrl) || !updateResult.assetName) {
      const target = isTrustedGithubReleaseUrl(updateResult.releaseUrl)
        ? updateResult.releaseUrl
        : GITHUB_RELEASES_PAGE_URL;
      await Linking.openURL(target).catch(() => {});
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setDownloadingMode('binary');
    setProgress({
      bytesWritten: 0,
      totalBytes: updateResult.assetSizeBytes || 0,
      fraction: 0,
    });

    try {
      const res = await downloadAndOpenReleaseInstaller({
        downloadUrl: updateResult.downloadUrl,
        assetName,
        otaManifestUrl: updateResult.otaManifestUrl,
        expectedSizeBytes: updateResult.assetSizeBytes,
        onProgress: (info) => setProgress(info),
        signal: ac.signal,
      });
      if (!res.handedOff) {
        Alert.alert('安装包已下载完成', `已保存至：${res.fileUri}`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
      setDownloadingMode(null);
      setProgress(null);
    }
  };

  const handleSignerDirectInstall = async (signer: InstalledIosSigner) => {
    if (!signer.buildInstallUrl || !isTrustedGithubReleaseUrl(updateResult.downloadUrl)) {
      return;
    }
    try {
      await Linking.openURL(signer.buildInstallUrl(updateResult.downloadUrl));
    } catch {
      setErrorText(`未能唤起 ${signer.label}，可点击下方直接下载 IPA 导入`);
    }
  };

  const pct = progress ? Math.round(progress.fraction * 100) : 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleRequestClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Ocean Gradient-Styled Top Banner */}
          <View style={styles.banner}>
            <View style={styles.bannerIconWrap}>
              <Ionicons
                name={canDirectOta ? 'flash' : 'cloud-download'}
                size={26}
                color={COLORS.oceanPrimary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerTitle}>发现新版本 v{updateResult.latestVersion}</Text>
              <Text style={styles.bannerSub}>
                当前 v{currentRunningVersion} → 最新 v{updateResult.latestVersion}
              </Text>
            </View>
            {!downloadingMode && (
              <TouchableOpacity onPress={handleRequestClose} hitSlop={10} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color="rgba(255,255,255,0.88)" />
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.body}>
            {/* Delivery Mode Pill */}
            <View
              style={[
                styles.modePill,
                canDirectOta ? styles.modePillOta : styles.modePillNative,
              ]}
            >
              <Ionicons
                name={canDirectOta ? 'sparkles' : 'layers-outline'}
                size={14}
                color={canDirectOta ? '#047857' : COLORS.oceanPrimary}
              />
              <Text
                style={[
                  styles.modePillText,
                  { color: canDirectOta ? '#065F46' : COLORS.oceanDeep },
                ]}
              >
                {checkingManifest
                  ? '正在检测最佳软件内更新通道...'
                  : canDirectOta
                    ? Platform.OS === 'ios'
                      ? '软件内极速更新 · 免电脑免重签 · 3 秒自动重启生效'
                      : '软件内极速热更新 · 校验后自动生效'
                    : isAppleOfficialStore
                      ? '应用内商店更新 · 无需离开 App'
                      : Platform.OS === 'ios'
                        ? '本次含原生能力升级（如小组件/系统桥接），需覆盖安装新 IPA'
                        : '本次含原生能力升级，将在软件内直下 APK 并自动调起安装'}
              </Text>
            </View>

            {/* Concise Release Notes */}
            <Text style={styles.sectionLabel}>本次更新内容</Text>
            <ScrollView style={styles.notesScroll} nestedScrollEnabled>
              {highlights.map((item, idx) => (
                <View key={idx} style={styles.noteRow}>
                  <View style={styles.noteDot} />
                  <Text style={styles.noteText}>{item}</Text>
                </View>
              ))}
            </ScrollView>

            {/* Live In-App Progress Area */}
            {downloadingMode && (
              <View style={styles.progressPanel}>
                <View style={styles.progressHeaderRow}>
                  <View style={styles.progressTitleWrap}>
                    <ActivityIndicator size="small" color={COLORS.oceanPrimary} />
                    <Text style={styles.progressTitle}>
                      {downloadingMode === 'ota'
                        ? STAGE_LABEL_MAP[otaStage]
                        : `正在软件内下载 ${Platform.OS === 'ios' ? 'IPA' : 'APK'} 安装包...`}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={handleCancelDownload} hitSlop={8}>
                    <Text style={styles.cancelText}>取消</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.max(4, pct)}%` }]} />
                </View>

                <View style={styles.progressFootRow}>
                  <Text style={styles.progressMeta}>
                    {formatBytesCompact(progress?.bytesWritten) || '0 KB'}
                    {progress && progress.totalBytes > 0
                      ? ` / ${formatBytesCompact(progress.totalBytes)}`
                      : ''}
                  </Text>
                  <Text style={styles.progressPct}>{pct}%</Text>
                </View>
              </View>
            )}

            {/* Manual reload prompt if auto-reload wasn't intercepted (e.g. Expo Go) */}
            {manualReadyReload && !downloadingMode && (
              <View style={styles.readyBox}>
                <Ionicons name="checkmark-circle" size={18} color={COLORS.emerald} />
                <Text style={styles.readyText}>
                  v{updateResult.latestVersion} 已通过 SHA-256 校验，点击下方按钮即可立即重启进入新版本。
                </Text>
              </View>
            )}

            {errorText && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={16} color={COLORS.danger} />
                <Text style={styles.errorText}>{errorText}</Text>
              </View>
            )}

            {/* Primary Action Area */}
            {!downloadingMode && (
              <View style={styles.actionsWrap}>
                {manualReadyReload ? (
                  <TouchableOpacity
                    style={styles.primaryBtn}
                    onPress={() => void triggerNativeOtaReload()}
                  >
                    <Ionicons name="refresh" size={18} color={COLORS.white} />
                    <Text style={styles.primaryBtnText}>立即重启并应用新版本</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    {/* When iOS requires native base IPA upgrade and an on-device signer is detected, make it 1-tap! */}
                    {Platform.OS === 'ios' &&
                      !canDirectOta &&
                      !isAppleOfficialStore &&
                      primarySigner && (
                        <TouchableOpacity
                          style={styles.primaryBtn}
                          onPress={() => void handleSignerDirectInstall(primarySigner)}
                        >
                          <Ionicons name="sparkles" size={17} color={COLORS.white} />
                          <Text style={styles.primaryBtnText}>
                            一键交给 {primarySigner.label} 升级安装
                          </Text>
                        </TouchableOpacity>
                      )}

                    <TouchableOpacity
                      style={[
                        Platform.OS === 'ios' && !canDirectOta && !isAppleOfficialStore && primarySigner
                          ? styles.secondaryActionBtn
                          : styles.primaryBtn,
                        checkingManifest && { opacity: 0.7 },
                      ]}
                      disabled={checkingManifest}
                      onPress={() => void handlePrimaryUpdate()}
                    >
                      <Ionicons
                        name={canDirectOta ? 'flash' : 'download-outline'}
                        size={17}
                        color={
                          Platform.OS === 'ios' && !canDirectOta && !isAppleOfficialStore && primarySigner
                            ? COLORS.oceanPrimary
                            : COLORS.white
                        }
                      />
                      <Text
                        style={
                          Platform.OS === 'ios' && !canDirectOta && !isAppleOfficialStore && primarySigner
                            ? styles.secondaryActionText
                            : styles.primaryBtnText
                        }
                      >
                        {canDirectOta
                          ? `立即软件内更新${
                              updateResult.otaSizeBytes
                                ? ` (${formatBytesCompact(updateResult.otaSizeBytes)})`
                                : ''
                            }`
                          : isAppleOfficialStore
                            ? '立即在应用内更新'
                            : Platform.OS === 'ios'
                              ? `软件内下载 IPA 安装包${
                                  updateResult.assetSizeBytes
                                    ? ` (${formatBytesCompact(updateResult.assetSizeBytes)})`
                                    : ''
                                }`
                              : `立即下载并安装 APK${
                                  updateResult.assetSizeBytes
                                    ? ` (${formatBytesCompact(updateResult.assetSizeBytes)})`
                                    : ''
                                }`}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}

                {/* Collapsible extra options when user wants binary/GitHub release directly */}
                {!isAppleOfficialStore && (
                  <View style={styles.extraWrap}>
                    <TouchableOpacity
                      onPress={() => setShowMoreOptions((v) => !v)}
                      style={styles.moreToggle}
                    >
                      <Text style={styles.moreToggleText}>
                        {showMoreOptions ? '收起其他更新方式' : '更多更新方式'}
                      </Text>
                      <Ionicons
                        name={showMoreOptions ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={COLORS.textMuted}
                      />
                    </TouchableOpacity>

                    {showMoreOptions && (
                      <View style={styles.moreRow}>
                        {canDirectOta && (
                          <TouchableOpacity
                            style={styles.moreChip}
                            onPress={() => void handleDirectBinaryInstall()}
                          >
                            <Text style={styles.moreChipText}>
                              下载完整 {Platform.OS === 'ios' ? 'IPA' : 'APK'}
                            </Text>
                          </TouchableOpacity>
                        )}
                        {Platform.OS === 'ios' &&
                          installedSigners
                            .filter((s) => s.buildInstallUrl && s.id !== primarySigner?.id)
                            .map((s) => (
                              <TouchableOpacity
                                key={s.id}
                                style={styles.moreChip}
                                onPress={() => void handleSignerDirectInstall(s)}
                              >
                                <Text style={styles.moreChipText}>{s.label} 直装</Text>
                              </TouchableOpacity>
                            ))}
                        <TouchableOpacity
                          style={styles.moreChip}
                          onPress={() => {
                            const url = isTrustedGithubReleaseUrl(updateResult.releaseUrl)
                              ? updateResult.releaseUrl
                              : GITHUB_RELEASES_PAGE_URL;
                            void Linking.openURL(url).catch(() => {});
                          }}
                        >
                          <Text style={styles.moreChipText}>GitHub 发布页</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )}

                {/* Non-blocking footer buttons (unlike forced-lock popups) */}
                <View style={styles.footerRow}>
                  <TouchableOpacity
                    style={styles.footerBtn}
                    onPress={() => {
                      onDismissVersion(updateResult.latestVersion);
                      onClose();
                    }}
                  >
                    <Text style={styles.footerMutedText}>忽略此版本</Text>
                  </TouchableOpacity>
                  <View style={styles.footerDivider} />
                  <TouchableOpacity style={styles.footerBtn} onPress={handleRequestClose}>
                    <Text style={styles.footerLaterText}>稍后再说</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.56)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 20,
    backgroundColor: COLORS.surface,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  banner: {
    backgroundColor: COLORS.oceanDeep,
    paddingHorizontal: 18,
    paddingVertical: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bannerIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.white,
  },
  bannerSub: {
    fontSize: 12,
    color: '#BAE6FD',
    marginTop: 2,
    fontWeight: '600',
  },
  closeBtn: {
    padding: 4,
  },
  body: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 14,
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    marginBottom: 12,
  },
  modePillOta: {
    backgroundColor: COLORS.emeraldLight,
  },
  modePillNative: {
    backgroundColor: COLORS.oceanLight,
  },
  modePillText: {
    flex: 1,
    fontSize: 11.5,
    fontWeight: '700',
    lineHeight: 16,
  },
  sectionLabel: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: 6,
  },
  notesScroll: {
    maxHeight: 155,
    marginBottom: 12,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 6,
  },
  noteDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.oceanPrimary,
    marginTop: 7,
  },
  noteText: {
    flex: 1,
    fontSize: 12.5,
    color: COLORS.textSecondary,
    lineHeight: 19,
  },
  progressPanel: {
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  progressHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 10,
  },
  progressTitleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressTitle: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.oceanDeep,
  },
  cancelText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: COLORS.danger,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.border,
    overflow: 'hidden',
  },
  progressFill: {
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.oceanPrimary,
  },
  progressFootRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  progressMeta: {
    fontSize: 11.5,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  progressPct: {
    fontSize: 12,
    color: COLORS.oceanPrimary,
    fontWeight: '800',
  },
  readyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: COLORS.emeraldLight,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  readyText: {
    flex: 1,
    fontSize: 12,
    color: '#065F46',
    lineHeight: 17,
    fontWeight: '600',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: COLORS.dangerLight,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    color: COLORS.danger,
    lineHeight: 17,
  },
  actionsWrap: {
    gap: 8,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: COLORS.oceanPrimary,
    height: 46,
    borderRadius: 13,
  },
  primaryBtnText: {
    fontSize: 14.5,
    fontWeight: '800',
    color: COLORS.white,
  },
  secondaryActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: COLORS.oceanLight,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    height: 42,
    borderRadius: 12,
  },
  secondaryActionText: {
    fontSize: 13.5,
    fontWeight: '700',
    color: COLORS.oceanPrimary,
  },
  extraWrap: {
    alignItems: 'center',
  },
  moreToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  moreToggleText: {
    fontSize: 12,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  moreRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 6,
    marginTop: 4,
  },
  moreChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  moreChipText: {
    fontSize: 11.5,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
    marginTop: 4,
    paddingTop: 10,
  },
  footerBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
  },
  footerDivider: {
    width: 1,
    height: 16,
    backgroundColor: COLORS.border,
  },
  footerMutedText: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  footerLaterText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontWeight: '700',
  },
});
