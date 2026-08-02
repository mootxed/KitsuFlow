# KitsuFlow

KitsuFlow — компактный local-first менеджер задач для разработчиков. GitHub Issues остаются источником истины для задач репозиториев, а быстрые личные заметки хранятся только в браузере и при необходимости публикуются как Issues.

Интерфейс и данные приложения размещаются статически на GitHub Pages. Для production OAuth используется минимальный backend-компонент — Cloudflare Worker: только он хранит `client_secret` и обменивает authorization code на token. `client_secret` никогда не попадает в Vite bundle, Actions Variables или браузер.

## Возможности первой версии

- GitHub App Authorization Code + PKCE через ограниченный Cloudflare Worker; локальный legacy Device Flow включается только явно;
- получение установок GitHub App и выбор закреплённых репозиториев;
- загрузка и локальный кеш GitHub Issues без Pull Requests;
- локальные заметки, теги и чек-листы в IndexedDB;
- статусы и приоритеты через системные GitHub labels с префиксом `kf:` (сохранена совместимость со старыми `km:`);
- отдельная несинхронизируемая секция «Под вопросом»;
- публикация заметки в Issue с подтверждением и сохранением исходника до успеха;
- offline outbox, последовательная отправка, backoff, различение 401/rate limit/permission denied/exhausted и неоднозначного создания;
- вкладки, правая панель, быстрое создание по `C` и drag-and-drop с атомарным обновлением статуса и приоритета;
- PWA, кеш оболочки и уведомление о новой версии Service Worker.

GitHub Projects, комментарии, сроки, мобильный UX, синхронизация заметок между устройствами и backend намеренно не входят в первую версию.

## Быстрый запуск

Требуются Node.js 22+ и Corepack.

```bash
corepack enable
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm dev
```

Проверки:

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format
corepack pnpm test
corepack pnpm build
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e
corepack pnpm test:e2e:production
```

## Настройка GitHub App

1. Откройте **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Укажите любое уникальное имя и Homepage URL (`http://localhost:5173` для локальной разработки или адрес Pages).
3. Webhook отключите: эта статическая версия его не использует.
4. Укажите callback URL: `https://<owner>.github.io/<repository>/` (для разработки также разрешите локальный callback в Worker).
5. В **Repository permissions** задайте:
   - **Issues: Read and write**;
   - **Metadata: Read-only** (GitHub включает это базовое разрешение автоматически).
6. Сохраните приложение и скопируйте публичный **Client ID**. Создайте `client_secret`, но храните его только как Cloudflare Worker Secret.
7. На странице приложения нажмите **Install App** и разрешите доступ только к нужным репозиториям.
8. Заполните `.env`:

```dotenv
VITE_GITHUB_CLIENT_ID=Iv1.public_client_id
VITE_GITHUB_APP_SLUG=your-app-slug
VITE_OAUTH_PROXY_URL=https://kitsuflow-oauth.example.workers.dev
# Альтернатива slug — полный URL установки:
# VITE_GITHUB_APP_INSTALL_URL=https://github.com/apps/your-app/installations/new
VITE_BASE_PATH=/
VITE_APP_NAME=KitsuFlow
```

После PKCE callback клиент получает GitHub App user access token через Worker и проверяет его запросом текущего пользователя. Обычные OAuth Apps не поддерживаются: приложение использует `/user/installations` и permissions установленного GitHub App, а не OAuth scopes.

Короткоживущий access token и непрозрачный идентификатор Worker refresh-сессии живут только в `sessionStorage` (ключ `kitsuflow.github.access-token`). GitHub `refresh_token` хранится только в Cloudflare KV и никогда не передаётся JavaScript-клиенту. Worker ротирует оба GitHub token до истечения восьмичасового access token. Настройка: [docs/oauth-proxy-setup.md](docs/oauth-proxy-setup.md).

## GitHub Pages и production OAuth

Workflow [deploy-pages.yml](.github/workflows/deploy-pages.yml) публикует `dist` при push в `main`.

1. В **Settings → Pages → Build and deployment** выберите **GitHub Actions**.
2. В **Settings → Secrets and variables → Actions → Variables** добавьте:
   - `VITE_GITHUB_CLIENT_ID`;
   - `VITE_GITHUB_APP_SLUG` или `VITE_GITHUB_APP_INSTALL_URL`.
   - `VITE_OAUTH_PROXY_URL` — публичный HTTPS URL Worker, без секретов.
3. Добавьте Pages URL в Homepage/callback URL GitHub App и в `ALLOWED_ORIGINS`/`ALLOWED_REDIRECT_URIS` Worker.
4. Выполните push в основную ветку.

