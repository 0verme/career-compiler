import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CareerEvidence,
  CareerFact,
  CareerFactStatus,
  CareerIR,
  CareerRepository,
  JdRequirement,
  JdRequirementRepository,
  JsonObject,
  SourceType,
  TargetJob,
  TargetJobPatch,
  TargetJobRepository,
  TargetJobUpdateOptions
} from '@career-compiler/core';
import {
  parseCareerIR,
  serializeCareerIR,
  updateTargetJob as applyTargetJobPatch,
  validateCareerEvidence,
  validateCareerFact,
  validateCareerIR,
  validateJdRequirement,
  validateTargetJob
} from '@career-compiler/core';

export interface SQLiteCareerRepositoryOptions {
  filePath: string;
}

type SQLiteRow = Record<string, unknown>;

function rowString(row: SQLiteRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`SQLite row field ${key} is not a string`);
  }
  return value;
}

function rowNullableString(row: SQLiteRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function rowNullableBoolean(row: SQLiteRow, key: string): boolean | undefined {
  const value = row[key];
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  return undefined;
}

function rowNullableAttribution(row: SQLiteRow): CareerEvidence['attribution'] {
  const value = rowNullableString(row, 'attribution');
  return value === 'owned' || value === 'authored' || value === 'contributed' ||
    value === 'reviewed' || value === 'context' || value === 'unknown'
    ? value
    : undefined;
}

function parseJsonObject(serialized: string, field: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(
      `Stored ${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Stored ${field} must be a JSON object`);
  }
  return value as JsonObject;
}

function parseEvidence(row: SQLiteRow): CareerEvidence {
  return validateCareerEvidence({
    id: rowString(row, 'id'),
    sourceType: rowString(row, 'source_type'),
    sourceId: rowString(row, 'source_id'),
    evidenceType: rowString(row, 'evidence_type'),
    raw: parseJsonObject(rowString(row, 'raw_json'), 'evidence.raw'),
    normalized: parseJsonObject(rowString(row, 'normalized_json'), 'evidence.normalized'),
    ...(rowNullableAttribution(row) ? { attribution: rowNullableAttribution(row) } : {}),
    ...(rowNullableBoolean(row, 'external_contribution') !== undefined
      ? { externalContribution: rowNullableBoolean(row, 'external_contribution') }
      : {}),
    ...(rowNullableString(row, 'source_uri') ? { sourceUri: rowNullableString(row, 'source_uri') } : {}),
    ...(rowNullableString(row, 'observed_at') ? { observedAt: rowNullableString(row, 'observed_at') } : {}),
    discoveredAt: rowString(row, 'discovered_at'),
    ...(rowNullableString(row, 'content_hash')
      ? { contentHash: rowNullableString(row, 'content_hash') }
      : {})
  });
}

function parseFact(row: SQLiteRow, refs: SQLiteRow[]): CareerFact {
  return validateCareerFact({
    id: rowString(row, 'id'),
    type: rowString(row, 'type'),
    statement: rowString(row, 'statement'),
    normalizedData: parseJsonObject(rowString(row, 'normalized_data_json'), 'fact.normalizedData'),
    status: rowString(row, 'status'),
    confidence: Number(row.confidence),
    evidenceRefs: refs.map((ref) => ({
      evidenceId: rowString(ref, 'evidence_id'),
      relation: rowString(ref, 'relation') as CareerFact['evidenceRefs'][number]['relation'],
      ...(ref.weight === null || ref.weight === undefined ? {} : { weight: Number(ref.weight) })
    })),
    ...(rowNullableString(row, 'canonical_key')
      ? { canonicalKey: rowNullableString(row, 'canonical_key') }
      : {}),
    createdAt: rowString(row, 'created_at'),
    updatedAt: rowString(row, 'updated_at'),
    ...(rowNullableString(row, 'confirmed_at')
      ? { confirmedAt: rowNullableString(row, 'confirmed_at') }
      : {}),
    ...(rowNullableString(row, 'confirmed_by')
      ? { confirmedBy: rowNullableString(row, 'confirmed_by') }
      : {}),
    ...(rowNullableString(row, 'supersedes_fact_id')
      ? { supersedesFactId: rowNullableString(row, 'supersedes_fact_id') }
      : {})
  });
}

