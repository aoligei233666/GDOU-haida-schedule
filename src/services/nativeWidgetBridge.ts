import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { AppSettings, CourseItem, ExamItem } from '../types/models';
import { invokeNativeBridge } from './gdouNativeBridge';
import {
  buildNativeWidgetPayload,
  NativeWidgetCourseRow,
  NativeWidgetDaySnapshot,
  NativeWidgetPayload,
} from './widgetPayloadBuilder';

export { buildNativeWidgetPayload };
export type { NativeWidgetCourseRow, NativeWidgetDaySnapshot, NativeWidgetPayload };

const WIDGET_BRIDGE_BASE = 'https://gdou-widget-internal.local';

const PATH_TO_NATIVE_ACTION: Record<string, string> = {
  '/sync-widget': 'widget/sync',
  '/ongoing-notification': 'widget/ongoing',
  '/live-activity/upsert': 'widget/live-activity/upsert',
  '/live-activity/stop': 'widget/live-activity/stop',
  '/pick-background': 'widget/pick-background',
  '/save-image': 'widget/save-image',
};

async function callNativeWidgetBridge(
  path: string,
  body?: unknown
): Promise<{ ok: boolean; error?: string; uri?: string; active?: boolean; [k: string]: unknown }> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return { ok: false, error: '当前运行环境不支持原生小组件桥接' };
  }
  const action = PATH_TO_NATIVE_ACTION[path] || `widget${path}`;
  return invokeNativeBridge({
    action,
    payload: body ?? {},
    legacyUrl: `${WIDGET_BRIDGE_BASE}${path}`,
    legacyMethod: 'POST',
    timeoutMs: path === '/pick-background' ? 120_000 : 12_000,
  }) as Promise<{ ok: boolean; error?: string; uri?: string; active?: boolean; [k: string]: unknown }>;
}

/**
 * Push sanitized today's + 7-day rolling schedule snapshot to:
 * - Android Home Screen AppWidget (SharedPreferences + atomic file mirror + AppWidgetManager broadcast)
 * - Android Ongoing Status Bar Notification (if enabled)
 * - iOS WidgetKit Extension (App Group atomic file + UserDefaults + Shared Keychain fallback + WidgetCenter.reloadAllTimelines)
 * - iOS Dynamic Island / Lock Screen Live Activity (if enabled)
 */
export async function syncNativeWidgetsAndLiveStatus(
  courses: CourseItem[],
  exams: ExamItem[],
  settings: AppSettings,
  termLabel: string
): Promise<{
  widgetSynced: boolean;
  appGroupAccessible?: boolean;
  keychainAccessible?: boolean;
  keychainGroup?: string;
  widgetTransport?: string;
  widgetSuite?: string;
  ongoingSynced: boolean;
  liveActivitySynced: boolean;
}> {
  const payload = buildNativeWidgetPayload(courses, exams, settings, termLabel);
  let widgetSynced = false;
  let appGroupAccessible: boolean | undefined;
  let keychainAccessible: boolean | undefined;
  let keychainGroup: string | undefined;
  let widgetTransport: string | undefined;
  let widgetSuite: string | undefined;
  let ongoingSynced = false;
  let liveActivitySynced = false;

  if (settings.enableWidgetSync !== false) {
    const res = await callNativeWidgetBridge('/sync-widget', payload);
    widgetSynced = Boolean(res.ok);
    if (typeof res.appGroupAccessible === 'boolean') {
      appGroupAccessible = res.appGroupAccessible;
    }
    if (typeof res.keychainAccessible === 'boolean') {
      keychainAccessible = res.keychainAccessible;
    }
    if (typeof res.keychainGroup === 'string' && res.keychainGroup) {
      keychainGroup = res.keychainGroup;
    }
    if (typeof res.transport === 'string' && res.transport) {
      widgetTransport = res.transport;
    }
    if (typeof res.suite === 'string') {
      widgetSuite = res.suite;
    }
  }

  if (Platform.OS === 'android') {
    const res = await callNativeWidgetBridge('/ongoing-notification', {
      enabled: Boolean(settings.enableOngoingNotification),
      payload,
    });
    ongoingSynced = Boolean(res.ok);
  }

  if (Platform.OS === 'ios') {
    const res = await callNativeWidgetBridge(
      settings.enableLiveActivity ? '/live-activity/upsert' : '/live-activity/stop',
      payload
    );
    liveActivitySynced = Boolean(res.ok);
  }

  return {
    widgetSynced,
    appGroupAccessible,
    keychainAccessible,
    keychainGroup,
    widgetTransport,
    widgetSuite,
    ongoingSynced,
    liveActivitySynced,
  };
}

/**
 * Launch system privacy-preserving photo picker (Android SAF ACTION_OPEN_DOCUMENT /
 * iOS PHPickerViewController — ZERO storage/photo-library permission required!)
 * and copy the chosen wallpaper into app-local files directory.
 */
export async function pickNativeBackgroundImage(): Promise<{
  ok: boolean;
  uri?: string;
  cancelled?: boolean;
  error?: string;
}> {
  const res = await callNativeWidgetBridge('/pick-background', {});
  if (res.cancelled) {
    return { ok: false, cancelled: true };
  }
  if (res.ok && typeof res.uri === 'string' && res.uri) {
    return { ok: true, uri: res.uri };
  }
  return {
    ok: false,
    error:
      typeof res.error === 'string' && res.error
        ? res.error
        : '当前安装包未包含原生相册选择器（请使用最新构建的安装包，或直接使用内置海大渐变壁纸）',
  };
}

/**
 * Save a generated HD PNG data URL (or pure base64) to cache file, optionally commit to
 * Android MediaStore Gallery (zero storage permissions on Android 10+), or open native Share sheet.
 */
export async function exportHdSchedulePng(
  dataUrlOrBase64: string,
  fileName: string,
  mode: 'share' | 'gallery' = 'share'
): Promise<{ ok: boolean; savedToGallery?: boolean; fileUri?: string; error?: string }> {
  const cleanBase64 = dataUrlOrBase64.replace(/^data:image\/\w+;base64,/, '').trim();
  if (!cleanBase64) {
    return { ok: false, error: '高清课表图片尚未生成完成' };
  }

  if (mode === 'gallery' && Platform.OS === 'android') {
    const nativeSave = await callNativeWidgetBridge('/save-image', {
      fileName,
      base64: cleanBase64,
    });
    if (nativeSave.ok) {
      return { ok: true, savedToGallery: true, fileUri: nativeSave.uri };
    }
  }

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = new File(Paths.cache, safeName);
  file.write(cleanBase64, { encoding: 'base64' });
  const fileUri = file.uri;

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    return { ok: true, fileUri };
  }
  await Sharing.shareAsync(fileUri, {
    mimeType: 'image/png',
    UTI: 'public.png',
    dialogTitle: '保存或分享高清海大课表图',
  });
  return { ok: true, savedToGallery: false, fileUri };
}

/**
 * Read a local picked wallpaper file (`file://...`) into a JPEG/PNG data URI for HD Canvas rendering.
 */
export async function readLocalImageAsDataUri(uri?: string): Promise<string | null> {
  if (!uri) return null;
  try {
    const f = new File(uri);
    if (!f.exists) return null;
    const b64 = await f.base64();
    if (!b64) return null;
    const mime = uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}
