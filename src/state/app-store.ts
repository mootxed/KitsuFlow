import { create } from 'zustand';
import { db } from '../data/db';
import { assertAccountId, labelsForMove, visibleLabels } from '../domain/github-mapping';
import {
  defaultTab,
  ensureDefaultTab,
  tabEntitySignature,
  titleForTabEntity,
} from '../domain/tabs';
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
  OAuthFlowPhase,
  OutboxOperation,
  PendingIssue,
  Repository,
  TabEntity,
  TaskStatus,
  WorkspaceTab,
} from '../domain/types';
import { GitHubApi } from '../github/api';
import { parseGitHubError } from '../github/errors';
import { APP_CONFIG } from '../config';
import { DeviceFlowController } from '../github/device-flow';
import {
  buildAuthUrl,
  cleanOAuthCallbackUrl,
  consumePkceState,
  exchangeCode,
  generatePkce,
  parseCallback,
  refreshAccessToken,
  revokeRefreshSession,
  savePkceState,
} from '../github/oauth-pkce';
import { session, type GitHubAuthSession } from '../github/session';
import { OutboxProcessor, type SyncEvent } from '../sync/outbox';
import {
  beginRepositoryRefresh,
  isLatestRepositoryRefresh,
  markRepositoryMutation,
  wasMutatedAfter,
} from '../sync/repository-revisions';

export type SelectedTask =
  | { kind: 'note'; id: string }
  | { kind: 'pending-issue'; clientLocalId: string }
  | { kind: 'issue'; key: string }
  | null;

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

/** Флаг legacy-unassigned данных для диалога присвоения аккаунту. */
export interface LegacyClaimState {
  hasLegacyData: boolean;
  counts: {
    repositories: number;
    issues: number;
    pendingIssues: number;
    notes: number;
    outbox: number;
    tabs: number;
    labels: number;
    assignees: number;
    syncMetadata: number;
  };
}

interface AppState {
  initialized: boolean;
  loading: boolean;
  user: GitHubUser | null;
  auth: OAuthFlowPhase;
  api: GitHubApi | null;
  repositories: Repository[];
  notes: LocalNote[];
  issues: GitHubIssue[];
  pendingIssues: PendingIssue[];
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
  /** Поколение сессии — инкрементируется при каждом login/logout для отмены stale запросов. */
  sessionGeneration: number;
  legacyClaim: LegacyClaimState;

  initialize: () => Promise<void>;
  login: () => Promise<void>;
  /** Инициирует PKCE OAuth flow (редирект на GitHub). */
  loginWithPkce: () => Promise<void>;
  /** Обрабатывает OAuth callback после редиректа с GitHub. */
  handleOAuthCallback: (url: URL) => Promise<boolean>;
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
    changes: {
      title?: string | undefined;
      body?: string | undefined;
      labels?: string[] | undefined;
      assignees?: string[] | undefined;
    },
  ) => Promise<void>;

  moveIssueToQuestion: (issue: GitHubIssue) => Promise<void>;
  requestConversion: (
    noteId: string,
    context?: {
      repositoryFullName?: string | undefined;
      status?: TaskStatus | undefined;
      priority?: IssuePriority | undefined;
    },
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
    options?: { newTab?: boolean | undefined; duplicate?: boolean | undefined },
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
  retryAmbiguousOperation: (id: string) => Promise<void>;
  updatePendingOperation: (
    clientLocalId: string,
    changes: {
      title?: string | undefined;
      body?: string | undefined;
      repositoryFullName?: string | undefined;
      labels?: string[] | undefined;
      assignees?: string[] | undefined;
      status?: Exclude<TaskStatus, 'question'> | undefined;
      priority?: IssuePriority | undefined;
    },
  ) => Promise<void>;
  cancelPendingOperation: (clientLocalId: string) => Promise<void>;
  getRepositoryLabels: (
    repositoryFullName: string,
  ) => Promise<Array<{ name: string; color: string }>>;
  getRepositoryAssignees: (repositoryFullName: string) => Promise<string[]>;
  /** Привязывает legacy-unassigned данные к текущему аккаунту. */
  claimLegacyData: () => Promise<void>;
  /** Отклоняет привязку legacy данных (закрывает диалог). */
  dismissLegacyClaim: () => void;
}

const PENDING_STATES = new Set(['pending', 'syncing', 'failed', 'attention', 'exhausted']);

const deviceFlow = new DeviceFlowController();
let outboxProcessor: OutboxProcessor;
let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let tokenRefreshPromise: Promise<GitHubAuthSession> | null = null;

const issueKey = (issue: Pick<GitHubIssue, 'repositoryFullName' | 'issueNumber'>) =>
  `${issue.repositoryFullName}#${issue.issueNumber}`;

export async function loadLocalDeviceState() {
  const [notes, storedTabs] = await Promise.all([
    db.localNotes
      .filter((note) => note.accountId === null)
      .sortBy('updatedAt')
      .then((res) => res.reverse()),
    db.tabs.filter((tab) => tab.accountId === null).sortBy('position'),
  ]);
  const tabs = await persistTabs(ensureDefaultTab(storedTabs, null), null);

  return {
    repositories: [],
    notes,
    issues: [],
    pendingIssues: [],
    tabs,
    outbox: [],
  };
}

export async function loadGitHubAccountState(accountId: string) {
  assertAccountId(accountId);
  const [repositories, notes, issues, pendingIssues, storedTabs, outbox] = await Promise.all([
    db.repositoriesCache.where('accountId').equals(accountId).toArray(),
    db.localNotes
      .filter((note) => note.accountId === null || note.accountId === accountId)
      .sortBy('updatedAt')
      .then((res) => res.reverse()),
    db.githubIssuesCache.where('accountId').equals(accountId).toArray(),
    db.pendingIssues.where('accountId').equals(accountId).toArray(),
    db.tabs.where('accountId').equals(accountId).sortBy('position'),
    db.outbox.where('accountId').equals(accountId).sortBy('createdAt'),
  ]);
  const tabs = await persistTabs(ensureDefaultTab(storedTabs, accountId), accountId);

  return {
    repositories,
    notes,
    issues,
    pendingIssues,
    tabs,
    outbox,
  };
}

