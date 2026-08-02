import { Clock } from 'lucide-react';
import type { PendingIssue } from '../domain/types';
import { PRIORITY_LABELS, STATUS_LABELS } from '../domain/types';

/**
 * Отображает временную карточку Issue, ожидающую подтверждения от GitHub.
 * Поля заблокированы — редактирование через outbox-операцию.
 */
export function PendingIssueContent({
  pending,
  embedded = false,
}: {
  pending: PendingIssue;
  embedded?: boolean;
}) {
  return (
    <div className={`details-content ${embedded ? 'embedded' : ''}`}>
      <p className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <Clock size={13} />
        {pending.repositoryFullName} · создаётся…
      </p>
      <div className="pending-banner">
        Задача создаётся на GitHub. Поля недоступны до получения подтверждения.
      </div>
      <input
        className="title-input"
        value={pending.title}
        readOnly
        disabled
        aria-label="Название Issue (ожидает создания)"
      />
      <div className="field-grid">
        <label>
          Статус
          <select value={pending.derivedStatus} disabled>
            <option value={pending.derivedStatus}>
              {STATUS_LABELS[pending.derivedStatus]}
            </option>
          </select>
        </label>
        <label>
          Приоритет
          <select value={pending.derivedPriority} disabled>
            <option value={pending.derivedPriority}>
              {PRIORITY_LABELS[pending.derivedPriority]}
            </option>
          </select>
        </label>
      </div>
      {pending.body && (
        <label>
          Описание
          <textarea
            className="markdown-editor"
            rows={embedded ? 14 : 8}
            value={pending.body}
            readOnly
            disabled
          />
        </label>
      )}
      {pending.labels.length > 0 && (
        <div className="label-list">
          {pending.labels.map((label) => (
            <span
              className="label"
              key={label.name}
              style={{ '--label-color': `#${label.color}` } as React.CSSProperties}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}
      {pending.assignees.length > 0 && (
        <p className="assignees">{pending.assignees.join(', ')}</p>
      )}
      <p className="sync-summary pending">Ожидает отправки на GitHub</p>
    </div>
  );
}
