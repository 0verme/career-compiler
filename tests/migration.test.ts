import { describe, expect, it } from 'vitest';
import {
  CAREER_IR_SCHEMA_VERSION,
  parseCareerIR,
  serializeCareerIR,
  validateCareerIR,
  type CareerEvidence,
  type CareerFact
} from '@career-compiler/core';

const NOW = '2025-01-15T00:00:00.000Z';

const evidence: CareerEvidence = {
  id: 'chat:conversation:legacy',
  sourceType: 'chat',
  sourceId: 'conversation:legacy',
  evidenceType: 'conversation',
  raw: { text: 'legacy' },
  normalized: { text: 'legacy' },
  discoveredAt: NOW
};

const fact: CareerFact = {
  id: 'fact_legacy',
  type: 'achievement',
  statement: 'Cut lineage onboarding time',
  normalizedData: { metric: '6 weeks to 1 week' },
  status: 'confirmed',
  confidence: 0.8,
  evidenceRefs: [{ evidenceId: evidence.id, relation: 'derived-from', weight: 0.8 }],
  canonicalKey: 'achievement:block:legacy',
  createdAt: NOW,
  updatedAt: NOW,
  confirmedAt: NOW,
  confirmedBy: 'test'
};

function legacyDocument(
  overrides: { achievement?: Record<string, unknown> } = {}
): Record<string, unknown> {
  return {
    kind: 'career-ir',
    schemaVersion: '0.1',
    exportedAt: NOW,
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
          factIds: [fact.id],
          evidenceRefs: [{ evidenceId: evidence.id, relation: 'derived-from', weight: 0.8 }],
          ...overrides.achievement
        }
      ],
      generatedAt: NOW
    },
    facts: [fact],
    evidence: [evidence]
  };
}

describe('CareerIR schema migration', () => {
  it('migrates a 0.1 document to 0.2 with factRefs provenance', () => {
    const parsed = parseCareerIR(JSON.stringify(legacyDocument()));
    expect(parsed.schemaVersion).toBe(CAREER_IR_SCHEMA_VERSION);
    const [achievement] = parsed.profile.achievements;
    expect(achievement?.statement).toBe('Cut lineage onboarding time');
    expect(achievement?.metric).toBe('6 weeks to 1 week');
    expect(achievement?.status).toBe('confirmed');
    expect(achievement?.factRefs).toEqual([
      {
        factId: fact.id,
        relation: 'derived-from',
        contributes: ['statement', 'metric']
      }
    ]);
    expect(achievement?.evidenceRefs).toEqual([
      { evidenceId: evidence.id, relation: 'derived-from', weight: 0.8 }
    ]);
    expect(parseCareerIR(serializeCareerIR(parsed)).schemaVersion).toBe(CAREER_IR_SCHEMA_VERSION);
  });

  it('rejects unknown schema versions instead of silently dropping fields', () => {
    const unknown = { ...legacyDocument(), schemaVersion: '0.3' };
    expect(() => parseCareerIR(JSON.stringify(unknown))).toThrow(
      'Unsupported CareerIR schema version: 0.3'
    );
    expect(() => validateCareerIR(legacyDocument())).toThrow(
      'Unsupported CareerIR schema version: 0.1'
    );
  });

  it('rejects a legacy achievement that has no provenance', () => {
    const document = legacyDocument({ achievement: { factIds: [] } });
    expect(() => parseCareerIR(JSON.stringify(document))).toThrow(
      'achievement.factRefs must contain at least one fact reference'
    );
  });

  it('rejects a 0.1 document whose achievement references a non-confirmed fact', () => {
    const document = legacyDocument();
    const facts = document.facts as CareerFact[];
    document.facts = [{ ...facts[0]!, status: 'candidate' }];
    expect(() => parseCareerIR(JSON.stringify(document))).toThrow(/non-confirmed fact/);
  });

  it('rejects a migrated 0.1 achievement whose statement diverges from its fact', () => {
    const document = legacyDocument({ achievement: { statement: 'Rewritten by hand' } });
    expect(() => parseCareerIR(JSON.stringify(document))).toThrow(
      /statement does not match contributing fact/
    );
  });

  it('rejects a migrated 0.1 achievement whose metric diverges from its fact', () => {
    const document = legacyDocument({ achievement: { metric: '90%' } });
    expect(() => parseCareerIR(JSON.stringify(document))).toThrow(
      /metric does not match contributing fact/
    );
  });
});
