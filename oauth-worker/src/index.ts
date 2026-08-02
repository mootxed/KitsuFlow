interface RefreshSessionStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGINS: string;
  ALLOWED_REDIRECT_URIS: string;
  OAUTH_SESSIONS: RefreshSessionStore;
}

interface RequestBody {
  action?: unknown;
  code?: unknown;
  code_verifier?: unknown;
  redirect_uri?: unknown;
  refresh_session_id?: unknown;
}

interface GitHubTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface StoredRefreshSession {
  refreshToken: string;
  expiresAt: number;
}

const splitAllowlist = (value: string): Set<string> =>
  new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const corsHeaders = (origin: string): HeadersInit => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  Vary: 'Origin',
  'Cache-Control': 'no-store',
});

const json = (origin: string, value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: corsHeaders(origin) });

const isAllowedLocalOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
};

const validRefreshSessionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 16 && value.length <= 128;

const exchangeWithGitHub = async (
  env: Env,
  input: { code: string; codeVerifier: string; redirectUri: string } | { refreshToken: string },
): Promise<{ response: Response; result: GitHubTokenResponse }> => {
  const body =
    'refreshToken' in input
      ? {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: input.refreshToken,
        }
      : {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
        };
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, result: (await response.json()) as GitHubTokenResponse };
};

const persistRefreshToken = async (
  env: Env,
  result: GitHubTokenResponse,
  existingSessionId?: string,
): Promise<{ sessionId?: string; expiresIn?: number }> => {
  if (!result.refresh_token || typeof result.refresh_token_expires_in !== 'number') return {};
  const sessionId = existingSessionId || crypto.randomUUID();
  const expiresIn = Math.max(60, Math.floor(result.refresh_token_expires_in));
  const stored: StoredRefreshSession = {
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  await env.OAUTH_SESSIONS.put(sessionId, JSON.stringify(stored), { expirationTtl: expiresIn });
  return { sessionId, expiresIn };
};

const publicTokenResponse = (
  result: GitHubTokenResponse,
  refresh: { sessionId?: string; expiresIn?: number },
): Record<string, unknown> => ({
  access_token: result.access_token,
  ...(typeof result.expires_in === 'number' ? { expires_in: result.expires_in } : {}),
  ...(refresh.sessionId ? { refresh_session_id: refresh.sessionId } : {}),
  ...(typeof refresh.expiresIn === 'number'
    ? { refresh_session_expires_in: refresh.expiresIn }
    : {}),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = splitAllowlist(env.ALLOWED_ORIGINS);
    if (!allowedOrigins.has(origin) && !isAllowedLocalOrigin(origin)) {
      return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') return json(origin, { error: 'method_not_allowed' }, 405);

    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return json(origin, { error: 'invalid_request' }, 400);
    }

    const action = body.action === undefined ? 'exchange' : body.action;
    try {
      if (action === 'logout') {
        if (!validRefreshSessionId(body.refresh_session_id)) {
          return json(origin, { error: 'invalid_request' }, 400);
        }
        await env.OAUTH_SESSIONS.delete(body.refresh_session_id);
        return json(origin, { ok: true });
      }

      if (action === 'refresh') {
        if (!validRefreshSessionId(body.refresh_session_id)) {
          return json(origin, { error: 'invalid_request' }, 400);
        }
        const storedRaw = await env.OAUTH_SESSIONS.get(body.refresh_session_id);
        if (!storedRaw) return json(origin, { error: 'refresh_session_expired' }, 401);
        const stored = JSON.parse(storedRaw) as StoredRefreshSession;
        if (!stored.refreshToken || stored.expiresAt <= Date.now()) {
          await env.OAUTH_SESSIONS.delete(body.refresh_session_id);
          return json(origin, { error: 'refresh_session_expired' }, 401);
        }
        const { response, result } = await exchangeWithGitHub(env, {
          refreshToken: stored.refreshToken,
        });
        // Terminal-ошибка: GitHub явно отверг refresh token (недействительный, истёкший)
        const isTerminalError = (r: typeof result): boolean => {
          const errCode = r.error || '';
          return (
            errCode === 'bad_verification_code' ||
            errCode === 'invalid_grant' ||
            errCode.includes('expir') ||
            errCode === 'incorrect_client_credentials'
          );
        };
        if (!response.ok || result.error || !result.access_token) {
          if (isTerminalError(result)) {
            // Терминальная ошибка: удаляем KV, refresh невозможен
            await env.OAUTH_SESSIONS.delete(body.refresh_session_id);
            return json(origin, { error: result.error || 'token_refresh_failed' }, 401);
          }
          // Временная ошибка (5xx, 429, сеть): сохраняем KV, предлагаем повторить
          const retryAfter =
            response.status === 429 ? Number(response.headers.get('retry-after') || 60) : 30;
          return json(origin, { error: 'token_refresh_unavailable', retry_after: retryAfter }, 503);
        }
        const refresh = await persistRefreshToken(env, result, body.refresh_session_id);
        if (!refresh.sessionId && result.expires_in) {
          await env.OAUTH_SESSIONS.delete(body.refresh_session_id);
          return json(origin, { error: 'refresh_configuration_error' }, 500);
        }
        return json(origin, publicTokenResponse(result, refresh));
      }

      if (action !== 'exchange') return json(origin, { error: 'invalid_request' }, 400);
      const code = typeof body.code === 'string' ? body.code : '';
      const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
      const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
      const allowedRedirects = splitAllowlist(env.ALLOWED_REDIRECT_URIS);
      if (
        code.length < 1 ||
        code.length > 512 ||
        verifier.length < 43 ||
        verifier.length > 128 ||
        redirectUri.length > 2048 ||
        !allowedRedirects.has(redirectUri)
      ) {
        return json(origin, { error: 'invalid_request' }, 400);
      }

      const { response, result } = await exchangeWithGitHub(env, {
        code,
        codeVerifier: verifier,
        redirectUri,
      });
      if (!response.ok || result.error || !result.access_token) {
        return json(
          origin,
          { error: result.error || 'token_exchange_failed' },
          response.ok ? 400 : 502,
        );
      }
      const refresh = await persistRefreshToken(env, result);
      if (!refresh.sessionId && result.expires_in) {
        return json(origin, { error: 'refresh_configuration_error' }, 500);
      }
      return json(origin, publicTokenResponse(result, refresh));
    } catch {
      return json(origin, { error: 'proxy_unavailable' }, 502);
    }
  },
};
