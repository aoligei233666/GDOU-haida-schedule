import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { Linking, Platform } from 'react-native';
import { invokeNativeBridge } from './gdouNativeBridge';
import { SignedOtaManifestFields, verifyOtaManifestSignature } from './otaCrypto';
import {
  buildAltStoreDirectInstallUrl,
  buildCampusMirrorDownloadUrls,
  buildLiveContainerDirectInstallUrl,
  buildSideStoreDirectInstallUrl,
  buildTrollStoreDirectInstallUrl,
  compareSemver,
  isTrustedGithubReleaseUrl,
  normalizeVersionTag,
} from './updateService';

/**
 * Bump ONLY when native Swift / Kotlin / Pod / Gradle dependencies break JS ABI compatibility.
 * v4: adds local Expo Native Module (`GdouNativeCore`), `gdouschedule://` deep links,
 *     Android 4x4 Weekly Widget + background refresher, iOS AppIntents + BGAppRefreshTask,
 *     and Ed25519-signed OTA manifest verification.
 */
export const NATIVE_OTA_RUNTIME_VERSION = 4;

const OTA_DIR_NAME = 'gdou-ota';
const ACTIVE_STATE_FILE = 'active-ota.json';
const INTERNAL_RELOAD_ENDPOINT = 'https://gdou-ota-internal.local/reload';
const INTERNAL_STATUS_ENDPOINT = 'https://gdou-ota-internal.local/status';
const INTERNAL_OPEN_STORE_ENDPOINT = 'https://gdou-ota-internal.local/open-store';

export type OtaApplyStage = 'checking' | 'downloading' | 'verifying' | 'applying' | 'reloading';

export interface NativeOtaStatus {
  otaSupported: boolean;
  nativeVersion?: string;
  nativeBuild?: string;
  activeOtaVersion?: string;
}

export interface InstalledIosSigner {
  id: 'sidestore' | 'trollstore' | 'altstore' | 'feather' | 'livecontainer';
  label: string;
  scheme: string;
  buildInstallUrl?: (ipaUrl: string) => string;
}

export interface ActiveOtaState {
  otaVersion: string;
  baseNativeVersion: string;
  baseNativeBuild: string;
  bundleFileName: string;
  sha256: string;
  installedAtIso: string;
  bootAttempts: number;
  confirmed: boolean;
}

export interface RemoteOtaManifest extends SignedOtaManifestFields {
  highlights?: string[];
  publishedAt?: string;
}

export interface TransferProgressInfo {
  bytesWritten: number;
  totalBytes: number;
  fraction: number; // 0..1
}

function getOtaDirectory(): Directory {
  return new Directory(Paths.document, OTA_DIR_NAME);
}

function getActiveStateFile(): File {
  return new File(getOtaDirectory(), ACTIVE_STATE_FILE);
}

function getTargetBundleFileName(platformOs: string): string {
  return platformOs === 'ios' ? 'main.jsbundle' : 'index.android.bundle';
}

/**
 * Read active OTA state if currently installed on disk.
 */
export function readActiveOtaState(): ActiveOtaState | null {
  try {
    const stateFile = getActiveStateFile();
    if (!stateFile.exists) return null;
    const raw = stateFile.textSync();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveOtaState>;
    if (!parsed || typeof parsed.otaVersion !== 'string' || !parsed.bundleFileName) {
      return null;
    }
    return {
      otaVersion: parsed.otaVersion,
      baseNativeVersion: String(parsed.baseNativeVersion ?? ''),
      baseNativeBuild: String(parsed.baseNativeBuild ?? ''),
      bundleFileName: parsed.bundleFileName,
      sha256: String(parsed.sha256 ?? ''),
      installedAtIso: String(parsed.installedAtIso ?? ''),
      bootAttempts: Number(parsed.bootAttempts ?? 0),
      confirmed: Boolean(parsed.confirmed),
    };
  } catch {
    return null;
  }
}

/**
 * Called once `MainApp` mounts cleanly so native 2-strike crash rollback guard knows
 * the active OTA JS bundle booted without error.
 */
