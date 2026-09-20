import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  serializeCareerIR,
  type CareerEvidence,
  type CareerFact,
  type CareerIR,
  type ResumePatchProposal,
  type ResumeVariant
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

function fact(id: string, type: string, statement: string, evidenceId: string): CareerFact {
  return {
    id,
    type,
    statement,
    normalizedData: {},
    status: 'confirmed',
    confidence: 0.8,
    evidenceRefs: [{ evidenceId, relation: 'derived-from', weight: 0.8 }],
    canonicalKey: `${type}:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    confirmedAt: NOW,
    confirmedBy: 'test'
  };
}

function fixtureIr(options: { displayName?: string } = {}): CareerIR {
  const evidence = [evidenceFor('ev:platform'), evidenceFor('ev:kafka')];
  const facts: CareerFact[] = [
    fact('fact_project_lineage', 'project', 'Maintains data-lineage-toolkit', 'ev:platform'),
    fact('fact_skill_kafka', 'skill', 'Kafka', 'ev:kafka'),
    {
      ...fact('fact_achievement_lineage', 'achievement', 'Built the lineage platform', 'ev:platform'),
      normalizedData: { metric: '180 systems' }
    },
    {
      ...fact('fact_achievement_hidden', 'achievement', 'Reworked legacy reporting', 'ev:platform'),
      normalizedData: { action: 'Reworked legacy reporting' }
    }
  ];
  facts[2]!.canonicalKey = 'achievement:lineage';
  facts[3]!.canonicalKey = 'achievement:hidden';
  return buildCareerIR({
    profile: {
      id: PROFILE_ID,
      displayName: options.displayName ?? 'Alice Example'
    },
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

function runCli(args: string[], input?: string): Promise<CliResult> {
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
    child.stdin.end(input ?? '');
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
  irFile: string;
}

async function cliWorkspace(): Promise<CliWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), 'career-compiler-compilation-cli-'));
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
  return {
    irFile,
    args: (extra: string[]) => ['--data-dir', dataDir, '--config', configFile, ...extra]
  };
}

describe('compile CLI', () => {
  it('runs propose → apply → render variant without changing career facts', async () => {
    const { args, irFile } = await cliWorkspace();
    const ir = fixtureIr();
    const hidden = ir.profile.achievements.find((item) => item.statement === 'Reworked legacy reporting')!;
    const skill = ir.profile.skills[0]!;

    expect((await runCli(args(['import', irFile]))).code).toBe(0);
    const factsBefore = parseJson<unknown[]>(await runCli(args(['--json', 'facts', 'list'])));

    const target = parseJson<{ id: string }>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Data Platform Lead', '--jd', 'Lead the platform.']))
    );
    const proposal = parseJson<ResumePatchProposal>(
      await runCli(
        args([
          '--json',
          'compile',
          'propose',
          '--target',
          target.id,
          '--hide-achievement',
          hidden.id,
          '--hide-section',
          'projects',
          '--section-order',
          'skills,achievements,summary,experience,projects',
          '--emphasize-skill',
          skill.id
        ])
      )
    );
    expect(proposal.status).toBe('draft');
    expect(proposal.targetJobId).toBe(target.id);
    expect(proposal.operations.map((operation) => operation.op)).toContain('hide-achievement');

    const applied = parseJson<{
      proposal: ResumePatchProposal;
      variant: ResumeVariant;
      snapshot: { id: string; previous: unknown };
    }>(await runCli(args(['--json', 'compile', 'apply', proposal.id])));
    expect(applied.proposal.status).toBe('applied');
    expect(applied.variant.revision).toBe(1);
    expect(applied.snapshot.previous).toBeNull();

    const rendered = await runCli(args(['render', 'resume', '--variant', applied.variant.id, '-o', '-']));
    expect(rendered.code).toBe(0);
    expect(rendered.stdout).not.toContain('Reworked legacy reporting');
    expect(rendered.stdout).not.toContain('## Projects');
    expect(rendered.stdout.indexOf('## Skills')).toBeLessThan(rendered.stdout.indexOf('## Summary'));
    expect(rendered.stdout.indexOf(`- ${skill.name}`)).toBeLessThan(
      rendered.stdout.indexOf('## Summary')
    );

    const reverted = parseJson<{ deleted: boolean; proposal: ResumePatchProposal }>(
      await runCli(args(['--json', 'compile', 'revert', applied.snapshot.id]))
    );
    expect(reverted.deleted).toBe(true);
    expect(reverted.proposal.status).toBe('draft');
    const variants = parseJson<ResumeVariant[]>(await runCli(args(['--json', 'compile', 'variants'])));
    expect(variants).toEqual([]);

    // Target-aware compilation never touches the fact pipeline.
    const factsAfter = parseJson<unknown[]>(await runCli(args(['--json', 'facts', 'list'])));
    expect(factsAfter).toEqual(factsBefore);
  });

  it('lists, rejects and reports invalid compile transitions', async () => {
    const { args, irFile } = await cliWorkspace();
    const ir = fixtureIr();
    const hidden = ir.profile.achievements[0]!;
    expect((await runCli(args(['import', irFile]))).code).toBe(0);

    const proposal = parseJson<ResumePatchProposal>(
      await runCli(args(['--json', 'compile', 'propose', '--hide-achievement', hidden.id]))
    );
    const list = parseJson<Array<{ id: string; status: string }>>(
      await runCli(args(['--json', 'compile', 'proposals']))
    );
    expect(list).toEqual([expect.objectContaining({ id: proposal.id, status: 'draft' })]);

    const rejected = parseJson<ResumePatchProposal>(
      await runCli(args(['--json', 'compile', 'reject', proposal.id]))
    );
    expect(rejected.status).toBe('rejected');
    expect((await runCli(args(['compile', 'apply', proposal.id]))).code).toBe(1);

    const missing = await runCli(args(['compile', 'show', 'proposal_missing']));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('ResumePatchProposal not found: proposal_missing');

    const missingVariant = await runCli(args(['render', 'resume', '--variant', 'variant_missing']));
    expect(missingVariant.code).toBe(1);
    expect(missingVariant.stderr).toContain('ResumeVariant not found: variant_missing');

    const badSection = await runCli(
      args(['compile', 'propose', '--section-order', 'summary,unknown'])
    );
    expect(badSection.code).toBe(1);
    expect(badSection.stderr).toContain('Unknown resume section: unknown');
  });

  it('refuses to render a stale variant after CareerIR changes', async () => {
    const { args, irFile } = await cliWorkspace();
    const ir = fixtureIr();
    const hidden = ir.profile.achievements[0]!;
    expect((await runCli(args(['import', irFile]))).code).toBe(0);

    const proposal = parseJson<ResumePatchProposal>(
      await runCli(args(['--json', 'compile', 'propose', '--hide-achievement', hidden.id]))
    );
    const applied = parseJson<{ variant: ResumeVariant }>(
      await runCli(args(['--json', 'compile', 'apply', proposal.id]))
    );
    expect(
      (await runCli(args(['render', 'resume', '--variant', applied.variant.id, '-o', '-']))).code
    ).toBe(0);

    const changedFile = join(dirname(irFile), 'career-ir-changed.json');
    await writeFile(changedFile, serializeCareerIR(fixtureIr({ displayName: 'Alice Updated' })), 'utf8');
    expect((await runCli(args(['import', changedFile]))).code).toBe(0);

    const stale = await runCli(args(['render', 'resume', '--variant', applied.variant.id, '-o', '-']));
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('is stale');
  });
});
