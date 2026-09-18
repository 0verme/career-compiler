import type {
  CareerAchievement,
  CareerAchievementComponent,
  CareerAchievementFactRef,
  CareerEvidenceRef,
  CareerFact
} from './types.js';
import {
  createStableId,
  dedupeEvidenceRefs,
  experienceIdFromFact,
  normalizeText,
  projectIdFromFact
} from './ids.js';

const COMPONENT_FIELDS = ['problem', 'constraint', 'decision', 'action', 'result', 'metric'] as const;
type ComponentField = (typeof COMPONENT_FIELDS)[number];

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function setIfAbsent<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key)) {
    map.set(key, value);
  }
}

interface AchievementLinkIndex {
  projectsByKey: Map<string, CareerFact>;
  projectsByName: Map<string, CareerFact>;
  experiencesByKey: Map<string, CareerFact>;
  experiencesByRole: Map<string, CareerFact>;
}

function isExperienceFact(fact: CareerFact): boolean {
  return fact.type === 'experience' || fact.type === 'role';
}

/**
 * Index confirmed project/experience facts so achievement facts can link to them.
 * Input is pre-sorted by canonical key, so the first match is deterministic.
 */
function buildLinkIndex(confirmedFacts: CareerFact[]): AchievementLinkIndex {
  const index: AchievementLinkIndex = {
    projectsByKey: new Map(),
    projectsByName: new Map(),
    experiencesByKey: new Map(),
    experiencesByRole: new Map()
  };
  for (const fact of confirmedFacts) {
    if (fact.canonicalKey) {
      if (fact.type === 'project') {
        setIfAbsent(index.projectsByKey, fact.canonicalKey, fact);
      }
      if (isExperienceFact(fact)) {
        setIfAbsent(index.experiencesByKey, fact.canonicalKey, fact);
      }
    }
    if (fact.type === 'project') {
      const names = [
        asString(fact.normalizedData.name),
        asString(fact.normalizedData.canonicalName)
      ];
      for (const name of names) {
        if (name) {
          setIfAbsent(index.projectsByName, normalizeText(name), fact);
        }
      }
    }
    if (isExperienceFact(fact)) {
      const role = asString(fact.normalizedData.role) ?? asString(fact.normalizedData.title);
      if (role) {
        setIfAbsent(index.experiencesByRole, normalizeText(role), fact);
      }
    }
  }
  return index;
}

function linkedProject(index: AchievementLinkIndex, fact: CareerFact): CareerFact | undefined {
  const key = asString(fact.normalizedData.projectKey);
  const name = asString(fact.normalizedData.projectName);
  return (
    (key ? index.projectsByKey.get(key) : undefined) ??
    (name ? index.projectsByName.get(normalizeText(name)) : undefined)
  );
}

function linkedExperience(index: AchievementLinkIndex, fact: CareerFact): CareerFact | undefined {
  const key = asString(fact.normalizedData.experienceKey);
  const role = asString(fact.normalizedData.experienceRole);
  return (
    (key ? index.experiencesByKey.get(key) : undefined) ??
    (role ? index.experiencesByRole.get(normalizeText(role)) : undefined)
  );
}

function mergeFactRef(target: Map<string, CareerAchievementFactRef>, ref: CareerAchievementFactRef): void {
  const existing = target.get(ref.factId);
  if (!existing) {
    target.set(ref.factId, { ...ref, contributes: [...ref.contributes] });
    return;
  }
  existing.contributes = [...new Set([...existing.contributes, ...ref.contributes])];
  if (existing.relation === 'context' && ref.relation !== 'context') {
    existing.relation = ref.relation;
  }
}

function achievementFromFact(
  fact: CareerFact,
  index: AchievementLinkIndex
): CareerAchievement {
  const contributes: CareerAchievementComponent[] = ['statement'];
  const components: Partial<Record<ComponentField, string>> = {};
  for (const field of COMPONENT_FIELDS) {
    const value = asString(fact.normalizedData[field]);
    if (value) {
      components[field] = value;
      contributes.push(field);
    }
  }

  const factRefs = new Map<string, CareerAchievementFactRef>();
  mergeFactRef(factRefs, { factId: fact.id, relation: 'derived-from', contributes });
  const evidenceRefs: CareerEvidenceRef[] = [...fact.evidenceRefs];

  const project = linkedProject(index, fact);
  if (project) {
    mergeFactRef(factRefs, { factId: project.id, relation: 'context', contributes: [] });
    evidenceRefs.push(...project.evidenceRefs);
  }

  const experience = linkedExperience(index, fact);
  if (experience) {
    mergeFactRef(factRefs, { factId: experience.id, relation: 'context', contributes: [] });
    evidenceRefs.push(...experience.evidenceRefs);
  }

  return {
    id: createStableId('achievement', fact.canonicalKey ?? fact.id),
    statement: fact.statement,
    ...components,
    ...(project ? { projectId: projectIdFromFact(project) } : {}),
    ...(experience ? { experienceId: experienceIdFromFact(experience) } : {}),
    status: 'confirmed',
    factRefs: [...factRefs.values()].sort((left, right) => left.factId.localeCompare(right.factId)),
    evidenceRefs: dedupeEvidenceRefs(evidenceRefs)
  };
}

/**
 * Deterministic Fact → Achievement compiler.
 *
 * Rules:
 * - Only confirmed facts produce formal achievements; candidate/rejected content is ignored.
 * - `achievement`/`metric` facts are achievement units; `project`/`experience`/`role`
 *   facts are link targets only.
 * - Component values are copied verbatim (trimmed) from fact normalizedData. Missing
 *   components stay absent; nothing is synthesized or inferred.
 * - A unit always carries factRefs and evidenceRefs so every claim stays traceable.
 */
export function compileAchievements(facts: CareerFact[]): CareerAchievement[] {
  const confirmedFacts = facts
    .filter((fact) => fact.status === 'confirmed')
    .sort((left, right) =>
      (left.canonicalKey ?? left.id).localeCompare(right.canonicalKey ?? right.id)
    );
  const index = buildLinkIndex(confirmedFacts);
  return confirmedFacts
    .filter((fact) => fact.type === 'achievement' || fact.type === 'metric')
    .map((fact) => achievementFromFact(fact, index))
    .sort((left, right) =>
      left.statement.localeCompare(right.statement) || left.id.localeCompare(right.id)
    );
}
