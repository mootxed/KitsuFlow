import { APP_CONFIG, SYSTEM_LABEL_PREFIXES, isSystemLabel } from '../config';
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

/** Проверяет, является ли имя label системным label статуса (оба префикса). */
function isStatusLabel(name: string): boolean {
  return (
    name === APP_CONFIG.labels.status.inProgress ||
    name === APP_CONFIG.labels.status.postponed ||
    name.startsWith('km:status:') ||
    name.startsWith('kf:status:')
  );
}

/** Проверяет, является ли имя label системным label приоритета (оба префикса). */
function isPriorityLabel(name: string): boolean {
  return (
    Object.values(APP_CONFIG.labels.priority).includes(name as any) ||
    name === 'km:priority:low' ||
    name === 'km:priority:medium' ||
    name === 'km:priority:high' ||
    name === 'km:priority:urgent'
  );
}

export function deriveStatus(issue: Pick<ApiIssue, 'state' | 'labels'>): {
  status: Exclude<TaskStatus, 'question'>;
  conflict: boolean;
} {
  if (issue.state === 'closed') return { status: 'done', conflict: false };
  const names = labelNames(issue.labels);
  const statusValues: Array<Exclude<TaskStatus, 'question'>> = [];
  if (
    names.includes(APP_CONFIG.labels.status.inProgress) ||
    names.includes('km:status:in-progress')
  ) {
    statusValues.push('in_progress');
  }
  if (names.includes(APP_CONFIG.labels.status.postponed) || names.includes('km:status:postponed')) {
    statusValues.push('postponed');
  }
  const uniqueStatuses = Array.from(new Set(statusValues));
  return {
    status: uniqueStatuses[0] || 'todo',
    conflict: uniqueStatuses.length > 1,
  };
}

export function derivePriority(labels: ApiIssue['labels']): {
  priority: IssuePriority;
  conflict: boolean;
} {
  const names = labelNames(labels);
  const legacyMap: Record<string, IssuePriority> = {
    'km:priority:low': 'low',
    'km:priority:medium': 'medium',
    'km:priority:high': 'high',
    'km:priority:urgent': 'urgent',
  };
  const foundPriorities: IssuePriority[] = [];
  for (const name of names) {
    const kfEntry = Object.entries(APP_CONFIG.labels.priority).find(([, val]) => val === name);
    if (kfEntry) {
      foundPriorities.push(kfEntry[0] as IssuePriority);
    } else if (name in legacyMap) {
      foundPriorities.push(legacyMap[name]!);
    }
  }
  const uniquePriorities = Array.from(new Set(foundPriorities));
  return {
    priority: uniquePriorities[0] || 'none',
    conflict: uniquePriorities.length > 1,
  };
}

export function isPullRequest(issue: ApiIssue): boolean {
  return 'pull_request' in issue && Boolean(issue.pull_request);
}

export function assertAccountId(accountId: string | null | undefined): string {
  if (!accountId || typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error('Missing or invalid accountId for GitHub entity');
  }
  return accountId;
}

export function normalizeIssue(
  repositoryFullName: string,
  issue: ApiIssue,
  accountId?: string,
): GitHubIssue {
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
    accountId: accountId!,
  };
}

/** Скрывает системные labels обоих префиксов (kf: и km:) из пользовательского списка. */
export function visibleLabels(labels: IssueLabel[]): IssueLabel[] {
  return labels.filter((label) => !isSystemLabel(label.name));
}

/** Удаляет системные labels статуса обоих префиксов и добавляет нужный kf:. */
export function labelsForStatus(
  current: string[],
  status: Exclude<TaskStatus, 'question'>,
): string[] {
  const withoutStatus = current.filter((name) => !isStatusLabel(name));
  if (status === 'in_progress') return [...withoutStatus, APP_CONFIG.labels.status.inProgress];
  if (status === 'postponed') return [...withoutStatus, APP_CONFIG.labels.status.postponed];
  return withoutStatus;
}

/** Удаляет системные labels приоритета обоих префиксов и добавляет нужный kf:. */
export function labelsForPriority(current: string[], priority: IssuePriority): string[] {
  const withoutPriority = current.filter((name) => !isPriorityLabel(name));
  const configured =
    APP_CONFIG.labels.priority[priority as keyof typeof APP_CONFIG.labels.priority];
  return configured ? [...withoutPriority, configured] : withoutPriority;
}

/**
 * Атомарно вычисляет итоговый массив labels при одновременном изменении
 * статуса И приоритета. Удаляет все старые системные labels обоих префиксов
 * и добавляет новые kf:* за один проход.
 */
export function labelsForMove(
  current: string[],
  status: Exclude<TaskStatus, 'question'>,
  priority: IssuePriority,
): string[] {
  const withoutSystem = current.filter((name) => !isStatusLabel(name) && !isPriorityLabel(name));
  let result = withoutSystem;
  if (status === 'in_progress') result = [...result, APP_CONFIG.labels.status.inProgress];
  else if (status === 'postponed') result = [...result, APP_CONFIG.labels.status.postponed];
  const priorityLabel =
    APP_CONFIG.labels.priority[priority as keyof typeof APP_CONFIG.labels.priority];
  if (priorityLabel) result = [...result, priorityLabel];
  return result;
}

// Re-export for convenience
export { isSystemLabel, SYSTEM_LABEL_PREFIXES };
