import { useMemo, useState } from 'react';
import { Filter, Plus } from 'lucide-react';
import { STATUS_LABELS, type TaskStatus } from '../domain/types';
import { useAppStore } from '../state/app-store';
import { TaskRow } from './TaskRow';
import { useShallow } from 'zustand/react/shallow';

export function AllTasks() {
  const notes = useAppStore((state) => state.notes);
  const issues = useAppStore((state) => state.issues);
  const pendingIssues = useAppStore((state) => state.pendingIssues);
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repo) => repo.pinned)),
  );
  const setCreateOpen = useAppStore((state) => state.setCreateOpen);
  const [statuses, setStatuses] = useState<TaskStatus[]>(['todo', 'in_progress']);

  const localNotes = useMemo(
    () => notes.filter((note) => !note.repositoryFullName && statuses.includes(note.status)),
    [notes, statuses],
  );

  const pinnedRepoNames = useMemo(
    () => new Set(repositories.map((repo) => repo.fullName)),
    [repositories],
  );

  const pinnedIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          pinnedRepoNames.has(issue.repositoryFullName) && statuses.includes(issue.derivedStatus),
      ),
    [issues, pinnedRepoNames, statuses],
  );

  const pinnedPendingIssues = useMemo(
    () =>
      pendingIssues.filter(
        (issue) =>
          pinnedRepoNames.has(issue.repositoryFullName) && statuses.includes(issue.derivedStatus),
      ),
    [pendingIssues, pinnedRepoNames, statuses],
  );

  const toggle = (status: TaskStatus) =>
    setStatuses((current) =>
      current.includes(status) ? current.filter((item) => item !== status) : [...current, status],
    );

  const total = localNotes.length + pinnedIssues.length + pinnedPendingIssues.length;

  return (
    <div className="screen all-tasks">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Рабочее пространство</p>
          <h1>Все задачи</h1>
        </div>
        <button className="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={15} /> Создать <kbd>C</kbd>
        </button>
      </header>
      <div className="filter-row">
        <Filter size={14} />
        <span>Статусы</span>
        {(['todo', 'in_progress', 'done', 'postponed'] as TaskStatus[]).map((status) => (
          <button
            key={status}
            className={statuses.includes(status) ? 'selected' : ''}
            onClick={() => toggle(status)}
          >
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>
      {total === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">C</span>
          <h2>Список активной работы пуст</h2>
          <p>
            Нажмите клавишу <kbd>C</kbd>, чтобы создать первую локальную заметку.
          </p>
        </div>
      ) : (
        <div className="task-groups">
          {localNotes.length > 0 && (
            <section className="task-group">
              <h2>
                <span className="status-dot status-todo" /> Локальные заметки{' '}
                <b>{localNotes.length}</b>
              </h2>
              <div className="task-list">
                {localNotes.map((note) => (
                  <TaskRow key={note.id} kind="note" item={note} compact />
                ))}
              </div>
            </section>
          )}
          {repositories.map((repository) => {
            const repoIssues = pinnedIssues.filter(
              (issue) => issue.repositoryFullName === repository.fullName,
            );
            const repoPendingIssues = pinnedPendingIssues.filter(
              (issue) => issue.repositoryFullName === repository.fullName,
            );

            if (repoIssues.length === 0 && repoPendingIssues.length === 0) return null;

            return (
              <section className="task-group" key={repository.fullName}>
                <h2>
                  <span className="repo-mark">{repository.owner.slice(0, 1).toUpperCase()}</span>
                  {repository.fullName}
                  <b>{repoIssues.length + repoPendingIssues.length}</b>
                </h2>
                <div className="task-list">
                  {repoIssues.map((issue) => (
                    <TaskRow
                      key={`${issue.repositoryFullName}#${issue.issueNumber}`}
                      kind="issue"
                      item={issue}
                      compact
                    />
                  ))}
                  {repoPendingIssues.map((issue) => (
                    <TaskRow key={issue.clientLocalId} kind="pending" item={issue} compact />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
