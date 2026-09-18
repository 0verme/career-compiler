import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  confirmCareerFact,
  deriveCandidateFacts,
  parseCareerIR,
  serializeCareerIR
} from '@career-compiler/core';
import { createAliceGitHubFixtureEvidence } from '@career-compiler/source-github';
import { SQLiteCareerRepository } from '@career-compiler/storage';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SQLite repository', () => {
  it('round-trips evidence, facts, links, and versioned IR', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'career-compiler-test-'));
    temporaryDirectories.push(directory);
    const repository = new SQLiteCareerRepository({ filePath: join(directory, 'career.sqlite') });
    const evidence = createAliceGitHubFixtureEvidence();
    const facts = deriveCandidateFacts(evidence).map((fact) =>
      confirmCareerFact(fact, '2025-01-15T00:00:00.000Z', 'test')
    );
    const ir = buildCareerIR({
      profile: { id: 'alice', displayName: 'Alice Example' },
      facts,
      evidence,
      exportedAt: '2025-01-15T00:00:00.000Z'
    });

    repository.saveCareerIR(ir);
    expect(repository.listEvidence('github')).toHaveLength(4);
    expect(repository.listFacts('confirmed')).toHaveLength(1);
    expect(repository.getFact(facts[0]!.id)?.evidenceRefs.map((ref) => ref.evidenceId)).toContain(evidence[0]!.id);
    expect(repository.loadCareerIR('alice')?.schemaVersion).toBe('0.2');

    const serialized = serializeCareerIR(ir);
    expect(parseCareerIR(serialized).profile.displayName).toBe('Alice Example');
    repository.close();
  });

  it('loads and migrates a persisted 0.1 IR document to 0.2', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'career-compiler-test-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'career.sqlite');
    const repository = new SQLiteCareerRepository({ filePath });
    const legacy = {
      kind: 'career-ir',
      schemaVersion: '0.1',
      exportedAt: '2025-01-15T00:00:00.000Z',
      profile: {
        id: 'alice',
        displayName: 'Alice Example',
        experiences: [],
        projects: [],
        skills: [],
        achievements: [
          {
            id: 'achievement_legacy',
            statement: 'Cut lineage onboarding time',
            metric: '6 weeks to 1 week',
            factIds: ['fact_legacy'],
            evidenceRefs: [
              { evidenceId: 'chat:conversation:legacy', relation: 'derived-from', weight: 0.8 }
            ]
          }
        ],
        generatedAt: '2025-01-15T00:00:00.000Z'
      },
      facts: [
        {
          id: 'fact_legacy',
          type: 'achievement',
          statement: 'Cut lineage onboarding time',
          normalizedData: { metric: '6 weeks to 1 week' },
          status: 'confirmed',
          confidence: 0.8,
          evidenceRefs: [
            { evidenceId: 'chat:conversation:legacy', relation: 'derived-from', weight: 0.8 }
          ],
          canonicalKey: 'achievement:block:legacy',
          createdAt: '2025-01-15T00:00:00.000Z',
          updatedAt: '2025-01-15T00:00:00.000Z',
          confirmedAt: '2025-01-15T00:00:00.000Z',
          confirmedBy: 'test'
        }
      ],
      evidence: [
        {
          id: 'chat:conversation:legacy',
          sourceType: 'chat',
          sourceId: 'conversation:legacy',
          evidenceType: 'conversation',
          raw: { text: 'legacy' },
          normalized: { text: 'legacy' },
          discoveredAt: '2025-01-15T00:00:00.000Z'
        }
      ]
    };
    const database = new DatabaseSync(filePath);
    database
      .prepare(
        'INSERT INTO profiles (profile_id, schema_version, document_json, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('alice', '0.1', JSON.stringify(legacy), '2025-01-15T00:00:00.000Z');
    database.close();

    const loaded = repository.loadCareerIR('alice');
    expect(loaded?.schemaVersion).toBe('0.2');
    expect(loaded?.profile.achievements[0]?.factRefs).toEqual([
      { factId: 'fact_legacy', relation: 'derived-from', contributes: ['statement', 'metric'] }
    ]);
    repository.close();
  });

  it('upserts stable evidence ids and protects confirmed facts from candidate rescans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'career-compiler-test-'));
    temporaryDirectories.push(directory);
    const repository = new SQLiteCareerRepository({ filePath: join(directory, 'career.sqlite') });
    const evidence = createAliceGitHubFixtureEvidence();
    const candidate = deriveCandidateFacts(evidence)[0]!;
    const confirmed = confirmCareerFact(candidate, '2025-01-16T00:00:00.000Z', 'test');

    for (const item of evidence) {
      repository.saveEvidence(item);
    }
    repository.saveEvidence({ ...evidence[0]!, discoveredAt: '2025-01-16T00:00:00.000Z' });
    expect(repository.listEvidence('github')).toHaveLength(4);
    expect(repository.getEvidence(evidence[0]!.id)?.attribution).toBe('owned');

    repository.saveFact(confirmed);
    const rescannedCandidate = {
      ...candidate,
      statement: 'Built an unrelated project',
      normalizedData: { ...candidate.normalizedData, name: 'unrelated-project' },
      updatedAt: '2025-01-17T00:00:00.000Z'
    };
    repository.saveFact(rescannedCandidate);
    const persisted = repository.getFact(candidate.id);
    expect(persisted?.status).toBe('confirmed');
    expect(persisted?.statement).toBe(confirmed.statement);
    expect(repository.updateFactStatus(candidate.id, 'rejected')?.status).toBe('rejected');
    repository.close();
  });
});
