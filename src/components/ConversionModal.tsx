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
  const getRepositoryLabels = useAppStore((state) => state.getRepositoryLabels);

  const [repository, setRepository] = useState('');
  const [status, setStatus] = useState<Exclude<TaskStatus, 'question'>>('todo');
  const [priority, setPriority] = useState<IssuePriority>('none');
  const [availableLabels, setAvailableLabels] = useState<Array<{ name: string; color: string }>>(
    [],
  );
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState('');

  const initialRepository =
    targetRepository || note?.repositoryFullName || repositories[0]?.fullName || '';

  useEffect(() => {
    if (note) setRepository(initialRepository);
  }, [note, initialRepository]);

  useEffect(() => {
    if (repository) {
      void getRepositoryLabels(repository).then((labels) => {
        setAvailableLabels(labels);
      });
    } else {
      setAvailableLabels([]);
    }
  }, [repository, getRepositoryLabels]);

  if (!noteId || !note) return null;

  const toggleLabel = (labelName: string) => {
    setSelectedLabels((prev) =>
      prev.includes(labelName) ? prev.filter((name) => name !== labelName) : [...prev, labelName],
    );
  };

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
              labels: selectedLabels,
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
          <div className="labels-selector">
            {availableLabels.length === 0 ? (
              <span className="no-labels-hint">Нет доступных меток для выбранного репозитория</span>
            ) : (
              availableLabels.map((lbl) => {
                const isSelected = selectedLabels.includes(lbl.name);
                return (
                  <button
                    key={lbl.name}
                    type="button"
                    className={`label-chip ${isSelected ? 'selected' : ''}`}
                    style={{
                      borderColor: `#${lbl.color}`,
                      backgroundColor: isSelected ? `#${lbl.color}33` : 'transparent',
                    }}
                    onClick={() => toggleLabel(lbl.name)}
                  >
                    {lbl.name}
                  </button>
                );
              })
            )}
          </div>
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
