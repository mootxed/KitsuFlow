import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { useAppStore } from '../../src/state/app-store';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { apiIssue } from '../fixtures';
import type { OutboxOperation } from '../../src/domain/types';

describe('GitHub multi-account data isolation & compound keys', () => {
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

  it('isolates Alice and Bob accessing the same org/shared repo with Issue #1', async () => {
    const aliceUser = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    const bobUser = { id: 2002, login: 'bob', name: 'Bob', avatarUrl: '' };

    const issueAlice = {
      ...normalizeIssue('org/shared', apiIssue({ number: 1, title: 'Alice Version of Issue #1' })),
      accountId: '1001',
    };

    const issueBob = {
      ...normalizeIssue('org/shared', apiIssue({ number: 1, title: 'Bob Version of Issue #1' })),
      accountId: '2002',
    };

    // Both objects exist concurrently in IndexedDB
    await db.githubIssuesCache.put(issueAlice);
    await db.githubIssuesCache.put(issueBob);

    expect(await db.githubIssuesCache.count()).toBe(2);

    await db.repositoriesCache.bulkPut([
      {
        id: 1,
        installationId: 1,
        fullName: 'org/shared',
        owner: 'org',
        name: 'shared',
        private: true,
        permissions: { pull: true, push: true },
        pinned: true,
        updatedAt: new Date().toISOString(),
        accountId: '1001',
      },
      {
        id: 1,
        installationId: 2,
        fullName: 'org/shared',
        owner: 'org',
        name: 'shared',
        private: true,
        permissions: { pull: true, push: true },
        pinned: true,
        updatedAt: new Date().toISOString(),
        accountId: '2002',
      },
    ]);

    await db.repositoryLabelsCache.bulkPut([
      {
        repositoryFullName: 'org/shared',
        labels: [{ name: 'alice-label', color: 'ff0000' }],
        cachedAt: new Date().toISOString(),
        accountId: '1001',
      },
      {
        repositoryFullName: 'org/shared',
        labels: [{ name: 'bob-label', color: '00ff00' }],
        cachedAt: new Date().toISOString(),
        accountId: '2002',
      },
    ]);

    await db.repositoryAssigneesCache.bulkPut([
      {
        repositoryFullName: 'org/shared',
        assignees: ['alice'],
        cachedAt: new Date().toISOString(),
        accountId: '1001',
      },
      {
        repositoryFullName: 'org/shared',
        assignees: ['bob'],
        cachedAt: new Date().toISOString(),
        accountId: '2002',
      },
    ]);

    const opAlice: OutboxOperation = {
      id: 'op-alice-1',
      type: 'update_issue',
      entityKey: 'org/shared#1',
      repositoryFullName: 'org/shared',
      payload: { issueNumber: 1, title: 'Alice update' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    };

    await db.outbox.add(opAlice);

    // 1. Without active user: NO private version visible
    useAppStore.setState({ user: null });
    await useAppStore.getState().initialize();
    expect(useAppStore.getState().issues).toHaveLength(0);
    expect(useAppStore.getState().repositories).toHaveLength(0);

    // 2. Login Alice (1001): ONLY Alice version is visible
    useAppStore.setState({ user: aliceUser });
    await useAppStore.getState().initialize();

    const aliceIssues = useAppStore.getState().issues;
    expect(aliceIssues).toHaveLength(1);
    expect(aliceIssues[0]?.title).toBe('Alice Version of Issue #1');
    expect(await useAppStore.getState().getRepositoryLabels('org/shared')).toEqual([
      { name: 'alice-label', color: 'ff0000' },
    ]);
    expect(await useAppStore.getState().getRepositoryAssignees('org/shared')).toEqual(['alice']);

    // 3. Logout & reload: Private data disappears
    useAppStore.getState().logout();
    expect(useAppStore.getState().issues).toHaveLength(0);

    // 4. Login Bob (2002): ONLY Bob version is visible
    useAppStore.setState({ user: bobUser });
    await useAppStore.getState().initialize();

    const bobIssues = useAppStore.getState().issues;
    expect(bobIssues).toHaveLength(1);
    expect(bobIssues[0]?.title).toBe('Bob Version of Issue #1');
    expect(await useAppStore.getState().getRepositoryLabels('org/shared')).toEqual([
      { name: 'bob-label', color: '00ff00' },
    ]);
    expect(await useAppStore.getState().getRepositoryAssignees('org/shared')).toEqual(['bob']);
  });
});
