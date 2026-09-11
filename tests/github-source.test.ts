import { describe, expect, it } from 'vitest';
import { GitHubSource } from '@career-compiler/source-github';

function requestPath(input: RequestInfo | URL): string {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  return `${url.pathname}${url.search}`;
}

function jsonResponse(payload: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

describe('GitHub source', () => {
  it('normalizes profile, repository, commit, issue, and pull request metadata', async () => {
    const responses = new Map<string, unknown>([
      ['/users/alice', { login: 'alice', name: 'Alice Example', bio: 'Data platform builder', public_repos: 1, html_url: 'https://github.com/alice' }],
      ['/users/alice/repos?per_page=20&sort=updated', [
        {
          owner: { login: 'alice' },
          name: 'data-lineage-toolkit'
        }
      ]],
      ['/repos/alice/data-lineage-toolkit', {
        owner: { login: 'alice' },
        name: 'data-lineage-toolkit',
        description: 'Open lineage platform.',
        html_url: 'https://github.com/alice/data-lineage-toolkit',
        default_branch: 'main',
        topics: ['data-lineage'],
        fork: false,
        archived: false,
        updated_at: '2025-01-14T12:00:00.000Z'
      }],
      ['/repos/alice/data-lineage-toolkit/languages', { TypeScript: 1000, Python: 500 }],
      ['/repos/alice/data-lineage-toolkit/commits?per_page=10', [
        {
          sha: 'abc123',
          author: { login: 'alice' },
          author_association: 'OWNER',
          html_url: 'https://github.com/alice/data-lineage-toolkit/commit/abc123',
          commit: {
            message: 'Document lineage boundaries',
            author: { name: 'Alice Example', date: '2025-01-13T09:00:00.000Z' }
          }
        }
      ]],
      ['/repos/alice/data-lineage-toolkit/issues?state=all&per_page=10', [
        {
          number: 18,
          title: 'Define ownership metadata',
          state: 'closed',
          user: { login: 'alice' },
          html_url: 'https://github.com/alice/data-lineage-toolkit/issues/18',
          updated_at: '2025-01-12T09:00:00.000Z'
        }
      ]],
      ['/repos/alice/data-lineage-toolkit/pulls?state=all&per_page=10', [
        {
          number: 27,
          title: 'Add ownership graph',
          state: 'closed',
          user: { login: 'alice' },
          merged_at: '2025-01-14T10:00:00.000Z',
          created_at: '2025-01-10T10:00:00.000Z',
          updated_at: '2025-01-14T10:00:00.000Z',
          html_url: 'https://github.com/alice/data-lineage-toolkit/pull/27'
        }
      ]]
    ]);
    const source = new GitHubSource({
      apiBaseUrl: 'https://api.github.test',
      maxExternalContributions: 0,
      fetchImpl: async (input) => {
        const path = requestPath(input);
        const payload = responses.get(path);
        return jsonResponse(payload ?? { message: 'not found' }, payload === undefined ? 404 : 200);
      }
    });
    const context = { now: '2025-01-15T00:00:00.000Z' };
    const discovery = await source.discover({ username: 'alice' }, context);
    const scan = await source.scan(discovery, context);
    const evidence = await source.extractEvidence(scan, context);

    expect(evidence.map((item) => item.evidenceType)).toEqual([
      'profile',
      'repository',
      'commit',
      'issue',
      'pull-request'
    ]);
    expect(evidence[1]?.normalized).toMatchObject({
      name: 'data-lineage-toolkit',
      topics: ['data-lineage'],
      languages: ['Python', 'TypeScript'],
      attribution: 'owned',
      fork: false
    });
    expect(evidence.find((item) => item.evidenceType === 'commit')?.attribution).toBe('authored');
    expect(evidence.find((item) => item.evidenceType === 'pull-request')?.normalized).toMatchObject({
      authorLogin: 'alice',
      merged: true,
      mergedAt: '2025-01-14T10:00:00.000Z'
    });
  });

  it('attributes owned, fork, context, and external pull request activity precisely', async () => {
    const requests: string[] = [];
    const source = new GitHubSource({
      apiBaseUrl: 'https://api.github.test',
      maxRepositories: 2,
      maxActivityItems: 10,
      maxExternalContributions: 2,
      fetchImpl: async (input) => {
        const path = requestPath(input);
        requests.push(path);
        if (path === '/users/alice') {
          return jsonResponse({ login: 'alice', name: 'Alice Example', html_url: 'https://github.com/alice' });
        }
        if (path === '/users/alice/repos?per_page=2&sort=updated') {
          return jsonResponse([
            { owner: { login: 'alice' }, name: 'owned-project' },
            { owner: { login: 'alice' }, name: 'forked-project' }
          ]);
        }
        if (path === '/repos/alice/owned-project') {
          return jsonResponse({
            owner: { login: 'alice' },
            name: 'owned-project',
            html_url: 'https://github.com/alice/owned-project',
            fork: false,
            topics: [],
            updated_at: '2025-01-14T12:00:00.000Z'
          });
        }
        if (path === '/repos/alice/forked-project') {
          return jsonResponse({
            owner: { login: 'alice' },
            name: 'forked-project',
            html_url: 'https://github.com/alice/forked-project',
            fork: true,
            topics: [],
            updated_at: '2025-01-14T12:00:00.000Z'
          });
        }
        if (path.endsWith('/languages')) {
          return jsonResponse({ TypeScript: 1 });
        }
        if (path === '/repos/alice/owned-project/commits?per_page=10') {
          return jsonResponse([
            { sha: 'mine', author: { login: 'alice' }, commit: { author: { name: 'Alice', date: '2025-01-01T00:00:00.000Z' }, message: 'Mine' } },
            { sha: 'other', author: { login: 'other' }, commit: { author: { name: 'Other', date: '2025-01-02T00:00:00.000Z' }, message: 'Other' } },
            { sha: 'unknown', commit: { author: { name: 'Unknown', date: '2025-01-03T00:00:00.000Z' }, message: 'Unknown author' } }
          ]);
        }
        if (path === '/repos/alice/forked-project/commits?per_page=10') {
          return jsonResponse([
            { sha: 'fork-mine', author: { login: 'alice' }, commit: { author: { name: 'Alice', date: '2025-01-03T00:00:00.000Z' }, message: 'Fork contribution' } },
            { sha: 'fork-other', author: { login: 'other' }, commit: { author: { name: 'Other', date: '2025-01-04T00:00:00.000Z' }, message: 'Original author' } }
          ]);
        }
        if (path === '/repos/alice/owned-project/issues?state=all&per_page=10') {
          return jsonResponse([
            { number: 1, title: 'Mine issue', state: 'open', user: { login: 'alice' }, html_url: 'https://github.com/alice/owned-project/issues/1', updated_at: '2025-01-05T00:00:00.000Z' },
            { number: 2, title: 'Context issue', state: 'open', user: { login: 'other' }, html_url: 'https://github.com/alice/owned-project/issues/2', updated_at: '2025-01-06T00:00:00.000Z' }
          ]);
        }
        if (path === '/repos/alice/forked-project/issues?state=all&per_page=10') {
          return jsonResponse([
            { number: 3, title: 'Fork issue', state: 'closed', user: { login: 'alice' }, html_url: 'https://github.com/alice/forked-project/issues/3', updated_at: '2025-01-07T00:00:00.000Z' }
          ]);
        }
        if (path === '/repos/alice/owned-project/pulls?state=all&per_page=10') {
          return jsonResponse([
            { number: 4, title: 'Mine PR', state: 'closed', user: { login: 'alice' }, merged_at: '2025-01-08T00:00:00.000Z', created_at: '2025-01-07T00:00:00.000Z', updated_at: '2025-01-08T00:00:00.000Z', html_url: 'https://github.com/alice/owned-project/pull/4' },
            { number: 5, title: 'Context PR', state: 'closed', user: { login: 'other' }, merged_at: null, created_at: '2025-01-07T00:00:00.000Z', updated_at: '2025-01-08T00:00:00.000Z', html_url: 'https://github.com/alice/owned-project/pull/5' }
          ]);
        }
        if (path === '/repos/alice/forked-project/pulls?state=all&per_page=10') {
          return jsonResponse([
            { number: 6, title: 'Fork PR', state: 'closed', user: { login: 'alice' }, merged_at: null, created_at: '2025-01-09T00:00:00.000Z', updated_at: '2025-01-09T00:00:00.000Z', html_url: 'https://github.com/alice/forked-project/pull/6' }
          ]);
        }
        if (path === '/search/issues?q=author%3Aalice+type%3Apr&per_page=2&page=1') {
          return jsonResponse({
            total_count: 1,
            items: [{
              repository_url: 'https://api.github.test/repos/t8y2/dbx',
              number: 99,
              title: 'Improve dbx ingestion',
              state: 'closed',
              user: { login: 'alice' },
              created_at: '2025-01-10T00:00:00.000Z',
              updated_at: '2025-01-11T00:00:00.000Z',
              pull_request: {
                html_url: 'https://github.com/t8y2/dbx/pull/99',
                merged_at: '2025-01-11T00:00:00.000Z'
              }
            }]
          });
        }
        return jsonResponse({ message: `unexpected path ${path}` }, 404);
      }
    });
    const context = { now: '2025-01-15T00:00:00.000Z' };
    const discovery = await source.discover({ username: 'alice' }, context);
    const scan = await source.scan(discovery, context);
    const evidence = await source.extractEvidence(scan, context);
    const find = (sourceId: string) => evidence.find((item) => item.sourceId === sourceId);

    expect(find('alice/owned-project')?.attribution).toBe('owned');
    expect(find('alice/forked-project')?.attribution).toBe('context');
    expect(find('alice/owned-project:mine')?.attribution).toBe('authored');
    expect(find('alice/owned-project:other')?.attribution).toBe('context');
    expect(find('alice/owned-project:unknown')?.attribution).toBe('unknown');
    expect(find('alice/owned-project:issue:1')?.attribution).toBe('authored');
    expect(find('alice/owned-project:issue:2')?.attribution).toBe('context');
    expect(find('alice/owned-project:pull-request:4')?.attribution).toBe('authored');
    expect(find('alice/owned-project:pull-request:5')?.attribution).toBe('context');
    expect(find('alice/forked-project:pull-request:6')?.attribution).toBe('authored');
    expect(find('t8y2/dbx:pull-request:99')?.attribution).toBe('authored');
    expect(find('t8y2/dbx:pull-request:99')?.externalContribution).toBe(true);
    expect(requests).toContain('/search/issues?q=author%3Aalice+type%3Apr&per_page=2&page=1');

    const repeated = await source.extractEvidence(scan, context);
    expect(repeated.map((item) => item.id)).toEqual(evidence.map((item) => item.id));
    expect(new Set(evidence.map((item) => item.id)).size).toBe(evidence.length);
  });

  it('returns a clear warning when optional external search hits the rate limit', async () => {
    const source = new GitHubSource({
      apiBaseUrl: 'https://api.github.test',
      maxRepositories: 1,
      fetchImpl: async (input) => {
        const path = requestPath(input);
        if (path === '/users/alice') {
          return jsonResponse({ login: 'alice', html_url: 'https://github.com/alice' });
        }
        if (path === '/users/alice/repos?per_page=1&sort=updated') {
          return jsonResponse([]);
        }
        return jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
      }
    });
    const context = { now: '2025-01-15T00:00:00.000Z' };
    const discovery = await source.discover({ username: 'alice' }, context);
    const scan = await source.scan(discovery, context);

    expect(scan.externalPullRequests).toHaveLength(0);
    expect(scan.warnings?.[0]).toContain('Use a GitHub token');
    expect(scan.warnings?.[0]).toContain('reduce scan limits');
  });

  it('fails with a clear rate-limit error for required repository reads', async () => {
    const source = new GitHubSource({
      apiBaseUrl: 'https://api.github.test',
      maxExternalContributions: 0,
      fetchImpl: async () => jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })
    });
    const context = { now: '2025-01-15T00:00:00.000Z' };
    const discovery = await source.discover({ username: 'alice', repository: 'alice/demo' }, context);

    await expect(source.scan(discovery, context)).rejects.toThrow(
      'GitHub API rate limit exceeded'
    );
  });
});
