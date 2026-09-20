import type {
  JdRequirement,
  JdRequirementCandidate,
  JdRequirementCategory,
  JdRequirementEditPatch,
  JdRequirementParser,
  JdRequirementPriority,
  JdRequirementRepository,
  JdRequirementSet,
  TargetJob
} from './types.js';
import { createJdRequirementId } from './ids.js';
import {
  DomainValidationError,
  assertJdRequirementQuote,
  validateJdRequirement,
  validateJdRequirementEditPatch,
  validateJdRequirementSet,
  validateTargetJob
} from './validation.js';

/**
 * JD → Requirement 理解层（v1 deterministic rules）。
 *
 * This module only reads the complete raw JD and produces reviewable candidate
 * requirements. It never matches requirements against career evidence (#17) and
 * never touches CareerFact / CareerEvidence / CareerAchievement / CareerProfile.
 */

type SectionKind = 'responsibility' | 'required' | 'preferred';

const SECTION_RULES: Array<{ kind: SectionKind; pattern: RegExp }> = [
  {
    kind: 'responsibility',
    pattern:
      /^(岗位职责|工作职责|职位职责|职责描述|工作内容|职位描述|responsibilities|responsibility|what you.?ll do|the role)/i
  },
  {
    kind: 'preferred',
    pattern:
      /^(加分项|优先条件|优先考虑|preferred qualifications|preferred|nice.?to.?have|bonus|plus)/i
  },
  {
    kind: 'required',
    pattern:
      /^(任职要求|岗位要求|职位要求|任职资格|任职条件|基本要求|资格要求|requirements|qualifications|must.?have|required)/i
  }
];

const CATEGORY_RULES: Array<{ category: JdRequirementCategory; pattern: RegExp }> = [
  {
    category: 'education',
    pattern: /(本科|硕士|博士|学历|学位|bachelor|master|phd|degree)/i
  },
  {
    category: 'experience',
    pattern: /(经验|年以上|从业|工作年限|\d+\s*\+?\s*年|\d+\+?\s*years?|experience)/i
  },
  {
    category: 'management',
    pattern: /(团队管理|管理团队|带领|团队|领导班子|management|manage|leadership|lead a team|headcount)/i
  },
  {
    category: 'domain',
    pattern:
      /(行业|领域|金融|券商|银行|保险|支付|风控|电商|互联网|广告|物流|医疗|fintech|industry|domain)/i
  },
  {
    category: 'skill',
    pattern:
      /(熟悉|精通|掌握|了解|具备|熟练|proficient|familiar|knowledge of|experience with|using|skills?)/i
  }
];

const PREFERRED_PATTERN = /(加分|优先|preferred|nice.?to.?have|bonus|plus)/i;
const LIST_MARKER = /^(?:[-*•·–—]\s*|\(\d+\)\s*|（\d+）\s*|\d+[.、)）]\s*|\[[ xX]\]\s*)+/;

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

function sourceLines(rawJd: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  for (const rawLine of rawJd.split('\n')) {
    lines.push({ text: rawLine, start: offset, end: offset + rawLine.length });
    offset += rawLine.length + 1;
  }
  return lines;
}

interface TrimmedLine {
  text: string;
  start: number;
  end: number;
}

function trimNonWhitespace(line: SourceLine): TrimmedLine | undefined {
  const match = /\S(?:[\s\S]*\S)?/.exec(line.text);
  if (!match || match.index === undefined) {
    return undefined;
  }
  const start = line.start + match.index;
  return { text: match[0], start, end: start + match[0].length };
}

/**
 * Section headings carry the default priority for their lines. Only short,
 * punctuation-free lines that consist of the heading itself count; a compact
 * line such as `任职要求：3年以上经验` stays a requirement.
 */
