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

/** Определяет, является ли ошибка rate-limit (а не permission denied). */
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

/** Формирует человекочитаемое описание ошибки без токена. */
function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Ошибка синхронизации';
  // Никогда не включаем токен в сообщение об ошибке
  const msg = error.message.replace(/ghp_\S+|gho_\S+|Bearer\s+\S+/g, '[REDACTED]');
  return msg;
}

export class OutboxProcessor {
  private running = false;

  constructor(
    private readonly getApi: () => GitHubApi | null,
    private readonly onEvent: (event: SyncEvent) => void,
  ) {}

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
        const merged = {
          ...existing,
          payload: { ...existing.payload, ...input.payload },
          state: 'pending' as const,
          updatedAt: now,
        };
        await db.outbox.put(merged);
        this.onEvent({ type: 'changed' });
        return merged;
      }
    }
    const operation: OutboxOperation = {
      ...input,
      id: crypto.randomUUID(),
      state: 'pending',
      requestStarted: false,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.outbox.add(operation);
    this.onEvent({ type: 'changed' });
    return operation;
  }

  /**
   * Сбрасывает операцию в состояние pending для ручного повтора.
   * Работает для состояний failed, attention и exhausted.
   */
  async retry(id: string): Promise<void> {
    await db.outbox.update(id, {
      state: 'pending',
      requestStarted: false,
      nextAttemptAt: undefined,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    });
    await this.process();
  }

  async process(): Promise<void> {
    if (this.running || !navigator.onLine) return;
    const api = this.getApi();
    if (!api) return;
    this.running = true;
    try {
      // Выбираем только pending и failed с допустимым nextAttemptAt.
      // attention и exhausted НЕ выбираются — только через retry().
      const operations = await db.outbox
        .where('state')
        .anyOf('pending', 'failed')
        .sortBy('createdAt');
      for (const operation of operations) {
        // Пропускаем failed, у которых ещё не наступило время повтора
        if (operation.nextAttemptAt && new Date(operation.nextAttemptAt).getTime() > Date.now())
          continue;
        const shouldContinue = await this.execute(api, operation);
        if (!shouldContinue) break;
      }
    } finally {
      this.running = false;
      this.onEvent({ type: 'changed' });
    }
  }

  private async execute(api: GitHubApi, operation: OutboxOperation): Promise<boolean> {
    // Инкрементируем attemptCount один раз — здесь, перед попыткой.
    const attemptCount = operation.attemptCount + 1;
    await db.outbox.update(operation.id, {
      state: 'syncing',
      requestStarted: true,
      attemptCount,
      updatedAt: new Date().toISOString(),
    });
    try {
      if (operation.type === 'create_issue' || operation.type === 'convert_note') {
        const issue = await api.createIssue(operation.repositoryFullName, {
          title: String(operation.payload.title || ''),
          body: String(operation.payload.body || ''),
          labels: (operation.payload.labels as string[]) || [],
          assignees: (operation.payload.assignees as string[]) || [],
        });
        const desiredState = operation.payload.state;
        const finalIssue: GitHubIssue =
          desiredState === 'closed'
            ? await api.updateIssue(issue.repositoryFullName, issue.issueNumber, {
                state: 'closed',
              })
            : issue;
        await db.transaction('rw', db.githubIssuesCache, db.localNotes, db.outbox, async () => {
          const clientLocalId = operation.payload.clientLocalId;
          if (typeof clientLocalId === 'string') {
            await db.githubIssuesCache.where('clientLocalId').equals(clientLocalId).delete();
          }
          await db.githubIssuesCache.put(finalIssue);
          if (operation.sourceNoteId) await db.localNotes.delete(operation.sourceNoteId);
          await db.outbox.delete(operation.id);
        });
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

      // 401 — сессия истекла
      if (status === 401) {
        await db.outbox.update(operation.id, {
          state: 'failed',
          lastError: 'Сессия GitHub истекла. Войдите снова.',
          updatedAt: new Date().toISOString(),
        });
        this.onEvent({ type: 'unauthorized' });
        return false;
      }

      // Rate limit: 429 или 403 с x-ratelimit-remaining=0
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

      // 403 без признаков rate limit — недостаточно разрешений
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

      // 404 — репозиторий или Issue недоступен
      if (status === 404) {
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: 'Репозиторий или Issue не найден (404). Проверьте доступ.',
          updatedAt: new Date().toISOString(),
        });
        return true;
      }

      // 422 — ошибка в данных или конфликт GitHub API
      if (status === 422) {
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: `Ошибка данных GitHub (422): ${message}. Проверьте содержимое операции.`,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }

      // Для create/convert — неопределённость: возможно Issue создался
      const isCreate = operation.type === 'create_issue' || operation.type === 'convert_note';
      if (isCreate) {
        await db.outbox.update(operation.id, {
          state: 'attention',
          lastError: `Неизвестно, создался ли Issue: ${message}. Проверьте GitHub перед повтором.`,
          updatedAt: new Date().toISOString(),
        });
        return true;
      }

      // Для update: exponential backoff до maxSyncAttempts, затем exhausted
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
