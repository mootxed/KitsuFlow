import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import { useAppStore } from '../../src/state/app-store';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { apiIssue } from '../fixtures';

function createBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Outbox and Refresh Issues Controlled Race Barriers', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      issues: [],
      notes: [],
      pendingIssues: [],
      repositories: [],
      api: null,
      tabs: [],
      outbox: [],
    });
  });

  it('controlled barrier race: pending create card is stored in pendingIssues (not issues) while API is in-flight', async () => {
    const barrier = createBarrier();
    let createCalled = false;

    const repo = {
      id: 1,
      installationId: 1,
      fullName: 'acme/repo',
      owner: 'acme',
      name: 'repo',
      private: false,
      permissions: { pull: true, push: true },
      pinned: true,
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    };
    await db.repositoriesCache.put(repo);

    const mockApi = {
      getIssues: async () => [
        normalizeIssue('acme/repo', apiIssue({ number: 1, title: 'Server Issue 1' }), '1001'),
      ],
      getLabels: async () => [],
      createIssue: async () => {
        createCalled = true;
        await barrier.promise;
        return normalizeIssue('acme/repo', apiIssue({ number: 2, title: 'New Created Issue' }), '1001');
      },
    };

    const user = { id: 1001, login: 'acme', name: 'ACME', avatarUrl: '' };
    useAppStore.setState({
      user,
      api: mockApi as any,
      repositories: [repo],
    });

    const store = useAppStore.getState();

    // 1. createTask enqueues outbox + puts in pendingIssues, then triggers outboxProcessor
    const createPromise = store.createTask({
      title: 'New Created Issue',
      description: 'Test body',
      status: 'todo',
      repositoryFullName: 'acme/repo',
      tags: [],
      checklist: [],
      priority: 'none',
      assignees: [],
    });

    // Wait until createIssue API is reached and paused at barrier
    while (!createCalled) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // 2. Concurrently run refreshIssues while createIssue is paused on barrier
    const refreshPromise = store.refreshIssues('acme/repo');
    await refreshPromise;

    // Check intermediate state:
    // - Pending card is now in pendingIssues, NOT in issues
    const intermediateState = useAppStore.getState();
    expect(
      intermediateState.pendingIssues.some((p) => p.title === 'New Created Issue'),
      'pending card must be in pendingIssues while API is in-flight',
    ).toBe(true);
    // - The real server issue is loaded
    expect(
      intermediateState.issues.some((i) => i.title === 'Server Issue 1'),
      'real server issue must be loaded by refresh',
    ).toBe(true);

    // 3. Release barrier
    barrier.resolve();
    await createPromise;

    // 4. Final state: pending card gone, real issue #2 visible in issues
    const finalState = useAppStore.getState();
    expect(finalState.issues.some((i) => i.issueNumber === 2)).toBe(true);
    expect(finalState.pendingIssues.some((p) => p.title === 'New Created Issue')).toBe(false);
    expect(finalState.issues.filter((i) => i.title === 'New Created Issue')).toHaveLength(1);
  });

  it('controlled barrier race: pending update fields are preserved during parallel refresh', async () => {
    const repo = {
      id: 1,
      installationId: 1,
      fullName: 'acme/repo',
      owner: 'acme',
      name: 'repo',
      private: false,
      permissions: { pull: true, push: true },
      pinned: true,
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    };
    await db.repositoriesCache.put(repo);

    const user = { id: 1001, login: 'acme', name: 'ACME', avatarUrl: '' };
    const existingIssue = {
      ...normalizeIssue('acme/repo', apiIssue({ number: 5, title: 'Original Title' }), '1001'),
      accountId: '1001',
    };
    await db.githubIssuesCache.put(existingIssue);

    const barrier = createBarrier();
    let updateCalled = false;

    const mockApi = {
      getIssues: async () => [
        normalizeIssue('acme/repo', apiIssue({ number: 5, title: 'Original Title' }), '1001'),
      ],
      getLabels: async () => [],
      updateIssue: async () => {
        updateCalled = true;
        await barrier.promise;
        return normalizeIssue('acme/repo', apiIssue({ number: 5, title: 'Updated Title' }), '1001');
      },
    };

    useAppStore.setState({
      user,
      api: mockApi as any,
      issues: [existingIssue],
      repositories: [repo],
    });

    const store = useAppStore.getState();

    const updatePromise = store.updateIssueFields(existingIssue, {
      title: 'Updated Title',
      body: 'Updated body',
    });

    while (!updateCalled) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Run refresh while update is pending at barrier
    await store.refreshIssues('acme/repo');

    // Optimistic local title MUST remain visible (pending outbox op protects it)
    expect(useAppStore.getState().issues.find((i) => i.issueNumber === 5)?.title).toBe(
      'Updated Title',
    );

    barrier.resolve();
    await updatePromise;

    expect(useAppStore.getState().issues.find((i) => i.issueNumber === 5)?.title).toBe(
      'Updated Title',
    );
  });
});
