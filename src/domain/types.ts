export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'postponed' | 'question';
export type IssuePriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type SyncState = 'local' | 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export type DeviceFlowState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | {
      phase: 'waiting';
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      interval: number;
    }
  | { phase: 'success' }
  | { phase: 'expired'; message: string }
  | { phase: 'error'; message: string };

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
  pendingConversionData?: ConversionDraft | undefined;
  accountId?: string | null | undefined;
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
  clientLocalId?: string | undefined;
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
  accountId?: string | undefined;
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
  accountId?: string | undefined;
}

export interface RepositoryLabelsCache {
  repositoryFullName: string;
  labels: IssueLabel[];
  cachedAt: string;
  accountId?: string | undefined;
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
  accountId?: string | undefined;
}

export type OutboxType = 'create_issue' | 'update_issue' | 'convert_note' | 'close_and_copy';
export type OutboxState = 'pending' | 'syncing' | 'failed' | 'attention' | 'exhausted';

export type OutboxCreationStage = 'not_started' | 'issue_created' | 'applying_final_state';

export interface OutboxOperation {
  id: string;
  type: OutboxType;
  entityKey: string;
  repositoryFullName: string;
  payload: Record<string, unknown>;
  sourceNoteId?: string | undefined;
  state: OutboxState;
  requestStarted: boolean;
  attemptCount: number;
  nextAttemptAt?: string | undefined;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  accountId?: string | undefined;
  claimedAt?: string | undefined;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  creationStage?: OutboxCreationStage | undefined;
  createdIssueNumber?: number | undefined;
  createdIssueNodeId?: string | undefined;
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
