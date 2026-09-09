import type {
  CareerEvidence,
  CareerFact,
  CareerSource,
  JsonObject,
  SourceRunContext
} from '@career-compiler/core';
import {
  assertConfidence,
  createEvidenceId,
  createStableId,
  isJsonObject
} from '@career-compiler/core';

export interface ManualChatRequest {
  text: string;
  conversationId?: string;
  observedAt?: string;
}

export interface ChatDiscovery {
  request: ManualChatRequest;
}

export interface ChatScan {
  text: string;
  conversationId: string;
  observedAt?: string;
}

export interface AIProviderRequest {
  purpose: 'career-fact-extraction';
  evidenceId: string;
  evidenceType: string;
  normalizedEvidence: JsonObject;
}

export interface AIProvider {
  readonly providerId: string;
  generate(request: AIProviderRequest): Promise<unknown>;
}

export interface FactExtractionCandidate {
  type: string;
  statement: string;
  normalizedData: JsonObject;
  confidence: number;
  canonicalKey?: string;
}

export interface FactExtractionOutput {
  facts: FactExtractionCandidate[];
  providerId: string;
}

export interface FactExtractor {
  extract(evidence: CareerEvidence): Promise<FactExtractionOutput>;
}

export class FactExtractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactExtractionValidationError';
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asText(evidence: CareerEvidence): string {
  return stringValue(evidence.normalized.text) ?? stringValue(evidence.raw.text) ?? '';
}

export function validateFactExtractionOutput(value: unknown): FactExtractionOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FactExtractionValidationError('Fact extraction output must be an object');
  }
  const record = value as Record<string, unknown>;
  const providerId = stringValue(record.providerId) ?? 'unknown-provider';
  if (!Array.isArray(record.facts)) {
    throw new FactExtractionValidationError('Fact extraction output.facts must be an array');
  }
  const facts: FactExtractionCandidate[] = [];
  for (const [index, item] of record.facts.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new FactExtractionValidationError(`facts[${index}] must be an object`);
    }
    const candidate = item as Record<string, unknown>;
    const type = stringValue(candidate.type);
    const statement = stringValue(candidate.statement);
    if (!type || !statement || !isJsonObject(candidate.normalizedData)) {
      throw new FactExtractionValidationError(
        `facts[${index}] requires type, statement and object normalizedData`
      );
    }
    if (typeof candidate.confidence !== 'number') {
      throw new FactExtractionValidationError(`facts[${index}].confidence must be a number`);
    }
    try {
      assertConfidence(candidate.confidence, `facts[${index}].confidence`);
    } catch (error) {
      throw new FactExtractionValidationError(error instanceof Error ? error.message : String(error));
    }
    facts.push({
      type,
      statement,
      normalizedData: candidate.normalizedData,
      confidence: candidate.confidence,
      ...(stringValue(candidate.canonicalKey)
        ? { canonicalKey: stringValue(candidate.canonicalKey) }
        : {})
    });
  }
  return { facts, providerId };
}

export class ManualChatSource implements CareerSource<ManualChatRequest, ChatDiscovery, ChatScan> {
  readonly sourceType = 'chat' as const;

  async discover(request: ManualChatRequest, _context: SourceRunContext): Promise<ChatDiscovery> {
    if (!request.text.trim()) {
      throw new Error('Manual/chat source requires non-empty text');
    }
    return { request: { ...request, text: request.text.trim() } };
  }

  async scan(discovery: ChatDiscovery, _context?: SourceRunContext): Promise<ChatScan> {
    return {
      text: discovery.request.text,
      conversationId: discovery.request.conversationId ?? createStableId('conversation', discovery.request.text),
      ...(discovery.request.observedAt ? { observedAt: discovery.request.observedAt } : {})
    };
  }

  async extractEvidence(scan: ChatScan, context: SourceRunContext): Promise<CareerEvidence[]> {
    const sourceId = `conversation:${scan.conversationId}`;
    return [
      {
        id: createEvidenceId(this.sourceType, sourceId, 'conversation'),
        sourceType: this.sourceType,
        sourceId,
        evidenceType: 'conversation',
        raw: {
          text: scan.text,
          conversationId: scan.conversationId
        },
        normalized: {
          text: scan.text,
          conversationId: scan.conversationId
        },
        ...(scan.observedAt ? { observedAt: scan.observedAt } : {}),
        discoveredAt: context.now,
        contentHash: createStableId('content', scan.text)
      }
    ];
  }
}

function sentenceAround(text: string, match: RegExpMatchArray): string {
  const start = Math.max(0, text.lastIndexOf('\n', match.index ?? 0) + 1);
  const endCandidates = [
    text.indexOf('.', (match.index ?? 0) + match[0].length),
    text.indexOf('。', (match.index ?? 0) + match[0].length),
    text.indexOf('\n', (match.index ?? 0) + match[0].length)
  ].filter((index) => index >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) + 1 : text.length;
  return text.slice(start, end).trim();
}

