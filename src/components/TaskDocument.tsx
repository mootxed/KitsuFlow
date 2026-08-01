import type { TabEntity } from '../domain/types';
import { useAppStore } from '../state/app-store';
import { DetailsContent } from './DetailsPanel';

export function TaskDocument({
  entity,
}: {
  entity: Extract<TabEntity, { kind: 'local-note' | 'issue' }>;
}) {
  const note = useAppStore((state) =>
    entity.kind === 'local-note' ? state.notes.find((item) => item.id === entity.id) : undefined,
  );
  const issue = useAppStore((state) =>
    entity.kind === 'issue'
      ? state.issues.find(
          (item) =>
            item.repositoryFullName === entity.repositoryFullName &&
            item.issueNumber === entity.issueNumber,
        )
      : undefined,
  );
  if (!note && !issue)
    return (
      <div className="empty-state">
        <h2>Задача не найдена</h2>
        <p>Она могла быть удалена или ещё не загружена.</p>
      </div>
    );
  return (
    <div className="task-document">
      <DetailsContent note={note} issue={issue} embedded />
    </div>
  );
}
