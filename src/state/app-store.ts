import { create } from 'zustand';
import { db } from '../data/db';
import { labelsForMove, visibleLabels } from '../domain/github-mapping';
import {
  createLocalNote,
  extractChecklistFromMarkdown,
  noteToIssueBody,
  shouldPublishAsIssue,
  stripSystemLabels,
} from '../domain/notes';
import type {
  ChecklistItem,
  GitHubIssue,
  GitHubUser,
  IssuePriority,
  LocalNote,
  OutboxOperation,
  Repository,
  TabEntity,
  TaskStatus,
  WorkspaceTab,
} from '../domain/types';
import { GitHubApi } from '../github/api';
import { DeviceFlowController, type DeviceFlowState } from '../github/device-flow';
import { session } from '../github/session';
import { OutboxProcessor, type SyncEvent } from '../sync/outbox';

type SelectedTask = { kind: 'note'; id: string } | { kind: 'issue'; key: string } | null;

interface CreateTaskInput {
  title: string;
  description: string;
  status: TaskStatus;
  repositoryFullName: string | null;
  tags: string[];
  checklist: ChecklistItem[];
  priority: IssuePriority;
  assignees: string[];
}

export interface CreateDialogState {
  open: boolean;
  initialRepositoryFullName?: string | undefined;
  initialStatus?: TaskStatus | undefined;
  initialPriority?: IssuePriority | undefined;
}

export interface ConversionDialogState {
  noteId: string | null;
  repositoryFullName?: string | undefined;
  status?: TaskStatus | undefined;
  priority?: IssuePriority | undefined;
}

interface AppState {
  initialized: boolean;
  loading: boolean;
  user: GitHubUser | null;
  auth: DeviceFlowState;
  api: GitHubApi | null;
  repositories: Repository[];
  notes: LocalNote[];
  issues: GitHubIssue[];
  tabs: WorkspaceTab[];
  outbox: OutboxOperation[];
  selectedTask: SelectedTask;
  createDialog: CreateDialogState;
  repositoryPickerOpen: boolean;
  conversionDialog: ConversionDialogState;
  online: boolean;
  stale: boolean;
  error: string | null;
  rateLimitUntil: string | null;

  initialize: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => void;
  refreshRepositories: () => Promise<void>;
  refreshIssues: (repositoryFullName?: string) => Promise<void>;
  toggleRepository: (fullName: string) => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<void>;
  updateNote: (id: string, changes: Partial<LocalNote>) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;

  updateIssuePlacement: (
    issueKeyString: string,
    changes: {
      status?: Exclude<TaskStatus, 'question'>;
      priority?: IssuePriority;
    },
  ) => Promise<void>;

  changeIssueStatus: (issue: GitHubIssue, status: Exclude<TaskStatus, 'question'>) => Promise<void>;
  changeIssuePriority: (issue: GitHubIssue, priority: IssuePriority) => Promise<void>;
  moveIssue: (
    issue: GitHubIssue,
    target: { status: Exclude<TaskStatus, 'question'>; priority: IssuePriority },
  ) => Promise<void>;

  updateIssueFields: (
    issue: GitHubIssue,
    changes: { title: string; body: string },
  ) => Promise<void>;
  moveIssueToQuestion: (issue: GitHubIssue) => Promise<void>;

  requestConversion: (
    noteId: string,
    context?:
      | {
          repositoryFullName?: string | undefined;
          status?: TaskStatus | undefined;
          priority?: IssuePriority | undefined;
        }
      | undefined,
  ) => void;
  confirmConversion: (draft: {
    repositoryFullName: string;
    status: Exclude<TaskStatus, 'question'>;
    priority: IssuePriority;
    labels: string[];
    assignees: string[];
  }) => Promise<void>;

  openEntity: (
    entity: TabEntity,
    options?: { duplicate?: boolean | undefined; newTab?: boolean | undefined } | undefined,
  ) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  selectTab: (id: string) => Promise<void>;
  setSelectedTask: (task: SelectedTask) => void;

