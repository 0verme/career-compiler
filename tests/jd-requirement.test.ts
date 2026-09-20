import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DomainValidationError,
  DeterministicJdRequirementParser,
  assertJdRequirementQuote,
  buildJdRequirementSet,
  confirmJdRequirement,
  confirmedJdRequirements,
  createTargetJob,
  editJdRequirement,
  getJdRequirementSet,
  isJdRequirementSetStale,
  parseJdRequirementsForTarget,
  rejectJdRequirement,
  updateTargetJob,
  validateJdRequirement,
  type JdRequirementCandidate,
  type JdRequirementParser,
  type TargetJob
} from '@career-compiler/core';
import { SQLiteCareerRepository } from '@career-compiler/storage';

const NOW = '2025-01-15T00:00:00.000Z';
const LATER = '2025-01-16T00:00:00.000Z';

const JD = [
  'Senior Data Platform Lead',
  '',
  '岗位职责：',
  '- 负责湖仓一体平台建设，服务180+上游系统；',
  '- 带领18人团队交付数据治理能力。',
  '',
  '任职要求：',
  '- 本科及以上学历，计算机相关专业；',
  '- 5年以上数据平台开发经验；',
  '- 熟悉 Kafka、Flink、Iceberg；',
  '',
  '加分项：',
  '- 有金融行业经验者优先；',
  '- 熟悉 Kubernetes 优先。'
].join('\n');

const JD_UPDATED = JD.replace('熟悉 Kafka、Flink、Iceberg', '精通 Kafka 与 Flink');

function targetJob(rawJd = JD, now = NOW): TargetJob {
  return createTargetJob(
    { title: 'Data Platform Lead', company: 'Acme', rawJd },
    { id: 'targetjob_test', now }
  );
}

function parser(): DeterministicJdRequirementParser {
  return new DeterministicJdRequirementParser();
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function repository(): Promise<SQLiteCareerRepository> {
  const directory = await mkdtemp(join(tmpdir(), 'career-compiler-jd-'));
  temporaryDirectories.push(directory);
  return new SQLiteCareerRepository({ filePath: join(directory, 'career.sqlite') });
}

describe('DeterministicJdRequirementParser', () => {
  it('is deterministic and keeps every quote verbatim locatable', () => {
    const first = parser().parse(JD);
    const second = parser().parse(JD);
    expect(second).toEqual(first);
    expect(first).toHaveLength(7);
    for (const candidate of first) {
      expect(JD.slice(candidate.quoteRange.start, candidate.quoteRange.end)).toBe(
        candidate.rawQuote
      );
    }
  });

  it('classifies sections, priorities and categories', () => {
    const candidates = parser().parse(JD);
    expect(candidates.map((item) => [item.statement, item.category, item.priority])).toEqual([
      ['负责湖仓一体平台建设，服务180+上游系统', 'responsibility', 'required'],
      ['带领18人团队交付数据治理能力', 'management', 'required'],
      ['本科及以上学历，计算机相关专业', 'education', 'required'],
      ['5年以上数据平台开发经验', 'experience', 'required'],
      ['熟悉 Kafka、Flink、Iceberg', 'skill', 'required'],
      ['有金融行业经验者优先', 'experience', 'preferred'],
      ['熟悉 Kubernetes 优先', 'skill', 'preferred']
    ]);
  });

  it('skips the document title but keeps compact JDs without headings intact', () => {
    expect(parser().parse(JD)).not.toContainEqual(
      expect.objectContaining({ rawQuote: 'Senior Data Platform Lead' })
    );
    const compact = ['熟悉 Kafka', '精通 Flink'].join('\n');
    expect(parser().parse(compact)).toHaveLength(2);
  });

  it('does not treat a compact heading line as a heading', () => {
    const compact = ['任职要求：3年以上数据平台经验'].join('\n');
    const candidates = parser().parse(compact);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.category).toBe('experience');
    expect(candidates[0]?.rawQuote).toBe('任职要求：3年以上数据平台经验');
  });
});

