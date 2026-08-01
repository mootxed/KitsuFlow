# Модель данных

Dexie database `kitsuflow-db` имеет мигрируемую схему. Одноразовая миграция переносит данные из старой базы `kitsune-manager`.

- `localNotes`: UUID, текст, локальные теги/чек-лист, статус, необязательный репозиторий и sync state. Приоритет/assignee отсутствуют на уровне типа.
- `githubIssuesCache`: нормализованный Issue по `[repositoryFullName+issueNumber]`; временная карточка имеет отрицательный номер и `clientLocalId`.
- `repositoriesCache`: репозитории установок и локальный флаг `pinned`.
- `repositoryLabelsCache`: labels для сопоставления локальных тегов при публикации.
- `outbox`: операция, payload, entity key, attempts, last error, request-started marker и состояние (`pending`, `syncing`, `failed`, `attention`, `exhausted`).
- `tabs`: сущность вкладки, позиция и active flag.
- `settings`, `syncMetadata`: расширяемые локальные настройки и времена синхронизации.

Состояния синхронизации предметных сущностей: `local`, `pending`, `syncing`, `synced`, `failed`, `conflict`. Состояния операции outbox: `pending`, `syncing`, `failed`, `attention`, `exhausted`.

Access token принципиально отсутствует в IndexedDB (`sessionStorage`: `kitsuflow.github.access-token`).
