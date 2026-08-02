/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_GITHUB_CLIENT_ID?: string;
  readonly VITE_GITHUB_APP_SLUG?: string;
  readonly VITE_GITHUB_APP_INSTALL_URL?: string;
  readonly VITE_OAUTH_PROXY_URL?: string;
  readonly VITE_ENABLE_LEGACY_DEVICE_FLOW?: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_APP_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
