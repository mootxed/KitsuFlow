import { create } from 'zustand';
import { db } from '../data/db';
import {
  labelsForMove,
  labelsForPriority,
  labelsForStatus,
  visibleLabels,
} from '../domain/github-mapping';
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
  createOpen: boolean;
  repositoryPickerOpen: boolean;
  conversionNoteId: string | null;
  conversionRepositoryFullName: string | null;
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
  changeIssueStatus: (issue: GitHubIssue, status: Exclude<TaskStatus, 'question'>) => Promise<void>;
  changeIssuePriority: (issue: GitHubIssue, priority: IssuePriority) => Promise<void>;
  /**
   * Атомарно переносит Issue в другую комбинацию статус+приоритет.
   * Вычисляет итоговые labels один раз, выполняет одно оптимистичное обновление
   * и одну outbox-операцию.
   */
  moveIssue: (
    issue: GitHubIssue,
    target: { status: Exclude<TaskStatus, 'question'>; priority: IssuePriority },
  ) => Promise<void>;
  updateIssueFields: (
    issue: GitHubIssue,
    changes: { title: string; body: string },
  ) => Promise<void>;
  moveIssueToQuestion: (issue: GitHubIssue) => Promise<void>;
  requestConversion: (noteId: string, repositoryFullName?: string) => void;
  confirmConversion: (draft: {
    repositoryFullName: string;
    status: Exclude<TaskStatus, 'question'>;
    priority: IssuePriority;
    labels: string[];
    assignees: string[];
  }) => Promise<void>;
  openEntity: (
    entity: TabEntity,
    options?: { duplicate?: boolean; newTab?: boolean },
  ) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  selectTab: (id: string) => Promise<void>;
  setSelectedTask: (task: SelectedTask) => void;
  setCreateOpen: (open: boolean) => void;
  setRepositoryPickerOpen: (open: boolean) => void;
  setConversionNoteId: (id: string | null) => void;
  retryOperation: (id: string) => Promise<void>;
  getRepositoryLabels: (
    repositoryFullName: string,
  ) => Promise<Array<{ name: string; color: string }>>;
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

async function loadCachedState() {
  const [repositories, notes, issues, tabs, outbox] = await Promise.all([
    db.repositoriesCache.toArray(),
    db.localNotes.orderBy('updatedAt').reverse().toArray(),
    db.githubIssuesCache.orderBy('updatedAt').reverse().toArray(),
    db.tabs.orderBy('position').toArray(),
    db.outbox.orderBy('createdAt').toArray(),
  ]);
  return { repositories, notes, issues, tabs, outbox };
}

async function persistTabs(tabs: WorkspaceTab[]): Promise<void> {
  await db.transaction('rw', db.tabs, async () => {
    await db.tabs.clear();
    await db.tabs.bulkPut(tabs);
  });
}

