import { APP_CONFIG, SYSTEM_LABEL_PREFIX } from '../config';
import type { GitHubIssue, IssueLabel, IssuePriority, TaskStatus } from './types';

export interface ApiIssue {
  number: number;
  node_id: string;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<
    string | { name?: string | null; color?: string | null; description?: string | null }
  >;
  assignees?: Array<{ login: string } | null> | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

const labelNames = (labels: ApiIssue['labels']) =>
  labels.map((label) => (typeof label === 'string' ? label : label.name || '')).filter(Boolean);

export function deriveStatus(issue: Pick<ApiIssue, 'state' | 'labels'>): {
  status: Exclude<TaskStatus, 'question'>;
  conflict: boolean;
} {
  if (issue.state === 'closed') return { status: 'done', conflict: false };
  const names = labelNames(issue.labels);
  const statusLabels = [
    APP_CONFIG.labels.status.inProgress,
    APP_CONFIG.labels.status.postponed,
  ].filter((name) => names.includes(name));
  return {
    status:
      statusLabels[0] === APP_CONFIG.labels.status.inProgress
        ? 'in_progress'
        : statusLabels[0] === APP_CONFIG.labels.status.postponed
          ? 'postponed'
          : 'todo',
    conflict: statusLabels.length > 1,
  };
}

export function derivePriority(labels: ApiIssue['labels']): {
  priority: IssuePriority;
  conflict: boolean;
} {
  const names = labelNames(labels);
  const priorities = Object.entries(APP_CONFIG.labels.priority).filter(([, name]) =>
    names.includes(name),
  );
  return {
    priority: (priorities[0]?.[0] as IssuePriority | undefined) || 'none',
    conflict: priorities.length > 1,
  };
}

export function isPullRequest(issue: ApiIssue): boolean {
  return 'pull_request' in issue && Boolean(issue.pull_request);
}

export function normalizeIssue(repositoryFullName: string, issue: ApiIssue): GitHubIssue {
  const status = deriveStatus(issue);
  const priority = derivePriority(issue.labels);
  return {
    repositoryFullName,
    nodeId: issue.node_id,
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body || '',
    state: issue.state === 'closed' ? 'closed' : 'open',
    derivedStatus: status.status,
    derivedPriority: priority.priority,
    labels: issue.labels.map<IssueLabel>((label) =>
      typeof label === 'string'
        ? { name: label, color: '8c959f' }
        : {
            name: label.name || '',
            color: label.color || '8c959f',
            description: label.description,
          },
    ),
    assignees: (issue.assignees || []).flatMap((assignee) => (assignee ? [assignee.login] : [])),
    htmlUrl: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    cachedAt: new Date().toISOString(),
    syncState: status.conflict || priority.conflict ? 'conflict' : 'synced',
    statusConflict: status.conflict,
    priorityConflict: priority.conflict,
  };
}

export function visibleLabels(labels: IssueLabel[]): IssueLabel[] {
  return labels.filter((label) => !label.name.startsWith(SYSTEM_LABEL_PREFIX));
}

export function labelsForStatus(
  current: string[],
  status: Exclude<TaskStatus, 'question'>,
): string[] {
  const withoutStatus = current.filter((name) => !name.startsWith('km:status:'));
  if (status === 'in_progress') return [...withoutStatus, APP_CONFIG.labels.status.inProgress];
  if (status === 'postponed') return [...withoutStatus, APP_CONFIG.labels.status.postponed];
  return withoutStatus;
}

export function labelsForPriority(current: string[], priority: IssuePriority): string[] {
  const withoutPriority = current.filter((name) => !name.startsWith('km:priority:'));
  const configured =
    APP_CONFIG.labels.priority[priority as keyof typeof APP_CONFIG.labels.priority];
  return configured ? [...withoutPriority, configured] : withoutPriority;
}
