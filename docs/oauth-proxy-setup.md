# GitHub OAuth PKCE CORS Proxy Setup

GitHub Pages — это статический хостинг (SPA). Браузёры блокируют прямые POST-запросы к `https://github.com/login/oauth/access_token` из-за политики **CORS** (Cross-Origin Resource Sharing).

Для поддержки безопасной OAuth-авторизации с PKCE (Authorization Code Flow) без хранения `client_secret` на клиенте необходим минимальный serverless proxy (Cloudflare Worker).

---

## Архитектура PKCE с Proxy

```
[ Браузер (Pages) ] --(1) /authorize (PKCE challenge)--> [ GitHub ]
[ Браузер (Pages) ] <--(2) Redirect ?code=...----------- [ GitHub ]
[ Браузер (Pages) ] --(3) POST {code, verifier}---------> [ Worker Proxy ]
                                                         [ Worker Proxy ] --(4) POST + client_secret --> [ GitHub ]
                                                         [ Worker Proxy ] <--(5) {access_token} --------- [ GitHub ]
[ Браузер (Pages) ] <--(6) {access_token} -------------- [ Worker Proxy ]
```

---

## Исходный код Cloudflare Worker (`worker.js`)

Разверните следующий код в бесплатном аккаунте [Cloudflare Workers](https://workers.cloudflare.com/):

```javascript
export default {
  async fetch(request, env) {
    // Обработка CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      const { code, code_verifier, redirect_uri } = await request.json();

      if (!code || !code_verifier) {
        return new Response(JSON.stringify({ error: 'Missing code or code_verifier' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // Обмен кода на access_token на стороне сервера
      const ghResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          code_verifier,
          redirect_uri,
        }),
      });

      const data = await ghResponse.json();

      return new Response(JSON.stringify(data), {
        status: ghResponse.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
```

---

## Настройка переменных окружения

### 1. Переменные в Cloudflare Worker:
- `GITHUB_CLIENT_ID` — Client ID вашего GitHub App / OAuth App
- `GITHUB_CLIENT_SECRET` — Client Secret вашего GitHub App / OAuth App

### 2. Переменные в `.env` вашего KitsuFlow приложения:
```env
VITE_GITHUB_CLIENT_ID=ваш_client_id
VITE_OAUTH_PROXY_URL=https://kitsuflow-oauth.your-worker.workers.dev
VITE_BASE_PATH=/KitsuFlow/
```

---

## Fallback (Device Flow)

Если `VITE_OAUTH_PROXY_URL` не задан, KitsuFlow автоматически переключается на **Device Flow** (`https://github.com/login/device/code`). 

*Примечание:* Device Flow корректно работает без прокси только при использовании **GitHub App** (не OAuth App).
