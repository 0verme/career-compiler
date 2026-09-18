import type { CareerEvidence, JsonObject, JsonValue, SourceRunContext } from '@career-compiler/core';
import { createEvidenceId, createStableId } from '@career-compiler/core';
import { canonicalizeAiSessionProject, type CanonicalAiSessionProject } from './project.js';
import { aiSessionMessageKey } from './parse.js';
import type { AiSessionMessage, AiSessionSourceRef, AiSessionToolCall, NormalizedAiSession } from './types.js';

export const AI_SESSION_SOURCE_TYPE = 'ai-session';
export const AI_SESSION_EVIDENCE_TYPE = 'ai-session';
export const AI_SESSION_MESSAGE_EVIDENCE_TYPE = 'ai-session-message';

export interface AiSessionPrivacyOptions {
  /**
   * How the absolute session file path is written into evidence.
   *
   * - `relative` (default): keep the AI-tool-relative suffix (for example
   *   `sessions/2025/01/12/rollout.jsonl`) plus a non-reversible path hash.
   * - `absolute`: keep the raw local path (explicit opt-in; it will also enter
   *   Career IR exports).
   * - `omitted`: keep only the non-reversible path hash.
   */
  sourcePath?: 'relative' | 'absolute' | 'omitted';
  /**
   * Copy raw tool call arguments into evidence. Defaults to `false` because
   * tool arguments can contain credentials or secrets.
   */
  includeToolArguments?: boolean;
}

export const DEFAULT_AI_SESSION_PRIVACY: Required<AiSessionPrivacyOptions> = {
  sourcePath: 'relative',
  includeToolArguments: false
};

type ResolvedPrivacy = Required<AiSessionPrivacyOptions>;

const SESSION_ROOT_SEGMENTS = new Set(['sessions', 'projects', 'conversations']);

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    return toJsonObject(value as Record<string, unknown>);
  }
  return undefined;
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const json = toJsonValue(item);
    if (json !== undefined) {
      result[key] = json;
    }
  }
  return result;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function relativeSessionPath(value: string): string {
  const segments = value.replaceAll('\\', '/').split('/').filter(Boolean);
  const marker = segments.findIndex((segment) => SESSION_ROOT_SEGMENTS.has(segment.toLowerCase()));
  const tail = marker >= 0 ? segments.slice(marker) : segments.slice(-1);
  return tail.join('/') || 'unknown';
}

function mapSessionPath(
  value: string | undefined,
  privacy: ResolvedPrivacy
): { sourcePath?: string; sourcePathHash?: string } {
  const path = value?.trim();
  if (!path) {
    return {};
  }
  const sourcePathHash = createStableId('source-path', path.replaceAll('\\', '/'));
  if (privacy.sourcePath === 'omitted') {
    return { sourcePathHash };
  }
  if (privacy.sourcePath === 'absolute') {
    return { sourcePath: path, sourcePathHash };
  }
  return { sourcePath: relativeSessionPath(path), sourcePathHash };
}

function toolCallJson(call: AiSessionToolCall, privacy: ResolvedPrivacy): JsonObject {
  return {
    ...(call.id ? { id: call.id } : {}),
    name: call.name,
    ...(privacy.includeToolArguments && call.arguments
      ? { arguments: toJsonObject(call.arguments) }
      : {})
  };
}

function sourceRefJson(sourceRef: AiSessionSourceRef, privacy: ResolvedPrivacy): JsonObject {
  const path = mapSessionPath(sourceRef.sourcePath, privacy);
  return {
    source: sourceRef.source,
    sourceSessionId: sourceRef.sourceSessionId,
    occurredAt: sourceRef.occurredAt,
    ...(sourceRef.sourceRecordId ? { sourceRecordId: sourceRef.sourceRecordId } : {}),
    ...path,
    ...(sourceRef.lineStart !== undefined ? { lineStart: sourceRef.lineStart } : {}),
    ...(sourceRef.lineEnd !== undefined ? { lineEnd: sourceRef.lineEnd } : {})
  };
}

function projectJson(project: CanonicalAiSessionProject): JsonObject {
  return {
    projectId: project.projectId,
    projectName: project.projectName,
    identityBasis: project.identityBasis,
    ...(project.repoUrl ? { repoUrl: project.repoUrl } : {}),
    ...(project.isWorktree ? { isWorktree: true } : {}),
    ...(project.upstreamProjectId ? { upstreamProjectId: project.upstreamProjectId } : {})
  };
}

