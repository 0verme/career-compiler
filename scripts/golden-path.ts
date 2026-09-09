import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CareerFact } from '@career-compiler/core';
import {
  buildCareerIR,
  confirmCareerFact,
  deriveCandidateFacts,
  mergeCandidateFacts,
  serializeCareerIR
} from '@career-compiler/core';
import { renderGitHubProfile } from '@career-compiler/renderer-github-profile';
import { renderResume } from '@career-compiler/renderer-resume';
import {
  createAliceChatFixtureEvidence,
  DeterministicFactExtractor,
  extractionToCandidateFacts
} from '@career-compiler/source-chat';
import { createAliceGitHubFixtureEvidence } from '@career-compiler/source-github';
import { createAliceLocalGitFixtureEvidence } from '@career-compiler/source-local-git';

const FIXTURE_TIME = '2025-01-15T00:00:00.000Z';
const fixtureDirectory = resolve('examples/fixtures/alice');
const outputDirectory = resolve('examples/output');

async function writeJson(path: string, value: CareerFact[]): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const githubEvidence = createAliceGitHubFixtureEvidence(FIXTURE_TIME);
const localEvidence = createAliceLocalGitFixtureEvidence(FIXTURE_TIME);
const chatEvidence = createAliceChatFixtureEvidence(FIXTURE_TIME);
const evidence = [...githubEvidence, ...localEvidence, chatEvidence];
const extractor = new DeterministicFactExtractor();
const extraction = await extractor.extract(chatEvidence);
const chatCandidates = extractionToCandidateFacts(chatEvidence, extraction, FIXTURE_TIME);
const sourceCandidates = deriveCandidateFacts([...githubEvidence, ...localEvidence]);
const candidateFacts = mergeCandidateFacts([], [...sourceCandidates, ...chatCandidates]);
const confirmedFacts = candidateFacts.map((fact) =>
  confirmCareerFact(fact, FIXTURE_TIME, 'synthetic-fixture-confirmation')
);
const ir = buildCareerIR({
  profile: {
    id: 'alice',
    displayName: 'Alice Example',
    headline: 'Data platform leader building dependable lineage systems',
    about: 'I build data platforms and turn complex system landscapes into reliable, explainable products.'
  },
  facts: confirmedFacts,
  evidence,
  exportedAt: FIXTURE_TIME
});

await mkdir(fixtureDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });
await writeJson(resolve(fixtureDirectory, 'candidate-facts.json'), candidateFacts);
await writeJson(resolve(fixtureDirectory, 'confirmed-facts.json'), confirmedFacts);
await writeFile(resolve(fixtureDirectory, 'career-ir.json'), serializeCareerIR(ir), 'utf8');
await writeFile(resolve(outputDirectory, 'resume.md'), renderResume(ir).content, 'utf8');
await writeFile(resolve(outputDirectory, 'github-profile.md'), renderGitHubProfile(ir).content, 'utf8');

process.stdout.write(
  `${JSON.stringify(
    {
      profile: ir.profile.id,
      evidence: ir.evidence.length,
      candidateFacts: candidateFacts.length,
      confirmedFacts: confirmedFacts.length,
      outputs: [
        resolve(outputDirectory, 'resume.md'),
        resolve(outputDirectory, 'github-profile.md')
      ]
    },
    null,
    2
  )}\n`
);
