import type {
  CareerIR,
  CompilationSnapshot,
  ResumeCompilationDirectives,
  ResumeCompilationInput,
  ResumeCompilationRepository,
  ResumeCompilationStrategy,
  ResumePatchOperation,
  ResumePatchProposal,
  ResumeSectionId,
  ResumeVariant,
  ResumeVariantState,
  ResumeViewConfig
} from './types.js';
import { DEFAULT_RESUME_SECTION_ORDER } from './types.js';
import { canonicalIrHash, createResumePatchProposalId } from './canonical.js';
import { createCompilationSnapshotId, createResumeVariantId } from './ids.js';
import {
  DomainValidationError,
  validateCareerIR,
  validateCompilationSnapshot,
  validateResumePatchProposal,
  validateResumeVariant,
  validateResumeViewConfig
} from './validation.js';

/**
 * Resume compilation layer: strategy → proposal → apply / reject / revert →
 * variant. This module owns structural projection semantics; storage owns
 * atomic persistence and the renderer only maps the resulting view to Markdown.
 */

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new DomainValidationError(`${field} must not contain duplicates`);
  }
}

function assertAchievementExists(ir: CareerIR, id: string, field: string): void {
  if (!ir.profile.achievements.some((achievement) => achievement.id === id)) {
    throw new DomainValidationError(`${field}: unknown achievement id ${id}`);
  }
}

function assertSkillExists(ir: CareerIR, id: string, field: string): void {
  if (!ir.profile.skills.some((skill) => skill.id === id)) {
    throw new DomainValidationError(`${field}: unknown skill id ${id}`);
  }
}

/** The view every variant starts from: everything visible, compiler order. */
export function defaultResumeView(): ResumeViewConfig {
  return {
    sectionOrder: [...DEFAULT_RESUME_SECTION_ORDER],
    hiddenSections: [],
    achievementOrder: [],
    hiddenAchievementIds: [],
    emphasizedSkillIds: []
  };
}

/**
 * Fold structural operations into a declarative view config.
 *
 * Operations are applied in list order, so the final config is fully
 * deterministic for a given proposal. All referenced ids are validated against
 * the base IR here; unknown ids fail the proposal instead of silently
 * disappearing at render time.
 */
export function normalizeResumeViewConfig(
  ir: CareerIR,
  operations: ResumePatchOperation[]
): ResumeViewConfig {
  const view = defaultResumeView();
  const selectedIds = new Set<string>();
  const hiddenIds = new Set<string>();
  for (const operation of operations) {
    switch (operation.op) {
      case 'select-achievement': {
        assertAchievementExists(ir, operation.achievementId, 'select-achievement');
        selectedIds.add(operation.achievementId);
        view.hiddenAchievementIds = view.hiddenAchievementIds.filter(
          (id) => id !== operation.achievementId
        );
        break;
      }
      case 'hide-achievement': {
        assertAchievementExists(ir, operation.achievementId, 'hide-achievement');
        hiddenIds.add(operation.achievementId);
        if (!view.hiddenAchievementIds.includes(operation.achievementId)) {
          view.hiddenAchievementIds.push(operation.achievementId);
        }
        break;
      }
      case 'reorder-achievements': {
        for (const id of operation.achievementIds) {
          assertAchievementExists(ir, id, 'reorder-achievements');
        }
        view.achievementOrder = [...operation.achievementIds];
        break;
      }
      case 'set-section-order': {
        view.sectionOrder = [...operation.sections];
        break;
      }
      case 'set-section-visibility': {
        if (operation.visible) {
          view.hiddenSections = view.hiddenSections.filter((id) => id !== operation.section);
        } else if (!view.hiddenSections.includes(operation.section)) {
          view.hiddenSections.push(operation.section);
        }
        break;
      }
      case 'emphasize-skill': {
        assertSkillExists(ir, operation.skillId, 'emphasize-skill');
        if (!view.emphasizedSkillIds.includes(operation.skillId)) {
          view.emphasizedSkillIds.push(operation.skillId);
        }
        break;
      }
    }
  }
  for (const id of selectedIds) {
    if (hiddenIds.has(id)) {
      throw new DomainValidationError(`operations select and hide the same achievement: ${id}`);
    }
  }
  return validateResumeViewConfig(view);
}

/**
 * Apply a view to a CareerIR without touching Career Truth: only item selection
 * and ordering change. The returned document keeps the same facts, evidence and
 * achievement content, so every claim stays traceable.
 */
