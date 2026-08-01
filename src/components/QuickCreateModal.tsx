import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type IssuePriority,
  type TaskStatus,
} from '../domain/types';
import { useAppStore } from '../state/app-store';
import { useShallow } from 'zustand/react/shallow';

export function QuickCreateModal() {
  const createDialog = useAppStore((state) => state.createDialog);
  const setOpen = useAppStore((state) => state.setCreateOpen);
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repo) => repo.pinned)),
  );
  const createTask = useAppStore((state) => state.createTask);
  const getRepositoryLabels = useAppStore((state) => state.getRepositoryLabels);
  const getRepositoryAssignees = useAppStore((state) => state.getRepositoryAssignees);

  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [repository, setRepository] = useState('');
  const [tags, setTags] = useState('');
  const [availableLabels, setAvailableLabels] = useState<Array<{ name: string; color: string }>>(
    [],
  );
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [availableAssignees, setAvailableAssignees] = useState<string[]>([]);
  const [assignee, setAssignee] = useState('');
  const [checklist, setChecklist] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('none');
  const [loadingLabels, setLoadingLabels] = useState(false);

  const open = createDialog.open;

  useEffect(() => {
    if (open) {
      window.setTimeout(() => titleRef.current?.focus(), 0);
      setTitle('');
      setDescription('');
      setRepository(createDialog.initialRepositoryFullName ?? '');
      setStatus(createDialog.initialStatus ?? 'todo');
      setPriority(createDialog.initialPriority ?? 'none');
      setTags('');
      setSelectedLabels([]);
      setAvailableLabels([]);
      setChecklist('');
      setAssignee('');
      setAvailableAssignees([]);
      setLoadingLabels(false);
    }
  }, [
    open,
    createDialog.initialRepositoryFullName,
    createDialog.initialStatus,
    createDialog.initialPriority,
  ]);

  useEffect(() => {
    if (!repository && status === 'question') setStatus('todo');
  }, [repository, status]);

  useEffect(() => {
    let active = true;
    if (repository) {
      setLoadingLabels(true);
      setSelectedLabels([]);
      setAssignee('');

      void getRepositoryLabels(repository).then((labels) => {
        if (active) {
          setAvailableLabels(labels);
          setLoadingLabels(false);
        }
      });

      void getRepositoryAssignees(repository).then((assignees) => {
        if (active) {
          setAvailableAssignees(assignees);
        }
      });
    } else {
      setAvailableLabels([]);
      setSelectedLabels([]);
      setAvailableAssignees([]);
      setAssignee('');
    }

    return () => {
      active = false;
    };
  }, [repository, getRepositoryLabels, getRepositoryAssignees]);

  if (!open) return null;

  const toggleLabel = (labelName: string) => {
    setSelectedLabels((prev) =>
      prev.includes(labelName) ? prev.filter((name) => name !== labelName) : [...prev, labelName],
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;

    const finalTags = repository
      ? selectedLabels
      : tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);

    await createTask({
      title,
      description,
      status,
      repositoryFullName: repository || null,
      tags: finalTags,
      checklist: checklist
        .split('\n')
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ id: crypto.randomUUID(), text, checked: false })),
      priority,
      assignees: assignee.trim() ? [assignee.trim()] : [],
    });

    setTitle('');
    setDescription('');
    setStatus('todo');
    setRepository('');
    setTags('');
    setSelectedLabels([]);
    setChecklist('');
    setPriority('none');
    setAssignee('');
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <form className="modal quick-create" onSubmit={submit} aria-label="Быстрое создание">
        <header>
          <span>
            <Plus size={16} /> Новая задача
          </span>
          <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </header>
        <input
          ref={titleRef}
          className="quick-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Название задачи"
          aria-label="Название"
          required
        />
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Описание (Markdown)"
          aria-label="Описание"
          rows={4}
        />
        <div className="field-grid">
          <label>
            Репозиторий
            <select value={repository} onChange={(event) => setRepository(event.target.value)}>
              <option value="">Локальная заметка</option>
              {repositories.map((repo) => (
                <option key={repo.fullName}>{repo.fullName}</option>
              ))}
            </select>
          </label>
          <label>
            Статус
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskStatus)}
            >
              {(
                [
                  'todo',
                  'in_progress',
                  'done',
                  'postponed',
                  ...(repository ? ['question'] : []),
                ] as TaskStatus[]
              ).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {repository ? 'GitHub labels' : 'Локальные теги'}{' '}
          {loadingLabels && <small>(загрузка...)</small>}
          {repository ? (
            <div className="labels-selector">
              {availableLabels.length === 0 ? (
                <span className="no-labels-hint">
                  {loadingLabels
                    ? 'Загрузка меток...'
                    : 'Нет доступных меток для выбранного репозитория'}
                </span>
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
          ) : (
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="bug, docs"
            />
          )}
        </label>
        <label>
          Чек-лист
          <textarea
            value={checklist}
            onChange={(event) => setChecklist(event.target.value)}
            placeholder="Один пункт на строку"
            rows={3}
          />
        </label>
        {repository && status !== 'question' && (
          <div className="field-grid">
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
            <label>
              Исполнитель
              <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                <option value="">Без исполнителя</option>
                {availableAssignees.map((userLogin) => (
                  <option key={userLogin} value={userLogin}>
                    {userLogin}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <footer>
          <span>
            <kbd>Enter</kbd> создать
          </span>
          <button type="submit" className="primary">
            Создать
          </button>
        </footer>
      </form>
    </div>
  );
}
