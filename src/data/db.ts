import Dexie, { type EntityTable, type Table } from 'dexie';
import type {
  GitHubIssue,
  LocalNote,
  OutboxOperation,
  Repository,
  RepositoryLabelsCache,
  WorkspaceTab,
} from '../domain/types';

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface SyncMetadata {
  key: string;
  value: string;
  updatedAt: string;
}

export class KitsuFlowDatabase extends Dexie {
  localNotes!: EntityTable<LocalNote, 'id'>;
  githubIssuesCache!: Table<GitHubIssue, [string, number]>;
  repositoriesCache!: EntityTable<Repository, 'fullName'>;
  repositoryLabelsCache!: EntityTable<RepositoryLabelsCache, 'repositoryFullName'>;
  outbox!: EntityTable<OutboxOperation, 'id'>;
  tabs!: EntityTable<WorkspaceTab, 'id'>;
  settings!: EntityTable<SettingRecord, 'key'>;
  syncMetadata!: EntityTable<SyncMetadata, 'key'>;

  constructor(name = 'kitsuflow-db') {
    super(name);
    this.version(1).stores({
      localNotes: 'id, status, repositoryFullName, updatedAt, syncState',
      githubIssuesCache:
        '[repositoryFullName+issueNumber], repositoryFullName, derivedStatus, updatedAt, syncState, clientLocalId',
      repositoriesCache: 'fullName, pinned, installationId, updatedAt',
      repositoryLabelsCache: 'repositoryFullName, cachedAt',
      outbox: 'id, type, entityKey, state, repositoryFullName, createdAt, nextAttemptAt',
      tabs: 'id, active, position',
      settings: 'key',
      syncMetadata: 'key, updatedAt',
    });
    this.version(2)
      .stores({
        outbox: 'id, type, entityKey, state, repositoryFullName, createdAt, nextAttemptAt',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('outbox')
          .toCollection()
          .modify((operation: Record<string, unknown>) => {
            operation.requestStarted ??= false;
          });
      });
  }
}

export const db = new KitsuFlowDatabase();

export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
}
