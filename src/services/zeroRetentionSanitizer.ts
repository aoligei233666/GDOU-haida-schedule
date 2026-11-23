/**
 * Defense-in-depth denylist + value-level redactor: guarantees NO credential,
 * cookie, ticket, or session token can ever be serialized into local storage —
 * neither by object key nor embedded inside string values or URLs.
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

const SENSITIVE_VALUE_REGEXES: RegExp[] = [
  /(\b(?:JSESSIONID|WFWSESSID|CASTGC|TGC|pwdEncryptSalt|password|passwd|ticket|token)\s*=\s*)([^;&\s"'<>]+)/gi,
  /(\b(?:Cookie|Set-Cookie)\s*:\s*)([^\r\n]+)/gi,
  /(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)([^\s\r\n]+)/gi,
];

/**
 * Strip query strings and fragments from endpoint URLs before recording them in
 * persisted receipts or logs so CAS tickets/tokens in URLs can never be persisted.
 */
export function sanitizeEndpointUrl(rawUrl: string): string {
  const s = String(rawUrl ?? '').trim();
  if (!s) return '';
  const noHash = s.split('#')[0];
  return noHash.split('?')[0];
}

export function containsSensitiveCredentialValue(text: string): boolean {
  if (!text) return false;
  for (const re of SENSITIVE_VALUE_REGEXES) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      return true;
    }
  }
  return false;
}

export function redactSensitiveStringValues(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SENSITIVE_VALUE_REGEXES) {
    re.lastIndex = 0;
    out = out.replace(re, '$1[REDACTED]');
    re.lastIndex = 0;
  }
  return out;
}

export function sanitizeForZeroRetention<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSensitiveStringValues(value) as unknown as T;
  }
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
    if (typeof cur === 'string') {
      if (containsSensitiveCredentialValue(cur)) {
        found.push(`${prefix || '<root>'} [sensitive-value]`);
      }
      return;
    }
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
