import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { APP_CONFIG } from './config';
import { migrateLegacyDb, type MigrationResult } from './data/migrate-legacy-db';
import { MigrationNoticeScreen } from './components/MigrationNoticeScreen';
import './styles.css';

document.title = APP_CONFIG.name;

async function bootstrap() {
  const rootElement = document.getElementById('root');
  if (!rootElement) return;

  const mountApp = () => {
    createRoot(rootElement).render(
      <StrictMode>
        <HashRouter>
          <App />
        </HashRouter>
      </StrictMode>,
    );
  };

  try {
    const result: MigrationResult = await migrateLegacyDb();
    if (result === 'target-not-empty') {
      createRoot(rootElement).render(
        <StrictMode>
          <MigrationNoticeScreen
            reason="target-not-empty"
            onContinue={() => {
              rootElement.innerHTML = '';
              mountApp();
            }}
          />
        </StrictMode>,
      );
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка миграции';
    createRoot(rootElement).render(
      <StrictMode>
        <MigrationNoticeScreen reason="error" errorMessage={message} />
      </StrictMode>,
    );
    return;
  }

  mountApp();
}

void bootstrap();
