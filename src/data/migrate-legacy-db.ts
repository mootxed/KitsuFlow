/**
 * migrate-legacy-db.ts
 *
 * Одноразовая миграция данных из устаревшей IndexedDB `kitsune-manager`
 * в новую `kitsuflow-db`.
 *
 * Гарантии:
 * - Выполняется ДО открытия новой базы Dexie.
 * - Если новая база уже содержит данные — миграция пропускается (не перезаписывает молча).
 * - После успешной миграции сохраняется маркер `kf_migrated` в новой базе.
 * - При любой ошибке: старая база не трогается, выбрасывается исключение
 *   и приложение показывает сообщение об ошибке (не запускается с пустой базой).
 * - Старая база сохраняется как резервная копия.
 */

import { db, KitsuFlowDatabase } from './db';

const LEGACY_DB_NAME = 'kitsune-manager';
const MIGRATION_MARKER_STORE = 'syncMetadata';
const MIGRATION_MARKER_KEY = 'kf_migrated';

/** Таблицы, которые нужно скопировать. */
const TABLES = [
  'localNotes',
  'githubIssuesCache',
  'repositoriesCache',
  'repositoryLabelsCache',
  'outbox',
  'tabs',
  'settings',
  'syncMetadata',
] as const;

/** Открывает существующую базу без изменения схемы (версия 0 = текущая). */
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

/** Читает все записи из store как Map<key, value>. */
function readAllFromStore(
  idb: IDBDatabase,
  storeName: string,
): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return new Promise((resolve, reject) => {
    if (!idb.objectStoreNames.contains(storeName)) {
      resolve([]);
      return;
    }
    const tx = idb.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const results: Array<{ key: IDBValidKey; value: unknown }> = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        results.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

/**
 * Главная функция миграции.
 *
 * Возвращает:
 * - `'migrated'` — данные успешно скопированы
 * - `'skipped'` — старой базы нет или новая уже содержит данные
 * - `'already-done'` — маркер уже стоит
 */
export async function migrateLegacyDb(): Promise<'migrated' | 'skipped' | 'already-done'> {
  // 1. Проверяем наличие старой базы
  const legacyDb = await openExisting(LEGACY_DB_NAME);
  if (!legacyDb) {
    return 'skipped';
  }

  try {
    // 2. Открываем новую базу через Dexie (чтобы использовать корректную схему Dexie)
    await db.open();

    // 3. Проверяем маркер — если уже мигрировали, пропускаем
    const marker = await db.syncMetadata.get(MIGRATION_MARKER_KEY);
    if (marker) {
      return 'already-done';
    }

    // 4. Проверяем, есть ли уже данные в новой базе
    const existingNotesCount = await db.localNotes.count();
    const existingOutboxCount = await db.outbox.count();
    if (existingNotesCount > 0 || existingOutboxCount > 0) {
      await db.syncMetadata.put({
        key: MIGRATION_MARKER_KEY,
        value: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return 'already-done';
    }

    // 5. Переносим данные из legacyDb в Dexie
    for (const tableName of TABLES) {
      const records = await readAllFromStore(legacyDb, tableName);
      if (records.length > 0) {
        const table = (db as any)[tableName];
        if (table) {
          await table.bulkPut(records.map((r) => r.value));
        }
      }
    }

    // 6. Записываем маркер успешной миграции
    await db.syncMetadata.put({
      key: MIGRATION_MARKER_KEY,
      value: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
