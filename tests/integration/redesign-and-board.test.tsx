import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AllTasks } from '../../src/components/AllTasks';
import { RepositoryBoard } from '../../src/components/RepositoryBoard';
import { Sidebar } from '../../src/components/Sidebar';
import { DetailsContent } from '../../src/components/DetailsPanel';
import { TaskRow } from '../../src/components/TaskRow';

import { db } from '../../src/data/db';
import type { GitHubIssue, LocalNote, OutboxOperation, Repository } from '../../src/domain/types';
import { useAppStore } from '../../src/state/app-store';

const repo1: Repository = {
  id: 1,
  installationId: 1,
  fullName: 'org/alpha',
  owner: 'org',
  name: 'alpha',
  private: false,
  permissions: { pull: true, push: true },
  pinned: true,
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
};

const repo2: Repository = {
  id: 2,
  installationId: 1,
  fullName: 'org/beta',
  owner: 'org',
  name: 'beta',
  private: false,
  permissions: { pull: true, push: false }, // Read-only repo!
  pinned: false, // Unpinned!
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
};

const makeIssue = (repo: string, num: number, title: string, status: 'todo' | 'in_progress' | 'done' = 'todo'): GitHubIssue => ({
  repositoryFullName: repo,
  nodeId: `node-${num}`,
  issueNumber: num,
  title,
  body: `Body for ${title}`,
  state: status === 'done' ? 'closed' : 'open',
  derivedStatus: status,
  derivedPriority: 'none',
  labels: [],
  assignees: [],
  htmlUrl: `https://github.com/${repo}/issues/${num}`,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  cachedAt: '2026-08-01T00:00:00Z',
  syncState: 'synced',
  accountId: '1001',
});

const makeNote = (id: string, title: string, repo: string | null = null): LocalNote => ({
  id,
  title,
  description: 'Note desc',
  status: repo ? 'question' : 'todo',
  repositoryFullName: repo,
  localTags: [],
  checklist: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  syncState: 'local',
  accountId: '1001',
});

describe('Redesign, Board Mode & Sync Status Fixes', () => {
  afterEach(async () => {
    cleanup();
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      user: { id: 1001, login: 'testuser', name: 'Test User', avatarUrl: '' },
      repositories: [],
      issues: [],
      notes: [],
      pendingIssues: [],
      outbox: [],
      online: true,
      stale: false,
      error: null,
      tabs: [],
    });
  });

  it('1. AllTasks board mode applies search query and status filters correctly', () => {
    const issue1 = makeIssue('org/alpha', 1, 'Fix critical bug in alpha', 'todo');
    const issue2 = makeIssue('org/alpha', 2, 'Add docs for alpha', 'in_progress');

    useAppStore.setState({
      repositories: [repo1],
      issues: [issue1, issue2],
      notes: [],
      pendingIssues: [],
    });

    render(<AllTasks />);

    // Switch to board mode
    const boardBtn = screen.getByRole('button', { name: /Доска/i });
    fireEvent.click(boardBtn);

    // Default filters are todo & in_progress
    expect(screen.getByText('Fix critical bug in alpha')).toBeVisible();
    expect(screen.getByText('Add docs for alpha')).toBeVisible();

    // Type search query
    const searchInput = screen.getByPlaceholderText('Поиск по всем задачам...');
    fireEvent.change(searchInput, { target: { value: 'critical' } });

    expect(screen.getByText('Fix critical bug in alpha')).toBeVisible();
    expect(screen.queryByText('Add docs for alpha')).not.toBeInTheDocument();
  });

  it('2. Multiple repositories in AllTasks board mode do not duplicate id="repo-screen"', () => {
    const pinnedRepo2 = { ...repo2, pinned: true };
    useAppStore.setState({
      repositories: [repo1, pinnedRepo2],
      issues: [makeIssue('org/alpha', 1, 'Alpha Issue'), makeIssue('org/beta', 1, 'Beta Issue')],
      notes: [],
      pendingIssues: [],
    });

    const { container } = render(<AllTasks />);

    // Switch to board mode
    fireEvent.click(screen.getByRole('button', { name: /Доска/i }));

    const screensWithId = container.querySelectorAll('#repo-screen');
    expect(screensWithId.length).toBe(0); // AllTasks board mode should NOT add id="repo-screen"
  });

  it('3. Selecting a repository in mobile Sidebar invokes onClose handler', () => {
    let closed = false;
    useAppStore.setState({
      repositories: [repo1],
      issues: [],
      notes: [],
      pendingIssues: [],
      tabs: [{ id: 'all', entity: { kind: 'all' }, title: 'Все задачи', position: 0, active: true, accountId: '1001' }],
    });

    render(<Sidebar open={true} onClose={() => { closed = true; }} />);

    const repoBtn = screen.getByRole('button', { name: /alpha/i });
    fireEvent.click(repoBtn);

    expect(closed).toBe(true);
  });

  it('4. RepositoryBoard headers reflect accurate offline, pending outbox, and error sync status', () => {
    useAppStore.setState({
      repositories: [repo1],
      issues: [],
      notes: [],
      pendingIssues: [],
      outbox: [],
      online: false, // Offline
    });

    const { rerender } = render(<RepositoryBoard repositoryFullName="org/alpha" />);
    expect(screen.getByText('Сохранено локально')).toBeVisible();

    // Now test pending outbox status (e.g. 2 queued operations)
    const op1: OutboxOperation = {
      id: 'op-1',
      type: 'update_issue',
      entityKey: 'org/alpha#1',
      repositoryFullName: 'org/alpha',
      payload: {},
      state: 'queued',
      requestStarted: false,
      attemptCount: 0,
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
      accountId: '1001',
    };
    const op2: OutboxOperation = { ...op1, id: 'op-2' };

    useAppStore.setState({
      online: true,
      outbox: [op1, op2],
    });

    rerender(<RepositoryBoard repositoryFullName="org/alpha" />);
    expect(screen.getByText('2 операции ожидают отправки')).toBeVisible();

    // Now test failed outbox status
    useAppStore.setState({
      outbox: [{ ...op1, state: 'failed', lastError: 'API Error' }],
    });

    rerender(<RepositoryBoard repositoryFullName="org/alpha" />);
    expect(screen.getByText('Ошибка синхронизации')).toBeVisible();
  });

  it('5. Note bound to repository displays repo name in card footer instead of "Без репозитория"', () => {
    const note = makeNote('note-1', 'Repo Note', 'org/alpha');
    useAppStore.setState({
      repositories: [repo1],
      issues: [],
      notes: [note],
    });

    render(<TaskRow item={note} kind="note" />);
    expect(screen.getByText('org/alpha')).toBeVisible();
    expect(screen.queryByText('Без репозитория')).not.toBeInTheDocument();
  });


  it('6. DetailsContent retains write permissions for issue from repo that is not pinned', () => {
    const pinnedRepo1 = { ...repo1, permissions: { pull: true, push: true }, pinned: false }; // Unpinned but has push permissions
    const unpinnedIssue = makeIssue('org/alpha', 10, 'Unpinned Issue');

    useAppStore.setState({
      repositories: [pinnedRepo1], // unpinned
      issues: [unpinnedIssue],
    });

    render(<DetailsContent issue={unpinnedIssue} />);

    const titleInput = screen.getByLabelText('Название Issue') as HTMLInputElement;
    expect(titleInput.readOnly).toBe(false);
    expect(screen.queryByText('Репозиторий доступен только для чтения.')).not.toBeInTheDocument();
  });
});
