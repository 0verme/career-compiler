import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JdRequirement, JdRequirementSet, TargetJob } from '@career-compiler/core';

const CLI_ENTRY = resolve(process.cwd(), 'apps/cli/dist/index.js');

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
  jdFile: string;
  updatedJdFile: string;
}

async function cliWorkspace(): Promise<CliWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), 'career-compiler-jd-cli-'));
  temporaryDirectories.push(directory);
  const dataDir = join(directory, 'data');
  const jdFile = join(directory, 'jd.md');
  const updatedJdFile = join(directory, 'jd-v2.md');
  await writeFile(jdFile, JD, 'utf8');
  await writeFile(updatedJdFile, JD_UPDATED, 'utf8');
  return {
    jdFile,
    updatedJdFile,
    args: (extra: string[]) => ['--data-dir', dataDir, ...extra]
  };
}

describe('jd CLI', () => {
  it('runs parse → list → confirm / edit / reject and re-parses after a JD update', async () => {
    const { args, jdFile, updatedJdFile } = await cliWorkspace();

    const target = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Data Platform Lead', '--jd-file', jdFile]))
    );
    const parsed = parseJson<{ requirements: number; rawJdHash: string; parser: string }>(
      await runCli(args(['--json', 'jd', 'parse', target.id]))
    );
    expect(parsed.requirements).toBe(7);
    expect(parsed.parser).toBe('deterministic-jd-rules');
    expect(parsed.rawJdHash).toBe(target.rawJdHash);

    const listed = parseJson<JdRequirementSet>(await runCli(args(['--json', 'jd', 'list', target.id])));
    expect(listed.requirements).toHaveLength(7);
    expect(listed.requirements.every((item) => item.status === 'parsed')).toBe(true);
    const [first, second, third] = listed.requirements;

    const confirmed = parseJson<JdRequirement>(
      await runCli(args(['--json', 'jd', 'confirm', first!.id]))
    );
    expect(confirmed.status).toBe('confirmed');

    const edited = parseJson<JdRequirement>(
      await runCli(
        args([
          '--json',
          'jd',
          'edit',
          second!.id,
          '--category',
          'domain',
          '--priority',
          'preferred',
          '--statement',
          '数据治理与平台建设'
        ])
      )
    );
    expect(edited.category).toBe('domain');
    expect(edited.priority).toBe('preferred');
    expect(edited.statement).toBe('数据治理与平台建设');
    expect(edited.rawQuote).toBe(second!.rawQuote);

    const rejected = parseJson<JdRequirement>(
      await runCli(args(['--json', 'jd', 'reject', third!.id]))
    );
    expect(rejected.status).toBe('rejected');

    const listText = await runCli(args(['jd', 'list', target.id]));
    expect(listText.code).toBe(0);
    expect(listText.stdout).toContain('confirmed');
    expect(listText.stdout).toContain('rejected');
    expect(listText.stdout).not.toContain('! stale:');

    // Changing the raw JD marks the stored set stale until it is re-parsed.
    await runCli(args(['target', 'update', target.id, '--jd-file', updatedJdFile]));
    const staleList = await runCli(args(['jd', 'list', target.id]));
    expect(staleList.code).toBe(0);
    expect(staleList.stdout).toContain('! stale:');
    expect(staleList.stdout).toContain('re-run `jd parse`');

    const reparsed = parseJson<{ rawJdHash: string }>(
      await runCli(args(['--json', 'jd', 'parse', target.id]))
    );
    expect(reparsed.rawJdHash).not.toBe(parsed.rawJdHash);
    const relisted = parseJson<JdRequirementSet>(await runCli(args(['--json', 'jd', 'list', target.id])));
    expect(relisted.rawJdHash).toBe(reparsed.rawJdHash);
    expect(relisted.requirements.every((item) => item.status === 'parsed')).toBe(true);
    expect(relisted.requirements.map((item) => item.id)).not.toContain(first!.id);

    // JD understanding never writes career facts.
    expect(parseJson<unknown[]>(await runCli(args(['--json', 'facts', 'list'])))).toEqual([]);
  });

  it('reports unknown ids and invalid review input with a non-zero exit code', async () => {
    const { args, jdFile } = await cliWorkspace();

    const target = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Data Platform Lead', '--jd-file', jdFile]))
    );
    const missingTarget = await runCli(args(['jd', 'parse', 'targetjob_missing']));
    expect(missingTarget.code).toBe(1);
    expect(missingTarget.stderr).toContain('TargetJob not found: targetjob_missing');

    const emptyList = await runCli(args(['jd', 'list', target.id]));
    expect(emptyList.code).toBe(0);
    expect(emptyList.stdout).toContain('(no JD requirements');

    await runCli(args(['jd', 'parse', target.id]));
    const listed = parseJson<JdRequirementSet>(await runCli(args(['--json', 'jd', 'list', target.id])));
    const requirementId = listed.requirements[0]!.id;

    const missing = await runCli(args(['jd', 'confirm', 'jdreq_missing']));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('JdRequirement not found: jdreq_missing');

    const noPatch = await runCli(args(['jd', 'edit', requirementId]));
    expect(noPatch.code).toBe(1);
    expect(noPatch.stderr).toContain('must change at least one');

    const badCategory = await runCli(args(['jd', 'edit', requirementId, '--category', 'unknown']));
    expect(badCategory.code).toBe(1);
    expect(badCategory.stderr).toContain('Unsupported requirement category: unknown');

    const shown = await runCli(args(['jd', 'show', requirementId]));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('rawQuote:');
  });
});
