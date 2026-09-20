import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StructuralCompilationStrategy,
  applyResumePatchProposal,
  applyResumeViewConfig,
  buildCareerIR,
  canonicalIrHash,
  defaultResumeView,
  normalizeResumeViewConfig,
  rejectResumePatchProposal,
  revertCompilationSnapshot,
  validateResumePatchProposal,
  type CareerEvidence,
  type CareerFact,
  type CareerIR,
  type JsonObject,
  type ResumePatchOperation,
  type ResumeSectionId
} from '@career-compiler/core';
import { ResumeMarkdownRenderer } from '@career-compiler/renderer-resume';
import { SQLiteCareerRepository } from '@career-compiler/storage';

const NOW = '2025-01-15T00:00:00.000Z';
const LATER = '2025-01-16T00:00:00.000Z';
const EVEN_LATER = '2025-01-17T00:00:00.000Z';
const PROFILE_ID = 'alice';

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
  normalizedData?: JsonObject;
  canonicalKey?: string;
}

function fact(options: FactOptions): CareerFact {
  return {
    id: options.id,
    type: options.type,
    statement: options.statement,
    normalizedData: options.normalizedData ?? {},
    status: 'confirmed',
    confidence: 0.8,
    evidenceRefs: [{ evidenceId: options.evidenceId, relation: 'derived-from', weight: 0.8 }],
    ...(options.canonicalKey ? { canonicalKey: options.canonicalKey } : {}),
    createdAt: NOW,
    updatedAt: NOW,
    confirmedAt: NOW,
    confirmedBy: 'test'
  };
}

const EVIDENCE: CareerEvidence[] = [
  evidenceFor('ev:platform'),
  evidenceFor('ev:governance'),
  evidenceFor('ev:kafka'),
  evidenceFor('ev:flink')
];

const FACTS: CareerFact[] = [
  fact({
    id: 'fact_project_lineage',
    type: 'project',
    statement: 'Maintains data-lineage-toolkit',
    evidenceId: 'ev:platform',
    canonicalKey: 'project:data-lineage-toolkit',
    normalizedData: { name: 'data-lineage-toolkit' }
  }),
  fact({
    id: 'fact_skill_kafka',
    type: 'skill',
    statement: 'Kafka',
    evidenceId: 'ev:kafka',
    normalizedData: { name: 'Kafka', category: 'streaming' }
  }),
  fact({
    id: 'fact_skill_flink',
    type: 'skill',
    statement: 'Flink',
    evidenceId: 'ev:flink',
    normalizedData: { name: 'Flink', category: 'streaming' }
  }),
  fact({
    id: 'fact_achievement_lineage',
    type: 'achievement',
    statement: 'Built the lineage platform',
    evidenceId: 'ev:platform',
    canonicalKey: 'achievement:lineage',
    normalizedData: {
      problem: 'Lineage was untraceable',
      action: 'Built a lineage graph service',
      result: '180 systems covered',
      metric: '180 systems'
    }
  }),
  fact({
    id: 'fact_achievement_governance',
    type: 'achievement',
    statement: 'Drove data governance adoption',
    evidenceId: 'ev:governance',
    canonicalKey: 'achievement:governance',
    normalizedData: { action: 'Rolled out governance reviews' }
  })
];

function fixtureIr(options: { exportedAt?: string; displayName?: string } = {}): CareerIR {
  return buildCareerIR({
    profile: {
      id: PROFILE_ID,
      displayName: options.displayName ?? 'Alice Example',
      headline: 'Data platform leader'
    },
    facts: FACTS,
    evidence: EVIDENCE,
    exportedAt: options.exportedAt ?? NOW
  });
}

function achievementIds(ir: CareerIR): string[] {
  return ir.profile.achievements.map((achievement) => achievement.id);
}

