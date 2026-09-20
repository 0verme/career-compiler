import type {
  CareerAchievement,
  CareerAchievementComponent,
  CareerAchievementFactRef,
  CareerEvidence,
  CareerEvidenceRef,
  CareerFact,
  CareerFactStatus,
  EvidenceAttribution,
  EvidenceRelation,
  CareerIdentity,
  CareerIR,
  CareerProfile,
  JdRequirement,
  JdRequirementCategory,
  JdRequirementEditPatch,
  JdRequirementPriority,
  JdRequirementSet,
  JdRequirementStatus,
  JsonObject,
  JsonValue,
  TargetJob,
  TargetJobDraft,
  TargetJobPatch
} from './types.js';
import { CAREER_IR_SCHEMA_VERSION } from './types.js';
import {
  createJdRequirementId,
  experienceIdFromFact,
  hashRawJd,
  projectIdFromFact
} from './ids.js';

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

export function isEvidenceAttribution(value: unknown): value is EvidenceAttribution {
  return (
    value === 'owned' ||
    value === 'authored' ||
    value === 'contributed' ||
    value === 'reviewed' ||
    value === 'context' ||
    value === 'unknown'
  );
}

function validateCareerIdentity(value: unknown, field: string): asserts value is CareerIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError(`${field} must be an object`);
  }
  const identity = value as Partial<CareerIdentity>;
  if (!Array.isArray(identity.sources) || identity.sources.length === 0) {
    throw new DomainValidationError(`${field}.sources must contain at least one source identity`);
  }
  identity.sources.forEach((source, index) => {
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new DomainValidationError(`${field}.sources[${index}] must be an object`);
    }
    assertNonEmptyString(source.provider, `${field}.sources[${index}].provider`);
    assertNonEmptyString(source.externalId, `${field}.sources[${index}].externalId`);
    for (const [key, values] of [['names', source.names], ['emails', source.emails]] as const) {
      if (values !== undefined && (!Array.isArray(values) ||
        !values.every((item) => typeof item === 'string' && item.trim().length > 0))) {
        throw new DomainValidationError(`${field}.sources[${index}].${key} must be an array of strings`);
      }
    }
    for (const [key, text] of [['username', source.username], ['displayName', source.displayName]] as const) {
      if (text !== undefined) {
        assertNonEmptyString(text, `${field}.sources[${index}].${key}`);
      }
    }
  });
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
  if (evidence.attribution !== undefined && !isEvidenceAttribution(evidence.attribution)) {
    throw new DomainValidationError(`Unsupported evidence attribution: ${String(evidence.attribution)}`);
  }
  if (evidence.externalContribution !== undefined && typeof evidence.externalContribution !== 'boolean') {
    throw new DomainValidationError('evidence.externalContribution must be a boolean');
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
  if (value.identity !== undefined) {
    validateCareerIdentity(value.identity, 'profile.identity');
  }
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
  value.achievements.forEach((achievement) => validateCareerAchievement(achievement));
  assertIsoDate(value.generatedAt, 'profile.generatedAt');
  return value as CareerProfile;
}

const CAREER_ACHIEVEMENT_COMPONENTS: CareerAchievementComponent[] = [
  'statement',
  'problem',
  'constraint',
  'decision',
  'action',
  'result',
  'metric'
];

export function isCareerAchievementComponent(
  value: unknown
): value is CareerAchievementComponent {
  return typeof value === 'string' && CAREER_ACHIEVEMENT_COMPONENTS.includes(value as CareerAchievementComponent);
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined) {
    assertNonEmptyString(value, field);
  }
}

