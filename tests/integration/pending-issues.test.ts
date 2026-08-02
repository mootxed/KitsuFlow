import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { OutboxProcessor } from '../../src/sync/outbox';
import { apiIssue } from '../fixtures';
import type { PendingIssue } from '../../src/domain/types';

const makePending = (clientLocalId: string, repo = 'acme/repo'): PendingIssue => ({
  clientLocalId,
  repositoryFullName: repo,
  accountId: '1001',
  title: `Pending Issue ${clientLocalId}`,
  body: 'Waiting for GitHub',
  state: 'open',
  derivedStatus: 'todo',
  derivedPriority: 'none',
  labels: [],
  assignees: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe('PendingIssues table — no collision, full lifecycle', () => {
  afterEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });

  it('two simultaneous pending issues in same repo get separate rows (no PK collision)', async () => {
    const p1 = makePending('client-aaa');
    const p2 = makePending('client-bbb');

    await db.pendingIssues.bulkPut([p1, p2]);

    const all = await db.pendingIssues.toArray();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.clientLocalId).sort()).toEqual(['client-aaa', 'client-bbb']);
  });

  it('pending issue is deleted from pendingIssues after successful creation', async () => {
    const clientLocalId = 'client-lifecycle-1';
    await db.pendingIssues.put(makePending(clientLocalId));

    const api = {
      createIssue: async () => normalizeIssue('acme/repo', apiIssue({ number: 55 }), '1001'),
      updateIssue: async () => normalizeIssue('acme/repo', apiIssue({ number: 55 }), '1001'),
      getIssues: async () => [normalizeIssue('acme/repo', apiIssue({ number: 55 }), '1001')],
    };

    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });

    await processor.enqueue({
      type: 'create_issue',
      entityKey: clientLocalId,
      repositoryFullName: 'acme/repo',
      payload: {
        title: 'Pending Issue client-lifecycle-1',
        body: '',
        labels: [],
        assignees: [],
        clientLocalId,
      },
      accountId: '1001',
    });

    await processor.process();

    // pendingIssues должна быть пустой
    expect(await db.pendingIssues.count()).toBe(0);
    // githubIssuesCache должна содержать реальный issue
    expect(await db.githubIssuesCache.count()).toBe(1);
    const realIssue = (await db.githubIssuesCache.toArray())[0];
    expect(realIssue?.issueNumber).toBe(55);

    processor.destroy();
  });

  it('pending issue survives in pendingIssues when API throws network error', async () => {
    const clientLocalId = 'client-survive';
    await db.pendingIssues.put(makePending(clientLocalId));

    const api = {
      createIssue: async () => {
        throw new TypeError('network failure');
      },
    };

    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });

    await processor.enqueue({
      type: 'create_issue',
      entityKey: clientLocalId,
      repositoryFullName: 'acme/repo',
      payload: {
        title: 'Pending Issue client-survive',
        body: '',
        labels: [],
        assignees: [],
        clientLocalId,
      },
      accountId: '1001',
    });

    await processor.process();

    // pendingIssues должна сохраниться
    expect(await db.pendingIssues.count()).toBe(1);
    // outbox — в состоянии attention (network error = ambiguous)
    const ops = await db.outbox.toArray();
    expect(ops[0]?.state).toBe('attention');

    processor.destroy();
  });

  it('three parallel pending issues in same repo all get unique rows', async () => {
    const ids = ['alpha', 'beta', 'gamma'];
    await db.pendingIssues.bulkPut(ids.map((id) => makePending(id)));

    const count = await db.pendingIssues.where('repositoryFullName').equals('acme/repo').count();
    expect(count).toBe(3);

    // Все три уникальны
    const all = await db.pendingIssues.toArray();
    const uniqueIds = new Set(all.map((p) => p.clientLocalId));
    expect(uniqueIds.size).toBe(3);
  });

  it('403 from createIssue sets state=attention and does not delete pending row', async () => {
    const clientLocalId = 'client-403';
    await db.pendingIssues.put(makePending(clientLocalId));

    const api = {
      createIssue: async () => {
        const err = Object.assign(new Error('Forbidden'), { status: 403 });
        throw err;
      },
    };

    const processor = new OutboxProcessor({
      getApi: () => api as any,
      getActiveAccountId: () => '1001',
      onEvent: () => undefined,
    });

    await processor.enqueue({
      type: 'create_issue',
      entityKey: clientLocalId,
      repositoryFullName: 'acme/repo',
      payload: { title: 'Pending 403', body: '', labels: [], assignees: [], clientLocalId },
      accountId: '1001',
    });

    await processor.process();

    // 403 — локальная ошибка, pending row сохраняется
    expect(await db.pendingIssues.count()).toBe(1);
    const ops = await db.outbox.toArray();
    expect(ops[0]?.state).toBe('attention');

    processor.destroy();
  });
});