  setCreateOpen: (
    open: boolean,
    context?:
      | {
          initialRepositoryFullName?: string | undefined;
          initialStatus?: TaskStatus | undefined;
          initialPriority?: IssuePriority | undefined;
        }
      | undefined,
  ) => void;
  setRepositoryPickerOpen: (open: boolean) => void;
  setConversionNoteId: (id: string | null) => void;
  retryOperation: (id: string) => Promise<void>;
  getRepositoryLabels: (
    repositoryFullName: string,
  ) => Promise<Array<{ name: string; color: string }>>;
  getRepositoryAssignees: (repositoryFullName: string) => Promise<string[]>;
}

const PENDING_STATES = new Set(['pending', 'syncing', 'failed', 'attention', 'exhausted']);

const deviceFlow = new DeviceFlowController();
let outboxProcessor: OutboxProcessor;

const issueKey = (issue: Pick<GitHubIssue, 'repositoryFullName' | 'issueNumber'>) =>
  `${issue.repositoryFullName}#${issue.issueNumber}`;

const titleForEntity = (entity: TabEntity): string => {
  if (entity.kind === 'all') return 'Все задачи';
  if (entity.kind === 'repository')
    return entity.repositoryFullName.split('/')[1] || entity.repositoryFullName;
  if (entity.kind === 'local-note') return 'Заметка';
  return `${entity.repositoryFullName.split('/')[1]} #${entity.issueNumber}`;
};

const entitySignature = (entity: TabEntity): string => JSON.stringify(entity);

async function loadCachedState(accountId: string | null) {
  const [repositories, notes, issues, tabs, outbox] = await Promise.all([
    db.repositoriesCache.toArray(),
    db.localNotes.orderBy('updatedAt').reverse().toArray(),
    db.githubIssuesCache.orderBy('updatedAt').reverse().toArray(),
    db.tabs.orderBy('position').toArray(),
    db.outbox.orderBy('createdAt').toArray(),
  ]);

  const userRepos = repositories.filter(
    (repo) => !accountId || !repo.accountId || repo.accountId === accountId,
  );

  const userIssues = issues.filter(
    (issue) => !accountId || !issue.accountId || issue.accountId === accountId,
  );

  const userTabs = tabs.filter(
    (tab) => !accountId || !tab.accountId || tab.accountId === accountId,
  );

  const userOutbox = outbox.filter(
    (op) => !accountId || !op.accountId || op.accountId === accountId,
  );

  const userNotes = notes.filter(
    (note) =>
      !accountId || note.accountId === null || note.accountId === accountId || !note.accountId,
  );

  return {
    repositories: userRepos,
    notes: userNotes,
    issues: userIssues,
    tabs: userTabs,
    outbox: userOutbox,
  };
}

async function persistTabs(tabs: WorkspaceTab[], accountId?: string | null): Promise<void> {
  const currentAccountId = accountId || undefined;
  const tabsWithAccount = tabs.map((t) => ({ ...t, accountId: currentAccountId }));
  await db.transaction('rw', db.tabs, async () => {
    if (currentAccountId) {
      await db.tabs.where('accountId').equals(currentAccountId).delete();
    } else {
      await db.tabs.clear();
    }
    await db.tabs.bulkPut(tabsWithAccount);
  });
}

