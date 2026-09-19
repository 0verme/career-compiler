import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DomainValidationError,
  buildCareerIR,
  confirmCareerFact,
  createTargetJob,
  deriveCandidateFacts,
  hashRawJd,
  serializeCareerIR,
  updateTargetJob,
  validateTargetJob,
  type TargetJob
} from '@career-compiler/core';
import { createAliceGitHubFixtureEvidence } from '@career-compiler/source-github';
import { SQLiteCareerRepository } from '@career-compiler/storage';

const NOW = '2025-01-15T00:00:00.000Z';
const LATER = '2025-01-16T00:00:00.000Z';
const LATEST = '2025-01-17T00:00:00.000Z';
const JD_A = [
  '数据平台负责人 / Data Platform Lead',
  '',
  '职责：',
  '- 负责湖仓一体平台建设，服务 180+ 上游系统；',
  '- 带领 18 人团队交付数据治理能力。',
  '',
  '要求：熟悉 Kafka、Flink、Iceberg。'
].join('\n');
const JD_B = [
  'Staff Data Engineer',
  '',
  'Responsibilities:',
  '- Own the streaming platform;',
  '- Drive data governance adoption.'
].join('\n');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'career-compiler-target-job-'));
  temporaryDirectories.push(directory);
  return join(directory, 'career.sqlite');
}

function largeRawJd(): string {
  return Array.from(
    { length: 4000 },
    (_, index) =>
      `职责 ${index + 1}：负责系统 ${index + 1} 的架构设计与交付，覆盖 ${index * 7} 个节点。`
  ).join('\n');
}

