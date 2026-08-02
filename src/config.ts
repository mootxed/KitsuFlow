export const APP_CONFIG = {
  name: import.meta.env.VITE_APP_NAME || 'KitsuFlow',
  github: {
    clientId: import.meta.env.VITE_GITHUB_CLIENT_ID || '',
    installUrl:
      import.meta.env.VITE_GITHUB_APP_INSTALL_URL ||
      (import.meta.env.VITE_GITHUB_APP_SLUG
        ? `https://github.com/apps/${import.meta.env.VITE_GITHUB_APP_SLUG}/installations/new`
        : ''),
    apiVersion: '2022-11-28',
    accept: 'application/vnd.github+json',
  },
  oauth: {
    proxyUrl: import.meta.env.VITE_OAUTH_PROXY_URL || '',
    legacyDeviceFlowEnabled:
      import.meta.env.DEV || import.meta.env.VITE_ENABLE_LEGACY_DEVICE_FLOW === 'true',
  },
  labels: {
    status: {
      inProgress: 'kf:status:in-progress',
      postponed: 'kf:status:postponed',
    },
    priority: {
      low: 'kf:priority:low',
      medium: 'kf:priority:medium',
      high: 'kf:priority:high',
      urgent: 'kf:priority:urgent',
    },
  },
  debounceMs: 650,
  maxSyncAttempts: 4,
} as const;

/** Текущий префикс системных labels. */
export const SYSTEM_LABEL_PREFIX = 'kf:';

/** Все известные системные префиксы (включая устаревший km:). */
export const SYSTEM_LABEL_PREFIXES = ['kf:', 'km:'] as const;

export function isSystemLabel(name: string): boolean {
  return SYSTEM_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export const SYSTEM_LABEL_DEFINITIONS: Record<string, { color: string; description: string }> = {
  [APP_CONFIG.labels.status.inProgress]: {
    color: '1f883d',
    description: 'KitsuFlow: issue is in progress',
  },
  [APP_CONFIG.labels.status.postponed]: {
    color: '6e7781',
    description: 'KitsuFlow: issue is postponed',
  },
  [APP_CONFIG.labels.priority.low]: { color: '8c959f', description: 'KitsuFlow priority: low' },
  [APP_CONFIG.labels.priority.medium]: {
    color: 'bf8700',
    description: 'KitsuFlow priority: medium',
  },
  [APP_CONFIG.labels.priority.high]: { color: 'd1242f', description: 'KitsuFlow priority: high' },
  [APP_CONFIG.labels.priority.urgent]: {
    color: '8250df',
    description: 'KitsuFlow priority: urgent',
  },
};
