import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { APP_CONFIG } from './config';
import { migrateLegacyDb } from './data/migrate-legacy-db';
import './styles.css';

document.title = APP_CONFIG.name;

async function bootstrap() {
  // Одноразовая миграция данных из kitsune-manager в kitsuflow-db.
  // Должна выполниться ДО открытия Dexie (происходит при первом импорте db.ts).
  // При ошибке — показываем понятное сообщение и не запускаем приложение.
  try {
    await migrateLegacyDb();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка';
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = `
        <div style="padding:2rem;font-family:system-ui;max-width:600px;margin:auto">
          <h2 style="color:#d1242f">⚠ Ошибка миграции данных</h2>
          <p>${message}</p>
          <p>Ваши данные в <code>kitsune-manager</code> не изменены.<br>
          Обновите страницу или откройте DevTools → Application → IndexedDB для диагностики.</p>
        </div>`;
    }
    return;
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  );
}

void bootstrap();
