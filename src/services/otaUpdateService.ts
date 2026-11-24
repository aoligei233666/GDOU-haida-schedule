import { Directory, File, Paths } from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { compareSemver, isTrustedGithubReleaseUrl, normalizeVersionTag } from './updateService';

/**
 * Bump ONLY when native Swift / Kotlin / Pod / Gradle dependencies break JS ABI compatibility.
 * Pure JS/TS/UI releases keep the same `NATIVE_OTA_RUNTIME_VERSION` so iOS & Android users
 * can hot-update directly from GitHub inside the app without re-signing or computer!
 */
export const NATIVE_OTA_RUNTIME_VERSION = 1;

const OTA_DIR_NAME = 'gdou-ota';
const ACTIVE_STATE_FILE = 'active-ota.json';
const INTERNAL_RELOAD_ENDPOINT = 'https://gdou-ota-internal.local/reload';

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

export interface RemoteOtaManifest {
  version: string;
  minNativeRuntimeVersion?: number;
  iosBundleName?: string;
  iosSha256?: string;
  iosSize?: number;
  androidBundleName?: string;
  androidSha256?: string;
  androidSize?: number;
  highlights?: string[];
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
 * Trigger instant native root-view / process reload into the newly activated bundle
 * via our local loopback URLProtocol / OkHttp interceptor (`gdou-ota-internal.local`).
 */
export async function triggerNativeOtaReload(): Promise<boolean> {
  try {
    const resp = await fetch(INTERNAL_RELOAD_ENDPOINT, {
      method: 'GET',
      credentials: 'omit',
    });
    return resp.ok;
  } catch {
    return false;
  }
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

async function fetchOptionalOtaManifest(
  manifestUrl: string | null | undefined,
  signal?: AbortSignal
): Promise<RemoteOtaManifest | null> {
  if (!manifestUrl || !isTrustedGithubReleaseUrl(manifestUrl)) {
    return null;
  }
  try {
    const resp = await fetch(manifestUrl, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!resp.ok) return null;
    return (await resp.json()) as RemoteOtaManifest;
  } catch {
    return null;
  }
}

/**
 * Download the platform OTA JS/Hermes bundle directly from GitHub Releases inside the app,
 * verify SHA-256 integrity, activate it in `Paths.document/gdou-ota/`, and hot-reload!
 * Especially valuable on iOS: updates the app in seconds WITHOUT computer, Sideloadly, or re-signing!
 */
export async function downloadAndApplyGithubOtaUpdate(options: {
  targetVersion: string;
  otaDownloadUrl: string;
  otaManifestUrl?: string | null;
  expectedSizeBytes?: number | null;
  currentRunningVersion: string;
  fallbackNativeBuild: string;
  onProgress?: (info: TransferProgressInfo) => void;
  signal?: AbortSignal;
}): Promise<{ sha256: string; reloadedAutomatically: boolean }> {
  const {
    targetVersion,
    otaDownloadUrl,
    otaManifestUrl,
    expectedSizeBytes,
    currentRunningVersion,
    fallbackNativeBuild,
    onProgress,
    signal,
  } = options;

  if (!isTrustedGithubReleaseUrl(otaDownloadUrl)) {
    throw new Error('安全校验拦截：热更新下载地址不属于受信任的 GitHub 官方 HTTPS 域名');
  }

  const normalizedTarget = normalizeVersionTag(targetVersion);
  if (compareSemver(normalizedTarget, currentRunningVersion) <= 0) {
    throw new Error(`当前已是 v${normalizeVersionTag(currentRunningVersion)}，无需重复应用该更新包`);
  }

  // 1. Check optional ota-manifest.json for native runtime compatibility & SHA-256 checksum
  const manifest = await fetchOptionalOtaManifest(otaManifestUrl, signal);
  if (
    manifest?.minNativeRuntimeVersion &&
    manifest.minNativeRuntimeVersion > NATIVE_OTA_RUNTIME_VERSION
  ) {
    throw new Error(
      `v${normalizedTarget} 升级了底层原生引擎（需 Runtime >= ${manifest.minNativeRuntimeVersion}），无法直接热更，请点击下方「软件内直接下载安装包」完成升级`
    );
  }

  const otaDir = getOtaDirectory();
  if (!otaDir.exists) {
    otaDir.create({ intermediates: true, idempotent: true });
  }

  const stagingFile = new File(otaDir, 'staging-ota.tmp');
  if (stagingFile.exists) {
    stagingFile.delete();
  }

  const task = File.createDownloadTask(otaDownloadUrl, stagingFile, {
    sessionType: 'foreground',
    signal,
    onProgress: ({ bytesWritten, totalBytes }) => {
      const denom = totalBytes > 0 ? totalBytes : expectedSizeBytes && expectedSizeBytes > 0 ? expectedSizeBytes : 0;
      const fraction = denom > 0 ? Math.min(1, Math.max(0, bytesWritten / denom)) : 0;
      onProgress?.({ bytesWritten, totalBytes: denom, fraction });
    },
  });

  const downloaded = await task.downloadAsync();
  if (!downloaded || !downloaded.exists) {
    throw new Error('GitHub 热更新包下载中断或未生成文件');
  }

  if (downloaded.size < 32 * 1024) {
    downloaded.delete();
    throw new Error(
      `下载到的更新包体积异常（${downloaded.size} B），该版本可能尚未上传 OTA 包，请改用下方「直接下载安装包」`
    );
  }

  const computedSha256 = (await downloaded.digest('SHA-256')).toLowerCase();
  const expectedSha256 = (
    Platform.OS === 'ios' ? manifest?.iosSha256 : manifest?.androidSha256
  )
    ?.trim()
    .toLowerCase();

  if (expectedSha256 && computedSha256 !== expectedSha256) {
    downloaded.delete();
    throw new Error('SHA-256 完整性校验未通过，已自动丢弃损坏文件，请重试');
  }

  // Preserve original native base version if updating on top of a previous OTA bundle
  const existingState = readActiveOtaState();
  const baseNativeVersion = existingState?.baseNativeVersion || normalizeVersionTag(currentRunningVersion);
  const baseNativeBuild = existingState?.baseNativeBuild || fallbackNativeBuild;

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

  const reloadedAutomatically = await triggerNativeOtaReload();
  return { sha256: computedSha256, reloadedAutomatically };
}

/**
 * Download the full platform binary installer (`.ipa` on iOS, `.apk` on Android)
 * directly inside the app from GitHub Releases with real-time progress, then:
 * - On Android: invoke native package installer (`ACTION_VIEW` + `contentUri`) directly!
 * - On iOS: present native Share / Open-In sheet with the downloaded `.ipa` file so the user
 *   can directly send it to SideStore / AltStore / Feather / ESign / TrollStore / Files App!
 */
export async function downloadAndOpenReleaseInstaller(options: {
  downloadUrl: string;
  assetName: string;
  expectedSizeBytes?: number | null;
  onProgress?: (info: TransferProgressInfo) => void;
  signal?: AbortSignal;
}): Promise<{ fileUri: string; handedOff: boolean }> {
  const { downloadUrl, assetName, expectedSizeBytes, onProgress, signal } = options;

  if (!isTrustedGithubReleaseUrl(downloadUrl)) {
    throw new Error('安全校验拦截：安装包下载地址不属于受信任的 GitHub 官方 HTTPS 域名');
  }

  const safeName = assetName.replace(/[^A-Za-z0-9._-]/g, '_');
  const pkgDir = new Directory(Paths.cache, 'gdou-release-pkg');
  if (!pkgDir.exists) {
    pkgDir.create({ intermediates: true, idempotent: true });
  }

  const targetFile = new File(pkgDir, safeName);
  if (targetFile.exists) {
    targetFile.delete();
  }

  const task = File.createDownloadTask(downloadUrl, targetFile, {
    sessionType: 'foreground',
    signal,
    onProgress: ({ bytesWritten, totalBytes }) => {
      const denom = totalBytes > 0 ? totalBytes : expectedSizeBytes && expectedSizeBytes > 0 ? expectedSizeBytes : 0;
      const fraction = denom > 0 ? Math.min(1, Math.max(0, bytesWritten / denom)) : 0;
      onProgress?.({ bytesWritten, totalBytes: denom, fraction });
    },
  });

  const downloaded = await task.downloadAsync();
  if (!downloaded || !downloaded.exists || downloaded.size < 100 * 1024) {
    if (downloaded?.exists) downloaded.delete();
    throw new Error('安装包下载未完成或文件大小异常，请检查网络后重试');
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
