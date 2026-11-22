/**
 * Defense-in-depth denylist: guarantees NO credential or session key can ever
 * be serialized into local storage even by accident.
 * Kept React-Native-free so Node.js unit tests verify the exact production implementation.
 */
export const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'username',
  'password',
  'pwd',
  'passwd',
  'cookie',
  'cookies',
  'token',
  'jsessionid',
  'wfwsessid',
  'tgc',
  'castgc',
  'pwdencryptsalt',
  'pwdEncryptSalt',
  'execution',
  'salt',
]);

export function sanitizeForZeroRetention<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForZeroRetention(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_CREDENTIAL_KEYS.has(k.toLowerCase()) || FORBIDDEN_CREDENTIAL_KEYS.has(k)) {
        continue;
      }
      clean[k] = sanitizeForZeroRetention(v);
    }
    return clean as T;
  }
  return value;
}

export function findForbiddenCredentialKeys(obj: unknown, pathPrefix = ''): string[] {
  const found: string[] = [];
  const inspect = (cur: unknown, prefix: string) => {
    if (Array.isArray(cur)) {
      cur.forEach((item, idx) => inspect(item, `${prefix}[${idx}]`));
    } else if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
        const fullKey = prefix ? `${prefix}.${k}` : k;
        if (FORBIDDEN_CREDENTIAL_KEYS.has(k.toLowerCase()) || FORBIDDEN_CREDENTIAL_KEYS.has(k)) {
          found.push(fullKey);
        }
        inspect(v, fullKey);
      }
    }
  };
  inspect(obj, pathPrefix);
  return found;
}
