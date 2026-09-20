export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export type SourceType =
  | 'github'
  | 'local-git'
  | 'manual'
  | 'chat'
  | (string & {});

export type EvidenceType =
  | 'profile'
  | 'repository'
  | 'commit'
  | 'issue'
  | 'pull-request'
  | 'local-repository'
  | 'conversation'
  | 'project-metadata'
  | 'tag'
  | (string & {});

export type CareerFactType =
  | 'project'
  | 'experience'
  | 'skill'
  | 'achievement'
  | 'metric'
  | 'role'
  | (string & {});

export type IdentityProvider = 'github' | 'git' | (string & {});

export interface SourceIdentity {
  provider: IdentityProvider;
  externalId: string;
  username?: string;
  displayName?: string;
  names?: string[];
  emails?: string[];
}

export interface CareerIdentity {
  sources: SourceIdentity[];
}

export type EvidenceAttribution =
  | 'owned'
  | 'authored'
  | 'contributed'
  | 'reviewed'
  | 'context'
  | 'unknown';

export type CareerFactStatus =
  | 'candidate'
  | 'confirmed'
  | 'rejected'
  | 'superseded'
  | 'conflicted';

export type EvidenceRelation = 'supports' | 'derived-from' | 'contradicts' | 'context';

export interface CareerEvidenceRef {
  evidenceId: string;
  relation: EvidenceRelation;
  weight?: number;
}

/** Raw observations from a source. This is not an AI-generated claim. */
export interface CareerEvidence {
  id: string;
  sourceType: SourceType;
  sourceId: string;
  evidenceType: EvidenceType;
  raw: JsonObject;
  normalized: JsonObject;
  /** Who the source can reliably attribute this observation to. */
  attribution?: EvidenceAttribution;
  /** True when an authored observation belongs to a repository not owned by the identity. */
  externalContribution?: boolean;
  sourceUri?: string;
  observedAt?: string;
  discoveredAt: string;
  contentHash?: string;
}

/** A normalized, reviewable claim. Every fact must point back to evidence. */
export interface CareerFact {
  id: string;
  type: CareerFactType;
  statement: string;
  normalizedData: JsonObject;
  status: CareerFactStatus;
  confidence: number;
  evidenceRefs: CareerEvidenceRef[];
  canonicalKey?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  confirmedBy?: string;
  supersedesFactId?: string;
}

export interface CareerProject {
  id: string;
  name: string;
  summary?: string;
  url?: string;
  repositoryUrl?: string;
  skills: string[];
  factIds: string[];
  evidenceRefs: CareerEvidenceRef[];
}

export interface CareerExperience {
  id: string;
  organization?: string;
  role: string;
  summary?: string;
  startDate?: string;
  endDate?: string;
  factIds: string[];
  evidenceRefs: CareerEvidenceRef[];
}

export interface CareerSkill {
  id: string;
  name: string;
  category?: string;
  factIds: string[];
  evidenceRefs: CareerEvidenceRef[];
}

/** Formal achievements only exist for confirmed facts; candidate content stays in facts. */
export type CareerAchievementStatus = 'confirmed';

/** The parts of a career achievement unit that a confirmed fact can substantiate. */
export type CareerAchievementComponent =
  | 'statement'
  | 'problem'
  | 'constraint'
  | 'decision'
  | 'action'
  | 'result'
  | 'metric';

/** Provenance link from an achievement unit back to one confirmed CareerFact. */
export interface CareerAchievementFactRef {
  factId: string;
  relation: Extract<EvidenceRelation, 'derived-from' | 'supports' | 'context'>;
  /** Components this fact substantiates; context links must keep this empty. */
  contributes: CareerAchievementComponent[];
}

/**
 * A career achievement unit compiled from confirmed facts. Components are copied
 * verbatim from fact normalizedData and may be absent; the compiler never invents
 * numbers, results, causality or technical decisions.
 */
