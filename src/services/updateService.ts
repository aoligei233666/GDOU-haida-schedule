export const GITHUB_RELEASES_PAGE_URL =
  'https://github.com/aoligei233666/GDOU-haida-schedule/releases/';
export const GITHUB_LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/aoligei233666/GDOU-haida-schedule/releases/latest';
export const GITHUB_RELEASES_LIST_API_URL =
  'https://api.github.com/repos/aoligei233666/GDOU-haida-schedule/releases?per_page=5';
export const IOS_ALTSTORE_SOURCE_URL =
  'https://raw.githubusercontent.com/aoligei233666/GDOU-haida-schedule/main/altstore-source.json';
export const FEATHER_ADD_SOURCE_URL = `feather://source/${IOS_ALTSTORE_SOURCE_URL}`;
export const SIDESTORE_ADD_SOURCE_URL = `sidestore://source?url=${encodeURIComponent(
  IOS_ALTSTORE_SOURCE_URL
)}`;

export function buildSideStoreDirectInstallUrl(ipaUrl: string): string {
  return `sidestore://install?url=${encodeURIComponent(ipaUrl)}`;
}

export function buildAltStoreDirectInstallUrl(ipaUrl: string): string {
  return `altstore://install?url=${encodeURIComponent(ipaUrl)}`;
}

export function buildTrollStoreDirectInstallUrl(ipaUrl: string): string {
  return `apple-magnifier://install?url=${encodeURIComponent(ipaUrl)}`;
}

export function buildLiveContainerDirectInstallUrl(ipaUrl: string): string {
  return `livecontainer://install?url=${encodeURIComponent(ipaUrl)}`;
}

/**
 * Concise summary of current v1.5.1 improvements & bug fixes shown directly in Settings -> Update Card.
 */
export const CURRENT_VERSION_HIGHLIGHTS: string[] = [
  '修复 iOS 桌面小组件显示空白：重构 iOS 17/18/26 containerBackground 与色调/玻璃适配、嵌入 App Group 权限并支持动态容器自动发现与大号桌面挂件',
  '升级软件内更新体验：启动自动检测并弹出应用内更新卡片，支持实时进度条极速热更新与原地无感重启，后续常规更新无需跳出 App',
  '彻底简化教务登录流程：校外微门户自动复用 CAS 统一认证票据免密直通教务，极速直连与官网网页均只需输一次密码，并支持 iOS 短信验证码一键填充',
  '保留完整 9 大校园工具：查询空教室、全校蹭课搜索、培养方案学分核对、成绩分项明细、课表变动 Diff、海大校历调休与高清课表图导出',
];

export function getPlatformVersionHighlights(platformOs: string): string[] {
  if (platformOs === 'android') {
    return [
      '简化教务登录流程：校外微门户自动复用 CAS 统一认证票据免密直通教务，极速直连与官网网页均只需输一次密码',
      '升级软件内更新体验：启动自动静默检测并弹出软件内更新卡片，支持进度条极速热更新或直接下载 APK 调起系统安装',
      '新增短信验证码 60 秒重发倒计时、键盘一键跳转提交与一键短信免密/企微扫码登录入口',
      '完整保留查询空教室、全校蹭课搜索、培养方案学分核对、成绩分项明细、课表换肤与桌面小组件/通知栏常驻今日课表',
    ];
  }
  if (platformOs === 'ios') {
    return [
      '根治 iOS 桌面挂件显示一片空白：重构 WidgetKit containerBackground 适配 iOS 17/18/26 浅色/深色/色调/玻璃模式，内置 App Group 权限并支持重签后动态自动发现（新增大号组件）',
      '升级类邮政 EMS 体验的软件内更新：启动自动检测并居中弹出更新卡片，支持软件内进度条热更新原地无感重启（免电脑免重签）、应用内商店卡片与自动识别已装签名器一键升级',
      '彻底简化教务登录流程：校外自动复用 CAS 票据直通教务，告别每次输两次密码；支持 iOS 键盘短信验证码一键自动填充与一键短信免密/企微扫码登录',
      '完整保留 iOS 26 AlarmKit 系统闹钟、灵动岛实时课表、查询空教室、蹭课搜索与高清课表图导出',
    ];
  }
  return CURRENT_VERSION_HIGHLIGHTS;
}

