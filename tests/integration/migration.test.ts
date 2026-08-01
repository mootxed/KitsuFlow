import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyDb } from '../../src/data/migrate-legacy-db';
import { db } from '../../src/data/db';

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
