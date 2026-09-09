import { describe, expect, it } from 'vitest';
import {
  DeterministicFactExtractor,
  ManualChatSource,
  MockAIProvider,
  ProviderFactExtractor,
  createAliceChatFixtureEvidence,
  extractionToCandidateFacts,
  validateFactExtractionOutput
} from '@career-compiler/source-chat';

describe('Manual/chat source and extraction', () => {
  it('creates candidate facts from the synthetic conversation', async () => {
    const evidence = createAliceChatFixtureEvidence();
    const output = await new DeterministicFactExtractor().extract(evidence);
    const facts = extractionToCandidateFacts(evidence, output, '2025-01-15T00:00:00.000Z');
    expect(facts.map((fact) => fact.type)).toEqual(['experience', 'achievement']);
    expect(facts.every((fact) => fact.status === 'candidate')).toBe(true);
    expect(facts.every((fact) => fact.evidenceRefs[0]?.evidenceId === evidence.id)).toBe(true);
  });

  it('extracts the documented Chinese input shape deterministically', async () => {
    const source = new ManualChatSource();
    const context = { now: '2025-01-15T00:00:00.000Z' };
    const discovery = await source.discover(
      { text: '我负责一个18人的湖仓团队，上游180多个系统，下游120多个系统。' },
      context
    );
    const scan = await source.scan(discovery, context);
    const evidence = await source.extractEvidence(scan, context);
    const output = await new DeterministicFactExtractor().extract(evidence[0]!);
    const facts = extractionToCandidateFacts(evidence[0]!, output, context.now);

    expect(facts[0]?.normalizedData).toMatchObject({ teamSize: 18 });
    expect(facts[1]?.normalizedData).toMatchObject({ upstreamSystems: 180, downstreamSystems: 120 });
  });

  it('validates provider output before creating facts', async () => {
    const extractor = new ProviderFactExtractor(
      new MockAIProvider({
        providerId: 'mock',
        facts: [
          {
            type: 'skill',
            statement: 'Uses TypeScript',
            normalizedData: { name: 'TypeScript' },
            confidence: 0.7
          }
        ]
      })
    );
    const evidence = createAliceChatFixtureEvidence();
    const output = await extractor.extract(evidence);
    expect(output.providerId).toBe('mock');
    expect(output.facts[0]?.type).toBe('skill');
    expect(() => validateFactExtractionOutput({ facts: [{ type: 'skill' }] })).toThrow();
  });
});