export function applyResumeViewConfig(ir: CareerIR, view: ResumeViewConfig): CareerIR {
  const validatedIr = validateCareerIR(ir);
  const validatedView = validateResumeViewConfig(view);
  for (const id of validatedView.achievementOrder) {
    assertAchievementExists(validatedIr, id, 'view.achievementOrder');
  }
  for (const id of validatedView.hiddenAchievementIds) {
    assertAchievementExists(validatedIr, id, 'view.hiddenAchievementIds');
  }
  for (const id of validatedView.emphasizedSkillIds) {
    assertSkillExists(validatedIr, id, 'view.emphasizedSkillIds');
  }

  const hiddenAchievements = new Set(validatedView.hiddenAchievementIds);
  const orderedAchievements = new Map(
    validatedView.achievementOrder.map((id, index) => [id, index])
  );
  const achievements = validatedIr.profile.achievements
    .filter((achievement) => !hiddenAchievements.has(achievement.id))
    .map((achievement, index) => ({ achievement, index }))
    .sort((left, right) => {
      const leftOrder = orderedAchievements.get(left.achievement.id);
      const rightOrder = orderedAchievements.get(right.achievement.id);
      if (leftOrder === undefined && rightOrder === undefined) {
        return left.index - right.index;
      }
      if (leftOrder === undefined) {
        return 1;
      }
      if (rightOrder === undefined) {
        return -1;
      }
      return leftOrder - rightOrder;
    })
    .map((entry) => entry.achievement);

  const emphasized = new Set(validatedView.emphasizedSkillIds);
  const skills = [
    ...validatedView.emphasizedSkillIds
      .map((id) => validatedIr.profile.skills.find((skill) => skill.id === id))
      .filter((skill): skill is CareerIR['profile']['skills'][number] => skill !== undefined),
    ...validatedIr.profile.skills.filter((skill) => !emphasized.has(skill.id))
  ];

  return validateCareerIR({
    ...validatedIr,
    profile: {
      ...validatedIr.profile,
      skills,
      achievements
    }
  });
}

const OPERATION_REASONS = {
  select: 'included by structural strategy',
  hide: 'excluded by structural strategy',
  reorder: 'reordered by structural strategy',
  sectionOrder: 'section order set by structural strategy',
  sectionHidden: 'section hidden by structural strategy',
  emphasize: 'skill emphasized by structural strategy'
} as const;

function directivesToOperations(
  ir: CareerIR,
  directives: ResumeCompilationDirectives
): ResumePatchOperation[] {
  const {
    selectAchievementIds = [],
    hideAchievementIds = [],
    achievementOrder = [],
    sectionOrder,
    hiddenSections = [],
    emphasizedSkillIds = []
  } = directives;
  assertUnique(selectAchievementIds, 'directives.selectAchievementIds');
  assertUnique(hideAchievementIds, 'directives.hideAchievementIds');
  assertUnique(achievementOrder, 'directives.achievementOrder');
  assertUnique(hiddenSections, 'directives.hiddenSections');
  assertUnique(emphasizedSkillIds, 'directives.emphasizedSkillIds');

  const hidden = new Set(hideAchievementIds);
  for (const id of selectAchievementIds) {
    assertAchievementExists(ir, id, 'directives.selectAchievementIds');
    if (hidden.has(id)) {
      throw new DomainValidationError(
        `directives select and hide the same achievement: ${id}`
      );
    }
  }
  for (const id of hideAchievementIds) {
    assertAchievementExists(ir, id, 'directives.hideAchievementIds');
  }
  for (const id of achievementOrder) {
    assertAchievementExists(ir, id, 'directives.achievementOrder');
    if (hidden.has(id)) {
      throw new DomainValidationError(
        `directives.achievementOrder must not contain hidden achievement ${id}`
      );
    }
  }
  for (const id of emphasizedSkillIds) {
    assertSkillExists(ir, id, 'directives.emphasizedSkillIds');
  }

  const operations: ResumePatchOperation[] = [];
  if (sectionOrder !== undefined) {
    operations.push({
      op: 'set-section-order',
      sections: [...sectionOrder],
      reason: OPERATION_REASONS.sectionOrder
    });
  }
  for (const section of hiddenSections) {
    operations.push({
      op: 'set-section-visibility',
      section,
      visible: false,
      reason: OPERATION_REASONS.sectionHidden
    });
  }
  for (const achievementId of [...selectAchievementIds].sort()) {
    operations.push({
      op: 'select-achievement',
      achievementId,
      reason: OPERATION_REASONS.select
    });
  }
  for (const achievementId of [...hideAchievementIds].sort()) {
    operations.push({
      op: 'hide-achievement',
      achievementId,
      reason: OPERATION_REASONS.hide
    });
  }
  if (achievementOrder.length > 0) {
    operations.push({
      op: 'reorder-achievements',
      achievementIds: [...achievementOrder],
      reason: OPERATION_REASONS.reorder
    });
  }
  for (const skillId of emphasizedSkillIds) {
    operations.push({
      op: 'emphasize-skill',
      skillId,
      reason: OPERATION_REASONS.emphasize
    });
  }
  return operations;
}

