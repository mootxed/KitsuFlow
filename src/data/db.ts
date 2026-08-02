import Dexie, { type EntityTable, type Table } from 'dexie';
import type {
  GitHubIssue,
  LocalNote,
  OutboxOperation,
  PendingIssue,
  Repository,
  RepositoryAssigneesCache,
  RepositoryLabelsCache,
  WorkspaceTab,
} from '../domain/types';
import { ensureDefaultTab, titleForTabEntity } from '../domain/tabs';

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface SyncMetadata {
  key: string;
  value: string;
  updatedAt: string;
  accountId?: string | undefined;
}

export class KitsuFlowDatabase extends Dexie {
  localNotes!: EntityTable<LocalNote, 'id'>;
  githubIssuesCache!: Table<GitHubIssue, [string, string, number]>;
  pendingIssues!: EntityTable<PendingIssue, 'clientLocalId'>;
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
    this.version(5)
      .stores({
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
      })
      .upgrade(async (transaction) => {
        // Переносим временные карточки (issueNumber < 0) из githubIssuesCache в pendingIssues
        const issuesTable = transaction.table('githubIssuesCache');
        const pendingTable = transaction.table('pendingIssues');
        const allIssues = await issuesTable.toArray();
        const tempIssues = allIssues.filter(
          (i: Record<string, unknown>) => Number(i.issueNumber) < 0,
        );
        for (const tempIssue of tempIssues) {
          const clientLocalId = String(tempIssue.clientLocalId || crypto.randomUUID());
          const pending: Record<string, unknown> = {
            clientLocalId,
            repositoryFullName: tempIssue.repositoryFullName,
            accountId: tempIssue.accountId,
            title: tempIssue.title,
            body: tempIssue.body,
            state: tempIssue.state,
            derivedStatus: tempIssue.derivedStatus,
            derivedPriority: tempIssue.derivedPriority,
            labels: tempIssue.labels,
            assignees: tempIssue.assignees,
            createdAt: tempIssue.createdAt,
            updatedAt: tempIssue.updatedAt,
          };
          await pendingTable.put(pending);
          // Удаляем временную запись из githubIssuesCache
          await issuesTable
            .where('[accountId+repositoryFullName+issueNumber]')
            .equals([tempIssue.accountId, tempIssue.repositoryFullName, tempIssue.issueNumber])
            .delete();
        }
      });
    this.version(6).stores({
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
    // v7: переносим upgrade-логику из v6 сюда, чтобы пользователи, открывавшие базу
    // на старом v6 (без этих полей), тоже прошли миграцию pendingIssues/outbox/tabs.
    this.version(7)
      .stores({
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
      })
      .upgrade(async (transaction) => {
        const issuesTable = transaction.table('githubIssuesCache');
        const pendingTable = transaction.table('pendingIssues');
        const outboxTable = transaction.table('outbox');
        const tabsTable = transaction.table('tabs');

        const operations = (await outboxTable.toArray()) as OutboxOperation[];
        const migrated: Array<{
          accountId: string;
          repositoryFullName: string;
          clientLocalId: string;
          title: string;
        }> = [];

        // Стабильный migrationGroupId: вычисляется один раз на уникальный набор candidate IDs.
        // Если несколько pending-карточек совпадают с теми же кандидатами,
        // они получают один и тот же groupId (иначе карточки теряли бы связь).
        const groupIdCache = new Map<string, string>();
        const getGroupId = (candidateIds: string[]): string => {
          const key = [...candidateIds].sort().join('\0');
          const existing = groupIdCache.get(key);
          if (existing) return existing;
          const id = crypto.randomUUID();
          groupIdCache.set(key, id);
          return id;
        };

        interface PendingResolution {
          clientLocalId: string;
          ambiguous: boolean;
          candidates: OutboxOperation[];
          operation?: OutboxOperation | undefined;
        }

        const resolveClientLocalId = (record: Record<string, unknown>): PendingResolution => {
          const existing =
            typeof record.clientLocalId === 'string' && record.clientLocalId
              ? record.clientLocalId
              : undefined;
          const accountId = String(record.accountId || 'legacy-unassigned');
          const repositoryFullName = String(record.repositoryFullName || '');
          const title = String(record.title || '');
          const eligible = operations.filter((operation) => {
            if (
              operation.accountId !== accountId ||
              operation.repositoryFullName !== repositoryFullName
            )
              return false;
            if (operation.type !== 'create_issue' && operation.type !== 'convert_note')
              return false;
            return true;
          });
          const exactCandidates = existing
            ? eligible.filter(
                (operation) =>
                  operation.entityKey === existing || operation.payload.clientLocalId === existing,
              )
            : [];
          const candidates = exactCandidates.length
            ? exactCandidates
            : eligible.filter((operation) => String(operation.payload.title || '') === title);
          const operation = candidates.length === 1 ? candidates[0] : undefined;
          if (operation) {
            return {
              clientLocalId: operation.entityKey,
              ambiguous: false,
              candidates,
              operation,
            };
          }
          return {
            clientLocalId: existing || crypto.randomUUID(),
            ambiguous: candidates.length > 1,
            candidates,
          };
        };

        const writePending = async (
          record: Record<string, unknown>,
          resolved = resolveClientLocalId(record),
        ) => {
          const accountId = String(record.accountId || 'legacy-unassigned');
          const repositoryFullName = String(record.repositoryFullName || '');
          const title = String(record.title || 'Временная Issue');
          // Стабильный groupId для одинакового набора кандидатов
          const migrationGroupId = resolved.ambiguous
            ? getGroupId(resolved.candidates.map((c) => c.id))
            : undefined;
          const pending: PendingIssue = {
            clientLocalId: resolved.clientLocalId,
            repositoryFullName,
            accountId,
            title,
            body: String(record.body || ''),
            state: record.state === 'closed' ? 'closed' : 'open',
            derivedStatus:
              record.derivedStatus === 'in_progress' ||
              record.derivedStatus === 'done' ||
              record.derivedStatus === 'postponed'
                ? record.derivedStatus
                : 'todo',
            derivedPriority:
              record.derivedPriority === 'low' ||
              record.derivedPriority === 'medium' ||
              record.derivedPriority === 'high' ||
              record.derivedPriority === 'urgent'
                ? record.derivedPriority
                : 'none',
            labels: Array.isArray(record.labels) ? record.labels : [],
            assignees: Array.isArray(record.assignees)
              ? record.assignees.filter((value): value is string => typeof value === 'string')
              : [],
            createdAt: String(record.createdAt || new Date().toISOString()),
            updatedAt: String(record.updatedAt || record.createdAt || new Date().toISOString()),
            needsAttention: resolved.ambiguous || undefined,
            migrationDiagnostic: resolved.ambiguous
              ? 'Несколько legacy-операций остановлены. Проверьте GitHub и отмените группу перед повторным созданием.'
              : undefined,
            migrationGroupId,
          };
          await pendingTable.put(pending);
          if (resolved.operation) {
            await outboxTable.update(resolved.operation.id, {
              entityKey: resolved.clientLocalId,
              payload: {
                ...resolved.operation.payload,
                clientLocalId: resolved.clientLocalId,
              },
            });
          } else if (migrationGroupId) {
            const diagnostic =
              'Неоднозначная legacy-миграция: автоматическая отправка запрещена до ручной проверки.';
            for (const candidate of resolved.candidates) {
              await outboxTable.update(candidate.id, {
                state: 'attention',
                ambiguityRisk: true,
                migrationGroupId,
                lastError: diagnostic,
                nextAttemptAt: undefined,
                claimedAt: undefined,
                leaseOwner: undefined,
                leaseExpiresAt: undefined,
                updatedAt: new Date().toISOString(),
              });
            }
          }
          migrated.push({
            accountId,
            repositoryFullName,
            clientLocalId: resolved.clientLocalId,
            title,
          });
        };

        const existingPending = (await pendingTable.toArray()) as Array<Record<string, unknown>>;
        for (const record of existingPending) {
          const oldId = String(record.clientLocalId || '');
          const resolved = resolveClientLocalId(record);
          if (oldId && oldId !== resolved.clientLocalId) await pendingTable.delete(oldId);
          await writePending(record, resolved);
        }

        const temporaryIssues = (
          (await issuesTable.toArray()) as Array<Record<string, unknown>>
        ).filter((issue) => Number(issue.issueNumber) < 0);
        for (const issue of temporaryIssues) {
          await writePending(issue);
          await issuesTable.delete([issue.accountId, issue.repositoryFullName, issue.issueNumber]);
        }

        const tabs = (await tabsTable.toArray()) as WorkspaceTab[];
        const convertedTabs = tabs.map((tab) => {
          if (tab.entity.kind !== 'issue' || tab.entity.issueNumber >= 0) return tab;
          const repositoryFullName = tab.entity.repositoryFullName;
          const matches = migrated.filter(
            (entry) =>
              entry.accountId === (tab.accountId || 'legacy-unassigned') &&
              entry.repositoryFullName === repositoryFullName,
          );
          if (matches.length !== 1) {
            return { ...tab, entity: { kind: 'all' } as const, title: 'Все задачи' };
          }
          const entity = {
            kind: 'pending-issue' as const,
            repositoryFullName: matches[0]!.repositoryFullName,
            clientLocalId: matches[0]!.clientLocalId,
          };
          return { ...tab, entity, title: matches[0]!.title || titleForTabEntity(entity) };
        });

        const byAccount = new Map<string | null, WorkspaceTab[]>();
        for (const tab of convertedTabs) {
          const accountId = tab.accountId ?? null;
          byAccount.set(accountId, [...(byAccount.get(accountId) || []), tab]);
        }
        await tabsTable.clear();
        for (const [accountId, accountTabs] of byAccount) {
          await tabsTable.bulkPut(ensureDefaultTab(accountTabs, accountId));
        }
      });
  }
}

export const db = new KitsuFlowDatabase();

export async function clearLocalData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });
}
