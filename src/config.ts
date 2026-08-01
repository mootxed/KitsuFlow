export const APP_CONFIG = {
  name: import.meta.env.VITE_APP_NAME || 'Kitsune Manager',
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
  labels: {
    status: {
      inProgress: 'km:status:in-progress',
      postponed: 'km:status:postponed',
    },
    priority: {
      low: 'km:priority:low',
      medium: 'km:priority:medium',
      high: 'km:priority:high',
      urgent: 'km:priority:urgent',
    },
  },
  debounceMs: 650,
  maxSyncAttempts: 4,
} as const;

export const SYSTEM_LABEL_PREFIX = 'km:';

export const SYSTEM_LABEL_DEFINITIONS: Record<string, { color: string; description: string }> = {
  [APP_CONFIG.labels.status.inProgress]: {
    color: '1f883d',
    description: 'Kitsune Manager: issue is in progress',
  },
  [APP_CONFIG.labels.status.postponed]: {
    color: '6e7781',
    description: 'Kitsune Manager: issue is postponed',
  },
  [APP_CONFIG.labels.priority.low]: { color: '8c959f', description: 'Kitsune priority: low' },
  [APP_CONFIG.labels.priority.medium]: {
    color: 'bf8700',
    description: 'Kitsune priority: medium',
  },
  [APP_CONFIG.labels.priority.high]: { color: 'd1242f', description: 'Kitsune priority: high' },
  [APP_CONFIG.labels.priority.urgent]: {
    color: '8250df',
    description: 'Kitsune priority: urgent',
  },
};
