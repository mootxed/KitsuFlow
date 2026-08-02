import { defineConfig, devices } from '@playwright/test';

const port = 4273;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['production-pages.spec.ts'],
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}/KitsuFlow/`,
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [{ name: 'chromium-production-pages', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'VITE_BASE_PATH=/KitsuFlow/ VITE_OAUTH_PROXY_URL=https://oauth-proxy.test corepack pnpm build && VITE_BASE_PATH=/KitsuFlow/ VITE_OAUTH_PROXY_URL=https://oauth-proxy.test corepack pnpm exec vite preview --host 127.0.0.1 --port 4273',
    url: `http://127.0.0.1:${port}/KitsuFlow/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
