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
  CompilationSnapshot,
  JsonObject,
  ResumeCompilationRepository,
  ResumePatchProposal,
  ResumeVariant,
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
  validateCompilationSnapshot,
  validateResumePatchProposal,
  validateResumeVariant,
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

function parseJsonValue(serialized: string, field: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error(
      `Stored ${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseResumePatchProposal(row: SQLiteRow): ResumePatchProposal {
  return validateResumePatchProposal({
    id: rowString(row, 'id'),
    baseIrHash: rowString(row, 'base_ir_hash'),
    ...(rowNullableString(row, 'target_job_id')
      ? { targetJobId: rowNullableString(row, 'target_job_id') }
      : {}),
    strategyId: rowString(row, 'strategy_id'),
    operations: parseJsonValue(rowString(row, 'operations_json'), 'proposal.operations'),
    status: rowString(row, 'status'),
    createdAt: rowString(row, 'created_at'),
    ...(rowNullableString(row, 'applied_at')
      ? { appliedAt: rowNullableString(row, 'applied_at') }
      : {}),
    ...(rowNullableString(row, 'rejected_at')
      ? { rejectedAt: rowNullableString(row, 'rejected_at') }
      : {})
  });
}

function parseResumeVariant(row: SQLiteRow): ResumeVariant {
  return validateResumeVariant({
    id: rowString(row, 'id'),
    ...(rowNullableString(row, 'target_job_id')
      ? { targetJobId: rowNullableString(row, 'target_job_id') }
      : {}),
    baseIrHash: rowString(row, 'base_ir_hash'),
    proposalId: rowString(row, 'proposal_id'),
    view: parseJsonValue(rowString(row, 'view_json'), 'variant.view'),
    revision: Number(row.revision),
    createdAt: rowString(row, 'created_at'),
    updatedAt: rowString(row, 'updated_at')
  });
}

function parseCompilationSnapshot(row: SQLiteRow): CompilationSnapshot {
  const previousJson = rowNullableString(row, 'previous_json');
  return validateCompilationSnapshot({
    id: rowString(row, 'id'),
    variantId: rowString(row, 'variant_id'),
    baseIrHash: rowString(row, 'base_ir_hash'),
    proposalId: rowString(row, 'proposal_id'),
    previous: previousJson ? parseJsonValue(previousJson, 'snapshot.previous') : null,
    createdAt: rowString(row, 'created_at')
  });
}

export class SQLiteCareerRepository
  implements CareerRepository, TargetJobRepository, ResumeCompilationRepository {
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

      CREATE TABLE IF NOT EXISTS resume_patch_proposals (
        id TEXT PRIMARY KEY,
        base_ir_hash TEXT NOT NULL,
        target_job_id TEXT,
        strategy_id TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        rejected_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_resume_patch_proposals_status
        ON resume_patch_proposals(status);

      CREATE TABLE IF NOT EXISTS resume_variants (
        id TEXT PRIMARY KEY,
        target_job_id TEXT UNIQUE,
        base_ir_hash TEXT NOT NULL,
        proposal_id TEXT NOT NULL REFERENCES resume_patch_proposals(id),
        view_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resume_variants_updated_at ON resume_variants(updated_at);

      CREATE TABLE IF NOT EXISTS compilation_snapshots (
        id TEXT PRIMARY KEY,
        variant_id TEXT NOT NULL REFERENCES resume_variants(id) ON DELETE CASCADE,
        base_ir_hash TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        previous_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compilation_snapshots_variant
        ON compilation_snapshots(variant_id);
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

  private writeResumePatchProposal(proposal: ResumePatchProposal): void {
    const validated = validateResumePatchProposal(proposal);
    this.database
      .prepare(`
        INSERT INTO resume_patch_proposals
          (id, base_ir_hash, target_job_id, strategy_id, operations_json,
           status, created_at, applied_at, rejected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          applied_at = excluded.applied_at,
          rejected_at = excluded.rejected_at
      `)
      .run(
        validated.id,
        validated.baseIrHash,
        validated.targetJobId ?? null,
        validated.strategyId,
        JSON.stringify(validated.operations),
        validated.status,
        validated.createdAt,
        validated.appliedAt ?? null,
        validated.rejectedAt ?? null
      );
  }

  private writeResumeVariant(variant: ResumeVariant): void {
    const validated = validateResumeVariant(variant);
    this.database
      .prepare(`
        INSERT INTO resume_variants
          (id, target_job_id, base_ir_hash, proposal_id, view_json, revision,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          target_job_id = excluded.target_job_id,
          base_ir_hash = excluded.base_ir_hash,
          proposal_id = excluded.proposal_id,
          view_json = excluded.view_json,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `)
      .run(
        validated.id,
        validated.targetJobId ?? null,
        validated.baseIrHash,
        validated.proposalId,
        JSON.stringify(validated.view),
        validated.revision,
        validated.createdAt,
        validated.updatedAt
      );
  }

  private writeCompilationSnapshot(snapshot: CompilationSnapshot): void {
    const validated = validateCompilationSnapshot(snapshot);
    this.database
      .prepare(`
        INSERT INTO compilation_snapshots
          (id, variant_id, base_ir_hash, proposal_id, previous_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          variant_id = excluded.variant_id,
          base_ir_hash = excluded.base_ir_hash,
          proposal_id = excluded.proposal_id,
          previous_json = excluded.previous_json,
          created_at = excluded.created_at
      `)
      .run(
        validated.id,
        validated.variantId,
        validated.baseIrHash,
        validated.proposalId,
        validated.previous === null ? null : JSON.stringify(validated.previous),
        validated.createdAt
      );
  }

  saveResumePatchProposal(proposal: ResumePatchProposal): void {
    this.transaction(() => this.writeResumePatchProposal(proposal));
  }

  getResumePatchProposal(id: string): ResumePatchProposal | undefined {
    const row = this.database
      .prepare('SELECT * FROM resume_patch_proposals WHERE id = ?')
      .get(id) as SQLiteRow | undefined;
    return row ? parseResumePatchProposal(row) : undefined;
  }

  /** Most recently created first, then by id so the order is deterministic. */
  listResumePatchProposals(): ResumePatchProposal[] {
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const rows = this.database
      .prepare('SELECT * FROM resume_patch_proposals ORDER BY created_at DESC, id')
      .all() as unknown as SQLiteRow[];
    return rows.map(parseResumePatchProposal);
  }

  getResumeVariant(id: string): ResumeVariant | undefined {
    const row = this.database.prepare('SELECT * FROM resume_variants WHERE id = ?').get(id) as
      | SQLiteRow
      | undefined;
    return row ? parseResumeVariant(row) : undefined;
  }

  findResumeVariantByTargetJob(targetJobId: string): ResumeVariant | undefined {
    const row = this.database
      .prepare('SELECT * FROM resume_variants WHERE target_job_id = ?')
      .get(targetJobId) as SQLiteRow | undefined;
    return row ? parseResumeVariant(row) : undefined;
  }

  /** Most recently updated first, then by id so the order is deterministic. */
  listResumeVariants(): ResumeVariant[] {
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const rows = this.database
      .prepare('SELECT * FROM resume_variants ORDER BY updated_at DESC, id')
      .all() as unknown as SQLiteRow[];
    return rows.map(parseResumeVariant);
  }

  getCompilationSnapshot(id: string): CompilationSnapshot | undefined {
    const row = this.database
      .prepare('SELECT * FROM compilation_snapshots WHERE id = ?')
      .get(id) as SQLiteRow | undefined;
    return row ? parseCompilationSnapshot(row) : undefined;
  }

  listCompilationSnapshots(variantId?: string): CompilationSnapshot[] {
    // SAFETY: node:sqlite returns each SELECT row as a string-keyed record.
    const rows = (variantId
      ? this.database
          .prepare(
            'SELECT * FROM compilation_snapshots WHERE variant_id = ? ORDER BY created_at, id'
          )
          .all(variantId)
      : this.database
          .prepare('SELECT * FROM compilation_snapshots ORDER BY created_at, id')
          .all()) as unknown as SQLiteRow[];
    return rows.map(parseCompilationSnapshot);
  }

  /**
   * Persist an apply atomically: proposal status, variant revision and rollback
   * snapshot either all exist or none do. The proposal is written first because
   * the variant references it.
   */
  commitResumeCompilation(
    proposal: ResumePatchProposal,
    variant: ResumeVariant,
    snapshot: CompilationSnapshot
  ): void {
    const validatedProposal = validateResumePatchProposal(proposal);
    const validatedVariant = validateResumeVariant(variant);
    const validatedSnapshot = validateCompilationSnapshot(snapshot);
    if (validatedSnapshot.variantId !== validatedVariant.id) {
      throw new Error(
        `CompilationSnapshot ${validatedSnapshot.id} does not belong to variant ${validatedVariant.id}`
      );
    }
    this.transaction(() => {
      this.writeResumePatchProposal(validatedProposal);
      this.writeResumeVariant(validatedVariant);
      this.writeCompilationSnapshot(validatedSnapshot);
    });
  }

  /**
   * Persist a rollback atomically: consume the snapshot, restore or delete the
   * variant and return the proposal to draft.
   */
  commitResumeRevert(
    proposal: ResumePatchProposal,
    variant: ResumeVariant | undefined,
    snapshotId: string
  ): void {
    const validatedProposal = validateResumePatchProposal(proposal);
    const validatedVariant = variant ? validateResumeVariant(variant) : undefined;
    this.transaction(() => {
      const row = this.database
        .prepare('SELECT variant_id FROM compilation_snapshots WHERE id = ?')
        .get(snapshotId) as SQLiteRow | undefined;
      if (!row) {
        throw new Error(`CompilationSnapshot not found: ${snapshotId}`);
      }
      const variantId = rowString(row, 'variant_id');
      if (validatedVariant !== undefined && validatedVariant.id !== variantId) {
        throw new Error(
          `CompilationSnapshot ${snapshotId} does not belong to variant ${validatedVariant.id}`
        );
      }
      this.database.prepare('DELETE FROM compilation_snapshots WHERE id = ?').run(snapshotId);
      if (validatedVariant) {
        this.writeResumeVariant(validatedVariant);
      } else {
        this.database.prepare('DELETE FROM resume_variants WHERE id = ?').run(variantId);
      }
      this.writeResumePatchProposal(validatedProposal);
    });
  }

  close(): void {
    this.database.close();
  }
}
