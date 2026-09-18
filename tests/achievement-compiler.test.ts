import { describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  buildCareerProfile,
  compileAchievements,
  validateCareerAchievement,
  validateCareerIR,
  type CareerEvidence,
  type CareerFact,
  type JsonObject
} from '@career-compiler/core';

const NOW = '2025-01-15T00:00:00.000Z';

function evidenceFor(id: string): CareerEvidence {
  return {
    id,
    sourceType: 'chat',
    sourceId: `conversation:${id}`,
    evidenceType: 'conversation',
    raw: { id },
    normalized: { id },
    discoveredAt: NOW
  };
}

interface FactOptions {
  id: string;
  type: string;
  statement: string;
  evidenceId: string;
  canonicalKey?: string;
  normalizedData?: JsonObject;
  status?: CareerFact['status'];
  confidence?: number;
}

function careerFact(options: FactOptions): CareerFact {
  const status = options.status ?? 'confirmed';
  return {
    id: options.id,
    type: options.type,
    statement: options.statement,
    normalizedData: options.normalizedData ?? {},
    status,
    confidence: options.confidence ?? 0.8,
    evidenceRefs: [
      {
        evidenceId: options.evidenceId,
        relation: 'derived-from',
        weight: options.confidence ?? 0.8
      }
    ],
    ...(options.canonicalKey ? { canonicalKey: options.canonicalKey } : {}),
    createdAt: NOW,
    updatedAt: NOW,
    ...(status === 'confirmed' ? { confirmedAt: NOW, confirmedBy: 'test' } : {})
  };
}

function asCandidate(fact: CareerFact): CareerFact {
  const candidate: CareerFact = { ...fact, status: 'candidate' };
  delete candidate.confirmedAt;
  delete candidate.confirmedBy;
  return candidate;
}

const PROJECT_FACT = careerFact({
  id: 'fact_project',
  type: 'project',
  statement: 'Maintains data-lineage-toolkit',
  evidenceId: 'ev:project',
  canonicalKey: 'project:data-lineage-toolkit',
  normalizedData: { name: 'data-lineage-toolkit' }
});

const STRUCTURED_ACHIEVEMENT = careerFact({
  id: 'fact_achievement_onboarding',
  type: 'achievement',
  statement: 'Cut lineage onboarding time from six weeks to one week',
  evidenceId: 'ev:achievement',
  canonicalKey: 'achievement:block:onboarding',
  normalizedData: {
    projectKey: 'project:data-lineage-toolkit',
    problem: 'Upstream metadata was inconsistent',
    constraint: 'The legacy catalog could not be replaced',
    decision: 'We adopted an incremental contract registry',
    action: 'I implemented the ingestion contract registry',
    result: 'Onboarding dropped from six weeks to one week',
    metric: '6 weeks to 1 week'
  }
});

