import { AlertTriangle, Clock, ExternalLink, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  OUTBOX_STATE_LABELS,
  OUTBOX_TYPE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type PendingIssue,
  type IssuePriority,
  type TaskStatus,
} from '../domain/types';
import { visibleLabels } from '../domain/github-mapping';
import { useAppStore } from '../state/app-store';

export function PendingIssueContent({
  pending,
  embedded = false,
}: {
  pending: PendingIssue;
  embedded?: boolean;
}) {
  const operation = useAppStore((state) =>
    state.outbox.find(
      (item) =>
        item.entityKey === pending.clientLocalId ||
        Boolean(pending.migrationGroupId && item.migrationGroupId === pending.migrationGroupId),
    ),
  );
  const repositories = useAppStore((state) => state.repositories);
  const updatePendingOperation = useAppStore((state) => state.updatePendingOperation);
  const cancelPendingOperation = useAppStore((state) => state.cancelPendingOperation);
  const retryOperation = useAppStore((state) => state.retryOperation);
  const retryAmbiguousOperation = useAppStore((state) => state.retryAmbiguousOperation);
  const [title, setTitle] = useState(pending.title);
  const [body, setBody] = useState(pending.body);
  const [repositoryFullName, setRepositoryFullName] = useState(pending.repositoryFullName);
  const [labels, setLabels] = useState(
    visibleLabels(pending.labels)
      .map((label) => label.name)
      .join(', '),
  );
  const [assignees, setAssignees] = useState(pending.assignees.join(', '));
  const [status, setStatus] = useState<Exclude<TaskStatus, 'question'>>(pending.derivedStatus);
  const [priority, setPriority] = useState<IssuePriority>(pending.derivedPriority);

  useEffect(() => {
    setTitle(pending.title);
    setBody(pending.body);
    setRepositoryFullName(pending.repositoryFullName);
    setLabels(
      visibleLabels(pending.labels)
        .map((label) => label.name)
        .join(', '),
    );
    setAssignees(pending.assignees.join(', '));
    setStatus(pending.derivedStatus);
    setPriority(pending.derivedPriority);
  }, [pending]);

  const editable = Boolean(operation && operation.state !== 'syncing' && !pending.migrationGroupId);
  const list = (value: string) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const save = () =>
    void updatePendingOperation(pending.clientLocalId, {
      title,
      body,
      repositoryFullName,
      labels: list(labels),
      assignees: list(assignees),
      status,
      priority,
    });
  const repositoryUrl = `https://github.com/${pending.repositoryFullName}/issues?q=${encodeURIComponent(pending.title)}`;

  return (
    <div className={`details-content ${embedded ? 'embedded' : ''}`}>
      <p className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <Clock size={13} />
        {pending.repositoryFullName} · pending Issue
      </p>
      <div className={`pending-banner state-${operation?.state || 'attention'}`}>
        <strong>
          {operation
            ? `${OUTBOX_TYPE_LABELS[operation.type]}: ${OUTBOX_STATE_LABELS[operation.state]}`
            : 'Связанная операция не найдена'}
        </strong>
        {operation?.lastError && <span>{operation.lastError}</span>}
        {operation?.nextAttemptAt && operation.state === 'failed' && (
          <span>Автоповтор: {new Date(operation.nextAttemptAt).toLocaleString()}</span>
        )}
        {pending.migrationDiagnostic && <span>{pending.migrationDiagnostic}</span>}
      </div>

      {operation?.ambiguityRisk && (
        <div className="conflict-notice">
          <AlertTriangle size={15} />
          <span>
            GitHub мог создать Issue до разрыва сети. Проверьте репозиторий: обычный повтор может
            создать дубликат.
          </span>
          <a className="button" href={repositoryUrl} target="_blank" rel="noreferrer">
            Найти на GitHub <ExternalLink size={13} />
          </a>
        </div>
      )}

      <input
        className="title-input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        readOnly={!editable}
        aria-label="Название pending Issue"
      />
      <div className="field-grid">
        <label>
          Статус
          <select
            value={status}
            disabled={!editable}
            onChange={(event) => setStatus(event.target.value as Exclude<TaskStatus, 'question'>)}
          >
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
            disabled={!editable}
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
        Репозиторий
        <select
          value={repositoryFullName}
          onChange={(event) => setRepositoryFullName(event.target.value)}
          disabled={!editable}
        >
          {repositories
            .filter(
              (repository) =>
                repository.permissions.push || repository.fullName === pending.repositoryFullName,
            )
            .map((repository) => (
              <option
                key={repository.fullName}
                value={repository.fullName}
                disabled={!repository.permissions.push}
              >
                {repository.fullName}
                {repository.permissions.push ? '' : ' (только чтение)'}
              </option>
            ))}
        </select>
      </label>
      <label>
        Описание
        <textarea
          className="markdown-editor"
          rows={embedded ? 14 : 8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          readOnly={!editable}
        />
      </label>
      <label>
        Labels
        <input
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          readOnly={!editable}
        />
      </label>
      <label>
        Assignees
        <input
          value={assignees}
          onChange={(event) => setAssignees(event.target.value)}
          readOnly={!editable}
        />
      </label>
      <div className="details-actions">
        {editable && (
          <button className="primary" onClick={save}>
            <Save size={14} /> Сохранить и отправить
          </button>
        )}
        {operation && operation.state !== 'syncing' && !operation.ambiguityRisk && (
          <button onClick={() => void retryOperation(operation.id)}>
            <RotateCcw size={14} /> Повторить
          </button>
        )}
        {operation?.ambiguityRisk && !pending.migrationGroupId && (
          <button
            className="danger"
            onClick={() => {
              if (
                window.confirm(
                  'Вы проверили GitHub и уверены, что Issue не создался? Повторить POST?',
                )
              )
                void retryAmbiguousOperation(operation.id);
            }}
          >
            <RotateCcw size={14} /> Я проверил — повторить POST
          </button>
        )}
        <button
          className="danger"
          onClick={() => {
            if (window.confirm('Отменить локальную операцию и удалить pending-карточку?'))
              void cancelPendingOperation(pending.clientLocalId);
          }}
        >
          <Trash2 size={14} /> Отменить операцию
        </button>
      </div>
    </div>
  );
}
