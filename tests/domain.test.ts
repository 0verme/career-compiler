import { describe, expect, it } from 'vitest';
import {
  buildCareerProfile,
  buildCareerIR,
  createStableId,
  deriveCandidateFacts,
  mergeCandidateFacts,
  validateCareerFact,
  type CareerEvidence,
  type CareerFact
} from '@career-compiler/core';

const evidence: CareerEvidence = {
  id: 'github:repository:alice/demo',
  sourceType: 'github',
  sourceId: 'alice/demo',
  evidenceType: 'repository',
  attribution: 'owned',
  raw: { name: 'demo', description: 'A demo project', fork: false },
  normalized: {
    canonicalName: 'demo',
    name: 'demo',
    description: 'A demo project',
    repositoryUrl: 'https://github.com/alice/demo',
    languages: ['TypeScript'],
    topics: ['compiler'],
    fork: false,
    attribution: 'owned'
  },
  sourceUri: 'https://github.com/alice/demo',
  discoveredAt: '2025-01-01T00:00:00.000Z'
};

function fact(status: CareerFact['status'] = 'candidate'): CareerFact {
  return {
    id: createStableId('fact', 'project:demo'),
    type: 'project',
    statement: 'Built demo: A demo project',
    normalizedData: {
      name: 'demo',
      summary: 'A demo project',
      repositoryUrl: 'https://github.com/alice/demo',
      skills: ['TypeScript']
    },
    status,
    confidence: 0.8,
    evidenceRefs: [{ evidenceId: evidence.id, relation: 'supports', weight: 1 }],
    canonicalKey: 'project:demo',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...(status === 'confirmed'
      ? {
          confirmedAt: '2025-01-02T00:00:00.000Z',
          confirmedBy: 'test'
        }
      : {})
  };
}

describe('Career domain pipeline', () => {
  it('derives a project candidate from repository metadata without using activity counts', () => {
    const candidates = deriveCandidateFacts([evidence]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status).toBe('candidate');
    expect(candidates[0]?.statement).toBe('Maintains demo');
    expect(candidates[0]?.evidenceRefs[0]?.evidenceId).toBe(evidence.id);
    expect(candidates[0]?.normalizedData).not.toHaveProperty('commitCount');
  });

  it('does not promote context-only repositories or activity', () => {
    const fork: CareerEvidence = {
      ...evidence,
      id: 'github:repository:alice/forked-demo',
      sourceId: 'alice/forked-demo',
      attribution: 'context',
      raw: { name: 'forked-demo', fork: true },
      normalized: {
        ...evidence.normalized,
        canonicalName: 'forked-demo',
        name: 'forked-demo',
        fork: true,
        attribution: 'context'
      }
    };
    const otherCommit: CareerEvidence = {
      ...evidence,
      id: 'github:commit:alice/forked-demo:other',
      sourceId: 'alice/forked-demo:other',
      evidenceType: 'commit',
      attribution: 'context',
      raw: { sha: 'other', authorLogin: 'other' },
      normalized: { repository: 'alice/forked-demo', sha: 'other', attribution: 'context' }
    };
    expect(deriveCandidateFacts([fork, otherCommit])).toEqual([]);
  });

  it('promotes an authored external pull request without claiming project ownership', () => {
    const pullRequest: CareerEvidence = {
      id: 'github:pull-request:t8y2/dbx:pull-request:99',
      sourceType: 'github',
      sourceId: 't8y2/dbx:pull-request:99',
      evidenceType: 'pull-request',
      attribution: 'authored',
      externalContribution: true,
      raw: { repository: 't8y2/dbx', number: 99, title: 'Improve ingestion' },
      normalized: {
        repository: 't8y2/dbx',
        repositoryUrl: 'https://github.com/t8y2/dbx',
        number: 99,
        title: 'Improve ingestion',
        merged: true,
        attribution: 'authored',
        externalContribution: true
      },
      sourceUri: 'https://github.com/t8y2/dbx/pull/99',
      discoveredAt: '2025-01-01T00:00:00.000Z'
    };
    const candidates = deriveCandidateFacts([pullRequest]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe('achievement');
    expect(candidates[0]?.statement).toContain('Contributed to t8y2/dbx');
    expect(candidates[0]?.statement).not.toContain('Built');
  });

  it('promotes authored work in a fork as a contribution, not a built project', () => {
    const fork: CareerEvidence = {
      ...evidence,
      id: 'github:repository:alice/forked-demo',
      sourceId: 'alice/forked-demo',
      attribution: 'context',
      raw: { name: 'forked-demo', fork: true },
      normalized: {
        ...evidence.normalized,
        canonicalName: 'forked-demo',
        name: 'forked-demo',
        fork: true,
        attribution: 'context'
      }
    };
    const authoredCommit: CareerEvidence = {
      ...evidence,
      id: 'github:commit:alice/forked-demo:mine',
      sourceId: 'alice/forked-demo:mine',
      evidenceType: 'commit',
      attribution: 'authored',
      raw: { sha: 'mine', authorLogin: 'alice' },
      normalized: { repository: 'alice/forked-demo', sha: 'mine', attribution: 'authored' }
    };
    const candidates = deriveCandidateFacts([fork, authoredCommit]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.type).toBe('achievement');
    expect(candidates[0]?.statement).toBe('Contributed to the fork forked-demo through authored commits');
    expect(candidates[0]?.statement).not.toContain('Built');
  });

  it('merges corroborating evidence while preserving a confirmed claim', () => {
    const confirmed = fact('confirmed');
    const corroborating: CareerEvidence = {
      ...evidence,
      id: 'local-git:local-repository:demo',
      sourceType: 'local-git',
      sourceId: 'demo',
      evidenceType: 'local-repository',
      attribution: 'owned',
      raw: { path: '/allowed/demo' },
      normalized: {
        canonicalName: 'demo',
        name: 'demo',
        description: 'Local metadata',
        skills: ['TypeScript'],
        attribution: 'owned'
      }
    };
    const incoming = deriveCandidateFacts([corroborating]);
    const merged = mergeCandidateFacts([confirmed], incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe('confirmed');
    expect(merged[0]?.statement).toBe(confirmed.statement);
    expect(merged[0]?.evidenceRefs).toHaveLength(2);
  });

  it('renders only confirmed facts into the Career Profile projection', () => {
    const candidate = fact();
    const confirmed = fact('confirmed');
    const profile = buildCareerProfile(
      { id: 'alice', displayName: 'Alice Example' },
      [candidate, confirmed],
      '2025-01-03T00:00:00.000Z'
    );
    expect(profile.projects).toHaveLength(1);
    expect(profile.skills.map((skill) => skill.name)).toContain('TypeScript');
  });

  it('rejects facts without provenance', () => {
    expect(() => validateCareerFact({ ...fact(), evidenceRefs: [] })).toThrow(
      'evidenceRefs must contain at least one evidence reference'
    );
  });

  it('builds a versioned IR with linked evidence', () => {
    const ir = buildCareerIR({
      profile: {
        id: 'alice',
        displayName: 'Alice Example',
        identity: {
          sources: [{ provider: 'github', externalId: 'alice', username: 'alice' }]
        }
      },
      facts: [fact('confirmed')],
      evidence: [evidence],
      exportedAt: '2025-01-03T00:00:00.000Z'
    });
    expect(ir.schemaVersion).toBe('0.1');
    expect(ir.profile.identity?.sources[0]?.username).toBe('alice');
    expect(ir.profile.projects[0]?.evidenceRefs[0]?.evidenceId).toBe(evidence.id);
  });
});
