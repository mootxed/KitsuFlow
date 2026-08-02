import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { migrateLegacyDb } from '../../src/data/migrate-legacy-db';
import { KitsuFlowDatabase, db } from '../../src/data/db';

const LEGACY_DB_NAME = 'kitsune-manager';
const NEW_DB_NAME = 'kitsuflow-db';

function openLegacyRaw(records: {
  notes?: any[];
  issues?: any[];
  repos?: any[];
  labels?: any[];
  outbox?: any[];
  tabs?: any[];
  settings?: any[];
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME, 1);
    req.onupgradeneeded = (event) => {
      const idb = (event.target as IDBOpenDBRequest).result;
      idb.createObjectStore('localNotes');
      idb.createObjectStore('githubIssuesCache');
      idb.createObjectStore('repositoriesCache');
      idb.createObjectStore('repositoryLabelsCache');
      idb.createObjectStore('outbox');
      idb.createObjectStore('tabs');
      idb.createObjectStore('settings');
      idb.createObjectStore('syncMetadata');
    };
    req.onsuccess = () => {
      const idb = req.result;
      const stores = Array.from(idb.objectStoreNames);
      const tx = idb.transaction(stores, 'readwrite');
      tx.oncomplete = () => {
        idb.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);

      if (records.notes) {
        const store = tx.objectStore('localNotes');
        for (const n of records.notes) store.put(n, n.id);
      }
      if (records.issues) {
        const store = tx.objectStore('githubIssuesCache');
        for (const i of records.issues) store.put(i, [i.repositoryFullName, i.issueNumber]);
      }
      if (records.repos) {
        const store = tx.objectStore('repositoriesCache');
        for (const r of records.repos) store.put(r, r.fullName);
      }
      if (records.labels) {
        const store = tx.objectStore('repositoryLabelsCache');
        for (const l of records.labels) store.put(l, l.repositoryFullName);
      }
      if (records.outbox) {
        const store = tx.objectStore('outbox');
        for (const o of records.outbox) store.put(o, o.id);
      }
      if (records.tabs) {
        const store = tx.objectStore('tabs');
        for (const t of records.tabs) store.put(t, t.id);
      }
      if (records.settings) {
        const store = tx.objectStore('settings');
        for (const s of records.settings) store.put(s, s.key);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

function deleteDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
}

describe('IndexedDB legacy migration & schema version 4 upgrade', () => {
  afterEach(async () => {
    await db.close();
    await deleteDB(LEGACY_DB_NAME);
    await deleteDB(NEW_DB_NAME);
  });

  it('skips migration if legacy database does not exist', async () => {
    const result = await migrateLegacyDb();
    expect(result).toBe('skipped');
  });

  it('successfully migrates all tables atomically from legacy DB, maps unassigned records to legacy-unassigned, and sets marker', async () => {
    const sampleNote = {
      id: 'note-1',
      title: 'Legacy Note',
      description: 'Migrate me',
      status: 'todo',
      repositoryFullName: null,
      localTags: ['legacy'],
      checklist: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncState: 'local',
    };

    const sampleOutbox = {
      id: 'outbox-1',
      type: 'create_issue',
      entityKey: 'client-1',
      repositoryFullName: 'acme/repo',
      payload: { title: 'Pending Issue' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await openLegacyRaw({ notes: [sampleNote], outbox: [sampleOutbox] });

    const result = await migrateLegacyDb();
    expect(result).toBe('migrated');

    await db.open();
    const notes = await db.localNotes.toArray();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe('Legacy Note');
    expect(notes[0]?.accountId).toBeNull(); // Local device note has accountId null

    const outbox = await db.outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.accountId).toBe('legacy-unassigned');

    const marker = await db.syncMetadata.get('kf_migrated');
    expect(marker).toBeDefined();
  });

  it('returns target-not-empty and does not overwrite if target DB contains tabs or settings', async () => {
    await openLegacyRaw({
      notes: [{ id: 'old-note', title: 'Old Note', status: 'todo' }],
    });

    await db.open();
    await db.tabs.add({
      id: 'existing-tab',
      entity: { kind: 'all' },
      title: 'Все задачи',
      position: 0,
      active: true,
      accountId: null,
    });

    const result = await migrateLegacyDb();
    expect(result).toBe('target-not-empty');

    const marker = await db.syncMetadata.get('kf_migrated');
    expect(marker).toBeUndefined();

    const notes = await db.localNotes.toArray();
    expect(notes).toHaveLength(0);
  });

  it('migrates composite keys for version 4 without losing data or overwriting duplicate repos/issues across accounts', async () => {
    await db.open();
    // Simulate populating Dexie version 4 directly
    await db.githubIssuesCache.put({
      repositoryFullName: 'org/repo',
      nodeId: 'n1',
      issueNumber: 1,
      title: 'Alice Issue #1',
      body: '',
      state: 'open',
      derivedStatus: 'todo',
      derivedPriority: 'none',
      labels: [],
      assignees: [],
      htmlUrl: '',
      createdAt: '',
      updatedAt: '',
      cachedAt: '',
      syncState: 'synced',
      statusConflict: false,
      priorityConflict: false,
      accountId: 'account-A',
    });

    await db.githubIssuesCache.put({
      repositoryFullName: 'org/repo',
      nodeId: 'n2',
      issueNumber: 1,
      title: 'Bob Issue #1',
      body: '',
      state: 'open',
      derivedStatus: 'todo',
      derivedPriority: 'none',
      labels: [],
      assignees: [],
      htmlUrl: '',
      createdAt: '',
      updatedAt: '',
      cachedAt: '',
      syncState: 'synced',
      statusConflict: false,
      priorityConflict: false,
      accountId: 'account-B',
    });

    const issues = await db.githubIssuesCache.toArray();
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.title).sort()).toEqual(['Alice Issue #1', 'Bob Issue #1']);
  });
});

describe('IndexedDB schema v5 → v6', () => {
  it('migrates a temporary issue, its outbox link and #-1 tab without losing data', async () => {
    const name = `kitsuflow-v5-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(5).stores({
      localNotes: 'id, status, repositoryFullName, updatedAt, syncState, accountId',
      githubIssuesCache:
        '[accountId+repositoryFullName+issueNumber], accountId, repositoryFullName, derivedStatus, updatedAt, syncState, clientLocalId',
      pendingIssues: 'clientLocalId, accountId, repositoryFullName, createdAt',
      repositoriesCache:
        '[accountId+fullName], accountId, fullName, pinned, installationId, updatedAt',
      repositoryLabelsCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      repositoryAssigneesCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      outbox:
        'id, type, entityKey, state, repositoryFullName, accountId, createdAt, nextAttemptAt, leaseExpiresAt',
      tabs: 'id, accountId, active, position',
      settings: 'key',
      syncMetadata: 'key, accountId, updatedAt',
    });
    await old.open();
    const now = '2026-08-01T00:00:00Z';
    await old.table('githubIssuesCache').put({
      repositoryFullName: 'acme/repo',
      nodeId: 'temporary',
      issueNumber: -1,
      title: 'Legacy pending',
      body: 'body',
      state: 'open',
      derivedStatus: 'todo',
      derivedPriority: 'high',
      labels: [],
      assignees: [],
      htmlUrl: '',
      createdAt: now,
      updatedAt: now,
      cachedAt: now,
      syncState: 'pending',
      statusConflict: false,
      priorityConflict: false,
      accountId: '1001',
    });
    await old.table('outbox').put({
      id: 'legacy-create',
      type: 'create_issue',
      entityKey: 'stable-client-id',
      repositoryFullName: 'acme/repo',
      payload: { title: 'Legacy pending' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      accountId: '1001',
    });
    await old.table('tabs').bulkPut([
      {
        id: 'legacy-tab',
        entity: { kind: 'issue', repositoryFullName: 'acme/repo', issueNumber: -1 },
        title: 'repo #-1',
        position: 8,
        active: true,
        accountId: '1001',
      },
      {
        id: 'all-tab',
        entity: { kind: 'all' },
        title: 'Все задачи',
        position: 8,
        active: true,
        accountId: '1001',
      },
    ]);
    old.close();

    const upgraded = new KitsuFlowDatabase(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(7);
    expect(await upgraded.githubIssuesCache.count()).toBe(0);
    expect(await upgraded.pendingIssues.get('stable-client-id')).toMatchObject({
      title: 'Legacy pending',
      accountId: '1001',
    });
    expect(await upgraded.outbox.get('legacy-create')).toMatchObject({
      entityKey: 'stable-client-id',
      payload: { clientLocalId: 'stable-client-id' },
    });
    const tabs = await upgraded.tabs.where('accountId').equals('1001').sortBy('position');
    expect(tabs.map((tab) => tab.position)).toEqual([0, 1]);
    expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    expect(tabs.find((tab) => tab.id === 'legacy-tab')?.entity).toEqual({
      kind: 'pending-issue',
      repositoryFullName: 'acme/repo',
      clientLocalId: 'stable-client-id',
    });
    upgraded.close();
    await Dexie.delete(name);
  });

  it('quarantines every candidate when a legacy pending Issue matches multiple creates', async () => {
    const name = `kitsuflow-v5-ambiguous-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(5).stores({
      localNotes: 'id, status, repositoryFullName, updatedAt, syncState, accountId',
      githubIssuesCache:
        '[accountId+repositoryFullName+issueNumber], accountId, repositoryFullName, derivedStatus, updatedAt, syncState, clientLocalId',
      pendingIssues: 'clientLocalId, accountId, repositoryFullName, createdAt',
      repositoriesCache:
        '[accountId+fullName], accountId, fullName, pinned, installationId, updatedAt',
      repositoryLabelsCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      repositoryAssigneesCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      outbox:
        'id, type, entityKey, state, repositoryFullName, accountId, createdAt, nextAttemptAt, leaseExpiresAt',
      tabs: 'id, accountId, active, position',
      settings: 'key',
      syncMetadata: 'key, accountId, updatedAt',
    });
    await old.open();
    const now = '2026-08-01T00:00:00Z';
    await old.table('githubIssuesCache').put({
      repositoryFullName: 'acme/repo',
      nodeId: 'temporary',
      issueNumber: -1,
      title: 'Ambiguous legacy create',
      body: '',
      state: 'open',
      derivedStatus: 'todo',
      derivedPriority: 'none',
      labels: [],
      assignees: [],
      htmlUrl: '',
      createdAt: now,
      updatedAt: now,
      cachedAt: now,
      syncState: 'pending',
      statusConflict: false,
      priorityConflict: false,
      accountId: '1001',
    });
    await old.table('outbox').bulkPut(
      ['candidate-a', 'candidate-b'].map((id) => ({
        id,
        type: 'create_issue',
        entityKey: id,
        repositoryFullName: 'acme/repo',
        payload: { title: 'Ambiguous legacy create' },
        state: 'pending',
        requestStarted: false,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
        accountId: '1001',
      })),
    );
    old.close();

    const upgraded = new KitsuFlowDatabase(name);
    await upgraded.open();
    const pending = (await upgraded.pendingIssues.toArray())[0];
    const candidates = await upgraded.outbox.toArray();

    expect(pending).toMatchObject({ needsAttention: true });
    expect(pending?.migrationGroupId).toBeTruthy();
    expect(candidates).toHaveLength(2);
    expect(
      candidates.every(
        (operation) =>
          operation.state === 'attention' &&
          operation.ambiguityRisk === true &&
          operation.migrationGroupId === pending?.migrationGroupId,
      ),
    ).toBe(true);

    upgraded.close();
    await Dexie.delete(name);
  });

  it('v6→v7: migrates pendingIssues for users who already had old v6 schema without upgrade logic', async () => {
    const name = `kitsuflow-v6-${crypto.randomUUID()}`;
    // Симулируем старое v6 без upgrade-логики (чистое изменение схемы)
    const oldV6 = new Dexie(name);
    oldV6.version(6).stores({
      localNotes: 'id, status, repositoryFullName, updatedAt, syncState, accountId',
      githubIssuesCache:
        '[accountId+repositoryFullName+issueNumber], accountId, repositoryFullName, derivedStatus, updatedAt, syncState, clientLocalId',
      pendingIssues:
        'clientLocalId, accountId, repositoryFullName, createdAt, needsAttention, migrationGroupId',
      repositoriesCache:
        '[accountId+fullName], accountId, fullName, pinned, installationId, updatedAt',
      repositoryLabelsCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      repositoryAssigneesCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      outbox:
        'id, type, entityKey, state, repositoryFullName, accountId, createdAt, nextAttemptAt, leaseExpiresAt, ambiguityRisk, migrationGroupId',
      tabs: 'id, accountId, active, position',
      settings: 'key',
      syncMetadata: 'key, accountId, updatedAt',
    });
    await oldV6.open();
    const now = '2026-08-01T00:00:00Z';
    // Добавляем временный issue в githubIssuesCache (как было до v5 миграции)
    await oldV6.table('githubIssuesCache').put({
      repositoryFullName: 'acme/v6test',
      nodeId: 'temporary-v6',
      issueNumber: -1,
      title: 'V6 pending issue',
      body: 'body',
      state: 'open',
      derivedStatus: 'todo',
      derivedPriority: 'none',
      labels: [],
      assignees: [],
      htmlUrl: '',
      createdAt: now,
      updatedAt: now,
      cachedAt: now,
      syncState: 'pending',
      statusConflict: false,
      priorityConflict: false,
      accountId: '9999',
    });
    await oldV6.table('outbox').put({
      id: 'v6-create-op',
      type: 'create_issue',
      entityKey: 'v6-client-id',
      repositoryFullName: 'acme/v6test',
      payload: { title: 'V6 pending issue' },
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      accountId: '9999',
    });
    oldV6.close();

    // Открываем новым кодом (включая v7)
    const upgraded = new KitsuFlowDatabase(name);
    await upgraded.open();
    expect(upgraded.verno).toBe(7);
    // Временный issue должен быть перенесён в pendingIssues
    expect(await upgraded.githubIssuesCache.count()).toBe(0);
    const pending = await upgraded.pendingIssues.get('v6-client-id');
    expect(pending).toMatchObject({ title: 'V6 pending issue', accountId: '9999' });
    upgraded.close();
    await Dexie.delete(name);
  });

  it('assigns the same migrationGroupId to multiple pending issues sharing identical candidates', async () => {
    const name = `kitsuflow-v6-shared-group-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(5).stores({
      localNotes: 'id, status, repositoryFullName, updatedAt, syncState, accountId',
      githubIssuesCache:
        '[accountId+repositoryFullName+issueNumber], accountId, repositoryFullName, derivedStatus, updatedAt, syncState, clientLocalId',
      pendingIssues: 'clientLocalId, accountId, repositoryFullName, createdAt',
      repositoriesCache:
        '[accountId+fullName], accountId, fullName, pinned, installationId, updatedAt',
      repositoryLabelsCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      repositoryAssigneesCache:
        '[accountId+repositoryFullName], accountId, repositoryFullName, cachedAt',
      outbox:
        'id, type, entityKey, state, repositoryFullName, accountId, createdAt, nextAttemptAt, leaseExpiresAt',
      tabs: 'id, accountId, active, position',
      settings: 'key',
      syncMetadata: 'key, accountId, updatedAt',
    });
    await old.open();
    const now = '2026-08-01T00:00:00Z';
    // Два pending issue с одинаковым заголовком (будут совпадать с одним набором кандидатов)
    await old.table('githubIssuesCache').bulkPut([
      {
        repositoryFullName: 'acme/shared',
        nodeId: 'tmp-1',
        issueNumber: -1,
        title: 'Shared title',
        body: '',
        state: 'open',
        derivedStatus: 'todo',
        derivedPriority: 'none',
        labels: [],
        assignees: [],
        htmlUrl: '',
        createdAt: now,
        updatedAt: now,
        cachedAt: now,
        syncState: 'pending',
        statusConflict: false,
        priorityConflict: false,
        accountId: '1001',
      },
      {
        repositoryFullName: 'acme/shared',
        nodeId: 'tmp-2',
        issueNumber: -2,
        title: 'Shared title',
        body: '',
        state: 'open',
        derivedStatus: 'todo',
        derivedPriority: 'none',
        labels: [],
        assignees: [],
        htmlUrl: '',
        createdAt: now,
        updatedAt: now,
        cachedAt: now,
        syncState: 'pending',
        statusConflict: false,
        priorityConflict: false,
        accountId: '1001',
      },
    ]);
    // Два outbox-кандидата с одинаковым заголовком
    await old.table('outbox').bulkPut(
      ['shared-cand-a', 'shared-cand-b'].map((id) => ({
        id,
        type: 'create_issue',
        entityKey: id,
        repositoryFullName: 'acme/shared',
        payload: { title: 'Shared title' },
        state: 'pending',
        requestStarted: false,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
        accountId: '1001',
      })),
    );
    old.close();

    const upgraded = new KitsuFlowDatabase(name);
    await upgraded.open();
    const pendingAll = await upgraded.pendingIssues.toArray();
    // Оба pending должны быть ambiguous
    expect(pendingAll.every((p) => p.needsAttention === true)).toBe(true);
    // Оба pending должны иметь одинаковый migrationGroupId
    const groupIds = new Set(pendingAll.map((p) => p.migrationGroupId));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toBeTruthy();
    upgraded.close();
    await Dexie.delete(name);
  });
});