function detectSection(text: string): SectionKind | undefined {
  if (/[。；;]/.test(text)) {
    return undefined;
  }
  const base = text
    .replace(/^[#*_\s]+/, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[：:。.\s]+/g, ' ')
    .trim();
  if (base.length === 0 || base.length > 24) {
    return undefined;
  }
  for (const rule of SECTION_RULES) {
    const match = rule.pattern.exec(base);
    if (match && base.slice(match[0].length).trim().length === 0) {
      return rule.kind;
    }
  }
  return undefined;
}

function hasListMarker(text: string): boolean {
  return LIST_MARKER.test(text);
}

/** Normalization removes list markers / emphasis only; rawQuote stays verbatim. */
function normalizeStatement(text: string): string {
  return text
    .replace(LIST_MARKER, '')
    .replace(/^[*_`#\s]+/, '')
    .replace(/[*_`\s]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/[。；;]+$/u, '')
    .trim();
}

function classifyPriority(statement: string, section: SectionKind | undefined): JdRequirementPriority {
  if (section === 'preferred' || PREFERRED_PATTERN.test(statement)) {
    return 'preferred';
  }
  if (section === 'required' || section === 'responsibility') {
    return 'required';
  }
  return 'unspecified';
}

function classifyCategory(
  statement: string,
  section: SectionKind | undefined
): JdRequirementCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(statement)) {
      return rule.category;
    }
  }
  return section === 'responsibility' ? 'responsibility' : 'other';
}

function confidenceFor(
  section: SectionKind | undefined,
  hasMarker: boolean,
  category: JdRequirementCategory,
  priority: JdRequirementPriority
): number {
  let confidence = 0.5;
  if (section !== undefined) {
    confidence += 0.2;
  }
  if (hasMarker) {
    confidence += 0.1;
  }
  if (category !== 'other') {
    confidence += 0.1;
  }
  if (priority !== 'unspecified') {
    confidence += 0.1;
  }
  return Math.round(Math.min(0.99, confidence) * 100) / 100;
}

/**
 * Deterministic rule-based parser.
 *
 * Guarantees: same raw JD → same candidates, in document order. Quotes are
 * verbatim slices of the raw JD, so traceability is exact and testable. The
 * parser never invents requirements and never marks anything as confirmed.
 */
export class DeterministicJdRequirementParser implements JdRequirementParser {
  readonly id = 'deterministic-jd-rules';
  readonly version = '1';