/** Validates a formal achievement unit. Only confirmed facts may produce one. */
export function validateCareerAchievement(value: unknown): CareerAchievement {
  if (typeof value !== 'object' || value === null) {
    throw new DomainValidationError('CareerAchievement must be an object');
  }
  const achievement = value as Partial<CareerAchievement>;
  assertNonEmptyString(achievement.id, 'achievement.id');
  assertNonEmptyString(achievement.statement, 'achievement.statement');
  for (const field of [
    'problem',
    'constraint',
    'decision',
    'action',
    'result',
    'metric',
    'projectId',
    'experienceId'
  ] as const) {
    assertOptionalString(achievement[field], `achievement.${field}`);
  }
  if (achievement.status !== 'confirmed') {
    throw new DomainValidationError(
      'achievement.status must be confirmed; candidate facts cannot produce formal achievements'
    );
  }
  if (!Array.isArray(achievement.factRefs) || achievement.factRefs.length === 0) {
    throw new DomainValidationError('achievement.factRefs must contain at least one fact reference');
  }
  achievement.factRefs.forEach((reference, index) => {
    if (typeof reference !== 'object' || reference === null) {
      throw new DomainValidationError(`achievement.factRefs[${index}] must be an object`);
    }
    assertNonEmptyString(reference.factId, `achievement.factRefs[${index}].factId`);
    if (
      reference.relation !== 'derived-from' &&
      reference.relation !== 'supports' &&
      reference.relation !== 'context'
    ) {
      throw new DomainValidationError(
        `achievement.factRefs[${index}].relation is not supported`
      );
    }
    if (
      !Array.isArray(reference.contributes) ||
      !reference.contributes.every(isCareerAchievementComponent)
    ) {
      throw new DomainValidationError(
        `achievement.factRefs[${index}].contributes must be achievement components`
      );
    }
    if (reference.relation === 'context') {
      if (reference.contributes.length > 0) {
        throw new DomainValidationError(
          `achievement.factRefs[${index}] is a context link and must not contribute components`
        );
      }
      return;
    }
    if (reference.contributes.length === 0) {
      throw new DomainValidationError(
        `achievement.factRefs[${index}] must contribute at least one component`
      );
    }
  });
  const contributesStatement = achievement.factRefs.some(
    (reference) =>
      reference.relation !== 'context' && reference.contributes.includes('statement')
  );
  if (!contributesStatement) {
    throw new DomainValidationError(
      'achievement.factRefs must contain a fact that contributes the statement'
    );
  }
  if (!Array.isArray(achievement.evidenceRefs) || achievement.evidenceRefs.length === 0) {
    throw new DomainValidationError(
      'achievement.evidenceRefs must contain at least one evidence reference'
    );
  }
  achievement.evidenceRefs.forEach(assertEvidenceRef);
  return achievement as CareerAchievement;
}

/** Validates the renderer-facing profile without requiring the full IR provenance document. */
export function validateCareerProfile(value: unknown): CareerProfile {
  return validateProfile(value);
}

