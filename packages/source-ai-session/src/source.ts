import { readFile } from 'node:fs/promises';
import type { CareerEvidence, CareerSource, SourceRunContext } from '@career-compiler/core';
import {
  aiSessionsToEvidence,
  DEFAULT_AI_SESSION_PRIVACY,
  type AiSessionPrivacyOptions
} from './evidence.js';
import {
  formatFromPath,
  parseAiSessionBundle,
  parseAiSessionText,
  type AiSessionInputFormat
} from './parse.js';
import type { AiSessionParseIssue, NormalizedAiSession } from './types.js';

export interface AiSessionRequest {
  /** Path to a normalized session bundle (`.json`) or JSONL file (`.jsonl`). */
  filePath?: string;
  /** Already-parsed normalized sessions, for callers that do their own IO. */
  sessions?: NormalizedAiSession[];
  /** Inline normalized session bundle value. */
  bundle?: unknown;
  /** Defaults to the file extension, then to `auto`. */
  format?: AiSessionInputFormat;
  privacy?: AiSessionPrivacyOptions;
}

export interface AiSessionDiscovery {
  sessions: NormalizedAiSession[];
  issues: AiSessionParseIssue[];
  skippedRecords: number;
  privacy: Required<AiSessionPrivacyOptions>;
  input: {
    filePath?: string;
    recordCount: number;
  };
}

export type AiSessionScan = AiSessionDiscovery;

/**
 * CareerSource adapter that turns already-normalized local AI sessions
 * (Codex CLI / Claude Code / Pi via AIUsage) into Career Evidence.
 *
 * It deliberately stops at the evidence layer: it does not parse vendor JSONL,
 * does not scan the disk, and never produces or confirms Career Facts.
 */
export class AiSessionSource
  implements CareerSource<AiSessionRequest, AiSessionDiscovery, AiSessionScan>
{
  readonly sourceType = 'ai-session' as const;

  async discover(request: AiSessionRequest, _context?: SourceRunContext): Promise<AiSessionDiscovery> {
    const privacy: Required<AiSessionPrivacyOptions> = {
      ...DEFAULT_AI_SESSION_PRIVACY,
      ...request.privacy
    };
    if (request.sessions) {
      return {
        sessions: request.sessions,
        issues: [],
        skippedRecords: 0,
        privacy,
        input: { recordCount: request.sessions.length }
      };
    }
    if (request.bundle !== undefined) {
      const parsed = parseAiSessionBundle(request.bundle);
      return {
        ...parsed,
        privacy,
        input: { recordCount: parsed.sessions.length + parsed.skippedRecords }
      };
    }
    if (!request.filePath) {
      throw new Error('AI session source requires filePath, bundle or sessions');
    }

    let text: string;
    try {
      text = await readFile(request.filePath, 'utf8');
    } catch (error) {
      throw new Error(
        `AI session file could not be read: ${request.filePath} (${error instanceof Error ? error.message : String(error)})`
      );
    }
    const format = request.format ?? formatFromPath(request.filePath);
    const parsed = parseAiSessionText(text, format);
    return {
      ...parsed,
      privacy,
      input: { filePath: request.filePath, recordCount: parsed.sessions.length + parsed.skippedRecords }
    };
  }

  async scan(discovery: AiSessionDiscovery, _context?: SourceRunContext): Promise<AiSessionScan> {
    return { ...discovery };
  }

  async extractEvidence(scan: AiSessionScan, context: SourceRunContext): Promise<CareerEvidence[]> {
    return aiSessionsToEvidence(scan.sessions, context, scan.privacy);
  }
}
