import type {
  AiSessionMessage,
  AiSessionParseIssue,
  AiSessionParseResult,
  AiSessionProject,
  AiSessionSourceRef,
  AiSessionToolCall,
  NormalizedAiSession
} from './types.js';

export class AiSessionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiSessionParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function pathValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isoValue(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const time = Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(stringValue).filter((item): item is string => Boolean(item)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function normalizeProject(value: unknown): AiSessionProject {
  if (!isRecord(value)) {
    return {};
  }
  const projectId = stringValue(value.projectId);
  const projectKey = stringValue(value.projectKey);
  const projectName = stringValue(value.projectName);
  const repoPath = pathValue(value.repoPath);
  const repoUrl = stringValue(value.repoUrl);
  const worktreePath = pathValue(value.worktreePath);
  const metadata = isRecord(value.metadata) ? { ...value.metadata } : undefined;
  return {
    ...(projectId ? { projectId } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(projectName ? { projectName } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {})
  };
}

function normalizeToolCalls(value: unknown): AiSessionToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const toolCalls: AiSessionToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const name = stringValue(item.name);
    if (!name) {
      continue;
    }
    const id = stringValue(item.id);
    const args = isRecord(item.arguments) ? { ...item.arguments } : undefined;
    toolCalls.push({
      ...(id ? { id } : {}),
      name,
      ...(args ? { arguments: args } : {})
    });
  }
  return toolCalls;
}

function normalizeSourceRef(
  value: unknown,
  fallback: { source: string; sessionId: string; timestamp: string }
): AiSessionSourceRef {
  const record = isRecord(value) ? value : {};
  const source = stringValue(record.source) ?? fallback.source;
  const sourceSessionId = stringValue(record.sourceSessionId) ?? fallback.sessionId;
  const sourceRecordId = stringValue(record.sourceRecordId);
  const sourcePath = pathValue(record.sourcePath);
  const projectPath = pathValue(record.projectPath);
  const lineStart = integerValue(record.lineStart);
  const lineEnd = integerValue(record.lineEnd) ?? lineStart;
  return {
    source,
    sourceSessionId,
    occurredAt: isoValue(record.occurredAt) ?? fallback.timestamp,
    ...(sourceRecordId ? { sourceRecordId } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(projectPath ? { projectPath } : {}),
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {})
  };
}

function normalizeMessage(
  value: unknown,
  sessionSource: string,
  sessionId: string,
  recordIndex: number,
  messageIndex: number,
  issues: AiSessionParseIssue[]
): AiSessionMessage | undefined {
  if (!isRecord(value)) {
    issues.push({ index: recordIndex, sessionId, messageIndex, reason: 'invalid-message' });
    return undefined;
  }
  const role = value.role === 'user' || value.role === 'assistant' ? value.role : undefined;
  const timestamp = isoValue(value.timestamp);
  if (!role || !timestamp) {
    issues.push({ index: recordIndex, sessionId, messageIndex, reason: 'invalid-message' });
    return undefined;
  }
  const text = stringValue(value.text);
  const toolCalls = normalizeToolCalls(value.toolCalls);
  if (!text && toolCalls.length === 0) {
    return undefined;
  }
  const id = stringValue(value.id);
  const model = stringValue(value.model);
  return {
    ...(id ? { id } : {}),
    role,
    ...(text ? { text } : {}),
    timestamp,
    ...(model ? { model } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    sourceRef: normalizeSourceRef(value.sourceRef, { source: sessionSource, sessionId, timestamp })
  };
}

function normalizeSession(
  value: unknown,
  recordIndex: number,
  issues: AiSessionParseIssue[]
): NormalizedAiSession | undefined {
  if (!isRecord(value)) {
    issues.push({ index: recordIndex, reason: 'invalid-session' });
    return undefined;
  }
  const source = stringValue(value.source);
  const sessionId = stringValue(value.sessionId);
  if (!source || !sessionId) {
    issues.push({ index: recordIndex, reason: 'invalid-session' });
    return undefined;
  }
  const rawMessages = Array.isArray(value.messages) ? value.messages : [];
  const messages = rawMessages
    .map((message, messageIndex) =>
      normalizeMessage(message, source, sessionId, recordIndex, messageIndex, issues)
    )
    .filter((message): message is AiSessionMessage => message !== undefined);
  if (messages.length === 0) {
    issues.push({ index: recordIndex, sessionId, reason: 'invalid-session' });
    return undefined;
  }

  const timestamps = messages.map((message) => message.timestamp).sort();
  const startedAt = isoValue(value.startedAt) ?? timestamps[0]!;
  const endedAt = isoValue(value.endedAt) ?? timestamps.at(-1)!;
  const models = stringArray(value.models);
  const toolNames = stringArray(value.toolNames);
  const metadata = isRecord(value.metadata) ? { ...value.metadata } : undefined;

  return {
    source,
    sessionId,
    project: normalizeProject(value.project),
    startedAt: earlier(startedAt, timestamps[0]!),
    endedAt: later(endedAt, timestamps.at(-1)!),
    ...(models.length > 0 ? { models } : {}),
    ...(toolNames.length > 0 ? { toolNames } : {}),
    messages,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {})
  };
}

function earlier(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function later(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/**
 * Stable identity for a normalized message used while merging duplicate session
 * records. Evidence ids additionally keep the message position, so two messages
 * without id / record id / line numbers never collide.
 */
export function aiSessionMessageIdentity(message: AiSessionMessage): string {
  const id = message.id ?? message.sourceRef.sourceRecordId;
  if (id) {
    return `id:${id}`;
  }
  const lineStart = message.sourceRef.lineStart;
  if (lineStart !== undefined) {
    return `line:${lineStart}:${message.sourceRef.lineEnd ?? lineStart}`;
  }
  return `content:${message.role}\u0000${message.timestamp}\u0000${message.text ?? ''}`;
}

export function aiSessionMessageKey(message: AiSessionMessage, index: number): string {
  const identity = aiSessionMessageIdentity(message);
  return identity.startsWith('content:') ? `pos:${index}` : identity;
}

function mergeProject(left: AiSessionProject, right: AiSessionProject): AiSessionProject {
  return {
    projectId: left.projectId ?? right.projectId,
    projectKey: left.projectKey ?? right.projectKey,
    projectName: left.projectName ?? right.projectName,
    repoPath: left.repoPath ?? right.repoPath,
    repoUrl: left.repoUrl ?? right.repoUrl,
    worktreePath: left.worktreePath ?? right.worktreePath,
    ...(left.metadata || right.metadata
      ? { metadata: { ...right.metadata, ...left.metadata } }
      : {})
  };
}

function mergeTwoSessions(
  left: NormalizedAiSession,
  right: NormalizedAiSession
): NormalizedAiSession {
  const seen = new Set<string>();
  const messages: AiSessionMessage[] = [];
  for (const message of [...left.messages, ...right.messages]) {
    const identity = aiSessionMessageIdentity(message);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    messages.push(message);
  }
  messages.sort((a, b) => {
    const byTime = a.timestamp.localeCompare(b.timestamp);
    return byTime !== 0 ? byTime : a.sourceRef.sourceSessionId.localeCompare(b.sourceRef.sourceSessionId);
  });

  const models = [...new Set([...(left.models ?? []), ...(right.models ?? [])])].sort((a, b) =>
    a.localeCompare(b)
  );
  const toolNames = [...new Set([...(left.toolNames ?? []), ...(right.toolNames ?? [])])].sort((a, b) =>
    a.localeCompare(b)
  );
  return {
    source: left.source,
    sessionId: left.sessionId,
    project: mergeProject(left.project, right.project),
    startedAt: earlier(left.startedAt, right.startedAt),
    endedAt: later(left.endedAt, right.endedAt),
    ...(models.length > 0 ? { models } : {}),
    ...(toolNames.length > 0 ? { toolNames } : {}),
    messages,
    ...(left.metadata || right.metadata
      ? { metadata: { ...right.metadata, ...left.metadata } }
      : {})
  };
}

/** Merge partial session records with the same `source:sessionId` without duplicates. */
export function mergeAiSessions(sessions: NormalizedAiSession[]): NormalizedAiSession[] {
  const byKey = new Map<string, NormalizedAiSession>();
  for (const session of sessions) {
    const key = `${session.source}\u0000${session.sessionId}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeTwoSessions(existing, session) : session);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.sessionId.localeCompare(right.sessionId)
  );
}

/**
 * Parse a normalized session bundle. Accepts either `{ sessions: [...] }` or a
 * raw session array. A malformed individual session is reported as an issue and
 * skipped; a malformed bundle shape fails explicitly.
 */
export function parseAiSessionBundle(value: unknown): AiSessionParseResult {
  let records: unknown[];
  if (Array.isArray(value)) {
    records = value;
  } else if (isRecord(value) && Array.isArray(value.sessions)) {
    const schemaVersion = stringValue(value.schemaVersion);
    if (schemaVersion && schemaVersion !== 'ai-session-bundle/1') {
      throw new AiSessionParseError(`Unsupported AI session bundle schema: ${schemaVersion}`);
    }
    records = value.sessions;
  } else {
    throw new AiSessionParseError(
      'AI session bundle must be an array of sessions or an object with a sessions array'
    );
  }

  const issues: AiSessionParseIssue[] = [];
  const sessions: NormalizedAiSession[] = [];
  let skippedRecords = 0;
  records.forEach((record, index) => {
    const session = normalizeSession(record, index, issues);
    if (session) {
      sessions.push(session);
    } else {
      skippedRecords += 1;
    }
  });

  return { sessions: mergeAiSessions(sessions), issues, skippedRecords };
}

/**
 * Parse a JSONL file where each non-empty line is one normalized session
 * record. A corrupt line is reported and skipped instead of failing the scan.
 */
export function parseAiSessionJsonl(text: string): AiSessionParseResult {
  const issues: AiSessionParseIssue[] = [];
  const sessions: NormalizedAiSession[] = [];
  let skippedRecords = 0;
  let lineNumber = 0;

  for (const line of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      issues.push({ index: lineNumber, reason: 'invalid-json' });
      skippedRecords += 1;
      continue;
    }
    const session = normalizeSession(parsed, lineNumber, issues);
    if (session) {
      sessions.push(session);
    } else {
      skippedRecords += 1;
    }
  }

  return { sessions: mergeAiSessions(sessions), issues, skippedRecords };
}

export type AiSessionInputFormat = 'json' | 'jsonl' | 'auto';

export function parseAiSessionText(
  text: string,
  format: AiSessionInputFormat = 'auto'
): AiSessionParseResult {
  if (format === 'jsonl') {
    return parseAiSessionJsonl(text);
  }
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AiSessionParseError(
        `AI session JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return parseAiSessionBundle(parsed);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return parseAiSessionJsonl(text);
  }
  return parseAiSessionBundle(parsed);
}

export function formatFromPath(filePath: string): AiSessionInputFormat {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jsonl')) {
    return 'jsonl';
  }
  if (lower.endsWith('.json')) {
    return 'json';
  }
  return 'auto';
}