describe('Fact → Achievement compiler', () => {
  it('compiles a confirmed achievement fact with component provenance and a project link', () => {
    const [unit] = compileAchievements([STRUCTURED_ACHIEVEMENT, PROJECT_FACT]);
    expect(unit).toBeDefined();
    expect(unit?.statement).toBe(STRUCTURED_ACHIEVEMENT.statement);
    expect(unit?.problem).toBe('Upstream metadata was inconsistent');
    expect(unit?.constraint).toBe('The legacy catalog could not be replaced');
    expect(unit?.decision).toBe('We adopted an incremental contract registry');
    expect(unit?.action).toBe('I implemented the ingestion contract registry');
    expect(unit?.result).toBe('Onboarding dropped from six weeks to one week');
    expect(unit?.metric).toBe('6 weeks to 1 week');
    expect(unit?.status).toBe('confirmed');

    const primary = unit?.factRefs.find((ref) => ref.factId === STRUCTURED_ACHIEVEMENT.id);
    expect(primary?.relation).toBe('derived-from');
    expect(primary?.contributes).toEqual([
      'statement',
      'problem',
      'constraint',
      'decision',
      'action',
      'result',
      'metric'
    ]);
    const context = unit?.factRefs.find((ref) => ref.factId === PROJECT_FACT.id);
    expect(context?.relation).toBe('context');
    expect(context?.contributes).toEqual([]);
    expect(unit?.evidenceRefs.map((ref) => ref.evidenceId).sort()).toEqual([
      'ev:achievement',
      'ev:project'
    ]);

    const profile = buildCareerProfile(
      { id: 'alice', displayName: 'Alice Example' },
      [STRUCTURED_ACHIEVEMENT, PROJECT_FACT],
      NOW
    );
    expect(profile.achievements).toHaveLength(1);
    expect(profile.achievements[0]?.projectId).toBe(profile.projects[0]?.id);
  });

  it('never compiles candidate facts into formal achievements', () => {
    const candidate = asCandidate(STRUCTURED_ACHIEVEMENT);
    expect(compileAchievements([candidate, PROJECT_FACT])).toEqual([]);

    const profile = buildCareerProfile(
      { id: 'alice', displayName: 'Alice Example' },
      [candidate, PROJECT_FACT],
      NOW
    );
    expect(profile.achievements).toEqual([]);
  });

  it('does not merge a candidate project link or its evidence', () => {
    const candidateProject = asCandidate(PROJECT_FACT);
    const [unit] = compileAchievements([STRUCTURED_ACHIEVEMENT, candidateProject]);
    expect(unit?.projectId).toBeUndefined();
    expect(unit?.factRefs.map((ref) => ref.factId)).toEqual([STRUCTURED_ACHIEVEMENT.id]);
    expect(unit?.evidenceRefs.map((ref) => ref.evidenceId)).toEqual(['ev:achievement']);
  });

  it('keeps missing components absent instead of inventing values', () => {
    const minimal = careerFact({
      id: 'fact_metric',
      type: 'metric',
      statement: 'Reduced pipeline cost by 30%',
      evidenceId: 'ev:metric',
      canonicalKey: 'metric:pipeline-cost',
      normalizedData: { metric: '30%' }
    });
    const [unit] = compileAchievements([minimal]);
    expect(unit?.metric).toBe('30%');
    expect(unit).not.toHaveProperty('problem');
    expect(unit).not.toHaveProperty('result');
    expect(unit?.factRefs).toHaveLength(1);
  });

  it('lets one project carry multiple achievements and stays deterministic', () => {
    const second = careerFact({
      id: 'fact_achievement_scale',
      type: 'achievement',
      statement: 'Scaled the lineage platform to 80 upstream systems',
      evidenceId: 'ev:achievement:scale',
      canonicalKey: 'achievement:block:scale',
      normalizedData: {
        projectKey: 'project:data-lineage-toolkit',
        result: '80 upstream systems onboarded with owned metadata',
        metric: '80 upstream systems'
      }
    });
    const firstOrder = compileAchievements([second, PROJECT_FACT, STRUCTURED_ACHIEVEMENT]);
    const secondOrder = compileAchievements([STRUCTURED_ACHIEVEMENT, PROJECT_FACT, second]);
    expect(firstOrder).toEqual(secondOrder);
    expect(firstOrder).toHaveLength(2);
    expect(new Set(firstOrder.map((unit) => unit.projectId)).size).toBe(1);
    expect(firstOrder.map((unit) => unit.statement)).toEqual([
      'Cut lineage onboarding time from six weeks to one week',
      'Scaled the lineage platform to 80 upstream systems'
    ]);
  });

  it('carries compiled achievements into Career IR with traceable facts and evidence', () => {
    const ir = buildCareerIR({
      profile: { id: 'alice', displayName: 'Alice Example' },
      facts: [STRUCTURED_ACHIEVEMENT, PROJECT_FACT],
      evidence: [evidenceFor('ev:project'), evidenceFor('ev:achievement')],
      exportedAt: NOW
    });
    const [unit] = ir.profile.achievements;
    expect(unit?.problem).toBe('Upstream metadata was inconsistent');
    for (const reference of unit?.factRefs ?? []) {
      const fact = ir.facts.find((item) => item.id === reference.factId);
      expect(fact?.status).toBe('confirmed');
    }
    expect(() => validateCareerIR(ir)).not.toThrow();
  });

  it('rejects achievement documents without provenance or with candidate-only facts', () => {
    const [unit] = compileAchievements([STRUCTURED_ACHIEVEMENT, PROJECT_FACT]);
    expect(unit).toBeDefined();
    expect(() => validateCareerAchievement({ ...unit, evidenceRefs: [] })).toThrow(
      'achievement.evidenceRefs must contain at least one evidence reference'
    );
    expect(() => validateCareerAchievement({ ...unit, factRefs: [] })).toThrow(
      'achievement.factRefs must contain at least one fact reference'
    );

    const ir = buildCareerIR({
      profile: { id: 'alice', displayName: 'Alice Example' },
      facts: [STRUCTURED_ACHIEVEMENT, PROJECT_FACT],
      evidence: [evidenceFor('ev:project'), evidenceFor('ev:achievement')],
      exportedAt: NOW
    });
    const candidate = asCandidate(STRUCTURED_ACHIEVEMENT);
    const tampered = {
      ...ir,
      facts: [candidate, PROJECT_FACT],
      profile: {
        ...ir.profile,
        achievements: ir.profile.achievements.map((achievement) => ({
          ...achievement,
          factRefs: [
            { factId: candidate.id, relation: 'derived-from', contributes: ['statement'] }
          ]
        }))
      }
    };
    expect(() => validateCareerIR(tampered)).toThrow(/non-confirmed fact/);
  });
});
