import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const appName = process.env.VITE_APP_NAME || 'KitsuFlow';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
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
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['app-icon.svg'],
      manifest: {
        name: appName,
        short_name: appName,
        description: 'Local-first GitHub Issues manager',
        lang: 'ru',
        theme_color: '#18191d',
        background_color: '#f2f3f5',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.github\.com\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
});
