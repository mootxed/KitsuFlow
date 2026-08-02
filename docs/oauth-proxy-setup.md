# GitHub App PKCE и refresh proxy

KitsuFlow поддерживает только **GitHub App user access tokens**. Обычный OAuth App не подходит: чтение репозиториев выполняется через `/user/installations`, а доступ определяется пересечением permissions приложения и пользователя. Параметр OAuth `scope` не отправляется.

GitHub не разрешает browser CORS для `POST /login/oauth/access_token`. Поэтому production OAuth на GitHub Pages использует Cloudflare Worker. Клиент не содержит `client_secret`; Worker обменивает code, хранит GitHub refresh token в KV и выполняет его ротацию.

Исходник Worker находится в [`oauth-worker/src/index.ts`](../oauth-worker/src/index.ts), пример конфигурации — в [`oauth-worker/wrangler.toml.example`](../oauth-worker/wrangler.toml.example).

## Поток

```text
Pages → GitHub App /authorize (state + PKCE challenge, без OAuth scopes)
GitHub → Pages callback (?code&state)
Pages → Worker { code, code_verifier, redirect_uri }
Worker → GitHub /access_token (+ client_secret)
Worker → KV { refresh_token }
Worker → Pages { access_token, expires_in, refresh_session_id }
Pages → Worker { refresh_session_id } до истечения access token
Worker → GitHub refresh_token grant → ротация записи KV
```

`refresh_session_id` — непрозрачный случайный идентификатор. Он не является GitHub refresh token и хранится вместе с короткоживущим access token только в `sessionStorage`. Callback затем один раз загружает `/user`, installations, repositories, outbox и Issues. Параметры OAuth удаляются из URL с сохранением hash-route.

## Развёртывание

1. Создайте именно GitHub App. Оставьте включённой опцию **User-to-server token expiration**. Permissions: `Issues: Read and write`, `Metadata: Read-only`.
2. Создайте Cloudflare KV namespace для refresh-сессий и preview namespace, затем заполните `id`/`preview_id` binding `OAUTH_SESSIONS` в `wrangler.toml`.
3. Скопируйте `oauth-worker/wrangler.toml.example` в `oauth-worker/wrangler.toml` и укажите:
   - `GITHUB_CLIENT_ID`;
   - `ALLOWED_ORIGINS`, например `https://mootxed.github.io,http://localhost:4173,http://127.0.0.1:4173`;
   - `ALLOWED_REDIRECT_URIS`, например `https://mootxed.github.io/KitsuFlow/,http://localhost:4173/`.
4. Сохраните секрет только в Cloudflare:

   ```bash
   cd oauth-worker
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler deploy
   ```

5. Добавьте публичный URL Worker в `.env` и GitHub Actions Variable:

   ```dotenv
   VITE_GITHUB_CLIENT_ID=your-public-client-id
   VITE_OAUTH_PROXY_URL=https://kitsuflow-oauth.example.workers.dev
   VITE_BASE_PATH=/KitsuFlow/
   ```

6. Callback URL GitHub App должен в точности совпадать с `redirect_uri`, включая trailing slash.

## Ограничения безопасности Worker

Worker проверяет `Origin`, разрешает только allowlist и localhost, проверяет тип/длину `code`, `code_verifier`, `redirect_uri`, `refresh_session_id` и точное вхождение redirect URI в allowlist. Все ответы имеют `Cache-Control: no-store`; CORS никогда не использует `*`. Внутренние исключения не возвращаются клиенту. Code, verifier, access/refresh token и secret не логируются.

`GITHUB_CLIENT_SECRET` нельзя задавать как `VITE_*`, Actions Variable или включать в bundle. `VITE_OAUTH_PROXY_URL` не является секретом.

## Device Flow

Device Flow не является production fallback. Он доступен в Vite dev mode или при явном `VITE_ENABLE_LEGACY_DEVICE_FLOW=true`; на GitHub Pages его browser-запросы могут быть заблокированы CORS. Если proxy не настроен, production UI показывает ошибку конфигурации.

Локальные mock-тесты проверяют PKCE/state/exchange/refresh/CORS/CSP и Pages subpath, но реальный OAuth считается проверенным только после ручного входа на опубликованном Pages с настоящим GitHub App и Worker, а также фактической или принудительной ротации token.