export const useAppStore = create<AppState>((set, get) => {
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
    const cached = await loadCachedState();
    set(cached);
  };
  outboxProcessor = new OutboxProcessor(() => get().api, handleSyncEvent);

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
    createOpen: false,
    repositoryPickerOpen: false,
    conversionNoteId: null,
    conversionRepositoryFullName: null,
    online: navigator.onLine,
    stale: !navigator.onLine,
    error: null,
    rateLimitUntil: null,

    initialize: async () => {
      const cached = await loadCachedState();
      let tabs = cached.tabs;
      if (!tabs.length) {
        tabs = [
          {
            id: crypto.randomUUID(),
            entity: { kind: 'all' },
            title: 'Все задачи',
            position: 0,
            active: true,
          },
        ];
        await persistTabs(tabs);
      }
      set({ ...cached, tabs, loading: false, initialized: true });
      const token = session.getToken();
      if (token) {
        const api = new GitHubApi(token);
        try {
          const user = await api.getCurrentUser();
          set({ api, user, error: null });
          await get().refreshRepositories();
          // Сначала outbox, потом refresh — избегаем гонки
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
        // Последовательно: сначала outbox, затем refresh
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
        set({ api, user, auth: { phase: 'idle' }, error: null });
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
      set({ api: null, user: null, auth: { phase: 'idle' }, selectedTask: null });
    },

    refreshRepositories: async () => {
      const api = get().api;
      if (!api || !navigator.onLine) return;
      try {
        const current = new Map(get().repositories.map((repo) => [repo.fullName, repo]));
        const repositories = (await api.getRepositories()).map((repo) => ({
          ...repo,
          pinned: current.get(repo.fullName)?.pinned || false,
        }));
        await db.repositoriesCache.bulkPut(repositories);
        set({ repositories, error: null });
      } catch (error: any) {
        set({
          error:
            error?.status === 403
              ? 'Нет доступа к установкам GitHub App.'
              : 'Не удалось загрузить репозитории.',
        });
      }
    },

    refreshIssues: async (repositoryFullName) => {
      const api = get().api;
      if (!api || !navigator.onLine) return;
      const repositories = repositoryFullName
        ? get().repositories.filter((repo) => repo.fullName === repositoryFullName)
        : get().repositories.filter((repo) => repo.pinned);
      try {
        for (const repository of repositories) {
          const [networkIssues, labels] = await Promise.all([
            api.getIssues(repository.fullName),
            api.getLabels(repository.fullName),
          ]);
          await db.transaction(
            'rw',
            db.githubIssuesCache,
            db.repositoryLabelsCache,
            db.outbox,
            async () => {
              // Получаем entityKey для операций в outbox этого репозитория
              const pendingOutboxKeys = new Set(
                (
                  await db.outbox
                    .where('repositoryFullName')
                    .equals(repository.fullName)
                    .and((op) => PENDING_STATES.has(op.state))
                    .toArray()
                ).map((op) => op.entityKey),
              );

              // Получаем текущие pending/syncing/failed/attention/exhausted Issues
              const localPendingIssues = await db.githubIssuesCache
                .where('repositoryFullName')
                .equals(repository.fullName)
                .and((issue) => PENDING_STATES.has(issue.syncState))
                .toArray();

              // Удаляем только подтверждённые (synced/conflict) Issues этого репозитория
              const networkIssueKeys = new Set(
                networkIssues.map((i) => `${i.repositoryFullName}#${i.issueNumber}`),
              );
              await db.githubIssuesCache
                .where('repositoryFullName')
                .equals(repository.fullName)
                .and((issue) => !PENDING_STATES.has(issue.syncState))
                .delete();

              // Записываем сетевые Issues
              await db.githubIssuesCache.bulkPut(networkIssues);

              // Восстанавливаем pending-карточки, которых нет в сетевом ответе
              // (они ещё не подтверждены GitHub или имеют временный номер)
              for (const localIssue of localPendingIssues) {
                const key = `${localIssue.repositoryFullName}#${localIssue.issueNumber}`;
                const isTemporary = localIssue.issueNumber < 0;
                const confirmedByNetwork = networkIssueKeys.has(key);
                const hasOutboxEntry = localIssue.clientLocalId
                  ? pendingOutboxKeys.has(localIssue.clientLocalId)
                  : pendingOutboxKeys.has(key);
                if (isTemporary || (!confirmedByNetwork && hasOutboxEntry)) {
                  await db.githubIssuesCache.put(localIssue);
                }
              }

              await db.repositoryLabelsCache.put({
                repositoryFullName: repository.fullName,
                labels,
                cachedAt: new Date().toISOString(),
              });
            },
          );
        }
        const issues = await db.githubIssuesCache.orderBy('updatedAt').reverse().toArray();
        set({ issues, stale: false, error: null });
      } catch (error: any) {
        if (error?.status === 401) {
          session.clear();
          set({ api: null, user: null, error: 'Сессия GitHub истекла. Войдите снова.' });
        } else if (error?.status === 403 || error?.status === 429) {
          set({ stale: true, error: 'GitHub API временно ограничил запросы. Показан кеш.' });
        } else set({ stale: true, error: 'Не удалось обновить Issues. Показан кеш.' });
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
      if (!shouldPublishAsIssue(input.repositoryFullName, input.status)) {
        const note = createLocalNote({
          title: input.title,
          description: input.description,
          status: input.status,
          repositoryFullName: input.repositoryFullName,
          localTags: input.tags,
          checklist: input.checklist,
        });
        await db.localNotes.add(note);
        set({ notes: [note, ...get().notes], createOpen: false });
        return;
      }
      const repositoryFullName = input.repositoryFullName as string;
      const clientLocalId = crypto.randomUUID();
      // Используем labelsForMove для атомарного вычисления labels
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
      };
      await db.githubIssuesCache.add(pending);
      await outboxProcessor.enqueue({
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
      });
      set({ issues: [pending, ...get().issues], createOpen: false });
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

    changeIssueStatus: async (issue, status) => {
      if (issue.issueNumber < 0) return;
      const labelNames = labelsForStatus(
        issue.labels.map((label) => label.name),
        status,
      );
      const optimistic = {
        ...issue,
        derivedStatus: status,
        state: status === 'done' ? ('closed' as const) : ('open' as const),
        syncState: 'pending' as const,
      };
      await db.githubIssuesCache.put(optimistic);
      set({
        issues: get().issues.map((item) =>
          issueKey(item) === issueKey(issue) ? optimistic : item,
        ),
      });
      await outboxProcessor.enqueue({
        type: 'update_issue',
        entityKey: issueKey(issue),
        repositoryFullName: issue.repositoryFullName,
        payload: { issueNumber: issue.issueNumber, labels: labelNames, state: optimistic.state },
      });
      await outboxProcessor.process();
    },

    changeIssuePriority: async (issue, priority) => {
      if (issue.issueNumber < 0) return;
      const labelNames = labelsForPriority(
        issue.labels.map((label) => label.name),
        priority,
      );
      const optimistic = { ...issue, derivedPriority: priority, syncState: 'pending' as const };
      await db.githubIssuesCache.put(optimistic);
      set({
        issues: get().issues.map((item) =>
          issueKey(item) === issueKey(issue) ? optimistic : item,
        ),
      });
      await outboxProcessor.enqueue({
        type: 'update_issue',
        entityKey: issueKey(issue),
        repositoryFullName: issue.repositoryFullName,
        payload: { issueNumber: issue.issueNumber, labels: labelNames },
      });
      await outboxProcessor.process();
    },

    moveIssue: async (issue, { status, priority }) => {
      if (issue.issueNumber < 0) return;
      // Вычисляем итоговые labels атомарно — один раз
      const finalLabels = labelsForMove(
        issue.labels.map((label) => label.name),
        status,
        priority,
      );
      const optimistic: GitHubIssue = {
        ...issue,
        derivedStatus: status,
        derivedPriority: priority,
        state: status === 'done' ? 'closed' : 'open',
        labels: finalLabels.map((name) => {
          const existing = issue.labels.find((l) => l.name === name);
          return existing ?? { name, color: '8c959f' };
        }),
        syncState: 'pending',
      };
      // Одно оптимистичное обновление
      await db.githubIssuesCache.put(optimistic);
      set({
        issues: get().issues.map((item) =>
          issueKey(item) === issueKey(issue) ? optimistic : item,
        ),
      });
      // Одна outbox-операция
      await outboxProcessor.enqueue({
        type: 'update_issue',
        entityKey: issueKey(issue),
        repositoryFullName: issue.repositoryFullName,
        payload: {
          issueNumber: issue.issueNumber,
          labels: finalLabels,
          state: optimistic.state,
        },
      });
      await outboxProcessor.process();
    },

    updateIssueFields: async (issue, changes) => {
      if (issue.issueNumber < 0) return;
      const optimistic = {
        ...issue,
        ...changes,
        updatedAt: new Date().toISOString(),
        syncState: 'pending' as const,
      };
      await db.githubIssuesCache.put(optimistic);
      set({
        issues: get().issues.map((item) =>
          issueKey(item) === issueKey(issue) ? optimistic : item,
        ),
      });
      await outboxProcessor.enqueue({
        type: 'update_issue',
        entityKey: issueKey(issue),
        repositoryFullName: issue.repositoryFullName,
        payload: { issueNumber: issue.issueNumber, ...changes },
      });
      await outboxProcessor.process();
    },

    moveIssueToQuestion: async (issue) => {
      if (issue.issueNumber < 0) return;
      // Извлекаем checklist из body, не копируем системные labels
      const { checklist, description } = extractChecklistFromMarkdown(issue.body);
      const userLabels = stripSystemLabels(issue.labels);
      await outboxProcessor.enqueue({
        type: 'close_and_copy',
        entityKey: issueKey(issue),
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
      });
      await outboxProcessor.process();
    },

    requestConversion: (noteId, repositoryFullName) => {
      set({ conversionNoteId: noteId, conversionRepositoryFullName: repositoryFullName || null });
    },

    confirmConversion: async (draft) => {
      const note = get().notes.find((item) => item.id === get().conversionNoteId);
      if (!note) return;
      const cachedLabels = await db.repositoryLabelsCache.get(draft.repositoryFullName);
      const repoLabelNames = cachedLabels?.labels.map((label) => label.name) || [];
      // Совпавшие теги (только если они есть в репозитории)
      const matchedTags = note.localTags.filter((tag) => repoLabelNames.includes(tag));
      let labels = [...new Set([...draft.labels, ...matchedTags])];
      labels = labelsForMove(labels, draft.status, draft.priority);
      await get().updateNote(note.id, {
        syncState: 'pending',
        pendingConversionData: draft,
        repositoryFullName: draft.repositoryFullName,
      });
      await outboxProcessor.enqueue({
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
      });
      set({ conversionNoteId: null, conversionRepositoryFullName: null });
      await outboxProcessor.process();
    },

    openEntity: async (entity, options) => {
      const existing = !options?.duplicate
        ? get().tabs.find((tab) => entitySignature(tab.entity) === entitySignature(entity))
        : undefined;
      if (existing) return get().selectTab(existing.id);
      if (!options?.newTab) {
        const tabs = get().tabs.map((tab) =>
          tab.active ? { ...tab, entity, title: titleForEntity(entity) } : tab,
        );
        await persistTabs(tabs);
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
      };
      const next = [...tabs, tab];
      await persistTabs(next);
      set({ tabs: next, selectedTask: null });
    },

    closeTab: async (id) => {
      const current = get().tabs;
      if (current.length === 1) {
        const reset = [
          { ...current[0]!, entity: { kind: 'all' } as const, title: 'Все задачи', active: true },
        ];
        await persistTabs(reset);
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
      await persistTabs(next);
      set({ tabs: next });
    },

    selectTab: async (id) => {
      const tabs = get().tabs.map((tab) => ({ ...tab, active: tab.id === id }));
      await persistTabs(tabs);
      set({ tabs, selectedTask: null });
    },

    setSelectedTask: (selectedTask) => set({ selectedTask }),
    setCreateOpen: (createOpen) => set({ createOpen }),
    setRepositoryPickerOpen: (repositoryPickerOpen) => set({ repositoryPickerOpen }),
    setConversionNoteId: (conversionNoteId) =>
      set({
        conversionNoteId,
        conversionRepositoryFullName: conversionNoteId ? get().conversionRepositoryFullName : null,
      }),
    retryOperation: async (id) => outboxProcessor.retry(id),

    getRepositoryLabels: async (repositoryFullName) => {
      const cached = await db.repositoryLabelsCache.get(repositoryFullName);
      if (!cached) return [];
      // Возвращаем только пользовательские labels (без системных)
      return visibleLabels(cached.labels);
    },
  };
});
