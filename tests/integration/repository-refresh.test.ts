import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import type { Repository } from '../../src/domain/types';
import { GitHubApi } from '../../src/github/api';
import { useAppStore } from '../../src/state/app-store';

const repository = (fullName: string, installationId: number): Repository => ({
  id: installationId,
  installationId,
  fullName,
  owner: fullName.split('/')[0] || 'acme',
  name: fullName.split('/')[1] || 'repo',
  private: false,
  permissions: { pull: true, push: true },
  pinned: true,
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
});

describe('repository refresh cache lifecycle', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      user: null,
      api: null,
      repositories: [],
      issues: [],
      pendingIssues: [],
      outbox: [],
      sessionGeneration: 0,
      error: null,
    });
  });

  it('removes repositories no longer returned after a complete refresh', async () => {
    const kept = repository('acme/kept', 7);
    const removed = repository('acme/removed', 7);
    await db.repositoriesCache.bulkPut([kept, removed]);
    const api = new GitHubApi('test-token');
    vi.spyOn(api, 'getRepositories').mockResolvedValue({
      repositories: [{ ...kept, accountId: '', pinned: false }],
      failedInstallations: [],
      installationCount: 1,
    });
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api,
      repositories: [kept, removed],
    });

    await useAppStore.getState().refreshRepositories();

    expect((await db.repositoriesCache.toArray()).map((item) => item.fullName)).toEqual([
      'acme/kept',
    ]);
    expect(useAppStore.getState().repositories.map((item) => item.fullName)).toEqual(['acme/kept']);
  });

  it('preserves cached repositories when one installation fails', async () => {
    const fresh = repository('acme/fresh', 7);
    const cachedFromFailedInstallation = repository('broken/cached', 8);
    await db.repositoriesCache.bulkPut([fresh, cachedFromFailedInstallation]);
    const api = new GitHubApi('test-token');
    vi.spyOn(api, 'getRepositories').mockResolvedValue({
      repositories: [{ ...fresh, accountId: '', pinned: false }],
      failedInstallations: [
        { installationId: 8, account: 'broken', error: new Error('temporary') },
      ],
      installationCount: 2,
    });
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api,
      repositories: [fresh, cachedFromFailedInstallation],
    });

    await useAppStore.getState().refreshRepositories();

    expect(
      useAppStore
        .getState()
        .repositories.map((item) => item.fullName)
        .sort(),
    ).toEqual(['acme/fresh', 'broken/cached']);
    expect(await db.repositoriesCache.get(['1001', 'broken/cached'])).toBeDefined();
    expect(useAppStore.getState().error).toContain('1 из 2');
  });
});
