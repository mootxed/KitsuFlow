import { APP_CONFIG } from '../config';
import { db } from '../data/db';
import { assertAccountId } from '../domain/github-mapping';
import { createLocalNote } from '../domain/notes';
import type { GitHubIssue, OutboxOperation } from '../domain/types';
import { GitHubApi } from '../github/api';

export type SyncEvent =
  | { type: 'changed' }
  | { type: 'unauthorized' }
  | { type: 'rate-limited'; retryAt: string }
  | { type: 'permission-denied'; message: string };

export interface GitHubRequestError {
  status?: number;
  response?: {
    headers?: Record<string, string>;
    data?: {
      message?: string;
    };
  };
}

const errorStatus = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const s = (error as GitHubRequestError).status;
    return typeof s === 'number' ? s : undefined;
  }
  return undefined;
};

const errorHeaders = (error: unknown): Record<string, string> => {
  if (typeof error !== 'object' || error === null) return {};
  const resp = (error as GitHubRequestError).response;
  return resp?.headers ?? {};
};

const errorBody = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return '';
  const resp = (error as GitHubRequestError).response?.data;
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

export interface OutboxProcessorOptions {
  getApi: () => GitHubApi | null;
  getActiveAccountId: () => string | null;
  onEvent: (event: SyncEvent) => void;
  onIssueCreated?: ((tempId: string | number, realIssue: GitHubIssue) => Promise<void>) | undefined;
}

export class OutboxProcessor {
  private currentProcessPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly instanceId = crypto.randomUUID();

  private readonly getApi: () => GitHubApi | null;
  private readonly getActiveAccountId: () => string | null;
  private readonly onEvent: (event: SyncEvent) => void;
  private readonly onIssueCreated?:
    ((tempId: string | number, realIssue: GitHubIssue) => Promise<void>) | undefined;

