import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TargetJob } from '@career-compiler/core';

const CLI_ENTRY = resolve(process.cwd(), 'apps/cli/dist/index.js');

const JD_A = [
  '数据平台负责人 / Data Platform Lead',
  '',
  '职责：',
  '- 负责湖仓一体平台建设，服务 180+ 上游系统；',
  '- 带领 18 人团队交付数据治理能力。'
].join('\n');
const JD_B = [
  'Staff Data Engineer',
  '',
  'Responsibilities:',
  '- Own the streaming platform;',
  '- Drive data governance adoption.'
].join('\n');
const JD_C = 'Data Platform Lead\n\n职责：\n- 负责指标平台建设。';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface TargetJobSummary {
  id: string;
  company: string | null;
  title: string;
  updatedAt: string;
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
  dataDir: string;
  jdFile: string;
  newJdFile: string;
  args: (extra: string[]) => string[];
}

async function cliWorkspace(): Promise<CliWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), 'career-compiler-target-cli-'));
  temporaryDirectories.push(directory);
  const dataDir = join(directory, 'data');
  const jdFile = join(directory, 'jd-a.md');
  const newJdFile = join(directory, 'jd-b.md');
  await writeFile(jdFile, JD_A, 'utf8');
  await writeFile(newJdFile, JD_B, 'utf8');
  return {
    dataDir,
    jdFile,
    newJdFile,
    args: (extra: string[]) => ['--data-dir', dataDir, ...extra]
  };
}

describe('target CLI', () => {
  it('runs add → list → show → update → show while keeping the target job id stable', async () => {
    const { args, jdFile, newJdFile } = await cliWorkspace();

    const created = parseJson<TargetJob>(
      await runCli(
        args([
          '--json',
          'target',
          'add',
          '--title',
          'Data Platform Lead',
          '--company',
          'Acme',
          '--jd-file',
          jdFile
        ])
      )
    );
    expect(created.id).toMatch(/^targetjob_/);
    expect(created.title).toBe('Data Platform Lead');
    expect(created.company).toBe('Acme');
    expect(created.rawJd).toBe(JD_A);
    expect(created.rawJdHash).toHaveLength(8);

    const listed = parseJson<TargetJobSummary[]>(await runCli(args(['--json', 'target', 'list'])));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      company: 'Acme',
      title: 'Data Platform Lead',
      updatedAt: created.updatedAt
    });
    expect(listed[0]).not.toHaveProperty('rawJd');
    expect(listed[0]).not.toHaveProperty('rawJdHash');

    const shown = await runCli(args(['target', 'show', created.id]));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain(created.id);
    expect(shown.stdout).toContain(created.rawJdHash);
    expect(shown.stdout).toContain(JD_A);

    const updatedText = await runCli(args(['target', 'update', created.id, '--jd', JD_B]));
    expect(updatedText.code).toBe(0);
    expect(updatedText.stdout).toContain('changed:   rawJd, rawJdHash, updatedAt');
    expect(updatedText.stdout).not.toContain('Responsibilities:');

    const updated = parseJson<TargetJob>(
      await runCli(
        args([
          '--json',
          'target',
          'update',
          created.id,
          '--title',
          'Staff Data Engineer',
          '--company',
          '',
          '--jd-file',
          newJdFile
        ])
      )
    );
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.title).toBe('Staff Data Engineer');
    expect(updated.company).toBeUndefined();
    expect(updated.rawJd).toBe(JD_B);
    expect(updated.rawJdHash).not.toBe(created.rawJdHash);

    const shownAgain = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'show', created.id]))
    );
    expect(shownAgain).toEqual(updated);

    const shownText = await runCli(args(['target', 'show', created.id]));
    expect(shownText.stdout).toContain(JD_B);
    expect(shownText.stdout).not.toContain(JD_A);
  });

  it('accepts raw JD from stdin and from an inline argument', async () => {
    const { args } = await cliWorkspace();

    const piped = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Streaming Lead', '--jd-file', '-']), JD_B)
    );
    expect(piped.rawJd).toBe(JD_B);

    const defaultStdin = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Piped Lead']), JD_A)
    );
    expect(defaultStdin.rawJd).toBe(JD_A);

    const inline = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Inline Lead', '--jd', JD_C]))
    );
    expect(inline.rawJd).toBe(JD_C);

    const list = parseJson<TargetJobSummary[]>(await runCli(args(['--json', 'target', 'list'])));
    expect(list).toHaveLength(3);
    for (const summary of list) {
      expect(summary).not.toHaveProperty('rawJd');
    }

    const listText = await runCli(args(['target', 'list']));
    expect(listText.stdout).toContain(piped.id);
    expect(listText.stdout).not.toContain('Responsibilities:');
    expect(listText.stdout).not.toContain('职责：');
  });

  it('reports unknown ids and empty updates with a non-zero exit code', async () => {
    const { args, jdFile } = await cliWorkspace();

    const emptyList = await runCli(args(['target', 'list']));
    expect(emptyList.code).toBe(0);
    expect(emptyList.stdout).toContain('(no target jobs)');

    const missing = await runCli(args(['target', 'show', 'targetjob_missing']));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('TargetJob not found: targetjob_missing');

    const created = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Data Platform Lead', '--jd-file', jdFile]))
    );
    const missingUpdate = await runCli(args(['target', 'update', 'targetjob_missing', '--title', 'X']));
    expect(missingUpdate.code).toBe(1);
    expect(missingUpdate.stderr).toContain('TargetJob not found: targetjob_missing');

    const noPatch = await runCli(args(['target', 'update', created.id]));
    expect(noPatch.code).toBe(1);
    expect(noPatch.stderr).toContain('TargetJob patch must change at least one of');

    const noTitle = await runCli(args(['target', 'add', '--jd-file', jdFile]));
    expect(noTitle.code).toBe(1);
    expect(noTitle.stderr).toContain('required option');
  });

  it('never creates career facts or evidence from target job commands', async () => {
    const { args, jdFile } = await cliWorkspace();

    const created = parseJson<TargetJob>(
      await runCli(args(['--json', 'target', 'add', '--title', 'Data Platform Lead', '--jd-file', jdFile]))
    );
    await runCli(args(['target', 'update', created.id, '--jd', JD_C]));

    const facts = parseJson<unknown[]>(await runCli(args(['--json', 'facts', 'list'])));
    expect(facts).toEqual([]);
    const stillThere = parseJson<TargetJob>(await runCli(args(['--json', 'target', 'show', created.id])));
    expect(stillThere.rawJd).toBe(JD_C);
  });
});
