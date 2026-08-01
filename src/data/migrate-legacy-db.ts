/**
 * migrate-legacy-db.ts
 *
 * Одноразовая атомарная миграция данных из устаревшей IndexedDB `kitsune-manager`
 * в новую `kitsuflow-db`.
 */

import { db } from './db';

const LEGACY_DB_NAME = 'kitsune-manager';
const MIGRATION_MARKER_KEY = 'kf_migrated';

type TableName =
  | 'localNotes'
  | 'githubIssuesCache'
  | 'repositoriesCache'
  | 'repositoryLabelsCache'
  | 'outbox'
  | 'tabs'
  | 'settings'
  | 'syncMetadata';

const TABLES: readonly TableName[] = [
  'localNotes',
  'githubIssuesCache',
  'repositoriesCache',
  'repositoryLabelsCache',
  'outbox',
  'tabs',
  'settings',
  'syncMetadata',
];

function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onupgradeneeded = (event) => {
      (event.target as IDBOpenDBRequest).result.close();
      const del = indexedDB.deleteDatabase(name);
      del.onsuccess = () => resolve(null);
      del.onerror = () => resolve(null);
    };
  });
}

function readAllFromStore(idb: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    if (!idb.objectStoreNames.contains(storeName)) {
      resolve([]);
      return;
    }
    const tx = idb.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const results: unknown[] = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export type MigrationResult = 'migrated' | 'skipped' | 'already-done' | 'target-not-empty';

export async function migrateLegacyDb(): Promise<MigrationResult> {
  const legacyDb = await openExisting(LEGACY_DB_NAME);
  if (!legacyDb) {
    return 'skipped';
  }

  try {
    // 1. Прочитать ВСЕ данные из старой базы в память (без изменения новой)
    const legacyDataMap = new Map<TableName, unknown[]>();
    for (const tableName of TABLES) {
      const records = await readAllFromStore(legacyDb, tableName);
      if (records.length > 0) {
        legacyDataMap.set(tableName, records);
      }
    }

    // 2. Открыть новую базу
    await db.open();

    // 3. Проверить маркер успешной миграции
    const marker = await db.syncMetadata.get(MIGRATION_MARKER_KEY);
    if (marker) {
      return 'already-done';
    }

    // 4. Проверить ВСЕ пользовательские таблицы новой базы на наличие данных
    const counts = await Promise.all([
      db.localNotes.count(),
      db.githubIssuesCache.count(),
      db.repositoriesCache.count(),
      db.repositoryLabelsCache.count(),
      db.outbox.count(),
      db.tabs.count(),
      db.settings.count(),
      db.syncMetadata.count(),
    ]);

    const totalExisting = counts.reduce((acc, count) => acc + count, 0);
    if (totalExisting > 0) {
      console.warn(
        '[Migration] Новая база уже содержит данные. Миграция пропущена во избежание перезаписи.',
      );
      return 'target-not-empty';
    }

    // 5. Записать все данные в ОДНОЙ Dexie-транзакции
    await db.transaction('rw', db.tables, async () => {
      for (const [tableName, records] of legacyDataMap.entries()) {
        const table = (db as Record<string, any>)[tableName];
        if (table && typeof table.bulkPut === 'function') {
          const normalizedRecords = records.map((rec: any) => {
            if (tableName === 'localNotes') {
              if (rec.repositoryFullName && !rec.accountId) {
                return { ...rec, accountId: 'legacy-unassigned' };
              }
              if (!rec.repositoryFullName) {
                return { ...rec, accountId: null };
              }
            }
            if (
              [
                'githubIssuesCache',
                'repositoriesCache',
                'repositoryLabelsCache',
                'outbox',
              ].includes(tableName)
            ) {
              if (!rec.accountId) {
                return { ...rec, accountId: 'legacy-unassigned' };
              }
            }
            if (tableName === 'tabs') {
              if (rec.accountId === undefined) {
                return { ...rec, accountId: null };
              }
            }
            return rec;
          });
          await table.bulkPut(normalizedRecords);
        }
      }

      // Маркер записывается внутри той же транзакции и только при её успешном прохождении
      await db.syncMetadata.put({
        key: MIGRATION_MARKER_KEY,
        value: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    return 'migrated';
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Неизвестная ошибка миграции IndexedDB';
    throw new Error(
      `Не удалось перенести данные из kitsune-manager в kitsuflow-db: ${message}. ` +
        `Ваши данные в kitsune-manager не изменены. Обновите страницу или обратитесь в поддержку.`,
    );
  } finally {
    legacyDb.close();
  }
}
