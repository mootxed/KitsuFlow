import { APP_CONFIG } from '../config';

export type DeviceFlowState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | {
      phase: 'waiting';
      userCode: string;
      verificationUri: string;
      expiresAt: number;
      interval: number;
    }
  | { phase: 'success'; token: string }
  | { phase: 'expired'; message: string }
  | { phase: 'error'; message: string };

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  error?: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string;
  error_description?: string;
}

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(id);
        reject(new DOMException('Отменено', 'AbortError'));
      },
      { once: true },
    );
  });

async function githubFormPost<T>(
  url: string,
  body: URLSearchParams,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  if (!response.ok) throw new Error(`GitHub OAuth вернул ${response.status}`);
  return (await response.json()) as T;
}

export class DeviceFlowController {
  private controller: AbortController | null = null;

  constructor(
    private readonly clientId = APP_CONFIG.github.clientId,
    private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void> = wait,
  ) {}

  get running(): boolean {
    return Boolean(this.controller);
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  async start(onState: (state: DeviceFlowState) => void): Promise<string | null> {
    if (this.controller) return null;
    if (!this.clientId) {
      onState({ phase: 'error', message: 'Не задан VITE_GITHUB_CLIENT_ID' });
      return null;
    }
    this.controller = new AbortController();
    const { signal } = this.controller;
    try {
      onState({ phase: 'requesting' });
      const device = await githubFormPost<DeviceCodeResponse>(
        'https://github.com/login/device/code',
        new URLSearchParams({ client_id: this.clientId }),
        signal,
      );
      if (device.error) throw new Error(device.error_description || device.error);
      const expiresAt = Date.now() + device.expires_in * 1000;
      let intervalSeconds = Math.max(device.interval || 5, 1);
      onState({
        phase: 'waiting',
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        expiresAt,
        interval: intervalSeconds,
      });
      while (Date.now() < expiresAt) {
        await this.sleep(intervalSeconds * 1000, signal);
        const token = await githubFormPost<TokenResponse>(
          'https://github.com/login/oauth/access_token',
          new URLSearchParams({
            client_id: this.clientId,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal,
        );
        if (token.access_token) {
          onState({ phase: 'success', token: token.access_token });
          return token.access_token;
        }
        if (token.error === 'authorization_pending') continue;
        if (token.error === 'slow_down') {
          intervalSeconds += 5;
          continue;
        }
        if (token.error === 'expired_token') {
          onState({ phase: 'expired', message: 'Код GitHub истёк. Запросите новый.' });
          return null;
        }
        throw new Error(token.error_description || token.error || 'Неизвестная ошибка авторизации');
      }
      onState({ phase: 'expired', message: 'Код GitHub истёк. Запросите новый.' });
      return null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      onState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Ошибка Device Flow',
      });
      return null;
    } finally {
      this.controller = null;
    }
  }
}
