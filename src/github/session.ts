const TOKEN_KEY = 'kitsuflow.github.access-token';

export interface GitHubAuthSession {
  accessToken: string;
  /** Unix timestamp в миллисекундах; отсутствует у legacy/non-expiring token. */
  expiresAt?: number | undefined;
  /** Непрозрачный идентификатор серверной refresh-сессии, не GitHub refresh token. */
  refreshSessionId?: string | undefined;
  refreshSessionExpiresAt?: number | undefined;
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
