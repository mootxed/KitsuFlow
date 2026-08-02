import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Circle, Clock, CloudOff, GripVertical } from 'lucide-react';
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
  const issueReadOnly = useAppStore((state) =>
    issue
      ? state.repositories.find((repository) => repository.fullName === issue.repositoryFullName)
          ?.permissions.push === false
      : false,
  );
  const key =
    note?.id || pending?.clientLocalId || `${issue!.repositoryFullName}#${issue!.issueNumber}`;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${kind}:${key}`,
    data: { type: kind, item },
    disabled: kind === 'pending' || issueReadOnly,
  });
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
  const taskStatus = note?.status || issue?.derivedStatus || pending?.derivedStatus;
  const taskPriority = issue?.derivedPriority || pending?.derivedPriority;
  const synchronizedItem = note || issue;
  return (
    <div
      ref={setNodeRef}
      data-task-key={key}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.55 : 1 }}
      className={`task-row ${compact ? 'compact' : ''} ${pending ? 'pending-task' : ''}`}
      tabIndex={0}
      onClick={(event) => {
        if (event.shiftKey) open(true);
        else if (note) setSelectedTask({ kind: 'note', id: note.id });
        else if (pending)
          setSelectedTask({ kind: 'pending-issue', clientLocalId: pending.clientLocalId });
        else setSelectedTask({ kind: 'issue', key });
      }}
      onDoubleClick={() => open(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open(event.shiftKey);
      }}
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
        <button
          className="drag-handle"
          aria-label="Перетащить задачу"
          {...listeners}
          {...attributes}
        >
          <GripVertical size={13} />
        </button>
      )}
      <Circle size={11} className={`status-dot status-${taskStatus}`} />
      <span className="task-title">{item.title}</span>
      {taskPriority && (
        <span
          className={`priority-dot priority-${taskPriority}`}
          title={PRIORITY_LABELS[taskPriority]}
        />
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
              {label.name}
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
      {!compact && (
        <small>{pending || note ? STATUS_LABELS[taskStatus!] : `#${issue?.issueNumber}`}</small>
      )}
    </div>
  );
}