const UPDATE_CHECK_TIMEOUT_MS = 12_000;

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GitHubReleasePayload {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseTitle: string;
  releaseNotes: string;
  conciseHighlights: string[];
  publishedAt: string | null;
  releaseUrl: string;
  downloadUrl: string;
  assetName: string | null;
  assetSizeBytes: number | null;
  otaDownloadUrl: string | null;
  otaAssetName: string | null;
  otaSizeBytes: number | null;
  otaManifestUrl: string | null;
  statusNote?: string;
}

/**
 * Strictly validate that any external release/download link belongs to official GitHub HTTPS origins.
 */
export function isTrustedGithubReleaseUrl(rawUrl?: string | null): boolean {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host === 'objects.githubusercontent.com' ||
      host === 'release-assets.githubusercontent.com'
    );
  } catch {
    return false;
  }
}

export function normalizeVersionTag(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[vV]+/, '')
    .trim();
}

/**
 * Semver comparator returning 1 if a > b, -1 if a < b, 0 if equal.
 * Supports leading `v`, arbitrary patch segments, and prerelease tags (e.g. `1.4.0-beta.1 < 1.4.0`).
 */
export function compareSemver(aRaw: string, bRaw: string): number {
  const parse = (input: string) => {
    const cleaned = normalizeVersionTag(input);
    const [core, pre = ''] = cleaned.split('-', 2);
    const parts = core
      .split('.')
      .map((n) => parseInt(n.replace(/[^\d]/g, ''), 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
    while (parts.length < 3) parts.push(0);
    return { parts, pre };
  };

  const a = parse(aRaw);
  const b = parse(bRaw);
  const len = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i++) {
    const av = a.parts[i] ?? 0;
    const bv = b.parts[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }

  if (!a.pre && !b.pre) return 0;
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  return a.pre.localeCompare(b.pre) > 0 ? 1 : a.pre.localeCompare(b.pre) < 0 ? -1 : 0;
}

/**
 * Extract up to `maxItems` clean, human-readable bullet highlights from raw GitHub Release Markdown,
 * stopping before installation guides or SHA-256 checksum tables.
 */
export function summarizeReleaseHighlights(rawBody: string, maxItems = 6): string[] {
  const text = String(rawBody ?? '').trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const items: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Stop when reaching installation tutorials or SHA-256 verification tables
    if (
      /^#{1,4}\s*.*(安装指南|校验|SHA-256|下载说明|Sideloadly)/i.test(trimmed) ||
      trimmed.startsWith('| 文件')
    ) {
      break;
    }

    // Skip markdown horizontal rules, quotes, code fences, or top titles
    if (
      /^---+$/.test(trimmed) ||
      trimmed.startsWith('```') ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('|') ||
      /^#{1,2}\s/.test(trimmed)
    ) {
      continue;
    }

    const bulletMatch = trimmed.match(/^(?:[-*•]|\d+\.)\s+(.+)$/);
    const heading3Match = trimmed.match(/^###\s+(?:\d+\.\s*)?(.+)$/);
    const candidate = bulletMatch ? bulletMatch[1] : heading3Match ? heading3Match[1] : '';
    if (!candidate) continue;

    const cleaned = candidate
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();

    if (cleaned.length >= 4 && !items.includes(cleaned)) {
      items.push(cleaned.length > 96 ? `${cleaned.slice(0, 95)}…` : cleaned);
      if (items.length >= maxItems) break;
    }
  }

  if (items.length === 0) {
    const fallback = text
      .replace(/[#>*`]/g, '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4)
      .slice(0, 3);
    return fallback;
  }

  return items;
}

/**
 * Pick the best platform-specific binary installer asset from a GitHub Release.
 * - Android: prefers signed `.apk` over `-unsigned.apk`.
 * - iOS: prefers `.ipa`.
 */
export function selectPlatformReleaseAsset(
  assets: GitHubReleaseAsset[] | undefined,
  platformOs: string
): GitHubReleaseAsset | null {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const trusted = assets.filter(
    (a) => a && typeof a.name === 'string' && isTrustedGithubReleaseUrl(a.browser_download_url)
  );
  if (trusted.length === 0) return null;

  if (platformOs === 'android') {
    const apks = trusted.filter((a) => a.name.toLowerCase().endsWith('.apk'));
    if (apks.length === 0) return null;
    const signed = apks.find((a) => !a.name.toLowerCase().includes('unsigned'));
    return signed ?? apks[0];
  }

  if (platformOs === 'ios') {
    const ipas = trusted.filter((a) => a.name.toLowerCase().endsWith('.ipa'));
    return ipas[0] ?? null;
  }

  return null;
}

/**
 * Pick the platform-specific OTA JS bundle asset (`*-ios-ota.jsbundle` / `*-android-ota.jsbundle`)
 * and optional `*-ota-manifest.json` from a GitHub Release.
 */
export function selectPlatformOtaAssets(
  assets: GitHubReleaseAsset[] | undefined,
  platformOs: string
): {
  bundleAsset: GitHubReleaseAsset | null;
  manifestAsset: GitHubReleaseAsset | null;
} {
  if (!Array.isArray(assets) || assets.length === 0) {
    return { bundleAsset: null, manifestAsset: null };
  }
  const trusted = assets.filter(
    (a) => a && typeof a.name === 'string' && isTrustedGithubReleaseUrl(a.browser_download_url)
  );
  const manifestAsset =
    trusted.find((a) => a.name.toLowerCase().endsWith('ota-manifest.json')) ?? null;

  if (platformOs === 'ios') {
    const bundleAsset =
      trusted.find((a) => a.name.toLowerCase().endsWith('-ios-ota.jsbundle')) ?? null;
    return { bundleAsset, manifestAsset };
  }
  if (platformOs === 'android') {
    const bundleAsset =
      trusted.find((a) => a.name.toLowerCase().endsWith('-android-ota.jsbundle')) ?? null;
    return { bundleAsset, manifestAsset };
  }
  return { bundleAsset: null, manifestAsset: null };
}

export function formatBytesCompact(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchGithubJson(
  url: string,
  currentVersion: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `haida-schedule-app/${currentVersion}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      throw new Error('连接 GitHub 超时，可点击下方按钮直接打开 Releases 页面查看更新');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Fallback update check via `raw.githubusercontent.com/.../altstore-source.json`
 * when campus NAT IP hits GitHub API's 60 req/hr unauthenticated rate limit (HTTP 403/429).
 */
async function fallbackCheckViaAltStoreSource(
  currentVersion: string,
  platformOs: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<UpdateCheckResult | null> {
  try {
    const resp = await fetchGithubJson(IOS_ALTSTORE_SOURCE_URL, currentVersion, options);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      apps?: Array<{
        version?: string;
        versionDate?: string;
        versionDescription?: string;
        downloadURL?: string;
        size?: number;
      }>;
    };
    const app = data.apps?.[0];
    if (!app || !app.version) return null;

    const latestVersion = normalizeVersionTag(app.version);
    const normalizedCurrent = normalizeVersionTag(currentVersion);
    const hasUpdate = compareSemver(latestVersion, normalizedCurrent) > 0;
    const tag = `v${latestVersion}`;
    const baseReleaseDownload = `https://github.com/aoligei233666/GDOU-haida-schedule/releases/download/${tag}`;
    const releaseUrl = `https://github.com/aoligei233666/GDOU-haida-schedule/releases/tag/${tag}`;

    const ipaName = `haida-schedule-${tag}-ios-unsigned.ipa`;
    const apkName = `haida-schedule-${tag}-android.apk`;
    const otaName =
      platformOs === 'ios'
        ? `haida-schedule-${tag}-ios-ota.jsbundle`
        : platformOs === 'android'
          ? `haida-schedule-${tag}-android-ota.jsbundle`
          : null;

    const downloadUrl =
      platformOs === 'ios' && isTrustedGithubReleaseUrl(app.downloadURL)
        ? String(app.downloadURL)
        : platformOs === 'android'
          ? `${baseReleaseDownload}/${apkName}`
          : `${baseReleaseDownload}/${ipaName}`;

    const notes = String(app.versionDescription ?? '').trim();

    return {
      currentVersion: normalizedCurrent,
      latestVersion,
      hasUpdate,
      releaseTitle: `海大课表 ${tag}`,
      releaseNotes: notes,
      conciseHighlights: summarizeReleaseHighlights(notes),
      publishedAt: app.versionDate ?? null,
      releaseUrl,
      downloadUrl,
      assetName: platformOs === 'ios' ? ipaName : platformOs === 'android' ? apkName : null,
      assetSizeBytes: platformOs === 'ios' && typeof app.size === 'number' ? app.size : null,
      otaDownloadUrl: otaName ? `${baseReleaseDownload}/${otaName}` : null,
      otaAssetName: otaName,
      otaSizeBytes: null,
      otaManifestUrl: `${baseReleaseDownload}/haida-schedule-${tag}-ota-manifest.json`,
      statusNote: '已通过 GitHub 镜像源通道完成版本检测',
    };
  } catch {
    return null;
  }
}

/**
 * Query GitHub Releases for `aoligei233666/GDOU-haida-schedule` and compare with `currentVersion`.
 * Never sends cookies or user credentials (`credentials: 'omit'`).
 */
export async function checkForAppUpdate(
  currentVersion: string,
  platformOs: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<UpdateCheckResult> {
  let release: GitHubReleasePayload | null = null;

  const latestResp = await fetchGithubJson(GITHUB_LATEST_RELEASE_API_URL, currentVersion, options);
  if (latestResp.ok) {
    release = (await latestResp.json()) as GitHubReleasePayload;
  } else if (latestResp.status === 404) {
    const listResp = await fetchGithubJson(GITHUB_RELEASES_LIST_API_URL, currentVersion, options);
    if (listResp.ok) {
      const list = (await listResp.json()) as GitHubReleasePayload[];
      const firstValid = Array.isArray(list) ? list.find((r) => r && !r.draft) : undefined;
      if (firstValid) {
        release = firstValid;
      }
    }
    if (!release) {
      return {
        currentVersion: normalizeVersionTag(currentVersion),
        latestVersion: normalizeVersionTag(currentVersion),
        hasUpdate: false,
        releaseTitle: '暂未发布正式 Release',
        releaseNotes: '',
        conciseHighlights: [],
        publishedAt: null,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        downloadUrl: GITHUB_RELEASES_PAGE_URL,
        assetName: null,
        assetSizeBytes: null,
        otaDownloadUrl: null,
        otaAssetName: null,
        otaSizeBytes: null,
        otaManifestUrl: null,
        statusNote: 'GitHub Releases 暂无已发布版本，可直接前往 Releases 页面查看',
      };
    }
  } else if (latestResp.status === 403 || latestResp.status === 429) {
    const fallback = await fallbackCheckViaAltStoreSource(currentVersion, platformOs, options);
    if (fallback) {
      return fallback;
    }
    throw new Error('GitHub API 请求频率受限，请直接点击下方「前往 GitHub Releases 页面」下载更新');
  } else {
    throw new Error(`检查更新失败 (HTTP ${latestResp.status})，请稍后重试或直接打开 Releases 页面`);
  }

  const latestVersion = normalizeVersionTag(release.tag_name || release.name || currentVersion);
  const normalizedCurrent = normalizeVersionTag(currentVersion);
  const hasUpdate = compareSemver(latestVersion, normalizedCurrent) > 0;
  const releaseUrl = isTrustedGithubReleaseUrl(release.html_url)
    ? String(release.html_url)
    : GITHUB_RELEASES_PAGE_URL;
  const asset = selectPlatformReleaseAsset(release.assets, platformOs);
  const { bundleAsset, manifestAsset } = selectPlatformOtaAssets(release.assets, platformOs);
  const downloadUrl = asset ? asset.browser_download_url : releaseUrl;
  const rawNotes = String(release.body ?? '').trim();

  return {
    currentVersion: normalizedCurrent,
    latestVersion,
    hasUpdate,
    releaseTitle: (release.name || release.tag_name || `v${latestVersion}`).trim(),
    releaseNotes: rawNotes,
    conciseHighlights: summarizeReleaseHighlights(rawNotes),
    publishedAt: release.published_at ?? null,
    releaseUrl,
    downloadUrl,
    assetName: asset?.name ?? null,
    assetSizeBytes: typeof asset?.size === 'number' ? asset.size : null,
    otaDownloadUrl: bundleAsset ? bundleAsset.browser_download_url : null,
    otaAssetName: bundleAsset?.name ?? null,
    otaSizeBytes: typeof bundleAsset?.size === 'number' ? bundleAsset.size : null,
    otaManifestUrl: manifestAsset ? manifestAsset.browser_download_url : null,
  };
}