  parse(rawJd: string): JdRequirementCandidate[] {
    const nonEmpty: TrimmedLine[] = [];
    for (const line of sourceLines(rawJd)) {
      const trimmed = trimNonWhitespace(line);
      if (trimmed) {
        nonEmpty.push(trimmed);
      }
    }
    // A leading title line before the first section heading is document
    // metadata (already stored on TargetJob), not a requirement.
    let startIndex = 0;
    if (
      nonEmpty.length >= 2 &&
      detectSection(nonEmpty[0]!.text) === undefined &&
      detectSection(nonEmpty[1]!.text) !== undefined
    ) {
      startIndex = 1;
    }
    const candidates: JdRequirementCandidate[] = [];
    let section: SectionKind | undefined;
    for (let index = startIndex; index < nonEmpty.length; index += 1) {
      const trimmed = nonEmpty[index]!;
      const detected = detectSection(trimmed.text);
      if (detected !== undefined) {
        section = detected;
        continue;
      }
      if (/^[-=~_*#\s]+$/.test(trimmed.text)) {
        continue;
      }
      const statement = normalizeStatement(trimmed.text);
      if (statement.length < 2) {
        continue;
      }
      const priority = classifyPriority(statement, section);
      const category = classifyCategory(statement, section);
      candidates.push({
        category,
        priority,
        statement,
        rawQuote: trimmed.text,
        quoteRange: { start: trimmed.start, end: trimmed.end },
        confidence: confidenceFor(section, hasListMarker(trimmed.text), category, priority)
      });
    }
    return candidates;
  }
}

export interface BuildJdRequirementSetOptions {
  now?: string;
}

/**
 * Assign deterministic identity and the `parsed` lifecycle state. Nothing is
 * confirmed here; confirmation is an explicit user action.
 */
export function buildJdRequirementSet(
  targetJob: TargetJob,
  candidates: JdRequirementCandidate[],
  options: BuildJdRequirementSetOptions = {}
): JdRequirementSet {
  const job = validateTargetJob(targetJob);
  const now = options.now ?? new Date().toISOString();
  const requirements = candidates.map((candidate) => {
    const requirement: JdRequirement = {
      id: createJdRequirementId(
        job.id,
        job.rawJdHash,
        candidate.quoteRange.start,
        candidate.quoteRange.end
      ),
      targetJobId: job.id,
      category: candidate.category,
      priority: candidate.priority,
      statement: candidate.statement,
      rawQuote: candidate.rawQuote,
      quoteRange: candidate.quoteRange,
      confidence: candidate.confidence,
      status: 'parsed',
      sourceRawJdHash: job.rawJdHash,
      createdAt: now,
      updatedAt: now
    };
    const validated = validateJdRequirement(requirement);
    assertJdRequirementQuote(validated, job.rawJd);
    return validated;
  });
  return validateJdRequirementSet({
    targetJobId: job.id,
    rawJdHash: job.rawJdHash,
    requirements
  });
}

/**
 * Parse a target job's raw JD and atomically replace its stored requirement
 * set. Validation and quote checks happen before any write, so a failed parse
 * leaves the previous set untouched.
 */
export function parseJdRequirementsForTarget(
  targetJob: TargetJob,
  repository: JdRequirementRepository,
  parser: JdRequirementParser = new DeterministicJdRequirementParser(),
  options: BuildJdRequirementSetOptions = {}
): JdRequirementSet {
  const job = validateTargetJob(targetJob);
  const candidates = parser.parse(job.rawJd);
  const set = buildJdRequirementSet(job, candidates, options);
  repository.replaceJdRequirements(job.id, set.requirements);
  return set;
}

/** Load the stored set for a target job. Empty sets report the current hash. */
export function getJdRequirementSet(
  targetJob: TargetJob,
  repository: JdRequirementRepository
): JdRequirementSet {
  const job = validateTargetJob(targetJob);
  const requirements = repository.listJdRequirements(job.id).map(validateJdRequirement);
  return validateJdRequirementSet({
    targetJobId: job.id,
    rawJdHash: requirements[0]?.sourceRawJdHash ?? job.rawJdHash,
    requirements
  });
}

/** True when the stored set was parsed from a different raw JD revision. */
export function isJdRequirementSetStale(set: JdRequirementSet, targetJob: TargetJob): boolean {
  return validateJdRequirementSet(set).rawJdHash !== validateTargetJob(targetJob).rawJdHash;
}

/** The only requirements that a future matcher may consume (#17). */
export function confirmedJdRequirements(requirements: JdRequirement[]): JdRequirement[] {
  return requirements
    .map(validateJdRequirement)
    .filter((requirement) => requirement.status === 'confirmed');
}

/**
 * Review actions. Confirmation is a user decision; parsed output is never
 * treated as capability and never enters matching by itself.
 */
export function confirmJdRequirement(
  requirement: JdRequirement,
  options: { now?: string } = {}
): JdRequirement {
  const current = validateJdRequirement(requirement);
  if (current.status === 'confirmed') {
    return current;
  }
  return validateJdRequirement({
    ...current,
    status: 'confirmed',
    updatedAt: options.now ?? new Date().toISOString()
  });
}

export function rejectJdRequirement(
  requirement: JdRequirement,
  options: { now?: string } = {}
): JdRequirement {
  const current = validateJdRequirement(requirement);
  if (current.status === 'rejected') {
    return current;
  }
  return validateJdRequirement({
    ...current,
    status: 'rejected',
    updatedAt: options.now ?? new Date().toISOString()
  });
}

/**
 * Correct category / priority / statement. `rawQuote` and `quoteRange` are
 * immutable: the quote is the evidence that this requirement came from the JD.
 */
export function editJdRequirement(
  requirement: JdRequirement,
  patch: JdRequirementEditPatch,
  options: { now?: string } = {}
): JdRequirement {
  const current = validateJdRequirement(requirement);
  const validatedPatch = validateJdRequirementEditPatch(patch);
  const statement = validatedPatch.statement?.trim() ?? current.statement;
  const category = validatedPatch.category ?? current.category;
  const priority = validatedPatch.priority ?? current.priority;
  if (
    statement === current.statement &&
    category === current.category &&
    priority === current.priority
  ) {
    return current;
  }
  if (statement.length === 0) {
    throw new DomainValidationError('requirement.statement must be a non-empty string');
  }
  return validateJdRequirement({
    ...current,
    category,
    priority,
    statement,
    updatedAt: options.now ?? new Date().toISOString()
  });
}
