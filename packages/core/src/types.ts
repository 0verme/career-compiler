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
  /** Components this fact substantiates; project/experience context links may be empty. */
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

export const DEFAULT_SCANNER_POLICY: ScannerPolicy = {
  maxDepth: 3,
  maxCommits: 200,
  maxFiles: 5000,
  allowlist: [],
  denylist: []
};
