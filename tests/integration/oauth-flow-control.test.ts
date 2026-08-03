import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import { GitHubApi } from '../../src/github/api';
import { useAppStore } from '../../src/state/app-store';

describe('OAuth Flow Control & Race Conditions', () => {
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

  it('cancelAuthFlow resets transient auth phase without clearing existing user session', () => {
    useAppStore.setState({
      user: { id: 777, login: 'existing-user', name: 'Existing', avatarUrl: '' },
      auth: {
        phase: 'waiting',
        userCode: 'CODE-123',
        verificationUri: 'https://github.com/login/device',
        expiresAt: Date.now() + 900_000,
        interval: 5,
      },
    });

    useAppStore.getState().cancelAuthFlow();

    const state = useAppStore.getState();
    expect(state.auth.phase).toBe('idle');
    expect(state.user?.id).toBe(777);
  });

  it('dismissAuthModal closes modal without clearing user or session tokens', () => {
    sessionStorage.setItem(
      'kitsuflow.github.access-token',
      JSON.stringify({ accessToken: 'valid-token' }),
    );
    useAppStore.setState({
      user: { id: 888, login: 'user888', name: 'User 888', avatarUrl: '' },
      auth: { phase: 'success' },
    });

    useAppStore.getState().dismissAuthModal();

    const state = useAppStore.getState();
    expect(state.auth.phase).toBe('idle');
    expect(state.user?.id).toBe(888);
    expect(sessionStorage.getItem('kitsuflow.github.access-token')).toContain('valid-token');
  });

  it('logout explicitly clears user, API client, and sessionStorage tokens', () => {
    sessionStorage.setItem(
      'kitsuflow.github.access-token',
      JSON.stringify({ accessToken: 'valid-token' }),
    );
    useAppStore.setState({
      user: { id: 999, login: 'user999', name: 'User 999', avatarUrl: '' },
      api: new GitHubApi('valid-token'),
      auth: { phase: 'idle' },
    });

    useAppStore.getState().logout();

    const state = useAppStore.getState();
    expect(state.user).toBeNull();
    expect(state.api).toBeNull();
    expect(state.auth.phase).toBe('idle');
    expect(sessionStorage.getItem('kitsuflow.github.access-token')).toBeNull();
  });

  it('handles race condition: modal dismissed while /user is pending, session completes successfully', async () => {
    vi.stubEnv('VITE_OAUTH_PROXY_URL', 'https://oauth-proxy.test/exchange');
    sessionStorage.setItem('kitsuflow.oauth.verifier', 'v'.repeat(64));
    sessionStorage.setItem('kitsuflow.oauth.state', 'race-state');
    window.history.replaceState({}, '', '/?code=race-code&state=race-state');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'race-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    let resolveUser: (value: {
      id: number;
      login: string;
      name: string;
      avatarUrl: string;
    }) => void;
    const userPromise = new Promise<{ id: number; login: string; name: string; avatarUrl: string }>(
      (resolve) => {
        resolveUser = resolve;
      },
    );

    vi.spyOn(GitHubApi.prototype, 'getCurrentUser').mockImplementation(() => userPromise);
    vi.spyOn(GitHubApi.prototype, 'getRepositories').mockResolvedValue({
      repositories: [],
      failedInstallations: [],
      installationCount: 0,
    });

    const initPromise = useAppStore.getState().initialize();

    // While initialize / user fetch is pending, user closes modal
    useAppStore.getState().dismissAuthModal();
    expect(useAppStore.getState().auth.phase).toBe('idle');

    // Resolve /user
    resolveUser!({ id: 1234, login: 'race-user', name: 'Race User', avatarUrl: '' });
    await initPromise;

    const state = useAppStore.getState();
    expect(state.user?.id).toBe(1234);
    expect(state.auth.phase).toBe('idle');
    expect(sessionStorage.getItem('kitsuflow.github.access-token')).toContain('race-token');
  });
});
