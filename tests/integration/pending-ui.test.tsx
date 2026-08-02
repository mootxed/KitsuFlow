import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AllTasks } from '../../src/components/AllTasks';
import { RepositoryBoard } from '../../src/components/RepositoryBoard';
import { db } from '../../src/data/db';
import type { OutboxOperation, PendingIssue, Repository } from '../../src/domain/types';
import { useAppStore } from '../../src/state/app-store';

const repository: Repository = {
  id: 1,
  installationId: 1,
  fullName: 'acme/repo',
  owner: 'acme',
  name: 'repo',
  private: false,
  permissions: { pull: true, push: true },
  pinned: true,
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
};

const pending = (id: string, title: string): PendingIssue => ({
  clientLocalId: id,
  repositoryFullName: repository.fullName,
  accountId: '1001',
  title,
  body: '',
  state: 'open',
  derivedStatus: 'todo',
  derivedPriority: 'high',
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
});

const operation = (id: string, state: OutboxOperation['state']): OutboxOperation => ({
  id: `op-${id}`,
  type: 'create_issue',
  entityKey: id,
  repositoryFullName: repository.fullName,
  payload: { title: id, clientLocalId: id },
  state,
  requestStarted: state === 'syncing',
  attemptCount: 1,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  accountId: '1001',
});

describe('pending Issues in task lists', () => {
  afterEach(async () => {
    cleanup();
    await Promise.all(db.tables.map((table) => table.clear()));
  });

  it('shows two pending cards in AllTasks and RepositoryBoard and opens panel/tab', async () => {
    const cards = [pending('client-a', 'Pending Alpha'), pending('client-b', 'Pending Beta')];
    useAppStore.setState({
      repositories: [repository],
      issues: [],
      notes: [],
      pendingIssues: cards,
      outbox: [operation('client-a', 'failed'), operation('client-b', 'attention')],
      tabs: [
        {
          id: 'all',
          entity: { kind: 'all' },
          title: 'Все задачи',
          position: 0,
          active: true,
          accountId: '1001',
        },
      ],
      user: { id: 1001, login: 'fox', name: 'Fox', avatarUrl: '' },
    });

    const view = render(<AllTasks />);
    expect(screen.getByText('Pending Alpha')).toBeVisible();
    expect(screen.getByText('Pending Beta')).toBeVisible();
    expect(screen.queryByText('#-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Pending Alpha'));
    expect(useAppStore.getState().selectedTask).toEqual({
      kind: 'pending-issue',
      clientLocalId: 'client-a',
    });
    fireEvent.doubleClick(screen.getByText('Pending Alpha'));
    await waitFor(() =>
      expect(useAppStore.getState().tabs.some((tab) => tab.entity.kind === 'pending-issue')).toBe(
        true,
      ),
    );

    view.unmount();
    render(<RepositoryBoard repositoryFullName="acme/repo" />);
    expect(screen.getByText('Pending Alpha')).toBeVisible();
    expect(screen.getByText('Pending Beta')).toBeVisible();
  });
});
