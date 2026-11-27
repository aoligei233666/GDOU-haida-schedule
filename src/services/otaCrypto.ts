/**
 * Pure-TypeScript RFC 8032 Ed25519 signature verification & canonical OTA manifest hashing.
 * - Zero external dependencies; runs deterministically on React Native Hermes and Node.js.
 * - Embedded public key matches the offline/CI Ed25519 release signing private key
 *   (private key is NEVER committed to Git).
 */

export const OTA_ED25519_KEY_ID = 'gdou-ota-ed25519-v1';
export const OTA_ED25519_PUBLIC_KEY_HEX =
  'cccc4d6256049d3fbb2c8c812fb2f28cd60b1c65dc0130cd2d49a366fc019651';

export interface SignedOtaManifestFields {
  version: string;
  minNativeRuntimeVersion?: number;
  iosBundleName?: string;
  iosSha256?: string;
  iosSize?: number;
  androidBundleName?: string;
  androidSha256?: string;
  androidSize?: number;
  iosIpaSha256?: string;
  iosIpaSize?: number;
  androidApkSha256?: string;
  androidApkSize?: number;
  ios?: { fileName?: string; sha256?: string; size?: number };
  android?: { fileName?: string; sha256?: string; size?: number };
  signatureAlg?: string;
  keyId?: string;
  signature?: string;
}

const SHA512_K: readonly bigint[] = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

const MASK64 = 0xffffffffffffffffn;

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

export function sha512(message: Uint8Array): Uint8Array {
  const bitLen = BigInt(message.length) * 8n;
  const padLen = ((112 - ((message.length + 1) % 128)) + 128) % 128;
  const totalLen = message.length + 1 + padLen + 16;
  const padded = new Uint8Array(totalLen);
  padded.set(message, 0);
  padded[message.length] = 0x80;
  // 128-bit big-endian bit length (high 64 bits are 0 for < 2^61 bytes)
  let rem = bitLen;
  for (let i = totalLen - 1; i >= totalLen - 8; i--) {
    padded[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }

  let h0 = 0x6a09e667f3bcc908n;
  let h1 = 0xbb67ae8584caa73bn;
  let h2 = 0x3c6ef372fe94f82bn;
  let h3 = 0xa54ff53a5f1d36f1n;
  let h4 = 0x510e527fade682d1n;
  let h5 = 0x9b05688c2b3e6c1fn;
  let h6 = 0x1f83d9abfb41bd6bn;
  let h7 = 0x5be0cd19137e2179n;

  const w = new Array<bigint>(80);

  for (let offset = 0; offset < totalLen; offset += 128) {
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 8;
      w[i] =
        (BigInt(padded[idx]) << 56n) |
        (BigInt(padded[idx + 1]) << 48n) |
        (BigInt(padded[idx + 2]) << 40n) |
        (BigInt(padded[idx + 3]) << 32n) |
        (BigInt(padded[idx + 4]) << 24n) |
        (BigInt(padded[idx + 5]) << 16n) |
        (BigInt(padded[idx + 6]) << 8n) |
        BigInt(padded[idx + 7]);
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ ((~e & MASK64) & g);
      const temp1 = (h + S1 + ch + SHA512_K[i] + w[i]) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) & MASK64;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & MASK64;
    }

    h0 = (h0 + a) & MASK64;
    h1 = (h1 + b) & MASK64;
    h2 = (h2 + c) & MASK64;
    h3 = (h3 + d) & MASK64;
    h4 = (h4 + e) & MASK64;
    h5 = (h5 + f) & MASK64;
    h6 = (h6 + g) & MASK64;
    h7 = (h7 + h) & MASK64;
  }

  const out = new Uint8Array(64);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    let val = words[i];
    for (let j = 7; j >= 0; j--) {
      out[i * 8 + j] = Number(val & 0xffn);
      val >>= 8n;
    }
  }
  return out;
}

// Ed25519 Curve Parameters (RFC 8032 Section 5.1)
const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
const BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;

interface ExtPoint {
  x: bigint;
  y: bigint;
  z: bigint;
  t: bigint;
}

function modP(a: bigint): bigint {
  const r = a % P;
  return r >= 0n ? r : r + P;
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function modInv(a: bigint): bigint {
  return modPow(a, P - 2n, P);
}

const IDENTITY_POINT: ExtPoint = { x: 0n, y: 1n, z: 1n, t: 0n };
const BASE_POINT: ExtPoint = { x: BX, y: BY, z: 1n, t: modP(BX * BY) };

function pointAdd(p1: ExtPoint, p2: ExtPoint): ExtPoint {
  const A = modP((p1.y - p1.x) * (p2.y - p2.x));
  const B = modP((p1.y + p1.x) * (p2.y + p2.x));
  const C = modP(p1.t * 2n * D * p2.t);
  const D2 = modP(p1.z * 2n * p2.z);
  const E = modP(B - A);
  const F = modP(D2 - C);
  const G = modP(D2 + C);
  const H = modP(B + A);
  return {
    x: modP(E * F),
    y: modP(G * H),
    z: modP(F * G),
    t: modP(E * H),
  };
}

function scalarMul(point: ExtPoint, scalar: bigint): ExtPoint {
  let acc = IDENTITY_POINT;
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if ((k & 1n) === 1n) {
      acc = pointAdd(acc, addend);
    }
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return acc;
}

function bytesToLittleEndianBigInt(bytes: Uint8Array): bigint {
  let val = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    val = (val << 8n) | BigInt(bytes[i]);
  }
  return val;
}

