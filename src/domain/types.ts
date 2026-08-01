export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'postponed' | 'question';
export type IssuePriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type SyncState = 'local' | 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface LocalNote {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  repositoryFullName: string | null;
  localTags: string[];
  checklist: ChecklistItem[];
  createdAt: string;
  updatedAt: string;
  syncState: SyncState;
  pendingConversionData?: ConversionDraft;
}

export interface ConversionDraft {
  repositoryFullName: string;
  status: Exclude<TaskStatus, 'question'>;
  priority: IssuePriority;
  labels: string[];
  assignees: string[];
}

export interface IssueLabel {
  name: string;
  color: string;
  description?: string | null | undefined;
}

export interface GitHubIssue {
  repositoryFullName: string;
  nodeId: string;
  issueNumber: number;
  clientLocalId?: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  derivedStatus: Exclude<TaskStatus, 'question'>;
  derivedPriority: IssuePriority;
  labels: IssueLabel[];
  assignees: string[];
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  cachedAt: string;
  syncState: SyncState;
  statusConflict: boolean;
  priorityConflict: boolean;
}

export interface Repository {
  id: number;
  installationId: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  permissions: { pull: boolean; push: boolean };
  pinned: boolean;
  updatedAt: string;
}

export interface RepositoryLabelsCache {
  repositoryFullName: string;
  labels: IssueLabel[];
  cachedAt: string;
}

export type TabEntity =
  | { kind: 'all' }
  | { kind: 'repository'; repositoryFullName: string }
  | { kind: 'local-note'; id: string }
  | { kind: 'issue'; repositoryFullName: string; issueNumber: number };

export interface WorkspaceTab {
  id: string;
  entity: TabEntity;
  title: string;
  position: number;
  active: boolean;
}

export type OutboxType = 'create_issue' | 'update_issue' | 'convert_note' | 'close_and_copy';
export type OutboxState = 'pending' | 'syncing' | 'failed' | 'attention' | 'exhausted';

export interface OutboxOperation {
  id: string;
  type: OutboxType;
  entityKey: string;
  repositoryFullName: string;
  payload: Record<string, unknown>;
  sourceNoteId?: string;
  state: OutboxState;
  requestStarted: boolean;
  attemptCount: number;
  nextAttemptAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Нужно сделать',
  in_progress: 'В работе',
  done: 'Готово',
  postponed: 'Отложено',
  question: 'Под вопросом',
};

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  none: 'Без приоритета',
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
  urgent: 'Срочный',
};
