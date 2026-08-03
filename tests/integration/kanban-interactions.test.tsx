import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryBoard } from '../../src/components/RepositoryBoard';
import { TaskRow } from '../../src/components/TaskRow';
import { db } from '../../src/data/db';
import type { GitHubIssue, LocalNote, PendingIssue, Repository } from '../../src/domain/types';
import { useAppStore } from '../../src/state/app-store';

const writableRepo: Repository = {
  id: 1,
  installationId: 1,
  fullName: 'org/writable',
  owner: 'org',
  name: 'writable',
  private: false,
  permissions: { pull: true, push: true },
  pinned: true,
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
};

const readOnlyRepo: Repository = {
  id: 2,
  installationId: 1,
  fullName: 'org/readonly',
  owner: 'org',
  name: 'readonly',
  private: false,
  permissions: { pull: true, push: false },
  pinned: true,
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
};

const makeIssue = (
  repo: string,
  num: number,
  title: string,
  status: 'todo' | 'in_progress' | 'done' = 'todo',
): GitHubIssue => ({
  repositoryFullName: repo,
  nodeId: `node-${num}`,
  issueNumber: num,
  title,
  body: `Body for ${title}`,
  state: status === 'done' ? 'closed' : 'open',
  derivedStatus: status,
  derivedPriority: 'none',
  labels: [{ name: 'feature-with-very-long-label-name-overflow-test', color: 'ff0000' }],
  assignees: ['verylongusernameforassigneetestingoverflow'],
  htmlUrl: `https://github.com/${repo}/issues/${num}`,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  cachedAt: '2026-08-01T00:00:00Z',
  syncState: 'synced',
  statusConflict: false,
  priorityConflict: false,
  accountId: '1001',
});

const makeNote = (id: string, title: string): LocalNote => ({
  id,
  title,
  description: 'Local note description',
  status: 'question',
  repositoryFullName: 'org/writable',
  localTags: ['tag1'],
  checklist: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  syncState: 'local',
  accountId: '1001',
});

const makePending = (id: string, title: string): PendingIssue => ({
  clientLocalId: id,
  repositoryFullName: 'org/writable',
  title,
  body: 'Pending body',
  state: 'open',
  derivedStatus: 'todo',
  derivedPriority: 'none',
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
});

describe('Kanban Full-Card Drag & Interaction Tests', () => {
  afterEach(async () => {
    cleanup();
    await Promise.all(db.tables.map((table) => table.clear()));
    useAppStore.setState({
      user: { id: 1001, login: 'testuser', name: 'Test User', avatarUrl: '' },
      repositories: [],
      issues: [],
      notes: [],
      pendingIssues: [],
      selectedTask: null,
    });
  });

  it('marks writable cards as data-draggable="true" and pending/read-only as data-draggable="false"', () => {
    useAppStore.setState({
      repositories: [writableRepo, readOnlyRepo],
    });

    const writableIssue = makeIssue('org/writable', 1, 'Writable Issue');
    const readOnlyIssue = makeIssue('org/readonly', 2, 'Read Only Issue');
    const note = makeNote('note-1', 'Local Note');
    const pending = makePending('pending-1', 'Pending Issue');

    const { container, rerender } = render(<TaskRow item={writableIssue} kind="issue" />);
    let card = container.querySelector('.task-card') as HTMLElement;
    expect(card.getAttribute('data-draggable')).toBe('true');

    rerender(<TaskRow item={readOnlyIssue} kind="issue" />);
    card = container.querySelector('.task-card') as HTMLElement;
    expect(card.getAttribute('data-draggable')).toBe('false');

    rerender(<TaskRow item={note} kind="note" />);
    card = container.querySelector('.task-card') as HTMLElement;
    expect(card.getAttribute('data-draggable')).toBe('true');

    rerender(<TaskRow item={pending} kind="pending" />);
    card = container.querySelector('.task-card') as HTMLElement;
    expect(card.getAttribute('data-draggable')).toBe('false');
  });

  it('renders cards with long titles, bodies, and labels in Done column without breaking layout structure', () => {
    const longTitle = 'Super ' + 'long '.repeat(30) + 'title';
    const longBody = 'Body ' + 'word '.repeat(50);
    const doneIssue = makeIssue('org/writable', 99, longTitle, 'done');
    doneIssue.body = longBody;

    useAppStore.setState({
      repositories: [writableRepo],
      issues: [doneIssue],
      notes: [],
      pendingIssues: [],
    });

    render(<RepositoryBoard repositoryFullName="org/writable" />);

    const titleElement = screen.getByText(longTitle);
    expect(titleElement).toBeInTheDocument();
    expect(titleElement.className).toContain('task-title');
  });

  it('opens details panel on regular card click', () => {
    const issue = makeIssue('org/writable', 5, 'Clickable Issue');
    useAppStore.setState({
      repositories: [writableRepo],
      issues: [issue],
    });

    const { container } = render(<TaskRow item={issue} kind="issue" />);

    const card = container.querySelector('.task-card') as HTMLElement;
    fireEvent.click(card);

    expect(useAppStore.getState().selectedTask).toEqual({
      kind: 'issue',
      key: 'org/writable#5',
    });
  });
});