function decodePoint(bytes: Uint8Array): ExtPoint | null {
  if (bytes.length !== 32) return null;
  const sign = (bytes[31] >> 7) & 1;
  const copy = new Uint8Array(bytes);
  copy[31] &= 0x7f;
  const y = bytesToLittleEndianBigInt(copy);
  if (y >= P) return null;

  const y2 = modP(y * y);
  const u = modP(y2 - 1n);
  const v = modP(D * y2 + 1n);
  const v3 = modP(v * v * v);
  const v7 = modP(v3 * v3 * v);
  let x = modP(u * v3 * modPow(modP(u * v7), (P - 5n) / 8n, P));

  const vx2 = modP(v * x * x);
  if (vx2 === modP(-u)) {
    x = modP(x * SQRT_M1);
  } else if (vx2 !== u) {
    return null;
  }

  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) {
    x = modP(-x);
  }
  return { x, y, z: 1n, t: modP(x * y) };
}

function pointsEqual(p1: ExtPoint, p2: ExtPoint): boolean {
  const x1z2 = modP(p1.x * p2.z);
  const x2z1 = modP(p2.x * p1.z);
  const y1z2 = modP(p1.y * p2.z);
  const y2z1 = modP(p2.y * p1.z);
  return x1z2 === x2z1 && y1z2 === y2z1;
}

export function hexToBytes(hex: string): Uint8Array | null {
  const clean = String(hex ?? '').trim().toLowerCase();
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    return null;
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function utf8ToBytes(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
  }
  return new Uint8Array(bytes);
}

/**
 * Verify an RFC 8032 Ed25519 signature (`signatureHex` = 64 bytes hex, `publicKeyHex` = 32 bytes hex).
 */
export function verifyEd25519Signature(
  message: Uint8Array,
  signatureHex: string,
  publicKeyHex: string = OTA_ED25519_PUBLIC_KEY_HEX
): boolean {
  try {
    const sigBytes = hexToBytes(signatureHex);
    const pubBytes = hexToBytes(publicKeyHex);
    if (!sigBytes || sigBytes.length !== 64 || !pubBytes || pubBytes.length !== 32) {
      return false;
    }

    const rBytes = sigBytes.subarray(0, 32);
    const sBytes = sigBytes.subarray(32, 64);
    const s = bytesToLittleEndianBigInt(sBytes);
    if (s >= L) return false;

    const R = decodePoint(rBytes);
    const A = decodePoint(pubBytes);
    if (!R || !A) return false;

    const hInput = new Uint8Array(64 + message.length);
    hInput.set(rBytes, 0);
    hInput.set(pubBytes, 32);
    hInput.set(message, 64);
    const k = bytesToLittleEndianBigInt(sha512(hInput)) % L;

    const lhs = scalarMul(BASE_POINT, s);
    const rhs = pointAdd(R, scalarMul(A, k));
    return pointsEqual(lhs, rhs);
  } catch {
    return false;
  }
}

/**
 * Canonical deterministic string representation of an OTA manifest signed by Ed25519.
 * Any change to version, minNativeRuntimeVersion, or bundle/installer SHA-256 invalidates the signature.
 */
export function buildCanonicalOtaManifestPayload(manifest: SignedOtaManifestFields): string {
  const norm = (s?: string) => String(s ?? '').trim().toLowerCase();
  const num = (n?: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0);
  const canonicalObj = {
    version: String(manifest.version ?? '').trim(),
    minNativeRuntimeVersion: num(manifest.minNativeRuntimeVersion ?? 1),
    iosSha256: norm(manifest.iosSha256 || manifest.ios?.sha256),
    iosSize: num(manifest.iosSize ?? manifest.ios?.size),
    androidSha256: norm(manifest.androidSha256 || manifest.android?.sha256),
    androidSize: num(manifest.androidSize ?? manifest.android?.size),
    iosIpaSha256: norm(manifest.iosIpaSha256),
    iosIpaSize: num(manifest.iosIpaSize),
    androidApkSha256: norm(manifest.androidApkSha256),
    androidApkSize: num(manifest.androidApkSize),
  };
  return `GDOU-OTA-MANIFEST-V1\n${JSON.stringify(canonicalObj)}`;
}

export function verifyOtaManifestSignature(
  manifest: SignedOtaManifestFields | null | undefined,
  publicKeyHex: string = OTA_ED25519_PUBLIC_KEY_HEX
): { present: boolean; valid: boolean; reason?: string } {
  if (!manifest) {
    return { present: false, valid: false, reason: '缺少 OTA 清单文件' };
  }
  const sig = String(manifest.signature ?? '').trim();
  if (!sig) {
    return { present: false, valid: false, reason: 'OTA 清单未包含 Ed25519 签名' };
  }
  if (manifest.signatureAlg && manifest.signatureAlg.toLowerCase() !== 'ed25519') {
    return { present: true, valid: false, reason: `不支持的签名算法：${manifest.signatureAlg}` };
  }
  const canonical = buildCanonicalOtaManifestPayload(manifest);
  const ok = verifyEd25519Signature(utf8ToBytes(canonical), sig, publicKeyHex);
  return ok
    ? { present: true, valid: true }
    : { present: true, valid: false, reason: 'Ed25519 数字签名校验失败（清单可能被篡改）' };
}

// Keep modInv referenced only when needed (export helper for tests if desired)
export const _internalModInv = modInv;
