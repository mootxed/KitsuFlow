import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function oauthProxyOrigin(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  const url = new URL(rawUrl);
  const isLocalHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('VITE_OAUTH_PROXY_URL должен использовать HTTPS (кроме localhost).');
  }
  return url.origin;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const appName = env.VITE_APP_NAME || 'KitsuFlow';
  const proxyOrigin = oauthProxyOrigin(env.VITE_OAUTH_PROXY_URL);

  // Нормализуем base path: всегда начинается и заканчивается на '/'
  let base = env.VITE_BASE_PATH || '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;

  // start_url для PWA: './' работает корректно для sub-path GitHub Pages
  const startUrl = base === '/' ? '/' : base;

  return {
    base,
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom', 'zustand'],
            github: ['@octokit/rest'],
            markdown: ['react-markdown', 'remark-gfm'],
            storage: ['dexie'],
            interaction: ['@dnd-kit/core', '@dnd-kit/utilities', 'lucide-react'],
          },
        },
      },
    },
    plugins: [
      {
        name: 'kitsuflow-oauth-proxy-csp',
        transformIndexHtml(html) {
          return html.replace('__OAUTH_PROXY_CONNECT_SRC__', proxyOrigin ? ` ${proxyOrigin}` : '');
        },
      },
      react(),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['app-icon.svg'],
        manifest: {
          name: appName,
          short_name: appName,
          description: 'Local-first GitHub Issues manager',
          lang: 'ru',
          theme_color: '#3b7de8',
          background_color: '#f2f2f7',
          display: 'standalone',
          // start_url с правильным base path для GitHub Pages
          start_url: startUrl,
          scope: base,
          icons: [
            { src: 'app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          ],
        },
        workbox: {
          // navigateFallback с учётом base path
          navigateFallback: `${base}index.html`,
          // Исключаем OAuth endpoints из кеширования
          navigateFallbackDenylist: [
            // GitHub OAuth endpoints — не кешировать
            /^https:\/\/github\.com\/login/,
          ],
          runtimeCaching: [
            {
              // GitHub API — всегда network-only
              urlPattern: /^https:\/\/api\.github\.com\//,
              handler: 'NetworkOnly',
            },
            {
              // GitHub OAuth — network-only
              urlPattern: /^https:\/\/github\.com\/login/,
              handler: 'NetworkOnly',
            },
            {
              // OAuth proxy — network-only (если VITE_OAUTH_PROXY_URL задан)
              urlPattern: new RegExp(
                `^${(env.VITE_OAUTH_PROXY_URL || 'https://noop.invalid').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
              ),
              handler: 'NetworkOnly',
            },
          ],
        },
      }),
    ],
  };
});
