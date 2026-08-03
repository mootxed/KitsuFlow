import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Circle, Clock, CloudOff, GripVertical } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { visibleLabels } from '../domain/github-mapping';
import {
  OUTBOX_STATE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  SYNC_STATE_LABELS,
  type GitHubIssue,
  type LocalNote,
  type PendingIssue,
} from '../domain/types';
import { useAppStore } from '../state/app-store';

type Props =
  | { item: LocalNote; kind: 'note'; compact?: boolean }
  | { item: GitHubIssue; kind: 'issue'; compact?: boolean }
  | { item: PendingIssue; kind: 'pending'; compact?: boolean };

function getContrastTextColor(hexColor: string): string {
  const hex = hexColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2) || '00', 16);
  const g = parseInt(hex.substring(2, 4) || '00', 16);
  const b = parseInt(hex.substring(4, 6) || '00', 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 160 ? '#1f2937' : `#${hex}`;
}

export function TaskRow({ item, kind, compact = false }: Props) {
  const setSelectedTask = useAppStore((state) => state.setSelectedTask);
  const openEntity = useAppStore((state) => state.openEntity);
  const pending = kind === 'pending' ? item : null;
  const issue = kind === 'issue' ? item : null;
  const note = kind === 'note' ? item : null;

  const linkedOperation = useAppStore((state) =>
    pending
      ? state.outbox.find(
          (operation) =>
            operation.entityKey === pending.clientLocalId ||
            Boolean(
              pending.migrationGroupId && operation.migrationGroupId === pending.migrationGroupId,
            ),
        )
      : undefined,
  );

  const repo = useAppStore((state) =>
    issue ? state.repositories.find((r) => r.fullName === issue.repositoryFullName) : undefined,
  );

  const issueReadOnly = issue ? !repo || repo.permissions.push === false : false;
  const isDragDisabled = kind === 'pending' || issueReadOnly;

  const key =
    note?.id || pending?.clientLocalId || `${issue!.repositoryFullName}#${issue!.issueNumber}`;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${kind}:${key}`,
    data: { type: kind, item },
    disabled: isDragDisabled,
  });

  const wasDraggedRef = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDraggedRef.current = true;
    } else if (wasDraggedRef.current) {
      const timer = setTimeout(() => {
        wasDraggedRef.current = false;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isDragging]);

  const open = (newTab: boolean) =>
    void openEntity(
      note
        ? { kind: 'local-note', id: note.id }
        : pending
          ? {
              kind: 'pending-issue',
              repositoryFullName: pending.repositoryFullName,
              clientLocalId: pending.clientLocalId,
            }
          : {
              kind: 'issue',
              repositoryFullName: issue!.repositoryFullName,
              issueNumber: issue!.issueNumber,
            },
      { newTab, duplicate: newTab },
    );

  const handleClick = (event: React.MouseEvent) => {
    if (wasDraggedRef.current) {
      wasDraggedRef.current = false;
      return;
    }
    if (event.shiftKey) open(true);
    else if (note) setSelectedTask({ kind: 'note', id: note.id });
    else if (pending)
      setSelectedTask({ kind: 'pending-issue', clientLocalId: pending.clientLocalId });
    else setSelectedTask({ kind: 'issue', key });
  };

  const taskStatus = note?.status || issue?.derivedStatus || pending?.derivedStatus;
  const taskPriority = issue?.derivedPriority || pending?.derivedPriority;
  const synchronizedItem = note || issue;

  const description = note?.description || issue?.body || pending?.body || '';

  const issueLabels = issue ? visibleLabels(issue.labels) : [];
  const shownLabels = issueLabels.slice(0, 3);
  const extraLabelsCount = issueLabels.length - 3;

  const dragListeners = isDragDisabled ? {} : listeners;
  const dragAttributes = isDragDisabled ? {} : attributes;

  // Compact view (for AllTasks list)
  if (compact) {
    return (
      <div
        ref={setNodeRef}
        data-task-key={key}
        data-draggable={String(!isDragDisabled)}
        style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.55 : 1 }}
        className={`task-row compact ${pending ? 'pending-task' : ''} ${isDragging ? 'dragging' : ''}`}
        tabIndex={0}
        onClick={handleClick}
        onDoubleClick={() => open(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open(event.shiftKey);
          }
        }}
        {...dragListeners}
        {...dragAttributes}
      >
        {pending || issueReadOnly ? (
          <span
            className="drag-handle disabled"
            title={
              issueReadOnly
                ? 'Репозиторий доступен только для чтения'
                : 'Pending Issue нельзя перемещать'
            }
          >
            <Clock size={13} />
          </span>
        ) : (
          <span className="drag-handle" aria-hidden="true">
            <GripVertical size={13} />
          </span>
        )}
        <Circle size={9} className={`status-dot status-${taskStatus}`} />
        <span className="task-title">{item.title}</span>
        {taskPriority && taskPriority !== 'none' && (
          <span className={`tag tag-priority-${taskPriority}`}>
            {PRIORITY_LABELS[taskPriority]}
          </span>
        )}
        {issue &&
          visibleLabels(issue.labels)
            .slice(0, 2)
            .map((label) => (
              <span
                key={label.name}
                className="label"
                style={{ '--label-color': `#${label.color}` } as React.CSSProperties}
              >
                <span className="tag-label-text">{label.name}</span>
              </span>
            ))}
        {issue?.statusConflict || issue?.priorityConflict ? (
          <AlertTriangle size={14} className="warning" aria-label="Конфликт системных labels" />
        ) : null}
        {synchronizedItem &&
          synchronizedItem.syncState !== 'synced' &&
          synchronizedItem.syncState !== 'local' && (
            <span className={`sync-state ${synchronizedItem.syncState}`}>
              <CloudOff size={12} /> {SYNC_STATE_LABELS[synchronizedItem.syncState]}
            </span>
          )}
        {pending && (
          <span className={`sync-state ${linkedOperation?.state || 'attention'}`}>
            <CloudOff size={12} />{' '}
            {linkedOperation ? OUTBOX_STATE_LABELS[linkedOperation.state] : 'Требует проверки'}
          </span>
        )}
        <small className="issue-number">
          {pending ? 'Черновик' : note ? STATUS_LABELS[taskStatus!] : `#${issue?.issueNumber}`}
        </small>
      </div>
    );
  }

  // Full Kanban Card View
  return (
    <article
      ref={setNodeRef}
      data-task-key={key}
      data-draggable={String(!isDragDisabled)}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.55 : 1 }}
      className={`task-card ${pending ? 'pending-card' : ''} ${isDragging ? 'dragging' : ''}`}
      tabIndex={0}
      onClick={handleClick}
      onDoubleClick={() => open(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open(event.shiftKey);
        }
      }}
      {...dragListeners}
      {...dragAttributes}
    >
      {pending ? (
        <div className="pending-line">
          <Clock size={14} />
          {linkedOperation
            ? `${OUTBOX_STATE_LABELS[linkedOperation.state]}`
            : 'Ожидает синхронизации'}
        </div>
      ) : (
        <div className="task-kicker">
          <span>{note ? 'Локальная заметка' : issue?.repositoryFullName}</span>
          {issueReadOnly ? (
            <span className="drag-handle disabled" title="Репозиторий доступен только для чтения">
              <Clock size={13} />
            </span>
          ) : (
            <span className="drag-handle" aria-hidden="true" title="Перетащить">
              <GripVertical size={14} />
            </span>
          )}
        </div>
      )}

      <h3 className="task-title">{item.title}</h3>

      {description && <p className="task-desc">{description}</p>}

      <div className="task-tags">
        {taskPriority && taskPriority !== 'none' && (
          <span className={`tag tag-priority-${taskPriority}`}>
            {PRIORITY_LABELS[taskPriority]}
          </span>
        )}

        {shownLabels.map((label) => (
          <span
            key={label.name}
            className="tag tag-default"
            style={{
              backgroundColor: `#${label.color}20`,
              color: getContrastTextColor(label.color),
              border: `1px solid #${label.color}40`,
            }}
          >
            <span className="tag-label-text">{label.name}</span>
          </span>
        ))}

        {extraLabelsCount > 0 && <span className="tag tag-default">+{extraLabelsCount}</span>}

        {note &&
          note.localTags.map((tag) => (
            <span key={tag} className="tag tag-default">
              <span className="tag-label-text">{tag}</span>
            </span>
          ))}

        {note && <span className="tag tag-local">Локально</span>}

        {pending && <span className="tag tag-sync">Отправится в GitHub</span>}

        {(issue?.statusConflict || issue?.priorityConflict) && (
          <span className="tag tag-local" title="Конфликт системных меток">
            <AlertTriangle size={12} /> Конфликт
          </span>
        )}
      </div>

      <footer className="task-footer">
        {issue?.assignees && issue.assignees.length > 0 && issue.assignees[0] ? (
          <>
            <span className="mini-avatar">{issue.assignees[0].slice(0, 1).toUpperCase()}</span>
            <span>{issue.assignees[0]}</span>
          </>
        ) : (
          <span>{note ? note.repositoryFullName || 'Без репозитория' : 'Без исполнителя'}</span>
        )}
        <span className="issue-number">
          {pending ? 'Черновик' : note ? '' : `#${issue?.issueNumber}`}
        </span>
      </footer>
    </article>
  );
}
