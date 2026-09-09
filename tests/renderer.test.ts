import { describe, expect, it } from 'vitest';
import { buildCareerIR, confirmCareerFact, deriveCandidateFacts } from '@career-compiler/core';
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
});
