import { describe, expect, it } from 'vitest';
import { GitHubSource } from '@career-compiler/source-github';

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
          html_url: 'https://github.com/alice/data-lineage-toolkit/issues/18',
          updated_at: '2025-01-12T09:00:00.000Z'
        }
      ]],
      ['/repos/alice/data-lineage-toolkit/pulls?state=all&per_page=10', [
        {
          number: 27,
          title: 'Add ownership graph',
          state: 'closed',
          merged_at: '2025-01-14T10:00:00.000Z',
          html_url: 'https://github.com/alice/data-lineage-toolkit/pull/27',
          updated_at: '2025-01-14T10:00:00.000Z'
        }
      ]]
    ]);
    const source = new GitHubSource({
      apiBaseUrl: 'https://api.github.test',
      fetchImpl: async (input) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const payload = responses.get(`${url.pathname}${url.search}`);
        return new Response(JSON.stringify(payload ?? { message: 'not found' }), {
          status: payload === undefined ? 404 : 200,
          headers: { 'content-type': 'application/json' }
        });
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
      languages: ['Python', 'TypeScript']
    });
  });
});
