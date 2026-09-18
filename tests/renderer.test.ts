import { describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  confirmCareerFact,
  deriveCandidateFacts,
  type CareerEvidence,
  type CareerFact
} from '@career-compiler/core';
import { renderGitHubProfile } from '@career-compiler/renderer-github-profile';
import { renderResume } from '@career-compiler/renderer-resume';
import { createAliceGitHubFixtureEvidence } from '@career-compiler/source-github';

describe('Markdown renderers', () => {
  const evidence = createAliceGitHubFixtureEvidence('2025-01-15T00:00:00.000Z');
  const candidates = deriveCandidateFacts(evidence);
  const facts = candidates.map((candidate) =>
    confirmCareerFact(candidate, '2025-01-15T00:00:00.000Z', 'fixture')
  );
  const ir = buildCareerIR({
    profile: {
      id: 'alice',
      displayName: 'Alice Example',
      headline: 'Data platform leader',
      about: 'Builds dependable lineage systems.'
    },
    facts,
    evidence,
    exportedAt: '2025-01-15T00:00:00.000Z'
  });

  it('produces deterministic resume output', () => {
    const first = renderResume(ir).content;
    const second = renderResume(ir).content;
    expect(first).toBe(second);
    expect(first).toContain('## Summary');
    expect(first).toContain('## Projects');
    expect(first).toContain('data-lineage-toolkit');
    expect(first).toContain('- TypeScript');
  });

  it('produces a GitHub profile with reusable template tokens', () => {
    const artifact = renderGitHubProfile(ir, {
      template: '# {{name}}\n\n{{projects}}\n'
    });
    expect(artifact.content).toContain('# Alice Example');
    expect(artifact.content).toContain('data-lineage-toolkit');
    expect(artifact.content).not.toContain('{{');
  });

  it('renders achievement units with traceable components', () => {
    const now = '2025-01-15T00:00:00.000Z';
    const projectEvidence: CareerEvidence = {
      id: 'chat:conversation:project',
      sourceType: 'chat',
      sourceId: 'conversation:project',
      evidenceType: 'conversation',
      raw: { text: 'I maintain data-lineage-toolkit.' },
      normalized: { text: 'I maintain data-lineage-toolkit.' },
      discoveredAt: now
    };
    const achievementEvidence: CareerEvidence = {
      id: 'chat:conversation:achievement',
      sourceType: 'chat',
      sourceId: 'conversation:achievement',
      evidenceType: 'conversation',
      raw: { text: 'Cut lineage onboarding time from six weeks to one week.' },
      normalized: { text: 'Cut lineage onboarding time from six weeks to one week.' },
      discoveredAt: now
    };
    const projectFact = confirmCareerFact(
      {
        id: 'fact_project_render',
        type: 'project',
        statement: 'Maintains data-lineage-toolkit',
        normalizedData: { name: 'data-lineage-toolkit' },
        status: 'candidate',
        confidence: 0.8,
        evidenceRefs: [{ evidenceId: projectEvidence.id, relation: 'supports', weight: 1 }],
        canonicalKey: 'project:data-lineage-toolkit',
        createdAt: now,
        updatedAt: now
      },
      now,
      'test'
    );
    const achievementFact: CareerFact = confirmCareerFact(
      {
        id: 'fact_achievement_render',
        type: 'achievement',
        statement: 'Cut lineage onboarding time from six weeks to one week',
        normalizedData: {
          projectKey: 'project:data-lineage-toolkit',
          problem: 'Upstream metadata was inconsistent',
          result: 'Onboarding dropped to one week',
          metric: '6 weeks to 1 week'
        },
        status: 'candidate',
        confidence: 0.8,
        evidenceRefs: [
          { evidenceId: achievementEvidence.id, relation: 'derived-from', weight: 0.8 }
        ],
        canonicalKey: 'achievement:block:render',
        createdAt: now,
        updatedAt: now
      },
      now,
      'test'
    );
    const structuredIR = buildCareerIR({
      profile: { id: 'alice', displayName: 'Alice Example' },
      facts: [achievementFact, projectFact],
      evidence: [projectEvidence, achievementEvidence],
      exportedAt: now
    });
    const content = renderResume(structuredIR).content;
    expect(content).toContain(
      '- Cut lineage onboarding time from six weeks to one week (6 weeks to 1 week)'
    );
    expect(content).toContain('  - Problem: Upstream metadata was inconsistent');
    expect(content).toContain('  - Result: Onboarding dropped to one week');

    // Every rendered achievement statement must trace back to confirmed facts and evidence.
    for (const achievement of structuredIR.profile.achievements) {
      expect(content).toContain(`- ${achievement.statement}`);
      for (const reference of achievement.factRefs) {
        const fact = structuredIR.facts.find((item) => item.id === reference.factId);
        expect(fact?.status).toBe('confirmed');
        for (const evidenceRef of fact?.evidenceRefs ?? []) {
          expect(structuredIR.evidence.map((item) => item.id)).toContain(evidenceRef.evidenceId);
        }
      }
    }

    // Profile-only convenience input stays supported for renderers.
    expect(() => renderResume(structuredIR.profile)).not.toThrow();
  });
});
