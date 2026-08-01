import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Circle, CloudOff, GripVertical } from 'lucide-react';
import { PRIORITY_LABELS, STATUS_LABELS, type GitHubIssue, type LocalNote } from '../domain/types';
import { visibleLabels } from '../domain/github-mapping';
import { useAppStore } from '../state/app-store';

type Props = { item: LocalNote | GitHubIssue; kind: 'note' | 'issue'; compact?: boolean };

export function TaskRow({ item, kind, compact = false }: Props) {
  const setSelectedTask = useAppStore((state) => state.setSelectedTask);
  const openEntity = useAppStore((state) => state.openEntity);
  const key =
    kind === 'note'
      ? (item as LocalNote).id
      : `${(item as GitHubIssue).repositoryFullName}#${(item as GitHubIssue).issueNumber}`;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${kind}:${key}`,
    data: { type: kind, item },
  });
  const issue = kind === 'issue' ? (item as GitHubIssue) : null;
  const note = kind === 'note' ? (item as LocalNote) : null;
  const open = (newTab: boolean) =>
    void openEntity(
      note
        ? { kind: 'local-note', id: note.id }
        : {
            kind: 'issue',
            repositoryFullName: issue!.repositoryFullName,
            issueNumber: issue!.issueNumber,
          },
      { newTab, duplicate: newTab },
    );
  return (
    <div
      ref={setNodeRef}
      data-task-key={key}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.55 : 1 }}
      className={`task-row ${compact ? 'compact' : ''}`}
      tabIndex={0}
      onClick={(event) => {
        if (event.shiftKey) open(true);
        else setSelectedTask(note ? { kind: 'note', id: note.id } : { kind: 'issue', key });
      }}
      onDoubleClick={() => open(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open(event.shiftKey);
      }}
    >
      <button className="drag-handle" aria-label="Перетащить задачу" {...listeners} {...attributes}>
        <GripVertical size={13} />
      </button>
      <Circle size={11} className={`status-dot status-${note?.status || issue?.derivedStatus}`} />
      <span className="task-title">{item.title}</span>
      {issue && (
        <span
          className={`priority-dot priority-${issue.derivedPriority}`}
          title={PRIORITY_LABELS[issue.derivedPriority]}
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
      {item.syncState !== 'synced' && item.syncState !== 'local' && (
        <span className={`sync-state ${item.syncState}`}>
          <CloudOff size={12} /> {item.syncState}
        </span>
      )}
      {!compact && <small>{note ? STATUS_LABELS[note.status] : `#${issue?.issueNumber}`}</small>}
    </div>
  );
}