/**
 * Deterministic structural strategy.
 *
 * v1 consumes explicit directives only: no JD parsing, no matching and no text
 * rewriting. The same IR revision + directives always produce the same
 * proposal id and content. Future JD / matrix strategies implement
 * `ResumeCompilationStrategy` the same way.
 */
export class StructuralCompilationStrategy implements ResumeCompilationStrategy {
  readonly id = 'structural-v1';

  propose(
    ir: CareerIR,
    input: ResumeCompilationInput,
    options: { now?: string } = {}
  ): ResumePatchProposal {
    const validatedIr = validateCareerIR(ir);
    const operations = directivesToOperations(validatedIr, input.directives);
    if (operations.length === 0) {
      throw new DomainValidationError(
        'structural proposal requires at least one directive'
      );
    }
    const baseIrHash = canonicalIrHash(validatedIr);
    const proposal: ResumePatchProposal = {
      id: createResumePatchProposalId({
        baseIrHash,
        ...(input.targetJobId !== undefined ? { targetJobId: input.targetJobId } : {}),
        strategyId: this.id,
        operations
      }),
      baseIrHash,
      ...(input.targetJobId !== undefined ? { targetJobId: input.targetJobId } : {}),
      strategyId: this.id,
      operations,
      status: 'draft',
      createdAt: options.now ?? new Date().toISOString()
    };
    return validateResumePatchProposal(proposal);
  }
}

function variantStateOf(variant: ResumeVariant): ResumeVariantState {
  return {
    ...(variant.targetJobId !== undefined ? { targetJobId: variant.targetJobId } : {}),
    baseIrHash: variant.baseIrHash,
    proposalId: variant.proposalId,
    view: variant.view,
    revision: variant.revision
  };
}

export interface ApplyResumePatchProposalResult {
  proposal: ResumePatchProposal;
  variant: ResumeVariant;
  snapshot: CompilationSnapshot;
}

/**
 * Apply a draft proposal to CareerIR.
 *
 * Fail-closed rules: the proposal must be draft, and `baseIrHash` must still
 * match the current IR revision. A stale proposal is rejected instead of being
 * applied on top of changed Career Truth.
 */
export function applyResumePatchProposal(
  proposal: ResumePatchProposal,
  ir: CareerIR,
  repository: ResumeCompilationRepository,
  options: { now?: string } = {}
): ApplyResumePatchProposalResult {
  const validatedProposal = validateResumePatchProposal(proposal);
  const validatedIr = validateCareerIR(ir);
  if (validatedProposal.status !== 'draft') {
    throw new DomainValidationError(
      `proposal ${validatedProposal.id} is ${validatedProposal.status}; only draft proposals can be applied`
    );
  }
  const currentIrHash = canonicalIrHash(validatedIr);
  if (validatedProposal.baseIrHash !== currentIrHash) {
    throw new DomainValidationError(
      `proposal ${validatedProposal.id} is stale: compiled from ${validatedProposal.baseIrHash} but current CareerIR is ${currentIrHash}; recompile before applying`
    );
  }
  const view = normalizeResumeViewConfig(validatedIr, validatedProposal.operations);
  const now = options.now ?? new Date().toISOString();
  const existing =
    validatedProposal.targetJobId !== undefined
      ? repository.findResumeVariantByTargetJob(validatedProposal.targetJobId)
      : undefined;
  const variant: ResumeVariant = existing
    ? {
        ...existing,
        baseIrHash: currentIrHash,
        proposalId: validatedProposal.id,
        view,
        revision: existing.revision + 1,
        updatedAt: now
      }
    : {
        id: createResumeVariantId(),
        ...(validatedProposal.targetJobId !== undefined
          ? { targetJobId: validatedProposal.targetJobId }
          : {}),
        baseIrHash: currentIrHash,
        proposalId: validatedProposal.id,
        view,
        revision: 1,
        createdAt: now,
        updatedAt: now
      };
  const applied: ResumePatchProposal = {
    ...validatedProposal,
    status: 'applied',
    appliedAt: now,
    rejectedAt: undefined
  };
  const snapshot: CompilationSnapshot = {
    id: createCompilationSnapshotId(),
    variantId: variant.id,
    baseIrHash: currentIrHash,
    proposalId: validatedProposal.id,
    previous: existing ? variantStateOf(existing) : null,
    createdAt: now
  };
  repository.commitResumeCompilation(
    applied,
    validateResumeVariant(variant),
    validateCompilationSnapshot(snapshot)
  );
  return { proposal: applied, variant, snapshot };
}