describe('JdRequirement build and lifecycle', () => {
  it('assigns deterministic ids and parsed status without confirming anything', () => {
    const job = targetJob();
    const set = buildJdRequirementSet(job, parser().parse(job.rawJd), { now: NOW });
    const again = buildJdRequirementSet(job, parser().parse(job.rawJd), { now: LATER });

    expect(set.requirements).toHaveLength(7);
    expect(again.requirements.map((item) => item.id)).toEqual(
      set.requirements.map((item) => item.id)
    );
    for (const requirement of set.requirements) {
      expect(requirement.status).toBe('parsed');
      expect(requirement.sourceRawJdHash).toBe(job.rawJdHash);
      expect(validateJdRequirement(requirement)).toEqual(requirement);
      assertJdRequirementQuote(requirement, job.rawJd);
    }
  });

  it('rejects tampered quotes and ids that do not match their range', () => {
    const job = targetJob();
    const set = buildJdRequirementSet(job, parser().parse(job.rawJd), { now: NOW });
    const [first] = set.requirements;

    expect(() =>
      assertJdRequirementQuote({ ...first!, rawQuote: 'not in the raw JD' }, job.rawJd)
    ).toThrow(/not locatable/);
    expect(() => validateJdRequirement({ ...first!, id: 'jdreq_tampered' })).toThrow(
      /must be derived/
    );
  });

  it('runs parsed → confirmed / rejected and preserves quotes on edit', () => {
    const job = targetJob();
    const set = buildJdRequirementSet(job, parser().parse(job.rawJd), { now: NOW });
    const first = set.requirements[0]!;

    const confirmed = confirmJdRequirement(first, { now: LATER });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.updatedAt).toBe(LATER);
    expect(confirmJdRequirement(confirmed, { now: NOW })).toEqual(confirmed);

    const rejected = rejectJdRequirement(set.requirements[1]!, { now: LATER });
    expect(rejected.status).toBe('rejected');
    expect(rejected.id).toBe(set.requirements[1]!.id);

    const edited = editJdRequirement(first, { priority: 'preferred', statement: '平台建设' }, { now: LATER });
    expect(edited.priority).toBe('preferred');
    expect(edited.statement).toBe('平台建设');
    expect(edited.id).toBe(first.id);
    expect(edited.rawQuote).toBe(first.rawQuote);
    expect(edited.quoteRange).toEqual(first.quoteRange);

    expect(confirmedJdRequirements([confirmed, rejected, ...set.requirements.slice(2)])).toEqual([
      confirmed
    ]);
    expect(confirmJdRequirement(confirmed, { now: NOW })).toBe(confirmed);
    expect(editJdRequirement(edited, { statement: '平台建设' }, { now: NOW })).toBe(edited);
    expect(() => editJdRequirement(edited, { statement: '   ' })).toThrow(/non-empty/);
    expect(() => editJdRequirement(edited, {})).toThrow(/at least one/);
  });
});

