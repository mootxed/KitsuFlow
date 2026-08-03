import { useDroppable } from '@dnd-kit/core';
import { AlertCircle, FolderGit2, LogIn, LogOut, Plus, RefreshCw, Rows3 } from 'lucide-react';
import { APP_CONFIG } from '../config';
import type { Repository } from '../domain/types';
import { useAppStore } from '../state/app-store';
import { useShallow } from 'zustand/react/shallow';

function RepositoryLink({
  repository,
  active,
  count,
  onNavigate,
}: {
  repository: Repository;
  active: boolean;
  count: number;
  onNavigate?: (() => void) | undefined;
}) {
  const openEntity = useAppStore((state) => state.openEntity);
  const { setNodeRef, isOver } = useDroppable({
    id: `repository:${repository.fullName}`,
    data: { type: 'repository', repositoryFullName: repository.fullName },
  });
  return (
    <button
      ref={setNodeRef}
      className={`sidebar-link repository-link repo-item ${active ? 'active' : ''} ${isOver ? 'drop-target' : ''}`}
      onClick={(event) => {
        void openEntity(
          { kind: 'repository', repositoryFullName: repository.fullName },
          { newTab: event.shiftKey, duplicate: event.shiftKey },
        );
        onNavigate?.();
      }}
      title={`${repository.fullName}. Shift + клик — новая вкладка`}
    >
      <span className="repo-avatar">{repository.owner.slice(0, 1).toUpperCase()}</span>
      <span className="repo-name">{repository.name}</span>
      <span className="repo-count">{count}</span>
    </button>
  );
}

/** Баннер для привязки мигрированных legacy-unassigned данных к аккаунту. */
function LegacyClaimBanner() {
  const legacyClaim = useAppStore((state) => state.legacyClaim);
  const claimLegacyData = useAppStore((state) => state.claimLegacyData);
  const dismissLegacyClaim = useAppStore((state) => state.dismissLegacyClaim);

  if (!legacyClaim.hasLegacyData) return null;

  const { counts } = legacyClaim;
  const summary = [
    counts.repositories > 0 && `${counts.repositories} репо`,
    counts.issues > 0 && `${counts.issues} Issues`,
    counts.notes > 0 && `${counts.notes} заметок`,
    counts.outbox > 0 && `${counts.outbox} в очереди`,
    counts.pendingIssues > 0 && `${counts.pendingIssues} pending Issues`,
    counts.labels + counts.assignees > 0 && `${counts.labels + counts.assignees} кешей`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="legacy-claim-banner">
      <AlertCircle size={14} />
      <div>
        <p>
          Обнаружены старые данные без аккаунта: {summary}.
          <br />
          Привязать их к текущему аккаунту?
        </p>
        <div className="legacy-claim-actions">
          <button className="primary small" onClick={() => void claimLegacyData()}>
            Привязать
          </button>
          <button className="small" onClick={dismissLegacyClaim}>
            Не показывать снова
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const user = useAppStore((state) => state.user);
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repository) => repository.pinned)),
  );
  const issues = useAppStore((state) => state.issues);
  const pendingIssues = useAppStore((state) => state.pendingIssues);
  const notes = useAppStore((state) => state.notes);
  const tabs = useAppStore((state) => state.tabs);
  const activeTab = tabs.find((t) => t.active);

  const openEntity = useAppStore((state) => state.openEntity);
  const setPickerOpen = useAppStore((state) => state.setRepositoryPickerOpen);
  const login = useAppStore((state) => state.login);
  const loginWithPkce = useAppStore((state) => state.loginWithPkce);
  const logout = useAppStore((state) => state.logout);
  const refreshIssues = useAppStore((state) => state.refreshIssues);
  const hasPkceProxy = Boolean(import.meta.env.VITE_OAUTH_PROXY_URL);

  const activeAllTasksCount =
    notes.filter((n) => !n.repositoryFullName && n.status !== 'done').length +
    issues.filter(
      (i) =>
        repositories.some((r) => r.fullName === i.repositoryFullName) && i.derivedStatus !== 'done',
    ).length +
    pendingIssues.filter(
      (p) =>
        repositories.some((r) => r.fullName === p.repositoryFullName) && p.derivedStatus !== 'done',
    ).length;

  const isAllActive = activeTab?.entity.kind === 'all';

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Боковая панель">
      <div className="brand">
        <span className="brand-mark">
          <svg
            className="icon icon-18"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="7" />
            <path d="M12 5v4m0 6v4M5 12h4m6 0h4" />
          </svg>
        </span>
        <span className="brand-name">{APP_CONFIG.name}</span>
      </div>
      <nav className="sidebar-nav" aria-label="Основная навигация">
        <button
          className={`nav-item ${isAllActive ? 'active' : ''}`}
          onClick={() => {
            void openEntity({ kind: 'all' });
            onClose?.();
          }}
        >
          <Rows3 size={16} />
          <span>Все задачи</span>
          <span className="nav-count">{activeAllTasksCount}</span>
        </button>
        <div className="nav-section-label">
          <span>Репозитории</span>
          <button
            className="icon-btn"
            title="Выбрать репозитории"
            aria-label="Выбрать репозитории"
            onClick={() => setPickerOpen(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="repository-list">
          {repositories.map((repository) => {
            const isRepoActive =
              activeTab?.entity.kind === 'repository' &&
              activeTab.entity.repositoryFullName === repository.fullName;
            const repoTaskCount =
              issues.filter(
                (i) => i.repositoryFullName === repository.fullName && i.derivedStatus !== 'done',
              ).length +
              pendingIssues.filter(
                (p) => p.repositoryFullName === repository.fullName && p.derivedStatus !== 'done',
              ).length +
              notes.filter(
                (n) => n.repositoryFullName === repository.fullName && n.status === 'question',
              ).length;

            return (
              <RepositoryLink
                key={repository.fullName}
                repository={repository}
                active={isRepoActive}
                count={repoTaskCount}
                onNavigate={onClose}
              />
            );
          })}
          {!repositories.length && (
            <p className="sidebar-empty">
              <FolderGit2 size={14} /> Нет закрепленных репозиториев
            </p>
          )}
        </div>
      </nav>
      <LegacyClaimBanner />
      <div className="account">
        {user ? (
          <>
            <div
              className="profile"
              onClick={() => void refreshIssues()}
              title="Обновить данные"
              tabIndex={0}
              role="button"
            >
              <img src={user.avatarUrl} alt={user.login} />
              <div className="user-info">
                <strong className="user-name">{user.name || user.login}</strong>
                <small className="user-handle">@{user.login}</small>
              </div>
              <span className="sync-dot" title="Активный аккаунт" />
            </div>
            <div className="account-actions">
              <button
                className="btn btn-wide btn-sm sync-button"
                onClick={() => void refreshIssues()}
              >
                <RefreshCw size={13} />
                Синхронизировать
              </button>
              <button
                className="icon-btn logout-button"
                title="Выйти"
                aria-label="Выйти"
                onClick={logout}
              >
                <LogOut size={15} />
              </button>
            </div>
          </>
        ) : (
          <div className="account-actions" style={{ gridTemplateColumns: '1fr' }}>
            <button
              className="btn btn-primary btn-wide btn-sm"
              onClick={() => (hasPkceProxy ? void loginWithPkce() : void loginWithPkce())}
            >
              <LogIn size={14} /> Войти через GitHub
            </button>
            {APP_CONFIG.oauth.legacyDeviceFlowEnabled && !hasPkceProxy && (
              <button className="btn btn-sm btn-wide" onClick={() => void login()}>
                Legacy Device Flow
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
