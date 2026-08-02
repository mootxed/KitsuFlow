import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { createLocalNote } from '../../src/domain/notes';
import type { OutboxOperation, PendingIssue } from '../../src/domain/types';
import { useAppStore } from '../../src/state/app-store';
import { apiIssue } from '../fixtures';

const now = '2026-08-01T00:00:00Z';
const pending: PendingIssue = {
  clientLocalId: 'pending-action',
  repositoryFullName: 'acme/repo',
  accountId: '1001',
  title: 'Invalid title',
  body: 'old body',
  state: 'open',
  derivedStatus: 'todo',
  derivedPriority: 'none',
  labels: [],
  assignees: [],
  createdAt: now,
  updatedAt: now,
};
const operation: OutboxOperation = {
  id: 'pending-operation',
  type: 'create_issue',
  entityKey: pending.clientLocalId,
  repositoryFullName: pending.repositoryFullName,
  payload: { title: pending.title, body: pending.body, clientLocalId: pending.clientLocalId },
  state: 'attention',
  requestStarted: true,
  attemptCount: 1,
  lastError: '422 validation failed',
  createdAt: now,
  updatedAt: now,
  accountId: '1001',
};

describe('pending actions and note conversion lifecycle', () => {
  afterEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      user: null,
      api: null,
      issues: [],
      pendingIssues: [],
      notes: [],
      repositories: [],
      tabs: [],
      outbox: [],
      selectedTask: null,
    });
  });

  it('updates a 422 payload in-place and returns the same operation to pending', async () => {
    await db.pendingIssues.put(pending);
    await db.outbox.put(operation);
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      pendingIssues: [pending],
      outbox: [operation],
    });

    await useAppStore.getState().updatePendingOperation(pending.clientLocalId, {
      title: 'Valid title',
      body: 'new body',
      labels: ['bug'],
    });

    expect(await db.pendingIssues.get(pending.clientLocalId)).toMatchObject({
      title: 'Valid title',
      body: 'new body',
    });
    expect(await db.outbox.get(operation.id)).toMatchObject({
      id: operation.id,
      state: 'pending',
      attemptCount: 0,
      payload: { title: 'Valid title', body: 'new body', labels: ['bug'] },
    });
  });

  it('atomically cancels a pending card, operation, selected task and tab', async () => {
    await db.pendingIssues.put(pending);
    await db.outbox.put(operation);
    await db.tabs.put({
      id: 'pending-tab',
      entity: {
        kind: 'pending-issue',
        repositoryFullName: pending.repositoryFullName,
        clientLocalId: pending.clientLocalId,
      },
      title: pending.title,
      position: 0,
      active: true,
      accountId: '1001',
    });
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      pendingIssues: [pending],
      outbox: [operation],
      selectedTask: { kind: 'pending-issue', clientLocalId: pending.clientLocalId },
    });

    await useAppStore.getState().cancelPendingOperation(pending.clientLocalId);

    expect(await db.pendingIssues.get(pending.clientLocalId)).toBeUndefined();
    expect(await db.outbox.get(operation.id)).toBeUndefined();
    expect(useAppStore.getState().selectedTask).toBeNull();
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useAppStore.getState().tabs[0]?.entity).toEqual({ kind: 'all' });
  });

  it('does not retry an ambiguous POST until the explicit confirmation path is used', async () => {
    let createCalls = 0;
    const ambiguous = { ...operation, ambiguityRisk: true };
    await db.pendingIssues.put(pending);
    await db.outbox.put(ambiguous);
    const created = normalizeIssue(
      'acme/repo',
      apiIssue({ number: 66, title: pending.title }),
      '1001',
    );
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api: {
        createIssue: async () => {
          createCalls += 1;
          return created;
        },
      } as never,
      pendingIssues: [pending],
      outbox: [ambiguous],
    });

    await useAppStore.getState().retryOperation(ambiguous.id);
    expect(createCalls).toBe(0);
    expect(await db.outbox.get(ambiguous.id)).toMatchObject({
      state: 'attention',
      ambiguityRisk: true,
    });

    await useAppStore.getState().retryAmbiguousOperation(ambiguous.id);
    expect(createCalls).toBe(1);
    expect(await db.outbox.get(ambiguous.id)).toBeUndefined();
    expect(await db.pendingIssues.get(pending.clientLocalId)).toBeUndefined();
  });

  it('replaces an open local-note tab and selected panel with the real Issue', async () => {
    const note = createLocalNote({
      title: 'Convert opened note',
      status: 'question',
      repositoryFullName: 'acme/repo',
    });
    note.accountId = '1001';
    await db.localNotes.put(note);
    const tab = {
      id: 'note-tab',
      entity: { kind: 'local-note' as const, id: note.id },
      title: note.title,
      position: 0,
      active: true,
      accountId: '1001',
    };
    await db.tabs.put(tab);
    const created = normalizeIssue(
      'acme/repo',
      apiIssue({ number: 77, title: note.title }),
      '1001',
    );
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api: { createIssue: async () => created } as never,
      notes: [note],
      tabs: [tab],
      selectedTask: { kind: 'note', id: note.id },
      conversionDialog: { noteId: note.id },
    });

    await useAppStore.getState().confirmConversion({
      repositoryFullName: 'acme/repo',
      status: 'todo',
      priority: 'none',
      labels: [],
      assignees: [],
    });

    expect(await db.localNotes.get(note.id)).toBeUndefined();
    expect(useAppStore.getState().selectedTask).toEqual({
      kind: 'issue',
      key: 'acme/repo#77',
    });
    expect(useAppStore.getState().tabs[0]?.entity).toEqual({
      kind: 'issue',
      repositoryFullName: 'acme/repo',
      issueNumber: 77,
    });
  });
});
