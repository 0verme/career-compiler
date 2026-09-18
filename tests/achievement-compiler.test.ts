import { describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  buildCareerProfile,
  compileAchievements,
  validateCareerAchievement,
  validateCareerIR,
  type CareerEvidence,
  type CareerFact,
  type CareerIR,
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
    // Context evidence stays on the context fact instead of widening the unit's evidence.
    expect(unit?.evidenceRefs.map((ref) => ref.evidenceId).sort()).toEqual(['ev:achievement']);
    expect(PROJECT_FACT.evidenceRefs.map((ref) => ref.evidenceId)).toEqual(['ev:project']);

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

function irFor(facts: CareerFact[]): CareerIR {
  const evidenceIds = [...new Set(facts.flatMap((fact) =>
    fact.evidenceRefs.map((reference) => reference.evidenceId)
  ))].sort();
  return buildCareerIR({
    profile: { id: 'alice', displayName: 'Alice Example' },
    facts,
    evidence: evidenceIds.map(evidenceFor),
    exportedAt: NOW
  });
}

describe('Achievement association resolution', () => {
  const platformAlpha = careerFact({
    id: 'fact_platform_alpha',
    type: 'project',
    statement: 'Maintains Data Platform (alpha)',
    evidenceId: 'ev:platform:alpha',
    canonicalKey: 'project:data-platform:alpha',
    normalizedData: { name: 'Data Platform' }
  });
  const platformBeta = careerFact({
    id: 'fact_platform_beta',
    type: 'project',
    statement: 'Maintains Data Platform (beta)',
    evidenceId: 'ev:platform:beta',
    canonicalKey: 'project:data-platform:beta',
    normalizedData: { name: 'Data Platform' }
  });
  const byProjectName = careerFact({
    id: 'fact_by_project_name',
    type: 'achievement',
    statement: 'Shipped the Data Platform',
    evidenceId: 'ev:by-project-name',
    canonicalKey: 'achievement:by-project-name',
    normalizedData: { projectName: 'Data Platform', result: 'Shipped' }
  });

  it('leaves a project name link empty when multiple confirmed projects share it', () => {
    const forward = compileAchievements([platformAlpha, platformBeta, byProjectName]);
    const reversed = compileAchievements([byProjectName, platformBeta, platformAlpha]);
    expect(forward).toEqual(reversed);
    expect(forward[0]?.projectId).toBeUndefined();
    expect(forward[0]?.factRefs.map((ref) => ref.factId)).toEqual([byProjectName.id]);
  });

  it('resolves a name fallback only for a single confirmed candidate', () => {
    const solo = careerFact({
      id: 'fact_solo_platform',
      type: 'project',
      statement: 'Maintains Solo Platform',
      evidenceId: 'ev:solo',
      canonicalKey: 'project:solo-platform',
      normalizedData: { name: 'Solo Platform' }
    });
    const achievement = careerFact({
      id: 'fact_solo_achievement',
      type: 'achievement',
      statement: 'Shipped Solo Platform',
      evidenceId: 'ev:solo:achievement',
      canonicalKey: 'achievement:solo',
      normalizedData: { projectName: 'solo platform', result: 'Shipped' }
    });
    const [unit] = compileAchievements([solo, achievement]);
    expect(unit?.projectId).toBeDefined();
    expect(unit?.factRefs.find((ref) => ref.relation === 'context')?.factId).toBe(solo.id);
  });

  it('does not treat a candidate project as an ambiguity source', () => {
    const solo = careerFact({
      id: 'fact_solo_confirmed',
      type: 'project',
      statement: 'Maintains Solo Platform',
      evidenceId: 'ev:solo:confirmed',
      canonicalKey: 'project:solo-confirmed',
      normalizedData: { name: 'Solo Platform' }
    });
    const draft = asCandidate(careerFact({
      id: 'fact_solo_candidate',
      type: 'project',
      statement: 'Maybe Solo Platform',
      evidenceId: 'ev:solo:candidate',
      canonicalKey: 'project:solo-candidate',
      normalizedData: { name: 'Solo Platform' }
    }));
    const achievement = careerFact({
      id: 'fact_candidate_scope',
      type: 'achievement',
      statement: 'Shipped Solo Platform',
      evidenceId: 'ev:candidate-scope',
      canonicalKey: 'achievement:candidate-scope',
      normalizedData: { projectName: 'Solo Platform' }
    });
    const [unit] = compileAchievements([solo, draft, achievement]);
    expect(unit?.factRefs.find((ref) => ref.relation === 'context')?.factId).toBe(solo.id);
  });

  it('prefers an exact project key over an ambiguous name', () => {
    const keyed = careerFact({
      id: 'fact_keyed',
      type: 'achievement',
      statement: 'Shipped the beta platform',
      evidenceId: 'ev:keyed',
      canonicalKey: 'achievement:keyed',
      normalizedData: { projectKey: 'project:data-platform:beta', projectName: 'Data Platform' }
    });
    const [unit] = compileAchievements([platformAlpha, platformBeta, keyed]);
    expect(unit?.factRefs.find((ref) => ref.relation === 'context')?.factId).toBe(platformBeta.id);
  });

  it('leaves duplicate canonical keys unresolved', () => {
    const first = careerFact({
      id: 'fact_duplicate_first',
      type: 'project',
      statement: 'Maintains Duplicate',
      evidenceId: 'ev:duplicate:first',
      canonicalKey: 'project:duplicate',
      normalizedData: { name: 'Duplicate One' }
    });
    const second = careerFact({
      id: 'fact_duplicate_second',
      type: 'project',
      statement: 'Maintains Duplicate Too',
      evidenceId: 'ev:duplicate:second',
      canonicalKey: 'project:duplicate',
      normalizedData: { name: 'Duplicate Two' }
    });
    const achievement = careerFact({
      id: 'fact_duplicate_achievement',
      type: 'achievement',
      statement: 'Used the duplicate key',
      evidenceId: 'ev:duplicate:achievement',
      canonicalKey: 'achievement:duplicate',
      normalizedData: { projectKey: 'project:duplicate' }
    });
    const [unit] = compileAchievements([first, second, achievement]);
    expect(unit?.projectId).toBeUndefined();
    expect(unit?.factRefs.map((ref) => ref.factId)).toEqual([achievement.id]);
  });

  it('leaves an experience role link empty when multiple confirmed experiences share it', () => {
    const acme = careerFact({
      id: 'fact_lead_acme',
      type: 'experience',
      statement: 'Tech Lead at Acme',
      evidenceId: 'ev:lead:acme',
      canonicalKey: 'experience:acme:tech-lead',
      normalizedData: { role: 'Tech Lead', organization: 'Acme' }
    });
    const beta = careerFact({
      id: 'fact_lead_beta',
      type: 'experience',
      statement: 'Tech Lead at Beta',
      evidenceId: 'ev:lead:beta',
      canonicalKey: 'experience:beta:tech-lead',
      normalizedData: { role: 'Tech Lead', organization: 'Beta' }
    });
    const achievement = careerFact({
      id: 'fact_lead_achievement',
      type: 'achievement',
      statement: 'Led the team',
      evidenceId: 'ev:lead:achievement',
      canonicalKey: 'achievement:lead',
      normalizedData: { experienceRole: 'tech lead' }
    });
    const [unit] = compileAchievements([acme, beta, achievement]);
    expect(unit?.experienceId).toBeUndefined();
    expect(unit?.factRefs.map((ref) => ref.factId)).toEqual([achievement.id]);
  });

  it('links an experience role fallback when only one confirmed candidate matches', () => {
    const acme = careerFact({
      id: 'fact_unique_lead',
      type: 'experience',
      statement: 'Tech Lead at Acme',
      evidenceId: 'ev:unique:lead',
      canonicalKey: 'experience:acme:unique-lead',
      normalizedData: { role: 'Tech Lead', organization: 'Acme' }
    });
    const achievement = careerFact({
      id: 'fact_unique_lead_achievement',
      type: 'achievement',
      statement: 'Led the team',
      evidenceId: 'ev:unique:lead:achievement',
      canonicalKey: 'achievement:unique-lead',
      normalizedData: { experienceRole: 'Tech Lead' }
    });
    const [unit] = compileAchievements([acme, achievement]);
    expect(unit?.experienceId).toBeDefined();
    expect(unit?.factRefs.find((ref) => ref.relation === 'context')?.factId).toBe(acme.id);
  });
});

describe('Achievement provenance invariants', () => {
  function structuredIR(): CareerIR {
    return irFor([STRUCTURED_ACHIEVEMENT, PROJECT_FACT]);
  }

  it('rejects a component that diverges from its contributing fact', () => {
    const ir = structuredIR();
    ir.profile.achievements[0]!.result = 'Onboarding dropped to one day';
    expect(() => validateCareerIR(ir)).toThrow(/result does not match contributing fact/);
  });

  it('rejects a rewritten statement', () => {
    const ir = structuredIR();
    ir.profile.achievements[0]!.statement = 'Invented a lineage platform';
    expect(() => validateCareerIR(ir)).toThrow(/statement does not match contributing fact/);
  });

  it('rejects a contribution the source fact cannot provide', () => {
    const bare = careerFact({
      id: 'fact_bare',
      type: 'achievement',
      statement: 'Bare claim',
      evidenceId: 'ev:bare',
      canonicalKey: 'achievement:bare',
      normalizedData: {}
    });
    const ir = irFor([bare]);
    ir.profile.achievements[0]!.factRefs[0]!.contributes.push('metric');
    expect(() => validateCareerIR(ir)).toThrow(/does not provide metric/);
  });

  it('rejects context links that contribute components', () => {
    const [unit] = compileAchievements([STRUCTURED_ACHIEVEMENT, PROJECT_FACT]);
    const context = unit!.factRefs.find((ref) => ref.factId === PROJECT_FACT.id)!;
    expect(() => validateCareerAchievement({
      ...unit,
      factRefs: [{ ...context, contributes: ['statement'] }]
    })).toThrow(/context link and must not contribute components/);
  });

  it('rejects non-context links without contribution', () => {
    const [unit] = compileAchievements([STRUCTURED_ACHIEVEMENT]);
    expect(() => validateCareerAchievement({
      ...unit,
      factRefs: unit!.factRefs.map((ref) => ({ ...ref, contributes: [] }))
    })).toThrow(/must contribute at least one component/);
  });

  it('rejects achievements without a statement contributor', () => {
    const [unit] = compileAchievements([STRUCTURED_ACHIEVEMENT]);
    expect(() => validateCareerAchievement({
      ...unit,
      factRefs: [
        { factId: STRUCTURED_ACHIEVEMENT.id, relation: 'derived-from', contributes: ['result'] }
      ]
    })).toThrow(/must contain a fact that contributes the statement/);
  });

  it('rejects an achievement that drops the evidence of a contributing fact', () => {
    const ir = structuredIR();
    ir.profile.achievements[0]!.evidenceRefs = [
      { evidenceId: 'ev:project', relation: 'supports', weight: 1 }
    ];
    expect(() => validateCareerIR(ir)).toThrow(
      /missing evidence ev:achievement of contributing fact/
    );
  });

  it('still accepts extra evidence from pre-hardening documents', () => {
    const ir = structuredIR();
    ir.profile.achievements[0]!.evidenceRefs.push({
      evidenceId: 'ev:project',
      relation: 'supports',
      weight: 1
    });
    expect(() => validateCareerIR(ir)).not.toThrow();
  });

  it('rejects a projectId that no context fact reference backs', () => {
    const ir = structuredIR();
    const unit = ir.profile.achievements[0]!;
    unit.factRefs = unit.factRefs.filter((ref) => ref.relation !== 'context');
    expect(() => validateCareerIR(ir)).toThrow(/projectId is not backed by a context fact reference/);
  });

  it('rejects an experienceId that no context fact reference backs', () => {
    const acme = careerFact({
      id: 'fact_backed_lead',
      type: 'experience',
      statement: 'Tech Lead at Acme',
      evidenceId: 'ev:backed:lead',
      canonicalKey: 'experience:acme:backed-lead',
      normalizedData: { role: 'Tech Lead' }
    });
    const achievement = careerFact({
      id: 'fact_backed_lead_achievement',
      type: 'achievement',
      statement: 'Led the team',
      evidenceId: 'ev:backed:lead:achievement',
      canonicalKey: 'achievement:backed-lead',
      normalizedData: { experienceRole: 'Tech Lead' }
    });
    const ir = irFor([acme, achievement]);
    const unit = ir.profile.achievements[0]!;
    expect(unit.experienceId).toBeDefined();
    unit.factRefs = unit.factRefs.filter((ref) => ref.relation !== 'context');
    expect(() => validateCareerIR(ir)).toThrow(
      /experienceId is not backed by a context fact reference/
    );
  });
});