export function confirmActiveOtaBootIfNeeded(): void {
  try {
    const current = readActiveOtaState();
    if (!current || current.confirmed) return;
    const next: ActiveOtaState = {
      ...current,
      bootAttempts: 0,
      confirmed: true,
    };
    const stateFile = getActiveStateFile();
    stateFile.writeSync(JSON.stringify(next, null, 2));
  } catch {
    // Non-fatal on Expo Go / Web
  }
}

/**
 * Compute the effective running app version (preferring active OTA version when higher
 * than the embedded native binary version) so auto-update checks never loop after OTA.
 */
export function getEffectiveRunningVersion(
  nativeVersion: string,
  activeOtaOverride?: ActiveOtaState | null
): string {
  const base = normalizeVersionTag(nativeVersion);
  const ota = activeOtaOverride !== undefined ? activeOtaOverride : readActiveOtaState();
  if (ota?.otaVersion) {
    const otaVer = normalizeVersionTag(ota.otaVersion);
    if (compareSemver(otaVer, base) > 0) {
      return otaVer;
    }
  }
  return base;
}

/**
 * Probe the native iOS/Android OTA bridge to confirm in-app reload support.
 */
export async function getNativeOtaStatus(): Promise<NativeOtaStatus> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { otaSupported: false };
  }
  const data = await invokeNativeBridge({
    action: 'ota/status',
    legacyUrl: INTERNAL_STATUS_ENDPOINT,
    legacyMethod: 'GET',
    timeoutMs: 5_000,
  });
  return {
    otaSupported: Boolean(data.ok && data.otaSupported !== false),
    nativeVersion: typeof data.nativeVersion === 'string' ? data.nativeVersion : undefined,
    nativeBuild: typeof data.nativeBuild === 'string' ? data.nativeBuild : undefined,
    activeOtaVersion: typeof data.activeOtaVersion === 'string' ? data.activeOtaVersion : undefined,
  };
}

/**
 * Present native iOS App Store in-app sheet (`SKStoreProductViewController`) without leaving the app.
 * Falls back to official HTTPS App Store link if StoreKit sheet fails or times out.
 */
