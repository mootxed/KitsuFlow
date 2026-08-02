const TOKEN_KEY = 'kitsuflow.github.access-token';
const ACCOUNT_CACHE_KEY = 'kitsuflow.account.cache';

export interface GitHubAuthSession {
  accessToken: string;
  /** Unix timestamp в миллисекундах; отсутствует у legacy/non-expiring token. */
  expiresAt?: number | undefined;
  /** Непрозрачный идентификатор серверной refresh-сессии, не GitHub refresh token. */
  refreshSessionId?: string | undefined;
  refreshSessionExpiresAt?: number | undefined;
}

/** Несекретный кеш аккаунта для офлайн-режима. Хранится в localStorage и переживает перезагрузку. */
export interface AccountCacheEntry {
  accountId: string;
  login: string;
  avatarUrl: string;
  name?: string | null | undefined;
}

const read = (): GitHubAuthSession | null => {
  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<GitHubAuthSession>;
    if (typeof parsed.accessToken === 'string' && parsed.accessToken) {
      return {
        accessToken: parsed.accessToken,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
        refreshSessionId:
          typeof parsed.refreshSessionId === 'string' ? parsed.refreshSessionId : undefined,
        refreshSessionExpiresAt:
          typeof parsed.refreshSessionExpiresAt === 'number'
            ? parsed.refreshSessionExpiresAt
            : undefined,
      };
    }
  } catch {
    // Legacy-значение до refresh lifecycle было обычной строкой access token.
  }
  return { accessToken: stored };
};

export const session = {
  get(): GitHubAuthSession | null {
    return read();
  },
  getToken(): string | null {
    return read()?.accessToken || null;
  },
  set(value: GitHubAuthSession): void {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(value));
  },
  setToken(token: string): void {
    const current = read();
    this.set(current ? { ...current, accessToken: token } : { accessToken: token });
  },
  clear(): GitHubAuthSession | null {
    const current = read();
    sessionStorage.removeItem(TOKEN_KEY);
    return current;
  },
};

/** Несекретный кеш данных аккаунта (переживает офлайн-перезагрузку). */
export const accountCache = {
  get(): AccountCacheEntry | null {
    const stored = localStorage.getItem(ACCOUNT_CACHE_KEY);
    if (!stored) return null;
    try {
      return JSON.parse(stored) as AccountCacheEntry;
    } catch {
      return null;
    }
  },
  set(entry: AccountCacheEntry): void {
    localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(entry));
  },
  clear(): void {
    localStorage.removeItem(ACCOUNT_CACHE_KEY);
  },
};
