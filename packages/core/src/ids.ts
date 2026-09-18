import type { CareerEvidenceRef, CareerFact, SourceType } from './types.js';

/**
 * Stable identity and normalization helpers shared by the fact pipeline and the
 * achievement compiler. Kept separate so both layers can use them without a
 * circular import.
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