export async function openIosInAppStoreSheet(appStoreId: string): Promise<boolean> {
  const cleaned = String(appStoreId ?? '').replace(/[^\d]/g, '');
  if (!cleaned) return false;
  if (Platform.OS === 'ios') {
    const data = await invokeNativeBridge({
      action: 'ota/open-store',
      payload: { appId: cleaned },
      legacyUrl: `${INTERNAL_OPEN_STORE_ENDPOINT}?appId=${encodeURIComponent(cleaned)}`,
      legacyMethod: 'GET',
      timeoutMs: 10_000,
    });
    if (data.ok) return true;
  }
  try {
    await Linking.openURL(`https://apps.apple.com/cn/app/id${cleaned}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which iOS sideload/signing managers are actually installed on the device
 * so the in-app update sheet can present a single clean 1-tap handoff button.
 */
export async function detectInstalledIosSigners(): Promise<InstalledIosSigner[]> {
  if (Platform.OS !== 'ios') return [];
  const candidates: InstalledIosSigner[] = [
    {
      id: 'trollstore',
      label: '巨魔 TrollStore',
      scheme: 'apple-magnifier://',
      buildInstallUrl: buildTrollStoreDirectInstallUrl,
    },
    {
      id: 'sidestore',
      label: 'SideStore',
      scheme: 'sidestore://',
      buildInstallUrl: buildSideStoreDirectInstallUrl,
    },
    {
      id: 'altstore',
      label: 'AltStore',
      scheme: 'altstore://',
      buildInstallUrl: buildAltStoreDirectInstallUrl,
    },
    {
      id: 'feather',
      label: 'Feather',
      scheme: 'feather://',
    },
    {
      id: 'livecontainer',
      label: 'LiveContainer',
      scheme: 'livecontainer://',
      buildInstallUrl: buildLiveContainerDirectInstallUrl,
    },
  ];
  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        const supported = await Linking.canOpenURL(c.scheme);
        return supported ? c : null;
      } catch {
        return null;
      }
    })
  );
  return results.filter((item): item is InstalledIosSigner => item !== null);
}

/**
 * Trigger instant native root-view / process reload into the newly activated bundle
 * via our local loopback URLProtocol / OkHttp interceptor (`gdou-ota-internal.local`).
 */
export async function triggerNativeOtaReload(): Promise<boolean> {
  const res = await invokeNativeBridge({
    action: 'ota/reload',
    legacyUrl: INTERNAL_RELOAD_ENDPOINT,
    legacyMethod: 'GET',
    timeoutMs: 5_000,
  });
  return Boolean(res.ok);
}

/**
 * Remove any downloaded OTA bundle and revert back to the built-in IPA/APK bundle.
 */
export async function clearOtaAndRollbackToEmbedded(): Promise<void> {
  const dir = getOtaDirectory();
  if (dir.exists) {
    dir.delete();
  }
  await triggerNativeOtaReload();
}

export async function fetchOptionalOtaManifest(
  manifestUrl: string | null | undefined,
  signal?: AbortSignal
): Promise<{ manifest: RemoteOtaManifest; fromMirror: boolean; signatureValid: boolean } | null> {
  if (!manifestUrl || !isTrustedGithubReleaseUrl(manifestUrl)) {
    return null;
  }
  const candidates: Array<{ url: string; fromMirror: boolean }> = [
    { url: manifestUrl, fromMirror: false },
    ...buildCampusMirrorDownloadUrls(manifestUrl).map((url) => ({ url, fromMirror: true })),
  ];

  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate.url, {
        method: 'GET',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!resp.ok) continue;
      const parsed = (await resp.json()) as RemoteOtaManifest;
      const sigCheck = verifyOtaManifestSignature(parsed);
      // Hard reject any tampered signature on both direct GitHub and mirrors
      if (sigCheck.present && !sigCheck.valid) {
        throw new Error(sigCheck.reason || 'OTA 清单 Ed25519 签名校验失败');
      }
      // Mirrors are ONLY trusted when the manifest carries a valid Ed25519 signature!
      if (candidate.fromMirror && !sigCheck.valid) {
        continue;
      }
      return { manifest: parsed, fromMirror: candidate.fromMirror, signatureValid: sigCheck.valid };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Ed25519')) {
        throw err;
      }
      if (signal?.aborted) throw err;
    }
  }
  return null;
}

async function downloadFileWithOptionalMirrors(options: {
  primaryUrl: string;
  allowMirrors: boolean;
  targetFile: File;
  expectedSizeBytes?: number | null;
  onProgress?: (info: TransferProgressInfo) => void;
  signal?: AbortSignal;
}): Promise<File> {
  const { primaryUrl, allowMirrors, targetFile, expectedSizeBytes, onProgress, signal } = options;
  const urls = allowMirrors
    ? [primaryUrl, ...buildCampusMirrorDownloadUrls(primaryUrl)]
    : [primaryUrl];
  let lastError: unknown = null;

  for (const url of urls) {
    if (signal?.aborted) {
      throw new Error('下载已取消');
    }
    if (targetFile.exists) {
      targetFile.delete();
    }
    try {
      const task = File.createDownloadTask(url, targetFile, {
        sessionType: 'foreground',
        signal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          const denom =
            totalBytes > 0
              ? totalBytes
              : expectedSizeBytes && expectedSizeBytes > 0
                ? expectedSizeBytes
                : 0;
          const fraction = denom > 0 ? Math.min(1, Math.max(0, bytesWritten / denom)) : 0;
          onProgress?.({ bytesWritten, totalBytes: denom, fraction });
        },
      });
      const downloaded = await task.downloadAsync();
      if (downloaded && downloaded.exists && downloaded.size > 0) {
        return downloaded;
      }
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('更新包下载中断或未生成文件');
}

/**
 * Download the platform OTA JS/Hermes bundle inside the app, enforce fail-closed SHA-256
 * and Ed25519 signature verification, activate in `Paths.document/gdou-ota/`, and hot-reload!
 * Mirror acceleration is automatically enabled ONLY when Ed25519 signature verification passes.
 */
export async function downloadAndApplyGithubOtaUpdate(options: {
  targetVersion: string;
  otaDownloadUrl: string;
  otaManifestUrl?: string | null;
  expectedSizeBytes?: number | null;
  currentRunningVersion: string;
  fallbackNativeBuild: string;
  onProgress?: (info: TransferProgressInfo) => void;
  onStage?: (stage: OtaApplyStage) => void;
  signal?: AbortSignal;
}): Promise<{ sha256: string; reloadedAutomatically: boolean; signatureVerified: boolean }> {
  const {
    targetVersion,
    otaDownloadUrl,
    otaManifestUrl,
    expectedSizeBytes,
    currentRunningVersion,
    fallbackNativeBuild,
    onProgress,
    onStage,
    signal,
  } = options;

  if (!isTrustedGithubReleaseUrl(otaDownloadUrl)) {
    throw new Error('安全校验拦截：热更新下载地址不属于受信任的 GitHub 官方 HTTPS 域名');
  }

  const normalizedTarget = normalizeVersionTag(targetVersion);
  if (compareSemver(normalizedTarget, currentRunningVersion) <= 0) {
    throw new Error(`当前已是 v${normalizeVersionTag(currentRunningVersion)}，无需重复应用该更新包`);
  }

  // 1. Fail-closed manifest & Ed25519 cryptographic verification (NEVER skip SHA-256!)
  onStage?.('checking');
  const fetched = await fetchOptionalOtaManifest(otaManifestUrl, signal);
  if (!fetched) {
    throw new Error(
      '安全校验拦截：未能拉取该版本的 OTA 校验清单（ota-manifest.json），已拒绝无校验热更新；请检查网络或改用完整安装包升级'
    );
  }
  const { manifest, signatureValid } = fetched;
  if (
    manifest.minNativeRuntimeVersion &&
    manifest.minNativeRuntimeVersion > NATIVE_OTA_RUNTIME_VERSION
  ) {
    throw new Error(
      `v${normalizedTarget} 升级了底层原生能力（需 Runtime >= ${manifest.minNativeRuntimeVersion}），无法纯热更，请点击「安装新底座版本」完成升级`
    );
  }

  const expectedSha256 = (
    Platform.OS === 'ios'
      ? manifest.iosSha256 || manifest.ios?.sha256
      : manifest.androidSha256 || manifest.android?.sha256
  )
    ?.trim()
    .toLowerCase();

  if (!expectedSha256 || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('安全校验拦截：OTA 清单缺少有效的 64 位 SHA-256 哈希，已拒绝热更新');
  }

  const otaDir = getOtaDirectory();
  if (!otaDir.exists) {
    otaDir.create({ intermediates: true, idempotent: true });
  }

  const stagingFile = new File(otaDir, 'staging-ota.tmp');
  onStage?.('downloading');
  const downloaded = await downloadFileWithOptionalMirrors({
    primaryUrl: otaDownloadUrl,
    allowMirrors: signatureValid,
    targetFile: stagingFile,
    expectedSizeBytes,
    onProgress,
    signal,
  });

  if (downloaded.size < 32 * 1024) {
    downloaded.delete();
    throw new Error(
      `下载到的更新包体积异常（${downloaded.size} B），该版本可能尚未上传 OTA 包，请改用「安装新底座版本」`
    );
  }

  onStage?.('verifying');
  const computedSha256 = (await downloaded.digest('SHA-256')).toLowerCase();
  if (computedSha256 !== expectedSha256) {
    downloaded.delete();
    throw new Error('SHA-256 完整性校验未通过，已自动丢弃损坏或被篡改的文件，请重试');
  }

  onStage?.('applying');
  const existingState = readActiveOtaState();
  const nativeStatus = await getNativeOtaStatus();
  const baseNativeVersion =
    normalizeVersionTag(nativeStatus.nativeVersion || '') ||
    existingState?.baseNativeVersion ||
    normalizeVersionTag(currentRunningVersion);
  const baseNativeBuild =
    String(nativeStatus.nativeBuild || '').trim() ||
    existingState?.baseNativeBuild ||
    fallbackNativeBuild;

  const finalFileName = getTargetBundleFileName(Platform.OS);
  const activeBundleFile = new File(otaDir, finalFileName);
  downloaded.moveSync(activeBundleFile, { overwrite: true });

  const nextState: ActiveOtaState = {
    otaVersion: normalizedTarget,
    baseNativeVersion,
    baseNativeBuild,
    bundleFileName: finalFileName,
    sha256: computedSha256,
    installedAtIso: new Date().toISOString(),
    bootAttempts: 0,
    confirmed: false,
  };

  const stateFile = getActiveStateFile();
  stateFile.writeSync(JSON.stringify(nextState, null, 2));

  onProgress?.({
    bytesWritten: activeBundleFile.size,
    totalBytes: activeBundleFile.size,
    fraction: 1,
  });

  onStage?.('reloading');
  const reloadedAutomatically = await triggerNativeOtaReload();
  return { sha256: computedSha256, reloadedAutomatically, signatureVerified: signatureValid };
}

/**
 * Download the full platform binary installer (`.ipa` on iOS, `.apk` on Android) inside the app
 * with optional Ed25519-verified campus mirror fallback and SHA-256 verification.
 */
export async function downloadAndOpenReleaseInstaller(options: {
  downloadUrl: string;
  assetName: string;
  otaManifestUrl?: string | null;
  expectedSizeBytes?: number | null;
  onProgress?: (info: TransferProgressInfo) => void;
  signal?: AbortSignal;
}): Promise<{ fileUri: string; handedOff: boolean }> {
  const { downloadUrl, assetName, otaManifestUrl, expectedSizeBytes, onProgress, signal } = options;

  if (!isTrustedGithubReleaseUrl(downloadUrl)) {
    throw new Error('安全校验拦截：安装包下载地址不属于受信任的 GitHub 官方 HTTPS 域名');
  }

  let expectedInstallerSha256: string | undefined;
  let allowMirrors = false;
  try {
    const fetched = await fetchOptionalOtaManifest(otaManifestUrl, signal);
    if (fetched?.signatureValid) {
      const candidateSha =
        Platform.OS === 'android'
          ? fetched.manifest.androidApkSha256
          : fetched.manifest.iosIpaSha256;
      if (candidateSha && /^[0-9a-f]{64}$/i.test(candidateSha.trim())) {
        expectedInstallerSha256 = candidateSha.trim().toLowerCase();
        allowMirrors = true;
      }
    }
  } catch {
    // Direct GitHub HTTPS fallback remains available
  }

  const safeName = assetName.replace(/[^A-Za-z0-9._-]/g, '_');
  const pkgDir = new Directory(Paths.cache, 'gdou-release-pkg');
  if (!pkgDir.exists) {
    pkgDir.create({ intermediates: true, idempotent: true });
  }

  const targetFile = new File(pkgDir, safeName);
  const downloaded = await downloadFileWithOptionalMirrors({
    primaryUrl: downloadUrl,
    allowMirrors,
    targetFile,
    expectedSizeBytes,
    onProgress,
    signal,
  });
  if (!downloaded || !downloaded.exists || downloaded.size < 100 * 1024) {
    if (downloaded?.exists) downloaded.delete();
    throw new Error('安装包下载未完成或文件大小异常，请检查网络后重试');
  }

  if (expectedInstallerSha256) {
    const actualSha = (await downloaded.digest('SHA-256')).toLowerCase();
    if (actualSha !== expectedInstallerSha256) {
      downloaded.delete();
      throw new Error('安装包 SHA-256 完整性校验失败，已自动清除损坏文件，请重试');
    }
  }

  onProgress?.({
    bytesWritten: downloaded.size,
    totalBytes: downloaded.size,
    fraction: 1,
  });

  if (Platform.OS === 'android') {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: downloaded.contentUri,
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
        type: 'application/vnd.android.package-archive',
      });
      return { fileUri: downloaded.uri, handedOff: true };
    } catch {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloaded.uri, {
          mimeType: 'application/vnd.android.package-archive',
          dialogTitle: `安装 ${safeName}`,
        });
        return { fileUri: downloaded.uri, handedOff: true };
      }
      return { fileUri: downloaded.uri, handedOff: false };
    }
  }

  // On iOS: immediately open the native iOS Share Sheet so user can one-tap import into
  // SideStore / AltStore / Feather / ESign / TrollStore / LiveContainer or save to Files
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(downloaded.uri, {
      mimeType: 'application/octet-stream',
      UTI: 'com.apple.itunes.ipa',
      dialogTitle: `导入或保存 ${safeName}`,
    });
    return { fileUri: downloaded.uri, handedOff: true };
  }

  return { fileUri: downloaded.uri, handedOff: false };
}
