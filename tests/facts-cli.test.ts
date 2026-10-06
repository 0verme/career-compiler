import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  serializeCareerIR,
  type CareerEvidence,
  type CareerFact,
  type CareerIR
} from '@career-compiler/core';

const CLI_ENTRY = resolve(process.cwd(), 'apps/cli/dist/index.js');
const NOW = '2025-01-15T00:00:00.000Z';
const PROFILE_ID = 'alice';

function evidenceFor(id: string): CareerEvidence {
  return {
    id,
    sourceType: 'chat',
    sourceId: `conversation:${id}`,
    evidenceType: 'conversation',
    raw: { id },
    normalized: { id },
    discoveredAt: NOW
  };
}

function fact(
  id: string,
  type: string,
  statement: string,
  evidenceId: string,
  status: CareerFact['status'] = 'confirmed'
): CareerFact {
  return {
    id,
    type,
    statement,
    normalizedData: { metric: '180 systems' },
    status,
    confidence: 0.8,
    evidenceRefs: [{ evidenceId, relation: 'derived-from', weight: 0.8 }],
    canonicalKey: `${type}:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...(status === 'confirmed' ? { confirmedAt: NOW, confirmedBy: 'test' } : {})
  };
}

function fixtureIr(): CareerIR {
  const evidence = [evidenceFor('ev:platform'), evidenceFor('ev:kafka')];
  const facts: CareerFact[] = [
    fact('fact_achievement_lineage', 'achievement', 'Built the lineage platform', 'ev:platform'),
    fact('fact_skill_kafka', 'skill', 'Kafka', 'ev:kafka', 'candidate')
  ];
  return buildCareerIR({
    profile: { id: PROFILE_ID, displayName: 'Alice Example' },
    facts,
    evidence,
    exportedAt: NOW
  });
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolveResult({ code: code ?? 0, stdout, stderr }));
    child.stdin.end();
  });
}

function parseJson<T>(result: CliResult): T {
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as T;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

interface CliWorkspace {
  args: (extra: string[]) => string[];
}

async function cliWorkspace(): Promise<CliWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), 'career-compiler-facts-cli-'));
  temporaryDirectories.push(directory);
  const dataDir = join(directory, 'data');
  const configFile = join(directory, 'config.json');
  const irFile = join(directory, 'career-ir.json');
  await writeFile(
    configFile,
    JSON.stringify({ profile: { id: PROFILE_ID, displayName: 'Alice Example' } }),
    'utf8'
  );
  await writeFile(irFile, serializeCareerIR(fixtureIr()), 'utf8');
  const imported = await runCli(['--data-dir', dataDir, '--config', configFile, 'import', irFile]);
  expect(imported.code).toBe(0);
  return {
    args: (extra: string[]) => ['--data-dir', dataDir, '--config', configFile, ...extra]
  };
}

describe('facts CLI', () => {
  it('shows a single fact by id in a readable form', async () => {
    const { args } = await cliWorkspace();

    const shown = await runCli(args(['facts', 'show', 'fact_achievement_lineage']));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('id:             fact_achievement_lineage');
    expect(shown.stdout).toContain('type:           achievement');
    expect(shown.stdout).toContain('status:         confirmed');
    expect(shown.stdout).toContain('confidence:     0.8');
    expect(shown.stdout).toContain('statement:      Built the lineage platform');
    expect(shown.stdout).toContain('normalizedData: {"metric":"180 systems"}');
    expect(shown.stdout).toContain('ev:platform (derived-from, weight 0.8)');

    // Other facts are not included: show is scoped to one id.
    expect(shown.stdout).not.toContain('fact_skill_kafka');
  });

  it('shows candidate facts including their review status', async () => {
    const { args } = await cliWorkspace();

    const shown = await runCli(args(['facts', 'show', 'fact_skill_kafka']));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('status:         candidate');
    expect(shown.stdout).toContain('statement:      Kafka');
    expect(shown.stdout).not.toContain('confirmedAt:');
  });

  it('returns the complete CareerFact with --json', async () => {
    const { args } = await cliWorkspace();

    const listed = parseJson<CareerFact[]>(await runCli(args(['--json', 'facts', 'list'])));
    const expected = listed.find((item) => item.id === 'fact_achievement_lineage');

    const shown = parseJson<CareerFact>(
      await runCli(args(['--json', 'facts', 'show', 'fact_achievement_lineage']))
    );
    expect(shown).toEqual(expected);
  });

  it('reports an unknown fact id with a clear error and non-zero exit code', async () => {
    const { args } = await cliWorkspace();

    const missing = await runCli(args(['facts', 'show', 'fact_missing']));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('CareerFact not found: fact_missing');
  });
});
