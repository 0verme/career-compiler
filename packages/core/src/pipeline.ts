import type {
  CareerAchievement,
  CareerEvidence,
  CareerEvidenceRef,
  CareerExperience,
  CareerFact,
  CareerIR,
  CareerProfile,
  CareerProject,
  CareerSkill,
  JsonObject,
  SourceType
} from './types.js';
import { CAREER_IR_SCHEMA_VERSION } from './types.js';
import { validateCareerEvidence, validateCareerFact, validateCareerIR } from './validation.js';

export interface ProfileSeed {
  id: string;
  displayName: string;
  headline?: string;
  about?: string;
}

export interface BuildCareerIRInput {
  profile: ProfileSeed;
  facts: CareerFact[];
  evidence: CareerEvidence[];
  exportedAt?: string;
}

function stableHash(value: string): string {
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeEvidenceRefs(refs: CareerEvidenceRef[]): CareerEvidenceRef[] {
  const byId = new Map<string, CareerEvidenceRef>();
  for (const ref of refs) {
    const previous = byId.get(ref.evidenceId);
    if (!previous || (ref.weight ?? 0) > (previous.weight ?? 0)) {
      byId.set(ref.evidenceId, { ...ref });
    }
  }
  return [...byId.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function factFromRepositoryEvidence(evidence: CareerEvidence): CareerFact | undefined {
  const normalized = evidence.normalized;
  const name = asString(normalized.name);
  if (!name) {
    return undefined;
  }
  const summary = asString(normalized.description) ?? asString(normalized.summary);
  const repositoryUrl = asString(normalized.repositoryUrl) ?? evidence.sourceUri;
  const topics = asStringArray(normalized.topics);
  const languages = asStringArray(normalized.languages);
  const canonicalName = asString(normalized.canonicalName) ?? name;
  const canonicalKey = `project:${normalizeText(canonicalName)}`;
  const statement = summary ? `Built ${name}: ${summary}` : `Worked on ${name}`;
  const normalizedData: JsonObject = {
    name,
    ...(summary ? { summary } : {}),
    ...(repositoryUrl ? { repositoryUrl, url: repositoryUrl } : {}),
    skills: dedupeStrings([...topics, ...languages])
  };
  return {
    id: createStableId('fact', canonicalKey),
    type: 'project',
    statement,
    normalizedData,
    status: 'candidate',
    confidence: 0.72,
    evidenceRefs: [{ evidenceId: evidence.id, relation: 'supports', weight: 1 }],
    canonicalKey,
    createdAt: evidence.discoveredAt,
    updatedAt: evidence.discoveredAt
  };
}

/**
 * Project only high-signal metadata into candidate facts. Commits, issues and PRs
 * remain evidence until a human or a future extractor turns them into a claim.
 */
export function deriveCandidateFacts(evidence: CareerEvidence[]): CareerFact[] {
  const candidates: CareerFact[] = [];
  for (const item of evidence) {
    if (item.evidenceType !== 'repository' && item.evidenceType !== 'local-repository') {
      continue;
    }
    const candidate = factFromRepositoryEvidence(item);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return mergeCandidateFacts([], candidates);
}

/** Merge corroborating observations without rewriting a confirmed claim. */
export function mergeCandidateFacts(
  existingFacts: CareerFact[],
  incomingFacts: CareerFact[]
): CareerFact[] {
  const result = new Map<string, CareerFact>();
  for (const fact of existingFacts) {
    result.set(fact.canonicalKey ?? fact.id, validateCareerFact(fact));
  }

  for (const incoming of incomingFacts) {
    const validated = validateCareerFact(incoming);
    const key = validated.canonicalKey ?? validated.id;
    const existing = result.get(key);
    if (!existing) {
      result.set(key, validated);
      continue;
    }
    if (existing.status === 'rejected' || existing.status === 'superseded') {
      continue;
    }
    const evidenceRefs = dedupeEvidenceRefs([...existing.evidenceRefs, ...validated.evidenceRefs]);
    if (existing.status === 'confirmed') {
      result.set(key, {
        ...existing,
        evidenceRefs,
        updatedAt: validated.updatedAt
      });
      continue;
    }
    result.set(key, {
      ...existing,
      statement: existing.statement,
      normalizedData: existing.normalizedData,
      confidence: Math.max(existing.confidence, validated.confidence),
      evidenceRefs,
      updatedAt: validated.updatedAt
    });
  }

  return [...result.values()].sort((left, right) =>
    (left.canonicalKey ?? left.id).localeCompare(right.canonicalKey ?? right.id)
  );
}

export function confirmCareerFact(
  fact: CareerFact,
  confirmedAt: string,
  confirmedBy = 'user'
): CareerFact {
  validateCareerFact(fact);
  return {
    ...fact,
    status: 'confirmed',
    confirmedAt,
    confirmedBy,
    updatedAt: confirmedAt
  };
}

function projectFromFact(fact: CareerFact): CareerProject {
  const data = fact.normalizedData;
  const name = asString(data.name) ?? fact.statement;
  const summary = asString(data.summary);
  const repositoryUrl = asString(data.repositoryUrl);
  const url = asString(data.url) ?? repositoryUrl;
  return {
    id: createStableId('project', fact.canonicalKey ?? fact.id),
    name,
    ...(summary ? { summary } : {}),
    ...(url ? { url } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    skills: dedupeStrings(asStringArray(data.skills)),
    factIds: [fact.id],
    evidenceRefs: dedupeEvidenceRefs(fact.evidenceRefs)
  };
}

function experienceFromFact(fact: CareerFact): CareerExperience {
  const data = fact.normalizedData;
  const role = asString(data.role) ?? asString(data.title) ?? fact.statement;
  const organization = asString(data.organization) ?? asString(data.company);
  return {
    id: createStableId('experience', fact.canonicalKey ?? fact.id),
    ...(organization ? { organization } : {}),
    role,
    ...(asString(data.summary) ? { summary: asString(data.summary) } : { summary: fact.statement }),
    ...(asString(data.startDate) ? { startDate: asString(data.startDate) } : {}),
    ...(asString(data.endDate) ? { endDate: asString(data.endDate) } : {}),
    factIds: [fact.id],
    evidenceRefs: dedupeEvidenceRefs(fact.evidenceRefs)
  };
}

function skillFromFact(fact: CareerFact): CareerSkill {
  const data = fact.normalizedData;
  const name = asString(data.name) ?? asString(data.skill) ?? fact.statement;
  const category = asString(data.category);
  return {
    id: createStableId('skill', normalizeText(name)),
    name,
    ...(category ? { category } : {}),
    factIds: [fact.id],
    evidenceRefs: dedupeEvidenceRefs(fact.evidenceRefs)
  };
}

function skillsFromFacts(projectFacts: CareerFact[], explicitSkillFacts: CareerFact[]): CareerSkill[] {
  const byName = new Map<string, CareerSkill>();
  const addSkill = (skill: CareerSkill): void => {
    const key = normalizeText(skill.name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, skill);
      return;
    }
    existing.factIds = [...new Set([...existing.factIds, ...skill.factIds])].sort();
    existing.evidenceRefs = dedupeEvidenceRefs([...existing.evidenceRefs, ...skill.evidenceRefs]);
  };

  for (const fact of explicitSkillFacts) {
    addSkill(skillFromFact(fact));
  }
  for (const fact of projectFacts) {
    for (const name of asStringArray(fact.normalizedData.skills)) {
      addSkill({
        id: createStableId('skill', normalizeText(name)),
        name,
        factIds: [fact.id],
        evidenceRefs: dedupeEvidenceRefs(fact.evidenceRefs)
      });
    }
  }
  return sortByLabel([...byName.values()]);
}

function achievementFromFact(fact: CareerFact): CareerAchievement {
  const data = fact.normalizedData;
  const metric = asString(data.metric);
  return {
    id: createStableId('achievement', fact.canonicalKey ?? fact.id),
    statement: fact.statement,
    ...(metric ? { metric } : {}),
    factIds: [fact.id],
    evidenceRefs: dedupeEvidenceRefs(fact.evidenceRefs)
  };
}

function sortByLabel<T extends { name?: string; role?: string; statement?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    (left.name ?? left.role ?? left.statement ?? '').localeCompare(
      right.name ?? right.role ?? right.statement ?? ''
    )
  );
}

/** Build the renderer-facing profile from confirmed facts only. */
export function buildCareerProfile(
  seed: ProfileSeed,
  facts: CareerFact[],
  generatedAt = new Date().toISOString()
): CareerProfile {
  const confirmedFacts = facts.filter((fact) => fact.status === 'confirmed').map(validateCareerFact);
  const projectFacts = confirmedFacts.filter((fact) => fact.type === 'project');
  const projects = projectFacts.map(projectFromFact);
  const experiences = confirmedFacts
    .filter((fact) => fact.type === 'experience' || fact.type === 'role')
    .map(experienceFromFact);
  const skills = skillsFromFacts(
    projectFacts,
    confirmedFacts.filter((fact) => fact.type === 'skill')
  );
  const achievements = confirmedFacts
    .filter((fact) => fact.type === 'achievement' || fact.type === 'metric')
    .map(achievementFromFact);

  return {
    id: seed.id,
    displayName: seed.displayName,
    ...(seed.headline ? { headline: seed.headline } : {}),
    ...(seed.about ? { about: seed.about } : {}),
    experiences: sortByLabel(experiences),
    projects: sortByLabel(projects),
    skills: sortByLabel(skills),
    achievements: sortByLabel(achievements),
    generatedAt
  };
}

export function buildCareerIR(input: BuildCareerIRInput): CareerIR {
  const now = input.exportedAt ?? new Date().toISOString();
  const facts = input.facts.map(validateCareerFact);
  const evidence = input.evidence.map(validateCareerEvidence);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  for (const fact of facts) {
    for (const reference of fact.evidenceRefs) {
      if (!evidenceIds.has(reference.evidenceId)) {
        throw new Error(`Fact ${fact.id} references evidence not present in IR: ${reference.evidenceId}`);
      }
    }
  }
  return validateCareerIR({
    kind: 'career-ir',
    schemaVersion: CAREER_IR_SCHEMA_VERSION,
    exportedAt: now,
    profile: buildCareerProfile(input.profile, facts, now),
    facts,
    evidence
  });
}

export function getFactEvidenceIds(fact: CareerFact): string[] {
  return fact.evidenceRefs.map((reference) => reference.evidenceId);
}
