/* eslint-disable @typescript-eslint/no-require-imports */
interface DirentLike {
  name: string;
  isDirectory(): boolean;
}
const fs = require('fs') as {
  existsSync(p: string): boolean;
  readdirSync(p: string, opts: { withFileTypes: true }): DirentLike[];
  readFileSync(p: string, enc: string): string;
};
const path = require('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
  extname(p: string): string;
};

/**
 * Deterministic static code quality, privacy, and version consistency linter (`npm run lint`).
 */
const ROOT = process.cwd();
const errors: string[] = [];

function walkFiles(dir: string, exts: Set<string>, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'android' || entry.name === 'ios') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (exts.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

// 1. Check for forbidden secret/keystore files inside repository tree
const allRepoFiles = walkFiles(
  ROOT,
  new Set(['.jks', '.keystore', '.p12', '.p8', '.mobileprovision', '.pem'])
);
for (const secretFile of allRepoFiles) {
  errors.push(`Forbidden key/certificate file inside repository: ${path.relative(ROOT, secretFile)}`);
}

function stripJsComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

// 2. Scan src/ files for anti-patterns and security regressions
const srcFiles = walkFiles(path.join(ROOT, 'src'), new Set(['.ts', '.tsx']));
for (const file of srcFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const raw = fs.readFileSync(file, 'utf8');
  const codeOnly = stripJsComments(raw);

  if (/\bconsole\.log\s*\(/.test(codeOnly)) {
    errors.push(`Disallowed console.log in production source: ${rel}`);
  }
  if (/TODO:|FIXME:/.test(raw)) {
    errors.push(`Unresolved TODO/FIXME marker in production source: ${rel}`);
  }
  if ((rel.includes('cryptoAes') || rel.includes('gdouAuth') || rel.includes('services/auth/')) && /\bMath\.random\s*\(/.test(codeOnly)) {
    errors.push(`Disallowed non-CSPRNG Math.random() in crypto/auth module: ${rel}`);
  }
  if (/(?:sessionLoggedOut|cookiesFlushed|storageCleaned)\s*:\s*true\b/.test(codeOnly)) {
    errors.push(`Hardcoded SyncReceipt verification flag in ${rel}`);
  }
  if (/-----BEGIN (?:PRIVATE|RSA PRIVATE|EC PRIVATE|OPENSSH PRIVATE) KEY-----/.test(raw)) {
    errors.push(`Hardcoded private key detected in ${rel}`);
  }
}

// 3. Scan plugins/ & modules/ for release-signing regressions or debug keystore fallbacks
const nativePluginFiles = [
  ...walkFiles(path.join(ROOT, 'plugins'), new Set(['.js', '.kt', '.swift'])),
  ...walkFiles(path.join(ROOT, 'modules'), new Set(['.ts', '.kt', '.swift', '.gradle'])),
];
for (const file of nativePluginFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const content = fs.readFileSync(file, 'utf8');
  if (/-----BEGIN (?:PRIVATE|RSA PRIVATE|EC PRIVATE) KEY-----/.test(content)) {
    errors.push(`Private key detected in native plugin/module: ${rel}`);
  }
  if (rel.endsWith('androidMods.js') && /signingConfig\s+signingConfigs\.debug\s*\n\s*\}/.test(content)) {
    errors.push(`Release buildType must never fall back to signingConfigs.debug: ${rel}`);
  }
}

// 4. Single-source version & doc consistency check
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const altJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'altstore-source.json'), 'utf8'));
const nativeCorePkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'modules', 'gdou-native-core', 'package.json'), 'utf8')
);
const readmeText = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const ver = appJson.expo.version;
if (pkgJson.version !== ver) {
  errors.push(`Version mismatch: package.json (${pkgJson.version}) != app.json (${ver})`);
}
if (lockJson.version !== ver || lockJson.packages?.['']?.version !== ver) {
  errors.push(`Version mismatch: package-lock.json != app.json (${ver})`);
}
if (altJson.apps?.[0]?.version !== ver) {
  errors.push(`Version mismatch: altstore-source.json (${altJson.apps?.[0]?.version}) != app.json (${ver})`);
}
if (nativeCorePkg.version !== ver) {
  errors.push(`Version mismatch: modules/gdou-native-core/package.json (${nativeCorePkg.version}) != app.json (${ver})`);
}
if (!readmeText.includes(`v${ver}`) && !readmeText.includes(`(${ver})`)) {
  errors.push(`README.md does not reference current version v${ver}`);
}

if (errors.length > 0) {
  console.error('LINT CHECK FAILED:');
  for (const e of errors) {
    console.error('  -', e);
  }
  process.exit(1);
}

console.log(
  `LINT CHECK PASSED (${srcFiles.length} src files, ${nativePluginFiles.length} plugin/module files, version v${ver} aligned).`
);