describe('TargetJob domain', () => {
  it('creates a target job with a stable id, timestamps and a raw JD hash', () => {
    const job = createTargetJob(
      { title: '  数据平台负责人  ', company: ' 某券商 ', rawJd: JD_A },
      { id: 'targetjob_test', now: NOW }
    );

    expect(job).toEqual({
      id: 'targetjob_test',
      company: '某券商',
      title: '数据平台负责人',
      rawJd: JD_A,
      rawJdHash: hashRawJd(JD_A),
      createdAt: NOW,
      updatedAt: NOW
    });
    expect(validateTargetJob(job)).toEqual(job);
  });

  it('generates a fresh identity per target job instead of deriving it from content', () => {
    const first = createTargetJob({ title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A }, { now: NOW });
    const second = createTargetJob({ title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A }, { now: NOW });
    const third = createTargetJob({ title: 'Data Platform Lead', rawJd: JD_B }, { now: NOW });

    expect(first.id).toMatch(/^targetjob_[0-9a-f-]{36}$/);
    expect(second.id).not.toBe(first.id);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it('hashes raw JD deterministically and only changes the hash when the text changes', () => {
    expect(hashRawJd(JD_A)).toBe(hashRawJd(JD_A));
    expect(hashRawJd(JD_A)).not.toBe(hashRawJd(JD_A + '\n'));

    const job = createTargetJob({ title: 'Data Platform Lead', rawJd: JD_A }, { id: 'targetjob_1', now: NOW });
    const sameJd = updateTargetJob(job, { rawJd: JD_A }, { now: LATER });
    const changedJd = updateTargetJob(job, { rawJd: JD_B }, { now: LATER });

    expect(sameJd.rawJdHash).toBe(job.rawJdHash);
    expect(changedJd.rawJdHash).toBe(hashRawJd(JD_B));
    expect(changedJd.rawJdHash).not.toBe(job.rawJdHash);
  });

  it('keeps the id stable when company, title or raw JD changes', () => {
    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_stable', now: NOW }
    );
    const renamed = updateTargetJob(job, { title: 'Staff Data Engineer' }, { now: LATER });
    const moved = updateTargetJob(renamed, { company: 'FinTech' }, { now: LATER });
    const rewritten = updateTargetJob(moved, { rawJd: JD_B }, { now: LATEST });

    for (const next of [renamed, moved, rewritten]) {
      expect(next.id).toBe('targetjob_stable');
      expect(next.createdAt).toBe(NOW);
    }
    expect(rewritten.title).toBe('Staff Data Engineer');
    expect(rewritten.company).toBe('FinTech');
    expect(rewritten.rawJd).toBe(JD_B);
    expect(rewritten.updatedAt).toBe(LATEST);
  });

  it('treats a patch that changes nothing as a no-op so updatedAt only moves on real change', () => {
    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_noop', now: NOW }
    );

    expect(updateTargetJob(job, { title: 'Data Platform Lead' }, { now: LATER }).updatedAt).toBe(NOW);
    expect(updateTargetJob(job, { company: 'Acme' }, { now: LATER }).updatedAt).toBe(NOW);
    expect(updateTargetJob(job, { rawJd: JD_A }, { now: LATER }).updatedAt).toBe(NOW);
    expect(updateTargetJob(job, { company: 'Acme Inc.' }, { now: LATER }).updatedAt).toBe(LATER);
    expect(updateTargetJob(job, { title: 'Data Platform Lead ' }, { now: LATER }).updatedAt).toBe(NOW);
  });

  it('clears the optional company with null without touching identity or raw JD', () => {
    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_clear', now: NOW }
    );
    const cleared = updateTargetJob(job, { company: null }, { now: LATER });

    expect(cleared.company).toBeUndefined();
    expect(cleared.id).toBe(job.id);
    expect(cleared.rawJd).toBe(JD_A);
    expect(cleared.updatedAt).toBe(LATER);
    expect('company' in cleared).toBe(false);
  });

  it('preserves raw JD verbatim, including large text, unicode and trailing whitespace', () => {
    const rawJd = `${largeRawJd()}\n\n  内部备注：保留尾部空白 ✅  \n`;
    expect(Buffer.byteLength(rawJd, 'utf8')).toBeGreaterThan(200_000);
    const job = createTargetJob({ title: '大文本 JD', rawJd }, { id: 'targetjob_large', now: NOW });
    expect(job.rawJd).toBe(rawJd);
    expect(job.rawJdHash).toBe(hashRawJd(rawJd));
  });

  it('rejects malformed target jobs, drafts, patches and forged hashes', () => {
    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_valid', now: NOW }
    );

    expect(() => createTargetJob({ title: '   ', rawJd: JD_A })).toThrow(DomainValidationError);
    expect(() => createTargetJob({ title: 'Data Platform Lead', rawJd: ' \n\t ' })).toThrow(
      DomainValidationError
    );
    expect(() =>
      createTargetJob({ title: 'Data Platform Lead', company: ' ', rawJd: JD_A })
    ).toThrow(DomainValidationError);
    expect(() => validateTargetJob({ ...job, id: '' })).toThrow(DomainValidationError);
    expect(() => validateTargetJob({ ...job, rawJdHash: 'deadbeef' })).toThrow(
      DomainValidationError
    );
    expect(() => validateTargetJob({ ...job, rawJd: JD_B })).toThrow(DomainValidationError);
    expect(() => validateTargetJob({ ...job, createdAt: 'yesterday' })).toThrow(
      DomainValidationError
    );
    expect(() => validateTargetJob({ ...job, updatedAt: 'yesterday' })).toThrow(
      DomainValidationError
    );
    expect(() => updateTargetJob(job, {})).toThrow(DomainValidationError);
    expect(() => updateTargetJob(job, { title: '' })).toThrow(DomainValidationError);
    expect(() => updateTargetJob(job, { company: '' })).toThrow(DomainValidationError);
    expect(() => updateTargetJob(job, { rawJd: '  ' })).toThrow(DomainValidationError);
  });
});

