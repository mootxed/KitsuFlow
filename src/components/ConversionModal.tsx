import { ArrowRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type IssuePriority,
  type TaskStatus,
} from '../domain/types';
import { useAppStore } from '../state/app-store';
import { useShallow } from 'zustand/react/shallow';

export function ConversionModal() {
  const noteId = useAppStore((state) => state.conversionNoteId);
  const note = useAppStore((state) => state.notes.find((item) => item.id === noteId));
  const targetRepository = useAppStore((state) => state.conversionRepositoryFullName);
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repo) => repo.pinned)),
  );
  const setNoteId = useAppStore((state) => state.setConversionNoteId);
  const confirm = useAppStore((state) => state.confirmConversion);
  const [repository, setRepository] = useState('');
  const [status, setStatus] = useState<Exclude<TaskStatus, 'question'>>('todo');
  const [priority, setPriority] = useState<IssuePriority>('none');
  const [labels, setLabels] = useState('');
  const [assignee, setAssignee] = useState('');
  const initialRepository =
    targetRepository || note?.repositoryFullName || repositories[0]?.fullName || '';
  useEffect(() => {
    if (note) setRepository(initialRepository);
  }, [note, initialRepository]);
  if (!noteId || !note) return null;
  return (
    <div className="modal-backdrop">
      <form
        className="modal conversion-modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (repository)
            void confirm({
              repositoryFullName: repository,
              status,
              priority,
              labels: labels
                .split(',')
                .map((label) => label.trim())
                .filter(Boolean),
              assignees: assignee ? [assignee] : [],
            });
        }}
      >
        <header>
          <span>
            <ArrowRight size={16} /> Преобразовать в GitHub Issue
          </span>
          <button type="button" aria-label="Отмена" onClick={() => setNoteId(null)}>
            <X size={16} />
          </button>
        </header>
        <div className="conversion-preview">
          <small>Предпросмотр</small>
          <strong>{note.title}</strong>
          <p>{note.description || 'Без описания'}</p>
          {note.checklist.length > 0 && <span>{note.checklist.length} пунктов чек-листа</span>}
        </div>
        <label>
          Репозиторий
          <select
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            required
          >
            <option value="" disabled>
              Выберите репозиторий
            </option>
            {repositories.map((repo) => (
              <option key={repo.fullName}>{repo.fullName}</option>
            ))}
          </select>
        </label>
        <div className="field-grid">
          <label>
            Будущий статус
            <select value={status} onChange={(event) => setStatus(event.target.value as any)}>
              {(['todo', 'in_progress', 'done', 'postponed'] as const).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Приоритет
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as IssuePriority)}
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
          GitHub labels
          <input
            value={labels}
            onChange={(event) => setLabels(event.target.value)}
            placeholder="Только существующие labels"
          />
        </label>
        <label>
          Assignee
          <input
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
            placeholder="GitHub login"
          />
        </label>
        <p className="hint">
          Совпавшие локальные теги будут использованы как GitHub labels. Остальные останутся в body.
        </p>
        <footer>
          <button type="button" onClick={() => setNoteId(null)}>
            Отмена
          </button>
          <button className="primary" type="submit" disabled={!repository}>
            Создать Issue
          </button>
        </footer>
      </form>
    </div>
  );
}