function factComponentValue(fact: CareerFact, component: string): string | undefined {
  const value = fact.normalizedData[component];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Component-level provenance invariant: a fact may only substantiate the values it
 * actually carries, and the achievement must copy them verbatim (trimmed).
 */
function assertContributionMatchesFact(
  achievement: CareerAchievement,
  reference: CareerAchievementFactRef,
  fact: CareerFact
): void {
  for (const component of reference.contributes) {
    if (component === 'statement') {
      if (achievement.statement !== fact.statement) {
        throw new DomainValidationError(
          `achievement ${achievement.id} statement does not match contributing fact ${fact.id}`
        );
      }
      continue;
    }
    const value = factComponentValue(fact, component);
    if (value === undefined) {
      throw new DomainValidationError(
        `achievement ${achievement.id} claims ${component} from fact ${fact.id}, but the fact does not provide ${component}`
      );
    }
    if (achievement[component] !== value) {
      throw new DomainValidationError(
        `achievement ${achievement.id} ${component} does not match contributing fact ${fact.id}`
      );
    }
  }
}

function isExperienceFact(fact: CareerFact): boolean {
  return fact.type === 'experience' || fact.type === 'role';
}

function hasContextFact(
  achievement: CareerAchievement,
  factsById: Map<string, CareerFact>,
  matches: (fact: CareerFact) => boolean
): boolean {
  return achievement.factRefs.some((reference) => {
    if (reference.relation !== 'context') {
      return false;
    }
    const fact = factsById.get(reference.factId);
    return fact !== undefined && matches(fact);
  });
}

/** A renderer-facing association must be derivable from a context fact reference. */
function assertAssociationIsBacked(
  achievement: CareerAchievement,
  factsById: Map<string, CareerFact>
): void {
  if (
    achievement.projectId !== undefined &&
    !hasContextFact(
      achievement,
      factsById,
      (fact) => fact.type === 'project' && projectIdFromFact(fact) === achievement.projectId
    )
  ) {
    throw new DomainValidationError(
      `achievement ${achievement.id} projectId is not backed by a context fact reference`
    );
  }
  if (
    achievement.experienceId !== undefined &&
    !hasContextFact(
      achievement,
      factsById,
      (fact) =>
        isExperienceFact(fact) && experienceIdFromFact(fact) === achievement.experienceId
    )
  ) {
    throw new DomainValidationError(
      `achievement ${achievement.id} experienceId is not backed by a context fact reference`
    );
  }
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
  const profile = validateProfile(ir.profile);
  if (!Array.isArray(ir.evidence)) {
    throw new DomainValidationError('ir.evidence must be an array');
  }
  if (!Array.isArray(ir.facts)) {
    throw new DomainValidationError('ir.facts must be an array');
  }
  const evidenceIds = new Set(ir.evidence.map((item) => validateCareerEvidence(item).id));
  const factsById = new Map<string, CareerFact>();
  for (const fact of ir.facts) {
    const validated = validateCareerFact(fact);
    factsById.set(validated.id, validated);
    for (const reference of validated.evidenceRefs) {
      if (!evidenceIds.has(reference.evidenceId)) {
        throw new DomainValidationError(
          `fact ${validated.id} references missing evidence ${reference.evidenceId}`
        );
      }
    }
  }
  for (const achievement of profile.achievements) {
    const unitEvidenceIds = new Set(
      achievement.evidenceRefs.map((reference) => reference.evidenceId)
    );
    for (const reference of achievement.factRefs) {
      const fact = factsById.get(reference.factId);
      if (!fact) {
        throw new DomainValidationError(
          `achievement ${achievement.id} references missing fact ${reference.factId}`
        );
      }
      if (fact.status !== 'confirmed') {
        throw new DomainValidationError(
          `achievement ${achievement.id} references non-confirmed fact ${reference.factId}`
        );
      }
      assertContributionMatchesFact(achievement, reference, fact);
    }
    for (const reference of achievement.evidenceRefs) {
      if (!evidenceIds.has(reference.evidenceId)) {
        throw new DomainValidationError(
          `achievement ${achievement.id} references missing evidence ${reference.evidenceId}`
        );
      }
    }
    // Facts that substantiate components must keep their evidence at the unit level.
    // Extra evidence (for example context evidence in pre-hardening 0.2 documents)
    // stays valid; context facts are only traceable through their context factRef.
    for (const reference of achievement.factRefs) {
      if (reference.relation === 'context') {
        continue;
      }
      const fact = factsById.get(reference.factId);
      for (const evidenceRef of fact?.evidenceRefs ?? []) {
        if (!unitEvidenceIds.has(evidenceRef.evidenceId)) {
          throw new DomainValidationError(
            `achievement ${achievement.id} is missing evidence ${evidenceRef.evidenceId} of contributing fact ${reference.factId}`
          );
        }
      }
    }
    assertAssociationIsBacked(achievement, factsById);
  }
  return ir as CareerIR;
}

export function serializeCareerIR(ir: CareerIR): string {
  return `${JSON.stringify(validateCareerIR(ir), null, 2)}\n`;
}

/**
 * Target Job validation. `rawJdHash` must be consistent with `rawJd` so a
 * stored target job can never silently disagree with the text future parsers
 * would re-read.
 */
export function validateTargetJob(value: unknown): TargetJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('TargetJob must be an object');
  }
  const job = value as Partial<TargetJob>;
  assertNonEmptyString(job.id, 'targetJob.id');
  assertNonEmptyString(job.title, 'targetJob.title');
  assertNonEmptyString(job.rawJd, 'targetJob.rawJd');
  if (job.company !== undefined) {
    assertNonEmptyString(job.company, 'targetJob.company');
  }
  assertNonEmptyString(job.rawJdHash, 'targetJob.rawJdHash');
  if (job.rawJdHash !== hashRawJd(job.rawJd)) {
    throw new DomainValidationError('targetJob.rawJdHash must match targetJob.rawJd');
  }
  assertIsoDate(job.createdAt, 'targetJob.createdAt');
  assertIsoDate(job.updatedAt, 'targetJob.updatedAt');
  return job as TargetJob;
}

