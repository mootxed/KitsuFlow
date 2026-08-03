import { useMemo, useState } from 'react';
import { Filter, LayoutGrid, List, Plus, Search } from 'lucide-react';
import { STATUS_LABELS, type TaskStatus } from '../domain/types';
import { useAppStore } from '../state/app-store';
import { TaskRow } from './TaskRow';
import { RepositoryKanban } from './RepositoryBoard';
import { useShallow } from 'zustand/react/shallow';

export function AllTasks() {
  const notes = useAppStore((state) => state.notes);
  const issues = useAppStore((state) => state.issues);
  const pendingIssues = useAppStore((state) => state.pendingIssues);
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repo) => repo.pinned)),
  );
  const setCreateOpen = useAppStore((state) => state.setCreateOpen);

  const [viewMode, setViewMode] = useState<'list' | 'board'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [statuses, setStatuses] = useState<TaskStatus[]>(['todo', 'in_progress']);

  const pinnedRepoNames = useMemo(
    () => new Set(repositories.map((repo) => repo.fullName)),
    [repositories],
  );

  const localNotes = useMemo(
    () =>
      notes.filter(
        (note) =>
          !note.repositoryFullName &&
          statuses.includes(note.status) &&
          (!searchQuery ||
            note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            note.description.toLowerCase().includes(searchQuery.toLowerCase())),
      ),
    [notes, statuses, searchQuery],
  );

  const pinnedIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          pinnedRepoNames.has(issue.repositoryFullName) &&
          statuses.includes(issue.derivedStatus) &&
          (!searchQuery ||
            issue.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            issue.body.toLowerCase().includes(searchQuery.toLowerCase())),
      ),
    [issues, pinnedRepoNames, statuses, searchQuery],
  );

  const pinnedPendingIssues = useMemo(
    () =>
      pendingIssues.filter(
        (issue) =>
          pinnedRepoNames.has(issue.repositoryFullName) &&
          statuses.includes(issue.derivedStatus) &&
          (!searchQuery ||
            issue.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            issue.body.toLowerCase().includes(searchQuery.toLowerCase())),
      ),
    [pendingIssues, pinnedRepoNames, statuses, searchQuery],
  );

  const toggleStatus = (status: TaskStatus) =>
    setStatuses((current) =>
      current.includes(status) ? current.filter((item) => item !== status) : [...current, status],
    );

  const total = localNotes.length + pinnedIssues.length + pinnedPendingIssues.length;

  return (
    <div className="screen all-tasks">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Рабочее пространство</p>
          <h1 className="screen-title">Все задачи</h1>
        </div>
        <div className="header-actions">
          <div className="segmented">
            <button
              className={`btn ${viewMode === 'list' ? 'selected' : ''}`}
              onClick={() => setViewMode('list')}
            >
              <List
                size={14}
                style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }}
              />
              Список
            </button>
            <button
              className={`btn ${viewMode === 'board' ? 'selected' : ''}`}
              onClick={() => setViewMode('board')}
            >
              <LayoutGrid
                size={14}
                style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }}
              />
              Доска
            </button>
          </div>
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Создать <kbd>C</kbd>
          </button>
        </div>
      </header>

      <div className="toolbar">
        <label className="search-wrap">
          <span className="sr-only">Поиск по задачам</span>
          <Search size={16} className="search-icon" />
          <input
            className="input search-input"
            type="search"
            placeholder="Поиск по всем задачам..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>

        <div className="filter-row" style={{ margin: 0 }}>
          <Filter size={14} />
          {(['todo', 'in_progress', 'done', 'postponed'] as TaskStatus[]).map((status) => (
            <button
              key={status}
              className={`btn btn-sm ${statuses.includes(status) ? 'selected' : ''}`}
              onClick={() => toggleStatus(status)}
            >
              {STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </div>

      {viewMode === 'board' ? (
        <div className="all-board active">
          {repositories.length === 0 ? (
            <div className="empty-state visible">
              <div className="empty-mark">
                <LayoutGrid size={24} />
              </div>
              <h2>Нет закрепленных репозиториев</h2>
              <p>Закрепите репозитории в боковой панели, чтобы видеть их на общей доске.</p>
            </div>
          ) : (
            repositories.map((repo) => {
              const repoIssues = pinnedIssues.filter(
                (issue) => issue.repositoryFullName === repo.fullName,
              );
              const repoPendingIssues = pinnedPendingIssues.filter(
                (issue) => issue.repositoryFullName === repo.fullName,
              );
              const repoNotes = notes.filter(
                (note) => note.repositoryFullName === repo.fullName && note.status === 'question',
              );

              return (
                <section key={repo.fullName} className="repo-board-section" style={{ marginBottom: 32 }}>
                  <header className="group-heading" style={{ marginBottom: 16 }}>
                    <span className="repo-avatar">
                      {repo.owner.slice(0, 1).toUpperCase()}
                    </span>
                    <h2>{repo.fullName}</h2>
                    <span className="count">{repoIssues.length + repoPendingIssues.length}</span>
                  </header>
                  <RepositoryKanban
                    repositoryFullName={repo.fullName}
                    issues={repoIssues}
                    pendingIssues={repoPendingIssues}
                    notes={repoNotes}
                  />
                </section>
              );
            })
          )}
        </div>
      ) : (
        <div className="all-list">
          {total === 0 ? (
            <div className="empty-state visible">
              <div className="empty-mark">C</div>
              <h2>Список задач пуст</h2>
              <p>
                {searchQuery
                  ? 'По вашему запросу ничего не найдено.'
                  : 'Нажмите клавишу C, чтобы создать первую локальную заметку.'}
              </p>
            </div>
          ) : (
            <div className="all-groups">
              {localNotes.length > 0 && (
                <section className="list-card">
                  <header className="group-heading">
                    <span className="status-dot status-todo" />
                    <h2>Локальные заметки</h2>
                    <span className="count">{localNotes.length}</span>
                  </header>
                  <div className="col-list" style={{ padding: 8 }}>
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
                  <section className="list-card" key={repository.fullName}>
                    <header className="group-heading">
                      <span className="repo-avatar">
                        {repository.owner.slice(0, 1).toUpperCase()}
                      </span>
                      <h2>{repository.fullName}</h2>
                      <span className="count">{repoIssues.length + repoPendingIssues.length}</span>
                    </header>
                    <div className="col-list" style={{ padding: 8 }}>
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
      )}
    </div>
  );
}
