import CryptoJS from 'crypto-js';
import { EphemeralCredentials } from '../types/models';

/**
 * Exact character table from GDOU authserver encrypt.js:
 * https://wfw.gdou.edu.cn/https://authserver.gdou.edu.cn/authserver/gdouThemeDz/static/common/encrypt.js
 */
const AES_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

export function randomAesString(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += AES_CHARS.charAt(Math.floor(Math.random() * AES_CHARS.length));
  }
  return out;
}

/**
 * Exact implementation of GDOU Wisedu IDS authserver `encryptPassword(password, salt)`:
 * AES-128-CBC with PKCS7 padding over `randomString(64) + password`,
 * key = UTF8(salt.trim()), iv = UTF8(randomString(16)), Base64 encoded.
 */
export function encryptGdouPassword(
  password: string,
  salt: string,
  deterministicSeed?: { prefix64: string; iv16: string }
): string {
  const trimmedSalt = salt.trim();
  if (!trimmedSalt) {
    return password;
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
 * Overwrites ephemeral credential properties in place so no reference
 * retains the user's username or password after the one-shot login request.
 */
export function purgeEphemeralCredentials(creds: EphemeralCredentials | null | undefined): void {
  if (!creds) return;
  creds.username = '';
  creds.password = '';
  creds.captcha = '';
}
