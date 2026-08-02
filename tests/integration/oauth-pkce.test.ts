import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanOAuthCallbackUrl,
  exchangeCode,
  generatePkce,
  parseCallback,
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
      new Response(JSON.stringify({ access_token: 'token-from-worker' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const token = await exchangeCode('oauth-code', 'v'.repeat(64));
    expect(token).toBe('token-from-worker');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://oauth-proxy.test/exchange');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      code: 'oauth-code',
      code_verifier: 'v'.repeat(64),
    });
  });
});
