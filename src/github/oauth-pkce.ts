/**
 * oauth-pkce.ts
 *
 * PKCE Authorization Code Flow для GitHub OAuth.
 *
 * GitHub OAuth Apps не поддерживают CORS на эндпоинте access_token, поэтому
 * exchange кода нужен server-side через Cloudflare Worker proxy.
 *
 * Схема:
 *   1. generatePkce()    → code_verifier + code_challenge
 *   2. buildAuthUrl()    → URL для редиректа на github.com
 *   3. parseCallback()   → извлечь code + state из URL
 *   4. exchangeCode()    → POST на proxy (server-side, без client_secret в bundle)
 */

import { APP_CONFIG } from '../config';

export interface PkceState {
  codeVerifier: string;
  oauthState: string;
}

export interface OAuthCallbackSuccess {
  kind: 'success';
  code: string;
  state: string;
}

export interface OAuthCallbackError {
  kind: 'error';
  error: string;
  errorDescription?: string | undefined;
  errorUri?: string | undefined;
}

export type OAuthCallbackParams = OAuthCallbackSuccess | OAuthCallbackError;

/** Генерирует криптографически стойкий code_verifier (43–128 символов). */
async function generateCodeVerifier(): Promise<string> {
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

/** Вычисляет code_challenge = BASE64URL(SHA-256(verifier)). */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(new Uint8Array(digest));
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Генерирует пару verifier/state для PKCE flow. */
export async function generatePkce(): Promise<PkceState> {
  const codeVerifier = await generateCodeVerifier();
  // state используется для защиты от CSRF
  const stateBytes = new Uint8Array(24);
  crypto.getRandomValues(stateBytes);
  const oauthState = base64urlEncode(stateBytes);
  return { codeVerifier, oauthState };
}

/** Сохраняет PKCE state в sessionStorage (не localStorage — не переживает перезапуск). */
export function savePkceState(pkce: PkceState): void {
  sessionStorage.setItem('kitsuflow.oauth.verifier', pkce.codeVerifier);
  sessionStorage.setItem('kitsuflow.oauth.state', pkce.oauthState);
}

/** Читает и удаляет PKCE state из sessionStorage. */
export function consumePkceState(): PkceState | null {
  const codeVerifier = sessionStorage.getItem('kitsuflow.oauth.verifier');
  const oauthState = sessionStorage.getItem('kitsuflow.oauth.state');
  sessionStorage.removeItem('kitsuflow.oauth.verifier');
  sessionStorage.removeItem('kitsuflow.oauth.state');
  if (!codeVerifier || !oauthState) return null;
  return { codeVerifier, oauthState };
}

/**
 * Строит redirect_uri с учётом VITE_BASE_PATH.
 * Пользователь возвращается на GitHub Pages URL проекта.
 */
export function buildRedirectUri(): string {
  const base = import.meta.env.BASE_URL || '/';
  // Убираем trailing slash, чтобы добавить ?code= параметры к корневому пути
  const origin = window.location.origin;
  const path = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${origin}${path}/`;
}

/**
 * Строит URL для редиректа на GitHub Authorization.
 * После авторизации GitHub редиректит обратно на redirect_uri с ?code=&state=
 */
export async function buildAuthUrl(clientId: string, pkce: PkceState): Promise<string> {
  const codeChallenge = await generateCodeChallenge(pkce.codeVerifier);
  const redirectUri = buildRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo',
    state: pkce.oauthState,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Извлекает code и state из текущего URL (после редиректа с GitHub).
 * Возвращает null, если параметры отсутствуют.
 */
export function parseCallback(url: URL): OAuthCallbackParams | null {
  const error = url.searchParams.get('error');
  if (error) {
    return {
      kind: 'error',
      error,
      errorDescription: url.searchParams.get('error_description') || undefined,
      errorUri: url.searchParams.get('error_uri') || undefined,
    };
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return null;
  return { kind: 'success', code, state };
}

/** Удаляет только OAuth-параметры, сохраняя base path и hash-route. */
export function cleanOAuthCallbackUrl(url: URL): string {
  const cleaned = new URL(url.toString());
  for (const name of ['code', 'state', 'error', 'error_description', 'error_uri']) {
    cleaned.searchParams.delete(name);
  }
  return `${cleaned.pathname}${cleaned.search}${cleaned.hash}`;
}

/**
 * Обменивает code на access_token через CORS proxy.
 *
 * Proxy URL задаётся через `VITE_OAUTH_PROXY_URL`.
 * Пример Cloudflare Worker: см. docs/oauth-proxy-setup.md
 *
 * Proxy получает: { code, code_verifier, redirect_uri }
 * Proxy возвращает: { access_token } или { error, error_description }
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  signal?: AbortSignal,
): Promise<string> {
  const proxyUrl = import.meta.env.VITE_OAUTH_PROXY_URL;
  if (!proxyUrl) {
    throw new Error(
      'VITE_OAUTH_PROXY_URL не задан. Для работы OAuth на GitHub Pages необходим serverless proxy. ' +
        'Подробнее: docs/oauth-proxy-setup.md',
    );
  }

  const clientId = APP_CONFIG.github.clientId;
  if (!clientId) {
    throw new Error('VITE_GITHUB_CLIENT_ID не задан.');
  }

  const redirectUri = buildRedirectUri();

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
      signal: signal ?? null,
    });
  } catch (fetchError) {
    if (fetchError instanceof DOMException && fetchError.name === 'AbortError') throw fetchError;
    throw new Error(
      `Не удалось связаться с OAuth proxy (${proxyUrl}). Проверьте, что proxy развёрнут и доступен.`,
    );
  }

  if (!response.ok) {
    throw new Error(`OAuth proxy вернул HTTP ${response.status}.`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  if (!data.access_token) {
    throw new Error('OAuth proxy не вернул access_token.');
  }

  return data.access_token;
}