  constructor(
    optionsOrGetApi: OutboxProcessorOptions | (() => GitHubApi | null),
    onEventOrGetActiveAccountId?: ((event: SyncEvent) => void) | (() => string | null),
    onIssueCreatedOrOnEvent?:
      | ((tempId: string | number, realIssue: GitHubIssue) => Promise<void>)
      | ((event: SyncEvent) => void),
    onIssueCreatedLegacy?: (tempId: string | number, realIssue: GitHubIssue) => Promise<void>,
  ) {
    if (typeof optionsOrGetApi === 'object' && optionsOrGetApi !== null) {
      this.getApi = optionsOrGetApi.getApi;
      this.getActiveAccountId = optionsOrGetApi.getActiveAccountId;
      this.onEvent = optionsOrGetApi.onEvent;
      this.onIssueCreated = optionsOrGetApi.onIssueCreated;
    } else {
      this.getApi = optionsOrGetApi as () => GitHubApi | null;
      if (
        typeof onEventOrGetActiveAccountId === 'function' &&
        onEventOrGetActiveAccountId.length === 0
      ) {
        this.getActiveAccountId = onEventOrGetActiveAccountId as () => string | null;
        this.onEvent = onIssueCreatedOrOnEvent as (event: SyncEvent) => void;
        this.onIssueCreated = onIssueCreatedLegacy;
      } else {
        this.getActiveAccountId = () => null;
        this.onEvent = onEventOrGetActiveAccountId as (event: SyncEvent) => void;
        this.onIssueCreated = onIssueCreatedOrOnEvent as (
          tempId: string | number,
          realIssue: GitHubIssue,
        ) => Promise<void>;
      }
    }
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
    assertAccountId(input.accountId);
    const now = new Date().toISOString();
    if (input.type === 'update_issue') {
      const existing = await db.outbox
        .where('entityKey')
        .equals(input.entityKey)
        .and(
          (op) =>
            op.type === 'update_issue' &&
            op.state !== 'syncing' &&
            op.accountId === input.accountId,
        )
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
      attemptCount: 0,
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
    const activeAccountId = this.getActiveAccountId();
    if (!activeAccountId) return;
    const api = this.getApi();
    if (!api) return;

    if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks?.request) {
      await navigator.locks.request(
        `kitsuflow_outbox_lock_${activeAccountId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return;
          await this.executeLoop(api, activeAccountId);
        },
      );
    } else {
      await this.executeLoop(api, activeAccountId);
    }
  }

  private async executeLoop(api: GitHubApi, activeAccountId: string): Promise<void> {
    await this.recoverStaleSyncing(activeAccountId);

    while (navigator.onLine && this.getApi() && this.getActiveAccountId() === activeAccountId) {
      const operations = await db.outbox
        .where('accountId')
        .equals(activeAccountId)
        .and((op) => op.state === 'pending' || op.state === 'failed')
        .sortBy('createdAt');

      const readyOperation = operations.find((op) => {
        if (op.state === 'failed' && op.nextAttemptAt) {
          return new Date(op.nextAttemptAt).getTime() <= Date.now();
        }
        return op.state === 'pending';
      });

      if (!readyOperation) break;

      const shouldContinue = await this.claimAndExecute(api, readyOperation.id, activeAccountId);
      if (!shouldContinue) break;
    }
  }

  private async recoverStaleSyncing(activeAccountId: string): Promise<void> {
    const syncingOps = await db.outbox
      .where('accountId')
      .equals(activeAccountId)
      .and((op) => op.state === 'syncing')
      .toArray();

    const now = Date.now();

    for (const op of syncingOps) {
      const leaseExpired = op.leaseExpiresAt ? new Date(op.leaseExpiresAt).getTime() <= now : true;
      if (!leaseExpired) continue;

      const isCreate = op.type === 'create_issue' || op.type === 'convert_note';
      if (isCreate) {
        if (
          (op.creationStage === 'issue_created' || op.creationStage === 'applying_final_state') &&
          op.createdIssueNumber
        ) {
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

    const activeAccountId = this.getActiveAccountId();
    if (!activeAccountId) return;

    const failedOps = await db.outbox
      .where('accountId')
      .equals(activeAccountId)
      .and((op) => op.state === 'failed')
      .toArray();

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

  private async claimAndExecute(
    api: GitHubApi,
    operationId: string,
    activeAccountId: string,
  ): Promise<boolean> {
    let claimedOperation: OutboxOperation | null = null;
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 30_000).toISOString();

    await db.transaction('rw', db.outbox, async () => {
      const op = await db.outbox.get(operationId);
      if (!op) return;
      if (op.accountId !== activeAccountId) return;
      if (op.state !== 'pending' && op.state !== 'failed') return;
      if (
        op.state === 'failed' &&
        op.nextAttemptAt &&
        new Date(op.nextAttemptAt).getTime() > Date.now()
      ) {
        return;
      }
      const isLeaseActive =
        op.leaseExpiresAt &&
        new Date(op.leaseExpiresAt).getTime() > Date.now() &&
        op.leaseOwner !== this.instanceId;
      if (isLeaseActive) return;

      const attemptCount = op.attemptCount + 1;
      const updated: Partial<OutboxOperation> = {
        state: 'syncing',
        requestStarted: true,
        attemptCount,
        claimedAt: now.toISOString(),
        leaseOwner: this.instanceId,
        leaseExpiresAt,
        updatedAt: now.toISOString(),
      };
      await db.outbox.update(op.id, updated);
      claimedOperation = { ...op, ...updated, attemptCount };
    });

    if (!claimedOperation) return true;

    return this.execute(api, claimedOperation);
  }

  private async execute(api: GitHubApi, operation: OutboxOperation): Promise<boolean> {
    assertAccountId(operation.accountId);
    let heartbeatInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
      void db.outbox
        .update(operation.id, {
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .catch(() => {});
    }, 10_000);

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
          createdIssue = { ...newIssue, accountId: operation.accountId };

          operation.creationStage = 'issue_created';
          operation.createdIssueNumber = issueNumber;
          operation.createdIssueNodeId = nodeId;

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

          const updatedIssue = await api.updateIssue(operation.repositoryFullName, issueNumber, {
            state: 'closed',
          });
          createdIssue = { ...updatedIssue, accountId: operation.accountId };
        } else if (!createdIssue) {
          // Прочитать актуальный Issue если POST был сделан ранее
          const fetched = await api.getIssues(operation.repositoryFullName);
          const found = fetched.find((i) => i.issueNumber === issueNumber);
          if (found) {
            createdIssue = { ...found, accountId: operation.accountId };
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
              accountId: operation.accountId,
            };
          }
        }

        const finalIssue: GitHubIssue = {
          ...createdIssue,
          accountId: assertAccountId(operation.accountId),
        };
        const clientLocalId = operation.payload.clientLocalId as string | undefined;

        await db.transaction(
          'rw',
          db.githubIssuesCache,
          db.pendingIssues,
          db.localNotes,
          db.outbox,
          db.tabs,
          async () => {
            // Удаляем временную карточку из pendingIssues по clientLocalId
            if (clientLocalId) {
              await db.pendingIssues.delete(clientLocalId);
            }

            await db.githubIssuesCache.put(finalIssue);

            if (operation.sourceNoteId) {
              await db.localNotes.delete(operation.sourceNoteId);
            }

            const accountTabs = await db.tabs
              .where('accountId')
              .equals(operation.accountId)
              .toArray();

            for (const tab of accountTabs) {
              if (
                tab.entity.kind === 'pending-issue' &&
                tab.entity.clientLocalId === clientLocalId
              ) {
                tab.entity = {
                  kind: 'issue',
                  repositoryFullName: finalIssue.repositoryFullName,
                  issueNumber: finalIssue.issueNumber,
                };
                tab.title = `${finalIssue.repositoryFullName.split('/')[1]} #${finalIssue.issueNumber}`;
                await db.tabs.put(tab);
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

        const finalIssue: GitHubIssue = {
          ...issue,
          accountId: assertAccountId(operation.accountId),
        };

        await db.transaction('rw', db.githubIssuesCache, db.outbox, async () => {
          await db.githubIssuesCache.put(finalIssue);
          await db.outbox.delete(operation.id);
        });
      } else if (operation.type === 'close_and_copy') {
        const issueNumber = Number(operation.payload.issueNumber);
        const issue = await api.updateIssue(operation.repositoryFullName, issueNumber, {
          state: 'closed',
        });
        const finalIssue: GitHubIssue = {
          ...issue,
          accountId: assertAccountId(operation.accountId),
        };

        const rawNote = operation.payload.note as Partial<GitHubIssue> & Record<string, unknown>;
        const note = createLocalNote({
          title: String(rawNote.title || issue.title),
          description: String(rawNote.description || issue.body),
          status: 'question',
          repositoryFullName: operation.repositoryFullName,
          localTags: Array.isArray(rawNote.localTags) ? (rawNote.localTags as string[]) : [],
          checklist: Array.isArray(rawNote.checklist) ? (rawNote.checklist as any) : [],
        });
        note.accountId = operation.accountId;

        await db.transaction('rw', db.githubIssuesCache, db.localNotes, db.outbox, async () => {
          await db.githubIssuesCache.put(finalIssue);
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
        // 403 = локальная ошибка конкретного репо/операции: переводим в attention и продолжаем
        const hint = 'Убедитесь, что GitHub App установлен с разрешением Issues: Read & write.';
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: `Отказано в доступе. ${hint}`,
          updatedAt: new Date().toISOString(),
        });
        this.onEvent({ type: 'permission-denied', message: hint });
        return true; // продолжаем обработку других операций
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

      const exhausted = operation.attemptCount >= APP_CONFIG.maxSyncAttempts;
      await db.outbox.update(operation.id, {
        state: exhausted ? 'exhausted' : 'failed',
        nextAttemptAt: exhausted
          ? undefined
          : new Date(
              Date.now() + Math.min(2 ** operation.attemptCount * 1000, 30_000),
            ).toISOString(),
        lastError: exhausted
          ? `Исчерпаны попытки (${operation.attemptCount}). Требуется ручной повтор. Последняя ошибка: ${message}`
          : message,
        updatedAt: new Date().toISOString(),
      });
      // exhausted — пропускаем и продолжаем очередь
      return true;
    } finally {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }
  }
}
