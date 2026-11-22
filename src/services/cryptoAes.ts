import CryptoJS from 'crypto-js';
import { EphemeralCredentials } from '../types/models';

/**
 * Exact character table from GDOU authserver encrypt.js:
 * https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/authserver/gdouThemeDz/static/common/encrypt.js
 * Length = 48 (divides 240 evenly for rejection sampling without modulo bias).
 */
const AES_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

interface CryptoProviderLike {
  getRandomBytes?: (byteCount: number) => Uint8Array;
}

let cachedExpoCrypto: CryptoProviderLike | null | undefined;

function getExpoCryptoProvider(): CryptoProviderLike | null {
  if (cachedExpoCrypto !== undefined) return cachedExpoCrypto;
  try {
    // Loaded dynamically so pure Node.js verification scripts work without native Expo runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-crypto') as CryptoProviderLike;
    cachedExpoCrypto = mod && typeof mod.getRandomBytes === 'function' ? mod : null;
  } catch {
    cachedExpoCrypto = null;
  }
  return cachedExpoCrypto;
}

/**
 * Cryptographically secure random bytes (CSPRNG).
 * Uses WebCrypto `crypto.getRandomValues` or `expo-crypto.getRandomBytes`.
 * Never falls back to `Math.random()`.
 */
export function secureRandomBytes(length: number): Uint8Array {
  if (length <= 0) return new Uint8Array(0);

  const expoCrypto = getExpoCryptoProvider();
  if (expoCrypto?.getRandomBytes) {
    return expoCrypto.getRandomBytes(length);
  }

  const webCrypto = (globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(arr: T) => T } }).crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const out = new Uint8Array(length);
    webCrypto.getRandomValues(out);
    return out;
  }

  throw new Error('当前运行环境缺少密码学安全随机数生成器 (CSPRNG)，已终止加密操作');
}

/**
 * Generates an unbiased CSPRNG string from AES_CHARS using rejection sampling.
 */
export function randomAesString(length: number): string {
  const alphabetLen = AES_CHARS.length; // 48
  const maxUnbiased = Math.floor(256 / alphabetLen) * alphabetLen; // 240
  let out = '';
  while (out.length < length) {
    const needed = length - out.length;
    const bytes = secureRandomBytes(Math.max(16, needed * 2));
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      const b = bytes[i];
      if (b < maxUnbiased) {
        out += AES_CHARS.charAt(b % alphabetLen);
      }
    }
  }
  return out;
}

/**
 * Generates an uppercase hex token from CSPRNG (used for ephemeral BFP & WebView bridge nonce).
 */
export function generateSecureHex(byteLength: number): string {
  const bytes = secureRandomBytes(byteLength);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0').toUpperCase();
  }
  return hex;
}

/**
 * Exact implementation of GDOU Wisedu IDS authserver `encryptPassword(password, salt)`:
 * AES-128-CBC with PKCS7 padding over `randomAesString(64) + password`,
 * key = UTF8(salt.trim()), iv = UTF8(randomAesString(16)), Base64 encoded.
 *
 * Security invariant (fail-closed): NEVER silently falls back to plaintext if salt is missing.
 */
export function encryptGdouPassword(
  password: string,
  salt: string,
  deterministicSeed?: { prefix64: string; iv16: string }
): string {
  const trimmedSalt = (salt ?? '').trim();
  if (!trimmedSalt || trimmedSalt.length < 16) {
    throw new Error('未获取到有效的海大认证加密盐值 (pwdEncryptSalt)，已终止提交以防明文发送密码');
  }
  const prefix = deterministicSeed ? deterministicSeed.prefix64 : randomAesString(64);
  const ivStr = deterministicSeed ? deterministicSeed.iv16 : randomAesString(16);

  const key = CryptoJS.enc.Utf8.parse(trimmedSalt);
  const iv = CryptoJS.enc.Utf8.parse(ivStr);
  const encrypted = CryptoJS.AES.encrypt(prefix + password, key, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return encrypted.toString();
}

/**
 * Clears all ephemeral credential property references on the caller's object so no
 * reachable JS reference retains username/password/captcha after the auth request.
 * Note: JavaScript strings are immutable in the JS heap until GC collects them;
 * clearing references promptly ensures zero persistence and rapid GC reclamation.
 */
export function purgeEphemeralCredentials(creds: EphemeralCredentials | null | undefined): void {
  if (!creds) return;
  creds.username = '';
  creds.password = '';
  creds.captcha = '';
}

export function areCredentialsPurged(creds: EphemeralCredentials | null | undefined): boolean {
  if (!creds) return true;
  return creds.username === '' && creds.password === '' && (creds.captcha ?? '') === '';
}
