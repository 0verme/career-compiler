import type {
  CareerAchievement,
  CareerAchievementComponent,
  CareerAchievementFactRef,
  CareerEvidence,
  CareerEvidenceRef,
  CareerFact,
  CareerFactStatus,
  CompilationSnapshot,
  EvidenceAttribution,
  EvidenceRelation,
  CareerIdentity,
  CareerIR,
  CareerProfile,
  JsonObject,
  JsonValue,
  ResumePatchOperation,
  ResumePatchProposal,
  ResumePatchProposalStatus,
  ResumeSectionId,
  ResumeVariant,
  ResumeVariantState,
  ResumeViewConfig,
  TargetJob,
  TargetJobDraft,
  TargetJobPatch
} from './types.js';
import { CAREER_IR_SCHEMA_VERSION, DEFAULT_RESUME_SECTION_ORDER } from './types.js';
import { createResumePatchProposalId } from './canonical.js';
import { experienceIdFromFact, hashRawJd, projectIdFromFact } from './ids.js';

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

const RESUME_SECTION_IDS: ResumeSectionId[] = [...DEFAULT_RESUME_SECTION_ORDER];

export function isResumeSectionId(value: unknown): value is ResumeSectionId {
  return typeof value === 'string' && (RESUME_SECTION_IDS as string[]).includes(value);
}

function assertSha256Hex(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new DomainValidationError(`${field} must be a SHA-256 hex digest`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new DomainValidationError(`${field} must be an array`);
  }
  value.forEach((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
  if (new Set(value).size !== value.length) {
    throw new DomainValidationError(`${field} must not contain duplicates`);
  }
}

function assertSectionPermutation(value: unknown, field: string): asserts value is ResumeSectionId[] {
  if (
    !Array.isArray(value) ||
    value.length !== RESUME_SECTION_IDS.length ||
    !value.every(isResumeSectionId) ||
    new Set(value).size !== value.length
  ) {
    throw new DomainValidationError(
      `${field} must contain every resume section exactly once: ${RESUME_SECTION_IDS.join(', ')}`
    );
  }
}

/** Validates the declarative structural view of a resume variant. */
export function validateResumeViewConfig(value: unknown): ResumeViewConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('ResumeViewConfig must be an object');
  }
  const view = value as Partial<ResumeViewConfig>;
  assertSectionPermutation(view.sectionOrder, 'view.sectionOrder');
  if (!Array.isArray(view.hiddenSections) || !view.hiddenSections.every(isResumeSectionId)) {
    throw new DomainValidationError('view.hiddenSections must be resume sections');
  }
  if (new Set(view.hiddenSections).size !== view.hiddenSections.length) {
    throw new DomainValidationError('view.hiddenSections must not contain duplicates');
  }
  assertStringArray(view.achievementOrder, 'view.achievementOrder');
  assertStringArray(view.hiddenAchievementIds, 'view.hiddenAchievementIds');
  assertStringArray(view.emphasizedSkillIds, 'view.emphasizedSkillIds');
  const hidden = new Set(view.hiddenAchievementIds);
  for (const achievementId of view.achievementOrder) {
    if (hidden.has(achievementId)) {
      throw new DomainValidationError(
        `view.achievementOrder must not contain hidden achievement ${achievementId}`
      );
    }
  }
  return view as ResumeViewConfig;
}

function assertResumeOperationReason(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
}

/** Validates one structural patch operation. Order/selection conflicts are rejected. */
export function validateResumePatchOperation(
  value: unknown,
  index = 0
): ResumePatchOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError(`operations[${index}] must be an object`);
  }
  const operation = value as Record<string, unknown>;
  assertResumeOperationReason(operation.reason, `operations[${index}].reason`);
  switch (operation.op) {
    case 'select-achievement':
    case 'hide-achievement':
    case 'emphasize-skill': {
      const idField = operation.op === 'emphasize-skill' ? 'skillId' : 'achievementId';
      assertNonEmptyString(operation[idField], `operations[${index}].${idField}`);
      return operation as unknown as ResumePatchOperation;
    }
    case 'reorder-achievements': {
      assertStringArray(operation.achievementIds, `operations[${index}].achievementIds`);
      if (operation.achievementIds.length === 0) {
        throw new DomainValidationError(`operations[${index}].achievementIds must not be empty`);
      }
      return operation as unknown as ResumePatchOperation;
    }
    case 'set-section-order': {
      assertSectionPermutation(operation.sections, `operations[${index}].sections`);
      return operation as unknown as ResumePatchOperation;
    }
    case 'set-section-visibility': {
      if (!isResumeSectionId(operation.section)) {
        throw new DomainValidationError(`operations[${index}].section is not a resume section`);
      }
      if (typeof operation.visible !== 'boolean') {
        throw new DomainValidationError(`operations[${index}].visible must be a boolean`);
      }
      return operation as unknown as ResumePatchOperation;
    }
    default:
      throw new DomainValidationError(
        `operations[${index}].op is not a supported structural operation: ${String(operation.op)}`
      );
  }
}

function isResumePatchProposalStatus(value: unknown): value is ResumePatchProposalStatus {
  return value === 'draft' || value === 'applied' || value === 'rejected';
}

/**
 * Structural validation of a proposal, including content-addressed identity.
 * Provenance against a specific CareerIR is checked separately so stored
 * proposals stay readable after the IR moves on.
 */
