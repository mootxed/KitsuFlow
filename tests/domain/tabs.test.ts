import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { ensureDefaultTab } from '../../src/domain/tabs';
import { loadGitHubAccountState } from '../../src/state/app-store';

describe('default workspace tab', () => {
  afterEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
  });

  it('persists «Все задачи» for a new account without saved tabs', async () => {
    const state = await loadGitHubAccountState('new-account');
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      entity: { kind: 'all' },
      title: 'Все задачи',
      position: 0,
      active: true,
      accountId: 'new-account',
    });
    expect(await db.tabs.where('accountId').equals('new-account').count()).toBe(1);
  });

  it('normalizes positions and leaves exactly one active tab', () => {
    const normalized = ensureDefaultTab(
      [
        {
          id: 'two',
          entity: { kind: 'all' },
          title: 'Все',
          position: 8,
          active: true,
          accountId: 'a',
        },
        {
          id: 'one',
          entity: { kind: 'repository', repositoryFullName: 'acme/repo' },
          title: 'repo',
          position: 2,
          active: true,
          accountId: 'wrong',
        },
      ],
      'a',
    );
    expect(normalized.map((tab) => tab.position)).toEqual([0, 1]);
    expect(normalized.filter((tab) => tab.active)).toHaveLength(1);
    expect(normalized.every((tab) => tab.accountId === 'a')).toBe(true);
  });
});