Без `VITE_OAUTH_PROXY_URL` кнопка входа показывает ошибку конфигурации: скрытого production fallback на Device Flow нет. Device Flow остаётся только для `DEV` или `VITE_ENABLE_LEGACY_DEVICE_FLOW=true`, потому что browser CORS делает его ненадёжным на Pages.

Workflow передаёт `VITE_BASE_PATH=/<repository-name>/` и останавливает deploy до сборки, если `VITE_GITHUB_CLIENT_ID` или HTTPS `VITE_OAUTH_PROXY_URL` отсутствует. CSP формируется Vite-плагином: в `connect-src` добавляется только origin настроенного proxy. В Actions Variables нет секретов: `client_id`, proxy URL и URL установки публичны.

## Хранение данных и миграция

| Место            | Данные                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GitHub           | Issues, state, обычные labels, `kf:status:*`, `kf:priority:*`, assignees                                               |
| IndexedDB        | `kitsuflow-db` v6: заметки, кеш реальных Issues/репозиториев, `pendingIssues`, outbox, вкладки, настройки и метаданные |
| `sessionStorage` | GitHub App access token, expiry и непрозрачный идентификатор серверной refresh-сессии                                  |

### Автоматическая миграция IndexedDB

При первом запуске новая версия обнаруживает существующую базу данных `kitsune-manager` и транзакционно копирует все данные (`localNotes`, `outbox`, `githubIssuesCache`, `tabs` и др.) в `kitsuflow-db`. Резервная копия `kitsune-manager` сохраняется нетронутой.

Локальные заметки не синхронизируются между устройствами: у статического сайта нет собственного сервера и записи без репозитория сознательно не отправляются в GitHub.

Подробнее: [архитектура](docs/architecture.md), [модель данных](docs/data-model.md), [GitHub sync](docs/github-sync.md), [статусы](docs/status-mapping.md).

## Offline и outbox

Service Worker кеширует только оболочку приложения; GitHub API используется в режиме Network Only, а предметный кеш ведёт Dexie. Операции выполняются последовательно. При отсутствии сети новые Issues остаются как временные карточки. После подтверждённого ответа GitHub временная карточка или исходная заметка заменяется настоящим Issue.

Состояния outbox:

- `pending` — готова к отправке;
- `syncing` — выполняется;
- `failed` — временная ошибка (например rate-limit) с запланированным временем повтора (`nextAttemptAt`);
- `attention` — ошибка доступа (403/404/422) или неопределённость сетевого обрыва;
- `exhausted` — превышено количество попыток (`maxSyncAttempts`). Ручной retry сбрасывает статус в `pending`.

## Безопасность

- Никогда не добавляйте PAT, client secret или access token в Vite `.env`, репозиторий и Actions Variables. `GITHUB_CLIENT_SECRET` хранится только через `wrangler secret put`.
- GitHub refresh token хранится только в KV binding `OAUTH_SESSIONS`; браузер и Pages bundle его не получают.
- `.env` исключён через `.gitignore`; публикуйте только `.env.example`.
- Markdown рендерится React-компонентами без `dangerouslySetInnerHTML` и без raw HTML.
- CSP ограничивает scripts/images/connect endpoints GitHub API и OAuth.
- Включите **Secret scanning** в Settings → Code security and analysis.
- CI использует Dependency Review для pull requests; Dependabot можно включить в настройках репозитория.

## Сброс локальных данных

Откройте DevTools → Application → Storage → IndexedDB → `kitsuflow-db` → Delete database, затем очистите данные сайта. Это безвозвратно удалит локальные заметки и outbox, но не изменит GitHub Issues. Обычный выход удаляет только токен активной сессии и безопаснее полного сброса.

## Известные ограничения

- Production OAuth требует развёрнутый и настроенный Worker; локальный mock proxy не доказывает работу реального опубликованного OAuth.
- Поддерживается только GitHub App с user-to-server token expiration. Обычный OAuth App несовместим с моделью installations.
- Offline-изменения не синхронизируются, пока вкладка/PWA снова не окажется онлайн и пользователь не войдёт.
- При неоднозначном сетевом разрыве GitHub не даёт idempotency key: UI требует ручной проверки репозитория и отдельного подтверждения повторного POST.
- Нет ручной сортировки внутри колонок: используется `updatedAt`.
- На экранах уже примерно 920 px сохраняется функциональность, но отдельного мобильного UX нет.
- ETag-кеширование оставлено на транспортный слой GitHub/CDN; предметный кеш явно обновляется после сетевого ответа.

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE)
