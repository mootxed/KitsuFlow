import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { GitHubApi } from '../../src/github/api';
import { server } from '../test-server';

describe('GitHub API layer', () => {
  it('loads repositories through user installations', async () => {
    server.use(
      http.get('https://api.github.com/user/installations', () =>
        HttpResponse.json({
          total_count: 1,
          installations: [{ id: 7, account: { login: 'acme' } }],
        }),
      ),
      http.get('https://api.github.com/user/installations/7/repositories', () =>
        HttpResponse.json({
          total_count: 1,
          repositories: [
            {
              id: 1,
              full_name: 'acme/repo',
              name: 'repo',
              private: false,
              owner: { login: 'acme' },
              permissions: { pull: true, push: true },
            },
          ],
        }),
      ),
    );
    const repos = await new GitHubApi('test-token').getRepositories();
    expect(repos).toHaveLength(1);
    expect(repos[0]?.fullName).toBe('acme/repo');
  });

  it('loads issues with pagination and excludes pull requests', async () => {
    server.use(
      http.get('https://api.github.com/repos/acme/repo/issues', () =>
        HttpResponse.json([
          {
            number: 1,
            node_id: 'I_1',
            title: 'Issue',
            body: '',
            state: 'open',
            labels: [],
            assignees: [],
            html_url: 'https://github.com/acme/repo/issues/1',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          {
            number: 2,
            node_id: 'PR_2',
            title: 'PR',
            body: '',
            state: 'open',
            labels: [],
            assignees: [],
            pull_request: {},
            html_url: 'https://github.com/acme/repo/pull/2',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]),
      ),
    );
    const issues = await new GitHubApi('test-token').getIssues('acme/repo');
    expect(issues.map((issue) => issue.title)).toEqual(['Issue']);
  });

  it('creates, closes and reopens an issue', async () => {
    let state = 'open';
    server.use(
      http.get('https://api.github.com/repos/acme/repo/labels', () => HttpResponse.json([])),
      http.post('https://api.github.com/repos/acme/repo/issues', async ({ request }) => {
        const body = (await request.json()) as any;
        return HttpResponse.json({
          number: 3,
          node_id: 'I_3',
          title: body.title,
          body: body.body,
          state,
          labels: body.labels || [],
          assignees: [],
          html_url: 'https://github.com/acme/repo/issues/3',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        });
      }),
      http.patch('https://api.github.com/repos/acme/repo/issues/3', async ({ request }) => {
        const body = (await request.json()) as any;
        state = body.state || state;
        return HttpResponse.json({
          number: 3,
          node_id: 'I_3',
          title: 'New',
          body: '',
          state,
          labels: body.labels || [],
          assignees: [],
          html_url: 'https://github.com/acme/repo/issues/3',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        });
      }),
    );
    const api = new GitHubApi('test-token');
    const created = await api.createIssue('acme/repo', {
      title: 'New',
      body: '',
      labels: [],
      assignees: [],
    });
    expect(
      (await api.updateIssue('acme/repo', created.issueNumber, { state: 'closed' })).derivedStatus,
    ).toBe('done');
    expect(
      (await api.updateIssue('acme/repo', created.issueNumber, { state: 'open' })).derivedStatus,
    ).toBe('todo');
  });
});
