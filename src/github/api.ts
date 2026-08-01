import { Octokit } from '@octokit/rest';
import { APP_CONFIG, SYSTEM_LABEL_DEFINITIONS } from '../config';
import {
  isPullRequest,
  labelsForStatus,
  normalizeIssue,
  type ApiIssue,
} from '../domain/github-mapping';
import type { GitHubIssue, GitHubUser, IssueLabel, Repository, TaskStatus } from '../domain/types';

const splitRepository = (fullName: string): [string, string] => {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) throw new Error(`Некорректный репозиторий: ${fullName}`);
  return [owner, repo];
};

export class GitHubApi {
  private readonly octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({
      auth: token,
      userAgent: `KitsuFlow/0.1`,
      request: {
        headers: {
          accept: APP_CONFIG.github.accept,
          'X-GitHub-Api-Version': APP_CONFIG.github.apiVersion,
        },
      },
    });
  }

  async getCurrentUser(): Promise<GitHubUser> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return { id: data.id, login: data.login, name: data.name, avatarUrl: data.avatar_url };
  }

  async getInstallations(): Promise<Array<{ id: number; account: string }>> {
    const { data } = await this.octokit.request('GET /user/installations', { per_page: 100 });
    return data.installations.map((installation: any) => ({
      id: installation.id,
      account: installation.account?.login || installation.account?.name || 'GitHub',
    }));
  }

  async getInstallationRepositories(installationId: number): Promise<Repository[]> {
    const response = await this.octokit.paginate(
      'GET /user/installations/{installation_id}/repositories',
      {
        installation_id: installationId,
        per_page: 100,
      },
    );
    return response.map((repo: any) => ({
      id: repo.id,
      installationId,
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      permissions: { pull: Boolean(repo.permissions?.pull), push: Boolean(repo.permissions?.push) },
      pinned: false,
      updatedAt: new Date().toISOString(),
    }));
  }

  async getRepositories(): Promise<Repository[]> {
    const installations = await this.getInstallations();
    const groups = await Promise.all(
      installations.map((installation) => this.getInstallationRepositories(installation.id)),
    );
    return groups.flat();
  }

  async getIssues(repositoryFullName: string): Promise<GitHubIssue[]> {
    const [owner, repo] = splitRepository(repositoryFullName);
    const response = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    return response
      .filter((issue) => !isPullRequest(issue as ApiIssue))
      .map((issue) => normalizeIssue(repositoryFullName, issue as ApiIssue));
  }

  async getLabels(repositoryFullName: string): Promise<IssueLabel[]> {
    const [owner, repo] = splitRepository(repositoryFullName);
    const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
      owner,
      repo,
      per_page: 100,
    });
    return labels.map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description,
    }));
  }

  async getAssignees(repositoryFullName: string): Promise<string[]> {
    const [owner, repo] = splitRepository(repositoryFullName);
    const users = await this.octokit.paginate(this.octokit.rest.issues.listAssignees, {
      owner,
      repo,
      per_page: 100,
    });
    return users.map((user) => user.login);
  }

  async ensureSystemLabels(repositoryFullName: string, names: string[]): Promise<void> {
    const required = names.filter((name) => name in SYSTEM_LABEL_DEFINITIONS);
    if (!required.length) return;
    const existing = new Set((await this.getLabels(repositoryFullName)).map((label) => label.name));
    const [owner, repo] = splitRepository(repositoryFullName);
    for (const name of required) {
      if (existing.has(name)) continue;
      const definition = SYSTEM_LABEL_DEFINITIONS[name];
      if (!definition) continue;
      try {
        await this.octokit.rest.issues.createLabel({ owner, repo, name, ...definition });
      } catch (error: any) {
        if (error?.status !== 422) throw error;
      }
    }
  }

  async createIssue(
    repositoryFullName: string,
    input: { title: string; body: string; labels: string[]; assignees: string[] },
  ): Promise<GitHubIssue> {
    await this.ensureSystemLabels(repositoryFullName, input.labels);
    const [owner, repo] = splitRepository(repositoryFullName);
    const { data } = await this.octokit.rest.issues.create({ owner, repo, ...input });
    return normalizeIssue(repositoryFullName, data as ApiIssue);
  }

  async updateIssue(
    repositoryFullName: string,
    issueNumber: number,
    input: {
      title?: string | undefined;
      body?: string | undefined;
      labels?: string[] | undefined;
      assignees?: string[] | undefined;
      state?: 'open' | 'closed' | undefined;
    },
  ): Promise<GitHubIssue> {
    if (input.labels) await this.ensureSystemLabels(repositoryFullName, input.labels);
    const [owner, repo] = splitRepository(repositoryFullName);
    const parameters: any = {
      owner,
      repo,
      issue_number: issueNumber,
    };
    if (input.title !== undefined) parameters.title = input.title;
    if (input.body !== undefined) parameters.body = input.body;
    if (input.labels !== undefined) parameters.labels = input.labels;
    if (input.assignees !== undefined) parameters.assignees = input.assignees;
    if (input.state !== undefined) parameters.state = input.state;
    const { data } = await this.octokit.rest.issues.update(parameters);
    return normalizeIssue(repositoryFullName, data as ApiIssue);
  }

  async setStatus(
    issue: GitHubIssue,
    status: Exclude<TaskStatus, 'question'>,
  ): Promise<GitHubIssue> {
    const labels = labelsForStatus(
      issue.labels.map((label) => label.name),
      status,
    );
    return this.updateIssue(issue.repositoryFullName, issue.issueNumber, {
      labels,
      state: status === 'done' ? 'closed' : 'open',
    });
  }
}
