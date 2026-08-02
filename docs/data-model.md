# Модель данных

Dexie database `kitsuflow-db` имеет мигрируемую схему. Одноразовая миграция переносит данные из старой базы `kitsune-manager`.

- `localNotes`: UUID, текст, локальные теги/чек-лист, статус, необязательный репозиторий и sync state. Приоритет/assignee отсутствуют на уровне типа.
- `githubIssuesCache`: только подтверждённые GitHub Issues по `[accountId+repositoryFullName+issueNumber]`.
- `pendingIssues`: временные карточки по стабильному `clientLocalId`; неоднозначная миграция дополнительно связывает карточку с кандидатами через `migrationGroupId`.
- `repositoriesCache`: репозитории установок и локальный флаг `pinned`.
- `repositoryLabelsCache`: labels для сопоставления локальных тегов при публикации.
- `outbox`: операция, payload, entity key, attempts, last error, request-started marker и состояние (`pending`, `syncing`, `failed`, `attention`, `exhausted`).
- `tabs`: сущность вкладки, позиция и active flag.
- `settings`, `syncMetadata`: расширяемые локальные настройки и времена синхронизации.

Состояния синхронизации предметных сущностей: `local`, `pending`, `syncing`, `synced`, `failed`, `conflict`. Состояния операции outbox: `pending`, `syncing`, `failed`, `attention`, `exhausted`.

Текущая версия схемы — **v6**. Миграция v5→v6 связывает legacy-временную Issue с `create_issue`/`convert_note`, переносит вкладки `issueNumber: -1` в `pending-issue`, обновляет entity key/payload и нормализует позиции/active. При нескольких кандидатах все операции переводятся в `attention + ambiguityRisk`, получают общий `migrationGroupId` и исключаются из автоматической обработки. Отмена удаляет всю группу.

Legacy claim переносит Issues, pendingIssues, notes, outbox, tabs, repository/labels/assignees caches и account-scoped sync metadata. Коллизии объединяются явно; отказ пользователя сохраняется в settings и не удаляет legacy-данные.

OAuth credentials принципиально отсутствуют в IndexedDB. В `sessionStorage` находятся короткоживущий GitHub App access token и непрозрачный Worker session ID; GitHub refresh token хранится только в Cloudflare KV.
