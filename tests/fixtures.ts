import type { ApiIssue } from '../src/domain/github-mapping';

export const apiIssue = (overrides: Partial<ApiIssue> = {}): ApiIssue => ({
  number: 12,
  node_id: 'I_kwTEST',
  title: 'Fix sync',
  body: 'Body',
  state: 'open',
  labels: [],
  assignees: [],
  html_url: 'https://github.com/acme/repo/issues/12',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-02T00:00:00Z',
  ...overrides,
});
