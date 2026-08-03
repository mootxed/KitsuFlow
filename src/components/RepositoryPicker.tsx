import { ExternalLink, FolderGit2, X } from 'lucide-react';
import { APP_CONFIG } from '../config';
import { useAppStore } from '../state/app-store';

export function RepositoryPicker() {
  const open = useAppStore((state) => state.repositoryPickerOpen);
  const setOpen = useAppStore((state) => state.setRepositoryPickerOpen);
  const repositories = useAppStore((state) => state.repositories);
  const user = useAppStore((state) => state.user);
  const login = useAppStore((state) => state.login);
  const toggle = useAppStore((state) => state.toggleRepository);
  const refresh = useAppStore((state) => state.refreshRepositories);
  if (!open) return null;
  return (
    <div className="modal-backdrop">
      <section className="modal repository-picker" aria-label="Выбор репозиториев">
        <header>
          <span>
            <FolderGit2 size={16} /> Доступные репозитории
          </span>
          <button className="btn icon-btn" aria-label="Закрыть" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </header>
        {!user ? (
          <div className="modal-empty">
            <p>Подключите GitHub, чтобы получить репозитории из установок GitHub App.</p>
            <button className="btn btn-primary" onClick={() => void login()}>
              Подключить GitHub
            </button>
          </div>
        ) : repositories.length ? (
          <div className="picker-list">
            {repositories.map((repository) => (
              <label key={repository.fullName}>
                <input
                  type="checkbox"
                  checked={repository.pinned}
                  onChange={() => void toggle(repository.fullName)}
                />
                <span>
                  <strong>{repository.fullName}</strong>
                  <small>
                    {repository.private ? 'Private' : 'Public'} ·{' '}
                    {repository.permissions.push ? 'read/write' : 'read-only'}
                  </small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="modal-empty">
            <h3>GitHub App не установлен</h3>
            <p>Установите приложение хотя бы в один репозиторий, затем обновите список.</p>
            {APP_CONFIG.github.installUrl && (
              <a
                className="btn btn-primary"
                href={APP_CONFIG.github.installUrl}
                target="_blank"
                rel="noreferrer"
              >
                Установить GitHub App <ExternalLink size={14} />
              </a>
            )}
          </div>
        )}
        <footer>
          <button className="btn" onClick={() => void refresh()}>
            Обновить список
          </button>
          <button className="btn btn-primary" onClick={() => setOpen(false)}>
            Готово
          </button>
        </footer>
      </section>
    </div>
  );
}
