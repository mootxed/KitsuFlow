import type { TabEntity, WorkspaceTab } from './types';

export const defaultTab = (accountId: string | null): WorkspaceTab => ({
  id: crypto.randomUUID(),
  entity: { kind: 'all' },
  title: 'Все задачи',
  position: 0,
  active: true,
  accountId,
});

export const tabEntitySignature = (entity: TabEntity): string => JSON.stringify(entity);

/**
 * Единая нормализация вкладок: непустой массив, уникальные сущности/ID,
 * последовательные позиции и ровно одна активная вкладка.
 */
export function ensureDefaultTab(input: WorkspaceTab[], accountId: string | null): WorkspaceTab[] {
  const seenIds = new Set<string>();
  const seenEntities = new Set<string>();
  const unique = input
    .slice()
    .sort((a, b) => a.position - b.position)
    .filter((tab) => {
      const signature = tabEntitySignature(tab.entity);
      if (seenIds.has(tab.id) || seenEntities.has(signature)) return false;
      seenIds.add(tab.id);
      seenEntities.add(signature);
      return true;
    });

  if (unique.length === 0) return [defaultTab(accountId)];

  const requestedActive = unique.findIndex((tab) => tab.active);
  const activeIndex = requestedActive >= 0 ? requestedActive : 0;
  return unique.map((tab, position) => ({
    ...tab,
    accountId,
    position,
    active: position === activeIndex,
  }));
}

export function titleForTabEntity(entity: TabEntity): string {
  if (entity.kind === 'all') return 'Все задачи';
  if (entity.kind === 'repository')
    return entity.repositoryFullName.split('/')[1] || entity.repositoryFullName;
  if (entity.kind === 'local-note') return 'Заметка';
  if (entity.kind === 'pending-issue')
    return `${entity.repositoryFullName.split('/')[1] || entity.repositoryFullName} · ожидает`;
  return `${entity.repositoryFullName.split('/')[1] || entity.repositoryFullName} #${entity.issueNumber}`;
}
