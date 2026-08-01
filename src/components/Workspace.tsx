import { AlertCircle, CloudOff, Inbox, RefreshCw } from 'lucide-react';
import { useAppStore } from '../state/app-store';
import { AllTasks } from './AllTasks';
import { RepositoryBoard } from './RepositoryBoard';
import { TaskDocument } from './TaskDocument';

export function Workspace() {
  const tabs = useAppStore((state) => state.tabs);
  const online = useAppStore((state) => state.online);
  const stale = useAppStore((state) => state.stale);
  const error = useAppStore((state) => state.error);
  const outbox = useAppStore((state) => state.outbox);
  const refreshIssues = useAppStore((state) => state.refreshIssues);
  const retryOperation = useAppStore((state) => state.retryOperation);
  const active = tabs.find((tab) => tab.active)?.entity || { kind: 'all' as const };
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
        <button aria-label="Обновить" onClick={() => void refreshIssues()}>
          <RefreshCw size={13} />
        </button>
      </div>
      {outbox.some(
        (operation) => operation.state === 'failed' || operation.state === 'attention',
      ) && (
        <details className="sync-queue">
          <summary>Операции, требующие внимания</summary>
          {outbox
            .filter((operation) => operation.state === 'failed' || operation.state === 'attention')
            .map((operation) => (
              <div key={operation.id}>
                <span>
                  <strong>{operation.repositoryFullName}</strong>
                  <small>{operation.lastError || 'Синхронизация не завершена'}</small>
                </span>
                <button onClick={() => void retryOperation(operation.id)}>Повторить</button>
              </div>
            ))}
        </details>
      )}
      {active.kind === 'all' && <AllTasks />}
      {active.kind === 'repository' && (
        <RepositoryBoard repositoryFullName={active.repositoryFullName} />
      )}
      {(active.kind === 'local-note' || active.kind === 'issue') && (
        <TaskDocument entity={active} />
      )}
    </section>
  );
}
