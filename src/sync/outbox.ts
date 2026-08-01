import { APP_CONFIG } from '../config';
import { db } from '../data/db';
import type { GitHubIssue, OutboxOperation } from '../domain/types';
import { GitHubApi } from '../github/api';
import { createLocalNote } from '../domain/notes';

export type SyncEvent =
  | { type: 'changed' }
  | { type: 'unauthorized' }
  | { type: 'rate-limited'; retryAt: string }
  | { type: 'permission-denied'; message: string };

const errorStatus = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;

const errorHeaders = (error: unknown): Record<string, string> => {
  if (typeof error !== 'object' || error === null) return {};
  const resp = (error as any).response;
  return resp?.headers ?? {};
};

const errorBody = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return '';
  const resp = (error as any).response?.data;
  if (typeof resp?.message === 'string') return resp.message.toLowerCase();
  return '';
};

function isRateLimit(status: number | undefined, error: unknown): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const headers = errorHeaders(error);
  const remaining = headers['x-ratelimit-remaining'];
  if (remaining === '0') return true;
  const body = errorBody(error);
  if (body.includes('rate limit') || body.includes('secondary rate')) return true;
  return false;
}

const retryAtFromError = (error: unknown): string => {
  const headers = errorHeaders(error);
  const retryAfter = Number(headers['retry-after'] || 0);
  if (retryAfter > 0) return new Date(Date.now() + retryAfter * 1000).toISOString();
  const epoch = Number(headers['x-ratelimit-reset'] || 0) * 1000;
  return new Date(epoch > Date.now() ? epoch : Date.now() + 60_000).toISOString();
};

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Ошибка синхронизации';
  return error.message.replace(/ghp_\S+|gho_\S+|Bearer\s+\S+/g, '[REDACTED]');
}

export class OutboxProcessor {
  private currentProcessPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly instanceId = crypto.randomUUID();

  constructor(
    private readonly getApi: () => GitHubApi | null,
    private readonly onEvent: (event: SyncEvent) => void,
    private readonly onIssueCreated?: (
      tempId: string | number,
      realIssue: GitHubIssue,
    ) => Promise<void>,
  ) {
    void this.restoreTimerFromDB();
  }

