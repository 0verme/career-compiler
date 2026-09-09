import type {
  CareerEvidence,
  CareerSource,
  JsonObject,
  SourceRunContext
} from '@career-compiler/core';
import { createEvidenceId } from '@career-compiler/core';

export interface GitHubSourceOptions {
  token?: string;
  apiBaseUrl?: string;
  maxRepositories?: number;
  maxActivityItems?: number;
  fetchImpl?: typeof fetch;
}

export interface GitHubRequest {
  username?: string;
  repository?: string;
}

export interface GitHubTarget {
  owner: string;
  name: string;
}

export interface GitHubDiscovery {
  request: GitHubRequest;
  targets?: GitHubTarget[];
}

export interface GitHubRepositoryScan {
  owner: string;
  repository: Record<string, unknown>;
  languages: Record<string, unknown>;
  commits: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  pullRequests: Record<string, unknown>[];
}

export interface GitHubScanResult {
  profile?: Record<string, unknown>;
  repositories: GitHubRepositoryScan[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GitHub API returned an unexpected JSON object');
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub API returned an unexpected JSON array');
  }
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function jsonObject(entries: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (value === null) {
      result[key] = null;
    } else if (Array.isArray(value)) {
      const strings = value.filter((item): item is string => typeof item === 'string');
      result[key] = strings;
    } else if (typeof value === 'object') {
      const nested = jsonObject(value as Record<string, unknown>);
      result[key] = nested;
    }
  }
  return result;
}

function parseRepository(value: string): GitHubTarget {
  const normalized = value
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const [owner, name] = normalized.split('/');
  if (!owner || !name || normalized.split('/').length !== 2) {
    throw new Error(`Repository must be in owner/name form: ${value}`);
  }
  return { owner, name };
}

function isoOrUndefined(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined;
}

