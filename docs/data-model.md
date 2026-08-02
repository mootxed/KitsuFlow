# Модель данных

Dexie database `kitsuflow-db` имеет мигрируемую схему. Одноразовая миграция переносит данные из старой базы `kitsune-manager`.

- `localNotes`: UUID, текст, локальные теги/чек-лист, статус, необязательный репозиторий и sync state. Приоритет/assignee отсутствуют на уровне типа.
- `githubIssuesCache`: только подтверждённые GitHub Issues по `[accountId+repositoryFullName+issueNumber]`.
- `pendingIssues`: временные карточки по стабильному `clientLocalId`; существуют offline и при `failed`/`attention`/`exhausted` до подтверждённого создания или ручной отмены.
- `repositoriesCache`: репозитории установок и локальный флаг `pinned`.
- `repositoryLabelsCache`: labels для сопоставления локальных тегов при публикации.
- `outbox`: операция, payload, entity key, attempts, last error, request-started marker и состояние (`pending`, `syncing`, `failed`, `attention`, `exhausted`).
- `tabs`: сущность вкладки, позиция и active flag.
- `settings`, `syncMetadata`: расширяемые локальные настройки и времена синхронизации.

Состояния синхронизации предметных сущностей: `local`, `pending`, `syncing`, `synced`, `failed`, `conflict`. Состояния операции outbox: `pending`, `syncing`, `failed`, `attention`, `exhausted`.

Текущая версия схемы — **v6**. Миграция v5→v6 связывает legacy-временную Issue с `create_issue`/`convert_note`, переносит вкладки `issueNumber: -1` в `pending-issue`, обновляет entity key/payload и нормализует позиции/active. При неоднозначности данные сохраняются и помечаются для ручной проверки.

Legacy claim переносит Issues, pendingIssues, notes, outbox, tabs, repository/labels/assignees caches и account-scoped sync metadata. Коллизии объединяются явно; отказ пользователя сохраняется в settings и не удаляет legacy-данные.

Access token принципиально отсутствует в IndexedDB (`sessionStorage`: `kitsuflow.github.access-token`).
