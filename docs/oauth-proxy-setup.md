# GitHub OAuth PKCE proxy

GitHub не разрешает browser CORS для `POST /login/oauth/access_token`. Поэтому production OAuth на GitHub Pages использует минимальный Cloudflare Worker. Клиентское приложение остаётся статическим и не содержит `client_secret`; Worker — обязательный backend-компонент для обмена кода.

Исходник Worker находится в [`oauth-worker/src/index.ts`](../oauth-worker/src/index.ts), пример конфигурации — в [`oauth-worker/wrangler.toml.example`](../oauth-worker/wrangler.toml.example).

## Поток

```text
Pages → GitHub /authorize (state + PKCE challenge)
GitHub → Pages callback (?code&state)
Pages → Worker { code, code_verifier, redirect_uri }
Worker → GitHub /access_token (+ client_secret)
Worker → Pages { access_token }
```

Callback только обменивает и сохраняет token в `sessionStorage`; затем `initialize()` один раз загружает `/user`, installations, repositories, outbox и Issues. Параметры `code`, `state`, `error`, `error_description`, `error_uri` удаляются из URL с сохранением hash-route.

## Развёртывание

1. Скопируйте `oauth-worker/wrangler.toml.example` в `oauth-worker/wrangler.toml` и укажите:
   - `GITHUB_CLIENT_ID`;
   - `ALLOWED_ORIGINS`, например `https://mootxed.github.io,http://localhost:4173,http://127.0.0.1:4173`;
   - `ALLOWED_REDIRECT_URIS`, например `https://mootxed.github.io/KitsuFlow/,http://localhost:4173/`.
2. Сохраните секрет только в Cloudflare:

   ```bash
   cd oauth-worker
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler deploy
   ```

3. Добавьте публичный URL Worker в `.env` и GitHub Actions Variable:

   ```dotenv
   VITE_GITHUB_CLIENT_ID=your-public-client-id
   VITE_OAUTH_PROXY_URL=https://kitsuflow-oauth.example.workers.dev
   VITE_BASE_PATH=/KitsuFlow/
   ```

4. Callback URL в GitHub OAuth/GitHub App должен в точности совпадать с `redirect_uri`, включая trailing slash.

## Ограничения безопасности Worker

Worker проверяет `Origin`, разрешает только allowlist и localhost, проверяет тип/длину `code`, `code_verifier`, `redirect_uri` и точное вхождение redirect URI в allowlist. Все ответы имеют `Cache-Control: no-store`; CORS никогда не использует `*`. Внутренние исключения не возвращаются клиенту. Код, verifier, token и secret не логируются.

`GITHUB_CLIENT_SECRET` нельзя задавать как `VITE_*`, Actions Variable или включать в bundle. `VITE_OAUTH_PROXY_URL` не является секретом.

## Device Flow

Device Flow не является production fallback. Он доступен в Vite dev mode или при явном `VITE_ENABLE_LEGACY_DEVICE_FLOW=true`; на GitHub Pages его browser-запросы могут быть заблокированы CORS. Если proxy не настроен, production UI показывает ошибку конфигурации.

Локальные mock-тесты проверяют PKCE/state/proxy/CSP и Pages subpath, но реальный OAuth считается проверенным только после ручного входа на опубликованном Pages с настоящим GitHub App/OAuth App и Worker.
