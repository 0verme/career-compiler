import type {
  CareerAchievement,
  CareerEvidence,
  CareerEvidenceRef,
  CareerExperience,
  CareerFact,
  CareerIR,
  CareerIdentity,
  CareerProfile,
  CareerProject,
  CareerSkill,
  JsonObject,
  SourceType
} from './types.js';
import { CAREER_IR_SCHEMA_VERSION } from './types.js';
import {
  isEvidenceAttribution,
  validateCareerEvidence,
  validateCareerFact,
  validateCareerIR
} from './validation.js';

export interface ProfileSeed {
  id: string;
  displayName: string;
  headline?: string;
  about?: string;
  identity?: CareerIdentity;
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function evidenceAttribution(evidence: CareerEvidence): CareerEvidence['attribution'] {
  if (evidence.attribution !== undefined) {
    return evidence.attribution;
  }
  const normalized = evidence.normalized.attribution;
  return isEvidenceAttribution(normalized) ? normalized : undefined;
}

function isForkEvidence(evidence: CareerEvidence): boolean {
  return asBoolean(evidence.normalized.fork) === true || asBoolean(evidence.raw.fork) === true;
}

function repositoryMatchesActivity(repository: CareerEvidence, activity: CareerEvidence): boolean {
  const repositoryName = asString(repository.normalized.canonicalName) ?? asString(repository.normalized.name);
  const repositoryId = repository.sourceId;
  const activityRepository = asString(activity.normalized.repository);
  return Boolean(
    (activityRepository &&
      (activityRepository === repositoryId || activityRepository === repositoryName ||
        repositoryId.endsWith(`/${activityRepository}`))) ||
      activity.sourceId.startsWith(`${repositoryId}:`)
  );
}

function repositoryLabel(evidence: CareerEvidence): string {
  return asString(evidence.normalized.repository) ??
    asString(evidence.normalized.name) ??
    evidence.sourceId.split(':')[0] ?? evidence.sourceId;
}

function contributionFactFromActivity(
  activity: CareerEvidence,
  repositoryEvidence?: CareerEvidence
): CareerFact | undefined {
  if (evidenceAttribution(activity) !== 'authored') {
    return undefined;
  }
  const isPullRequest = activity.evidenceType === 'pull-request';
  const isIssue = activity.evidenceType === 'issue';
  const isFork = repositoryEvidence ? isForkEvidence(repositoryEvidence) : false;
  const isExternal = activity.externalContribution === true ||
    (typeof activity.normalized.externalContribution === 'boolean' && activity.normalized.externalContribution);
  if (!isPullRequest && !isIssue) {
    return undefined;
  }
  if (!isExternal && !isFork) {
    return undefined;
  }
  const repository = repositoryLabel(activity);
  const number = asString(activity.normalized.number) ?? String(activity.normalized.number ?? '');
  const title = asString(activity.normalized.title) ?? `${isPullRequest ? 'pull request' : 'issue'} #${number}`;
  const kind = isPullRequest ? 'pull request' : 'issue';
  const statement = isExternal
    ? `Contributed to ${repository} via ${kind} #${number}: ${title}`
    : `Contributed to the fork ${repository} via ${kind} #${number}: ${title}`;
  const canonicalKey = `contribution:${kind}:${normalizeText(repository)}:${number}`;
  return {
    id: createStableId('fact', canonicalKey),
    type: 'achievement',
    statement,
    normalizedData: {
      repository,
      ...(asString(activity.normalized.repositoryUrl) ? { repositoryUrl: asString(activity.normalized.repositoryUrl) } : {}),
      number: activity.normalized.number ?? number,
      title,
      kind,
      merged: asBoolean(activity.normalized.merged) ?? false,
      externalContribution: isExternal,
      attribution: 'authored'
    },
    status: 'candidate',
    confidence: isPullRequest ? 0.86 : 0.78,
    evidenceRefs: [
      ...(repositoryEvidence
        ? [{ evidenceId: repositoryEvidence.id, relation: 'context' as const, weight: 0.5 }]
        : []),
      { evidenceId: activity.id, relation: 'supports', weight: 1 }
    ],
    canonicalKey,
    createdAt: activity.discoveredAt,
    updatedAt: activity.discoveredAt
  };
}

function contributionFactFromAuthoredCommits(
  repository: CareerEvidence,
  activities: CareerEvidence[]
): CareerFact | undefined {
  if (!isForkEvidence(repository) || activities.length === 0) {
    return undefined;
  }
  const name = asString(repository.normalized.name) ?? repositoryLabel(repository);
  const canonicalName = asString(repository.normalized.canonicalName) ?? name;
  const canonicalKey = `contribution:fork:${normalizeText(canonicalName)}`;
  return {
    id: createStableId('fact', canonicalKey),
    type: 'achievement',
    statement: `Contributed to the fork ${name} through authored commits`,
    normalizedData: {
      name,
      ...(asString(repository.normalized.repositoryUrl) ?? repository.sourceUri
        ? { repositoryUrl: asString(repository.normalized.repositoryUrl) ?? repository.sourceUri }
        : {}),
      fork: true,
      attribution: 'contributed',
      authoredActivityCount: activities.length,
      skills: asStringArray(repository.normalized.skills)
    },
    status: 'candidate',
    confidence: 0.8,
    evidenceRefs: [
      { evidenceId: repository.id, relation: 'context', weight: 0.5 },
      ...activities.map((activity) => ({
        evidenceId: activity.id,
        relation: 'supports' as const,
        weight: 1
      }))
    ],
    canonicalKey,
    createdAt: repository.discoveredAt,
    updatedAt: repository.discoveredAt
  };
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

function factFromRepositoryEvidence(
  evidence: CareerEvidence,
  authoredActivities: CareerEvidence[]
): CareerFact | undefined {
  const normalized = evidence.normalized;
  const name = asString(normalized.name);
  const attribution = evidenceAttribution(evidence);
  const fork = isForkEvidence(evidence);
  if (!name || fork || (attribution !== 'owned' && attribution !== 'contributed')) {
    return undefined;
  }
  const summary = asString(normalized.description) ?? asString(normalized.summary);
  const repositoryUrl = asString(normalized.repositoryUrl) ?? evidence.sourceUri;
  const topics = asStringArray(normalized.topics);
  const languages = asStringArray(normalized.languages);
  const canonicalName = asString(normalized.canonicalName) ?? name;
  const canonicalKey = `project:${normalizeText(canonicalName)}`;
  const statement = attribution === 'owned'
    ? authoredActivities.length > 0
      ? `Works on ${name}`
      : `Maintains ${name}`
    : `Contributed to ${name}`;
  const normalizedData: JsonObject = {
    name,
    ...(summary ? { summary } : {}),
    ...(repositoryUrl ? { repositoryUrl, url: repositoryUrl } : {}),
    attribution,
    fork,
    authoredActivityCount: authoredActivities.length,
    skills: dedupeStrings([...topics, ...languages])
  };
  return {
    id: createStableId('fact', canonicalKey),
    type: 'project',
    statement,
    normalizedData,
    status: 'candidate',
    confidence: Math.round(Math.min(0.92, attribution === 'owned'
      ? 0.68 + Math.min(authoredActivities.length, 4) * 0.05
      : 0.72) * 100) / 100,
    evidenceRefs: [
      { evidenceId: evidence.id, relation: 'supports', weight: 1 },
      ...authoredActivities.map((activity) => ({
        evidenceId: activity.id,
        relation: 'supports' as const,
        weight: 1
      }))
    ],
    canonicalKey,
    createdAt: evidence.discoveredAt,
    updatedAt: evidence.discoveredAt
  };
}

/**
 * Promote only attributed repository ownership/contribution and explicit external
 * authored work. Context-only observations remain evidence and never become facts.
 */
export function deriveCandidateFacts(evidence: CareerEvidence[]): CareerFact[] {
  const candidates: CareerFact[] = [];
  const repositories = evidence.filter(
    (item) => item.evidenceType === 'repository' || item.evidenceType === 'local-repository'
  );
  const activities = evidence.filter(
    (item) => item.evidenceType === 'commit' || item.evidenceType === 'issue' || item.evidenceType === 'pull-request'
  );

  for (const repository of repositories) {
    const authoredActivities = activities.filter(
      (activity) => evidenceAttribution(activity) === 'authored' && repositoryMatchesActivity(repository, activity)
    );
    const project = factFromRepositoryEvidence(repository, authoredActivities);
    if (project) {
      candidates.push(project);
    }
    const authoredCommits = authoredActivities.filter((activity) => activity.evidenceType === 'commit');
    if (evidenceAttribution(repository) === 'context' || evidenceAttribution(repository) === 'unknown') {
      const forkContribution = contributionFactFromAuthoredCommits(repository, authoredCommits);
      if (forkContribution) {
        candidates.push(forkContribution);
      }
    }
    for (const activity of authoredActivities) {
      const contribution = contributionFactFromActivity(activity, repository);
      if (contribution) {
        candidates.push(contribution);
      }
    }
  }

  for (const activity of activities.filter((item) => !repositories.some((repository) => repositoryMatchesActivity(repository, item)))) {
    const contribution = contributionFactFromActivity(activity);
    if (contribution) {
      candidates.push(contribution);
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
    existing.factIds = [...new Set([...existing.factIds, ...skill.factIds])]
      .sort((left, right) => left.localeCompare(right));
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
    ...(seed.identity ? { identity: seed.identity } : {}),
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