export class GitHubSource
  implements CareerSource<GitHubRequest, GitHubDiscovery, GitHubScanResult>
{
  readonly sourceType = 'github' as const;

  private readonly token?: string;
  private readonly apiBaseUrl: string;
  private readonly maxRepositories: number;
  private readonly maxActivityItems: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubSourceOptions = {}) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.maxRepositories = options.maxRepositories ?? 20;
    this.maxActivityItems = options.maxActivityItems ?? 10;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async discover(request: GitHubRequest, _context: SourceRunContext): Promise<GitHubDiscovery> {
    if (!request.username && !request.repository) {
      throw new Error('GitHub source requires username or repository');
    }
    if (request.repository) {
      return { request, targets: [parseRepository(request.repository)] };
    }
    return { request };
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'career-compiler/0.1'
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} ${response.statusText} for ${path}`);
    }
    return response.json();
  }

  private async scanRepository(target: GitHubTarget): Promise<GitHubRepositoryScan> {
    const repository = asRecord(await this.getJson(`/repos/${target.owner}/${target.name}`));
    const [languages, commits, issues, pullRequests] = await Promise.all([
      this.getJson(`/repos/${target.owner}/${target.name}/languages`),
      this.getJson(
        `/repos/${target.owner}/${target.name}/commits?per_page=${this.maxActivityItems}`
      ),
      this.getJson(
        `/repos/${target.owner}/${target.name}/issues?state=all&per_page=${this.maxActivityItems}`
      ),
      this.getJson(
        `/repos/${target.owner}/${target.name}/pulls?state=all&per_page=${this.maxActivityItems}`
      )
    ]);
    return {
      owner: target.owner,
      repository,
      languages: asRecord(languages),
      commits: asRecordArray(commits),
      issues: asRecordArray(issues),
      pullRequests: asRecordArray(pullRequests)
    };
  }

  async scan(discovery: GitHubDiscovery, _context: SourceRunContext): Promise<GitHubScanResult> {
    let profile: Record<string, unknown> | undefined;
    let targets = discovery.targets;
    if (!targets) {
      const username = discovery.request.username;
      if (!username) {
        throw new Error('GitHub discovery did not contain a username');
      }
      profile = asRecord(await this.getJson(`/users/${encodeURIComponent(username)}`));
      const repositories = asRecordArray(
        await this.getJson(
          `/users/${encodeURIComponent(username)}/repos?per_page=${this.maxRepositories}&sort=updated`
        )
      );
      targets = repositories
        .map((repository) => ({
          owner: stringValue(repository.owner && asRecord(repository.owner).login) ?? username,
          name: stringValue(repository.name)
        }))
        .filter((target): target is GitHubTarget => Boolean(target.name));
    }
    const repositories: GitHubRepositoryScan[] = [];
    for (const target of targets.slice(0, this.maxRepositories)) {
      repositories.push(await this.scanRepository(target));
    }
    return { profile, repositories };
  }

  async extractEvidence(
    scan: GitHubScanResult,
    context: SourceRunContext
  ): Promise<CareerEvidence[]> {
    const evidence: CareerEvidence[] = [];
    if (scan.profile) {
      const login = stringValue(scan.profile.login) ?? 'unknown-user';
      const sourceId = `profile:${login}`;
      evidence.push({
        id: createEvidenceId(this.sourceType, sourceId, 'profile'),
        sourceType: this.sourceType,
        sourceId,
        evidenceType: 'profile',
        raw: jsonObject({
          login,
          name: stringValue(scan.profile.name),
          bio: stringValue(scan.profile.bio),
          publicRepos: numberValue(scan.profile.public_repos),
          htmlUrl: stringValue(scan.profile.html_url)
        }),
        normalized: jsonObject({
          username: login,
          displayName: stringValue(scan.profile.name) ?? login,
          bio: stringValue(scan.profile.bio),
          publicRepositoryCount: numberValue(scan.profile.public_repos)
        }),
        sourceUri: stringValue(scan.profile.html_url),
        discoveredAt: context.now
      });
    }

    for (const repositoryScan of scan.repositories) {
      const repository = repositoryScan.repository;
      const owner = stringValue(repositoryScan.owner) ?? stringValue(repository.owner && asRecord(repository.owner).login) ?? 'unknown';
      const name = stringValue(repository.name) ?? 'unnamed-repository';
      const sourceId = `${owner}/${name}`;
      const topics = stringArray(repository.topics);
      const languages = Object.keys(repositoryScan.languages).sort();
      const description = stringValue(repository.description);
      const repositoryUrl = stringValue(repository.html_url);
      const defaultBranch = stringValue(repository.default_branch);
      evidence.push({
        id: createEvidenceId(this.sourceType, sourceId, 'repository'),
        sourceType: this.sourceType,
        sourceId,
        evidenceType: 'repository',
        raw: jsonObject({
          owner,
          name,
          description,
          htmlUrl: repositoryUrl,
          defaultBranch,
          topics,
          languages,
          fork: booleanValue(repository.fork),
          archived: booleanValue(repository.archived)
        }),
        normalized: jsonObject({
          canonicalName: name,
          name,
          description,
          repositoryUrl,
          topics,
          languages,
          defaultBranch
        }),
        sourceUri: repositoryUrl,
        observedAt: isoOrUndefined(repository.updated_at),
        discoveredAt: context.now
      });

      for (const commit of repositoryScan.commits) {
        const sha = stringValue(commit.sha);
        if (!sha) {
          continue;
        }
        const commitData = isRecord(commit.commit) ? commit.commit : undefined;
        const author = isRecord(commitData?.author) ? commitData.author : undefined;
        const message = stringValue(commitData?.message);
        const date = isoOrUndefined(author?.date);
        const commitId = `${sourceId}:${sha}`;
        evidence.push({
          id: createEvidenceId(this.sourceType, commitId, 'commit'),
          sourceType: this.sourceType,
          sourceId: commitId,
          evidenceType: 'commit',
          raw: jsonObject({
            sha,
            message,
            author: stringValue(author?.name),
            date,
            htmlUrl: stringValue(commit.html_url)
          }),
          normalized: jsonObject({
            repository: sourceId,
            sha,
            summary: message?.split('\n')[0],
            author: stringValue(author?.name)
          }),
          sourceUri: stringValue(commit.html_url),
          observedAt: date,
          discoveredAt: context.now
        });
      }

      for (const issue of repositoryScan.issues) {
        if (issue.pull_request) {
          continue;
        }
        const number = numberValue(issue.number);
        if (number === undefined) {
          continue;
        }
        const issueId = `${sourceId}:issue:${number}`;
        evidence.push({
          id: createEvidenceId(this.sourceType, issueId, 'issue'),
          sourceType: this.sourceType,
          sourceId: issueId,
          evidenceType: 'issue',
          raw: jsonObject({
            number,
            title: stringValue(issue.title),
            state: stringValue(issue.state),
            htmlUrl: stringValue(issue.html_url)
          }),
          normalized: jsonObject({
            repository: sourceId,
            number,
            title: stringValue(issue.title),
            state: stringValue(issue.state)
          }),
          sourceUri: stringValue(issue.html_url),
          observedAt: isoOrUndefined(issue.updated_at),
          discoveredAt: context.now
        });
      }

      for (const pullRequest of repositoryScan.pullRequests) {
        const number = numberValue(pullRequest.number);
        if (number === undefined) {
          continue;
        }
        const pullRequestId = `${sourceId}:pull-request:${number}`;
        evidence.push({
          id: createEvidenceId(this.sourceType, pullRequestId, 'pull-request'),
          sourceType: this.sourceType,
          sourceId: pullRequestId,
          evidenceType: 'pull-request',
          raw: jsonObject({
            number,
            title: stringValue(pullRequest.title),
            state: stringValue(pullRequest.state),
            merged: booleanValue(pullRequest.merged_at !== null),
            htmlUrl: stringValue(pullRequest.html_url)
          }),
          normalized: jsonObject({
            repository: sourceId,
            number,
            title: stringValue(pullRequest.title),
            state: stringValue(pullRequest.state),
            merged: pullRequest.merged_at !== null
          }),
          sourceUri: stringValue(pullRequest.html_url),
          observedAt: isoOrUndefined(pullRequest.updated_at),
          discoveredAt: context.now
        });
      }
    }
    return evidence;
  }
}
