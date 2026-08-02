import { useDroppable } from '@dnd-kit/core';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type IssuePriority,
  type TaskStatus,
} from '../domain/types';
import { useAppStore } from '../state/app-store';
import { TaskRow } from './TaskRow';
import { useShallow } from 'zustand/react/shallow';

const PRIORITIES: IssuePriority[] = ['none', 'low', 'medium', 'high', 'urgent'];
const SECTIONS: TaskStatus[] = ['in_progress', 'todo', 'done', 'postponed', 'question'];

function DropColumn({
  repositoryFullName,
  status,
  priority,
  children,
}: {
  repositoryFullName: string;
  status: Exclude<TaskStatus, 'question'>;
  priority: IssuePriority;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `priority:${repositoryFullName}:${status}:${priority}`,
    data: { type: 'priority', repositoryFullName, status, priority },
  });
  return (
    <div ref={setNodeRef} className={`priority-column ${isOver ? 'drop-target' : ''}`}>
      <h3>
        <span className={`priority-dot priority-${priority}`} />
        {PRIORITY_LABELS[priority]}
      </h3>
      {children}
    </div>
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
    <div ref={setNodeRef} className={`question-list ${isOver ? 'drop-target' : ''}`}>
      {children}
    </div>
  );
}

export function RepositoryBoard({ repositoryFullName }: { repositoryFullName: string }) {
  const canWrite = useAppStore((state) =>
    Boolean(
      state.repositories.find((repository) => repository.fullName === repositoryFullName)
        ?.permissions.push,
    ),
  );
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
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(
    new Set(['done', 'postponed', 'question']),
  );
  const toggle = (status: TaskStatus) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  return (
    <div className="screen repository-board">
      <header className="screen-header">
        <div>
          <p className="eyebrow">Репозиторий</p>
          <h1>{repositoryFullName}</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => void refreshIssues(repositoryFullName)}>Обновить</button>
          <button
            className="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : 'Репозиторий доступен только для чтения'}
            onClick={() =>
              setCreateOpen(true, {
                initialRepositoryFullName: repositoryFullName,
              })
            }
          >
            <Plus size={15} /> Issue
          </button>
        </div>
      </header>
      {!canWrite && <p className="hint">Режим только для чтения: действия записи отключены.</p>}
      {SECTIONS.map((status) => {
        const sectionIssues = issues.filter((issue) => issue.derivedStatus === status);
        const sectionPendingIssues = pendingIssues.filter(
          (issue) => issue.derivedStatus === status,
        );
        const count =
          status === 'question' ? notes.length : sectionIssues.length + sectionPendingIssues.length;
        const isCollapsed = collapsed.has(status);
        return (
          <section className={`board-section section-${status}`} key={status}>
            <button
              className="section-heading"
              onClick={() => toggle(status)}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              <span className={`status-dot status-${status}`} />
              <strong>{STATUS_LABELS[status]}</strong>
              <b>{count}</b>
            </button>
            {!isCollapsed && status !== 'question' && (
              <div className="priority-grid">
                {PRIORITIES.map((priority) => (
                  <DropColumn
                    key={priority}
                    repositoryFullName={repositoryFullName}
                    status={status as Exclude<TaskStatus, 'question'>}
                    priority={priority}
                  >
                    {sectionIssues
                      .filter((issue) => issue.derivedPriority === priority)
                      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                      .map((issue) => (
                        <TaskRow key={issue.issueNumber} item={issue} kind="issue" />
                      ))}
                    {sectionPendingIssues
                      .filter((issue) => issue.derivedPriority === priority)
                      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                      .map((issue) => (
                        <TaskRow key={issue.clientLocalId} item={issue} kind="pending" />
                      ))}
                  </DropColumn>
                ))}
              </div>
            )}
            {!isCollapsed && status === 'question' && (
              <QuestionDrop repositoryFullName={repositoryFullName}>
                {notes.map((note) => (
                  <TaskRow key={note.id} item={note} kind="note" />
                ))}
              </QuestionDrop>
            )}
          </section>
        );
      })}
    </div>
  );
}
