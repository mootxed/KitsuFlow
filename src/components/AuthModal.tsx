import { Check, Clipboard, ExternalLink, LoaderCircle, X } from 'lucide-react';
import { useAppStore } from '../state/app-store';
import { APP_CONFIG } from '../config';

export function AuthModal() {
  const auth = useAppStore((state) => state.auth);
  const login = useAppStore((state) => state.login);
  const loginWithPkce = useAppStore((state) => state.loginWithPkce);
  const cancelAuthFlow = useAppStore((state) => state.cancelAuthFlow);
  const dismissAuthModal = useAppStore((state) => state.dismissAuthModal);
  const hasPkceProxy = Boolean(import.meta.env.VITE_OAUTH_PROXY_URL);

  if (auth.phase === 'idle') return null;

  const handleClose = () => {
    if (auth.phase === 'requesting' || auth.phase === 'waiting' || auth.phase === 'redirecting') {
      cancelAuthFlow();
    } else {
      dismissAuthModal();
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="modal auth-modal" aria-live="polite">
        <header>
          <span>Вход через GitHub</span>
          <button className="btn icon-btn" aria-label="Закрыть" onClick={handleClose}>
            <X size={16} />
          </button>
        </header>
        {auth.phase === 'requesting' && (
          <div className="auth-state">
            <LoaderCircle className="spin" />
            <h3>Получаем одноразовый код…</h3>
          </div>
        )}
        {auth.phase === 'redirecting' && (
          <div className="auth-state">
            <LoaderCircle className="spin" />
            <h3>Перенаправление на GitHub…</h3>
            <p>Сейчас откроется страница авторизации GitHub.</p>
          </div>
        )}
        {auth.phase === 'callback' && (
          <div className="auth-state">
            <LoaderCircle className="spin" />
            <h3>Получаем токен доступа…</h3>
          </div>
        )}
        {auth.phase === 'waiting' && (
          <div className="auth-state">
            <p>Скопируйте код и подтвердите вход на GitHub. Он действует ограниченное время.</p>
            <div className="device-code">
              <strong>{auth.userCode}</strong>
              <button
                className="btn icon-btn"
                aria-label="Копировать код"
                onClick={() => void navigator.clipboard.writeText(auth.userCode)}
              >
                <Clipboard size={16} />
              </button>
            </div>
            <a
              className="btn btn-primary"
              target="_blank"
              rel="noreferrer noopener"
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
            {/* Показываем кнопки повтора в зависимости от доступного метода */}
            {hasPkceProxy ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  cancelAuthFlow();
                  void loginWithPkce();
                }}
              >
                Попробовать снова
              </button>
            ) : APP_CONFIG.oauth.legacyDeviceFlowEnabled ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  cancelAuthFlow();
                  void login();
                }}
              >
                Попробовать снова
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => {
                  cancelAuthFlow();
                  void loginWithPkce();
                }}
              >
                Проверить конфигурацию OAuth
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
