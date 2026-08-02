# Архитектура

Приложение разделено на четыре слоя.

1. `domain/` содержит типы, инварианты заметок и чистое сопоставление GitHub labels со статусами/приоритетами.
2. `github/` инкапсулирует PKCE, явно включаемый legacy Device Flow, сессию, общий parser ошибок и все вызовы Octokit. React-компоненты Octokit не импортируют.
3. `data/` и `sync/` содержат версионируемую Dexie-схему и последовательный outbox.
4. `state/` координирует optimistic UI, кеш и вкладки; `components/` отвечает только за взаимодействие и представление.

Поток обновления GitHub Issue:

```text
UI → optimistic Zustand/IndexedDB → outbox → GitHub API
                                      ↓ success
                              normalized cache → UI
```

GitHub остаётся источником истины. Кеш нужен для быстрого старта и offline-чтения; при сети закреплённые репозитории обновляются заново.

Production UI размещается статически, но GitHub App OAuth использует Cloudflare Worker для хранения `client_secret`, server-side token exchange и refresh. GitHub refresh token находится в Cloudflare KV; Pages получает короткоживущий access token и непрозрачный session ID. CSP собирается из `VITE_OAUTH_PROXY_URL` и разрешает только его origin.

Поддерживается только GitHub App: `/user/installations` и `/user/installations/{id}/repositories` требуют соответствующей user-access-token модели. OAuth scopes не запрашиваются.

Каждый GET Issues получает request ID и стартовую revision репозитория. Успешные локальные мутации увеличивают revision конкретной Issue; старый ответ может добавить безопасные сетевые записи, но не удаляет и не перезаписывает данные, изменённые после старта.

Assets, manifest, start URL, scope и Service Worker используют `VITE_BASE_PATH`, поэтому production dist работает на project subpath GitHub Pages. Название и системные labels собраны в `src/config.ts`.
