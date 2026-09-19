import type { TargetJob, TargetJobDraft, TargetJobPatch } from './types.js';
import { createTargetJobId, hashRawJd } from './ids.js';
import {
  validateTargetJob,
  validateTargetJobDraft,
  validateTargetJobPatch
} from './validation.js';

// Target Job identity and content hash are part of the public domain contract.
export { createTargetJobId, hashRawJd } from './ids.js';

export interface CreateTargetJobOptions {
  /** Injected for deterministic tests; production callers should omit it. */
  id?: string;
  now?: string;
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Create a TargetJob from user input.
 *
 * The id is fresh and stable for the lifetime of this target context, and
 * `rawJd` is stored verbatim; trimming the JD would make the "re-run the parser
 * on the original input" contract ambiguous.
 */
export function createTargetJob(
  draft: TargetJobDraft,
  options: CreateTargetJobOptions = {}
): TargetJob {
  const validated = validateTargetJobDraft(draft);
  const now = options.now ?? new Date().toISOString();
  const company = normalizeOptionalText(validated.company);
  return validateTargetJob({
    id: options.id ?? createTargetJobId(),
    ...(company ? { company } : {}),
    title: validated.title.trim(),
    rawJd: validated.rawJd,
    rawJdHash: hashRawJd(validated.rawJd),
    createdAt: now,
    updatedAt: now
  });
}

/**
 * Apply a partial update while preserving identity.
 *
 * Only fields present in the patch change; `company: null` clears the company.
 * When the patch does not actually change anything the original job is returned
 * untouched, so `updatedAt` only moves when the target context really changed.
 * `rawJdHash` is always recomputed from the resulting raw JD.
 */
export function updateTargetJob(
  job: TargetJob,
  patch: TargetJobPatch,
  options: { now?: string } = {}
): TargetJob {
  const current = validateTargetJob(job);
  const validatedPatch = validateTargetJobPatch(patch);
  const title = validatedPatch.title !== undefined ? validatedPatch.title.trim() : current.title;
  const company =
    validatedPatch.company !== undefined
      ? normalizeOptionalText(validatedPatch.company)
      : current.company;
  const rawJd = validatedPatch.rawJd ?? current.rawJd;

  if (title === current.title && company === current.company && rawJd === current.rawJd) {
    return current;
  }

  return validateTargetJob({
    id: current.id,
    ...(company ? { company } : {}),
    title,
    rawJd,
    rawJdHash: hashRawJd(rawJd),
    createdAt: current.createdAt,
    updatedAt: options.now ?? new Date().toISOString()
  });
}
