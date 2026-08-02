import { Octokit } from '@octokit/rest';
import { APP_CONFIG, SYSTEM_LABEL_DEFINITIONS } from '../config';
import {
  isPullRequest,
  labelsForStatus,
  normalizeIssue,
  type ApiIssue,
} from '../domain/github-mapping';
import type { GitHubIssue, GitHubUser, IssueLabel, Repository, TaskStatus } from '../domain/types';
import { parseGitHubError } from './errors';

interface InstallationRecord {
  id: number;
  account?: { login?: string | undefined; name?: string | undefined } | null | undefined;
}

export interface InstallationRepositoryFailure {
  installationId: number;
  account: string;
  error: unknown;
}

export interface RepositoryLoadResult {
  repositories: Repository[];
  failedInstallations: InstallationRepositoryFailure[];
  installationCount: number;
}

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
    const installations = await this.octokit.paginate('GET /user/installations', {
      per_page: 100,
    });
    return (installations as InstallationRecord[]).map((installation) => ({
      id: installation.id,
      account: installation.account?.login || installation.account?.name || 'GitHub',
    }));
  }

  async getInstallationRepositories(
    installationId: number,
    signal?: AbortSignal,
  ): Promise<Repository[]> {
    const response = await this.octokit.paginate(
      'GET /user/installations/{installation_id}/repositories',
      {
        installation_id: installationId,
        per_page: 100,
        ...(signal ? { request: { signal } } : {}),
      },
    );
    return response.map((repo) => ({
      id: repo.id,
      installationId,
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      permissions: { pull: Boolean(repo.permissions?.pull), push: Boolean(repo.permissions?.push) },
      pinned: false,
      updatedAt: new Date().toISOString(),
      accountId: '',
    }));
  }

  async getRepositories(): Promise<RepositoryLoadResult> {
    const installations = await this.getInstallations();
    const groups = await Promise.allSettled(
      installations.map((installation) => this.getInstallationRepositories(installation.id)),
    );
    const repositories: Repository[] = [];
    const failedInstallations: InstallationRepositoryFailure[] = [];
    groups.forEach((result, index) => {
      const installation = installations[index];
      if (!installation) return;
      if (result.status === 'fulfilled') {
        repositories.push(...result.value);
      } else {
        const parsed = parseGitHubError(result.reason);
        // 401 и глобальный rate-limit — критические ошибки, пробрасываем наверх
        if (parsed.kind === 'unauthorized' || parsed.kind === 'rate-limit') {
          throw result.reason;
        }
        // Локальные ошибки (403, 404, сеть) остаются в failedInstallations
        failedInstallations.push({
          installationId: installation.id,
          account: installation.account,
          error: result.reason,
        });
      }
    });
    return { repositories, failedInstallations, installationCount: installations.length };
  }

  async getIssues(repositoryFullName: string, signal?: AbortSignal): Promise<GitHubIssue[]> {
    const [owner, repo] = splitRepository(repositoryFullName);
    const response = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
      ...(signal ? { request: { signal } } : {}),
    });
    return response
      .filter((issue) => !isPullRequest(issue as ApiIssue))
      .map((issue) => normalizeIssue(repositoryFullName, issue as ApiIssue));
  }

  async getLabels(repositoryFullName: string, signal?: AbortSignal): Promise<IssueLabel[]> {
    const [owner, repo] = splitRepository(repositoryFullName);
    const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
      owner,
      repo,
      per_page: 100,
      ...(signal ? { request: { signal } } : {}),
    });
    return labels.map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description,
    }));
  }

  async getAssignees(repositoryFullName: string, signal?: AbortSignal): Promise<string[]> {
    const [owner, repo] = splitRepository(repositoryFullName);
    const users = await this.octokit.paginate(this.octokit.rest.issues.listAssignees, {
      owner,
      repo,
      per_page: 100,
      ...(signal ? { request: { signal } } : {}),
    });
    return users.map((user) => user.login);
  }

  async ensureSystemLabels(
    repositoryFullName: string,
    names: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const required = names.filter((name) => name in SYSTEM_LABEL_DEFINITIONS);
    if (!required.length) return;
    const existing = new Set(
      (await this.getLabels(repositoryFullName, signal)).map((label) => label.name),
    );
    const [owner, repo] = splitRepository(repositoryFullName);
    for (const name of required) {
      if (existing.has(name)) continue;
      const definition = SYSTEM_LABEL_DEFINITIONS[name];
      if (!definition) continue;
      try {
        await this.octokit.rest.issues.createLabel({
          owner,
          repo,
          name,
          ...definition,
          ...(signal ? { request: { signal } } : {}),
        });
      } catch (error: unknown) {
        if ((error as { status?: number }).status !== 422) throw error;
      }
    }
  }

  async createIssue(
    repositoryFullName: string,
    input: { title: string; body: string; labels: string[]; assignees: string[] },
    signal?: AbortSignal,
  ): Promise<GitHubIssue> {
    await this.ensureSystemLabels(repositoryFullName, input.labels, signal);
    const [owner, repo] = splitRepository(repositoryFullName);
    const { data } = await this.octokit.rest.issues.create({
      owner,
      repo,
      ...input,
      ...(signal ? { request: { signal } } : {}),
    });
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
    signal?: AbortSignal,
  ): Promise<GitHubIssue> {
    if (input.labels) await this.ensureSystemLabels(repositoryFullName, input.labels, signal);
    const [owner, repo] = splitRepository(repositoryFullName);
    const parameters: Parameters<typeof this.octokit.rest.issues.update>[0] = {
      owner,
      repo,
      issue_number: issueNumber,
    };
    if (input.title !== undefined) parameters.title = input.title;
    if (input.body !== undefined) parameters.body = input.body;
    if (input.labels !== undefined) parameters.labels = input.labels;
    if (input.assignees !== undefined) parameters.assignees = input.assignees;
    if (input.state !== undefined) parameters.state = input.state;
    if (signal) parameters.request = { signal };
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