describe('TargetJob SQLite storage', () => {
  it('round-trips a target job through create and load', async () => {
    const filePath = await temporaryDatabasePath();
    const repository = new SQLiteCareerRepository({ filePath });
    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_roundtrip', now: NOW }
    );

    repository.saveTargetJob(job);

    expect(repository.getTargetJob(job.id)).toEqual(job);
    expect(repository.getTargetJob('targetjob_missing')).toBeUndefined();
    repository.close();
  });

  it('rejects a target job whose hash disagrees with its raw JD', async () => {
    const filePath = await temporaryDatabasePath();
    const repository = new SQLiteCareerRepository({ filePath });
    const job = createTargetJob({ title: 'Data Platform Lead', rawJd: JD_A }, { now: NOW });

    expect(() => repository.saveTargetJob({ ...job, rawJdHash: 'deadbeef' })).toThrow(
      DomainValidationError
    );
    expect(repository.listTargetJobs()).toEqual([]);
    repository.close();
  });

  it('lists target jobs most recently updated first', async () => {
    const filePath = await temporaryDatabasePath();
    const repository = new SQLiteCareerRepository({ filePath });
    const older = createTargetJob({ title: 'Older', rawJd: JD_A }, { id: 'targetjob_older', now: NOW });
    const newer = createTargetJob({ title: 'Newer', rawJd: JD_B }, { id: 'targetjob_newer', now: LATER });

    repository.saveTargetJob(older);
    repository.saveTargetJob(newer);
    expect(repository.listTargetJobs().map((job) => job.id)).toEqual([
      'targetjob_newer',
      'targetjob_older'
    ]);

    repository.updateTargetJob(older.id, { title: 'Older v2' }, { now: LATEST });
    expect(repository.listTargetJobs().map((job) => job.id)).toEqual([
      'targetjob_older',
      'targetjob_newer'
    ]);
    repository.close();
  });

  it('updates through the repository and persists the new hash and timestamp', async () => {
    const filePath = await temporaryDatabasePath();
    const repository = new SQLiteCareerRepository({ filePath });
    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_update', now: NOW }
    );
    repository.saveTargetJob(job);

    const updated = repository.updateTargetJob(job.id, { rawJd: JD_B }, { now: LATER });

    expect(updated?.id).toBe(job.id);
    expect(updated?.createdAt).toBe(NOW);
    expect(updated?.updatedAt).toBe(LATER);
    expect(updated?.rawJdHash).toBe(hashRawJd(JD_B));
    expect(repository.getTargetJob(job.id)).toEqual(updated);
    expect(repository.updateTargetJob('targetjob_missing', { rawJd: JD_B })).toBeUndefined();
    repository.close();
  });

  it('stores a large raw JD without losing a single character', async () => {
    const filePath = await temporaryDatabasePath();
    const rawJd = `${largeRawJd()}\n\n内部备注：尾部空白保留  `;
    const job = createTargetJob({ title: '大文本 JD', rawJd }, { id: 'targetjob_large', now: NOW });

    const repository = new SQLiteCareerRepository({ filePath });
    repository.saveTargetJob(job);
    repository.close();

    const reopened = new SQLiteCareerRepository({ filePath });
    expect(reopened.getTargetJob(job.id)?.rawJd).toBe(rawJd);
    expect(reopened.getTargetJob(job.id)?.rawJdHash).toBe(hashRawJd(rawJd));
    reopened.close();
  });

  it('keeps multiple target jobs isolated from each other and from career facts', async () => {
    const filePath = await temporaryDatabasePath();
    const repository = new SQLiteCareerRepository({ filePath });
    const evidence = createAliceGitHubFixtureEvidence(NOW);
    const facts = deriveCandidateFacts(evidence).map((fact) =>
      confirmCareerFact(fact, NOW, 'test')
    );
    const ir = buildCareerIR({
      profile: { id: 'alice', displayName: 'Alice Example' },
      facts,
      evidence,
      exportedAt: NOW
    });
    repository.saveCareerIR(ir);
    const factsBefore = repository.listFacts();
    const evidenceBefore = repository.listEvidence();
    const irBefore = repository.loadCareerIR('alice');

    const jobA = createTargetJob({ title: 'Job A', company: 'Acme', rawJd: JD_A }, { id: 'targetjob_a', now: NOW });
    const jobB = createTargetJob({ title: 'Job B', rawJd: JD_B }, { id: 'targetjob_b', now: NOW });
    repository.saveTargetJob(jobA);
    repository.saveTargetJob(jobB);
    repository.updateTargetJob(jobA.id, { rawJd: JD_B, company: null }, { now: LATER });

    expect(repository.getTargetJob(jobA.id)?.rawJd).toBe(JD_B);
    expect(repository.getTargetJob(jobA.id)?.company).toBeUndefined();
    expect(repository.getTargetJob(jobB.id)).toEqual(jobB);

    // Target Job context must never rewrite career facts, evidence or profile.
    expect(repository.listFacts()).toEqual(factsBefore);
    expect(repository.listEvidence()).toEqual(evidenceBefore);
    expect(repository.loadCareerIR('alice')).toEqual(irBefore);
    repository.close();
  });

  it('keeps target jobs after the database is reopened', async () => {
    const filePath = await temporaryDatabasePath();
    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_persisted', now: NOW }
    );
    const repository = new SQLiteCareerRepository({ filePath });
    repository.saveTargetJob(job);
    repository.close();

    const reopened = new SQLiteCareerRepository({ filePath });
    expect(reopened.getTargetJob(job.id)).toEqual(job);
    expect(reopened.listTargetJobs()).toHaveLength(1);
    reopened.close();
  });

  it('opens a database created before target job persistence existed', async () => {
    const filePath = await temporaryDatabasePath();
    const evidence = createAliceGitHubFixtureEvidence(NOW);
    const ir = buildCareerIR({
      profile: { id: 'alice', displayName: 'Alice Example' },
      facts: deriveCandidateFacts(evidence).map((fact) => confirmCareerFact(fact, NOW, 'test')),
      evidence,
      exportedAt: NOW
    });

    // Storage schema 0.1: evidence, facts, fact_evidence and profiles only.
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '0.1');

      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        source_uri TEXT,
        observed_at TEXT,
        discovered_at TEXT NOT NULL,
        content_hash TEXT,
        attribution TEXT,
        external_contribution INTEGER
      );
      CREATE INDEX idx_evidence_source_type ON evidence(source_type);
      CREATE INDEX idx_evidence_source_id ON evidence(source_id);

      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        statement TEXT NOT NULL,
        normalized_data_json TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        canonical_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        confirmed_by TEXT,
        supersedes_fact_id TEXT
      );
      CREATE INDEX idx_facts_status ON facts(status);
      CREATE UNIQUE INDEX idx_facts_canonical_key
        ON facts(canonical_key) WHERE canonical_key IS NOT NULL;

      CREATE TABLE fact_evidence (
        fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL,
        weight REAL,
        PRIMARY KEY (fact_id, evidence_id)
      );

      CREATE TABLE profiles (
        profile_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        document_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy
      .prepare(
        'INSERT INTO profiles (profile_id, schema_version, document_json, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('alice', ir.schemaVersion, serializeCareerIR(ir), NOW);
    legacy
      .prepare(
        `INSERT INTO evidence
          (id, source_type, source_id, evidence_type, raw_json, normalized_json,
           source_uri, observed_at, discovered_at, content_hash, attribution, external_contribution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'github:repository:alice/demo',
        'github',
        'alice/demo',
        'repository',
        JSON.stringify({ name: 'demo' }),
        JSON.stringify({ name: 'demo' }),
        null,
        null,
        NOW,
        null,
        'owned',
        null
      );
    legacy.close();

    const repository = new SQLiteCareerRepository({ filePath });
    expect(repository.loadCareerIR('alice')?.profile.displayName).toBe('Alice Example');
    expect(repository.listEvidence('github')).toHaveLength(1);
    expect(repository.getEvidence('github:repository:alice/demo')?.attribution).toBe('owned');
    expect(repository.listTargetJobs()).toEqual([]);

    const job = createTargetJob(
      { title: 'Data Platform Lead', company: 'Acme', rawJd: JD_A },
      { id: 'targetjob_migrated', now: NOW }
    );
    repository.saveTargetJob(job);
    expect(repository.getTargetJob(job.id)).toEqual(job);
    repository.close();
  });

  it('accepts a target job type from the core contract', () => {
    const job: TargetJob = createTargetJob({ title: 'Type check', rawJd: JD_A }, { now: NOW });
    expect(job.rawJdHash).toHaveLength(8);
  });
});