async function persistTabs(
  tabs: WorkspaceTab[],
  accountId?: string | null,
): Promise<WorkspaceTab[]> {
  const currentAccountId = accountId || null;
  const tabsWithAccount = ensureDefaultTab(tabs, currentAccountId);
  await db.transaction('rw', db.tabs, async () => {
    if (currentAccountId) {
      await db.tabs.where('accountId').equals(currentAccountId).delete();
    } else {
      const nullTabs = await db.tabs.filter((t) => t.accountId === null).toArray();
      await db.tabs.bulkDelete(nullTabs.map((t) => t.id));
    }
    await db.tabs.bulkPut(tabsWithAccount);
  });
  return tabsWithAccount;
}

/** Проверяет наличие данных с accountId === 'legacy-unassigned'. */
async function checkLegacyData(accountId: string): Promise<LegacyClaimState> {
  const dismissal = await db.settings.get(`legacy-claim:${accountId}`);
  const [
    repositories,
    issues,
    pendingIssues,
    notes,
    outbox,
    tabs,
    labels,
    assignees,
    syncMetadata,
  ] = await Promise.all([
    db.repositoriesCache.where('accountId').equals('legacy-unassigned').count(),
    db.githubIssuesCache.where('accountId').equals('legacy-unassigned').count(),
    db.pendingIssues.where('accountId').equals('legacy-unassigned').count(),
    db.localNotes.filter((n) => n.accountId === 'legacy-unassigned').count(),
    db.outbox.where('accountId').equals('legacy-unassigned').count(),
    db.tabs.where('accountId').equals('legacy-unassigned').count(),
    db.repositoryLabelsCache.where('accountId').equals('legacy-unassigned').count(),
    db.repositoryAssigneesCache.where('accountId').equals('legacy-unassigned').count(),
    db.syncMetadata.where('accountId').equals('legacy-unassigned').count(),
  ]);
  const counts = {
    repositories,
    issues,
    pendingIssues,
    notes,
    outbox,
    tabs,
    labels,
    assignees,
    syncMetadata,
  };
  const hasLegacyData =
    dismissal?.value !== 'never' && Object.values(counts).some((count) => count > 0);
  return { hasLegacyData, counts };
}

const emptyLegacyClaim = (): LegacyClaimState => ({
  hasLegacyData: false,
  counts: {
    repositories: 0,
    issues: 0,
    pendingIssues: 0,
    notes: 0,
    outbox: 0,
    tabs: 0,
    labels: 0,
    assignees: 0,
    syncMetadata: 0,
  },
});

let listenersAttached = false;
export function attachConnectivityListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
}

export function detachConnectivityListeners(): void {
  if (!listenersAttached) return;
  listenersAttached = false;
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
}

function handleOnline(): void {
  const store = useAppStore.getState();
  useAppStore.setState({ online: true });
  void outboxProcessor.process().then(() => store.refreshIssues());
}

function handleOffline(): void {
  useAppStore.setState({ online: false, stale: true });
}