function messageContentHash(
  session: NormalizedAiSession,
  message: AiSessionMessage,
  toolCalls: JsonObject[]
): string {
  return createStableId(
    'ai-session-message-content',
    stableStringify({
      source: session.source,
      sessionId: session.sessionId,
      role: message.role,
      timestamp: message.timestamp,
      text: message.text ?? null,
      toolNames: message.toolCalls?.map((call) => call.name) ?? [],
      toolCalls
    })
  );
}

function messageToEvidence(
  session: NormalizedAiSession,
  message: AiSessionMessage,
  index: number,
  project: CanonicalAiSessionProject,
  context: SourceRunContext,
  privacy: ResolvedPrivacy
): CareerEvidence {
  const toolCalls = (message.toolCalls ?? []).map((call) => toolCallJson(call, privacy));
  const key = aiSessionMessageKey(message, index);
  const sourceId = `${session.source}:${session.sessionId}:message:${key}`;
  const sourceRef = sourceRefJson(message.sourceRef, privacy);
  const shared = {
    source: session.source,
    sessionId: session.sessionId,
    messageId: message.id ?? null,
    role: message.role,
    actorRole: message.role,
    timestamp: message.timestamp,
    model: message.model ?? null,
    text: message.text ?? null,
    toolCalls,
    project: projectJson(project),
    sourceRef
  };
  return {
    id: createEvidenceId(AI_SESSION_SOURCE_TYPE, sourceId, AI_SESSION_MESSAGE_EVIDENCE_TYPE),
    sourceType: AI_SESSION_SOURCE_TYPE,
    sourceId,
    evidenceType: AI_SESSION_MESSAGE_EVIDENCE_TYPE,
    raw: toJsonObject(shared),
    normalized: toJsonObject(shared),
    // A local session has no verified link to a career identity yet, so the
    // adapter never claims ownership. User confirmation stays a later step.
    attribution: 'context',
    sourceUri: `ai-session://${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}`,
    observedAt: message.timestamp,
    discoveredAt: context.now,
    contentHash: messageContentHash(session, message, toolCalls)
  };
}

function sessionToEvidence(
  session: NormalizedAiSession,
  project: CanonicalAiSessionProject,
  messageEvidence: CareerEvidence[],
  context: SourceRunContext,
  privacy: ResolvedPrivacy
): CareerEvidence {
  const userMessageCount = session.messages.filter((message) => message.role === 'user').length;
  const assistantMessageCount = session.messages.length - userMessageCount;
  const models = [...new Set(session.models ?? [])].sort((left, right) => left.localeCompare(right));
  const toolNames = [...new Set(session.toolNames ?? [])].sort((left, right) => left.localeCompare(right));
  const sourceRef = sourceRefJson(
    {
      source: session.source,
      sourceSessionId: session.sessionId,
      occurredAt: session.startedAt
    },
    privacy
  );
  const shared = {
    source: session.source,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    models,
    toolNames,
    messageCount: session.messages.length,
    userMessageCount,
    assistantMessageCount,
    project: projectJson(project),
    sourceRef
  };
  return {
    id: createEvidenceId(
      AI_SESSION_SOURCE_TYPE,
      `${session.source}:${session.sessionId}`,
      AI_SESSION_EVIDENCE_TYPE
    ),
    sourceType: AI_SESSION_SOURCE_TYPE,
    sourceId: `${session.source}:${session.sessionId}`,
    evidenceType: AI_SESSION_EVIDENCE_TYPE,
    raw: toJsonObject(shared),
    normalized: toJsonObject(shared),
    attribution: 'context',
    sourceUri: `ai-session://${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}`,
    observedAt: session.endedAt,
    discoveredAt: context.now,
    contentHash: createStableId(
      'ai-session-content',
      stableStringify(messageEvidence.map((item) => [item.id, item.contentHash ?? null]))
    )
  };
}

/**
 * Map normalized sessions to Career Evidence. One session-level plus one
 * message-level evidence is produced per session; nothing here creates or
 * confirms a Career Fact.
 */
export function aiSessionsToEvidence(
  sessions: NormalizedAiSession[],
  context: SourceRunContext,
  privacy: AiSessionPrivacyOptions = {}
): CareerEvidence[] {
  const resolved: ResolvedPrivacy = { ...DEFAULT_AI_SESSION_PRIVACY, ...privacy };
  const evidence: CareerEvidence[] = [];
  for (const session of sessions) {
    const project = canonicalizeAiSessionProject(session.project);
    const messageEvidence = session.messages.map((message, index) =>
      messageToEvidence(session, message, index, project, context, resolved)
    );
    evidence.push(sessionToEvidence(session, project, messageEvidence, context, resolved));
    evidence.push(...messageEvidence);
  }
  return evidence;
}
