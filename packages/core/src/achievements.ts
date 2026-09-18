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

function addLinkCandidate(map: Map<string, CareerFact[]>, key: string, fact: CareerFact): void {
  const candidates = map.get(key);
  if (candidates) {
    candidates.push(fact);
    return;
  }
  map.set(key, [fact]);
}

interface AchievementLinkIndex {
  projectsByKey: Map<string, CareerFact[]>;
  projectsByName: Map<string, CareerFact[]>;
  experiencesByKey: Map<string, CareerFact[]>;
  experiencesByRole: Map<string, CareerFact[]>;
}

function isExperienceFact(fact: CareerFact): boolean {
  return fact.type === 'experience' || fact.type === 'role';
}

/**
 * Index confirmed project/experience facts so achievement facts can link to them.
 * Every candidate key keeps all matches; ambiguity is resolved at lookup time and
 * never by input order.
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
        addLinkCandidate(index.projectsByKey, fact.canonicalKey, fact);
      }
      if (isExperienceFact(fact)) {
        addLinkCandidate(index.experiencesByKey, fact.canonicalKey, fact);
      }
    }
    if (fact.type === 'project') {
      const names = [
        asString(fact.normalizedData.name),
        asString(fact.normalizedData.canonicalName)
      ];
      for (const name of names) {
        if (name) {
          addLinkCandidate(index.projectsByName, normalizeText(name), fact);
        }
      }
    }
    if (isExperienceFact(fact)) {
      const role = asString(fact.normalizedData.role) ?? asString(fact.normalizedData.title);
      if (role) {
        addLinkCandidate(index.experiencesByRole, normalizeText(role), fact);
      }
    }
  }
  return index;
}

/** Only an exact single match may link; zero or multiple candidates stay unresolved. */
function uniqueCandidate(candidates: CareerFact[] | undefined): CareerFact | undefined {
  if (!candidates || candidates.length !== 1) {
    return undefined;
  }
  return candidates[0];
}

function linkedProject(index: AchievementLinkIndex, fact: CareerFact): CareerFact | undefined {
  const key = asString(fact.normalizedData.projectKey);
  if (key && index.projectsByKey.has(key)) {
    // An exact key is authoritative; conflicting facts with the same key stay unresolved.
    return uniqueCandidate(index.projectsByKey.get(key));
  }
  const name = asString(fact.normalizedData.projectName);
  return name ? uniqueCandidate(index.projectsByName.get(normalizeText(name))) : undefined;
}

function linkedExperience(index: AchievementLinkIndex, fact: CareerFact): CareerFact | undefined {
  const key = asString(fact.normalizedData.experienceKey);
  if (key && index.experiencesByKey.has(key)) {
    // An exact key is authoritative; conflicting facts with the same key stay unresolved.
    return uniqueCandidate(index.experiencesByKey.get(key));
  }
  const role = asString(fact.normalizedData.experienceRole);
  return role ? uniqueCandidate(index.experiencesByRole.get(normalizeText(role))) : undefined;
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
  // Only facts that substantiate a component contribute evidence. Context facts stay
  // traceable through their context factRef and must not widen the direct evidence set.
  const evidenceRefs: CareerEvidenceRef[] = [...fact.evidenceRefs];

  const project = linkedProject(index, fact);
  if (project) {
    mergeFactRef(factRefs, { factId: project.id, relation: 'context', contributes: [] });
  }

  const experience = linkedExperience(index, fact);
  if (experience) {
    mergeFactRef(factRefs, { factId: experience.id, relation: 'context', contributes: [] });
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
 * - Project/experience links resolve only through an exact unique canonical key or a
 *   unique confirmed name/role candidate; ambiguous matches stay empty instead of
 *   picking by input order.
 * - evidenceRefs is the evidence union of facts that contribute components; context
 *   fact evidence remains reachable via factRefs → context fact → fact.evidenceRefs.
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
