import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { useAppStore } from '../../src/state/app-store';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { apiIssue } from '../fixtures';

describe('Extended Account Isolation & Session Generation Safety', () => {
  afterEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      user: null,
      api: null,
      issues: [],
      notes: [],
      pendingIssues: [],
      repositories: [],
      tabs: [],
      outbox: [],
      sessionGeneration: 0,
    });
  });

  it('clears state on 401 unauthorized response during refreshIssues', async () => {
    const user = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    const mockApi = {
      getIssues: async () => {
        const error = new Error('Unauthorized');
        (error as any).status = 401;
        throw error;
      },
      getLabels: async () => [],
    };

    useAppStore.setState({
      user,
      api: mockApi as any,
      repositories: [
        {
          id: 1,
          installationId: 1,
          fullName: 'org/repo',
          owner: 'org',
          name: 'repo',
          private: false,
          permissions: { pull: true, push: true },
          pinned: true,
          updatedAt: new Date().toISOString(),
          accountId: '1001',
        },
      ],
    });

    await useAppStore.getState().refreshIssues('org/repo');

    const state = useAppStore.getState();
    expect(state.user).toBeNull();
    expect(state.api).toBeNull();
    expect(state.issues).toHaveLength(0);
    expect(state.error).toContain('Сессия GitHub истекла');
  });

  it('cancels stale async updates if logout occurs while request is in-flight', async () => {
    let resolveGetIssues!: (val: any) => void;
    const getIssuesPromise = new Promise((resolve) => {
      resolveGetIssues = resolve;
    });

    const mockApi = {
      getIssues: async () => {
        await getIssuesPromise;
        return [normalizeIssue('org/repo', apiIssue({ number: 99, title: 'Stale Issue' }), '1001')];
      },
    };

    const user = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    useAppStore.setState({
      user,
      api: mockApi as any,
      repositories: [
        {
          id: 1,
          installationId: 1,
          fullName: 'org/repo',
          owner: 'org',
          name: 'repo',
          private: false,
          permissions: { pull: true, push: true },
          pinned: true,
          updatedAt: new Date().toISOString(),
          accountId: '1001',
        },
      ],
    });

    const store = useAppStore.getState();

    // Start refresh in background (will pause at getIssuesPromise)
    const refreshPromise = store.refreshIssues('org/repo');

    // Logout immediately — increments sessionGeneration
    store.logout();
    expect(useAppStore.getState().user).toBeNull();

    // Now complete the stale request
    resolveGetIssues(true);
    await refreshPromise;

    // State MUST NOT be contaminated with Alice's stale issue
    const finalState = useAppStore.getState();
    expect(finalState.user).toBeNull();
    expect(finalState.issues).toHaveLength(0);
  });

  it('claimLegacyData transfers legacy-unassigned records to active user account', async () => {
    const user = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    useAppStore.setState({ user });

    // Seed DB with legacy-unassigned data
    await db.localNotes.add({
      id: 'legacy-note-1',
      title: 'Legacy Note',
      description: '',
      status: 'question',
      repositoryFullName: 'org/repo',
      localTags: [],
      checklist: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncState: 'local',
      accountId: 'legacy-unassigned',
    });

    await db.outbox.add({
      id: 'legacy-op-1',
      type: 'create_issue',
      entityKey: 'legacy-key',
      repositoryFullName: 'org/repo',
      payload: { title: 'Legacy Op' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accountId: 'legacy-unassigned',
    });

    const store = useAppStore.getState();
    await store.claimLegacyData();

    // Verify notes and outbox are now assigned to 1001
    const note = await db.localNotes.get('legacy-note-1');
    expect(note?.accountId).toBe('1001');

    const op = await db.outbox.get('legacy-op-1');
    expect(op?.accountId).toBe('1001');

    expect(useAppStore.getState().legacyClaim.hasLegacyData).toBe(false);
  });

  it('claims pending Issues and caches, normalizes tabs, then runs transferred outbox', async () => {
    const user = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    const now = new Date().toISOString();
    await db.repositoriesCache.put({
      id: 1,
      installationId: 1,
      fullName: 'org/repo',
      owner: 'org',
      name: 'repo',
      private: false,
      permissions: { pull: true, push: true },
      pinned: true,
      updatedAt: now,
      accountId: 'legacy-unassigned',
    });
    await db.pendingIssues.put({
      clientLocalId: 'legacy-pending',
      repositoryFullName: 'org/repo',
      accountId: 'legacy-unassigned',
      title: 'Claim and publish',
      body: '',
      state: 'open',
      derivedStatus: 'todo',
      derivedPriority: 'none',
      labels: [],
      assignees: [],
      createdAt: now,
      updatedAt: now,
    });
    await db.outbox.put({
      id: 'legacy-create',
      type: 'create_issue',
      entityKey: 'legacy-pending',
      repositoryFullName: 'org/repo',
      payload: { title: 'Claim and publish', clientLocalId: 'legacy-pending' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      accountId: 'legacy-unassigned',
    });
    await db.repositoryLabelsCache.put({
      repositoryFullName: 'org/repo',
      labels: [{ name: 'bug', color: 'ff0000' }],
      cachedAt: now,
      accountId: 'legacy-unassigned',
    });
    await db.repositoryAssigneesCache.put({
      repositoryFullName: 'org/repo',
      assignees: ['alice'],
      cachedAt: now,
      accountId: 'legacy-unassigned',
    });
    await db.tabs.bulkPut([
      {
        id: 'legacy-pending-tab',
        entity: {
          kind: 'pending-issue',
          repositoryFullName: 'org/repo',
          clientLocalId: 'legacy-pending',
        },
        title: 'Claim and publish',
        position: 4,
        active: true,
        accountId: 'legacy-unassigned',
      },
      {
        id: 'legacy-all-tab',
        entity: { kind: 'all' },
        title: 'Все задачи',
        position: 4,
        active: true,
        accountId: 'legacy-unassigned',
      },
    ]);
    const created = normalizeIssue(
      'org/repo',
      apiIssue({ number: 90, title: 'Claim and publish' }),
      '1001',
    );
    useAppStore.setState({
      user,
      api: {
        createIssue: async () => created,
        getIssues: async () => [created],
        getLabels: async () => [],
      } as never,
    });

    await useAppStore.getState().claimLegacyData();

    expect(await db.pendingIssues.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.githubIssuesCache.get(['1001', 'org/repo', 90])).toBeDefined();
    expect(await db.repositoryLabelsCache.get(['1001', 'org/repo'])).toBeDefined();
    expect(await db.repositoryAssigneesCache.get(['1001', 'org/repo'])).toBeDefined();
    const tabs = await db.tabs.where('accountId').equals('1001').sortBy('position');
    expect(tabs.map((tab) => tab.position)).toEqual([0, 1]);
    expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    expect(tabs.some((tab) => tab.entity.kind === 'issue')).toBe(true);
  });
});
