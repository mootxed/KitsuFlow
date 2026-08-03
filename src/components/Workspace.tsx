import { AlertCircle, CloudOff, Inbox, RefreshCw } from 'lucide-react';
import { useAppStore } from '../state/app-store';
import { OUTBOX_STATE_LABELS, OUTBOX_TYPE_LABELS } from '../domain/types';
import { AllTasks } from './AllTasks';
import { PendingIssueContent } from './PendingIssueDocument';
import { RepositoryBoard } from './RepositoryBoard';
import { TaskDocument } from './TaskDocument';

export function Workspace() {
  const tabs = useAppStore((state) => state.tabs);
  const online = useAppStore((state) => state.online);
  const stale = useAppStore((state) => state.stale);
  const error = useAppStore((state) => state.error);
  const outbox = useAppStore((state) => state.outbox);
  const pendingIssues = useAppStore((state) => state.pendingIssues);
  const refreshIssues = useAppStore((state) => state.refreshIssues);
  const retryOperation = useAppStore((state) => state.retryOperation);
  const active = tabs.find((tab) => tab.active)?.entity || { kind: 'all' as const };

  const problematicOps = outbox.filter(
    (operation) =>
      operation.state === 'failed' ||
      operation.state === 'attention' ||
      operation.state === 'exhausted',
  );

  const activePendingIssue =
    active.kind === 'pending-issue'
      ? pendingIssues.find((p) => p.clientLocalId === active.clientLocalId)
      : undefined;

  return (
    <section className="workspace">
      <div className="state-strip">
        {!online && (
          <span>
            <CloudOff size={13} /> Офлайн — GitHub данные могут быть устаревшими
          </span>
        )}
        {online && stale && (
          <span>
            <RefreshCw size={13} /> Показан кеш
          </span>
        )}
        {outbox.length > 0 && (
          <span>
            <Inbox size={13} /> В очереди: {outbox.length}
          </span>
        )}
        {error && (
          <span className="error">
            <AlertCircle size={13} /> {error}
          </span>
        )}
        <button className="btn icon-btn" aria-label="Обновить" onClick={() => void refreshIssues()}>
          <RefreshCw size={13} />
        </button>
      </div>

      {problematicOps.length > 0 && (
        <details className="sync-queue" open>
          <summary>Операции outbox, требующие внимания ({problematicOps.length})</summary>
          {problematicOps.map((operation) => {
            const isFutureAutoRetry =
              operation.state === 'failed' &&
              operation.nextAttemptAt &&
              new Date(operation.nextAttemptAt).getTime() > Date.now();

            return (
              <div key={operation.id} className={`outbox-op state-${operation.state}`}>
                <span>
                  <strong>{operation.repositoryFullName}</strong> (
                  {OUTBOX_TYPE_LABELS[operation.type]})
                  <small>{operation.lastError || 'Синхронизация не завершена'}</small>
                  {operation.attemptCount > 0 && (
                    <small> • Попыток: {operation.attemptCount}</small>
                  )}
                  <small> • {OUTBOX_STATE_LABELS[operation.state]}</small>
                  {isFutureAutoRetry && (
                    <small className="auto-retry">
                      {' '}
                      • Автоповтор в {new Date(operation.nextAttemptAt!).toLocaleTimeString()}
                    </small>
                  )}
                </span>
                {!operation.ambiguityRisk &&
                  (!isFutureAutoRetry || operation.state === 'exhausted') && (
                    <button className="btn btn-sm" onClick={() => void retryOperation(operation.id)}>
                      {operation.state === 'exhausted' ? 'Повторить вручную' : 'Повторить'}
                    </button>
                  )}
              </div>
            );
          })}
        </details>
      )}


      {active.kind === 'all' && <AllTasks />}
      {active.kind === 'repository' && (
        <RepositoryBoard repositoryFullName={active.repositoryFullName} />
      )}
      {(active.kind === 'local-note' || active.kind === 'issue') && (
        <TaskDocument entity={active} />
      )}
      {active.kind === 'pending-issue' && activePendingIssue && (
        <div className="task-document">
          <PendingIssueContent pending={activePendingIssue} embedded />
        </div>
      )}
      {active.kind === 'pending-issue' && !activePendingIssue && (
        <div className="empty-state">
          <h2>Задача создана</h2>
          <p>Issue успешно отправлен на GitHub. Обновите список для просмотра.</p>
        </div>
      )}
    </section>
  );
}