function skillIds(ir: CareerIR): string[] {
  return ir.profile.skills.map((skill) => skill.id);
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function repository(): Promise<SQLiteCareerRepository> {
  const directory = await mkdtemp(join(tmpdir(), 'career-compiler-compilation-'));
  temporaryDirectories.push(directory);
  return new SQLiteCareerRepository({ filePath: join(directory, 'career.sqlite') });
}

describe('canonical IR fingerprint', () => {
  it('is stable for the same semantic document regardless of volatile timestamps', () => {
    const first = fixtureIr();
    const rebuilt = fixtureIr({ exportedAt: EVEN_LATER });
    expect(rebuilt.profile.generatedAt).not.toBe(first.profile.generatedAt);
    expect(canonicalIrHash(rebuilt)).toBe(canonicalIrHash(first));
  });

  it('ignores collection order but changes when semantic content changes', () => {
    const ir = fixtureIr();
    const reordered: CareerIR = {
      ...ir,
      facts: [...ir.facts].reverse(),
      evidence: [...ir.evidence].reverse(),
      profile: {
        ...ir.profile,
        achievements: [...ir.profile.achievements].reverse(),
        skills: [...ir.profile.skills].reverse()
      }
    };
    expect(canonicalIrHash(reordered)).toBe(canonicalIrHash(ir));
    expect(canonicalIrHash(fixtureIr({ displayName: 'Alice Updated' }))).not.toBe(
      canonicalIrHash(ir)
    );
  });

  it('excludes non-semantic fact timestamps', () => {
    const ir = fixtureIr();
    const restamped: CareerIR = {
      ...ir,
      facts: ir.facts.map((item) => ({ ...item, updatedAt: EVEN_LATER }))
    };
    expect(canonicalIrHash(restamped)).toBe(canonicalIrHash(ir));
  });
});

describe('structural strategy', () => {
  it('produces the same proposal for the same directives and IR', () => {
    const ir = fixtureIr();
    const [firstAchievement] = achievementIds(ir);
    const strategy = new StructuralCompilationStrategy();
    const first = strategy.propose(
      ir,
      { directives: { hideAchievementIds: [firstAchievement!] } },
      { now: NOW }
    );
    const second = strategy.propose(
      ir,
      { directives: { hideAchievementIds: [firstAchievement!] } },
      { now: EVEN_LATER }
    );
    expect(second.id).toBe(first.id);
    expect(second.operations).toEqual(first.operations);
    expect(second.baseIrHash).toBe(first.baseIrHash);
    expect(second.createdAt).not.toBe(first.createdAt);
    expect(validateResumePatchProposal(second)).toEqual(second);

    const different = strategy.propose(
      ir,
      {
        directives: {
          sectionOrder: ['achievements', 'summary', 'experience', 'projects', 'skills']
        }
      },
      { now: NOW }
    );
    expect(different.id).not.toBe(first.id);
  });

  it('rejects unknown ids, contradictions and incomplete section orders', () => {
    const ir = fixtureIr();
    const strategy = new StructuralCompilationStrategy();
    const proposal = strategy.propose(
      ir,
      { directives: { hideAchievementIds: [achievementIds(ir)[0]!] } },
      { now: NOW }
    );

    expect(() =>
      strategy.propose(ir, { directives: { selectAchievementIds: ['achievement_missing'] } })
    ).toThrow(/unknown achievement id/);
    expect(() =>
      strategy.propose(ir, { directives: { emphasizedSkillIds: ['skill_missing'] } })
    ).toThrow(/unknown skill id/);
    expect(() =>
      strategy.propose(ir, {
        directives: {
          selectAchievementIds: [achievementIds(ir)[0]!],
          hideAchievementIds: [achievementIds(ir)[0]!]
        }
      })
    ).toThrow(/select and hide the same achievement/);
    expect(() =>
      strategy.propose(ir, {
        directives: {
          achievementOrder: [achievementIds(ir)[0]!],
          hideAchievementIds: [achievementIds(ir)[0]!]
        }
      })
    ).toThrow(/must not contain hidden achievement/);
    expect(() =>
      strategy.propose(ir, {
        directives: { sectionOrder: ['summary', 'experience'] as unknown as ResumeSectionId[] }
      })
    ).toThrow(/every resume section exactly once/);
    expect(() => strategy.propose(ir, { directives: {} })).toThrow(/at least one directive/);

    expect(proposal.status).toBe('draft');
  });
});

describe('apply / reject / revert', () => {
  it('creates a variant and a rollback snapshot without touching Career Truth', async () => {
    const repo = await repository();
    const ir = fixtureIr();
    const strategy = new StructuralCompilationStrategy();
    const proposal = strategy.propose(
      ir,
      {
        targetJobId: 'targetjob_1',
        directives: {
          hideAchievementIds: [achievementIds(ir)[0]!],
          sectionOrder: ['skills', 'achievements', 'projects', 'experience', 'summary']
        }
      },
      { now: NOW }
    );
    repo.saveResumePatchProposal(proposal);

    const storedBefore = repo.listFacts();
    const result = applyResumePatchProposal(proposal, ir, repo, { now: LATER });

    expect(result.proposal.status).toBe('applied');
    expect(result.proposal.appliedAt).toBe(LATER);
    expect(result.variant.revision).toBe(1);
    expect(result.variant.targetJobId).toBe('targetjob_1');
    expect(result.variant.baseIrHash).toBe(canonicalIrHash(ir));
    expect(result.snapshot.previous).toBeNull();
    expect(result.snapshot.proposalId).toBe(proposal.id);
    expect(result.variant.view.hiddenAchievementIds).toEqual([achievementIds(ir)[0]]);
    expect(result.variant.view.sectionOrder[0]).toBe('skills');

    // Career Truth is untouched: same facts in storage and an unchanged input IR.
    expect(repo.listFacts()).toEqual(storedBefore);
    expect(ir).toEqual(fixtureIr());
    expect(repo.getResumePatchProposal(proposal.id)?.status).toBe('applied');
    expect(repo.findResumeVariantByTargetJob('targetjob_1')).toEqual(result.variant);
    repo.close();
  });

  it('appends revisions for the same target and supports a single-step revert', async () => {
    const repo = await repository();
    const ir = fixtureIr();
    const strategy = new StructuralCompilationStrategy();
    const first = strategy.propose(
      ir,
      { targetJobId: 'targetjob_1', directives: { hideAchievementIds: [achievementIds(ir)[0]!] } },
      { now: NOW }
    );
    const second = strategy.propose(
      ir,
      { targetJobId: 'targetjob_1', directives: { emphasizedSkillIds: [skillIds(ir)[0]!] } },
      { now: NOW }
    );
    repo.saveResumePatchProposal(first);
    repo.saveResumePatchProposal(second);

    const appliedFirst = applyResumePatchProposal(first, ir, repo, { now: LATER });
    const appliedSecond = applyResumePatchProposal(second, ir, repo, { now: EVEN_LATER });

    expect(appliedSecond.variant.id).toBe(appliedFirst.variant.id);
    expect(appliedSecond.variant.revision).toBe(2);
    expect(appliedSecond.snapshot.previous?.revision).toBe(1);
    expect(appliedSecond.snapshot.previous?.proposalId).toBe(first.id);
    expect(repo.listResumeVariants()).toHaveLength(1);

    // Only the newest apply of a variant can be reverted.
    expect(() => revertCompilationSnapshot(appliedFirst.snapshot, repo)).toThrow(
      /not the latest apply/
    );

    const reverted = revertCompilationSnapshot(appliedSecond.snapshot, repo, { now: NOW });
    expect(reverted.deleted).toBe(false);
    expect(reverted.variant?.revision).toBe(1);
    expect(reverted.variant?.proposalId).toBe(first.id);
    expect(reverted.proposal.status).toBe('draft');
    expect(repo.getCompilationSnapshot(appliedSecond.snapshot.id)).toBeUndefined();

    const revertedFirst = revertCompilationSnapshot(appliedFirst.snapshot, repo, { now: NOW });
    expect(revertedFirst.deleted).toBe(true);
    expect(revertedFirst.variant).toBeUndefined();
    expect(repo.findResumeVariantByTargetJob('targetjob_1')).toBeUndefined();
    expect(repo.getResumePatchProposal(first.id)?.status).toBe('draft');
    repo.close();
  });

  it('rejects stale proposals and non-draft transitions', async () => {
    const repo = await repository();
    const ir = fixtureIr();
    const strategy = new StructuralCompilationStrategy();
    const proposal = strategy.propose(
      ir,
      { directives: { hideAchievementIds: [achievementIds(ir)[0]!] } },
      { now: NOW }
    );
    repo.saveResumePatchProposal(proposal);

    const changedIr = fixtureIr({ displayName: 'Alice Updated' });
    expect(() => applyResumePatchProposal(proposal, changedIr, repo)).toThrow(/is stale/);

    const applied = applyResumePatchProposal(proposal, ir, repo, { now: LATER });
    expect(() => applyResumePatchProposal(applied.proposal, ir, repo)).toThrow(/only draft/);
    expect(() => rejectResumePatchProposal(applied.proposal, repo)).toThrow(/only draft/);
    repo.close();
  });

  it('rejects a proposal without touching variants', async () => {
    const repo = await repository();
    const ir = fixtureIr();
    const strategy = new StructuralCompilationStrategy();
    const proposal = strategy.propose(
      ir,
      { targetJobId: 'targetjob_1', directives: { hideAchievementIds: [achievementIds(ir)[0]!] } },
      { now: NOW }
    );
    repo.saveResumePatchProposal(proposal);
    const rejected = rejectResumePatchProposal(proposal, repo, { now: LATER });

    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectedAt).toBe(LATER);
    expect(repo.listResumeVariants()).toEqual([]);
    expect(repo.listCompilationSnapshots()).toEqual([]);
    repo.close();
  });

  it('round-trips proposals, variants and snapshots through SQLite', async () => {
    const repo = await repository();
    const ir = fixtureIr();
    const strategy = new StructuralCompilationStrategy();
    const proposal = strategy.propose(
      ir,
      { targetJobId: 'targetjob_1', directives: { hideAchievementIds: [achievementIds(ir)[0]!] } },
      { now: NOW }
    );
    repo.saveResumePatchProposal(proposal);
    const applied = applyResumePatchProposal(proposal, ir, repo, { now: LATER });

    expect(repo.getResumePatchProposal(proposal.id)).toEqual(applied.proposal);
    expect(repo.getResumeVariant(applied.variant.id)).toEqual(applied.variant);
    expect(repo.getCompilationSnapshot(applied.snapshot.id)).toEqual(applied.snapshot);
    repo.close();
  });
});