/** Validates user input for a new TargetJob before identity and hash are assigned. */
export function validateTargetJobDraft(value: unknown): TargetJobDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('TargetJob draft must be an object');
  }
  const draft = value as Partial<TargetJobDraft>;
  assertNonEmptyString(draft.title, 'targetJob.title');
  assertNonEmptyString(draft.rawJd, 'targetJob.rawJd');
  if (draft.company !== undefined) {
    assertNonEmptyString(draft.company, 'targetJob.company');
  }
  return draft as TargetJobDraft;
}

/** Validates a partial TargetJob update; `company: null` explicitly clears it. */
export function validateTargetJobPatch(value: unknown): TargetJobPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('TargetJob patch must be an object');
  }
  const patch = value as TargetJobPatch;
  if (patch.title !== undefined) {
    assertNonEmptyString(patch.title, 'targetJob.title');
  }
  if (patch.company !== undefined && patch.company !== null) {
    assertNonEmptyString(patch.company, 'targetJob.company');
  }
  if (patch.rawJd !== undefined) {
    assertNonEmptyString(patch.rawJd, 'targetJob.rawJd');
  }
  if (patch.title === undefined && patch.company === undefined && patch.rawJd === undefined) {
    throw new DomainValidationError(
      'TargetJob patch must change at least one of title, company or rawJd'
    );
  }
  return patch;
}

const JD_REQUIREMENT_CATEGORIES: JdRequirementCategory[] = [
  'responsibility',
  'skill',
  'experience',
  'education',
  'management',
  'domain',
  'other'
];

const JD_REQUIREMENT_PRIORITIES: JdRequirementPriority[] = [
  'required',
  'preferred',
  'unspecified'
];

const JD_REQUIREMENT_STATUSES: JdRequirementStatus[] = [
  'parsed',
  'confirmed',
  'rejected'
];

export function isJdRequirementCategory(value: unknown): value is JdRequirementCategory {
  return typeof value === 'string' && (JD_REQUIREMENT_CATEGORIES as string[]).includes(value);
}

export function isJdRequirementPriority(value: unknown): value is JdRequirementPriority {
  return typeof value === 'string' && (JD_REQUIREMENT_PRIORITIES as string[]).includes(value);
}

export function isJdRequirementStatus(value: unknown): value is JdRequirementStatus {
  return typeof value === 'string' && (JD_REQUIREMENT_STATUSES as string[]).includes(value);
}

function assertQuoteRange(value: unknown, field: string): asserts value is { start: number; end: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError(`${field} must be an object`);
  }
  const range = value as { start?: unknown; end?: unknown };
  if (!Number.isInteger(range.start) || (range.start as number) < 0) {
    throw new DomainValidationError(`${field}.start must be a non-negative integer`);
  }
  if (!Number.isInteger(range.end) || (range.end as number) <= (range.start as number)) {
    throw new DomainValidationError(`${field}.end must be an integer greater than start`);
  }
}

/**
 * Structural validation of one JD requirement, including deterministic id
 * consistency. Traceability against the current raw JD is checked separately
 * with `assertJdRequirementQuote` so stored requirements stay readable after
 * the JD moves on.
 */
