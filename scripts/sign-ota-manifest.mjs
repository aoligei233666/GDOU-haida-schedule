#!/usr/bin/env node
/**
 * Sign a generated `haida-schedule-vX.Y.Z-ota-manifest.json` using Ed25519 private key.
 * Reads private key PEM from:
 *   1. `process.env.OTA_SIGNING_PRIVATE_KEY_PEM` (GitHub Actions Secret), or
 *   2. `~/.gdou-keystore/ota-ed25519-private.pem` (local developer keystore outside Git).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('Usage: node scripts/sign-ota-manifest.mjs <path-to-ota-manifest.json>');
  process.exit(1);
}

const envPem = (process.env.OTA_SIGNING_PRIVATE_KEY_PEM || '').trim();
const localKeyPath = path.join(os.homedir(), '.gdou-keystore', 'ota-ed25519-private.pem');
const pem = envPem || (fs.existsSync(localKeyPath) ? fs.readFileSync(localKeyPath, 'utf8').trim() : '');

if (!pem) {
  console.log('[sign-ota-manifest] No Ed25519 private key configured; leaving manifest unsigned.');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const norm = (s) => String(s ?? '').trim().toLowerCase();
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0);

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
const canonicalPayload = `GDOU-OTA-MANIFEST-V1\n${JSON.stringify(canonicalObj)}`;

const privateKey = crypto.createPrivateKey(pem);
const publicKey = crypto.createPublicKey(privateKey);
const signatureBuf = crypto.sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKey);
const verified = crypto.verify(null, Buffer.from(canonicalPayload, 'utf8'), publicKey, signatureBuf);
if (!verified) {
  console.error('[sign-ota-manifest] Self-verification failed!');
  process.exit(1);
}

manifest.signatureAlg = 'ed25519';
manifest.keyId = 'gdou-ota-ed25519-v1';
manifest.signature = signatureBuf.toString('hex');

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('[sign-ota-manifest] Signed manifest with Ed25519:', path.basename(manifestPath));