describe('view projection and rendering', () => {
  it('applies selection, ordering and emphasis as a pure projection', () => {
    const ir = fixtureIr();
    const [firstAchievement, secondAchievement] = achievementIds(ir);
    const [firstSkill, secondSkill] = skillIds(ir);
    const operations: ResumePatchOperation[] = [
      { op: 'hide-achievement', achievementId: firstAchievement!, reason: 'noise' },
      { op: 'reorder-achievements', achievementIds: [secondAchievement!], reason: 'priority' },
      { op: 'emphasize-skill', skillId: secondSkill!, reason: 'relevance' }
    ];
    const view = normalizeResumeViewConfig(ir, operations);
    const projected = applyResumeViewConfig(ir, view);

    expect(projected.profile.achievements.map((item) => item.id)).toEqual([secondAchievement]);
    expect(projected.profile.skills.map((item) => item.id)).toEqual([
      secondSkill,
      firstSkill
    ]);
    // The projection copies content instead of mutating Career Truth.
    expect(ir.profile.achievements).toHaveLength(2);
    expect(ir.profile.skills.map((item) => item.id)).toEqual([firstSkill, secondSkill]);
  });

  it('renders the default view identically to the default template', () => {
    const ir = fixtureIr();
    const renderer = new ResumeMarkdownRenderer();
    expect(renderer.render(ir, { view: defaultResumeView() }).content).toBe(
      renderer.render(ir).content
    );
  });

  it('renders section order/visibility, achievement selection and skill emphasis', () => {
    const ir = fixtureIr();
    const [firstAchievement] = achievementIds(ir);
    const emphasizedSkill = skillIds(ir)[1]!;
    const view = normalizeResumeViewConfig(ir, [
      {
        op: 'set-section-order',
        sections: ['achievements', 'skills', 'summary', 'experience', 'projects'],
        reason: 'target emphasis'
      },
      {
        op: 'set-section-visibility',
        section: 'projects',
        visible: false,
        reason: 'not relevant for this target'
      },
      { op: 'hide-achievement', achievementId: firstAchievement!, reason: 'noise' },
      { op: 'emphasize-skill', skillId: emphasizedSkill, reason: 'relevance' }
    ]);
    const content = new ResumeMarkdownRenderer().render(ir, { view }).content;

    expect(content.indexOf('## Achievements')).toBeLessThan(content.indexOf('## Skills'));
    expect(content.indexOf('## Skills')).toBeLessThan(content.indexOf('## Summary'));
    expect(content).not.toContain('## Projects');
    expect(content).not.toContain('Built the lineage platform');
    const skillsBlock = content.slice(
      content.indexOf('## Skills'),
      content.indexOf('## Summary')
    );
    expect(skillsBlock).toContain('- Kafka');
    expect(skillsBlock.indexOf('- Kafka')).toBeLessThan(skillsBlock.indexOf('- Flink'));

    expect(() =>
      new ResumeMarkdownRenderer().render(ir, {
        view,
        template: '# {{name}}\n'
      })
    ).toThrow(/view and template cannot be combined/);
  });

  it('rejects views that reference content outside the base IR', () => {
    const ir = fixtureIr();
    expect(() =>
      normalizeResumeViewConfig(ir, [
        { op: 'hide-achievement', achievementId: 'achievement_missing', reason: 'noise' }
      ])
    ).toThrow(/unknown achievement id/);
    expect(() =>
      applyResumeViewConfig(ir, { ...defaultResumeView(), hiddenAchievementIds: ['missing'] })
    ).toThrow(/unknown achievement id/);
  });

  it('fails closed when a view selects and hides the same achievement', () => {
    const ir = fixtureIr();
    const [firstAchievement] = achievementIds(ir);
    expect(() =>
      normalizeResumeViewConfig(ir, [
        { op: 'hide-achievement', achievementId: firstAchievement!, reason: 'noise' },
        { op: 'select-achievement', achievementId: firstAchievement!, reason: 'keep' }
      ])
    ).toThrow(/select and hide|must not contain hidden/);
  });
});
