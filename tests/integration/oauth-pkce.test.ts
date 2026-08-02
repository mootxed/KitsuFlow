import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  cleanOAuthCallbackUrl,
  exchangeCode,
  generatePkce,
  parseCallback,
  refreshAccessToken,
} from '../../src/github/oauth-pkce';

describe('PKCE OAuth', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('generates verifier/challenge input with valid length and unique state', async () => {
    const first = await generatePkce();
    const second = await generatePkce();
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(first.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(first.oauthState).not.toBe(second.oauthState);
    const url = new URL(await buildAuthUrl('Iv1.github-app-client', first));
    expect(url.searchParams.get('scope')).toBeNull();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('parses callback denial and removes all callback parameters without losing hash', () => {
    const url = new URL(
      'https://example.test/KitsuFlow/?error=access_denied&error_description=No&error_uri=https%3A%2F%2Fdocs.test#repo',
    );
    expect(parseCallback(url)).toEqual({
      kind: 'error',
      error: 'access_denied',
      errorDescription: 'No',
      errorUri: 'https://docs.test',
    });
    expect(cleanOAuthCallbackUrl(url)).toBe('/KitsuFlow/#repo');
  });

  it('sends code, verifier and redirect_uri only to configured proxy', async () => {
    vi.stubEnv('VITE_OAUTH_PROXY_URL', 'https://oauth-proxy.test/exchange');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'token-from-worker',
          expires_in: 28_800,
          refresh_session_id: 'opaque-refresh-session',
          refresh_session_expires_in: 15_897_600,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const credentials = await exchangeCode('oauth-code', 'v'.repeat(64));
    expect(credentials).toMatchObject({
      accessToken: 'token-from-worker',
      refreshSessionId: 'opaque-refresh-session',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth-proxy.test/exchange');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      action: 'exchange',
      code: 'oauth-code',
      code_verifier: 'v'.repeat(64),
    });
  });

  it('refreshes through an opaque Worker session without exposing a GitHub refresh token', async () => {
    vi.stubEnv('VITE_OAUTH_PROXY_URL', 'https://oauth-proxy.test/exchange');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'rotated-access-token',
          expires_in: 28_800,
          refresh_session_id: 'opaque-refresh-session',
          refresh_session_expires_in: 15_897_600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const refreshed = await refreshAccessToken({
      accessToken: 'expired-access-token',
      expiresAt: Date.now() - 1,
      refreshSessionId: 'opaque-refresh-session',
    });

    expect(refreshed.accessToken).toBe('rotated-access-token');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ action: 'refresh', refresh_session_id: 'opaque-refresh-session' });
    expect(JSON.stringify(body)).not.toContain('refresh_token');
  });
});
