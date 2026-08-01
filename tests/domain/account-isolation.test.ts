import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { useAppStore } from '../../src/state/app-store';
import { normalizeIssue } from '../../src/domain/github-mapping';
import { apiIssue } from '../fixtures';

describe('GitHub multi-account data isolation', () => {
  afterEach(async () => {
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      user: null,
      api: null,
      issues: [],
      notes: [],
      repositories: [],
      tabs: [],
      outbox: [],
    });
  });

  it('isolates cached issues, repos, and tabs between different GitHub accounts', async () => {
    const userA = { id: 1001, login: 'alice', name: 'Alice', avatarUrl: '' };
    const userB = { id: 2002, login: 'bob', name: 'Bob', avatarUrl: '' };

    const issueA = normalizeIssue('alice/repo', apiIssue({ number: 1, title: 'Alice Issue' }));
    issueA.accountId = '1001';

    const issueB = normalizeIssue(
      'bob/private-repo',
      apiIssue({ number: 2, title: 'Bob Private Issue' }),
    );
    issueB.accountId = '2002';

    await db.githubIssuesCache.bulkPut([issueA, issueB]);

    await db.repositoriesCache.bulkPut([
      {
        id: 1,
        installationId: 1,
        fullName: 'alice/repo',
        owner: 'alice',
        name: 'repo',
        private: false,
        permissions: { pull: true, push: true },
        pinned: true,
        updatedAt: new Date().toISOString(),
        accountId: '1001',
      },
      {
        id: 2,
        installationId: 2,
        fullName: 'bob/private-repo',
        owner: 'bob',
        name: 'private-repo',
        private: true,
        permissions: { pull: true, push: true },
        pinned: true,
        updatedAt: new Date().toISOString(),
        accountId: '2002',
      },
    ]);

    // 1. Login as Alice (userA)
    useAppStore.setState({ user: userA });
    await useAppStore.getState().initialize();

    const aliceIssues = useAppStore.getState().issues;
    expect(aliceIssues.map((i) => i.title)).toContain('Alice Issue');
    expect(aliceIssues.map((i) => i.title)).not.toContain('Bob Private Issue');

    // 2. Logout Alice
    useAppStore.getState().logout();
    expect(useAppStore.getState().issues).toHaveLength(0);

    // 3. Login as Bob (userB)
    useAppStore.setState({ user: userB });
    await useAppStore.getState().initialize();

    const bobIssues = useAppStore.getState().issues;
    expect(bobIssues.map((i) => i.title)).toContain('Bob Private Issue');
    expect(bobIssues.map((i) => i.title)).not.toContain('Alice Issue');
  });
});
