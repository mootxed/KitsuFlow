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
  const open = useAppStore((state) => state.createOpen);
  const setOpen = useAppStore((state) => state.setCreateOpen);
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repo) => repo.pinned)),
  );
  const createTask = useAppStore((state) => state.createTask);
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [repository, setRepository] = useState('');
  const [tags, setTags] = useState('');
  const [checklist, setChecklist] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('none');
  const [assignee, setAssignee] = useState('');
  useEffect(() => {
    if (open) window.setTimeout(() => titleRef.current?.focus(), 0);
  }, [open]);
  useEffect(() => {
    if (!repository && status === 'question') setStatus('todo');
  }, [repository, status]);
  if (!open) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    await createTask({
      title,
      description,
      status,
      repositoryFullName: repository || null,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
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
          {repository ? 'GitHub labels' : 'Локальные теги'}
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="bug, docs"
          />
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
              <input
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                placeholder="GitHub login"
              />
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
