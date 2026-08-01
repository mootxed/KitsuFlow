import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    'import.meta.env.VITE_GITHUB_CLIENT_ID': JSON.stringify('test-client-id'),
    'import.meta.env.VITE_APP_NAME': JSON.stringify('KitsuFlow'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: true,
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
