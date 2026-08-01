import { Check, Clipboard, ExternalLink, LoaderCircle, X } from 'lucide-react';
import { useAppStore } from '../state/app-store';

export function AuthModal() {
  const auth = useAppStore((state) => state.auth);
  const login = useAppStore((state) => state.login);
  const logout = useAppStore((state) => state.logout);
  if (auth.phase === 'idle') return null;
  return (
    <div className="modal-backdrop">
      <section className="modal auth-modal" aria-live="polite">
        <header>
          <span>Вход через GitHub</span>
          <button aria-label="Закрыть" onClick={logout}>
            <X size={16} />
          </button>
        </header>
        {auth.phase === 'requesting' && (
          <div className="auth-state">
            <LoaderCircle className="spin" />
            <h3>Получаем одноразовый код…</h3>
          </div>
        )}
        {auth.phase === 'waiting' && (
          <div className="auth-state">
            <p>Скопируйте код и подтвердите вход на GitHub. Он действует ограниченное время.</p>
            <div className="device-code">
              <strong>{auth.userCode}</strong>
              <button
                aria-label="Копировать код"
                onClick={() => void navigator.clipboard.writeText(auth.userCode)}
              >
                <Clipboard size={16} />
              </button>
            </div>
            <a
              className="button primary"
              target="_blank"
              rel="noreferrer"
              href={auth.verificationUri}
            >
              Открыть GitHub <ExternalLink size={14} />
            </a>
            <p className="hint">Ожидаем подтверждения. Это окно можно оставить открытым.</p>
          </div>
        )}
        {auth.phase === 'success' && (
          <div className="auth-state">
            <Check />
            <h3>Авторизация завершена</h3>
            <p>Проверяем текущего пользователя…</p>
          </div>
        )}
        {(auth.phase === 'expired' || auth.phase === 'error') && (
          <div className="auth-state error">
            <h3>{auth.phase === 'expired' ? 'Код истёк' : 'Не удалось войти'}</h3>
            <p>{auth.message}</p>
            <button
              className="primary"
              onClick={() => {
                logout();
                void login();
              }}
            >
              Попробовать снова
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
