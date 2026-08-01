import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyDb } from '../../src/data/migrate-legacy-db';
import { db } from '../../src/data/db';

const LEGACY_DB_NAME = 'kitsune-manager';
const NEW_DB_NAME = 'kitsuflow-db';

function openLegacyRaw(records: { notes?: any[]; outbox?: any[] }): Promise<void> {
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
      const tx = idb.transaction(['localNotes', 'outbox'], 'readwrite');
      tx.oncomplete = () => {
        idb.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      const notesStore = tx.objectStore('localNotes');
      for (const n of records.notes || []) {
        notesStore.put(n, n.id);
      }
      const outboxStore = tx.objectStore('outbox');
      for (const o of records.outbox || []) {
        outboxStore.put(o, o.id);
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

describe('IndexedDB legacy migration', () => {
  afterEach(async () => {
    await db.close();
    await deleteDB(LEGACY_DB_NAME);
    await deleteDB(NEW_DB_NAME);
  });

  it('skips migration if legacy database does not exist', async () => {
    const result = await migrateLegacyDb();
    expect(result).toBe('skipped');
  });

  it('successfully migrates notes and outbox operations from legacy kitsune-manager DB', async () => {
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

    // Open new Dexie DB and check data
    await db.open();
    const notes = await db.localNotes.toArray();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe('Legacy Note');

    const outbox = await db.outbox.toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload.title).toBe('Pending Issue');
  });
});
