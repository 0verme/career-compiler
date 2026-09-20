import { createHash } from 'node:crypto';
import type {
  CareerAchievement,
  CareerEvidence,
  CareerEvidenceRef,
  CareerFact,
  CareerIR,
  CareerProfile,
  JsonValue,
  ResumePatchOperation
} from './types.js';

/**
 * Canonical serialization and semantic fingerprints.
 *
 * The existing `stableHash` (32-bit FNV-1a) remains a change detector for target
 * job raw text and legacy stable ids. Compilation needs stronger semantics:
 * `baseIrHash` addresses a CareerIR revision, so it must be a canonical
 * serialization of the semantic document and a SHA-256 digest. FNV-1a is
 * explicitly not used here.
 */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = canonicalize(item);
      }
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON: object keys sorted recursively, array order preserved. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Content-addressed identity for generated documents. Uses SHA-256 instead of
 * the legacy 32-bit `createStableId` because proposal identity must not collide
 * across different operation sets.
 */
export function createContentId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Hex(canonicalStringify(value)).slice(0, 16)}`;
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalEvidenceRefs(refs: CareerEvidenceRef[]): CareerEvidenceRef[] {
  return [...refs]
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .map((ref) => ({ ...ref }));
}

function canonicalAchievement(achievement: CareerAchievement): unknown {
  return {
    ...achievement,
    factRefs: [...achievement.factRefs]
      .sort((left, right) => left.factId.localeCompare(right.factId))
      .map((ref) => ({ ...ref, contributes: [...ref.contributes].sort() })),
    evidenceRefs: canonicalEvidenceRefs(achievement.evidenceRefs)
  };
}

function canonicalProfile(profile: CareerProfile): unknown {
  return {
    ...profile,
    identity:
      profile.identity === undefined
        ? undefined
        : {
            sources: [...profile.identity.sources]
              .sort((left, right) =>
                `${left.provider}:${left.externalId}`.localeCompare(
                  `${right.provider}:${right.externalId}`
                )
              )
              .map((source) => ({
                ...source,
                ...(source.names ? { names: [...source.names].sort() } : {}),
                ...(source.emails ? { emails: [...source.emails].sort() } : {})
              }))
          },
    experiences: sortById(profile.experiences).map((experience) => ({
      ...experience,
      factIds: [...experience.factIds].sort(),
      evidenceRefs: canonicalEvidenceRefs(experience.evidenceRefs)
    })),
    projects: sortById(profile.projects).map((project) => ({
      ...project,
      skills: [...project.skills],
      factIds: [...project.factIds].sort(),
      evidenceRefs: canonicalEvidenceRefs(project.evidenceRefs)
    })),
    skills: sortById(profile.skills).map((skill) => ({
      ...skill,
      factIds: [...skill.factIds].sort(),
      evidenceRefs: canonicalEvidenceRefs(skill.evidenceRefs)
    })),
    achievements: sortById(profile.achievements).map(canonicalAchievement)
  };
}

function canonicalFact(fact: CareerFact): unknown {
  return {
    id: fact.id,
    type: fact.type,
    statement: fact.statement,
    normalizedData: fact.normalizedData,
    status: fact.status,
    confidence: fact.confidence,
    evidenceRefs: canonicalEvidenceRefs(fact.evidenceRefs),
    ...(fact.canonicalKey !== undefined ? { canonicalKey: fact.canonicalKey } : {}),
    ...(fact.supersedesFactId !== undefined ? { supersedesFactId: fact.supersedesFactId } : {})
  };
}

function canonicalEvidence(evidence: CareerEvidence): unknown {
  return {
    id: evidence.id,
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    evidenceType: evidence.evidenceType,
    raw: evidence.raw,
    normalized: evidence.normalized,
    ...(evidence.attribution !== undefined ? { attribution: evidence.attribution } : {}),
    ...(evidence.externalContribution !== undefined
      ? { externalContribution: evidence.externalContribution }
      : {}),
    ...(evidence.sourceUri !== undefined ? { sourceUri: evidence.sourceUri } : {}),
    ...(evidence.contentHash !== undefined ? { contentHash: evidence.contentHash } : {})
  };
}

/**
 * Semantic projection of a CareerIR document:
 *
 * - `exportedAt`, `profile.generatedAt`, fact `createdAt` / `updatedAt` /
 *   `confirmedAt` and evidence `discoveredAt` / `observedAt` are volatile
 *   metadata and excluded;
 * - set-like collections (facts, evidence, profile lists, refs) are sorted by
 *   stable id so input order never changes the fingerprint;
 * - everything that participates in compilation or Career Truth is included, so
 *   two different truth documents cannot share a revision hash.
 */
export function careerIrFingerprintDocument(ir: CareerIR): JsonValue {
  const { generatedAt: _generatedAt, ...profile } = ir.profile;
  void _generatedAt;
  return {
    kind: ir.kind,
    schemaVersion: ir.schemaVersion,
    profile: canonicalProfile(profile as CareerProfile),
    facts: sortById(ir.facts).map(canonicalFact),
    evidence: sortById(ir.evidence).map(canonicalEvidence)
  } as unknown as JsonValue;
}

/**
 * SHA-256 semantic revision fingerprint of a CareerIR document. The caller is
 * responsible for passing a validated document (`validateCareerIR`); this
 * function is pure serialization and intentionally has no validation import.
 */
export function canonicalIrHash(ir: CareerIR): string {
  return sha256Hex(canonicalStringify(careerIrFingerprintDocument(ir)));
}

/** Identity input of a content-addressed resume patch proposal. */
export interface ResumePatchProposalIdentity {
  baseIrHash: string;
  targetJobId?: string;
  strategyId: string;
  operations: ResumePatchOperation[];
}

/**
 * Content-addressed proposal identity. Lifecycle metadata (status, timestamps)
 * is excluded so the same directives always reproduce the same proposal.
 */
export function createResumePatchProposalId(input: ResumePatchProposalIdentity): string {
  return createContentId('proposal', {
    baseIrHash: input.baseIrHash,
    targetJobId: input.targetJobId ?? null,
    strategyId: input.strategyId,
    operations: input.operations
  });
}
