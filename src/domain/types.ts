export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'postponed' | 'question';
export type IssuePriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
/** Состояния синхронизации сущности. attention/exhausted используются операциями outbox. */
export type SyncState =
  'local' | 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict' | 'attention' | 'exhausted';

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

/** Фазы OAuth Device Flow (и других flow). Определение здесь — единственное. */
export type OAuthFlowPhase =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | {
      phase: 'waiting';
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      interval: number;
    }
  | { phase: 'redirecting' }
  | { phase: 'callback'; code: string }
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
  accountId: string;
}

/**
 * Временная карточка Issue, ожидающая подтверждения от GitHub.
 * Хранится в отдельной таблице `pendingIssues` (не в `githubIssuesCache`).
 * После успешного создания атомарно заменяется на `GitHubIssue`.
 */
export interface PendingIssue {
  /** Стабильный уникальный идентификатор — также entityKey в outbox. */
  clientLocalId: string;
  repositoryFullName: string;
  accountId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  derivedStatus: Exclude<TaskStatus, 'question'>;
  derivedPriority: IssuePriority;
  labels: IssueLabel[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  /** Запись требует ручной проверки после неоднозначной legacy-миграции. */
  needsAttention?: boolean | undefined;
  /** Безопасная диагностика миграции, не содержащая секретов. */
  migrationDiagnostic?: string | undefined;
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
  accountId: string;
}

export interface RepositoryLabelsCache {
  repositoryFullName: string;
  labels: IssueLabel[];
  cachedAt: string;
  accountId: string;
}

export interface RepositoryAssigneesCache {
  repositoryFullName: string;
  assignees: string[];
  cachedAt: string;
  accountId: string;
}

export type TabEntity =
  | { kind: 'all' }
  | { kind: 'repository'; repositoryFullName: string }
  | { kind: 'local-note'; id: string }
  | { kind: 'pending-issue'; repositoryFullName: string; clientLocalId: string }
  | { kind: 'issue'; repositoryFullName: string; issueNumber: number };

export interface WorkspaceTab {
  id: string;
  entity: TabEntity;
  title: string;
  position: number;
  active: boolean;
  accountId: string | null;
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
  accountId: string;
  claimedAt?: string | undefined;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: string | undefined;
  creationStage?: OutboxCreationStage | undefined;
  createdIssueNumber?: number | undefined;
  createdIssueNodeId?: string | undefined;
  /** POST мог завершиться на GitHub, хотя клиент не получил ответ. */
  ambiguityRisk?: boolean | undefined;
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

/** Русские названия состояний синхронизации для UI. */
export const SYNC_STATE_LABELS: Record<SyncState, string> = {
  local: 'Локально',
  pending: 'Ожидает отправки',
  syncing: 'Синхронизируется',
  synced: 'Синхронизировано',
  failed: 'Ошибка синхронизации',
  conflict: 'Конфликт',
  attention: 'Требует внимания',
  exhausted: 'Попытки исчерпаны',
};

/** Русские названия состояний операций outbox. */
export const OUTBOX_STATE_LABELS: Record<OutboxState, string> = {
  pending: 'Ожидает',
  syncing: 'Отправляется',
  failed: 'Ошибка (автоповтор)',
  attention: 'Требует внимания',
  exhausted: 'Попытки исчерпаны',
};

/** Русские названия типов операций outbox. */
export const OUTBOX_TYPE_LABELS: Record<OutboxType, string> = {
  create_issue: 'Создание Issue',
  update_issue: 'Обновление Issue',
  convert_note: 'Публикация заметки',
  close_and_copy: 'Перенос в «Под вопросом»',
};
