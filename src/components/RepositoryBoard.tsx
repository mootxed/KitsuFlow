import { useDroppable } from '@dnd-kit/core';
import { CheckCircle2, Clock, HelpCircle, Plus, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { STATUS_LABELS, type TaskStatus } from '../domain/types';
import { useAppStore } from '../state/app-store';
import { TaskRow } from './TaskRow';
import { useShallow } from 'zustand/react/shallow';

const KANBAN_STATUSES: Array<{
  status: Exclude<TaskStatus, 'question'>;
  colClass: string;
  icon: React.ReactNode;
}> = [
  {
    status: 'todo',
    colClass: 'col-todo',
    icon: (
      <svg
        className="icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="8" />
      </svg>
    ),
  },
  {
    status: 'in_progress',
    colClass: 'col-progress',
    icon: (
      <svg
        className="icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v8" />
      </svg>
    ),
  },
  {
    status: 'postponed',
    colClass: 'col-postponed',
    icon: <Clock size={18} />,
  },
  {
    status: 'done',
    colClass: 'col-done',
    icon: <CheckCircle2 size={18} />,
  },
];

function DropColumn({
  repositoryFullName,
  status,
  colClass,
  icon,
  count,
  children,
}: {
  repositoryFullName: string;
  status: Exclude<TaskStatus, 'question'>;
  colClass: string;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `status:${repositoryFullName}:${status}`,
    data: { type: 'status', repositoryFullName, status },
  });

  return (
    <section ref={setNodeRef} className={`kanban-col ${colClass} ${isOver ? 'drop-target' : ''}`}>
      <header className="col-header">
        <span className="col-status-icon">{icon}</span>
        <h2 className="col-name">{STATUS_LABELS[status]}</h2>
        <span className="col-count">{count}</span>
      </header>
      <div className="col-list">{children}</div>
    </section>
  );
}

function QuestionDrop({
  repositoryFullName,
  children,
}: {
  repositoryFullName: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `status:${repositoryFullName}:question`,
    data: { type: 'status', repositoryFullName, status: 'question' },
  });

  return (
    <section ref={setNodeRef} className={`question-shelf ${isOver ? 'drop-target' : ''}`}>
      <div className="question-heading">
        <h2>
          <HelpCircle
            size={18}
            style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }}
          />
          Под вопросом
        </h2>
        <p>Локальные заметки и идеи, требующие уточнения</p>
      </div>
      <div className="question-list">{children}</div>
    </section>
  );
}

export function RepositoryBoard({ repositoryFullName }: { repositoryFullName: string }) {
  const [searchQuery, setSearchQuery] = useState('');

  const repository = useAppStore((state) =>
    state.repositories.find((r) => r.fullName === repositoryFullName),
  );
  const canWrite = Boolean(repository?.permissions.push);

  const issues = useAppStore(
    useShallow((state) =>
      state.issues.filter((issue) => issue.repositoryFullName === repositoryFullName),
    ),
  );

  const pendingIssues = useAppStore(
    useShallow((state) =>
      state.pendingIssues.filter((issue) => issue.repositoryFullName === repositoryFullName),
    ),
  );

  const notes = useAppStore(
    useShallow((state) =>
      state.notes.filter(
        (note) => note.repositoryFullName === repositoryFullName && note.status === 'question',
      ),
    ),
  );

  const setCreateOpen = useAppStore((state) => state.setCreateOpen);
  const refreshIssues = useAppStore((state) => state.refreshIssues);

  const filteredIssues = issues.filter(
    (issue) =>
      !searchQuery ||
      issue.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      issue.body.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const filteredPending = pendingIssues.filter(
    (issue) =>
      !searchQuery ||
      issue.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      issue.body.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const filteredNotes = notes.filter(
    (note) =>
      !searchQuery ||
      note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      note.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const totalCount = issues.length + pendingIssues.length + notes.length;

  return (
    <div className="screen repository-board" id="repo-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Репозиторий</p>
          <h1 className="screen-title">{repository?.name || repositoryFullName}</h1>
          <p className="screen-meta">
            <span>{repositoryFullName}</span>
            <span className="meta-dot">•</span>
            <span>{totalCount} задач</span>
          </p>
          <div className="repo-sync">
            <span className="sync-state">
              <span className="sync-dot" />
              <span>Все изменения сохранены</span>
            </span>
            {pendingIssues.length > 0 && (
              <span className="pending-badge">
                <Clock size={13} />
                {pendingIssues.length} ожидает отправки
              </span>
            )}
          </div>
        </div>
        <div className="header-actions">
          <button
            className="btn sync-button"
            onClick={() => void refreshIssues(repositoryFullName)}
          >
            <RefreshCw size={14} />
            <span>Обновить</span>
          </button>
          <button
            className="btn btn-primary open-create"
            disabled={!canWrite}
            title={canWrite ? undefined : 'Репозиторий доступен только для чтения'}
            onClick={() =>
              setCreateOpen(true, {
                initialRepositoryFullName: repositoryFullName,
              })
            }
          >
            <Plus size={16} />
            Создать задачу
          </button>
        </div>
      </header>

      {!canWrite && (
        <p className="conflict-notice" style={{ marginBottom: 16 }}>
          Режим только для чтения: добавление и изменения отключены для текущего токена.
        </p>
      )}

      <div className="toolbar">
        <label className="search-wrap">
          <span className="sr-only">Поиск по задачам</span>
          <Search size={16} className="search-icon" />
          <input
            className="input search-input board-search"
            type="search"
            placeholder="Поиск по задачам..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
      </div>

      <div className="board-scroll">
        <div className="kanban">
          {KANBAN_STATUSES.map(({ status, colClass, icon }) => {
            const sectionIssues = filteredIssues.filter((i) => i.derivedStatus === status);
            const sectionPending = filteredPending.filter((p) => p.derivedStatus === status);
            const count = sectionIssues.length + sectionPending.length;

            return (
              <DropColumn
                key={status}
                repositoryFullName={repositoryFullName}
                status={status}
                colClass={colClass}
                icon={icon}
                count={count}
              >
                {sectionIssues
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map((issue) => (
                    <TaskRow
                      key={`${issue.repositoryFullName}#${issue.issueNumber}`}
                      item={issue}
                      kind="issue"
                    />
                  ))}
                {sectionPending
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map((issue) => (
                    <TaskRow key={issue.clientLocalId} item={issue} kind="pending" />
                  ))}
              </DropColumn>
            );
          })}
        </div>
      </div>

      <QuestionDrop repositoryFullName={repositoryFullName}>
        {filteredNotes.map((note) => (
          <TaskRow key={note.id} item={note} kind="note" />
        ))}
      </QuestionDrop>
    </div>
  );
}