describe('stale detection and re-parse', () => {
  it('marks requirements stale after the raw JD changes and rebinds on re-parse', async () => {
    const repo = await repository();
    const job = targetJob();
    repo.saveTargetJob(job);
    const set = parseJdRequirementsForTarget(job, repo, parser(), { now: NOW });

    const updated = updateTargetJob(job, { rawJd: JD_UPDATED }, { now: LATER });
    repo.saveTargetJob(updated);
    expect(isJdRequirementSetStale(set, updated)).toBe(true);
    expect(isJdRequirementSetStale(set, job)).toBe(false);

    const reparsed = parseJdRequirementsForTarget(updated, repo, parser(), { now: LATER });
    expect(reparsed.rawJdHash).toBe(updated.rawJdHash);
    expect(reparsed.requirements[0]?.sourceRawJdHash).toBe(updated.rawJdHash);
    expect(isJdRequirementSetStale(reparsed, updated)).toBe(false);
    // Re-parse replaces the set: confirmations do not survive a changed raw JD.
    expect(reparsed.requirements.every((item) => item.status === 'parsed')).toBe(true);
    expect(getJdRequirementSet(updated, repo)).toEqual(reparsed);
    repo.close();
  });

  it('leaves the previous set untouched when a parse produces an unlocatable quote', async () => {
    const repo = await repository();
    const job = targetJob();
    repo.saveTargetJob(job);
    const set = parseJdRequirementsForTarget(job, repo, parser(), { now: NOW });

    const brokenParser: JdRequirementParser = {
      id: 'broken',
      version: '1',
      parse: (): JdRequirementCandidate[] => [
        {
          category: 'skill',
          priority: 'required',
          statement: 'fabricated',
          rawQuote: 'this quote does not exist in the JD',
          quoteRange: { start: 0, end: 5 },
          confidence: 0.5
        }
      ]
    };
    expect(() => parseJdRequirementsForTarget(job, repo, brokenParser, { now: LATER })).toThrow(
      /not locatable/
    );
    expect(getJdRequirementSet(job, repo)).toEqual(set);
    repo.close();
  });
});

describe('JD requirement storage and boundaries', () => {
  it('round-trips requirements and review edits', async () => {
    const repo = await repository();
    const job = targetJob();
    repo.saveTargetJob(job);
    const set = parseJdRequirementsForTarget(job, repo, parser(), { now: NOW });

    expect(repo.listJdRequirements(job.id)).toEqual(set.requirements);
    const first = set.requirements[0]!;
    expect(repo.getJdRequirement(first.id)).toEqual(first);

    const confirmed = confirmJdRequirement(first, { now: LATER });
    repo.saveJdRequirement(confirmed);
    expect(repo.getJdRequirement(first.id)?.status).toBe('confirmed');
    expect(repo.listJdRequirements(job.id)[0]?.status).toBe('confirmed');
    repo.close();
  });

  it('refuses to store requirements for another target job and keeps rows intact', async () => {
    const repo = await repository();
    const job = targetJob();
    repo.saveTargetJob(job);
    const set = parseJdRequirementsForTarget(job, repo, parser(), { now: NOW });

    const otherJob = createTargetJob(
      { title: 'Other Role', rawJd: JD_UPDATED },
      { id: 'targetjob_other', now: NOW }
    );
    const foreign = buildJdRequirementSet(otherJob, parser().parse(otherJob.rawJd), {
      now: NOW
    }).requirements[0]!;
    expect(() => repo.replaceJdRequirements(job.id, [foreign])).toThrow(/belongs to target job/);
    expect(repo.listJdRequirements(job.id)).toEqual(set.requirements);
    repo.close();
  });

  it('never touches career facts, evidence or the Career IR', async () => {
    const repo = await repository();
    const job = targetJob();
    repo.saveTargetJob(job);
    const factsBefore = repo.listFacts();
    const evidenceBefore = repo.listEvidence();

    const set = parseJdRequirementsForTarget(job, repo, parser(), { now: NOW });
    repo.saveJdRequirement(confirmJdRequirement(set.requirements[0]!, { now: LATER }));
    repo.saveJdRequirement(rejectJdRequirement(set.requirements[1]!, { now: LATER }));

    expect(repo.listFacts()).toEqual(factsBefore);
    expect(repo.listEvidence()).toEqual(evidenceBefore);
    expect(repo.loadCareerIR('alice')).toBeUndefined();
    repo.close();
  });

  it('rejects structurally invalid stored requirements on read', async () => {
    const repo = await repository();
    const job = targetJob();
    repo.saveTargetJob(job);
    expect(() =>
      repo.saveJdRequirement({
        ...buildJdRequirementSet(job, parser().parse(job.rawJd), { now: NOW }).requirements[0]!,
        confidence: 42
      })
    ).toThrow(DomainValidationError);
    repo.close();
  });
});
