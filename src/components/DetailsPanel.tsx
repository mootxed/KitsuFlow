import { Check, ExternalLink, GitPullRequestArrow, Save, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type GitHubIssue,
  type LocalNote,
  type TaskStatus,
} from '../domain/types';
import { visibleLabels } from '../domain/github-mapping';
import { useAppStore } from '../state/app-store';
import { useShallow } from 'zustand/react/shallow';

export function DetailsContent({
  note,
  issue,
  embedded = false,
}: {
  note?: LocalNote | undefined;
  issue?: GitHubIssue | undefined;
  embedded?: boolean;
}) {
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repo) => repo.pinned)),
  );
  const updateNote = useAppStore((state) => state.updateNote);
  const deleteNote = useAppStore((state) => state.deleteNote);
  const requestConversion = useAppStore((state) => state.requestConversion);
  const updateIssueFields = useAppStore((state) => state.updateIssueFields);
  const changeIssueStatus = useAppStore((state) => state.changeIssueStatus);
  const changeIssuePriority = useAppStore((state) => state.changeIssuePriority);
  const [title, setTitle] = useState(note?.title || issue?.title || '');
  const [body, setBody] = useState(note?.description || issue?.body || '');

  useEffect(() => {
    setTitle(note?.title || issue?.title || '');
    setBody(note?.description || issue?.body || '');
  }, [note?.id, issue?.nodeId, note?.title, issue?.title, note?.description, issue?.body]);

  if (note) {
    const save = () =>
      void updateNote(note.id, { title: title.trim() || note.title, description: body });
    return (
      <div className={`details-content ${embedded ? 'embedded' : ''}`}>
        <p className="eyebrow">Локальная заметка</p>
        <input
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Название заметки"
        />
        <label>
          Описание
          <textarea
            rows={embedded ? 12 : 7}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <div className="field-grid">
          <label>
            Статус
            <select
              value={note.status}
              onChange={(event) =>
                void updateNote(note.id, { status: event.target.value as TaskStatus })
              }
            >
              {(
                [
                  'todo',
                  'in_progress',
                  'done',
                  'postponed',
                  ...(note.repositoryFullName ? ['question'] : []),
                ] as TaskStatus[]
              ).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Репозиторий
            <select
              value={note.repositoryFullName || ''}
              onChange={(event) =>
                void updateNote(note.id, {
                  repositoryFullName: event.target.value || null,
                  status: event.target.value
                    ? 'question'
                    : note.status === 'question'
                      ? 'todo'
                      : note.status,
                })
              }
            >
              <option value="">Без репозитория</option>
              {repositories.map((repository) => (
                <option key={repository.fullName}>{repository.fullName}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Локальные теги
          <input
            value={note.localTags.join(', ')}
            onChange={(event) =>
              void updateNote(note.id, {
                localTags: event.target.value
                  .split(',')
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
        <label>
          Чек-лист
          <textarea
            value={note.checklist
              .map((item) => `${item.checked ? '[x]' : '[ ]'} ${item.text}`)
              .join('\n')}
            onChange={(event) =>
              void updateNote(note.id, {
                checklist: event.target.value
                  .split('\n')
                  .filter(Boolean)
                  .map((line, index) => ({
                    id: note.checklist[index]?.id || crypto.randomUUID(),
                    checked: /^\[x\]/i.test(line),
                    text: line.replace(/^\[[ x]\]\s*/i, ''),
                  })),
              })
            }
          />
        </label>
        <div className="details-actions">
          <button className="primary" onClick={save}>
            <Save size={14} /> Сохранить
          </button>
          <button onClick={() => requestConversion(note.id, note.repositoryFullName || undefined)}>
            <GitPullRequestArrow size={14} /> Превратить в Issue
          </button>
          <button
            className="danger"
            onClick={() => {
              if (window.confirm('Удалить локальную заметку?')) void deleteNote(note.id);
            }}
          >
            <Trash2 size={14} /> Удалить
          </button>
        </div>
      </div>
    );
  }
  if (!issue) return null;
  const save = () => void updateIssueFields(issue, { title: title.trim() || issue.title, body });
  return (
    <div className={`details-content ${embedded ? 'embedded' : ''}`}>
      <p className="eyebrow">
        {issue.repositoryFullName} · #{issue.issueNumber > 0 ? issue.issueNumber : 'ожидает'}
      </p>
      <input
        className="title-input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Название Issue"
      />
      <div className="field-grid">
        <label>
          Статус
          <select
            value={issue.derivedStatus}
            onChange={(event) => void changeIssueStatus(issue, event.target.value as any)}
          >
            {(['todo', 'in_progress', 'done', 'postponed'] as const).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Приоритет
          <select
            value={issue.derivedPriority}
            onChange={(event) => void changeIssuePriority(issue, event.target.value as any)}
          >
            {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Markdown body
        <textarea
          className="markdown-editor"
          rows={embedded ? 14 : 8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <div className="markdown-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </div>
      <div className="label-list">
        {visibleLabels(issue.labels).map((label) => (
          <span
            className="label"
            key={label.name}
            style={{ '--label-color': `#${label.color}` } as React.CSSProperties}
          >
            {label.name}
          </span>
        ))}
      </div>
      {(issue.statusConflict || issue.priorityConflict) && (
        <p className="conflict-notice">
          Обнаружены конфликтующие системные labels. Выберите правильные статус и приоритет выше,
          чтобы исправить конфликт явно.
        </p>
      )}
      {issue.assignees.length > 0 && (
        <p className="assignees">
          <Check size={13} /> {issue.assignees.join(', ')}
        </p>
      )}
      <p className={`sync-summary ${issue.syncState}`}>Синхронизация: {issue.syncState}</p>
      <div className="details-actions">
        <button className="primary" onClick={save}>
          <Save size={14} /> Сохранить
        </button>
        {issue.htmlUrl && (
          <a className="button" href={issue.htmlUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Открыть на GitHub
          </a>
        )}
      </div>
    </div>
  );
}

export function DetailsPanel() {
  const selected = useAppStore((state) => state.selectedTask);
  const note = useAppStore((state) =>
    selected?.kind === 'note' ? state.notes.find((item) => item.id === selected.id) : undefined,
  );
  const issue = useAppStore((state) =>
    selected?.kind === 'issue'
      ? state.issues.find(
          (item) => `${item.repositoryFullName}#${item.issueNumber}` === selected.key,
        )
      : undefined,
  );
  const setSelectedTask = useAppStore((state) => state.setSelectedTask);
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const key = selected.kind === 'note' ? selected.id : selected.key;
        setSelectedTask(null);
        window.setTimeout(
          () => document.querySelector<HTMLElement>(`[data-task-key="${key}"]`)?.focus(),
          0,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, setSelectedTask]);
  if (!selected) return null;
  const close = () => {
    const key = selected.kind === 'note' ? selected.id : selected.key;
    setSelectedTask(null);
    window.setTimeout(
      () => document.querySelector<HTMLElement>(`[data-task-key="${key}"]`)?.focus(),
      0,
    );
  };
  return (
    <aside className="details-panel" aria-label="Панель задачи">
      <button className="panel-close" aria-label="Закрыть панель" onClick={close}>
        <X size={16} />
      </button>
      <DetailsContent note={note} issue={issue} />
    </aside>
  );
}
