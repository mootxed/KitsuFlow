import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { useAppStore } from '../../src/state/app-store';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { apiIssue } from '../fixtures';

describe('Independent Per-Repository Refresh Error Isolation', () => {
  afterEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      user: null,
      api: null,
      issues: [],
      notes: [],
      repositories: [],
      tabs: [],
      outbox: [],
    });
  });

  it('continues refreshing repo2 even if repo1 fails with a 404 or 403 error', async () => {
    const user = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };

    const repo1 = {
      id: 1,
      installationId: 1,
      fullName: 'org/repo1',
      owner: 'org',
      name: 'repo1',
      private: false,
      permissions: { pull: true, push: true },
      pinned: true,
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    };

    const repo2 = {
      id: 2,
      installationId: 1,
      fullName: 'org/repo2',
      owner: 'org',
      name: 'repo2',
      private: false,
      permissions: { pull: true, push: true },
      pinned: true,
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    };

    await db.repositoriesCache.bulkPut([repo1, repo2]);

    const mockApi = {
      getIssues: async (repoFullName: string) => {
        if (repoFullName === 'org/repo1') {
          const err = Object.assign(new Error('Not Found'), { status: 404 });
          throw err;
        }
        return [
          normalizeIssue('org/repo2', apiIssue({ number: 42, title: 'Repo 2 Issue' }), '1001'),
        ];
      },
      getLabels: async () => [],
    };

    useAppStore.setState({
      user,
      api: mockApi as any,
      repositories: [repo1, repo2],
    });

    // Refresh all pinned repos
    await useAppStore.getState().refreshIssues();

    const state = useAppStore.getState();

    // Repo 2 issues SHOULD be loaded into store despite Repo 1 failing
    expect(
      state.issues.some((i) => i.repositoryFullName === 'org/repo2' && i.issueNumber === 42),
    ).toBe(true);

    // Error state should contain reference to repo1 failure
    expect(state.error).toContain('org/repo1');
    expect(state.stale).toBe(true);
  });

  it('stops remaining repositories on a global rate limit', async () => {
    const calls: string[] = [];
    const repositories = ['org/limited', 'org/not-called'].map((fullName, index) => ({
      id: index + 1,
      installationId: 1,
      fullName,
      owner: 'org',
      name: fullName.split('/')[1]!,
      private: false,
      permissions: { pull: true, push: true },
      pinned: true,
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    }));
    const api = {
      getIssues: async (repositoryFullName: string) => {
        calls.push(repositoryFullName);
        throw Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: {
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
            },
            data: { message: 'API rate limit exceeded' },
          },
        });
      },
      getLabels: async () => [],
    };
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api: api as never,
      repositories,
    });

    await useAppStore.getState().refreshIssues();

    expect(calls).toEqual(['org/limited']);
    expect(useAppStore.getState().rateLimitUntil).not.toBeNull();
    expect(useAppStore.getState().error).toContain('глобальный лимит');
    expect(useAppStore.getState().error).not.toContain('org/not-called');
  });
});
