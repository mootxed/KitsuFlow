interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGINS: string;
  ALLOWED_REDIRECT_URIS: string;
}

interface ExchangeBody {
  code?: unknown;
  code_verifier?: unknown;
  redirect_uri?: unknown;
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

    let body: ExchangeBody;
    try {
      body = (await request.json()) as ExchangeBody;
    } catch {
      return json(origin, { error: 'invalid_request' }, 400);
    }

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

    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });
      const result = (await response.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!response.ok || result.error || !result.access_token) {
        return json(
          origin,
          {
            error: result.error || 'token_exchange_failed',
            error_description: result.error_description || 'GitHub отклонил обмен кода.',
          },
          response.ok ? 400 : 502,
        );
      }
      return json(origin, { access_token: result.access_token });
    } catch {
      return json(origin, { error: 'proxy_unavailable' }, 502);
    }
  },
};
