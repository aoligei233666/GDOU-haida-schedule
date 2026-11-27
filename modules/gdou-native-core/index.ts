import { requireOptionalNativeModule } from 'expo-modules-core';

export interface GdouNativeCoreNativeModule {
  isReady(): boolean;
  invokeAsync(action: string, payloadJson: string): Promise<string>;
}

const nativeModule = requireOptionalNativeModule<GdouNativeCoreNativeModule>('GdouNativeCore');

export function isGdouNativeCoreAvailable(): boolean {
  if (!nativeModule) return false;
  try {
    return Boolean(nativeModule.isReady());
  } catch {
    return false;
  }
}

export async function invokeGdouNativeCore(
  action: string,
  payload?: unknown
): Promise<{ ok: boolean; [key: string]: unknown } | null> {
  if (!nativeModule) return null;
  try {
    const serialized = payload === undefined ? '{}' : JSON.stringify(payload);
    const raw = await nativeModule.invokeAsync(action, serialized);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ok?: boolean; [key: string]: unknown };
    return {
      ...parsed,
      ok: Boolean(parsed?.ok),
    };
  } catch {
    return null;
  }
}
