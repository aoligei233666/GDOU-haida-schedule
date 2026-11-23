export const GITHUB_RELEASES_PAGE_URL =
  'https://github.com/aoligei233666/GDOU-haida-schedule/releases/';
export const GITHUB_LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/aoligei233666/GDOU-haida-schedule/releases/latest';
export const GITHUB_RELEASES_LIST_API_URL =
  'https://api.github.com/repos/aoligei233666/GDOU-haida-schedule/releases?per_page=5';

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
  publishedAt: string | null;
  releaseUrl: string;
  downloadUrl: string;
  assetName: string | null;
  assetSizeBytes: number | null;
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
 * Pick the best platform-specific installer asset from a GitHub Release.
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
    // Fallback to releases list in case only prereleases exist or no release has been published yet
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
        publishedAt: null,
        releaseUrl: GITHUB_RELEASES_PAGE_URL,
        downloadUrl: GITHUB_RELEASES_PAGE_URL,
        assetName: null,
        assetSizeBytes: null,
        statusNote: 'GitHub Releases 暂无已发布版本，可直接前往 Releases 页面查看',
      };
    }
  } else if (latestResp.status === 403 || latestResp.status === 429) {
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
  const downloadUrl = asset ? asset.browser_download_url : releaseUrl;

  return {
    currentVersion: normalizedCurrent,
    latestVersion,
    hasUpdate,
    releaseTitle: (release.name || release.tag_name || `v${latestVersion}`).trim(),
    releaseNotes: String(release.body ?? '').trim(),
    publishedAt: release.published_at ?? null,
    releaseUrl,
    downloadUrl,
    assetName: asset?.name ?? null,
    assetSizeBytes: typeof asset?.size === 'number' ? asset.size : null,
  };
}
