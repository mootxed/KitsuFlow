import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import { useAppStore, attachConnectivityListeners } from '../../src/state/app-store';
import { createLocalNote } from '../../src/domain/notes';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { OutboxProcessor } from '../../src/sync/outbox';
import { apiIssue } from '../fixtures';
import type { WorkspaceTab } from '../../src/domain/types';

describe('Pending tabs, Question drops, Assignees API, Modal reset, and Listener lifecycle', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('links pending issues with tabs via clientLocalId and updates matching tab on completion', async () => {
    const tab1: WorkspaceTab = {
      id: 'tab-pending-1',
      entity: { kind: 'pending-issue', repositoryFullName: 'org/repo', clientLocalId: 'client-1' },
      title: 'repo (создаётся...)',
      position: 0,
      active: true,
      accountId: 'user-1',
    };
    const tab2: WorkspaceTab = {
      id: 'tab-pending-2',
      entity: { kind: 'pending-issue', repositoryFullName: 'org/repo', clientLocalId: 'client-2' },
      title: 'repo (создаётся...)',
      position: 1,
      active: false,
      accountId: 'user-1',
    };

    await db.tabs.bulkPut([tab1, tab2]);

    const api = {
      createIssue: async (repo: string, input: any) => {
        const num = input.title.includes('First') ? 101 : 102;
        return normalizeIssue(repo, apiIssue({ number: num, title: input.title }), 'user-1');
      },
      updateIssue: async (repo: string, num: number) =>
        normalizeIssue(repo, apiIssue({ number: num }), 'user-1'),
      getIssues: async () => [],
    };

    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => 'user-1',
      onEvent: () => undefined,
    });

    await processor.enqueue({
      type: 'create_issue',
      entityKey: 'client-1',
      repositoryFullName: 'org/repo',
      payload: { title: 'First Issue', clientLocalId: 'client-1' },
      accountId: 'user-1',
    });

    await processor.process();

    const updatedTab1 = await db.tabs.get('tab-pending-1');
    const updatedTab2 = await db.tabs.get('tab-pending-2');

    expect(updatedTab1?.entity).toEqual({
      kind: 'issue',
      repositoryFullName: 'org/repo',
      issueNumber: 101,
    });
    expect(updatedTab2?.entity).toEqual({
      kind: 'pending-issue',
      repositoryFullName: 'org/repo',
      clientLocalId: 'client-2',
    });

    processor.destroy();
  });

  it('dropping local note onto question status stays a local note without outbox or GitHub API call', async () => {
    const user = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    useAppStore.setState({ user });

    const note = createLocalNote({
      title: 'Drop to question note',
      status: 'todo',
      repositoryFullName: null,
    });
    await db.localNotes.add(note);
    useAppStore.setState({ notes: [note] });

    await useAppStore.getState().updateNote(note.id, {
      repositoryFullName: 'org/repo',
      status: 'question',
    });

    const updated = await db.localNotes.get(note.id);
    expect(updated?.repositoryFullName).toBe('org/repo');
    expect(updated?.status).toBe('question');
    expect(updated?.accountId).toBe('1001');

    expect(await db.outbox.count()).toBe(0);
  });

  it('getRepositoryAssignees fetches from api.getAssignees endpoint and caches by accountId', async () => {
    const user = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    const mockApi = {
      getAssignees: async () => ['charlie', 'dave'],
    };

    useAppStore.setState({ user, api: mockApi as any, online: true });

    const assignees = await useAppStore.getState().getRepositoryAssignees('org/repo');
    expect(assignees).toEqual(['charlie', 'dave']);

    const cached = await db.repositoryAssigneesCache.get(['1001', 'org/repo']);
    expect(cached?.assignees).toEqual(['charlie', 'dave']);
  });

  it('attachConnectivityListeners attaches event listeners safely without duplicate triggers', () => {
    const onlineSpy = vi.spyOn(window, 'addEventListener');
    attachConnectivityListeners();
    attachConnectivityListeners();

    const onlineCalls = onlineSpy.mock.calls.filter((call) => call[0] === 'online');
    expect(onlineCalls.length).toBe(1);
  });
});
