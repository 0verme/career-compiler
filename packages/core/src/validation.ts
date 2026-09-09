import type {
  CareerEvidence,
  CareerEvidenceRef,
  CareerFact,
  CareerFactStatus,
  EvidenceRelation,
  CareerIR,
  CareerProfile,
  JsonObject,
  JsonValue
} from './types.js';
import { CAREER_IR_SCHEMA_VERSION } from './types.js';

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonValue(value);
}

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainValidationError(`${field} must be a non-empty string`);
  }
}

export function assertIsoDate(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(value))) {
    throw new DomainValidationError(`${field} must be an ISO-compatible date`);
  }
}

export function assertConfidence(value: unknown, field = 'confidence'): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DomainValidationError(`${field} must be a number between 0 and 1`);
  }
}

export function isCareerFactStatus(value: unknown): value is CareerFactStatus {
  return (
    value === 'candidate' ||
    value === 'confirmed' ||
    value === 'rejected' ||
    value === 'superseded' ||
    value === 'conflicted'
  );
}

export function isEvidenceRelation(value: unknown): value is EvidenceRelation {
  return value === 'supports' || value === 'derived-from' || value === 'contradicts' || value === 'context';
}

function assertEvidenceRef(value: unknown, index: number): asserts value is CareerEvidenceRef {
  if (typeof value !== 'object' || value === null) {
    throw new DomainValidationError(`evidenceRefs[${index}] must be an object`);
  }
  const ref = value as Partial<CareerEvidenceRef>;
  assertNonEmptyString(ref.evidenceId, `evidenceRefs[${index}].evidenceId`);
  assertNonEmptyString(ref.relation, `evidenceRefs[${index}].relation`);
  if (!isEvidenceRelation(ref.relation)) {
    throw new DomainValidationError(`evidenceRefs[${index}].relation is not supported`);
  }
  if (ref.weight !== undefined) {
    assertConfidence(ref.weight, `evidenceRefs[${index}].weight`);
  }
}

export function validateCareerEvidence(value: unknown): CareerEvidence {
  if (typeof value !== 'object' || value === null) {
    throw new DomainValidationError('CareerEvidence must be an object');
  }
  const evidence = value as Partial<CareerEvidence>;
  assertNonEmptyString(evidence.id, 'evidence.id');
  assertNonEmptyString(evidence.sourceType, 'evidence.sourceType');
  assertNonEmptyString(evidence.sourceId, 'evidence.sourceId');
  assertNonEmptyString(evidence.evidenceType, 'evidence.evidenceType');
  if (!isJsonObject(evidence.raw)) {
    throw new DomainValidationError('evidence.raw must be a JSON object');
  }
  if (!isJsonObject(evidence.normalized)) {
    throw new DomainValidationError('evidence.normalized must be a JSON object');
  }
  assertIsoDate(evidence.discoveredAt, 'evidence.discoveredAt');
  if (evidence.observedAt !== undefined) {
    assertIsoDate(evidence.observedAt, 'evidence.observedAt');
  }
  return evidence as CareerEvidence;
}

export function validateCareerFact(value: unknown): CareerFact {
  if (typeof value !== 'object' || value === null) {
    throw new DomainValidationError('CareerFact must be an object');
  }
  const fact = value as Partial<CareerFact>;
  assertNonEmptyString(fact.id, 'fact.id');
  assertNonEmptyString(fact.type, 'fact.type');
  assertNonEmptyString(fact.statement, 'fact.statement');
  if (!isJsonObject(fact.normalizedData)) {
    throw new DomainValidationError('fact.normalizedData must be a JSON object');
  }
  assertNonEmptyString(fact.status, 'fact.status');
  if (!isCareerFactStatus(fact.status)) {
    throw new DomainValidationError(`Unsupported fact status: ${fact.status}`);
  }
  assertConfidence(fact.confidence);
  if (!Array.isArray(fact.evidenceRefs) || fact.evidenceRefs.length === 0) {
    throw new DomainValidationError('fact.evidenceRefs must contain at least one evidence reference');
  }
  fact.evidenceRefs.forEach(assertEvidenceRef);
  assertIsoDate(fact.createdAt, 'fact.createdAt');
  assertIsoDate(fact.updatedAt, 'fact.updatedAt');
  if (fact.confirmedAt !== undefined) {
    assertIsoDate(fact.confirmedAt, 'fact.confirmedAt');
  }
  return fact as CareerFact;
}

function validateProfile(profile: unknown): CareerProfile {
  if (typeof profile !== 'object' || profile === null) {
    throw new DomainValidationError('CareerProfile must be an object');
  }
  const value = profile as Partial<CareerProfile>;
  assertNonEmptyString(value.id, 'profile.id');
  assertNonEmptyString(value.displayName, 'profile.displayName');
  if (!Array.isArray(value.experiences)) {
    throw new DomainValidationError('profile.experiences must be an array');
  }
  if (!Array.isArray(value.projects)) {
    throw new DomainValidationError('profile.projects must be an array');
  }
  if (!Array.isArray(value.skills)) {
    throw new DomainValidationError('profile.skills must be an array');
  }
  if (!Array.isArray(value.achievements)) {
    throw new DomainValidationError('profile.achievements must be an array');
  }
  assertIsoDate(value.generatedAt, 'profile.generatedAt');
  return value as CareerProfile;
}

export function validateCareerIR(value: unknown): CareerIR {
  if (typeof value !== 'object' || value === null) {
    throw new DomainValidationError('CareerIR must be an object');
  }
  const ir = value as Partial<CareerIR>;
  if (ir.kind !== 'career-ir') {
    throw new DomainValidationError('CareerIR.kind must be career-ir');
  }
  if (ir.schemaVersion !== CAREER_IR_SCHEMA_VERSION) {
    throw new DomainValidationError(
      `Unsupported CareerIR schema version: ${String(ir.schemaVersion)}`
    );
  }
  assertIsoDate(ir.exportedAt, 'ir.exportedAt');
  validateProfile(ir.profile);
  if (!Array.isArray(ir.evidence)) {
    throw new DomainValidationError('ir.evidence must be an array');
  }
  if (!Array.isArray(ir.facts)) {
    throw new DomainValidationError('ir.facts must be an array');
  }
  const evidenceIds = new Set(ir.evidence.map((item) => validateCareerEvidence(item).id));
  ir.facts.forEach((fact) => {
    const validated = validateCareerFact(fact);
    for (const reference of validated.evidenceRefs) {
      if (!evidenceIds.has(reference.evidenceId)) {
        throw new DomainValidationError(
          `fact ${validated.id} references missing evidence ${reference.evidenceId}`
        );
      }
    }
  });
  return ir as CareerIR;
}

export function serializeCareerIR(ir: CareerIR): string {
  return `${JSON.stringify(validateCareerIR(ir), null, 2)}\n`;
}

export function parseCareerIR(serialized: string): CareerIR {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new DomainValidationError(
      `CareerIR is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateCareerIR(parsed);
}