export const useAppStore = create<AppState>((set, get) => {
  const handleIssueCreated = async (tempId: string | number, realIssue: GitHubIssue) => {
    const { selectedTask } = get();
    if (selectedTask?.kind === 'issue' && selectedTask.key.includes(String(tempId))) {
      set({ selectedTask: { kind: 'issue', key: issueKey(realIssue) } });
    }
    const currentAccountId = get().user ? String(get().user?.id) : null;
    const cached = await loadCachedState(currentAccountId);
    set({ tabs: cached.tabs, issues: cached.issues, outbox: cached.outbox });
  };

  const handleSyncEvent = async (event: SyncEvent) => {
    if (event.type === 'unauthorized') {
      session.clear();
      set({
        user: null,
        api: null,
        error: 'Сессия GitHub истекла. Войдите снова; очередь сохранена.',
      });
    }
    if (event.type === 'rate-limited') set({ rateLimitUntil: event.retryAt });
    if (event.type === 'permission-denied') {
      set({ error: `Нет доступа: ${event.message}` });
    }
    const currentAccountId = get().user ? String(get().user?.id) : null;
    const cached = await loadCachedState(currentAccountId);
    set(cached);
  };

  outboxProcessor = new OutboxProcessor(() => get().api, handleSyncEvent, handleIssueCreated);

  return {
    initialized: false,
    loading: true,
    user: null,
    auth: { phase: 'idle' },
    api: null,
    repositories: [],
    notes: [],
    issues: [],
    tabs: [],
    outbox: [],
    selectedTask: null,
    createDialog: { open: false },
    repositoryPickerOpen: false,
    conversionDialog: { noteId: null },
    online: navigator.onLine,
    stale: !navigator.onLine,
    error: null,
    rateLimitUntil: null,

    initialize: async () => {
      const currentUser = get().user;
      const currentAccountId = currentUser ? String(currentUser.id) : null;
      const cached = await loadCachedState(currentAccountId);
      let tabs = cached.tabs;
      if (!tabs.length) {
        tabs = [
          {
            id: crypto.randomUUID(),
            entity: { kind: 'all' },
            title: 'Все задачи',
            position: 0,
            active: true,
            accountId: currentAccountId || undefined,
          },
        ];
        await persistTabs(tabs, currentAccountId);
      }
      set({ ...cached, tabs, loading: false, initialized: true });

      const token = session.getToken();
      if (token) {
        const api = new GitHubApi(token);
        try {
          const user = await api.getCurrentUser();
          const accountId = String(user.id);
          const userCached = await loadCachedState(accountId);
          set({ api, user, error: null, ...userCached });

          await get().refreshRepositories();
          await outboxProcessor.process();
          await get().refreshIssues();
        } catch {
          session.clear();
          set({
            api: null,
            user: null,
            error: 'Сессия GitHub недействительна. Локальные данные доступны.',
          });
        }
      }

      window.addEventListener('online', () => {
        set({ online: true });
        void outboxProcessor.process().then(() => get().refreshIssues());
      });
      window.addEventListener('offline', () => set({ online: false, stale: true }));
    },

    login: async () => {
      if (deviceFlow.running) return;
      set({ error: null });
      const token = await deviceFlow.start((auth) => set({ auth }));
      if (!token) return;
      const api = new GitHubApi(token);
      try {
        const user = await api.getCurrentUser();
        session.setToken(token);
        const accountId = String(user.id);
        const userCached = await loadCachedState(accountId);

        set({ api, user, auth: { phase: 'idle' }, error: null, ...userCached });
        await get().refreshRepositories();
        await outboxProcessor.process();
        await get().refreshIssues();
      } catch {
        session.clear();
        set({
          api: null,
          user: null,
          auth: { phase: 'error', message: 'GitHub не подтвердил авторизацию' },
        });
      }
    },

    logout: () => {
      deviceFlow.cancel();
      session.clear();
      outboxProcessor.destroy();
      set({
        api: null,
        user: null,
        auth: { phase: 'idle' },
        selectedTask: null,
        issues: [],
        repositories: [],
        tabs: [
          {
            id: crypto.randomUUID(),
            entity: { kind: 'all' },
            title: 'Все задачи',
            position: 0,
            active: true,
          },
        ],
      });
    },

    refreshRepositories: async () => {
      const api = get().api;
      const user = get().user;
      if (!api || !navigator.onLine) return;
      const accountId = user ? String(user.id) : undefined;
      try {
        const currentMap = new Map(get().repositories.map((repo) => [repo.fullName, repo]));
        const repositories = (await api.getRepositories()).map((repo) => ({
          ...repo,
          pinned: currentMap.get(repo.fullName)?.pinned || false,
          accountId,
        }));
        await db.repositoriesCache.bulkPut(repositories);
        set({ repositories, error: null });
      } catch (error: any) {
        const status = error?.status;
        set({
          error:
            status === 403
              ? 'Нет доступа к установкам GitHub App.'
              : 'Не удалось загрузить репозитории.',
        });
      }
    },

    refreshIssues: async (repositoryFullName) => {
      const api = get().api;
      const user = get().user;
      if (!api || !navigator.onLine) return;
      const accountId = user ? String(user.id) : undefined;

      const repositories = repositoryFullName
        ? get().repositories.filter((repo) => repo.fullName === repositoryFullName)
        : get().repositories.filter((repo) => repo.pinned);

      try {
        for (const repository of repositories) {
          const [networkIssues, labels] = await Promise.all([
            api.getIssues(repository.fullName),
            api.getLabels(repository.fullName),
          ]);

          const networkIssuesWithAccount = networkIssues.map((i) => ({ ...i, accountId }));

          await db.transaction(
            'rw',
            db.githubIssuesCache,
            db.repositoryLabelsCache,
            db.outbox,
            async () => {
              const pendingOutbox = await db.outbox
                .where('repositoryFullName')
                .equals(repository.fullName)
                .and((op) => PENDING_STATES.has(op.state))
                .toArray();

              const pendingOutboxKeys = new Set(pendingOutbox.map((op) => op.entityKey));

              const localPendingIssues = await db.githubIssuesCache
                .where('repositoryFullName')
                .equals(repository.fullName)
                .and((issue) => PENDING_STATES.has(issue.syncState))
                .toArray();

              const localIssueMap = new Map(
                (
                  await db.githubIssuesCache
                    .where('repositoryFullName')
                    .equals(repository.fullName)
                    .toArray()
                ).map((i) => [issueKey(i), i]),
              );

              // Удалить только не-pending записи
              await db.githubIssuesCache
                .where('repositoryFullName')
                .equals(repository.fullName)
                .and((issue) => !PENDING_STATES.has(issue.syncState))
                .delete();

              // Записать сетевые гибридно с учётом оптимистичных локальных оверлеев
              for (const netIssue of networkIssuesWithAccount) {
                const key = issueKey(netIssue);
                const local = localIssueMap.get(key);
                const activeOp = pendingOutbox.find(
                  (op) => op.entityKey === key && op.type === 'update_issue',
                );

                if (local && activeOp) {
                  const hasConflict =
                    local.title !== netIssue.title || local.body !== netIssue.body;

                  await db.githubIssuesCache.put({
                    ...netIssue,
                    title: local.title,
                    body: local.body,
                    labels: local.labels,
                    state: local.state,
                    derivedStatus: local.derivedStatus,
                    derivedPriority: local.derivedPriority,
                    syncState: hasConflict ? 'conflict' : 'pending',
                  });
                } else {
                  await db.githubIssuesCache.put(netIssue);
                }
              }

              // Восстановить pending и временные карточки
              for (const localIssue of localPendingIssues) {
                const key = issueKey(localIssue);
                const isTemporary = localIssue.issueNumber < 0;
                const hasOutboxEntry = localIssue.clientLocalId
                  ? pendingOutboxKeys.has(localIssue.clientLocalId)
                  : pendingOutboxKeys.has(key);

                if (isTemporary || hasOutboxEntry) {
                  await db.githubIssuesCache.put(localIssue);
                }
              }

              await db.repositoryLabelsCache.put({
                repositoryFullName: repository.fullName,
                labels,
                cachedAt: new Date().toISOString(),
                accountId,
              });
            },
          );
        }

        const cached = await loadCachedState(accountId || null);
        set({ issues: cached.issues, stale: false, error: null });
      } catch (error: any) {
        const status = error?.status;
        if (status === 401) {
          session.clear();
          set({ api: null, user: null, error: 'Сессия GitHub истекла. Войдите снова.' });
        } else if (status === 403 || status === 429) {
          const headers = error?.response?.headers || {};
          const isRate = status === 429 || headers['x-ratelimit-remaining'] === '0';
          if (isRate) {
            set({ stale: true, error: 'GitHub API временно ограничил запросы. Показан кеш.' });
          } else {
            set({
              stale: true,
              error: 'Отказано в доступе. Убедитесь, что GitHub App имеет нужные разрешения.',
            });
          }
        } else if (status === 404) {
          set({ stale: true, error: 'Репозиторий не найден (404). Показан кеш.' });
        } else {
          set({ stale: true, error: 'Не удалось обновить Issues. Показан кеш.' });
        }
      }
    },

    toggleRepository: async (fullName) => {
      const repository = get().repositories.find((repo) => repo.fullName === fullName);
      if (!repository) return;
      const updated = { ...repository, pinned: !repository.pinned };
      await db.repositoriesCache.put(updated);
      set({
        repositories: get().repositories.map((repo) =>
          repo.fullName === fullName ? updated : repo,
        ),
      });
      if (updated.pinned) await get().refreshIssues(fullName);
    },

    createTask: async (input) => {
      const accountId = get().user ? String(get().user?.id) : undefined;
      if (!shouldPublishAsIssue(input.repositoryFullName, input.status)) {
        const note = createLocalNote({
          title: input.title,
          description: input.description,
          status: input.status,
          repositoryFullName: input.repositoryFullName,
          localTags: input.tags,
          checklist: input.checklist,
        });
        note.accountId = accountId || null;
        await db.localNotes.add(note);
        set({ notes: [note, ...get().notes], createDialog: { open: false } });
        return;
      }

      const repositoryFullName = input.repositoryFullName as string;
      const clientLocalId = crypto.randomUUID();
      const userLabels = input.tags.filter((t) => !t.startsWith('kf:') && !t.startsWith('km:'));
      const labels = labelsForMove(
        userLabels,
        input.status as Exclude<TaskStatus, 'question'>,
        input.priority,
      );
      const now = new Date().toISOString();

      const pending: GitHubIssue = {
        repositoryFullName,
        nodeId: `local:${clientLocalId}`,
        issueNumber: -Date.now(),
        clientLocalId,
        title: input.title,
        body: [
          input.description,
          input.checklist.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n'),
        ]
          .filter(Boolean)
          .join('\n\n'),
        state: input.status === 'done' ? 'closed' : 'open',
        derivedStatus: input.status as Exclude<TaskStatus, 'question'>,
        derivedPriority: input.priority,
        labels: labels.map((name) => ({ name, color: '8c959f' })),
        assignees: input.assignees,
        htmlUrl: '',
        createdAt: now,
        updatedAt: now,
        cachedAt: now,
        syncState: 'pending',
        statusConflict: false,
        priorityConflict: false,
        accountId,
      };

      const outboxOp: OutboxOperation = {
        id: crypto.randomUUID(),
        type: 'create_issue',
        entityKey: clientLocalId,
        repositoryFullName,
        payload: {
          title: pending.title,
          body: pending.body,
          labels,
          assignees: input.assignees,
          state: pending.state,
          clientLocalId,
        },
        state: 'pending',
        requestStarted: false,
        attemptCount: 0,
        creationStage: 'not_started',
        createdAt: now,
        updatedAt: now,
        accountId,
      };

      // Единая транзакция для сущности и outbox
      await db.transaction('rw', db.githubIssuesCache, db.outbox, async () => {
        await db.githubIssuesCache.add(pending);
        await db.outbox.add(outboxOp);
      });

      const cached = await loadCachedState(accountId || null);
      set({ ...cached, createDialog: { open: false } });
      await outboxProcessor.process();
    },

    updateNote: async (id, changes) => {
      const note = get().notes.find((item) => item.id === id);
      if (!note) return;
      const updated = { ...note, ...changes, id, updatedAt: new Date().toISOString() };
      if (updated.status === 'question' && !updated.repositoryFullName) {
        set({ error: '«Под вопросом» доступно только внутри репозитория.' });
        return;
      }
      if (
        updated.repositoryFullName &&
        updated.status !== 'question' &&
        updated.syncState !== 'pending'
      ) {
        set({ error: 'Локальная запись внутри репозитория может быть только «Под вопросом».' });
        return;
      }
      await db.localNotes.put(updated);
      set({ notes: get().notes.map((item) => (item.id === id ? updated : item)) });
    },

    deleteNote: async (id) => {
      await db.localNotes.delete(id);
      set({ notes: get().notes.filter((note) => note.id !== id), selectedTask: null });
    },

    updateIssuePlacement: async (key, changes) => {
      const issue = get().issues.find((i) => issueKey(i) === key || i.clientLocalId === key);
      if (!issue || issue.issueNumber < 0) return;

      const targetStatus = changes.status ?? issue.derivedStatus;
      const targetPriority = changes.priority ?? issue.derivedPriority;
      const finalLabels = labelsForMove(
        issue.labels.map((l) => l.name),
        targetStatus,
        targetPriority,
      );

      const optimistic: GitHubIssue = {
        ...issue,
        derivedStatus: targetStatus,
        derivedPriority: targetPriority,
        state: targetStatus === 'done' ? 'closed' : 'open',
        labels: finalLabels.map((name) => {
          const existing = issue.labels.find((l) => l.name === name);
          return existing ?? { name, color: '8c959f' };
        }),
        syncState: 'pending',
        updatedAt: new Date().toISOString(),
      };

      const accountId = get().user ? String(get().user?.id) : undefined;

      await db.transaction('rw', db.githubIssuesCache, db.outbox, async () => {
        await db.githubIssuesCache.put(optimistic);
        const existingOp = await db.outbox
          .where('entityKey')
          .equals(key)
          .and((op) => op.type === 'update_issue' && op.state !== 'syncing')
          .last();

        if (existingOp) {
          await db.outbox.put({
            ...existingOp,
            payload: {
              ...existingOp.payload,
              labels: finalLabels,
              state: optimistic.state,
            },
            state: 'pending',
            updatedAt: new Date().toISOString(),
          });
        } else {
          const op: OutboxOperation = {
            id: crypto.randomUUID(),
            type: 'update_issue',
            entityKey: key,
            repositoryFullName: issue.repositoryFullName,
            payload: {
              issueNumber: issue.issueNumber,
              labels: finalLabels,
              state: optimistic.state,
            },
            state: 'pending',
            requestStarted: false,
            attemptCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            accountId,
          };
          await db.outbox.add(op);
        }
      });

      const cached = await loadCachedState(accountId || null);
      set(cached);
      await outboxProcessor.process();
    },

    changeIssueStatus: async (issue, status) => {
      await get().updateIssuePlacement(issueKey(issue), { status });
    },

    changeIssuePriority: async (issue, priority) => {
      await get().updateIssuePlacement(issueKey(issue), { priority });
    },

    moveIssue: async (issue, { status, priority }) => {
      await get().updateIssuePlacement(issueKey(issue), { status, priority });
    },

    updateIssueFields: async (issue, changes) => {
      if (issue.issueNumber < 0) return;
      const key = issueKey(issue);
      const optimistic = {
        ...issue,
        ...changes,
        updatedAt: new Date().toISOString(),
        syncState: 'pending' as const,
      };
      const accountId = get().user ? String(get().user?.id) : undefined;

      await db.transaction('rw', db.githubIssuesCache, db.outbox, async () => {
        await db.githubIssuesCache.put(optimistic);
        await db.outbox.add({
          id: crypto.randomUUID(),
          type: 'update_issue',
          entityKey: key,
          repositoryFullName: issue.repositoryFullName,
          payload: { issueNumber: issue.issueNumber, ...changes },
          state: 'pending',
          requestStarted: false,
          attemptCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          accountId,
        });
      });

      const cached = await loadCachedState(accountId || null);
      set(cached);
      await outboxProcessor.process();
    },

    moveIssueToQuestion: async (issue) => {
      if (issue.issueNumber < 0) return;
      const key = issueKey(issue);
      const { checklist, description } = extractChecklistFromMarkdown(issue.body);
      const userLabels = stripSystemLabels(issue.labels);
      const accountId = get().user ? String(get().user?.id) : undefined;

      await db.transaction('rw', db.githubIssuesCache, db.outbox, async () => {
        await db.outbox.add({
          id: crypto.randomUUID(),
          type: 'close_and_copy',
          entityKey: key,
          repositoryFullName: issue.repositoryFullName,
          payload: {
            issueNumber: issue.issueNumber,
            note: {
              title: issue.title,
              description,
              status: 'question',
              repositoryFullName: issue.repositoryFullName,
              localTags: userLabels,
              checklist,
            },
          },
          state: 'pending',
          requestStarted: false,
          attemptCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          accountId,
        });
      });

      const cached = await loadCachedState(accountId || null);
      set(cached);
      await outboxProcessor.process();
    },

    requestConversion: (noteId, context) => {
      set({
        conversionDialog: {
          noteId,
          repositoryFullName: context?.repositoryFullName,
          status: context?.status,
          priority: context?.priority,
        },
      });
    },

    confirmConversion: async (draft) => {
      const note = get().notes.find((item) => item.id === get().conversionDialog.noteId);
      if (!note) return;
      const cachedLabels = await db.repositoryLabelsCache.get(draft.repositoryFullName);
      const repoLabelNames = cachedLabels?.labels.map((label) => label.name) || [];
      const matchedTags = note.localTags.filter((tag) => repoLabelNames.includes(tag));
      let labels = [...new Set([...draft.labels, ...matchedTags])];
      labels = labelsForMove(labels, draft.status, draft.priority);

      const accountId = get().user ? String(get().user?.id) : undefined;
      const updatedNote: LocalNote = {
        ...note,
        syncState: 'pending',
        pendingConversionData: draft,
        repositoryFullName: draft.repositoryFullName,
        updatedAt: new Date().toISOString(),
      };

      const outboxOp: OutboxOperation = {
        id: crypto.randomUUID(),
        type: 'convert_note',
        entityKey: note.id,
        repositoryFullName: draft.repositoryFullName,
        sourceNoteId: note.id,
        payload: {
          title: note.title,
          body: noteToIssueBody(note, matchedTags),
          labels,
          assignees: draft.assignees,
          state: draft.status === 'done' ? 'closed' : 'open',
        },
        state: 'pending',
        requestStarted: false,
        attemptCount: 0,
        creationStage: 'not_started',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        accountId,
      };

      // Атомарное обновление заметки и outbox
      await db.transaction('rw', db.localNotes, db.outbox, async () => {
        await db.localNotes.put(updatedNote);
        await db.outbox.add(outboxOp);
      });

      const cached = await loadCachedState(accountId || null);
      set({ ...cached, conversionDialog: { noteId: null } });
      await outboxProcessor.process();
    },

    openEntity: async (entity, options) => {
      const existing = !options?.duplicate
        ? get().tabs.find((tab) => entitySignature(tab.entity) === entitySignature(entity))
        : undefined;
      if (existing) return get().selectTab(existing.id);

      const accountId = get().user ? String(get().user?.id) : undefined;
      if (!options?.newTab) {
        const tabs = get().tabs.map((tab) =>
          tab.active ? { ...tab, entity, title: titleForEntity(entity) } : tab,
        );
        await persistTabs(tabs, accountId);
        set({ tabs, selectedTask: null });
        return;
      }
      const tabs = get().tabs.map((tab) => ({ ...tab, active: false }));
      const tab: WorkspaceTab = {
        id: crypto.randomUUID(),
        entity,
        title: titleForEntity(entity),
        position: tabs.length,
        active: true,
        accountId,
      };
      const next = [...tabs, tab];
      await persistTabs(next, accountId);
      set({ tabs: next, selectedTask: null });
    },

    closeTab: async (id) => {
      const current = get().tabs;
      const accountId = get().user ? String(get().user?.id) : undefined;
      if (current.length === 1) {
        const reset = [
          {
            ...current[0]!,
            entity: { kind: 'all' } as const,
            title: 'Все задачи',
            active: true,
            accountId,
          },
        ];
        await persistTabs(reset, accountId);
        set({ tabs: reset });
        return;
      }
      const closing = current.find((tab) => tab.id === id);
      let next = current
        .filter((tab) => tab.id !== id)
        .map((tab, position) => ({ ...tab, position }));
      if (closing?.active)
        next = next.map((tab, index) => ({
          ...tab,
          active: index === Math.max(0, next.length - 1),
        }));
      await persistTabs(next, accountId);
      set({ tabs: next });
    },

    selectTab: async (id) => {
      const accountId = get().user ? String(get().user?.id) : undefined;
      const tabs = get().tabs.map((tab) => ({ ...tab, active: tab.id === id }));
      await persistTabs(tabs, accountId);
      set({ tabs, selectedTask: null });
    },

    setSelectedTask: (selectedTask) => set({ selectedTask }),
    setCreateOpen: (open, context) =>
      set({
        createDialog: {
          open,
          initialRepositoryFullName: context?.initialRepositoryFullName,
          initialStatus: context?.initialStatus,
          initialPriority: context?.initialPriority,
        },
      }),
    setRepositoryPickerOpen: (repositoryPickerOpen) => set({ repositoryPickerOpen }),
    setConversionNoteId: (noteId) =>
      set({
        conversionDialog: {
          noteId,
          repositoryFullName: noteId ? get().conversionDialog.repositoryFullName : undefined,
        },
      }),
    retryOperation: async (id) => outboxProcessor.retry(id),

    getRepositoryLabels: async (repositoryFullName) => {
      const api = get().api;
      if (navigator.onLine && api) {
        try {
          const freshLabels = await api.getLabels(repositoryFullName);
          await db.repositoryLabelsCache.put({
            repositoryFullName,
            labels: freshLabels,
            cachedAt: new Date().toISOString(),
            accountId: get().user ? String(get().user?.id) : undefined,
          });
          return visibleLabels(freshLabels);
        } catch {
          // fall through to cache
        }
      }
      const cached = await db.repositoryLabelsCache.get(repositoryFullName);
      if (!cached) return [];
      return visibleLabels(cached.labels);
    },

    getRepositoryAssignees: async (repositoryFullName) => {
      const api = get().api;
      if (navigator.onLine && api) {
        try {
          const issues = await api.getIssues(repositoryFullName);
          const assigneesSet = new Set<string>();
          for (const issue of issues) {
            for (const assignee of issue.assignees) {
              if (assignee) assigneesSet.add(assignee);
            }
          }
          if (get().user?.login) assigneesSet.add(get().user!.login);
          return Array.from(assigneesSet);
        } catch {
          // fallback below
        }
      }
      const cachedIssues = await db.githubIssuesCache
        .where('repositoryFullName')
        .equals(repositoryFullName)
        .toArray();
      const assigneesSet = new Set<string>();
      for (const issue of cachedIssues) {
        for (const assignee of issue.assignees) {
          if (assignee) assigneesSet.add(assignee);
        }
      }
      if (get().user?.login) assigneesSet.add(get().user!.login);
      return Array.from(assigneesSet);
    },
  };
});
