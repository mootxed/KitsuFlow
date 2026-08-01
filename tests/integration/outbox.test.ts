import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import { createLocalNote } from '../../src/domain/notes';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { OutboxProcessor } from '../../src/sync/outbox';
import { apiIssue } from '../fixtures';

describe('outbox durability & error handling', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(db.tables.map((table) => table.clear()));
  });

  it('keeps the source note when issue creation is ambiguous', async () => {
    const note = createLocalNote({
      title: 'Do not lose',
      status: 'question',
      repositoryFullName: 'acme/repo',
    });
    note.accountId = '1001';
    await db.localNotes.add(note);
    const api = {
      createIssue: async () => {
        throw new TypeError('network');
      },
    };
    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });
    await processor.enqueue({
      type: 'convert_note',
      entityKey: note.id,
      repositoryFullName: 'acme/repo',
      sourceNoteId: note.id,
      payload: { title: note.title, body: '', labels: [], assignees: [] },
      accountId: '1001',
    });
    await processor.process();
    expect(await db.localNotes.get(note.id)).toBeDefined();
    expect((await db.outbox.toArray())[0]?.state).toBe('attention');
    processor.destroy();
  });

  it('deletes the source note only after confirmed issue creation', async () => {
    const note = createLocalNote({
      title: 'Publish',
      status: 'question',
      repositoryFullName: 'acme/repo',
    });
    note.accountId = '1001';
    await db.localNotes.add(note);
    const api = {
      createIssue: async () => normalizeIssue('acme/repo', apiIssue(), '1001'),
      updateIssue: async () => normalizeIssue('acme/repo', apiIssue(), '1001'),
      getIssues: async () => [normalizeIssue('acme/repo', apiIssue(), '1001')],
    };
    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });
    await processor.enqueue({
      type: 'convert_note',
      entityKey: note.id,
      repositoryFullName: 'acme/repo',
      sourceNoteId: note.id,
      payload: { title: note.title, body: '', labels: [], assignees: [] },
      accountId: '1001',
    });
    await processor.process();
    expect(await db.localNotes.get(note.id)).toBeUndefined();
    expect(await db.githubIssuesCache.count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    processor.destroy();
  });

  it('filters outbox operations strictly by active account ID', async () => {
    let currentAccount: string | null = 'user-A';
    const executed: string[] = [];

    const api = {
      updateIssue: async (repo: string, num: number) => {
        executed.push(`issue-${num}`);
        return normalizeIssue(repo, apiIssue({ number: num }), currentAccount!);
      },
    };

    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => currentAccount,
      onEvent: () => undefined,
    });

    await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#1',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 1, title: 'Op A' },
      accountId: 'user-A',
    });

    await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#2',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 2, title: 'Op B' },
      accountId: 'user-B',
    });

    // Process under user-A
    await processor.process();
    expect(executed).toEqual(['issue-1']);

    // Switch to user-B
    currentAccount = 'user-B';
    await processor.process();
    expect(executed).toEqual(['issue-1', 'issue-2']);

    processor.destroy();
  });

  it('manual retry resets attemptCount so subsequent failure yields attemptCount=1 and state=failed', async () => {
    const api = {
      updateIssue: async () => {
        throw new Error('API temporary error');
      },
    };
    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });

    const op = await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#3',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 3, title: 'Retry test' },
      accountId: '1001',
    });

    // Simulate exhausted operation after 4 attempts
    await db.outbox.update(op.id, {
      state: 'exhausted',
      attemptCount: 4,
      lastError: 'Failed max times',
    });

    // User clicks retry
    await processor.retry(op.id);

    const updatedOp = await db.outbox.get(op.id);
    expect(updatedOp?.attemptCount).toBe(1);
    expect(updatedOp?.state).toBe('failed');
    expect(updatedOp?.state).not.toBe('exhausted');

    processor.destroy();
  });

  it('recovers safely on applying_final_state stage during restart', async () => {
    let postCalls = 0;
    let patchCalls = 0;

    const api = {
      createIssue: async () => {
        postCalls++;
        return normalizeIssue('acme/repo', apiIssue({ number: 88 }), '1001');
      },
      updateIssue: async () => {
        patchCalls++;
        return normalizeIssue('acme/repo', apiIssue({ number: 88, state: 'closed' }), '1001');
      },
      getIssues: async () => [normalizeIssue('acme/repo', apiIssue({ number: 88 }), '1001')],
    };

    await db.outbox.add({
      id: 'op-staged-recovery',
      type: 'create_issue',
      entityKey: 'client-temp-stage',
      repositoryFullName: 'acme/repo',
      payload: { title: 'Applying state test', state: 'closed' },
      state: 'syncing',
      requestStarted: true,
      attemptCount: 1,
      creationStage: 'applying_final_state',
      createdIssueNumber: 88,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    });

    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });

    await processor.process();

    expect(postCalls).toBe(0); // POST was skipped!
    expect(patchCalls).toBe(1); // PATCH was executed!
    expect(await db.outbox.count()).toBe(0);

    processor.destroy();
  });

  it('lease fallback prevents duplicate execution across two processors when Web Locks is disabled', async () => {
    let apiCallCount = 0;
    const api = {
      updateIssue: async (repo: string, num: number) => {
        apiCallCount++;
        await new Promise((r) => setTimeout(r, 100));
        return normalizeIssue(repo, apiIssue({ number: num }), '1001');
      },
    };

    const processor1 = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });

    const processor2 = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });

    await db.outbox.add({
      id: 'op-lease-test',
      type: 'update_issue',
      entityKey: 'acme/repo#5',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 5, title: 'Lease fallback' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accountId: '1001',
    });

    // Run both processors concurrently
    await Promise.all([processor1.process(), processor2.process()]);

    expect(apiCallCount).toBe(1);

    processor1.destroy();
    processor2.destroy();
  });
});
