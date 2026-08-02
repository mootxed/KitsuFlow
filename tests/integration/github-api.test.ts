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
    const result = await new GitHubApi('test-token').getRepositories();
    expect(result.failedInstallations).toEqual([]);
    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]?.fullName).toBe('acme/repo');
  });

  it('paginates installations and isolates a failed installation', async () => {
    server.use(
      http.get('https://api.github.com/user/installations', ({ request }) => {
        const page = new URL(request.url).searchParams.get('page');
        if (page === '2') {
          return HttpResponse.json({
            total_count: 2,
            installations: [{ id: 8, account: { login: 'broken' } }],
          });
        }
        return HttpResponse.json(
          {
            total_count: 2,
            installations: [{ id: 7, account: { login: 'acme' } }],
          },
          { headers: { Link: '<https://api.github.com/user/installations?page=2>; rel="next"' } },
        );
      }),
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
      http.get('https://api.github.com/user/installations/8/repositories', () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );

    const result = await new GitHubApi('test-token').getRepositories();
    expect(result.installationCount).toBe(2);
    expect(result.repositories.map((repository) => repository.fullName)).toEqual(['acme/repo']);
    expect(result.failedInstallations).toMatchObject([{ installationId: 8, account: 'broken' }]);
  });

  it('throws globally when any installation returns 401 (getRepositories)', async () => {
    server.use(
      http.get('https://api.github.com/user/installations', () =>
        HttpResponse.json({
          total_count: 1,
          installations: [{ id: 9, account: { login: 'secured' } }],
        }),
      ),
      http.get('https://api.github.com/user/installations/9/repositories', () =>
        HttpResponse.json({ message: 'Requires authentication' }, { status: 401 }),
      ),
    );
    await expect(new GitHubApi('bad-token').getRepositories()).rejects.toMatchObject({
      status: 401,
    });
  });

  it('isolates 404 installation into failedInstallations (getRepositories)', async () => {
    server.use(
      http.get('https://api.github.com/user/installations', () =>
        HttpResponse.json({
          total_count: 2,
          installations: [
            { id: 10, account: { login: 'ok' } },
            { id: 11, account: { login: 'missing' } },
          ],
        }),
      ),
      http.get('https://api.github.com/user/installations/10/repositories', () =>
        HttpResponse.json({
          total_count: 1,
          repositories: [
            {
              id: 2,
              full_name: 'ok/repo',
              name: 'repo',
              private: false,
              owner: { login: 'ok' },
              permissions: { pull: true, push: true },
            },
          ],
        }),
      ),
      http.get('https://api.github.com/user/installations/11/repositories', () =>
        HttpResponse.json({ message: 'Not Found' }, { status: 404 }),
      ),
    );
    const result = await new GitHubApi('test-token').getRepositories();
    expect(result.repositories).toHaveLength(1);
    expect(result.failedInstallations).toMatchObject([{ installationId: 11, account: 'missing' }]);
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
