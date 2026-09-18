/**
 * Input contract for the AI session evidence source.
 *
 * These types intentionally mirror the normalized output that AIUsage already
 * produces from Codex CLI / Claude Code / Pi session logs (`NormalizedSession`,
 * `NormalizedMessage`, `NormalizedToolCall`, `ProjectIdentity`,
 * `MemorySourceReference`). Career Compiler does **not** import
 * `@aiusage/memory-core` (private, source-only export) and does **not** parse
 * vendor JSONL itself: AI session normalization stays upstream, and this
 * contract is the only boundary this adapter depends on.
 */
export const AI_SESSION_BUNDLE_SCHEMA_VERSION = 'ai-session-bundle/1' as const;

export type AiSessionBundleSchemaVersion = typeof AI_SESSION_BUNDLE_SCHEMA_VERSION;

export type AiSessionMessageRole = 'user' | 'assistant';

/** Normalized tool call metadata copied from a local AI session. */
export interface AiSessionToolCall {
  id?: string;
  name: string;
  /**
   * Raw tool arguments are part of the upstream session payload but may contain
   * secrets or credentials. They are kept out of evidence unless the caller
   * explicitly enables `includeToolArguments`.
   */
  arguments?: Record<string, unknown>;
}

/** Provenance reference for one upstream session record. */
export interface AiSessionSourceRef {
  source: string;
  sourceSessionId: string;
  occurredAt: string;
  sourceRecordId?: string;
  sourcePath?: string;
  projectPath?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface AiSessionMessage {
  id?: string;
  role: AiSessionMessageRole;
  text?: string;
  timestamp: string;
  model?: string;
  toolCalls?: AiSessionToolCall[];
  sourceRef: AiSessionSourceRef;
}

/**
 * Project identity as resolved by the upstream scanner.
 *
 * `projectKey` uses the AIUsage canonical form (`remote:...`, `git:...`,
 * `path:...`). `metadata.gitCommonDir` is what lets multiple Git worktrees
 * collapse into one canonical project instead of three separate projects.
 * None of the absolute path fields are copied into exported evidence.
 */
export interface AiSessionProject {
  projectId?: string;
  projectKey?: string;
  projectName?: string;
  repoPath?: string;
  repoUrl?: string;
  worktreePath?: string;
  metadata?: Record<string, unknown>;
}

export interface NormalizedAiSession {
  source: string;
  sessionId: string;
  project: AiSessionProject;
  startedAt: string;
  endedAt: string;
  models?: string[];
  toolNames?: string[];
  messages: AiSessionMessage[];
  metadata?: Record<string, unknown>;
}

export interface AiSessionBundle {
  schemaVersion?: string;
  generatedAt?: string;
  sessions: NormalizedAiSession[];
}

export interface AiSessionParseIssue {
  /** Record position in the input (JSON array index or JSONL line number). */
  index: number;
  sessionId?: string;
  messageIndex?: number;
  reason: AiSessionParseIssueReason;
}

export type AiSessionParseIssueReason =
  | 'invalid-json'
  | 'invalid-session'
  | 'invalid-message'
  | 'unsupported-schema-version';

export interface AiSessionParseResult {
  sessions: NormalizedAiSession[];
  issues: AiSessionParseIssue[];
  /** Number of top-level records that could not be turned into a session. */
  skippedRecords: number;
}
