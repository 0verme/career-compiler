import { describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  confirmCareerFact,
  deriveCandidateFacts,
  mergeCandidateFacts,
  type CareerFact
} from '@career-compiler/core';
import { renderResume } from '@career-compiler/renderer-resume';
import {
  createAliceAchievementNotesEvidence,
  createAliceChatFixtureEvidence,
  DeterministicFactExtractor,
  extractionToCandidateFacts
} from '@career-compiler/source-chat';
import { createAliceGitHubFixtureEvidence } from '@career-compiler/source-github';
import { createAliceLocalGitFixtureEvidence } from '@career-compiler/source-local-git';

const NOW = '2025-01-15T00:00:00.000Z';

describe('Alice golden path: Evidence → Fact → Achievement → Career IR → Resume', () => {
  it('compiles confirmed achievements with traceable provenance and no candidate leakage', async () => {
    const githubEvidence = createAliceGitHubFixtureEvidence(NOW);
    const localEvidence = createAliceLocalGitFixtureEvidence(NOW);
    const chatEvidence = [
      createAliceChatFixtureEvidence(NOW),
      createAliceAchievementNotesEvidence(NOW)
    ];
    const evidence = [...githubEvidence, ...localEvidence, ...chatEvidence];
    const extractor = new DeterministicFactExtractor();
    const chatCandidates: CareerFact[] = [];
    for (const item of chatEvidence) {
      const extraction = await extractor.extract(item);
      chatCandidates.push(...extractionToCandidateFacts(item, extraction, NOW));
    }
    const candidateFacts = mergeCandidateFacts([], [
      ...deriveCandidateFacts([...githubEvidence, ...localEvidence]),
      ...chatCandidates
    ]);
    const confirmedFacts = candidateFacts.map((fact) =>
      confirmCareerFact(fact, NOW, 'golden-path-test')
    );
    const profile = { id: 'alice', displayName: 'Alice Example' };
    const ir = buildCareerIR({ profile, facts: confirmedFacts, evidence, exportedAt: NOW });
    const resume = renderResume(ir).content;

    // Confirmed facts produce achievements that stay traceable to facts and evidence.
    expect(ir.schemaVersion).toBe('0.2');
    expect(ir.profile.achievements.length).toBeGreaterThanOrEqual(3);
    for (const achievement of ir.profile.achievements) {
      expect(achievement.status).toBe('confirmed');
      expect(achievement.factRefs.length).toBeGreaterThan(0);
      expect(achievement.evidenceRefs.length).toBeGreaterThan(0);
      expect(resume).toContain(`- ${achievement.statement}`);
      for (const reference of achievement.factRefs) {
        const fact = ir.facts.find((item) => item.id === reference.factId);
        expect(fact?.status).toBe('confirmed');
        for (const evidenceRef of fact?.evidenceRefs ?? []) {
          expect(ir.evidence.map((item) => item.id)).toContain(evidenceRef.evidenceId);
        }
      }
    }

    // One project can carry multiple achievements.
    const projectId = ir.profile.projects[0]?.id;
    expect(projectId).toBeDefined();
    expect(
      ir.profile.achievements.filter((achievement) => achievement.projectId === projectId)
    ).toHaveLength(2);

    // Candidate-only content never becomes a formal achievement or resume statement.
    const draftIR = buildCareerIR({
      profile,
      facts: candidateFacts,
      evidence,
      exportedAt: NOW
    });
    expect(draftIR.profile.achievements).toEqual([]);
    expect(renderResume(draftIR).content).not.toContain('Cut lineage onboarding time');

    // Structured components are copied verbatim from the user-provided notes.
    const onboarding = ir.profile.achievements.find((achievement) =>
      achievement.statement.startsWith('Cut lineage onboarding time')
    );
    expect(onboarding?.problem).toBe(
      'Upstream metadata was inconsistent and column-level lineage was unreliable'
    );
    expect(onboarding?.result).toBe(
      'New upstream systems reached trusted lineage in under one week'
    );
  });
});