export function validateJdRequirement(value: unknown): JdRequirement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('JdRequirement must be an object');
  }
  const requirement = value as Partial<JdRequirement>;
  assertNonEmptyString(requirement.id, 'requirement.id');
  assertNonEmptyString(requirement.targetJobId, 'requirement.targetJobId');
  if (!isJdRequirementCategory(requirement.category)) {
    throw new DomainValidationError(
      `Unsupported requirement category: ${String(requirement.category)}`
    );
  }
  if (!isJdRequirementPriority(requirement.priority)) {
    throw new DomainValidationError(
      `Unsupported requirement priority: ${String(requirement.priority)}`
    );
  }
  if (!isJdRequirementStatus(requirement.status)) {
    throw new DomainValidationError(
      `Unsupported requirement status: ${String(requirement.status)}`
    );
  }
  assertNonEmptyString(requirement.statement, 'requirement.statement');
  assertNonEmptyString(requirement.rawQuote, 'requirement.rawQuote');
  assertQuoteRange(requirement.quoteRange, 'requirement.quoteRange');
  assertConfidence(requirement.confidence, 'requirement.confidence');
  assertNonEmptyString(requirement.sourceRawJdHash, 'requirement.sourceRawJdHash');
  assertIsoDate(requirement.createdAt, 'requirement.createdAt');
  assertIsoDate(requirement.updatedAt, 'requirement.updatedAt');
  const expectedId = createJdRequirementId(
    requirement.targetJobId,
    requirement.sourceRawJdHash,
    requirement.quoteRange.start,
    requirement.quoteRange.end
  );
  if (requirement.id !== expectedId) {
    throw new DomainValidationError(
      `requirement.id must be derived from targetJobId, sourceRawJdHash and quoteRange; expected ${expectedId}, got ${requirement.id}`
    );
  }
  return requirement as JdRequirement;
}

/**
 * A requirement may only be saved when its `rawQuote` is locatable in the raw
 * JD it was parsed from. This rejects tampered or truncated quotes instead of
 * silently keeping an unverifiable requirement.
 */
export function assertJdRequirementQuote(requirement: JdRequirement, rawJd: string): void {
  const { start, end } = requirement.quoteRange;
  if (end > rawJd.length || rawJd.slice(start, end) !== requirement.rawQuote) {
    throw new DomainValidationError(
      `requirement ${requirement.id} rawQuote is not locatable at ${start}..${end} in the source raw JD`
    );
  }
}

/** Validates a parsed requirement set produced from one raw JD revision. */
export function validateJdRequirementSet(value: unknown): JdRequirementSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('JdRequirementSet must be an object');
  }
  const set = value as Partial<JdRequirementSet>;
  assertNonEmptyString(set.targetJobId, 'requirementSet.targetJobId');
  assertNonEmptyString(set.rawJdHash, 'requirementSet.rawJdHash');
  if (!Array.isArray(set.requirements)) {
    throw new DomainValidationError('requirementSet.requirements must be an array');
  }
  const ids = new Set<string>();
  for (const item of set.requirements) {
    const requirement = validateJdRequirement(item);
    if (requirement.targetJobId !== set.targetJobId) {
      throw new DomainValidationError(
        `requirement ${requirement.id} belongs to another target job`
      );
    }
    if (requirement.sourceRawJdHash !== set.rawJdHash) {
      throw new DomainValidationError(
        `requirement ${requirement.id} was parsed from another raw JD revision`
      );
    }
    if (ids.has(requirement.id)) {
      throw new DomainValidationError(`duplicate requirement id: ${requirement.id}`);
    }
    ids.add(requirement.id);
  }
  return set as JdRequirementSet;
}

/** Validates a user correction of a requirement; quotes cannot be edited. */
export function validateJdRequirementEditPatch(value: unknown): JdRequirementEditPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('JdRequirement edit patch must be an object');
  }
  const patch = value as JdRequirementEditPatch;
  if (patch.category === undefined && patch.priority === undefined && patch.statement === undefined) {
    throw new DomainValidationError(
      'JdRequirement edit patch must change at least one of category, priority or statement'
    );
  }
  if (patch.category !== undefined && !isJdRequirementCategory(patch.category)) {
    throw new DomainValidationError(`Unsupported requirement category: ${String(patch.category)}`);
  }
  if (patch.priority !== undefined && !isJdRequirementPriority(patch.priority)) {
    throw new DomainValidationError(`Unsupported requirement priority: ${String(patch.priority)}`);
  }
  if (patch.statement !== undefined) {
    assertNonEmptyString(patch.statement, 'requirement.statement');
  }
  return patch;
}