export function validateResumePatchProposal(value: unknown): ResumePatchProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('ResumePatchProposal must be an object');
  }
  const proposal = value as Partial<ResumePatchProposal>;
  assertNonEmptyString(proposal.id, 'proposal.id');
  assertSha256Hex(proposal.baseIrHash, 'proposal.baseIrHash');
  if (proposal.targetJobId !== undefined) {
    assertNonEmptyString(proposal.targetJobId, 'proposal.targetJobId');
  }
  assertNonEmptyString(proposal.strategyId, 'proposal.strategyId');
  if (!Array.isArray(proposal.operations) || proposal.operations.length === 0) {
    throw new DomainValidationError('proposal.operations must contain at least one operation');
  }
  const operations = proposal.operations.map((operation, index) =>
    validateResumePatchOperation(operation, index)
  );
  const selected = new Set<string>();
  const hidden = new Set<string>();
  const ordered = new Set<string>();
  for (const operation of operations) {
    if (operation.op === 'select-achievement') {
      selected.add(operation.achievementId);
    }
    if (operation.op === 'hide-achievement') {
      hidden.add(operation.achievementId);
    }
    if (operation.op === 'reorder-achievements') {
      for (const id of operation.achievementIds) {
        ordered.add(id);
      }
    }
  }
  for (const id of selected) {
    if (hidden.has(id)) {
      throw new DomainValidationError(
        `proposal selects and hides the same achievement: ${id}`
      );
    }
  }
  for (const id of ordered) {
    if (hidden.has(id)) {
      throw new DomainValidationError(`proposal reorders a hidden achievement: ${id}`);
    }
  }
  if (!isResumePatchProposalStatus(proposal.status)) {
    throw new DomainValidationError(`Unsupported proposal status: ${String(proposal.status)}`);
  }
  assertIsoDate(proposal.createdAt, 'proposal.createdAt');
  if (proposal.status === 'applied') {
    assertIsoDate(proposal.appliedAt, 'proposal.appliedAt');
    if (proposal.rejectedAt !== undefined) {
      throw new DomainValidationError('an applied proposal must not carry rejectedAt');
    }
  } else if (proposal.status === 'rejected') {
    assertIsoDate(proposal.rejectedAt, 'proposal.rejectedAt');
    if (proposal.appliedAt !== undefined) {
      throw new DomainValidationError('a rejected proposal must not carry appliedAt');
    }
  } else if (proposal.appliedAt !== undefined || proposal.rejectedAt !== undefined) {
    throw new DomainValidationError('a draft proposal must not carry appliedAt or rejectedAt');
  }
  const expectedId = createResumePatchProposalId({
    baseIrHash: proposal.baseIrHash,
    ...(proposal.targetJobId !== undefined ? { targetJobId: proposal.targetJobId } : {}),
    strategyId: proposal.strategyId,
    operations
  });
  if (proposal.id !== expectedId) {
    throw new DomainValidationError(
      `proposal.id must be content-addressed; expected ${expectedId}, got ${proposal.id}`
    );
  }
  return { ...proposal, operations } as ResumePatchProposal;
}

/** Validates the variant state a snapshot can restore. */
export function validateResumeVariantState(value: unknown): ResumeVariantState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('ResumeVariantState must be an object');
  }
  const state = value as Partial<ResumeVariantState>;
  if (state.targetJobId !== undefined) {
    assertNonEmptyString(state.targetJobId, 'variantState.targetJobId');
  }
  assertSha256Hex(state.baseIrHash, 'variantState.baseIrHash');
  assertNonEmptyString(state.proposalId, 'variantState.proposalId');
  validateResumeViewConfig(state.view);
  if (!Number.isInteger(state.revision) || (state.revision ?? 0) < 1) {
    throw new DomainValidationError('variantState.revision must be a positive integer');
  }
  return state as ResumeVariantState;
}

/** Validates a persisted resume variant. */
export function validateResumeVariant(value: unknown): ResumeVariant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('ResumeVariant must be an object');
  }
  const variant = value as Partial<ResumeVariant>;
  assertNonEmptyString(variant.id, 'variant.id');
  validateResumeVariantState({
    ...(variant.targetJobId !== undefined ? { targetJobId: variant.targetJobId } : {}),
    baseIrHash: variant.baseIrHash,
    proposalId: variant.proposalId,
    view: variant.view,
    revision: variant.revision
  });
  assertIsoDate(variant.createdAt, 'variant.createdAt');
  assertIsoDate(variant.updatedAt, 'variant.updatedAt');
  return variant as ResumeVariant;
}

/** Validates an apply-time snapshot used for single-step rollback. */
export function validateCompilationSnapshot(value: unknown): CompilationSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('CompilationSnapshot must be an object');
  }
  const snapshot = value as Partial<CompilationSnapshot>;
  assertNonEmptyString(snapshot.id, 'snapshot.id');
  assertNonEmptyString(snapshot.variantId, 'snapshot.variantId');
  assertSha256Hex(snapshot.baseIrHash, 'snapshot.baseIrHash');
  assertNonEmptyString(snapshot.proposalId, 'snapshot.proposalId');
  if (snapshot.previous !== null && snapshot.previous !== undefined) {
    validateResumeVariantState(snapshot.previous);
  }
  assertIsoDate(snapshot.createdAt, 'snapshot.createdAt');
  return { ...snapshot, previous: snapshot.previous ?? null } as CompilationSnapshot;
}