export const useAppStore = create<AppState>((set, get) => {
  const activeAuthRetries = new Set<'repositories' | 'issues'>();
  const ensureRepositoryWritable = (repositoryFullName: string): boolean => {
    const repository = get().repositories.find((item) => item.fullName === repositoryFullName);
    if (!repository || repository.permissions.push) return true;
    set({ error: `Репозиторий ${repositoryFullName} доступен только для чтения.` });
    return false;
  };

  const clearTokenRefreshTimer = (): void => {
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = null;
  };

  const scheduleTokenRefresh = (credentials: GitHubAuthSession, generation: number): void => {
    clearTokenRefreshTimer();
    if (!credentials.expiresAt || !credentials.refreshSessionId) return;
    const delay = Math.max(0, credentials.expiresAt - Date.now() - 60_000);
    tokenRefreshTimer = setTimeout(() => {
      tokenRefreshTimer = null;
      void refreshStoredSession(generation, true)
        .then(() => outboxProcessor.process())
        .catch(() => {
          if (get().sessionGeneration === generation) get().logout();
        });
    }, delay);
  };

  const refreshStoredSession = async (
    generation: number,
    force = false,
  ): Promise<GitHubAuthSession> => {
    const current = session.get();
    if (!current) throw new Error('Сессия GitHub отсутствует.');
    const needsRefresh = Boolean(current.expiresAt) && current.expiresAt! <= Date.now() + 60_000;
    if (!force && !needsRefresh) {
      scheduleTokenRefresh(current, generation);
      return current;
    }
    if (!current.refreshSessionId) {
      if (!needsRefresh && !force) return current;
      throw new Error('GitHub refresh-сессия отсутствует. Выполните вход снова.');
    }
    tokenRefreshPromise ||= refreshAccessToken(current);
    try {
      const refreshed = await tokenRefreshPromise;
      if (get().sessionGeneration !== generation)
        throw new DOMException('Stale session', 'AbortError');
      session.set(refreshed);
      if (get().user) set({ api: new GitHubApi(refreshed.accessToken), error: null });
      scheduleTokenRefresh(refreshed, generation);
      return refreshed;
    } finally {
      tokenRefreshPromise = null;
    }
  };

  const handleIssueCreated = async (tempId: string | number, realIssue: GitHubIssue) => {
    const { selectedTask, sessionGeneration } = get();
    if (selectedTask?.kind === 'pending-issue' && selectedTask.clientLocalId === String(tempId)) {
      set({ selectedTask: { kind: 'issue', key: issueKey(realIssue) } });
    } else if (selectedTask?.kind === 'note' && selectedTask.id === String(tempId)) {
      set({ selectedTask: { kind: 'issue', key: issueKey(realIssue) } });
    }
    const currentAccountId = get().user ? String(get().user?.id) : null;
    // Проверяем, что сессия не изменилась пока ждали
    if (get().sessionGeneration !== sessionGeneration) return;
    const cached = currentAccountId
      ? await loadGitHubAccountState(currentAccountId)
      : await loadLocalDeviceState();
    if (get().sessionGeneration !== sessionGeneration) return;
    set({
      tabs: cached.tabs,
      issues: cached.issues,
      pendingIssues: cached.pendingIssues,
      outbox: cached.outbox,
    });
  };

  const handleSyncEvent = async (event: SyncEvent) => {
    const { sessionGeneration } = get();
    if (event.type === 'unauthorized') {
      try {
        await refreshStoredSession(sessionGeneration, true);
        setTimeout(() => void outboxProcessor.retry(event.operationId), 0);
        return;
      } catch {
        get().logout();
        set({ error: 'Сессия GitHub истекла. Войдите снова; очередь сохранена.' });
        return;
      }
    }
    if (event.type === 'rate-limited') set({ rateLimitUntil: event.retryAt });
    if (event.type === 'permission-denied') {
      set({ error: `Нет доступа: ${event.message}` });
    }
    const currentAccountId = get().user ? String(get().user?.id) : null;
    if (get().sessionGeneration !== sessionGeneration) return;
    const cached = currentAccountId
      ? await loadGitHubAccountState(currentAccountId)
      : await loadLocalDeviceState();
    if (get().sessionGeneration !== sessionGeneration) return;
    set(cached);
  };

  outboxProcessor = new OutboxProcessor({
    getApi: () => get?.()?.api ?? null,
    getActiveAccountId: () => {
      const state = get?.();
      return state?.user ? String(state.user.id) : null;
    },
    onEvent: handleSyncEvent,
    onIssueCreated: handleIssueCreated,
  });

  const restoreAuthenticatedSession = async (
    token: string,
    generation: number,
    authAfterRestore?: OAuthFlowPhase,
  ): Promise<boolean> => {
    const api = new GitHubApi(token);
    const user = await api.getCurrentUser();
    if (get().sessionGeneration !== generation) return false;
    session.setToken(token);
    const accountId = String(user.id);
    const cached = await loadGitHubAccountState(accountId);
    if (get().sessionGeneration !== generation) return false;
    set({
      api,
      user,
      error: null,
      ...cached,
      ...(authAfterRestore ? { auth: authAfterRestore } : {}),
    });
    const credentials = session.get();
    if (credentials) scheduleTokenRefresh(credentials, generation);
    set({ legacyClaim: await checkLegacyData(accountId) });
    await get().refreshRepositories();
    await outboxProcessor.process();
    await get().refreshIssues();
    return true;
  };

  return {
    initialized: false,
    loading: true,
    user: null,
    auth: { phase: 'idle' },
    api: null,
    repositories: [],
    notes: [],
    issues: [],
    pendingIssues: [],
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
    sessionGeneration: 0,
    legacyClaim: emptyLegacyClaim(),

    initialize: async () => {
      attachConnectivityListeners();

      // Проверяем OAuth callback в URL (после редиректа с GitHub)
      const callbackHandled = await get().handleOAuthCallback(new URL(window.location.href));
      if (callbackHandled) {
        window.history.replaceState({}, '', cleanOAuthCallbackUrl(new URL(window.location.href)));
      }

      const existingUser = get().user;
      const cached = existingUser
        ? await loadGitHubAccountState(String(existingUser.id))
        : await loadLocalDeviceState();
      set({ ...cached, loading: false, initialized: true });

      const storedSession = session.get();
      if (storedSession) {
        const gen = get().sessionGeneration;
        try {
          const credentials = await refreshStoredSession(gen);
          const callbackSucceeded = get().auth.phase === 'success';
          await restoreAuthenticatedSession(
            credentials.accessToken,
            gen,
            callbackSucceeded ? { phase: 'success' } : undefined,
          );
          if (callbackSucceeded) setTimeout(() => set({ auth: { phase: 'idle' } }), 1500);
        } catch (error) {
          if (get().sessionGeneration !== gen) return;
          session.clear();
          const localCached = await loadLocalDeviceState();
          set({
            api: null,
            user: null,
            error:
              get().auth.phase === 'success'
                ? 'Токен получен, но восстановить сессию GitHub не удалось.'
                : 'Сессия GitHub недействительна. Локальные данные доступны.',
            auth:
              get().auth.phase === 'success'
                ? {
                    phase: 'error',
                    message:
                      error instanceof Error ? error.message : 'Не удалось восстановить сессию.',
                  }
                : get().auth,
            ...localCached,
          });
        }
      }
    },

    login: async () => {
      if (!APP_CONFIG.oauth.legacyDeviceFlowEnabled) {
        set({
          auth: {
            phase: 'error',
            message:
              'Legacy Device Flow отключён. Для production-входа настройте VITE_OAUTH_PROXY_URL.',
          },
        });
        return;
      }
      if (deviceFlow.running) return;
      set({ error: null });
      const token = await deviceFlow.start((auth) => set({ auth }));
      if (!token) return;
      const gen = get().sessionGeneration + 1;
      set({ sessionGeneration: gen });
      try {
        await restoreAuthenticatedSession(token, gen, { phase: 'idle' });
      } catch {
        if (get().sessionGeneration !== gen) return;
        session.clear();
        const localCached = await loadLocalDeviceState();
        set({
          api: null,
          user: null,
          auth: { phase: 'error', message: 'GitHub не подтвердил авторизацию' },
          ...localCached,
        });
      }
    },

    loginWithPkce: async () => {
      const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID;
      if (!clientId) {
        set({ auth: { phase: 'error', message: 'Не задан VITE_GITHUB_CLIENT_ID' } });
        return;
      }
      if (!APP_CONFIG.oauth.proxyUrl) {
        set({
          auth: {
            phase: 'error',
            message:
              'OAuth proxy не настроен: задайте VITE_OAUTH_PROXY_URL. Production OAuth без Worker недоступен.',
          },
        });
        return;
      }
      set({ auth: { phase: 'requesting' }, error: null });
      try {
        const pkce = await generatePkce();
        savePkceState(pkce);
        const url = await buildAuthUrl(clientId, pkce);
        set({ auth: { phase: 'redirecting' } });
        window.location.href = url;
      } catch (error) {
        set({
          auth: {
            phase: 'error',
            message: error instanceof Error ? error.message : 'Ошибка инициализации OAuth',
          },
        });
      }
    },

    handleOAuthCallback: async (url: URL): Promise<boolean> => {
      const params = parseCallback(url);
      if (!params) return false;

      if (params.kind === 'error') {
        consumePkceState();
        const description = params.errorDescription || params.error;
        set({
          auth: {
            phase: 'error',
            message:
              params.error === 'access_denied'
                ? `Вы отменили вход через GitHub. ${description === params.error ? '' : description}`.trim()
                : `GitHub отклонил авторизацию: ${description}`,
          },
        });
        return true;
      }

      const pkce = consumePkceState();
      if (!pkce) {
        set({
          auth: { phase: 'error', message: 'OAuth state не найден в сессии. Попробуйте снова.' },
        });
        return true;
      }

      if (params.state !== pkce.oauthState) {
        set({
          auth: { phase: 'error', message: 'OAuth state не совпадает. Возможна CSRF-атака.' },
        });
        return true;
      }

      set({ auth: { phase: 'callback', code: params.code } });
      const gen = get().sessionGeneration + 1;
      set({ sessionGeneration: gen });

      try {
        const credentials = await exchangeCode(params.code, pkce.codeVerifier);
        if (get().sessionGeneration !== gen) return true;
        session.set(credentials);
        // Единственная ответственность callback: безопасно обменять и сохранить token.
        // initialize() ниже выполнит ровно одно восстановление пользователя и синхронизацию.
        set({ auth: { phase: 'success' }, error: null });
      } catch (error) {
        if (get().sessionGeneration !== gen) return true;
        session.clear();
        const localCached = await loadLocalDeviceState();
        set({
          api: null,
          user: null,
          auth: {
            phase: 'error',
            message: error instanceof Error ? error.message : 'Ошибка OAuth авторизации',
          },
          ...localCached,
        });
      }

      return true;
    },

    logout: () => {
      deviceFlow.cancel();
      outboxProcessor.destroy();
      clearTokenRefreshTimer();
      const credentials = session.clear();
      if (credentials) void revokeRefreshSession(credentials).catch(() => undefined);
      const gen = get().sessionGeneration + 1;
      const localDefaultTab = defaultTab(null);
      void persistTabs([localDefaultTab], null);
      set({
        api: null,
        user: null,
        auth: { phase: 'idle' },
        selectedTask: null,
        issues: [],
        pendingIssues: [],
        repositories: [],
        notes: get().notes.filter((n) => n.accountId === null),
        tabs: [localDefaultTab],
        outbox: [],
        sessionGeneration: gen,
        legacyClaim: emptyLegacyClaim(),
      });
    },

    refreshRepositories: async () => {
      const api = get().api;
      const user = get().user;
      if (!api || !user || !navigator.onLine) return;
      const accountId = assertAccountId(String(user.id));
      const gen = get().sessionGeneration;
      try {
        const currentMap = new Map(get().repositories.map((repo) => [repo.fullName, repo]));
        const result = await api.getRepositories();
        const repositories: Repository[] = result.repositories.map((repo) => ({
          ...repo,
          pinned: currentMap.get(repo.fullName)?.pinned || false,
          accountId,
        }));
        if (get().sessionGeneration !== gen) return;
        let nextRepositories: Repository[];
        await db.transaction('rw', db.repositoriesCache, async () => {
          await db.repositoriesCache.bulkPut(repositories);
          if (result.failedInstallations.length === 0) {
            const freshNames = new Set(repositories.map((repository) => repository.fullName));
            const cached = await db.repositoriesCache
              .where('accountId')
              .equals(accountId)
              .toArray();
            await db.repositoriesCache.bulkDelete(
              cached
                .filter((repository) => !freshNames.has(repository.fullName))
                .map((repository) => [accountId, repository.fullName] as [string, string]),
            );
            nextRepositories = repositories;
          } else {
            const merged = new Map(
              get().repositories.map((repository) => [repository.fullName, repository]),
            );
            for (const repository of repositories) merged.set(repository.fullName, repository);
            nextRepositories = [...merged.values()];
          }
        });
        if (get().sessionGeneration !== gen) return;
        const partialMessage =
          result.failedInstallations.length > 0
            ? `Не удалось загрузить ${result.failedInstallations.length} из ${result.installationCount} установок GitHub App. Их кеш сохранён.`
            : null;
        set({
          repositories: nextRepositories!,
          error: partialMessage,
          stale: Boolean(partialMessage),
        });
      } catch (error: unknown) {
        if (get().sessionGeneration !== gen) return;
        const parsed = parseGitHubError(error);
        if (parsed.kind === 'unauthorized') {
          if (!activeAuthRetries.has('repositories')) {
            activeAuthRetries.add('repositories');
            try {
              await refreshStoredSession(gen, true);
              if (get().sessionGeneration === gen) await get().refreshRepositories();
              return;
            } catch (refreshError) {
              set({
                error:
                  refreshError instanceof Error
                    ? refreshError.message
                    : 'Не удалось обновить GitHub App token.',
              });
            } finally {
              activeAuthRetries.delete('repositories');
            }
          }
          get().logout();
          return;
        }
        set({
          error:
            parsed.kind === 'permission-denied'
              ? 'Нет доступа к установкам GitHub App.'
              : 'Не удалось загрузить репозитории.',
          stale: true,
        });
      }
    },

    refreshIssues: async (repositoryFullName) => {
      const api = get().api;
      const user = get().user;
      if (!api || !user || !navigator.onLine) return;
      const accountId = assertAccountId(String(user.id));
      const gen = get().sessionGeneration;

      const repositories = repositoryFullName
        ? get().repositories.filter((repo) => repo.fullName === repositoryFullName)
        : get().repositories.filter((repo) => repo.pinned);

      /** Ошибки по отдельным репозиториям. */
      const repoErrors: string[] = [];
      let globalRateLimitUntil: string | null = null;

      for (const repository of repositories) {
        // Проверяем сессию перед каждым репозиторием
        if (get().sessionGeneration !== gen) return;

        const refreshToken = beginRepositoryRefresh(accountId, repository.fullName);
        try {
          const [networkIssues, labels] = await Promise.all([
            api.getIssues(repository.fullName),
            api.getLabels(repository.fullName),
          ]);

          if (get().sessionGeneration !== gen) return;

          const networkIssuesWithAccount = networkIssues.map((i) => ({ ...i, accountId }));

          await db.transaction(
            'rw',
            db.githubIssuesCache,
            db.repositoryLabelsCache,
            db.outbox,
            async () => {
              const pendingOutbox = await db.outbox
                .where('accountId')
                .equals(accountId)
                .and(
                  (op) =>
                    op.repositoryFullName === repository.fullName && PENDING_STATES.has(op.state),
                )
                .toArray();

              const pendingOutboxKeys = new Set(pendingOutbox.map((op) => op.entityKey));

              const localIssuesInRepo = await db.githubIssuesCache
                .where('accountId')
                .equals(accountId)
                .and((i) => i.repositoryFullName === repository.fullName)
                .toArray();

              const localPendingIssues = localIssuesInRepo.filter((i) =>
                PENDING_STATES.has(i.syncState),
              );
              const localIssueMap = new Map(localIssuesInRepo.map((i) => [issueKey(i), i]));
              const networkKeys = new Set(networkIssuesWithAccount.map((i) => issueKey(i)));
              const latestRequest = isLatestRepositoryRefresh(refreshToken);

              // Удаляем только записи, которых нет в актуальном снимке и которые не
              // менялись локально после старта GET. Старый параллельный GET не удаляет данные.
              for (const item of localIssuesInRepo) {
                const key = issueKey(item);
                const protectedByMutation = wasMutatedAfter(refreshToken, key);
                if (
                  latestRequest &&
                  !networkKeys.has(key) &&
                  !PENDING_STATES.has(item.syncState) &&
                  !protectedByMutation
                ) {
                  await db.githubIssuesCache.delete([
                    accountId,
                    repository.fullName,
                    item.issueNumber,
                  ]);
                }
              }

              // Записать сетевые гибридно с учётом оптимистичных локальных оверлеев
              for (const netIssue of networkIssuesWithAccount) {
                const key = issueKey(netIssue);
                const local = localIssueMap.get(key);
                const activeOp = pendingOutbox.find(
                  (op) => op.entityKey === key && op.type === 'update_issue',
                );
                const changedAfterRequest = wasMutatedAfter(refreshToken, key);

                if (local && changedAfterRequest) {
                  // Сохраняем подтверждённую или optimistic локальную мутацию целиком.
                  await db.githubIssuesCache.put(local);
                } else if (local && activeOp) {
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
                    accountId,
                  });
                } else if (latestRequest || !local) {
                  await db.githubIssuesCache.put({ ...netIssue, accountId });
                }
              }

              // Восстановить pending записи с outbox
              for (const localIssue of localPendingIssues) {
                const key = issueKey(localIssue);
                const hasOutboxEntry = localIssue.clientLocalId
                  ? pendingOutboxKeys.has(localIssue.clientLocalId)
                  : pendingOutboxKeys.has(key);

                if (hasOutboxEntry) {
                  await db.githubIssuesCache.put({ ...localIssue, accountId });
                }
              }

              if (latestRequest) {
                await db.repositoryLabelsCache.put({
                  repositoryFullName: repository.fullName,
                  labels,
                  cachedAt: new Date().toISOString(),
                  accountId,
                });
              }
            },
          );
        } catch (error: unknown) {
          if (get().sessionGeneration !== gen) return;
          const parsed = parseGitHubError(error);

          if (parsed.kind === 'unauthorized') {
            if (!activeAuthRetries.has('issues')) {
              activeAuthRetries.add('issues');
              try {
                await refreshStoredSession(gen, true);
                if (get().sessionGeneration === gen) {
                  await get().refreshIssues(repositoryFullName);
                }
                return;
              } catch (refreshError) {
                set({
                  error:
                    refreshError instanceof Error
                      ? refreshError.message
                      : 'Не удалось обновить GitHub App token.',
                });
              } finally {
                activeAuthRetries.delete('issues');
              }
            }
            get().logout();
            set({ error: 'Сессия GitHub истекла. Войдите снова; данные сохранены.' });
            return;
          }

          if (parsed.kind === 'rate-limit') {
            globalRateLimitUntil = parsed.retryAt || new Date(Date.now() + 60_000).toISOString();
            set({ rateLimitUntil: globalRateLimitUntil });
            break;
          }

          // Локальная ошибка репозитория: логируем и продолжаем
          const msg =
            parsed.kind === 'permission-denied'
              ? `${repository.fullName}: нет доступа (403)`
              : parsed.kind === 'not-found'
                ? `${repository.fullName}: репозиторий не найден (404)`
                : `${repository.fullName}: ошибка обновления`;
          repoErrors.push(msg);
        }
      }

      if (get().sessionGeneration !== gen) return;
      const cached = await loadGitHubAccountState(accountId);
      if (get().sessionGeneration !== gen) return;

      const errorMsg = globalRateLimitUntil
        ? `Достигнут глобальный лимит GitHub API. Следующая попытка после ${new Date(globalRateLimitUntil).toLocaleTimeString()}.`
        : repoErrors.length > 0
          ? `Ошибки при обновлении: ${repoErrors.join('; ')}`
          : null;

      set({
        issues: cached.issues,
        pendingIssues: cached.pendingIssues,
        stale: repoErrors.length > 0 || Boolean(globalRateLimitUntil),
        error: errorMsg,
      });
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
      const user = get().user;
      const accountId = user ? String(user.id) : null;
      if (!shouldPublishAsIssue(input.repositoryFullName, input.status)) {
        const note = createLocalNote({
          title: input.title,
          description: input.description,
          status: input.status,
          repositoryFullName: input.repositoryFullName,
          localTags: input.tags,
          checklist: input.checklist,
        });
        note.accountId = input.repositoryFullName ? accountId || 'legacy-unassigned' : null;
        await db.localNotes.add(note);
        set({ notes: [note, ...get().notes], createDialog: { open: false } });
        return;
      }

      const activeAccountId = assertAccountId(accountId);
      const repositoryFullName = input.repositoryFullName as string;
      if (!ensureRepositoryWritable(repositoryFullName)) return;
      const clientLocalId = crypto.randomUUID();
      const userLabels = input.tags.filter((t) => !t.startsWith('kf:') && !t.startsWith('km:'));
      const labels = labelsForMove(
        userLabels,
        input.status as Exclude<TaskStatus, 'question'>,
        input.priority,
      );
      const now = new Date().toISOString();

      // Временная карточка теперь в pendingIssues — не в githubIssuesCache
      const pending: PendingIssue = {
        clientLocalId,
        repositoryFullName,
        accountId: activeAccountId,
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
        createdAt: now,
        updatedAt: now,
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
        accountId: activeAccountId,
      };

      await db.transaction('rw', db.pendingIssues, db.outbox, async () => {
        await db.pendingIssues.put(pending);
        await db.outbox.add(outboxOp);
      });

      const cached = await loadGitHubAccountState(activeAccountId);
      set({ ...cached, createDialog: { open: false } });
      await outboxProcessor.process();
    },

    updateNote: async (id, changes) => {
      const note = get().notes.find((item) => item.id === id);
      if (!note) return;
      const user = get().user;
      const activeAccountId = user ? String(user.id) : null;
      const updated: LocalNote = { ...note, ...changes, id, updatedAt: new Date().toISOString() };

      if (updated.repositoryFullName && updated.status === 'question') {
        updated.accountId = activeAccountId || 'legacy-unassigned';
        await db.localNotes.put(updated);
        const cached = activeAccountId
          ? await loadGitHubAccountState(activeAccountId)
          : await loadLocalDeviceState();
        set({ notes: cached.notes });
        return;
      }

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
      const cached = activeAccountId
        ? await loadGitHubAccountState(activeAccountId)
        : await loadLocalDeviceState();
      set({ notes: cached.notes });
    },

    deleteNote: async (id) => {
      await db.localNotes.delete(id);
      set({ notes: get().notes.filter((note) => note.id !== id), selectedTask: null });
    },

    updateIssuePlacement: async (key, changes) => {
      const issue = get().issues.find((i) => issueKey(i) === key || i.clientLocalId === key);
      if (!issue || issue.issueNumber < 0) return;
      if (!ensureRepositoryWritable(issue.repositoryFullName)) return;

      const user = get().user;
      if (!user) return;
      const accountId = assertAccountId(String(user.id));

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
        accountId,
      };

      await db.transaction('rw', db.githubIssuesCache, db.outbox, async () => {
        await db.githubIssuesCache.put(optimistic);
        const existingOp = await db.outbox
          .where('entityKey')
          .equals(key)
          .and(
            (op) =>
              op.type === 'update_issue' && op.state !== 'syncing' && op.accountId === accountId,
          )
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
      markRepositoryMutation(accountId, issue.repositoryFullName, key);

      const cached = await loadGitHubAccountState(accountId);
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
      if (!ensureRepositoryWritable(issue.repositoryFullName)) return;
      const user = get().user;
      if (!user) return;
      const accountId = assertAccountId(String(user.id));
      const key = issueKey(issue);

      const optimistic: GitHubIssue = {
        ...issue,
        title: changes.title ?? issue.title,
        body: changes.body ?? issue.body,
        labels: changes.labels
          ? changes.labels.map((name) => {
              const existing = issue.labels.find((l) => l.name === name);
              return existing ?? { name, color: '8c959f' };
            })
          : issue.labels,
        assignees: changes.assignees ?? issue.assignees,
        updatedAt: new Date().toISOString(),
        syncState: 'pending' as const,
        accountId,
      };

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
      markRepositoryMutation(accountId, issue.repositoryFullName, key);

      const cached = await loadGitHubAccountState(accountId);
      set(cached);
      await outboxProcessor.process();
    },

    moveIssueToQuestion: async (issue) => {
      if (issue.issueNumber < 0) return;
      if (!ensureRepositoryWritable(issue.repositoryFullName)) return;
      const user = get().user;
      if (!user) return;
      const accountId = assertAccountId(String(user.id));
      const key = issueKey(issue);
      const { checklist, description } = extractChecklistFromMarkdown(issue.body);
      const userLabels = stripSystemLabels(issue.labels);

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

      const cached = await loadGitHubAccountState(accountId);
      set(cached);
      await outboxProcessor.process();
    },

    requestConversion: (noteId, context) => {
      if (context?.repositoryFullName && !ensureRepositoryWritable(context.repositoryFullName)) {
        return;
      }
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
      const user = get().user;
      if (!user) return;
      if (!ensureRepositoryWritable(draft.repositoryFullName)) return;
      const accountId = assertAccountId(String(user.id));

      const cachedLabels = await db.repositoryLabelsCache.get([
        accountId,
        draft.repositoryFullName,
      ]);
      const repoLabelNames = cachedLabels?.labels.map((label) => label.name) || [];
      const matchedTags = note.localTags.filter((tag) => repoLabelNames.includes(tag));
      let labels = [...new Set([...draft.labels, ...matchedTags])];
      labels = labelsForMove(labels, draft.status, draft.priority);

      const updatedNote: LocalNote = {
        ...note,
        syncState: 'pending',
        pendingConversionData: draft,
        repositoryFullName: draft.repositoryFullName,
        updatedAt: new Date().toISOString(),
        accountId,
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

      await db.transaction('rw', db.localNotes, db.outbox, async () => {
        await db.localNotes.put(updatedNote);
        await db.outbox.add(outboxOp);
      });

      const cached = await loadGitHubAccountState(accountId);
      set({ ...cached, conversionDialog: { noteId: null } });
      await outboxProcessor.process();
    },

    openEntity: async (entity, options) => {
      const user = get().user;
      const accountId = user ? String(user.id) : null;
      let currentTabs = ensureDefaultTab(get().tabs, accountId);
      if (currentTabs !== get().tabs || get().tabs.length === 0) {
        currentTabs = await persistTabs(currentTabs, accountId);
        set({ tabs: currentTabs });
      }
      const existing = !options?.duplicate
        ? currentTabs.find((tab) => tabEntitySignature(tab.entity) === tabEntitySignature(entity))
        : undefined;
      if (existing) return get().selectTab(existing.id);

      if (!options?.newTab) {
        const tabs = currentTabs.map((tab) =>
          tab.active ? { ...tab, entity, title: titleForTabEntity(entity) } : tab,
        );
        const persisted = await persistTabs(tabs, accountId);
        set({ tabs: persisted, selectedTask: null });
        return;
      }
      const tabs = currentTabs.map((tab) => ({ ...tab, active: false }));
      const tab: WorkspaceTab = {
        id: crypto.randomUUID(),
        entity,
        title: titleForTabEntity(entity),
        position: tabs.length,
        active: true,
        accountId,
      };
      const next = [...tabs, tab];
      const persisted = await persistTabs(next, accountId);
      set({ tabs: persisted, selectedTask: null });
    },

    closeTab: async (id) => {
      const current = get().tabs;
      const user = get().user;
      const accountId = user ? String(user.id) : null;
      if (current.length === 1) {
        const reset: WorkspaceTab[] = [
          {
            ...current[0]!,
            entity: { kind: 'all' } as const,
            title: 'Все задачи',
            active: true,
            accountId,
          },
        ];
        const persisted = await persistTabs(reset, accountId);
        set({ tabs: persisted });
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
      const persisted = await persistTabs(next, accountId);
      set({ tabs: persisted });
    },

    selectTab: async (id) => {
      const user = get().user;
      const accountId = user ? String(user.id) : null;
      const tabs = get().tabs.map((tab) => ({ ...tab, active: tab.id === id }));
      const persisted = await persistTabs(tabs, accountId);
      set({ tabs: persisted, selectedTask: null });
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
    retryOperation: async (id) => {
      try {
        await outboxProcessor.retry(id);
      } catch (error) {
        set({ error: error instanceof Error ? error.message : 'Не удалось повторить операцию.' });
      }
    },
    retryAmbiguousOperation: async (id) => {
      await outboxProcessor.retry(id, true);
    },
    updatePendingOperation: async (clientLocalId, changes) => {
      const pending = await db.pendingIssues.get(clientLocalId);
      const operation = await db.outbox
        .where('accountId')
        .equals(pending?.accountId || '')
        .and(
          (item) =>
            item.entityKey === clientLocalId ||
            Boolean(
              pending?.migrationGroupId && item.migrationGroupId === pending.migrationGroupId,
            ),
        )
        .first();
      if (!pending || !operation) return;
      if (pending.migrationGroupId) {
        set({
          error:
            'Эта карточка связана с несколькими legacy-операциями. Проверьте GitHub, отмените группу и создайте Issue заново.',
        });
        return;
      }
      if (operation.state === 'syncing') {
        set({ error: 'Нельзя изменить операцию во время отправки.' });
        return;
      }
      const repositoryFullName = changes.repositoryFullName || pending.repositoryFullName;
      const repository = get().repositories.find((item) => item.fullName === repositoryFullName);
      if (repository && !repository.permissions.push) {
        set({ error: `Репозиторий ${repositoryFullName} доступен только для чтения.` });
        return;
      }
      const derivedStatus = changes.status ?? pending.derivedStatus;
      const derivedPriority = changes.priority ?? pending.derivedPriority;
      const userLabels = changes.labels ?? visibleLabels(pending.labels).map((label) => label.name);
      const finalLabels = labelsForMove(userLabels, derivedStatus, derivedPriority);
      const updatedPending: PendingIssue = {
        ...pending,
        repositoryFullName,
        title: changes.title?.trim() || pending.title,
        body: changes.body ?? pending.body,
        state: derivedStatus === 'done' ? 'closed' : 'open',
        derivedStatus,
        derivedPriority,
        labels: finalLabels.map((name) => {
          const existing = pending.labels.find((label) => label.name === name);
          return existing || { name, color: '8c959f' };
        }),
        assignees: changes.assignees ?? pending.assignees,
        updatedAt: new Date().toISOString(),
        needsAttention: false,
        migrationDiagnostic: undefined,
      };
      const updatedOperation: OutboxOperation = {
        ...operation,
        repositoryFullName,
        payload: {
          ...operation.payload,
          title: updatedPending.title,
          body: updatedPending.body,
          labels: finalLabels,
          assignees: updatedPending.assignees,
          state: updatedPending.state,
          clientLocalId,
        },
        state: operation.ambiguityRisk ? 'attention' : 'pending',
        requestStarted: false,
        attemptCount: 0,
        nextAttemptAt: undefined,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      };
      let normalizedTabs: WorkspaceTab[] = [];
      await db.transaction('rw', db.pendingIssues, db.outbox, db.tabs, async () => {
        await db.pendingIssues.put(updatedPending);
        await db.outbox.put(updatedOperation);
        const accountTabs = await db.tabs.where('accountId').equals(pending.accountId).toArray();
        normalizedTabs = ensureDefaultTab(
          accountTabs.map((tab) =>
            tab.entity.kind === 'pending-issue' && tab.entity.clientLocalId === clientLocalId
              ? {
                  ...tab,
                  entity: {
                    ...tab.entity,
                    repositoryFullName,
                  },
                  title: updatedPending.title,
                }
              : tab,
          ),
          pending.accountId,
        );
        await db.tabs.where('accountId').equals(pending.accountId).delete();
        await db.tabs.bulkPut(normalizedTabs);
      });
      const cached = await loadGitHubAccountState(pending.accountId);
      set({ ...cached, tabs: normalizedTabs, error: null });
      if (!updatedOperation.ambiguityRisk) await outboxProcessor.process();
    },
    cancelPendingOperation: async (clientLocalId) => {
      const pending = await db.pendingIssues.get(clientLocalId);
      if (!pending) return;
      let normalizedTabs: WorkspaceTab[] = [];
      await db.transaction('rw', db.pendingIssues, db.outbox, db.tabs, async () => {
        const operations = await db.outbox
          .where('accountId')
          .equals(pending.accountId)
          .and(
            (operation) =>
              operation.entityKey === clientLocalId ||
              Boolean(
                pending.migrationGroupId && operation.migrationGroupId === pending.migrationGroupId,
              ),
          )
          .toArray();
        await db.outbox.bulkDelete(operations.map((operation) => operation.id));
        await db.pendingIssues.delete(clientLocalId);
        const accountTabs = await db.tabs.where('accountId').equals(pending.accountId).toArray();
        normalizedTabs = ensureDefaultTab(
          accountTabs.filter(
            (tab) =>
              tab.entity.kind !== 'pending-issue' || tab.entity.clientLocalId !== clientLocalId,
          ),
          pending.accountId,
        );
        await db.tabs.where('accountId').equals(pending.accountId).delete();
        await db.tabs.bulkPut(normalizedTabs);
      });
      const cached = await loadGitHubAccountState(pending.accountId);
      const selectedTask = get().selectedTask;
      set({
        ...cached,
        tabs: normalizedTabs,
        selectedTask:
          selectedTask?.kind === 'pending-issue' && selectedTask.clientLocalId === clientLocalId
            ? null
            : selectedTask,
      });
    },

    getRepositoryLabels: async (repositoryFullName) => {
      const api = get().api;
      const user = get().user;
      const accountId = user ? String(user.id) : null;
      if (navigator.onLine && api && accountId) {
        try {
          const freshLabels = await api.getLabels(repositoryFullName);
          await db.repositoryLabelsCache.put({
            repositoryFullName,
            labels: freshLabels,
            cachedAt: new Date().toISOString(),
            accountId,
          });
          return visibleLabels(freshLabels);
        } catch {
          // fall through to cache
        }
      }
      if (accountId) {
        const cached = await db.repositoryLabelsCache.get([accountId, repositoryFullName]);
        if (cached) return visibleLabels(cached.labels);
      }
      return [];
    },

    getRepositoryAssignees: async (repositoryFullName) => {
      const api = get().api;
      const user = get().user;
      const accountId = user ? String(user.id) : null;
      if (navigator.onLine && api && accountId) {
        try {
          const assignees = await api.getAssignees(repositoryFullName);
          await db.repositoryAssigneesCache.put({
            repositoryFullName,
            assignees,
            cachedAt: new Date().toISOString(),
            accountId,
          });
          return assignees;
        } catch {
          // fall through to cache
        }
      }
      if (accountId) {
        const cached = await db.repositoryAssigneesCache.get([accountId, repositoryFullName]);
        if (cached) return cached.assignees;
      }
      return [];
    },

    claimLegacyData: async () => {
      const user = get().user;
      if (!user) return;
      const accountId = assertAccountId(String(user.id));
      try {
        await db.transaction('rw', db.tables, async () => {
          const pendingIdMap = new Map<string, string>();
          const noteIdMap = new Map<string, string>();

          const legacyRepos = await db.repositoriesCache
            .where('accountId')
            .equals('legacy-unassigned')
            .toArray();
          for (const legacy of legacyRepos) {
            const current = await db.repositoriesCache.get([accountId, legacy.fullName]);
            await db.repositoriesCache.delete(['legacy-unassigned', legacy.fullName]);
            await db.repositoriesCache.put({
              ...(current || legacy),
              pinned: Boolean(current?.pinned || legacy.pinned),
              updatedAt:
                current && current.updatedAt > legacy.updatedAt
                  ? current.updatedAt
                  : legacy.updatedAt,
              accountId,
            });
          }

          const legacyIssues = await db.githubIssuesCache
            .where('accountId')
            .equals('legacy-unassigned')
            .toArray();
          for (const legacy of legacyIssues) {
            const key: [string, string, number] = [
              accountId,
              legacy.repositoryFullName,
              legacy.issueNumber,
            ];
            const current = await db.githubIssuesCache.get(key);
            const preferLegacy =
              !current ||
              PENDING_STATES.has(legacy.syncState) ||
              legacy.updatedAt > current.updatedAt;
            await db.githubIssuesCache.delete([
              'legacy-unassigned',
              legacy.repositoryFullName,
              legacy.issueNumber,
            ]);
            if (preferLegacy) await db.githubIssuesCache.put({ ...legacy, accountId });
          }

          const legacyPending = await db.pendingIssues
            .where('accountId')
            .equals('legacy-unassigned')
            .toArray();
          for (const legacy of legacyPending) {
            const collision = await db.pendingIssues.get(legacy.clientLocalId);
            const nextId =
              collision && collision.accountId !== 'legacy-unassigned'
                ? crypto.randomUUID()
                : legacy.clientLocalId;
            pendingIdMap.set(legacy.clientLocalId, nextId);
            await db.pendingIssues.delete(legacy.clientLocalId);
            await db.pendingIssues.put({ ...legacy, clientLocalId: nextId, accountId });
          }

          const legacyNotes = await db.localNotes
            .filter((note) => note.accountId === 'legacy-unassigned')
            .toArray();
          for (const legacy of legacyNotes) {
            const collision = await db.localNotes.get(legacy.id);
            const nextId =
              collision && collision.accountId !== 'legacy-unassigned'
                ? crypto.randomUUID()
                : legacy.id;
            noteIdMap.set(legacy.id, nextId);
            if (nextId !== legacy.id) await db.localNotes.delete(legacy.id);
            await db.localNotes.put({ ...legacy, id: nextId, accountId });
          }

          const legacyLabels = await db.repositoryLabelsCache
            .where('accountId')
            .equals('legacy-unassigned')
            .toArray();
          for (const legacy of legacyLabels) {
            const current = await db.repositoryLabelsCache.get([
              accountId,
              legacy.repositoryFullName,
            ]);
            await db.repositoryLabelsCache.delete(['legacy-unassigned', legacy.repositoryFullName]);
            if (!current || legacy.cachedAt > current.cachedAt) {
              await db.repositoryLabelsCache.put({ ...legacy, accountId });
            }
          }
          const legacyAssignees = await db.repositoryAssigneesCache
            .where('accountId')
            .equals('legacy-unassigned')
            .toArray();
          for (const legacy of legacyAssignees) {
            const current = await db.repositoryAssigneesCache.get([
              accountId,
              legacy.repositoryFullName,
            ]);
            await db.repositoryAssigneesCache.delete([
              'legacy-unassigned',
              legacy.repositoryFullName,
            ]);
            if (!current || legacy.cachedAt > current.cachedAt) {
              await db.repositoryAssigneesCache.put({ ...legacy, accountId });
            }
          }

          const legacyOperations = await db.outbox
            .where('accountId')
            .equals('legacy-unassigned')
            .toArray();
          for (const operation of legacyOperations) {
            const idCollision = await db.outbox.get(operation.id);
            const mappedEntityKey =
              pendingIdMap.get(operation.entityKey) ||
              noteIdMap.get(operation.entityKey) ||
              operation.entityKey;
            const sourceNoteId = operation.sourceNoteId
              ? noteIdMap.get(operation.sourceNoteId) || operation.sourceNoteId
              : undefined;
            await db.outbox.delete(operation.id);
            await db.outbox.put({
              ...operation,
              id:
                idCollision && idCollision.accountId !== 'legacy-unassigned'
                  ? crypto.randomUUID()
                  : operation.id,
              entityKey: mappedEntityKey,
              sourceNoteId,
              payload: {
                ...operation.payload,
                ...(pendingIdMap.has(operation.entityKey)
                  ? { clientLocalId: mappedEntityKey }
                  : {}),
              },
              accountId,
            });
          }

          const currentTabs = await db.tabs.where('accountId').equals(accountId).toArray();
          const legacyTabs = await db.tabs.where('accountId').equals('legacy-unassigned').toArray();
          const existingIds = new Set(currentTabs.map((tab) => tab.id));
          const mappedLegacyTabs = legacyTabs.map((tab) => {
            let entity = tab.entity;
            if (entity.kind === 'pending-issue' && pendingIdMap.has(entity.clientLocalId)) {
              entity = { ...entity, clientLocalId: pendingIdMap.get(entity.clientLocalId)! };
            } else if (entity.kind === 'local-note' && noteIdMap.has(entity.id)) {
              entity = { ...entity, id: noteIdMap.get(entity.id)! };
            }
            const id = existingIds.has(tab.id) ? crypto.randomUUID() : tab.id;
            existingIds.add(id);
            return { ...tab, id, entity, accountId };
          });
          await db.tabs.where('accountId').equals('legacy-unassigned').delete();
          await db.tabs.where('accountId').equals(accountId).delete();
          await db.tabs.bulkPut(ensureDefaultTab([...currentTabs, ...mappedLegacyTabs], accountId));

          await db.syncMetadata
            .where('accountId')
            .equals('legacy-unassigned')
            .modify({ accountId });
        });

        const userCached = await loadGitHubAccountState(accountId);
        set({ ...userCached, legacyClaim: emptyLegacyClaim(), error: null });
        await outboxProcessor.process();
        await get().refreshIssues();
      } catch {
        set({
          error:
            'Не удалось привязать legacy-данные. Транзакция отменена, исходные данные сохранены.',
        });
      }
    },

    dismissLegacyClaim: () => {
      const user = get().user;
      if (user) {
        void db.settings.put({ key: `legacy-claim:${user.id}`, value: 'never' });
      }
      set({ legacyClaim: emptyLegacyClaim() });
    },
  };
});
