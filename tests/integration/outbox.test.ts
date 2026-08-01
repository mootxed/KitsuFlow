import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/data/db';
import { createLocalNote } from '../../src/domain/notes';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { OutboxProcessor } from '../../src/sync/outbox';
import { apiIssue } from '../fixtures';
import { APP_CONFIG } from '../../src/config';

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
  });

  it('restores pending operations from IndexedDB after a new processor is created', async () => {
    const first = new OutboxProcessor(
      () => null,
      () => undefined,
    );
    await first.enqueue({
      type: 'create_issue',
      entityKey: 'draft',
      repositoryFullName: 'acme/repo',
      payload: { title: 'Offline' },
    });
    const second = new OutboxProcessor(
      () => null,
      () => undefined,
    );
    expect(second).toBeDefined();
    expect((await db.outbox.toArray())[0]?.payload.title).toBe('Offline');
  });

  it('keeps offline creation queued and sends it after reconnect', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get');
    online.mockReturnValue(false);
    const api = {
      createIssue: vi.fn(async () => normalizeIssue('acme/repo', apiIssue())),
    };
    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );
    await processor.enqueue({
      type: 'create_issue',
      entityKey: 'offline',
      repositoryFullName: 'acme/repo',
      payload: { title: 'Offline', body: '', labels: [], assignees: [] },
    });
    await processor.process();
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(await db.outbox.count()).toBe(1);
    online.mockReturnValue(true);
    await processor.process();
    expect(api.createIssue).toHaveBeenCalledOnce();
    expect(await db.outbox.count()).toBe(0);
  });

  it('stops on 401 without deleting the outbox', async () => {
    const events: string[] = [];
    const api = {
      updateIssue: async () => {
        throw Object.assign(new Error('Bad credentials'), { status: 401 });
      },
    };
    const processor = new OutboxProcessor(
      () => api as any,
      (event) => events.push(event.type),
    );
    await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#1',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 1, title: 'Keep me' },
    });
    await processor.process();
    expect(events).toContain('unauthorized');
    expect(await db.outbox.count()).toBe(1);
  });

  it('pauses at the rate limit reset time', async () => {
    const events: string[] = [];
    const reset = Math.ceil((Date.now() + 60_000) / 1000);
    const api = {
      updateIssue: async () => {
        throw Object.assign(new Error('rate limit'), {
          status: 429,
          response: { headers: { 'x-ratelimit-reset': String(reset) } },
        });
      },
    };
    const processor = new OutboxProcessor(
      () => api as any,
      (event) => events.push(event.type),
    );
    await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#2',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 2, title: 'Later' },
    });
    await processor.process();
    expect(events).toContain('rate-limited');
    expect((await db.outbox.toArray())[0]?.nextAttemptAt).toBeDefined();
  });

  it('transitions to exhausted state after maxSyncAttempts', async () => {
    const api = {
      updateIssue: async () => {
        throw new Error('500 Server Error');
      },
    };
    const processor = new OutboxProcessor(
      () => api as any,
      () => undefined,
    );
    const op = await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#3',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 3, title: 'Fails repeatedly' },
    });

    // Simulate attempts up to maxSyncAttempts (4)
    await db.outbox.update(op.id, { attemptCount: APP_CONFIG.maxSyncAttempts - 1 });
    await processor.process();

    const result = await db.outbox.get(op.id);
    expect(result?.state).toBe('exhausted');
    expect(result?.attemptCount).toBe(APP_CONFIG.maxSyncAttempts);

    // Automatic process should not select exhausted operations
    const updateSpy = vi.spyOn(api, 'updateIssue');
    await processor.process();
    expect(updateSpy).not.toHaveBeenCalled();

    // Manual retry should reset state to pending and try again
    await processor.retry(op.id);
    expect(updateSpy).toHaveBeenCalledOnce();
  });

  it('distinguishes 403 permission-denied from rate limit and does not auto-retry', async () => {
    const events: string[] = [];
    const api = {
      updateIssue: async () => {
        throw Object.assign(new Error('Resource not accessible by integration'), {
          status: 403,
          response: {
            headers: { 'x-ratelimit-remaining': '60' },
            data: { message: 'Resource not accessible' },
          },
        });
      },
    };
    const processor = new OutboxProcessor(
      () => api as any,
      (event) => events.push(event.type),
    );
    await processor.enqueue({
      type: 'update_issue',
      entityKey: 'acme/repo#4',
      repositoryFullName: 'acme/repo',
      payload: { issueNumber: 4, title: 'Permission check' },
    });

    await processor.process();

    expect(events).toContain('permission-denied');
    const result = (await db.outbox.toArray())[0];
    expect(result?.state).toBe('attention');
    expect(result?.lastError).toContain('Отказано в доступе');
  });
});
