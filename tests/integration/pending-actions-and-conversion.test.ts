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

  it('blocks GitHub writes for a read-only repository before creating outbox work', async () => {
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      repositories: [
        {
          id: 1,
          installationId: 7,
          fullName: 'acme/read-only',
          owner: 'acme',
          name: 'read-only',
          private: false,
          permissions: { pull: true, push: false },
          pinned: true,
          updatedAt: now,
          accountId: '1001',
        },
      ],
    });

    await useAppStore.getState().createTask({
      title: 'Must not enqueue',
      description: '',
      status: 'todo',
      repositoryFullName: 'acme/read-only',
      tags: [],
      checklist: [],
      priority: 'none',
      assignees: [],
    });

    expect(await db.outbox.count()).toBe(0);
    expect(await db.pendingIssues.count()).toBe(0);
    expect(useAppStore.getState().error).toContain('только для чтения');
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

  it('updates pending repository tabs and rebuilds system labels from status/priority', async () => {
    const ambiguous = {
      ...operation,
      ambiguityRisk: true,
      payload: {
        ...operation.payload,
        labels: ['bug', 'kf:status:todo', 'kf:priority:none'],
      },
    };
    const withLabels = {
      ...pending,
      labels: [
        { name: 'bug', color: 'ff0000' },
        { name: 'kf:status:todo', color: '000000' },
        { name: 'kf:priority:none', color: '000000' },
      ],
    };
    await db.pendingIssues.put(withLabels);
    await db.outbox.put(ambiguous);
    await db.tabs.put({
      id: 'pending-tab-update',
      entity: {
        kind: 'pending-issue',
        repositoryFullName: 'acme/repo',
        clientLocalId: pending.clientLocalId,
      },
      title: pending.title,
      position: 0,
      active: true,
      accountId: '1001',
    });
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      repositories: [
        {
          id: 2,
          installationId: 1,
          fullName: 'acme/next',
          owner: 'acme',
          name: 'next',
          private: false,
          permissions: { pull: true, push: true },
          pinned: true,
          updatedAt: now,
          accountId: '1001',
        },
      ],
      pendingIssues: [withLabels],
      outbox: [ambiguous],
    });

    await useAppStore.getState().updatePendingOperation(pending.clientLocalId, {
      title: 'Moved pending',
      repositoryFullName: 'acme/next',
      labels: ['bug'],
      status: 'in_progress',
      priority: 'urgent',
    });

    expect(await db.pendingIssues.get(pending.clientLocalId)).toMatchObject({
      repositoryFullName: 'acme/next',
      title: 'Moved pending',
      derivedStatus: 'in_progress',
      derivedPriority: 'urgent',
    });
    expect((await db.outbox.get(operation.id))?.payload.labels).toEqual([
      'bug',
      'kf:status:in-progress',
      'kf:priority:urgent',
    ]);
    expect((await db.tabs.get('pending-tab-update'))?.entity).toEqual({
      kind: 'pending-issue',
      repositoryFullName: 'acme/next',
      clientLocalId: pending.clientLocalId,
    });
    expect((await db.tabs.get('pending-tab-update'))?.title).toBe('Moved pending');
  });

  it('cancels every outbox candidate linked to an ambiguous migration group', async () => {
    const migrationGroupId = 'migration-group';
    const groupedPending = { ...pending, migrationGroupId, needsAttention: true };
    const candidates = ['candidate-a', 'candidate-b'].map((id) => ({
      ...operation,
      id,
      entityKey: id,
      migrationGroupId,
      ambiguityRisk: true,
    }));
    await db.pendingIssues.put(groupedPending);
    await db.outbox.bulkPut(candidates);
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      pendingIssues: [groupedPending],
      outbox: candidates,
    });

    await useAppStore.getState().cancelPendingOperation(groupedPending.clientLocalId);

    expect(await db.pendingIssues.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
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
      repositories: [
        {
          id: 1,
          installationId: 1,
          fullName: 'acme/repo',
          name: 'repo',
          owner: 'acme',
          private: false,
          permissions: { pull: true, push: true },
          pinned: true,
          updatedAt: now,
          accountId: '1001',
        },
      ],
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

  it('double confirmConversion creates only one convert_note outbox entry', async () => {
    const note = createLocalNote({
      title: 'Convert me',
      description: '',
      status: 'question',
      repositoryFullName: 'acme/repo',
      localTags: [],
      checklist: [],
    });
    note.id = 'note-double-convert';
    note.accountId = '1001';
    await db.localNotes.put(note);
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api: {} as never,
      notes: [note],
      repositories: [
        {
          id: 1,
          installationId: 7,
          fullName: 'acme/repo',
          owner: 'acme',
          name: 'repo',
          private: false,
          permissions: { pull: true, push: true },
          pinned: true,
          updatedAt: now,
          accountId: '1001',
        },
      ],
      conversionDialog: { noteId: note.id },
    });

    const draft = {
      repositoryFullName: 'acme/repo',
      status: 'todo' as const,
      priority: 'none' as const,
      labels: [],
      assignees: [],
    };
    // Первый вызов
    await useAppStore.getState().confirmConversion(draft);
    // Сбрасываем диалог и вызываем снова
    useAppStore.setState({ conversionDialog: { noteId: note.id } });
    await useAppStore.getState().confirmConversion(draft);

    const ops = await db.outbox.where('entityKey').equals(note.id).toArray();
    const activeOps = ops.filter((op) => op.type === 'convert_note');
    expect(activeOps).toHaveLength(1);
  });

  it('deleteNote deletes the associated pending convert_note operation', async () => {
    const note = createLocalNote({
      title: 'Will be deleted',
      description: '',
      status: 'question',
      repositoryFullName: 'acme/repo',
      localTags: [],
      checklist: [],
    });
    note.id = 'note-to-delete';
    note.accountId = '1001';
    note.syncState = 'pending';
    await db.localNotes.put(note);
    const convertOp: OutboxOperation = {
      id: 'convert-op-to-cancel',
      type: 'convert_note',
      entityKey: note.id,
      sourceNoteId: note.id,
      repositoryFullName: 'acme/repo',
      payload: { title: note.title, body: '', labels: [], assignees: [], state: 'open' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      accountId: '1001',
    };
    await db.outbox.put(convertOp);
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api: {} as never,
      notes: [note],
      outbox: [convertOp],
      repositories: [],
    });

    await useAppStore.getState().deleteNote(note.id);

    expect(await db.localNotes.get(note.id)).toBeUndefined();
    const deletedOp = await db.outbox.get('convert-op-to-cancel');
    expect(deletedOp).toBeUndefined();
  });

  it('updateNote ignores updates while note is pending conversion', async () => {
    const note = createLocalNote({
      title: 'Original title',
      description: 'Original body',
      status: 'question',
      repositoryFullName: 'acme/repo',
      localTags: [],
      checklist: [],
    });
    note.id = 'note-to-update';
    note.accountId = '1001';
    note.syncState = 'pending';
    await db.localNotes.put(note);
    const convertOp: OutboxOperation = {
      id: 'convert-op-to-update',
      type: 'convert_note',
      entityKey: note.id,
      sourceNoteId: note.id,
      repositoryFullName: 'acme/repo',
      payload: {
        title: 'Original title',
        body: 'Original body',
        labels: [],
        assignees: [],
        state: 'open',
      },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      accountId: '1001',
    };
    await db.outbox.put(convertOp);
    useAppStore.setState({
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
      api: {} as never,
      notes: [note],
      outbox: [convertOp],
      repositories: [],
    });

    await useAppStore.getState().updateNote(note.id, { title: 'Updated title' });

    const updatedOp = await db.outbox.get('convert-op-to-update');
    expect(updatedOp?.payload.title).toBe('Original title');
  });
});