export interface CareerAchievement {
  id: string;
  statement: string;
  problem?: string;
  constraint?: string;
  decision?: string;
  action?: string;
  result?: string;
  metric?: string;
  /** Stable link to the confirmed project fact this unit belongs to, when resolvable. */
  projectId?: string;
  /** Stable link to the confirmed experience/role fact this unit belongs to, when resolvable. */
  experienceId?: string;
  status: CareerAchievementStatus;
  factRefs: CareerAchievementFactRef[];
  /**
   * Evidence union of the confirmed facts that substantiate components. Context-link
   * evidence stays reachable through `factRefs` → context fact → `fact.evidenceRefs`.
   */
  evidenceRefs: CareerEvidenceRef[];
}

/** The renderer-friendly projection of confirmed career facts. */
export interface CareerProfile {
  id: string;
  displayName: string;
  headline?: string;
  about?: string;
  identity?: CareerIdentity;
  experiences: CareerExperience[];
  projects: CareerProject[];
  skills: CareerSkill[];
  achievements: CareerAchievement[];
  generatedAt: string;
}

/** Versioned portable document: the Career Intermediate Representation. */
export interface CareerIR {
  kind: 'career-ir';
  schemaVersion: '0.2';
  exportedAt: string;
  profile: CareerProfile;
  facts: CareerFact[];
  evidence: CareerEvidence[];
}

/**
 * A target job the user wants to apply for. Target Job is target context, not
 * career evidence: it never creates, confirms or rewrites CareerEvidence,
 * CareerFact, CareerAchievement or CareerProfile.
 */
