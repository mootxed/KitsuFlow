import Dexie, { type EntityTable, type Table } from 'dexie';
import type {
  GitHubIssue,
  LocalNote,
  OutboxOperation,
  Repository,
  RepositoryAssigneesCache,
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
  githubIssuesCache!: Table<GitHubIssue, [string, string, number]>;
  repositoriesCache!: Table<Repository, [string, string]>;
  repositoryLabelsCache!: Table<RepositoryLabelsCache, [string, string]>;
  repositoryAssigneesCache!: Table<RepositoryAssigneesCache, [string, string]>;
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
    this.version(3)
      .stores({
        localNotes: 'id, status, repositoryFullName, updatedAt, syncState, accountId',
        githubIssuesCache:
          '[repositoryFullName+issueNumber], repositoryFullName, accountId, derivedStatus, updatedAt, syncState, clientLocalId',
        repositoriesCache: 'fullName, pinned, installationId, accountId, updatedAt',
        repositoryLabelsCache: 'repositoryFullName, accountId, cachedAt',
        outbox:
          'id, type, entityKey, state, repositoryFullName, accountId, createdAt, nextAttemptAt, leaseExpiresAt',
        tabs: 'id, accountId, active, position',
        settings: 'key',
        syncMetadata: 'key, accountId, updatedAt',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('outbox')
          .toCollection()
          .modify((op: Record<string, unknown>) => {
            op.creationStage ??= 'not_started';
          });
      });
    this.version(4)
      .stores({
        localNotes: 'id, status, repositoryFullName, updatedAt, syncState, accountId',
        githubIssuesCache:
          '[accountId+repositoryFullName+issueNumber], accountId, repositoryFullName, derivedStatus, updatedAt, syncState, clientLocalId',
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
      })
      .upgrade(async (transaction) => {
        const issuesTable = transaction.table('githubIssuesCache');
        const reposTable = transaction.table('repositoriesCache');
        const labelsTable = transaction.table('repositoryLabelsCache');
        const outboxTable = transaction.table('outbox');
        const tabsTable = transaction.table('tabs');
        const notesTable = transaction.table('localNotes');

        const issues = await issuesTable.toArray();
        await issuesTable.clear();
        for (const issue of issues) {
          issue.accountId = issue.accountId || 'legacy-unassigned';
          await issuesTable.put(issue);
        }

        const repos = await reposTable.toArray();
        await reposTable.clear();
        for (const repo of repos) {
          repo.accountId = repo.accountId || 'legacy-unassigned';
          await reposTable.put(repo);
        }

        const labels = await labelsTable.toArray();
        await labelsTable.clear();
        for (const label of labels) {
          label.accountId = label.accountId || 'legacy-unassigned';
          await labelsTable.put(label);
        }

        await outboxTable.toCollection().modify((op: Record<string, unknown>) => {
          op.accountId = op.accountId || 'legacy-unassigned';
        });

        await tabsTable.toCollection().modify((tab: Record<string, unknown>) => {
          if (tab.accountId === undefined) {
            tab.accountId = null;
          }
        });

        await notesTable.toCollection().modify((note: Record<string, unknown>) => {
          if (note.repositoryFullName && !note.accountId) {
            note.accountId = 'legacy-unassigned';
          } else if (!note.repositoryFullName) {
            note.accountId = null;
          }
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
