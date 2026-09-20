import type { CareerEvidenceRef, CareerFact, SourceType } from './types.js';

/**
 * Stable identity and normalization helpers shared by the fact pipeline, the
 * achievement compiler and the target job domain. Kept separate so every layer
 * can use them without a circular import.
 */
export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createStableId(prefix: string, value: string): string {
  return `${prefix}_${stableHash(value)}`;
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Target Job identity is intentionally not content-derived: editing company,
 * title or the JD text must never produce a new logical target job. New jobs
 * get a fresh id; `hashRawJd` only tracks JD content changes.
 */
export function createTargetJobId(): string {
  return `targetjob_${globalThis.crypto.randomUUID()}`;
}

/**
 * Compilation objects mutate over time (variant revisions, snapshot lifecycle),
 * so their identity is fresh like TargetJob rather than content-derived.
 */
export function createResumeVariantId(): string {
  return `variant_${globalThis.crypto.randomUUID()}`;
}

export function createCompilationSnapshotId(): string {
  return `snapshot_${globalThis.crypto.randomUUID()}`;
}

/**
 * Deterministic content fingerprint for a raw JD. It answers "did the stored
 * text change?", not "which target job is this?". 32-bit FNV-1a matches the
 * existing stable-hash convention; it is a change detector, not a security
 * hash.
 */
export function hashRawJd(rawJd: string): string {
  return stableHash(rawJd);
}

/**
 * Deterministic requirement identity: the same target job revision and quote
 * range always produce the same id, so re-parsing the unchanged raw JD is
 * reproducible and review references stay stable.
 */
export function createJdRequirementId(
  targetJobId: string,
  sourceRawJdHash: string,
  quoteStart: number,
  quoteEnd: number
): string {
  return createStableId('jdreq', `${targetJobId}:${sourceRawJdHash}:${quoteStart}:${quoteEnd}`);
}

export function createEvidenceId(
  sourceType: SourceType,
  sourceId: string,
  evidenceType: string
): string {
  return `${sourceType}:${evidenceType}:${sourceId}`;
}

export function dedupeEvidenceRefs(refs: CareerEvidenceRef[]): CareerEvidenceRef[] {
  const byId = new Map<string, CareerEvidenceRef>();
  for (const ref of refs) {
    const previous = byId.get(ref.evidenceId);
    if (!previous || (ref.weight ?? 0) > (previous.weight ?? 0)) {
      byId.set(ref.evidenceId, { ...ref });
    }
  }
  return [...byId.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

export function projectIdFromFact(fact: CareerFact): string {
  return createStableId('project', fact.canonicalKey ?? fact.id);
}

export function experienceIdFromFact(fact: CareerFact): string {
  return createStableId('experience', fact.canonicalKey ?? fact.id);
}
