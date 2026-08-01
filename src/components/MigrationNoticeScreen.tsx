import { useState } from 'react';

export interface MigrationNoticeScreenProps {
  reason: 'target-not-empty' | 'error';
  errorMessage?: string | undefined;
  onContinue?: () => void;
  onRecheck?: () => void;
}

export function MigrationNoticeScreen({
  reason,
  errorMessage,
  onContinue,
  onRecheck,
}: MigrationNoticeScreenProps) {
  const [showGuide, setShowGuide] = useState(false);

  const handleExportDiagnostics = () => {
    const data = {
      timestamp: new Date().toISOString(),
      reason,
      errorMessage: errorMessage || null,
      userAgent: navigator.userAgent,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `kitsuflow-migration-diagnostic-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (reason === 'error') {
    return (
      <div
        style={{
          padding: '2rem',
          fontFamily: 'system-ui, sans-serif',
          maxWidth: '600px',
          margin: 'auto',
        }}
      >
        <h2 style={{ color: '#d1242f' }}>⚠ Ошибка миграции данных</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>
          {errorMessage || 'Произошла непредвиденная ошибка миграции.'}
        </p>
        <p>
          Ваши данные в <code>kitsune-manager</code> не изменены.
          <br />
          Обновите страницу или откройте DevTools → Application → IndexedDB для диагностики.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button onClick={() => window.location.reload()}>Повторить попытку</button>
          <button onClick={handleExportDiagnostics}>Экспортировать диагностику</button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '2rem',
        fontFamily: 'system-ui, sans-serif',
        maxWidth: '650px',
        margin: 'auto',
        lineHeight: '1.5',
      }}
    >
      <h2 style={{ color: '#0969da' }}>Конфликт миграции базы данных</h2>
      <p>
        Новая база <strong>KitsuFlow</strong> уже содержит данные. Старая база{' '}
        <strong>kitsune-manager</strong> также была обнаружена.
      </p>
      <p>
        Автоматическое объединение не выполнено, чтобы не перезаписать или не продублировать
        существующие данные.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '1.5rem 0' }}>
        {onContinue && (
          <button
            style={{
              padding: '0.5rem 1rem',
              background: '#0969da',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
            onClick={onContinue}
          >
            Продолжить с новой базой
          </button>
        )}
        <button
          style={{
            padding: '0.5rem 1rem',
            background: '#24292f',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
          onClick={handleExportDiagnostics}
        >
          Экспорт диагностики
        </button>
        <button
          style={{
            padding: '0.5rem 1rem',
            border: '1px solid #d0d7de',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
          onClick={() => (onRecheck ? onRecheck() : window.location.reload())}
        >
          Повторно проверить состояние
        </button>
        <button
          style={{
            padding: '0.5rem 1rem',
            border: '1px solid #d0d7de',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
          onClick={() => setShowGuide(!showGuide)}
        >
          {showGuide ? 'Скрыть инструкцию' : 'Инструкция по восстановлению'}
        </button>
      </div>

      {showGuide && (
        <div
          style={{
            padding: '1rem',
            background: '#f6f8fa',
            borderRadius: '6px',
            border: '1px solid #d0d7de',
          }}
        >
          <h4>Руководство по восстановлению:</h4>
          <ol style={{ paddingLeft: '1.2rem' }}>
            <li>
              Если вы хотите полностью перенести данные из устаревшей базы, очистите новую IndexedDB
              в браузерных DevTools (Application → Storage → Clear site data) и перезагрузите
              страницу.
            </li>
            <li>
              Если в текущей базе KitsuFlow сохранены новые важные данные, нажмите &quot;Продолжить
              с новой базой&quot;.
            </li>
            <li>
              Вы также можете экспортировать диагностическую информацию для детального разбора.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
