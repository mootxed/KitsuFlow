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
    await db.localNotes.add(note);
    const api = {
      createIssue: async () => {
        throw new TypeError('network');
      },
    };
    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );
    await processor.enqueue({
      type: 'convert_note',
      entityKey: note.id,
      repositoryFullName: 'acme/repo',
      sourceNoteId: note.id,
      payload: { title: note.title, body: '', labels: [], assignees: [] },
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
    await db.localNotes.add(note);
    const api = {
      createIssue: async () => normalizeIssue('acme/repo', apiIssue()),
      updateIssue: async () => normalizeIssue('acme/repo', apiIssue()),
      getIssues: async () => [normalizeIssue('acme/repo', apiIssue())],
    };
    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );
    await processor.enqueue({
      type: 'convert_note',
      entityKey: note.id,
      repositoryFullName: 'acme/repo',
      sourceNoteId: note.id,
      payload: { title: note.title, body: '', labels: [], assignees: [] },
    });
    await processor.process();
    expect(await db.localNotes.get(note.id)).toBeUndefined();
    expect(await db.githubIssuesCache.count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    processor.destroy();
  });

  it('parallel calls to process() return the same Promise and do not duplicate execution', async () => {
    let callCount = 0;
    const api = {
      updateIssue: async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return normalizeIssue('acme/repo', apiIssue({ number: 1 }));
      },
    };
    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );
    await db.outbox.add({
      id: 'op-parallel-1',
      type: 'update_issue',
      entityKey: 'acme/repo#1',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 1, title: 'Parallel test' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const p1 = processor.process();
    const p2 = processor.process();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
    processor.destroy();
  });

  it('executes operation added during an active process() loop in the same loop', async () => {
    const processed: string[] = [];
    const api = {
      updateIssue: async (repo: string, num: number) => {
        processed.push(`op-${num}`);
        await new Promise((r) => setTimeout(r, 20));
        return normalizeIssue(repo, apiIssue({ number: num }));
      },
    };
    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );

    await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#1',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 1, title: 'First' },
    });

    const processPromise = processor.process();

    await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#2',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 2, title: 'Second' },
    });

    await processPromise;
    expect(processed).toEqual(['op-1', 'op-2']);
    processor.destroy();
  });

  it('two-stage issue creation: POST succeeds, PATCH fails, retry executes only PATCH without repeating POST', async () => {
    let postCalls = 0;
    let patchCalls = 0;

    const api = {
      createIssue: async () => {
        postCalls++;
        return normalizeIssue('acme/repo', apiIssue({ number: 99 }));
      },
      updateIssue: async () => {
        patchCalls++;
        if (patchCalls === 1) {
          throw new Error('500 Server error during PATCH close');
        }
        return normalizeIssue('acme/repo', apiIssue({ number: 99, state: 'closed' }));
      },
      getIssues: async () => [normalizeIssue('acme/repo', apiIssue({ number: 99 }))],
    };

    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );

    const op = await processor.enqueue({
      type: 'create_issue',
      entityKey: 'client-temp-1',
      repositoryFullName: 'acme/repo',
      payload: { title: 'Closed Issue', state: 'closed', labels: [], assignees: [] },
    });

    await processor.process();

    expect(postCalls).toBe(1);
    expect(patchCalls).toBe(1);

    const outboxItem = await db.outbox.get(op.id);
    expect(outboxItem?.creationStage).toBe('applying_final_state');
    expect(outboxItem?.createdIssueNumber).toBe(99);
    expect(outboxItem?.state).toBe('failed');

    await processor.retry(op.id);

    expect(postCalls).toBe(1);
    expect(patchCalls).toBe(2);
    expect(await db.outbox.count()).toBe(0);
    processor.destroy();
  });

  it('recovers stale syncing update_issue back to pending', async () => {
    await db.outbox.add({
      id: 'stale-1',
      type: 'update_issue',
      entityKey: 'acme/repo#10',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 10, title: 'Stale' },
      state: 'syncing',
      requestStarted: true,
      attemptCount: 1,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const api = {
      updateIssue: async () => normalizeIssue('acme/repo', apiIssue({ number: 10 })),
    };

    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );

    await processor.process();
    expect(await db.outbox.count()).toBe(0);
    processor.destroy();
  });

  it('manual retry resets attemptCount, state, nextAttemptAt, and lastError', async () => {
    const api = {
      updateIssue: async () => normalizeIssue('acme/repo', apiIssue({ number: 3 })),
    };
    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );

    const op = await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#3',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 3, title: 'Retry test' },
    });

    await db.outbox.update(op.id, {
      state: 'exhausted',
      attemptCount: 4,
      lastError: 'Failed max times',
      nextAttemptAt: undefined,
    });

    await processor.retry(op.id);
    expect(await db.outbox.count()).toBe(0);
    processor.destroy();
  });
});
