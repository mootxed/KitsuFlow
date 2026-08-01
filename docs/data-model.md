# Модель данных

Dexie database `kitsune-manager` имеет мигрируемую схему.

- `localNotes`: UUID, текст, локальные теги/чек-лист, статус, необязательный репозиторий и sync state. Приоритет/assignee отсутствуют на уровне типа.
- `githubIssuesCache`: нормализованный Issue по `[repositoryFullName+issueNumber]`; временная карточка имеет отрицательный номер и `clientLocalId`.
- `repositoriesCache`: репозитории установок и локальный флаг `pinned`.
- `repositoryLabelsCache`: labels для сопоставления локальных тегов при публикации.
- `outbox`: операция, payload, entity key, attempts, last error, request-started marker и состояние.
- `tabs`: сущность вкладки, позиция и active flag.
- `settings`, `syncMetadata`: расширяемые локальные настройки и времена синхронизации.

Состояния синхронизации предметных сущностей: `local`, `pending`, `syncing`, `synced`, `failed`, `conflict`. Состояния операции outbox: `pending`, `syncing`, `failed`, `attention`.

Access token принципиально отсутствует в IndexedDB.
