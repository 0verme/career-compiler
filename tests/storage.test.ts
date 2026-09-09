import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(repository.getFact(facts[0]!.id)?.evidenceRefs[0]?.evidenceId).toBe(evidence[0]!.id);
    expect(repository.loadCareerIR('alice')?.schemaVersion).toBe('0.1');

    const serialized = serializeCareerIR(ir);
    expect(parseCareerIR(serialized).profile.displayName).toBe('Alice Example');
    repository.close();
  });
});
