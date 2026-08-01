import { useDroppable } from '@dnd-kit/core';
import { CircleDot, FolderGit2, LogIn, LogOut, Plus, RefreshCw, Rows3 } from 'lucide-react';
import { APP_CONFIG } from '../config';
import type { Repository } from '../domain/types';
import { useAppStore } from '../state/app-store';
import { useShallow } from 'zustand/react/shallow';

function RepositoryLink({ repository }: { repository: Repository }) {
  const openEntity = useAppStore((state) => state.openEntity);
  const { setNodeRef, isOver } = useDroppable({
    id: `repository:${repository.fullName}`,
    data: { type: 'repository', repositoryFullName: repository.fullName },
  });
  return (
    <button
      ref={setNodeRef}
      className={`sidebar-link repository-link ${isOver ? 'drop-target' : ''}`}
      onClick={(event) =>
        void openEntity(
          { kind: 'repository', repositoryFullName: repository.fullName },
          { newTab: event.shiftKey, duplicate: event.shiftKey },
        )
      }
      title={`${repository.fullName}. Shift + клик — новая вкладка`}
    >
      <span className="repo-mark">{repository.owner.slice(0, 1).toUpperCase()}</span>
      <span>{repository.name}</span>
    </button>
  );
}

export function Sidebar() {
  const user = useAppStore((state) => state.user);
  const repositories = useAppStore(
    useShallow((state) => state.repositories.filter((repository) => repository.pinned)),
  );
  const openEntity = useAppStore((state) => state.openEntity);
  const setPickerOpen = useAppStore((state) => state.setRepositoryPickerOpen);
  const login = useAppStore((state) => state.login);
  const logout = useAppStore((state) => state.logout);
  const refreshIssues = useAppStore((state) => state.refreshIssues);

  return (
    <aside className="sidebar">
      <div className="brand">
        <CircleDot size={18} /> {APP_CONFIG.name}
      </div>
      <nav aria-label="Основная навигация">
        <button className="sidebar-link" onClick={() => void openEntity({ kind: 'all' })}>
          <Rows3 size={15} /> Все задачи
        </button>
        <div className="sidebar-heading">
          <span>Репозитории</span>
          <button aria-label="Выбрать репозитории" onClick={() => setPickerOpen(true)}>
            <Plus size={14} />
          </button>
        </div>
        <div className="repository-list">
          {repositories.map((repository) => (
            <RepositoryLink key={repository.fullName} repository={repository} />
          ))}
          {!repositories.length && (
            <p className="sidebar-empty">
              <FolderGit2 size={14} /> Репозитории не закреплены
            </p>
          )}
        </div>
      </nav>
      <div className="sidebar-footer">
        {user ? (
          <>
            <button
              className="profile"
              onClick={() => void refreshIssues()}
              title="Обновить Issues"
            >
              <img src={user.avatarUrl} alt="" />
              <span>
                <strong>{user.name || user.login}</strong>
                <small>@{user.login}</small>
              </span>
              <RefreshCw size={14} />
            </button>
            <button className="sidebar-link" onClick={logout}>
              <LogOut size={14} /> Выйти
            </button>
          </>
        ) : (
          <button className="sidebar-link primary-dark" onClick={() => void login()}>
            <LogIn size={15} /> Подключить GitHub
          </button>
        )}
      </div>
    </aside>
  );
}
