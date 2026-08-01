# Архитектура

Приложение разделено на четыре слоя.

1. `domain/` содержит типы, инварианты заметок и чистое сопоставление GitHub labels со статусами/приоритетами.
2. `github/` инкапсулирует Device Flow, сессию и все вызовы Octokit. React-компоненты Octokit не импортируют.
3. `data/` и `sync/` содержат версионируемую Dexie-схему и последовательный outbox.
4. `state/` координирует optimistic UI, кеш и вкладки; `components/` отвечает только за взаимодействие и представление.

Поток обновления GitHub Issue:

```text
UI → optimistic Zustand/IndexedDB → outbox → GitHub API
                                      ↓ success
                              normalized cache → UI
```

GitHub остаётся источником истины. Кеш нужен для быстрого старта и offline-чтения; при сети закреплённые репозитории обновляются заново.

`HashRouter` выбран из-за отсутствия rewrite/fallback на project GitHub Pages. Название и системные labels собраны в `src/config.ts`.