/** Reject a draft proposal. Rejection never touches any variant. */
export function rejectResumePatchProposal(
  proposal: ResumePatchProposal,
  repository: ResumeCompilationRepository,
  options: { now?: string } = {}
): ResumePatchProposal {
  const validatedProposal = validateResumePatchProposal(proposal);
  if (validatedProposal.status !== 'draft') {
    throw new DomainValidationError(
      `proposal ${validatedProposal.id} is ${validatedProposal.status}; only draft proposals can be rejected`
    );
  }
  const rejected: ResumePatchProposal = {
    ...validatedProposal,
    status: 'rejected',
    rejectedAt: options.now ?? new Date().toISOString(),
    appliedAt: undefined
  };
  repository.saveResumePatchProposal(rejected);
  return rejected;
}

export interface RevertCompilationSnapshotResult {
  proposal: ResumePatchProposal;
  /** `undefined` when the reverted apply had created the variant. */
  variant: ResumeVariant | undefined;
  deleted: boolean;
}

/**
 * Roll back one apply using its snapshot. The applied proposal returns to
 * `draft` (so it can be reviewed and applied again) and the snapshot is
 * consumed. Full revision history belongs to the snapshot history roadmap item.
 */
export function revertCompilationSnapshot(
  snapshot: CompilationSnapshot,
  repository: ResumeCompilationRepository,
  options: { now?: string } = {}
): RevertCompilationSnapshotResult {
  const validatedSnapshot = validateCompilationSnapshot(snapshot);
  const proposal = repository.getResumePatchProposal(validatedSnapshot.proposalId);
  if (!proposal) {
    throw new DomainValidationError(
      `snapshot ${validatedSnapshot.id} references missing proposal ${validatedSnapshot.proposalId}`
    );
  }
  if (proposal.status !== 'applied') {
    throw new DomainValidationError(
      `proposal ${proposal.id} is ${proposal.status}; only an applied proposal can be reverted`
    );
  }
  const variant = repository.getResumeVariant(validatedSnapshot.variantId);
  if (!variant) {
    throw new DomainValidationError(
      `snapshot ${validatedSnapshot.id} references missing variant ${validatedSnapshot.variantId}`
    );
  }
  if (
    validatedSnapshot.previous !== null &&
    variant.revision !== validatedSnapshot.previous.revision + 1
  ) {
    throw new DomainValidationError(
      `snapshot ${validatedSnapshot.id} does not describe the current revision of variant ${variant.id}`
    );
  }
  if (variant.proposalId !== validatedSnapshot.proposalId) {
    throw new DomainValidationError(
      `snapshot ${validatedSnapshot.id} is not the latest apply of variant ${variant.id}; revert the newest apply first`
    );
  }
  const now = options.now ?? new Date().toISOString();
  const restoredProposal: ResumePatchProposal = {
    ...proposal,
    status: 'draft',
    appliedAt: undefined,
    rejectedAt: undefined
  };
  const restoredVariant: ResumeVariant | undefined =
    validatedSnapshot.previous === null
      ? undefined
      : validateResumeVariant({
          ...variant,
          baseIrHash: validatedSnapshot.previous.baseIrHash,
          proposalId: validatedSnapshot.previous.proposalId,
          view: validatedSnapshot.previous.view,
          revision: validatedSnapshot.previous.revision,
          updatedAt: now
        });
  repository.commitResumeRevert(restoredProposal, restoredVariant, validatedSnapshot.id);
  return { proposal: restoredProposal, variant: restoredVariant, deleted: restoredVariant === undefined };
}

/** Sections that a rendered view will actually show, in view order. */
export function visibleResumeSections(view: ResumeViewConfig): ResumeSectionId[] {
  const hidden = new Set(view.hiddenSections);
  return view.sectionOrder.filter((section) => !hidden.has(section));
}
