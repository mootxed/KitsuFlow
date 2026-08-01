# Kitsune Manager

Kitsune Manager — компактный local-first менеджер задач для разработчиков. GitHub Issues остаются источником истины для задач репозиториев, а быстрые личные заметки хранятся только в браузере и при необходимости публикуются как Issues.

Это полностью статическое React-приложение: backend, PAT и `client_secret` не нужны. Проект можно разместить на GitHub Pages.

## Возможности первой версии

- GitHub App Device Flow с токеном только в `sessionStorage`;
- получение установок GitHub App и выбор закреплённых репозиториев;
- загрузка и локальный кеш GitHub Issues без Pull Requests;
- локальные заметки, теги и чек-листы в IndexedDB;
- статусы и приоритеты через системные GitHub labels с префиксом `km:`;
- отдельная несинхронизируемая секция «Под вопросом»;
- публикация заметки в Issue с подтверждением и сохранением исходника до успеха;
- offline outbox, последовательная отправка, backoff, обработка 401/rate limit и неоднозначного создания;
- вкладки, правая панель, быстрое создание по `C` и drag-and-drop;
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
```

## Настройка GitHub App

1. Откройте **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Укажите любое уникальное имя и Homepage URL (`http://localhost:5173` для локальной разработки или адрес Pages).
3. Webhook отключите: эта статическая версия его не использует.
4. Включите **Enable Device Flow**.
5. В **Repository permissions** задайте:
   - **Issues: Read and write**;
   - **Metadata: Read-only** (GitHub включает это базовое разрешение автоматически).
6. Сохраните приложение и скопируйте публичный **Client ID**. Client secret создавать или передавать приложению не требуется.
7. На странице приложения нажмите **Install App** и разрешите доступ только к нужным репозиториям.
8. Заполните `.env`:

```dotenv
VITE_GITHUB_CLIENT_ID=Iv1.public_client_id
VITE_GITHUB_APP_SLUG=your-app-slug
# Альтернатива slug — полный URL установки:
# VITE_GITHUB_APP_INSTALL_URL=https://github.com/apps/your-app/installations/new
VITE_BASE_PATH=/
VITE_APP_NAME=Kitsune Manager
```

После Device Flow клиент проверяет токен запросом текущего пользователя. Токен живёт только в `sessionStorage`, не попадает в Zustand persistence, IndexedDB, URL или логи и удаляется при выходе/401.

## GitHub Pages

Workflow [deploy-pages.yml](.github/workflows/deploy-pages.yml) публикует `dist` при push в `master` или `main`.

1. В **Settings → Pages → Build and deployment** выберите **GitHub Actions**.
2. В **Settings → Secrets and variables → Actions → Variables** добавьте:
   - `VITE_GITHUB_CLIENT_ID`;
   - `VITE_GITHUB_APP_SLUG` или `VITE_GITHUB_APP_INSTALL_URL`.
3. Добавьте Pages URL в Homepage URL GitHub App.
4. Выполните push в основную ветку.

Workflow передаёт `VITE_BASE_PATH=/<repository-name>/`. Приложение использует `HashRouter`/hash-навигацию и не требует серверного fallback. Никаких секретов в workflow нет: `client_id` и URL установки публичны.

## Хранение данных

| Место            | Данные                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| GitHub           | Issues, state, обычные labels, `km:status:*`, `km:priority:*`, assignees                                 |
| IndexedDB        | локальные заметки, кеш Issues/репозиториев/labels, outbox, вкладки, настройки и метаданные синхронизации |
| `sessionStorage` | только OAuth access token активной вкладки браузера                                                      |

Локальные заметки не синхронизируются между устройствами: у статического сайта нет собственного сервера и записи без репозитория сознательно не отправляются в GitHub. Экспорт/импорт пока не реализован.

Подробнее: [архитектура](docs/architecture.md), [модель данных](docs/data-model.md), [GitHub sync](docs/github-sync.md), [статусы](docs/status-mapping.md).

## Offline и outbox

Service Worker кеширует только оболочку приложения; GitHub API используется в режиме Network Only, а предметный кеш ведёт Dexie. Операции выполняются последовательно. При отсутствии сети новые Issues остаются как временные карточки. После подтверждённого ответа GitHub временная карточка или исходная заметка заменяется настоящим Issue.

Если соединение оборвалось после начала `POST /issues`, автоматический повтор блокируется как `attention`: пользователь должен проверить GitHub, чтобы не создать дубликат. При 401 токен удаляется, но очередь сохраняется. При rate limit сохраняется время следующей попытки.

## Безопасность

- Никогда не добавляйте PAT, client secret или access token в `.env`, репозиторий и Actions variables.
- `.env` исключён через `.gitignore`; публикуйте только `.env.example`.
- Markdown рендерится React-компонентами без `dangerouslySetInnerHTML` и без raw HTML.
- CSP ограничивает scripts/images/connect endpoints GitHub API и OAuth.
- Включите **Secret scanning** в Settings → Code security and analysis.
- CI использует Dependency Review для pull requests; Dependabot можно включить в настройках репозитория.

## Сброс локальных данных

Откройте DevTools → Application → Storage → IndexedDB → `kitsune-manager` → Delete database, затем очистите данные сайта. Это безвозвратно удалит локальные заметки и outbox, но не изменит GitHub Issues. Обычный выход удаляет только токен активной сессии и безопаснее полного сброса.

## Известные ограничения

- Device Flow требует ручной настройки/установки GitHub App владельцем развёртывания.
- Offline-изменения не синхронизируются, пока вкладка/PWA снова не окажется онлайн и пользователь не войдёт.
- Временная карточка создания не может безопасно узнать, был ли создан Issue при неоднозначном сетевом разрыве.
- Нет ручной сортировки внутри колонок: используется `updatedAt`.
- На экранах уже примерно 920 px сохраняется функциональность, но отдельного мобильного UX нет.
- ETag-кеширование оставлено на транспортный слой GitHub/CDN; предметный кеш явно обновляется после сетевого ответа.

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE).
