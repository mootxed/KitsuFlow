export interface GitHubRequestErrorShape {
  status?: number;
  response?: {
    headers?: Record<string, string | number | undefined>;
    data?: { message?: string };
  };
}

export type GitHubErrorKind =
  | 'unauthorized'
  | 'rate-limit'
  | 'permission-denied'
  | 'not-found'
  | 'validation'
  | 'network'
  | 'unknown';

export interface ParsedGitHubError {
  kind: GitHubErrorKind;
  status?: number | undefined;
  message: string;
  retryAt?: string | undefined;
}

const shapeOf = (error: unknown): GitHubRequestErrorShape =>
  typeof error === 'object' && error !== null ? (error as GitHubRequestErrorShape) : {};

const header = (error: unknown, name: string): string => {
  const headers = shapeOf(error).response?.headers;
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return value === undefined ? '' : String(value);
};

export function safeGitHubErrorMessage(error: unknown): string {
  const responseMessage = shapeOf(error).response?.data?.message;
  const raw =
    typeof responseMessage === 'string'
      ? responseMessage
      : error instanceof Error
        ? error.message
        : 'Ошибка GitHub API';
  return raw.replace(/gh[pousr]_[A-Za-z0-9_]+|Bearer\s+\S+/gi, '[REDACTED]');
}

export function retryAtFromGitHubError(error: unknown): string {
  const retryAfter = Number(header(error, 'retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return new Date(Date.now() + retryAfter * 1000).toISOString();
  }
  const resetMs = Number(header(error, 'x-ratelimit-reset')) * 1000;
  return new Date(resetMs > Date.now() ? resetMs : Date.now() + 60_000).toISOString();
}

export function parseGitHubError(error: unknown): ParsedGitHubError {
  const status = shapeOf(error).status;
  const message = safeGitHubErrorMessage(error);
  const normalized = message.toLowerCase();
  const rateLimited =
    status === 429 ||
    header(error, 'x-ratelimit-remaining') === '0' ||
    normalized.includes('rate limit') ||
    normalized.includes('secondary rate');

  if (status === 401) return { kind: 'unauthorized', status, message };
  if (rateLimited)
    return { kind: 'rate-limit', status, message, retryAt: retryAtFromGitHubError(error) };
  if (status === 403) return { kind: 'permission-denied', status, message };
  if (status === 404) return { kind: 'not-found', status, message };
  if (status === 422) return { kind: 'validation', status, message };
  if (error instanceof TypeError || (error instanceof Error && !status)) {
    return { kind: 'network', status, message };
  }
  return { kind: 'unknown', status, message };
}
