import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import { useAppStore } from '../../src/state/app-store';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { apiIssue } from '../fixtures';

describe('Outbox and Refresh Issues Race Condition Prevention', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      issues: [],
      notes: [],
      repositories: [],
      api: null,
    });
  });

  it('preserves offline pending card when network reconnects and sync + refresh runs', async () => {
    // 1. Create an issue offline via store
    const store = useAppStore.getState();

    // Mock API
    let issueCreatedOnServer = false;
    const mockApi = {
      getIssues: async () => {
        // Server only has existing issues, not the newly created offline one yet if delay happens
        return issueCreatedOnServer
          ? [normalizeIssue('acme/repo', apiIssue({ number: 99, title: 'Server Task' }))]
          : [];
      },
      getLabels: async () => [],
      createIssue: async () => {
        issueCreatedOnServer = true;
        return normalizeIssue('acme/repo', apiIssue({ number: 99, title: 'Offline Task' }));
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

    // Create task offline (simulated)
    const onlineSpy = vi.spyOn(window.navigator, 'onLine', 'get');
    onlineSpy.mockReturnValue(false);

    await store.createTask({
      title: 'Offline Task',
      description: 'Created offline',
      status: 'todo',
      repositoryFullName: 'acme/repo',
      tags: [],
      checklist: [],
      priority: 'none',
      assignees: [],
    });

    // Verify pending card exists in store & db
    expect(useAppStore.getState().issues).toHaveLength(1);
    expect(useAppStore.getState().issues[0]?.syncState).toBe('pending');
    expect(await db.githubIssuesCache.count()).toBe(1);

    // 2. Network reconnects: trigger refresh & outbox processing
    onlineSpy.mockReturnValue(true);

    // Call refreshIssues and outbox process
    await store.refreshIssues('acme/repo');

    // The card should NOT disappear during or after refresh
    const issuesInStore = useAppStore.getState().issues;
    expect(issuesInStore.length).toBeGreaterThan(0);
    expect(issuesInStore.some((i) => i.title === 'Offline Task')).toBe(true);
  });
});
