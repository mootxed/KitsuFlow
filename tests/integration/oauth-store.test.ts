import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import { GitHubApi } from '../../src/github/api';
import { useAppStore } from '../../src/state/app-store';

describe('OAuth callback store lifecycle', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      initialized: false,
      user: null,
      api: null,
      issues: [],
      pendingIssues: [],
      repositories: [],
      tabs: [],
      outbox: [],
      auth: { phase: 'idle' },
      sessionGeneration: 0,
    });
  });

  it('exchanges callback once and restores /user and repositories once', async () => {
    vi.stubEnv('VITE_OAUTH_PROXY_URL', 'https://oauth-proxy.test/exchange');
    sessionStorage.setItem('kitsuflow.oauth.verifier', 'v'.repeat(64));
    sessionStorage.setItem('kitsuflow.oauth.state', 'expected-state');
    window.history.replaceState({}, '', '/?code=oauth-code&state=expected-state#all');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'callback-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const userSpy = vi.spyOn(GitHubApi.prototype, 'getCurrentUser').mockResolvedValue({
      id: 1001,
      login: 'fox',
      name: 'Fox',
      avatarUrl: '',
    });
    const repositoriesSpy = vi.spyOn(GitHubApi.prototype, 'getRepositories').mockResolvedValue([]);

    await useAppStore.getState().initialize();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(userSpy).toHaveBeenCalledOnce();
    expect(repositoriesSpy).toHaveBeenCalledOnce();
    expect(useAppStore.getState().user?.id).toBe(1001);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#all');
  });

  it('shows access_denied and cleans callback URL without contacting proxy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    window.history.replaceState(
      {},
      '',
      '/?error=access_denied&error_description=The+user+denied+access#all',
    );

    await useAppStore.getState().initialize();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().auth).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('отменили вход'),
    });
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#all');
  });

  it('rejects a state mismatch before contacting the proxy', async () => {
    sessionStorage.setItem('kitsuflow.oauth.verifier', 'v'.repeat(64));
    sessionStorage.setItem('kitsuflow.oauth.state', 'expected-state');
    window.history.replaceState({}, '', '/?code=oauth-code&state=wrong-state');
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await useAppStore.getState().initialize();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAppStore.getState().auth).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('не совпадает'),
    });
    expect(window.location.search).toBe('');
  });
});
