import {
  DEFAULT_DESKTOP_UA,
  extractSafeHostname,
  GDOU_JW_SSO_SERVICE,
  upgradeGdouHttpToHttps,
} from '../../constants/gdouEndpoints';
import {
  AuthRequestOptions,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OVERALL_SYNC_TIMEOUT_MS,
  OVERALL_TIMEOUT_REASON,
} from './types';

/**
 * Detect whether code is running inside the native React Native runtime (Android/iOS),
 * where our native OkHttp / URLProtocol interceptor is guaranteed to strip `X-Gdou-*`
 * internal control headers before any bytes hit the wire.
 */
export function isNativeMobileRuntime(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.product === 'string' &&
    navigator.product === 'ReactNative'
  );
}

export function stripInternalControlHeaders(headers?: HeadersInit): HeadersInit | undefined {
  if (!headers) return headers;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const clean = new Headers();
    headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('x-gdou-')) {
        clean.append(key, value);
      }
    });
    return clean;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([key]) => !String(key).toLowerCase().startsWith('x-gdou-'));
  }
  const cleanObj: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.toLowerCase().startsWith('x-gdou-')) {
      cleanObj[key] = value;
    }
  }
  return cleanObj;
}

export function buildHeadersWithOptionalNativeControl(
  base: Record<string, string>,
  controlHeader?:
    | 'X-Gdou-Reset-Cookies-Before'
    | 'X-Gdou-Clear-Cookies-After'
    | 'X-Gdou-Direct-Probe'
): Record<string, string> {
  if (controlHeader && isNativeMobileRuntime()) {
    return { ...base, [controlHeader]: '1' };
  }
  return base;
}

export async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw createAbortError('已取消本次同步操作');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError('已取消本次同步操作'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Legacy compatibility no-op: plaintext passwords are NEVER retained in any module-level global.
 */
export function clearPendingMfaSecret(): void {
  // Intentionally empty: zero module-level credential storage exists.
}

export function isAccountLockedMessage(text: string): boolean {
  const s = String(text ?? '');
  return /冻结|锁定|已被锁|密码错误次数过多|账号异常|account\s*locked|temporarily\s*locked/i.test(s);
}

export function createAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Unified bounded-timeout + cancellable fetch wrapper.
 * Every outbound HTTP request in gdouAuth passes through this guard so no request can hang indefinitely.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  options: AuthRequestOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const externalSignal = options.signal;

  if (externalSignal?.aborted) {
    if (externalSignal.reason === OVERALL_TIMEOUT_REASON) {
      throw new Error(
        `整体同步超时（${Math.round(OVERALL_SYNC_TIMEOUT_MS / 1000)} 秒），请检查网络连接（若开启代理/VPN 请先关闭）或切换「官网无痕网页」`
      );
    }
    throw createAbortError('已取消本次同步操作');
  }

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const safeHeaders = isNativeMobileRuntime()
      ? init.headers
      : stripInternalControlHeaders(init.headers);
    return await fetch(url, {
      ...init,
      headers: safeHeaders,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      const host = extractSafeHostname(url);
      if (host === 'jw.gdou.edu.cn') {
        throw new Error(
          `请求超时（连接 jw.gdou.edu.cn 超过 ${secs} 秒）：校园网直连不可达，请切换上方「校外微门户」通道重试`
        );
      }
      if (host) {
        throw new Error(
          `请求超时（连接 ${host} 超过 ${secs} 秒），请检查网络连接（若开启 VPN/代理 请先关闭）或切换「官网无痕网页」`
        );
      }
      throw new Error(`请求超时（${secs} 秒），请检查网络连接或切换「官网无痕网页」`);
    }
    if (externalSignal?.aborted) {
      if (externalSignal.reason === OVERALL_TIMEOUT_REASON) {
        throw new Error(
          `整体同步超时（${Math.round(OVERALL_SYNC_TIMEOUT_MS / 1000)} 秒），请检查网络连接（若开启代理/VPN 请先关闭）或切换「官网无痕网页」`
        );
      }
      throw createAbortError('已取消本次同步操作');
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw createAbortError('已取消本次同步操作');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export function createBoundedSyncController(externalSignal?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const overallTimer = setTimeout(
    () => controller.abort(OVERALL_TIMEOUT_REASON),
    OVERALL_SYNC_TIMEOUT_MS
  );
  return {
    controller,
    cleanup: () => {
      clearTimeout(overallTimer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

export function extractHiddenInput(html: string, idOrName: string): string {
  const tagRegex = new RegExp(`<input[^>]+(?:id|name)=["']${idOrName}["'][^>]*>`, 'gi');
  const matches = html.match(tagRegex);
  if (!matches) return '';
  for (let i = matches.length - 1; i >= 0; i--) {
    const valMatch = matches[i].match(/value=["']([^"']*)["']/i);
    if (valMatch && valMatch[1]) {
      return valMatch[1];
    }
  }
  return '';
}

export function extractServiceUrl(html: string): string {
  const m = html.match(/var\s+service\s*=\s*\[\s*["']([^"']+)["']\s*\]/);
  if (m && m[1]) {
    return m[1].replace(/\\\//g, '/');
  }
  return GDOU_JW_SSO_SERVICE;
}

export function extractAuthError(html: string): string {
  const patterns = [
    /id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/div>/gi,
    /id=["']showErrorTip["'][^>]*>([\s\S]*?)<\/span>/gi,
    /id=["']formErrorTip2?["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const clean = (m[1] || '').replace(/<[^>]+>/g, '').trim();
      if (clean) return clean;
    }
  }
  return '';
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    result += chars[(triple >> 18) & 63];
    result += chars[(triple >> 12) & 63];
    result += i + 1 < bytes.length ? chars[(triple >> 6) & 63] : '=';
    result += i + 2 < bytes.length ? chars[triple & 63] : '=';
  }
  return result;
}

export function encodeFormBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function parseSelectedOption(html: string, selectId: string): string | null {
  const selectRegex = new RegExp(
    `<select[^>]+id=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    'i'
  );
  const m = html.match(selectRegex);
  if (!m) return null;
  const optMatch = m[1].match(
    /<option[^>]+selected[^>]*value=["']([^"']*)["']|<option[^>]+value=["']([^"']*)["'][^>]*selected/i
  );
  if (optMatch) {
    return (optMatch[1] || optMatch[2] || '').trim() || null;
  }
  return null;
}
