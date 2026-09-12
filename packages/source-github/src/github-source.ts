import type {
  CareerEvidence,
  CareerSource,
  EvidenceAttribution,
  JsonObject,
  SourceIdentity,
  SourceRunContext
} from '@career-compiler/core';
import { createEvidenceId } from '@career-compiler/core';

export interface GitHubSourceOptions {
  token?: string;
  apiBaseUrl?: string;
  maxRepositories?: number;
  maxActivityItems?: number;
  maxExternalContributions?: number;
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
  identity?: SourceIdentity;
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
  identity?: SourceIdentity;
  profile?: Record<string, unknown>;
  repositories: GitHubRepositoryScan[];
  externalPullRequests: Record<string, unknown>[];
  warnings?: string[];
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly rateLimit: boolean;

  constructor(status: number, path: string, message: string, rateLimit: boolean) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.path = path;
    this.rateLimit = rateLimit;
  }
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

function parseRepositoryFromUrl(value: unknown): string | undefined {
  const candidate = stringValue(value);
  if (!candidate) {
    return undefined;
  }
  const match = candidate.match(/\/repos\/([^/]+\/[^/]+)(?:$|\/)/) ??
    candidate.match(/github\.com\/([^/]+\/[^/#?]+)(?:$|[?#/])/);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return `${parseRepository(match[1]).owner}/${parseRepository(match[1]).name}`;
  } catch {
    return undefined;
  }
}

function isoOrUndefined(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined;
}

function loginFromUser(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value.login) : undefined;
}

function githubIdentityLogin(identity: SourceIdentity | undefined): string | undefined {
  if (!identity || identity.provider !== 'github') {
    return undefined;
  }
  return identity.username ?? identity.externalId;
}

function sameLogin(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function attributionForActor(
  actorLogin: string | undefined,
  identity: SourceIdentity | undefined
): EvidenceAttribution {
  const identityLogin = githubIdentityLogin(identity);
  if (!identityLogin || !actorLogin) {
    return 'unknown';
  }
  return sameLogin(actorLogin, identityLogin) ? 'authored' : 'context';
}

function attributionForRepository(
  owner: string,
  fork: boolean,
  identity: SourceIdentity | undefined
): EvidenceAttribution {
  const identityLogin = githubIdentityLogin(identity);
  if (!identityLogin) {
    return 'unknown';
  }
  if (!sameLogin(owner, identityLogin)) {
    return 'context';
  }
  return fork ? 'context' : 'owned';
}

function sourceIdentity(username: string | undefined, configured: SourceIdentity | undefined): SourceIdentity | undefined {
  if (!username && !configured) {
    return undefined;
  }
  if (!username) {
    return configured;
  }
  return {
    ...(configured ?? { provider: 'github', externalId: username }),
    provider: 'github',
    externalId: username,
    username
  };
}

function ownerFromRepositoryId(repositoryId: string): string | undefined {
  const [owner] = repositoryId.split('/');
  return owner || undefined;
}

function repositoryIdFromSearchItem(item: Record<string, unknown>): string | undefined {
  const repository = isRecord(item.repository) ? stringValue(item.repository.full_name) : undefined;
  return repository ?? parseRepositoryFromUrl(item.repository_url) ??
    (isRecord(item.pull_request) ? parseRepositoryFromUrl(item.pull_request.url) : undefined);
}

function pullRequestEvidence(
  pullRequest: Record<string, unknown>,
  repositoryId: string,
  identity: SourceIdentity | undefined,
  fork: boolean,
  discoveredAt: string
): CareerEvidence | undefined {
  const number = numberValue(pullRequest.number);
  if (number === undefined) {
    return undefined;
  }
  const owner = ownerFromRepositoryId(repositoryId);
  const authorLogin = loginFromUser(pullRequest.user);
  const attribution = attributionForActor(authorLogin, identity);
  const mergedAt = isoOrUndefined(pullRequest.merged_at) ??
    (isRecord(pullRequest.pull_request) ? isoOrUndefined(pullRequest.pull_request.merged_at) : undefined);
  const sourceUri = stringValue(pullRequest.html_url) ??
    (isRecord(pullRequest.pull_request) ? stringValue(pullRequest.pull_request.html_url) : undefined);
  const pullRequestId = `${repositoryId}:pull-request:${number}`;
  const externalContribution = attribution === 'authored' && !sameLogin(owner, githubIdentityLogin(identity));
  const createdAt = isoOrUndefined(pullRequest.created_at);
  const updatedAt = isoOrUndefined(pullRequest.updated_at);
  return {
    id: createEvidenceId('github', pullRequestId, 'pull-request'),
    sourceType: 'github',
    sourceId: pullRequestId,
    evidenceType: 'pull-request',
    attribution,
    externalContribution,
    raw: jsonObject({
      repository: repositoryId,
      number,
      title: stringValue(pullRequest.title),
      state: stringValue(pullRequest.state),
      merged: mergedAt !== undefined,
      mergedAt,
      authorLogin,
      createdAt,
      updatedAt,
      fork,
      htmlUrl: sourceUri
    }),
    normalized: jsonObject({
      repository: repositoryId,
      number,
      title: stringValue(pullRequest.title),
      state: stringValue(pullRequest.state),
      merged: mergedAt !== undefined,
      mergedAt,
      authorLogin,
      createdAt,
      updatedAt,
      fork,
      attribution,
      externalContribution,
      repositoryUrl: sourceUri ? `https://github.com/${repositoryId}` : undefined
    }),
    sourceUri,
    observedAt: updatedAt ?? mergedAt ?? createdAt,
    discoveredAt
  };
}

export class GitHubSource
  implements CareerSource<GitHubRequest, GitHubDiscovery, GitHubScanResult>
{
  readonly sourceType = 'github' as const;

  private readonly token?: string;
  private readonly apiBaseUrl: string;
  private readonly maxRepositories: number;
  private readonly maxActivityItems: number;
  private readonly maxExternalContributions: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubSourceOptions = {}) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.maxRepositories = Math.max(1, Math.floor(options.maxRepositories ?? 20));
    this.maxActivityItems = Math.min(100, Math.max(1, Math.floor(options.maxActivityItems ?? 10)));
    this.maxExternalContributions = Math.min(1000, Math.max(0, Math.floor(options.maxExternalContributions ?? 20)));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async discover(request: GitHubRequest, context: SourceRunContext): Promise<GitHubDiscovery> {
    if (!request.username && !request.repository) {
      throw new Error('GitHub source requires username or repository');
    }
    const configuredIdentity = context.identity?.sources.find((item) => item.provider === 'github');
    const identity = sourceIdentity(request.username, configuredIdentity);
    if (request.repository) {
      return { request, targets: [parseRepository(request.repository)], identity };
    }
    return { request, identity };
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
      const body = await response.text();
      let message: string | undefined;
      try {
        const parsed = JSON.parse(body) as unknown;
        message = isRecord(parsed) ? stringValue(parsed.message) : undefined;
      } catch {
        message = undefined;
      }
      const rateLimit = response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') ||
        /rate limit/i.test(message ?? body);
      if (rateLimit) {
        throw new GitHubApiError(
          response.status,
          path,
          `GitHub API rate limit exceeded for ${path}. Use a GitHub token, reduce scan limits, or retry later.`,
          true
        );
      }
      throw new GitHubApiError(
        response.status,
        path,
        `GitHub API ${response.status} ${response.statusText} for ${path}${message ? `: ${message}` : ''}`,
        false
      );
    }
    const body = await response.text();
    if (body.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error(
        `GitHub API returned invalid JSON for ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async listUserRepositories(username: string): Promise<Record<string, unknown>[]> {
    const pageSize = Math.min(this.maxRepositories, 100);
    const repositories: Record<string, unknown>[] = [];
    let page = 1;
    while (repositories.length < this.maxRepositories) {
      const suffix = page === 1 ? '' : `&page=${page}`;
      const payload = await this.getJson(
        `/users/${encodeURIComponent(username)}/repos?per_page=${pageSize}&sort=updated${suffix}`
      );
      const current = asRecordArray(payload);
      repositories.push(...current);
      if (current.length < pageSize) {
        break;
      }
      page += 1;
    }
    return repositories.slice(0, this.maxRepositories);
  }

  private async searchExternalPullRequests(username: string): Promise<Record<string, unknown>[]> {
    if (this.maxExternalContributions === 0) {
      return [];
    }
    const pageSize = Math.min(this.maxExternalContributions, 100);
    const pullRequests: Record<string, unknown>[] = [];
    let page = 1;
    while (pullRequests.length < this.maxExternalContributions) {
      const query = new URLSearchParams({
        q: `author:${username} type:pr`,
        per_page: String(pageSize),
        page: String(page)
      });
      const payload = asRecord(await this.getJson(`/search/issues?${query.toString()}`));
      const current = asRecordArray(payload.items);
      pullRequests.push(...current);
      if (current.length < pageSize) {
        break;
      }
      page += 1;
    }
    return pullRequests.slice(0, this.maxExternalContributions);
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
    let identity = discovery.identity;
    let targets = discovery.targets;
    const warnings: string[] = [];
    if (!targets) {
      const username = identity?.username ?? discovery.request.username;
      if (!username) {
        throw new Error('GitHub discovery did not contain a username or GitHub identity');
      }
      profile = asRecord(await this.getJson(`/users/${encodeURIComponent(username)}`));
      const profileLogin = stringValue(profile.login);
      identity = sourceIdentity(profileLogin ?? username, identity);
      const repositories = await this.listUserRepositories(profileLogin ?? username);
      targets = repositories
        .map((repository) => ({
          owner: stringValue(repository.owner && asRecord(repository.owner).login) ?? profileLogin ?? username,
          name: stringValue(repository.name)
        }))
        .filter((target): target is GitHubTarget => Boolean(target.name));
    }
    const repositories: GitHubRepositoryScan[] = [];
    for (const target of targets.slice(0, this.maxRepositories)) {
      repositories.push(await this.scanRepository(target));
    }

    let externalPullRequests: Record<string, unknown>[] = [];
    if (identity?.username && !discovery.request.repository) {
      try {
        externalPullRequests = await this.searchExternalPullRequests(identity.username);
      } catch (error) {
        if (error instanceof GitHubApiError && error.rateLimit) {
          warnings.push(error.message);
        } else {
          throw error;
        }
      }
    }
    return {
      ...(identity ? { identity } : {}),
      ...(profile ? { profile } : {}),
      repositories,
      externalPullRequests,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  async extractEvidence(
    scan: GitHubScanResult,
    context: SourceRunContext
  ): Promise<CareerEvidence[]> {
    const evidenceById = new Map<string, CareerEvidence>();
    const addEvidence = (item: CareerEvidence): void => {
      if (!evidenceById.has(item.id)) {
        evidenceById.set(item.id, item);
      }
    };
    const identity = scan.identity ?? context.identity?.sources.find((item) => item.provider === 'github');
    const identityLogin = githubIdentityLogin(identity);

    if (scan.profile) {
      const login = stringValue(scan.profile.login) ?? identityLogin ?? 'unknown-user';
      const sourceId = `profile:${login}`;
      const attribution: EvidenceAttribution = sameLogin(login, identityLogin) ? 'owned' : 'context';
      addEvidence({
        id: createEvidenceId(this.sourceType, sourceId, 'profile'),
        sourceType: this.sourceType,
        sourceId,
        evidenceType: 'profile',
        attribution,
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
          publicRepositoryCount: numberValue(scan.profile.public_repos),
          attribution
        }),
        sourceUri: stringValue(scan.profile.html_url),
        discoveredAt: context.now
      });
    }

    for (const repositoryScan of scan.repositories) {
      const repository = repositoryScan.repository;
      const owner = stringValue(repositoryScan.owner) ??
        stringValue(repository.owner && asRecord(repository.owner).login) ??
        'unknown';
      const name = stringValue(repository.name) ?? 'unnamed-repository';
      const sourceId = `${owner}/${name}`;
      const topics = stringArray(repository.topics);
      const languages = Object.keys(repositoryScan.languages).sort((left, right) => left.localeCompare(right));
      const description = stringValue(repository.description);
      const repositoryUrl = stringValue(repository.html_url);
      const defaultBranch = stringValue(repository.default_branch);
      const fork = booleanValue(repository.fork) ?? false;
      const attribution = attributionForRepository(owner, fork, identity);
      addEvidence({
        id: createEvidenceId(this.sourceType, sourceId, 'repository'),
        sourceType: this.sourceType,
        sourceId,
        evidenceType: 'repository',
        attribution,
        raw: jsonObject({
          owner,
          name,
          description,
          htmlUrl: repositoryUrl,
          defaultBranch,
          topics,
          languages,
          fork,
          archived: booleanValue(repository.archived),
          attribution
        }),
        normalized: jsonObject({
          canonicalName: name,
          name,
          owner,
          ownerLogin: owner,
          description,
          repositoryUrl,
          defaultBranch,
          topics,
          languages,
          fork,
          attribution
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
        const commitAuthor = isRecord(commitData?.author) ? commitData.author : undefined;
        const authorLogin = loginFromUser(commit.author);
        const message = stringValue(commitData?.message);
        const date = isoOrUndefined(commitAuthor?.date);
        const attribution = attributionForActor(authorLogin, identity);
        const externalContribution = attribution === 'authored' && !sameLogin(owner, identityLogin);
        const commitId = `${sourceId}:${sha}`;
        addEvidence({
          id: createEvidenceId(this.sourceType, commitId, 'commit'),
          sourceType: this.sourceType,
          sourceId: commitId,
          evidenceType: 'commit',
          attribution,
          externalContribution,
          raw: jsonObject({
            repository: sourceId,
            sha,
            message,
            author: stringValue(commitAuthor?.name),
            authorLogin,
            authorAssociation: stringValue(commit.author_association),
            date,
            htmlUrl: stringValue(commit.html_url)
          }),
          normalized: jsonObject({
            repository: sourceId,
            sha,
            summary: message?.split('\n')[0],
            author: stringValue(commitAuthor?.name),
            authorLogin,
            authorAssociation: stringValue(commit.author_association),
            attribution,
            externalContribution
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
        const authorLogin = loginFromUser(issue.user);
        const attribution = attributionForActor(authorLogin, identity);
        const externalContribution = attribution === 'authored' && !sameLogin(owner, identityLogin);
        const issueId = `${sourceId}:issue:${number}`;
        addEvidence({
          id: createEvidenceId(this.sourceType, issueId, 'issue'),
          sourceType: this.sourceType,
          sourceId: issueId,
          evidenceType: 'issue',
          attribution,
          externalContribution,
          raw: jsonObject({
            repository: sourceId,
            number,
            title: stringValue(issue.title),
            state: stringValue(issue.state),
            authorLogin,
            authorAssociation: stringValue(issue.author_association),
            createdAt: isoOrUndefined(issue.created_at),
            updatedAt: isoOrUndefined(issue.updated_at),
            htmlUrl: stringValue(issue.html_url)
          }),
          normalized: jsonObject({
            repository: sourceId,
            number,
            title: stringValue(issue.title),
            state: stringValue(issue.state),
            authorLogin,
            authorAssociation: stringValue(issue.author_association),
            createdAt: isoOrUndefined(issue.created_at),
            updatedAt: isoOrUndefined(issue.updated_at),
            attribution,
            externalContribution
          }),
          sourceUri: stringValue(issue.html_url),
          observedAt: isoOrUndefined(issue.updated_at),
          discoveredAt: context.now
        });
      }

      for (const pullRequest of repositoryScan.pullRequests) {
        const item = pullRequestEvidence(
          pullRequest,
          sourceId,
          identity,
          fork,
          context.now
        );
        if (item) {
          addEvidence(item);
        }
      }
    }

    for (const pullRequest of scan.externalPullRequests) {
      const repositoryId = repositoryIdFromSearchItem(pullRequest);
      if (!repositoryId) {
        continue;
      }
      const item = pullRequestEvidence(
        pullRequest,
        repositoryId,
        identity,
        false,
        context.now
      );
      if (item) {
        addEvidence(item);
      }
    }
    return [...evidenceById.values()];
  }
}