  public destroy(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async restoreTimerFromDB(): Promise<void> {
    await this.scheduleNextRetry();
  }

  async enqueue(
    input: Omit<
      OutboxOperation,
      'id' | 'state' | 'requestStarted' | 'attemptCount' | 'createdAt' | 'updatedAt'
    >,
  ): Promise<OutboxOperation> {
    const now = new Date().toISOString();
    if (input.type === 'update_issue') {
      const existing = await db.outbox
        .where('entityKey')
        .equals(input.entityKey)
        .and((operation) => operation.type === 'update_issue' && operation.state !== 'syncing')
        .last();
      if (existing) {
        const merged: OutboxOperation = {
          ...existing,
          payload: { ...existing.payload, ...input.payload },
          state: 'pending',
          updatedAt: now,
        };
        await db.outbox.put(merged);
        this.onEvent({ type: 'changed' });
        void this.process();
        return merged;
      }
    }

    const operation: OutboxOperation = {
      ...input,
      id: crypto.randomUUID(),
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      creationStage: 'not_started',
      createdAt: now,
      updatedAt: now,
    };
    await db.outbox.add(operation);
    this.onEvent({ type: 'changed' });
    void this.process();
    return operation;
  }

  async retry(id: string): Promise<void> {
    const existing = await db.outbox.get(id);
    if (!existing) return;

    await db.outbox.update(id, {
      state: 'pending',
      requestStarted: false,
      nextAttemptAt: undefined,
      lastError: undefined,
      claimedAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    });
    this.onEvent({ type: 'changed' });
    await this.process();
  }

  process(): Promise<void> {
    if (this.currentProcessPromise) {
      return this.currentProcessPromise;
    }

    this.currentProcessPromise = this.runLoop().finally(() => {
      this.currentProcessPromise = null;
      void this.scheduleNextRetry();
      this.onEvent({ type: 'changed' });
    });

    return this.currentProcessPromise;
  }

  private async runLoop(): Promise<void> {
    if (!navigator.onLine) return;
    const api = this.getApi();
    if (!api) return;

    if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks?.request) {
      await navigator.locks.request(
        'kitsuflow_outbox_lock',
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return;
          await this.executeLoop(api);
        },
      );
    } else {
      await this.executeLoop(api);
    }
  }

  private async executeLoop(api: GitHubApi): Promise<void> {
    await this.recoverStaleSyncing();

    while (navigator.onLine && this.getApi()) {
      const operations = await db.outbox
        .where('state')
        .anyOf('pending', 'failed')
        .sortBy('createdAt');

      const readyOperation = operations.find((op) => {
        if (op.state === 'failed' && op.nextAttemptAt) {
          return new Date(op.nextAttemptAt).getTime() <= Date.now();
        }
        return op.state === 'pending';
      });

      if (!readyOperation) break;

      const shouldContinue = await this.execute(api, readyOperation);
      if (!shouldContinue) break;
    }
  }

  private async recoverStaleSyncing(): Promise<void> {
    const syncingOps = await db.outbox.where('state').equals('syncing').toArray();
    const now = Date.now();

    for (const op of syncingOps) {
      const leaseExpired = op.leaseExpiresAt ? new Date(op.leaseExpiresAt).getTime() <= now : true;
      if (!leaseExpired) continue;

      const isCreate = op.type === 'create_issue' || op.type === 'convert_note';
      if (isCreate) {
        if (op.creationStage === 'issue_created' && op.createdIssueNumber) {
          await db.outbox.update(op.id, {
            state: 'pending',
            requestStarted: false,
            claimedAt: undefined,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            updatedAt: new Date().toISOString(),
          });
        } else if (op.requestStarted) {
          await db.outbox.update(op.id, {
            state: 'attention',
            lastError:
              'Операция создания прервана во время запроса. Проверьте GitHub перед повтором во избежание дубликата.',
            claimedAt: undefined,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            updatedAt: new Date().toISOString(),
          });
        } else {
          await db.outbox.update(op.id, {
            state: 'pending',
            claimedAt: undefined,
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            updatedAt: new Date().toISOString(),
          });
        }
      } else {
        await db.outbox.update(op.id, {
          state: 'pending',
          requestStarted: false,
          claimedAt: undefined,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async scheduleNextRetry(): Promise<void> {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    const failedOps = await db.outbox.where('state').equals('failed').toArray();

    const futureOps = failedOps.filter(
      (op) => op.nextAttemptAt && new Date(op.nextAttemptAt).getTime() > Date.now(),
    );

    if (futureOps.length === 0) return;

    futureOps.sort(
      (a, b) => new Date(a.nextAttemptAt!).getTime() - new Date(b.nextAttemptAt!).getTime(),
    );

    const earliest = futureOps[0];
    if (!earliest?.nextAttemptAt) return;

    const delay = Math.max(0, new Date(earliest.nextAttemptAt).getTime() - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.process();
    }, delay);
  }

  private async execute(api: GitHubApi, operation: OutboxOperation): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 30_000).toISOString();
    const attemptCount = operation.attemptCount + 1;

    await db.outbox.update(operation.id, {
      state: 'syncing',
      requestStarted: true,
      attemptCount,
      claimedAt: now.toISOString(),
      leaseOwner: this.instanceId,
      leaseExpiresAt,
      updatedAt: now.toISOString(),
    });

    try {
      if (operation.type === 'create_issue' || operation.type === 'convert_note') {
        let issueNumber = operation.createdIssueNumber;
        let nodeId = operation.createdIssueNodeId;
        let createdIssue: GitHubIssue | null = null;

        // ЭТАП 1: Выполнить POST только если issueNumber ещё не получен
        if (!issueNumber) {
          const newIssue = await api.createIssue(operation.repositoryFullName, {
            title: String(operation.payload.title || ''),
            body: String(operation.payload.body || ''),
            labels: (operation.payload.labels as string[]) || [],
            assignees: (operation.payload.assignees as string[]) || [],
          });

          issueNumber = newIssue.issueNumber;
          nodeId = newIssue.nodeId;
          createdIssue = newIssue;

          operation.creationStage = 'issue_created';
          operation.createdIssueNumber = issueNumber;
          operation.createdIssueNodeId = nodeId;

          // СРАЗУ сохранить номер и stage в outbox
          await db.outbox.update(operation.id, {
            creationStage: 'issue_created',
            createdIssueNumber: issueNumber,
            createdIssueNodeId: nodeId,
            updatedAt: new Date().toISOString(),
          });
        }

        // ЭТАП 2: PATCH для закрытия (если необходимо)
        const desiredState = operation.payload.state;
        if (desiredState === 'closed') {
          operation.creationStage = 'applying_final_state';
          await db.outbox.update(operation.id, {
            creationStage: 'applying_final_state',
            updatedAt: new Date().toISOString(),
          });

          createdIssue = await api.updateIssue(operation.repositoryFullName, issueNumber, {
            state: 'closed',
          });
        } else if (!createdIssue) {
          // Если POST был выполнен ранее, но PATCH не требовался — прочитать актуальный Issue
          const fetched = await api.getIssues(operation.repositoryFullName);
          const found = fetched.find((i) => i.issueNumber === issueNumber);
          if (found) {
            createdIssue = found;
          } else {
            createdIssue = {
              repositoryFullName: operation.repositoryFullName,
              nodeId: nodeId || '',
              issueNumber,
              title: String(operation.payload.title || ''),
              body: String(operation.payload.body || ''),
              state: 'open',
              derivedStatus: 'todo',
              derivedPriority: 'none',
              labels: [],
              assignees: (operation.payload.assignees as string[]) || [],
              htmlUrl: `https://github.com/${operation.repositoryFullName}/issues/${issueNumber}`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              cachedAt: new Date().toISOString(),
              syncState: 'synced',
              statusConflict: false,
              priorityConflict: false,
            };
          }
        }

        const finalIssue = createdIssue;
        const clientLocalId = operation.payload.clientLocalId as string | undefined;

        // Завершающая атомарная транзакция
        await db.transaction(
          'rw',
          db.githubIssuesCache,
          db.localNotes,
          db.outbox,
          db.tabs,
          async () => {
            if (clientLocalId) {
              await db.githubIssuesCache.where('clientLocalId').equals(clientLocalId).delete();
            }

            await db.githubIssuesCache.put(finalIssue);

            if (operation.sourceNoteId) {
              await db.localNotes.delete(operation.sourceNoteId);
            }

            // Обновить вкладки с временным номером/clientLocalId на настоящий issueNumber
            const allTabs = await db.tabs.toArray();

            for (const tab of allTabs) {
              if (
                tab.entity.kind === 'issue' &&
                tab.entity.repositoryFullName === finalIssue.repositoryFullName
              ) {
                if (
                  tab.entity.issueNumber < 0 ||
                  (clientLocalId && String(tab.entity.issueNumber) === clientLocalId)
                ) {
                  tab.entity.issueNumber = finalIssue.issueNumber;
                  tab.title = `${finalIssue.repositoryFullName.split('/')[1]} #${finalIssue.issueNumber}`;
                  await db.tabs.put(tab);
                }
              }
            }

            await db.outbox.delete(operation.id);
          },
        );

        if (this.onIssueCreated && clientLocalId) {
          await this.onIssueCreated(clientLocalId, finalIssue);
        }
      } else if (operation.type === 'update_issue') {
        const issueNumber = Number(operation.payload.issueNumber);
        const issue = await api.updateIssue(operation.repositoryFullName, issueNumber, {
          title: operation.payload.title as string | undefined,
          body: operation.payload.body as string | undefined,
          labels: operation.payload.labels as string[] | undefined,
          assignees: operation.payload.assignees as string[] | undefined,
          state: operation.payload.state as 'open' | 'closed' | undefined,
        });

        await db.transaction('rw', db.githubIssuesCache, db.outbox, async () => {
          await db.githubIssuesCache.put(issue);
          await db.outbox.delete(operation.id);
        });
      } else if (operation.type === 'close_and_copy') {
        const issueNumber = Number(operation.payload.issueNumber);
        const issue = await api.updateIssue(operation.repositoryFullName, issueNumber, {
          state: 'closed',
        });

        const rawNote = operation.payload.note as any;
        const note = createLocalNote({
          title: String(rawNote.title || issue.title),
          description: String(rawNote.description || issue.body),
          status: 'question',
          repositoryFullName: operation.repositoryFullName,
          localTags: Array.isArray(rawNote.localTags) ? rawNote.localTags : [],
          checklist: Array.isArray(rawNote.checklist) ? rawNote.checklist : [],
        });

        await db.transaction('rw', db.githubIssuesCache, db.localNotes, db.outbox, async () => {
          await db.githubIssuesCache.put(issue);
          await db.localNotes.add(note);
          await db.outbox.delete(operation.id);
        });
      }

      return true;
    } catch (error) {
      const status = errorStatus(error);
      const message = safeMessage(error);

      if (status === 401) {
        await db.outbox.update(operation.id, {
          state: 'failed',
          lastError: 'Сессия GitHub истекла. Войдите снова.',
          updatedAt: new Date().toISOString(),
        });
        this.onEvent({ type: 'unauthorized' });
        return false;
      }

      if (isRateLimit(status, error)) {
        const retryAt = retryAtFromError(error);
        await db.outbox.update(operation.id, {
          state: 'failed',
          nextAttemptAt: retryAt,
          lastError: `Лимит GitHub API. Повтор после ${new Date(retryAt).toLocaleTimeString()}`,
          updatedAt: new Date().toISOString(),
        });
        this.onEvent({ type: 'rate-limited', retryAt });
        return false;
      }

      if (status === 403) {
        const hint = 'Убедитесь, что GitHub App установлен с разрешением Issues: Read & write.';
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: `Отказано в доступе. ${hint}`,
          updatedAt: new Date().toISOString(),
        });
        this.onEvent({ type: 'permission-denied', message: hint });
        return false;
      }

      if (status === 404) {
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: 'Репозиторий или Issue не найден (404). Проверьте доступ.',
          updatedAt: new Date().toISOString(),
        });
        return true;
      }

      if (status === 422) {
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: `Ошибка данных GitHub (422): ${message}. Проверьте содержимое операции.`,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }

      const isCreate = operation.type === 'create_issue' || operation.type === 'convert_note';
      // Если POST завершился ошибкой и issueNumber ещё не создан -> перевести в attention
      if (
        isCreate &&
        (!operation.createdIssueNumber || operation.creationStage === 'not_started')
      ) {
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: `Неизвестно, создался ли Issue: ${message}. Проверьте GitHub перед повтором.`,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }

      // Для update или повтора PATCH в условном создании: exponential backoff до maxSyncAttempts, затем exhausted
      const exhausted = attemptCount >= APP_CONFIG.maxSyncAttempts;
      await db.outbox.update(operation.id, {
        state: exhausted ? 'exhausted' : 'failed',
        nextAttemptAt: exhausted
          ? undefined
          : new Date(Date.now() + Math.min(2 ** attemptCount * 1000, 30_000)).toISOString(),
        lastError: exhausted
          ? `Исчерпаны попытки (${attemptCount}). Требуется ручной повтор. Последняя ошибка: ${message}`
          : message,
        updatedAt: new Date().toISOString(),
      });
      return true;
    }
  }
}