export interface TargetJob {
  /** Stable identity; editing company/title/rawJd never changes it. */
  id: string;
  company?: string;
  title: string;
  /** Verbatim user-provided JD, kept as the source of truth for future parsing. */
  rawJd: string;
  /** Deterministic fingerprint of rawJd, used for change/stale detection only. */
  rawJdHash: string;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a new TargetJob. */
export interface TargetJobDraft {
  company?: string;
  title: string;
  rawJd: string;
}

/** Partial update for an existing TargetJob. `company: null` clears the company. */
export interface TargetJobPatch {
  company?: string | null;
  title?: string;
  rawJd?: string;
}

export interface TargetJobUpdateOptions {
  now?: string;
}

/**
 * Persistence contract for Target Job context. Separate from CareerRepository
 * because Target Job is a second, independent input line into the compiler.
 */
export interface TargetJobRepository {
  saveTargetJob(job: TargetJob): void;
  getTargetJob(id: string): TargetJob | undefined;
  listTargetJobs(): TargetJob[];
  updateTargetJob(
    id: string,
    patch: TargetJobPatch,
    options?: TargetJobUpdateOptions
  ): TargetJob | undefined;
}

/**
 * Resume compilation layer.
 *
 * A proposal is a reviewable, content-addressed description of structural
 * changes to the presentation projection. Applying a proposal produces a
 * ResumeVariant; Career Truth (facts, evidence, achievements) is never
 * rewritten. Patch operations are structural only (selection / ordering /
 * visibility / emphasis) and may not introduce free-form text.
 */
export type ResumeSectionId =
  | 'summary'
  | 'experience'
  | 'projects'
  | 'skills'
  | 'achievements';

export type ResumePatchProposalStatus = 'draft' | 'applied' | 'rejected';

interface ResumePatchOperationBase {
  /** Human-readable reason shown during review. */
  reason: string;
}

export interface ResumePatchSelectAchievementOperation extends ResumePatchOperationBase {
  op: 'select-achievement';
  achievementId: string;
}

export interface ResumePatchHideAchievementOperation extends ResumePatchOperationBase {
  op: 'hide-achievement';
  achievementId: string;
}

export interface ResumePatchReorderAchievementsOperation extends ResumePatchOperationBase {
  op: 'reorder-achievements';
  achievementIds: string[];
}

export interface ResumePatchSetSectionOrderOperation extends ResumePatchOperationBase {
  op: 'set-section-order';
  sections: ResumeSectionId[];
}

export interface ResumePatchSetSectionVisibilityOperation extends ResumePatchOperationBase {
  op: 'set-section-visibility';
  section: ResumeSectionId;
  visible: boolean;
}

export interface ResumePatchEmphasizeSkillOperation extends ResumePatchOperationBase {
  op: 'emphasize-skill';
  skillId: string;
}

export type ResumePatchOperation =
  | ResumePatchSelectAchievementOperation
  | ResumePatchHideAchievementOperation
  | ResumePatchReorderAchievementsOperation
  | ResumePatchSetSectionOrderOperation
  | ResumePatchSetSectionVisibilityOperation
  | ResumePatchEmphasizeSkillOperation;

/**
 * Declarative structural view of a resume variant. This is presentation state,
 * not a copy of career content: it only says what is included and in what
 * order. Hidden items stay in Career Truth and remain renderable by other
 * variants.
 */
export interface ResumeViewConfig {
  /** Complete section order; every `ResumeSectionId` appears exactly once. */
  sectionOrder: ResumeSectionId[];
  /** Sections excluded from the rendered view. */
  hiddenSections: ResumeSectionId[];
  /** Explicit order prefix for included achievements; unlisted ids keep compiler order. */
  achievementOrder: string[];
  /** Achievement ids excluded from the view. */
  hiddenAchievementIds: string[];
  /** Skills moved to the front of the skills list. */
  emphasizedSkillIds: string[];
}

/**
 * A reviewable compilation proposal. Identity is content-addressed: the same
 * IR revision + strategy + target + operations always produce the same id and
 * content, so proposals are reproducible and deduplicated. Lifecycle metadata
 * (`status`, timestamps) is not part of the identity.
 */
export interface ResumePatchProposal {
  id: string;
  /** Semantic CareerIR fingerprint the proposal was compiled from. */
  baseIrHash: string;
  targetJobId?: string;
  /** Strategy that produced this proposal (for example `structural-v1`). */
  strategyId: string;
  operations: ResumePatchOperation[];
  status: ResumePatchProposalStatus;
  createdAt: string;
  appliedAt?: string;
  rejectedAt?: string;
}

/**
 * A compiled, target-aware presentation state. The variant stores only the
 * structural view; it never copies career content.
 */
export interface ResumeVariant {
  id: string;
  targetJobId?: string;
  baseIrHash: string;
  /** Proposal of the most recent apply; restored state on revert. */
  proposalId: string;
  view: ResumeViewConfig;
  /** Monotonic per variant under apply/revert cycles. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Snapshot of the variant state a proposal was applied on top of. */
export interface ResumeVariantState {
  targetJobId?: string;
  baseIrHash: string;
  proposalId: string;
  view: ResumeViewConfig;
  revision: number;
}

/**
 * Minimal apply-time snapshot used to roll back a single apply. Full revision
 * history / content addressing belongs to the snapshot history roadmap item.
 */
export interface CompilationSnapshot {
  id: string;
  variantId: string;
  baseIrHash: string;
  proposalId: string;
  /** `null` when the applied proposal created the variant. */
  previous: ResumeVariantState | null;
  createdAt: string;
}

/** Explicit structural directives consumed by the deterministic strategy. */
export interface ResumeCompilationDirectives {
  selectAchievementIds?: string[];
  hideAchievementIds?: string[];
  achievementOrder?: string[];
  sectionOrder?: ResumeSectionId[];
  hiddenSections?: ResumeSectionId[];
  emphasizedSkillIds?: string[];
}

export interface ResumeCompilationInput {
  targetJobId?: string;
  directives: ResumeCompilationDirectives;
}

/**
 * Compilation strategy contract. v1 only ships a deterministic structural
 * strategy; future JD / matrix driven strategies implement the same interface
 * and must not modify Career Truth either.
 */
export interface ResumeCompilationStrategy {
  readonly id: string;
  propose(
    ir: CareerIR,
    input: ResumeCompilationInput,
    options?: { now?: string }
  ): ResumePatchProposal;
}

/**
 * Persistence contract for the compilation layer. Apply / revert are committed
 * atomically so a failed apply never leaves a half-written variant.
 */
export interface ResumeCompilationRepository {
  saveResumePatchProposal(proposal: ResumePatchProposal): void;
  getResumePatchProposal(id: string): ResumePatchProposal | undefined;
  listResumePatchProposals(): ResumePatchProposal[];
  getResumeVariant(id: string): ResumeVariant | undefined;
  findResumeVariantByTargetJob(targetJobId: string): ResumeVariant | undefined;
  listResumeVariants(): ResumeVariant[];
  getCompilationSnapshot(id: string): CompilationSnapshot | undefined;
  listCompilationSnapshots(variantId?: string): CompilationSnapshot[];
  commitResumeCompilation(
    proposal: ResumePatchProposal,
    variant: ResumeVariant,
    snapshot: CompilationSnapshot
  ): void;
  commitResumeRevert(
    proposal: ResumePatchProposal,
    variant: ResumeVariant | undefined,
    snapshotId: string
  ): void;
}

export interface SourceRunContext {
  now: string;
  scanner?: ScannerPolicy;
  identity?: CareerIdentity;
}

export interface CareerSource<
  TRequest,
  TDiscovery = unknown,
  TScan = unknown
> {
  readonly sourceType: SourceType;
  discover(request: TRequest, context: SourceRunContext): Promise<TDiscovery>;
  scan(discovery: TDiscovery, context: SourceRunContext): Promise<TScan>;
  extractEvidence(scan: TScan, context: SourceRunContext): Promise<CareerEvidence[]>;
}

export interface ScannerPolicy {
  maxDepth: number;
  maxCommits: number;
  maxFiles: number;
  allowlist: string[];
  denylist: string[];
}

export interface RendererOptions {
  template?: string;
}

export interface RenderedArtifact {
  rendererId: string;
  format: 'markdown';
  fileName: string;
  content: string;
}

export interface CareerRenderer<TOptions extends RendererOptions = RendererOptions> {
  readonly rendererId: string;
  readonly format: 'markdown';
  render(ir: CareerIR, options?: TOptions): RenderedArtifact;
}

export interface CareerRepository {
  saveEvidence(evidence: CareerEvidence): void;
  getEvidence(id: string): CareerEvidence | undefined;
  listEvidence(sourceType?: SourceType): CareerEvidence[];
  saveFact(fact: CareerFact): void;
  getFact(id: string): CareerFact | undefined;
  listFacts(status?: CareerFactStatus): CareerFact[];
  updateFactStatus(
    id: string,
    status: CareerFactStatus,
    metadata?: { confirmedAt?: string; confirmedBy?: string }
  ): CareerFact | undefined;
  saveCareerIR(ir: CareerIR): void;
  loadCareerIR(profileId: string): CareerIR | undefined;
  importCareerIR(ir: CareerIR): void;
  close(): void;
}

export const CAREER_IR_SCHEMA_VERSION = '0.2' as const;

/** Previous IR schema. Parsing it migrates achievements to the 0.2 contract. */
export const CAREER_IR_SCHEMA_VERSION_V01 = '0.1' as const;

/** Default resume section layout, shared by the strategy validation and renderer. */
export const DEFAULT_RESUME_SECTION_ORDER: readonly ResumeSectionId[] = [
  'summary',
  'experience',
  'projects',
  'skills',
  'achievements'
];

export const DEFAULT_SCANNER_POLICY: ScannerPolicy = {
  maxDepth: 3,
  maxCommits: 200,
  maxFiles: 5000,
  allowlist: [],
  denylist: []
};
