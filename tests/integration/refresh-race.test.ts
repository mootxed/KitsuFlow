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
      repositories: [],
      api: null,
      tabs: [],
      outbox: [],
    });
  });

  it('controlled barrier race: pending create card is preserved while refresh runs concurrently', async () => {
    const barrier = createBarrier();
    let createCalled = false;

    const mockApi = {
      getIssues: async () => [
        normalizeIssue('acme/repo', apiIssue({ number: 1, title: 'Server Issue 1' })),
      ],
      getLabels: async () => [],
      createIssue: async () => {
        createCalled = true;
        await barrier.promise;
        return normalizeIssue('acme/repo', apiIssue({ number: 2, title: 'New Created Issue' }));
      },
    };

    useAppStore.setState({
      api: mockApi as any,
      repositories: [
        {
          id: 1,
          installationId: 1,
          fullName: 'acme/repo',
          owner: 'acme',
          name: 'repo',
          private: false,
          permissions: { pull: true, push: true },
          pinned: true,
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const store = useAppStore.getState();

    // 1. Start createTask (enqueues outbox and triggers outboxProcessor.process())
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

    // Wait until createIssue API is reached and waiting on barrier
    while (!createCalled) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // 2. Concurrently run refreshIssues while createIssue is paused on barrier
    const refreshPromise = store.refreshIssues('acme/repo');
    await refreshPromise;

    // Check intermediate state in store: temporary card MUST NOT be wiped by refresh!
    const intermediateIssues = useAppStore.getState().issues;
    expect(intermediateIssues.some((i) => i.title === 'New Created Issue')).toBe(true);

    // 3. Release barrier and allow createIssue to finish
    barrier.resolve();
    await createPromise;

    // 4. Final state check: no duplicates, replaced by real issue #2
    const finalIssues = useAppStore.getState().issues;
    expect(finalIssues.some((i) => i.issueNumber === 2)).toBe(true);
    expect(finalIssues.filter((i) => i.title === 'New Created Issue')).toHaveLength(1);
  });

  it('controlled barrier race: pending update fields are preserved during parallel refresh', async () => {
    const existingIssue = normalizeIssue(
      'acme/repo',
      apiIssue({ number: 5, title: 'Original Title' }),
    );
    await db.githubIssuesCache.put(existingIssue);

    const barrier = createBarrier();
    let updateCalled = false;

    const mockApi = {
      getIssues: async () => [
        normalizeIssue('acme/repo', apiIssue({ number: 5, title: 'Original Title' })),
      ],
      getLabels: async () => [],
      updateIssue: async () => {
        updateCalled = true;
        await barrier.promise;
        return normalizeIssue('acme/repo', apiIssue({ number: 5, title: 'Updated Title' }));
      },
    };

    useAppStore.setState({
      api: mockApi as any,
      issues: [existingIssue],
      repositories: [
        {
          id: 1,
          installationId: 1,
          fullName: 'acme/repo',
          owner: 'acme',
          name: 'repo',
          private: false,
          permissions: { pull: true, push: true },
          pinned: true,
          updatedAt: new Date().toISOString(),
        },
      ],
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

    // Optimistic local title MUST remain visible
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
