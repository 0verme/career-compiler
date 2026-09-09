import type { CareerEvidence } from '@career-compiler/core';
import { createEvidenceId } from '@career-compiler/core';

/** Synthetic data used by the golden path; it contains no real user information. */
export function createAliceGitHubFixtureEvidence(
  discoveredAt = '2025-01-15T00:00:00.000Z'
): CareerEvidence[] {
  const repositoryId = 'alice/data-lineage-toolkit';
  const repositoryUrl = 'https://github.com/alice/data-lineage-toolkit';
  return [
    {
      id: createEvidenceId('github', repositoryId, 'repository'),
      sourceType: 'github',
      sourceId: repositoryId,
      evidenceType: 'repository',
      raw: {
        owner: 'alice',
        name: 'data-lineage-toolkit',
        description: 'Open lineage platform for dependable data operations.',
        htmlUrl: repositoryUrl,
        defaultBranch: 'main',
        topics: ['data-lineage', 'data-platform', 'lakehouse'],
        languages: ['TypeScript', 'Python']
      },
      normalized: {
        canonicalName: 'data-lineage-toolkit',
        name: 'data-lineage-toolkit',
        description: 'Open lineage platform for dependable data operations.',
        repositoryUrl,
        topics: ['data-lineage', 'data-platform', 'lakehouse'],
        languages: ['TypeScript', 'Python'],
        defaultBranch: 'main'
      },
      sourceUri: repositoryUrl,
      observedAt: '2025-01-14T12:00:00.000Z',
      discoveredAt
    },
    {
      id: createEvidenceId('github', `${repositoryId}:abc1234`, 'commit'),
      sourceType: 'github',
      sourceId: `${repositoryId}:abc1234`,
      evidenceType: 'commit',
      raw: {
        sha: 'abc1234',
        message: 'Document lineage ingestion boundaries',
        author: 'Alice Example',
        date: '2025-01-13T09:00:00.000Z',
        htmlUrl: `${repositoryUrl}/commit/abc1234`
      },
      normalized: {
        repository: repositoryId,
        sha: 'abc1234',
        summary: 'Document lineage ingestion boundaries',
        author: 'Alice Example'
      },
      sourceUri: `${repositoryUrl}/commit/abc1234`,
      observedAt: '2025-01-13T09:00:00.000Z',
      discoveredAt
    },
    {
      id: createEvidenceId('github', `${repositoryId}:issue:18`, 'issue'),
      sourceType: 'github',
      sourceId: `${repositoryId}:issue:18`,
      evidenceType: 'issue',
      raw: {
        number: 18,
        title: 'Define upstream ownership metadata',
        state: 'closed',
        htmlUrl: `${repositoryUrl}/issues/18`
      },
      normalized: {
        repository: repositoryId,
        number: 18,
        title: 'Define upstream ownership metadata',
        state: 'closed'
      },
      sourceUri: `${repositoryUrl}/issues/18`,
      observedAt: '2025-01-12T09:00:00.000Z',
      discoveredAt
    },
    {
      id: createEvidenceId('github', `${repositoryId}:pull-request:27`, 'pull-request'),
      sourceType: 'github',
      sourceId: `${repositoryId}:pull-request:27`,
      evidenceType: 'pull-request',
      raw: {
        number: 27,
        title: 'Add source ownership graph',
        state: 'closed',
        merged: true,
        htmlUrl: `${repositoryUrl}/pull/27`
      },
      normalized: {
        repository: repositoryId,
        number: 27,
        title: 'Add source ownership graph',
        state: 'closed',
        merged: true
      },
      sourceUri: `${repositoryUrl}/pull/27`,
      observedAt: '2025-01-14T10:00:00.000Z',
      discoveredAt
    }
  ];
}
