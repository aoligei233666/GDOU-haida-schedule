import { Platform } from 'react-native';
import { invokeGdouNativeCore } from '../../modules/gdou-native-core';

export interface NativeBridgeResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Unified typed bridge to native Android/iOS capabilities:
 * 1. Primary path (v2.0+): invokes local Expo Native Module `GdouNativeCore` over JSI (zero HTTP loopback overhead).
 * 2. Legacy fallback (v1.5.x native binaries receiving OTA): transparently falls back to internal loopback URL.
 */
export async function invokeNativeBridge(options: {
  action: string;
  payload?: unknown;
  legacyUrl?: string;
  legacyMethod?: 'GET' | 'POST';
  timeoutMs?: number;
}): Promise<NativeBridgeResponse> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return { ok: false, error: '当前运行环境不支持原生桥接' };
  }

  // 1. Prefer typed Expo Native Module (GdouNativeCore)
  const nativeRes = await invokeGdouNativeCore(options.action, options.payload);
  if (nativeRes !== null) {
    return nativeRes;
  }

  // 2. Fallback to legacy loopback interception when running on older native shells
  if (!options.legacyUrl) {
    return { ok: false, error: '当前底座不支持该原生能力，请安装最新版安装包' };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const method = options.legacyMethod ?? 'POST';
    const resp = await fetch(options.legacyUrl, {
      method,
      credentials: 'omit',
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(options.payload ?? {}) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    const parsed = JSON.parse(text) as NativeBridgeResponse;
    return { ...parsed, ok: Boolean(parsed?.ok) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
