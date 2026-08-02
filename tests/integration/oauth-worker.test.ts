import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../oauth-worker/src/index';

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) || null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const env = (kv: MemoryKv) => ({
  GITHUB_CLIENT_ID: 'Iv1.github-app-client',
  GITHUB_CLIENT_SECRET: 'worker-secret',
  ALLOWED_ORIGINS: 'https://mootxed.github.io',
  ALLOWED_REDIRECT_URIS: 'https://mootxed.github.io/KitsuFlow/',
  OAUTH_SESSIONS: kv,
});

const request = (body: Record<string, unknown>, origin = 'https://mootxed.github.io') =>
  new Request('https://worker.test/oauth', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('OAuth Worker refresh lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the GitHub refresh token in KV and returns only an opaque session id', async () => {
    const kv = new MemoryKv();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        access_token: 'ghu_access',
        expires_in: 28_800,
        refresh_token: 'ghr_secret_refresh',
        refresh_token_expires_in: 15_897_600,
      }),
    );

    const response = await worker.fetch(
      request({
        action: 'exchange',
        code: 'oauth-code',
        code_verifier: 'v'.repeat(64),
        redirect_uri: 'https://mootxed.github.io/KitsuFlow/',
      }),
      env(kv),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.access_token).toBe('ghu_access');
    expect(body.refresh_token).toBeUndefined();
    expect(typeof body.refresh_session_id).toBe('string');
    expect([...kv.values.values()][0]).toContain('ghr_secret_refresh');
  });

  it('rotates a refresh token through the existing opaque session', async () => {
    const kv = new MemoryKv();
    const sessionId = 'opaque-session-id-123456';
    await kv.put(
      sessionId,
      JSON.stringify({ refreshToken: 'ghr_old', expiresAt: Date.now() + 60_000 }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        access_token: 'ghu_rotated',
        expires_in: 28_800,
        refresh_token: 'ghr_rotated',
        refresh_token_expires_in: 15_897_600,
      }),
    );

    const response = await worker.fetch(
      request({ action: 'refresh', refresh_session_id: sessionId }),
      env(kv),
    );
    const body = (await response.json()) as Record<string, unknown>;
    const githubBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(body).toMatchObject({
      access_token: 'ghu_rotated',
      refresh_session_id: sessionId,
    });
    expect(githubBody).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_old' });
    expect(kv.values.get(sessionId)).toContain('ghr_rotated');
  });

  it('rejects an unknown origin before contacting GitHub', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(
      request(
        { action: 'refresh', refresh_session_id: 'opaque-session-id-123456' },
        'https://evil.test',
      ),
      env(new MemoryKv()),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves KV and returns 503 when GitHub responds with a transient 500 error', async () => {
    const kv = new MemoryKv();
    const sessionId = 'transient-session-123456';
    await kv.put(
      sessionId,
      JSON.stringify({ refreshToken: 'ghr_valid', expiresAt: Date.now() + 60_000 }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'server_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await worker.fetch(
      request({ action: 'refresh', refresh_session_id: sessionId }),
      env(kv),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body.error).toBe('token_refresh_unavailable');
    expect(typeof body.retry_after).toBe('number');
    // KV запись должна остаться нетронутой
    expect(kv.values.has(sessionId)).toBe(true);
  });

  it('deletes KV and returns 401 when GitHub returns invalid_grant (terminal error)', async () => {
    const kv = new MemoryKv();
    const sessionId = 'terminal-session-123456';
    await kv.put(
      sessionId,
      JSON.stringify({ refreshToken: 'ghr_expired', expiresAt: Date.now() + 60_000 }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token expired' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await worker.fetch(
      request({ action: 'refresh', refresh_session_id: sessionId }),
      env(kv),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('invalid_grant');
    // KV запись должна быть удалена
    expect(kv.values.has(sessionId)).toBe(false);
  });
});