function extractDeterministicCandidates(text: string): FactExtractionCandidate[] {
  const candidates: FactExtractionCandidate[] = [];
  const teamMatch = text.match(/(?:led|managed|owned|负责|带领|管理|领导)[^。.!\n]{0,50}?(\d+)\s*(?:-\s*person|person|people|人)/i);
  if (teamMatch) {
    const teamSize = numberValue(Number(teamMatch[1]));
    if (teamSize !== undefined) {
      candidates.push({
        type: 'experience',
        statement: sentenceAround(text, teamMatch),
        normalizedData: {
          role: 'Data platform team leadership',
          teamSize,
          domain: 'data platform'
        },
        confidence: 0.86,
        canonicalKey: `experience:team-leadership:${teamSize}`
      });
    }
  }

  const upstreamMatch = text.match(/(?:more than|over|超过|上游)\s*(\d+)\s*(?:\+|多?个?)?\s*(?:upstream systems?|上游系统|系统)/i);
  const downstreamMatch = text.match(/(?:more than|over|超过|下游)\s*(\d+)\s*(?:\+|多?个?)?\s*(?:downstream systems?|下游系统|系统)/i);
  const builtMatch = text.match(/(?:built|created|developed|打造|建设|构建)[^。.!\n]{0,140}/i);
  if (upstreamMatch || downstreamMatch) {
    const upstreamSystems = upstreamMatch ? numberValue(Number(upstreamMatch[1])) : undefined;
    const downstreamSystems = downstreamMatch ? numberValue(Number(downstreamMatch[1])) : undefined;
    const metricParts = [
      upstreamSystems === undefined ? undefined : `${upstreamSystems}+ upstream systems`,
      downstreamSystems === undefined ? undefined : `${downstreamSystems}+ downstream systems`
    ].filter((part): part is string => Boolean(part));
    candidates.push({
      type: 'achievement',
      statement: builtMatch ? sentenceAround(text, builtMatch) : sentenceAround(text, upstreamMatch ?? downstreamMatch!),
      normalizedData: {
        ...(upstreamSystems === undefined ? {} : { upstreamSystems }),
        ...(downstreamSystems === undefined ? {} : { downstreamSystems }),
        metric: metricParts.join(', ')
      },
      confidence: 0.84,
      canonicalKey: `achievement:systems:${upstreamSystems ?? 'na'}:${downstreamSystems ?? 'na'}`
    });
  }

  if (candidates.length === 0 && text.trim()) {
    candidates.push({
      type: 'experience',
      statement: text.trim(),
      normalizedData: { source: 'manual-chat' },
      confidence: 0.55,
      canonicalKey: `conversation:${createStableId('claim', text.trim())}`
    });
  }
  return candidates;
}

export class DeterministicFactExtractor implements FactExtractor {
  readonly providerId = 'deterministic-mock';

  async extract(evidence: CareerEvidence): Promise<FactExtractionOutput> {
    return {
      providerId: this.providerId,
      facts: extractDeterministicCandidates(asText(evidence))
    };
  }
}

export class ProviderFactExtractor implements FactExtractor {
  constructor(private readonly provider: AIProvider) {}

  async extract(evidence: CareerEvidence): Promise<FactExtractionOutput> {
    const response = await this.provider.generate({
      purpose: 'career-fact-extraction',
      evidenceId: evidence.id,
      evidenceType: evidence.evidenceType,
      normalizedEvidence: evidence.normalized
    });
    const validated = validateFactExtractionOutput(response);
    return { ...validated, providerId: this.provider.providerId };
  }
}

export function extractionToCandidateFacts(
  evidence: CareerEvidence,
  output: FactExtractionOutput,
  now: string
): CareerFact[] {
  const validated = validateFactExtractionOutput(output);
  return validated.facts.map((candidate, index) => {
    const canonicalKey = candidate.canonicalKey ?? `${evidence.id}:${candidate.type}:${index}`;
    return {
      id: createStableId('fact', canonicalKey),
      type: candidate.type,
      statement: candidate.statement,
      normalizedData: candidate.normalizedData,
      status: 'candidate',
      confidence: candidate.confidence,
      evidenceRefs: [{ evidenceId: evidence.id, relation: 'derived-from', weight: candidate.confidence }],
      canonicalKey,
      createdAt: now,
      updatedAt: now
    };
  });
}

/** Static provider used in tests and fixtures without binding Core to an LLM vendor. */
export class MockAIProvider implements AIProvider {
  readonly providerId = 'mock';

  constructor(private readonly response: unknown = { providerId: 'mock', facts: [] }) {}

  async generate(_request: AIProviderRequest): Promise<unknown> {
    return this.response;
  }
}

export const ALICE_CONVERSATION =
  'I led a 12-person data platform team and built a lineage platform supporting more than 80 upstream systems.';

export function createAliceChatFixtureEvidence(
  discoveredAt = '2025-01-15T00:00:00.000Z'
): CareerEvidence {
  const conversationId = 'alice-lineage-leadership';
  return {
    id: createEvidenceId('chat', `conversation:${conversationId}`, 'conversation'),
    sourceType: 'chat',
    sourceId: `conversation:${conversationId}`,
    evidenceType: 'conversation',
    raw: {
      text: ALICE_CONVERSATION,
      conversationId
    },
    normalized: {
      text: ALICE_CONVERSATION,
      conversationId
    },
    observedAt: '2025-01-10T12:00:00.000Z',
    discoveredAt,
    contentHash: createStableId('content', ALICE_CONVERSATION)
  };
}
