// Values that never reach run output or either stream (spec part 2 section
// 9.6): every value read through ${env.NAME}, and the session's cookie and
// storage values. Values under 4 characters are not redacted.

const known = new Map<string, string>();

export function addSecret(value: string, replacement: string): void {
  if (value.length < 4 || known.has(value)) return;
  known.set(value, replacement);
}

export function clearSecrets(): void {
  known.clear();
}

export function secretValues(): string[] {
  return [...known.keys()];
}

// Exact matches, in raw and JSON-escaped form, longest first so a value that
// contains another is replaced whole.
export function redactSecrets(text: string): string {
  let out = text;
  const values = [...known.keys()].sort((a, b) => b.length - a.length);
  for (const value of values) {
    const replacement = known.get(value)!;
    out = out.split(value).join(replacement);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) out = out.split(escaped).join(JSON.stringify(replacement).slice(1, -1));
  }
  return out;
}

export interface StorageStateLike {
  cookies: { value: string }[];
  origins: { localStorage: { value: string }[] }[];
}

export function addSessionSecrets(state: StorageStateLike): void {
  for (const cookie of state.cookies) addSecret(cookie.value, '<session>');
  for (const origin of state.origins) for (const item of origin.localStorage) addSecret(item.value, '<session>');
}

// Credential strings for `401` (section 20.6): session cookie and localStorage
// values of at least 16 characters, and strings inside localStorage values
// that parse as JSON.
export function credentialStrings(state: StorageStateLike | null | undefined): string[] {
  if (!state) return [];
  const out = new Set<string>();
  const add = (v: string) => {
    if (v.length >= 16) out.add(v);
  };
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === 'string') add(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, depth + 1));
  };
  for (const cookie of state.cookies) add(cookie.value);
  for (const origin of state.origins) {
    for (const item of origin.localStorage) {
      add(item.value);
      try {
        walk(JSON.parse(item.value), 0);
      } catch {
        // Not JSON.
      }
    }
  }
  return [...out];
}

// A credential header: Authorization, or any header but Cookie whose value
// contains a credential string.
export function hasCredentialHeader(headers: Record<string, string>, credentials: string[]): boolean {
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (n === 'cookie') continue;
    if (n === 'authorization') return true;
    if (credentials.some((c) => value.includes(c))) return true;
  }
  return false;
}