function parseTargetJob(row: SQLiteRow): TargetJob {
  return validateTargetJob({
    id: rowString(row, 'id'),
    ...(rowNullableString(row, 'company') ? { company: rowNullableString(row, 'company') } : {}),
    title: rowString(row, 'title'),
    rawJd: rowString(row, 'raw_jd'),
    rawJdHash: rowString(row, 'raw_jd_hash'),
    createdAt: rowString(row, 'created_at'),
    updatedAt: rowString(row, 'updated_at')
  });
}

function parseJdRequirement(row: SQLiteRow): JdRequirement {
  return validateJdRequirement({
    id: rowString(row, 'id'),
    targetJobId: rowString(row, 'target_job_id'),
    category: rowString(row, 'category'),
    priority: rowString(row, 'priority'),
    statement: rowString(row, 'statement'),
    rawQuote: rowString(row, 'raw_quote'),
    quoteRange: { start: Number(row.quote_start), end: Number(row.quote_end) },
    confidence: Number(row.confidence),
    status: rowString(row, 'status'),
    sourceRawJdHash: rowString(row, 'source_raw_jd_hash'),
    createdAt: rowString(row, 'created_at'),
    updatedAt: rowString(row, 'updated_at')
  });
}

export class SQLiteCareerRepository
  implements CareerRepository, TargetJobRepository, JdRequirementRepository {
  private readonly database: DatabaseSync;

  constructor(options: SQLiteCareerRepositoryOptions) {
    mkdirSync(dirname(options.filePath), { recursive: true });
    this.database = new DatabaseSync(options.filePath);
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '0.1');

      CREATE TABLE IF NOT EXISTS evidence (
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
      CREATE INDEX IF NOT EXISTS idx_evidence_source_type ON evidence(source_type);
      CREATE INDEX IF NOT EXISTS idx_evidence_source_id ON evidence(source_id);

      CREATE TABLE IF NOT EXISTS facts (
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
      CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_canonical_key
        ON facts(canonical_key) WHERE canonical_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS fact_evidence (
        fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL,
        weight REAL,
        PRIMARY KEY (fact_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS profiles (
        profile_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        document_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS target_jobs (
        id TEXT PRIMARY KEY,
        company TEXT,
        title TEXT NOT NULL,
        raw_jd TEXT NOT NULL,
        raw_jd_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_target_jobs_updated_at ON target_jobs(updated_at);

      CREATE TABLE IF NOT EXISTS jd_requirements (
        id TEXT PRIMARY KEY,
        target_job_id TEXT NOT NULL REFERENCES target_jobs(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        statement TEXT NOT NULL,
        raw_quote TEXT NOT NULL,
        quote_start INTEGER NOT NULL,
        quote_end INTEGER NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        source_raw_jd_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jd_requirements_target_job
        ON jd_requirements(target_job_id);
    `);
    this.ensureEvidenceColumns();
  }

  private ensureEvidenceColumns(): void {
    // Existing V0.1 databases may not have the optional attribution columns.
    // SAFETY: node:sqlite returns PRAGMA table_info rows as string-keyed records.
    const columns = this.database
      .prepare('PRAGMA table_info(evidence)')
      .all() as unknown as SQLiteRow[];
    const names = new Set(columns.map((column) => rowString(column, 'name')));
    if (!names.has('attribution')) {
      this.database.exec('ALTER TABLE evidence ADD COLUMN attribution TEXT;');
    }
    if (!names.has('external_contribution')) {
      this.database.exec('ALTER TABLE evidence ADD COLUMN external_contribution INTEGER;');
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private writeEvidence(evidence: CareerEvidence): void {
    const validated = validateCareerEvidence(evidence);
    this.database
      .prepare(`
        INSERT INTO evidence
          (id, source_type, source_id, evidence_type, raw_json, normalized_json,
           attribution, external_contribution, source_uri, observed_at, discovered_at, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          evidence_type = excluded.evidence_type,
          raw_json = excluded.raw_json,
          normalized_json = excluded.normalized_json,
          attribution = excluded.attribution,
          external_contribution = excluded.external_contribution,
          source_uri = excluded.source_uri,
          observed_at = excluded.observed_at,
          discovered_at = excluded.discovered_at,
          content_hash = excluded.content_hash
      `)
      .run(
        validated.id,
        validated.sourceType,
        validated.sourceId,
        validated.evidenceType,
        JSON.stringify(validated.raw),
        JSON.stringify(validated.normalized),
        validated.attribution ?? null,
        validated.externalContribution === undefined ? null : validated.externalContribution ? 1 : 0,
        validated.sourceUri ?? null,
        validated.observedAt ?? null,
        validated.discoveredAt,
        validated.contentHash ?? null
      );
  }

  private writeFact(fact: CareerFact, protectConfirmed = true): void {
    const validated = validateCareerFact(fact);
    const existing = this.getFact(validated.id);
    let toWrite = validated;
    if (protectConfirmed && existing?.status === 'confirmed' && validated.status !== 'confirmed') {
      const refs = new Map(existing.evidenceRefs.map((reference) => [reference.evidenceId, reference]));
      for (const reference of validated.evidenceRefs) {
        const previous = refs.get(reference.evidenceId);
        if (!previous || (reference.weight ?? 0) > (previous.weight ?? 0)) {
          refs.set(reference.evidenceId, reference);
        }
      }
      toWrite = {
        ...existing,
        evidenceRefs: [...refs.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
        updatedAt: validated.updatedAt
      };
    }
    this.database
      .prepare(`
        INSERT INTO facts
          (id, type, statement, normalized_data_json, status, confidence, canonical_key,
           created_at, updated_at, confirmed_at, confirmed_by, supersedes_fact_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          statement = excluded.statement,
          normalized_data_json = excluded.normalized_data_json,
          status = excluded.status,
          confidence = excluded.confidence,
          canonical_key = excluded.canonical_key,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          confirmed_at = excluded.confirmed_at,
          confirmed_by = excluded.confirmed_by,
          supersedes_fact_id = excluded.supersedes_fact_id
      `)
      .run(
        toWrite.id,
        toWrite.type,
        toWrite.statement,
        JSON.stringify(toWrite.normalizedData),
        toWrite.status,
        toWrite.confidence,
        toWrite.canonicalKey ?? null,
        toWrite.createdAt,
        toWrite.updatedAt,
        toWrite.confirmedAt ?? null,
        toWrite.confirmedBy ?? null,
        toWrite.supersedesFactId ?? null
      );
    this.database.prepare('DELETE FROM fact_evidence WHERE fact_id = ?').run(toWrite.id);
    const relationStatement = this.database.prepare(`
      INSERT INTO fact_evidence (fact_id, evidence_id, relation, weight)
      VALUES (?, ?, ?, ?)
    `);
    for (const reference of toWrite.evidenceRefs) {
      relationStatement.run(
        toWrite.id,
        reference.evidenceId,
        reference.relation,
        reference.weight ?? null
      );
    }
  }

  saveEvidence(evidence: CareerEvidence): void {
    this.transaction(() => this.writeEvidence(evidence));
  }

  getEvidence(id: string): CareerEvidence | undefined {
    const row = this.database.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as
      | SQLiteRow
      | undefined;
    return row ? parseEvidence(row) : undefined;
  }

  listEvidence(sourceType?: SourceType): CareerEvidence[] {
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const rows = (sourceType
      ? this.database.prepare('SELECT * FROM evidence WHERE source_type = ? ORDER BY id').all(sourceType)
      : this.database.prepare('SELECT * FROM evidence ORDER BY id').all()) as unknown as SQLiteRow[];
    return rows.map(parseEvidence);
  }

  saveFact(fact: CareerFact): void {
    this.transaction(() => this.writeFact(fact));
  }

  getFact(id: string): CareerFact | undefined {
    const row = this.database.prepare('SELECT * FROM facts WHERE id = ?').get(id) as
      | SQLiteRow
      | undefined;
    if (!row) {
      return undefined;
    }
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const refs = this.database
      .prepare('SELECT evidence_id, relation, weight FROM fact_evidence WHERE fact_id = ? ORDER BY evidence_id')
      .all(id) as unknown as SQLiteRow[];
    return parseFact(row, refs);
  }

  listFacts(status?: CareerFactStatus): CareerFact[] {
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const rows = (status
      ? this.database.prepare('SELECT * FROM facts WHERE status = ? ORDER BY id').all(status)
      : this.database.prepare('SELECT * FROM facts ORDER BY id').all()) as unknown as SQLiteRow[];
    return rows.map((row) => {
      // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
      const refs = this.database
        .prepare('SELECT evidence_id, relation, weight FROM fact_evidence WHERE fact_id = ? ORDER BY evidence_id')
        .all(rowString(row, 'id')) as unknown as SQLiteRow[];
      return parseFact(row, refs);
    });
  }

  updateFactStatus(
    id: string,
    status: CareerFactStatus,
    metadata: { confirmedAt?: string; confirmedBy?: string } = {}
  ): CareerFact | undefined {
    const fact = this.getFact(id);
    if (!fact) {
      return undefined;
    }
    const updatedAt = metadata.confirmedAt ?? new Date().toISOString();
    const updated: CareerFact = {
      ...fact,
      status,
      updatedAt,
      ...(status === 'confirmed'
        ? {
            confirmedAt: metadata.confirmedAt ?? new Date().toISOString(),
            confirmedBy: metadata.confirmedBy ?? 'user'
          }
        : {})
    };
    this.transaction(() => this.writeFact(updated, false));
    return updated;
  }

  saveCareerIR(ir: CareerIR): void {
    const validated = validateCareerIR(ir);
    this.transaction(() => {
      for (const evidence of validated.evidence) {
        this.writeEvidence(evidence);
      }
      for (const fact of validated.facts) {
        this.writeFact(fact);
      }
      this.database
        .prepare(`
          INSERT INTO profiles (profile_id, schema_version, document_json, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            document_json = excluded.document_json,
            updated_at = excluded.updated_at
        `)
        .run(
          validated.profile.id,
          validated.schemaVersion,
          serializeCareerIR(validated),
          validated.exportedAt
        );
    });
  }

  loadCareerIR(profileId: string): CareerIR | undefined {
    const row = this.database
      .prepare('SELECT document_json FROM profiles WHERE profile_id = ?')
      .get(profileId) as SQLiteRow | undefined;
    if (!row) {
      return undefined;
    }
    return parseCareerIR(rowString(row, 'document_json'));
  }

  importCareerIR(ir: CareerIR): void {
    this.saveCareerIR(validateCareerIR(ir));
  }

  async exportCareerIRToFile(profileId: string, filePath: string): Promise<void> {
    const ir = this.loadCareerIR(profileId);
    if (!ir) {
      throw new Error(`Career profile not found: ${profileId}`);
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, serializeCareerIR(ir), 'utf8');
  }

  async importCareerIRFromFile(filePath: string): Promise<CareerIR> {
    const ir = parseCareerIR(await readFile(filePath, 'utf8'));
    this.importCareerIR(ir);
    return ir;
  }

  saveTargetJob(job: TargetJob): void {
    this.transaction(() => this.writeTargetJob(job));
  }

  getTargetJob(id: string): TargetJob | undefined {
    const row = this.database.prepare('SELECT * FROM target_jobs WHERE id = ?').get(id) as
      | SQLiteRow
      | undefined;
    return row ? parseTargetJob(row) : undefined;
  }

  /** Most recently updated first, then by id so the order is deterministic. */
  listTargetJobs(): TargetJob[] {
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const rows = this.database
      .prepare('SELECT * FROM target_jobs ORDER BY updated_at DESC, id')
      .all() as unknown as SQLiteRow[];
    return rows.map(parseTargetJob);
  }

  updateTargetJob(
    id: string,
    patch: TargetJobPatch,
    options: TargetJobUpdateOptions = {}
  ): TargetJob | undefined {
    return this.transaction(() => {
      const existing = this.getTargetJob(id);
      if (!existing) {
        return undefined;
      }
      const updated = applyTargetJobPatch(existing, patch, options);
      this.writeTargetJob(updated);
      return updated;
    });
  }

  private writeTargetJob(job: TargetJob): void {
    const validated = validateTargetJob(job);
    this.database
      .prepare(`
        INSERT INTO target_jobs
          (id, company, title, raw_jd, raw_jd_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          company = excluded.company,
          title = excluded.title,
          raw_jd = excluded.raw_jd,
          raw_jd_hash = excluded.raw_jd_hash,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `)
      .run(
        validated.id,
        validated.company ?? null,
        validated.title,
        validated.rawJd,
        validated.rawJdHash,
        validated.createdAt,
        validated.updatedAt
      );
  }

  private writeJdRequirement(requirement: JdRequirement): void {
    const validated = validateJdRequirement(requirement);
    this.database
      .prepare(`
        INSERT INTO jd_requirements
          (id, target_job_id, category, priority, statement, raw_quote,
           quote_start, quote_end, confidence, status, source_raw_jd_hash,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          category = excluded.category,
          priority = excluded.priority,
          statement = excluded.statement,
          confidence = excluded.confidence,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(
        validated.id,
        validated.targetJobId,
        validated.category,
        validated.priority,
        validated.statement,
        validated.rawQuote,
        validated.quoteRange.start,
        validated.quoteRange.end,
        validated.confidence,
        validated.status,
        validated.sourceRawJdHash,
        validated.createdAt,
        validated.updatedAt
      );
  }

  /**
   * Replace the whole requirement set of a target job atomically. Re-parsing
   * the same or a changed raw JD never mixes old and new requirements.
   */
  replaceJdRequirements(targetJobId: string, requirements: JdRequirement[]): void {
    const validated = requirements.map((requirement) => {
      const item = validateJdRequirement(requirement);
      if (item.targetJobId !== targetJobId) {
        throw new Error(
          `JdRequirement ${item.id} belongs to target job ${item.targetJobId}, not ${targetJobId}`
        );
      }
      return item;
    });
    this.transaction(() => {
      this.database.prepare('DELETE FROM jd_requirements WHERE target_job_id = ?').run(targetJobId);
      for (const requirement of validated) {
        this.writeJdRequirement(requirement);
      }
    });
  }

  /** Document order: by quote position, then id for determinism. */
  listJdRequirements(targetJobId: string): JdRequirement[] {
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const rows = this.database
      .prepare(
        'SELECT * FROM jd_requirements WHERE target_job_id = ? ORDER BY quote_start, id'
      )
      .all(targetJobId) as unknown as SQLiteRow[];
    return rows.map(parseJdRequirement);
  }

  getJdRequirement(id: string): JdRequirement | undefined {
    const row = this.database.prepare('SELECT * FROM jd_requirements WHERE id = ?').get(id) as
      | SQLiteRow
      | undefined;
    return row ? parseJdRequirement(row) : undefined;
  }

  saveJdRequirement(requirement: JdRequirement): void {
    this.transaction(() => this.writeJdRequirement(requirement));
  }

  close(): void {
    this.database.close();
  }
}
