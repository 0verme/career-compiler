import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitSource } from '@career-compiler/source-local-git';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

async function git(directory: string, args: string[]): Promise<void> {
  await execFile('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Local Git source', () => {
  it('normalizes repository metadata and excludes secret paths from language discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'career-compiler-local-'));
    temporaryDirectories.push(root);
    const repository = join(root, 'lineage-toolkit');
    await mkdir(join(repository, 'node_modules'), { recursive: true });
    await mkdir(join(repository, 'secrets'), { recursive: true });
    await git(root, ['init', 'lineage-toolkit']);
    await git(repository, ['config', 'user.email', 'test@example.invalid']);
    await git(repository, ['config', 'user.name', 'Synthetic Test']);
    await writeFile(join(repository, 'README.md'), '# Lineage Toolkit\n\nMetadata-only fixture.\n');
    await writeFile(join(repository, 'index.ts'), 'export const value = 1;\n');
    await writeFile(join(repository, '.env'), 'SHOULD_NOT_BE_READ=redacted\n');
    await writeFile(join(repository, 'secrets', 'notes.ts'), 'should be excluded\n');
    await writeFile(join(repository, 'node_modules', 'ignored.ts'), 'should be excluded\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-m', 'Add metadata fixture']);

    const source = new LocalGitSource();
    const context = { now: '2025-01-15T00:00:00.000Z' };
    const discovery = await source.discover({ directory: root }, context);
    const scan = await source.scan(discovery, context);
    const evidence = await source.extractEvidence(scan, context);
    const repositoryEvidence = evidence.find((item) => item.evidenceType === 'local-repository');

    expect(scan.repositories).toHaveLength(1);
    expect(repositoryEvidence?.normalized).toMatchObject({
      name: 'lineage-toolkit',
      languages: ['TypeScript'],
      currentBranch: expect.any(String)
    });
    expect(repositoryEvidence?.raw).not.toHaveProperty('SHOULD_NOT_BE_READ');
    expect(evidence.some((item) => item.evidenceType === 'commit')).toBe(true);

    const allowlisted = await source.discover(
      { directory: root, policy: { allowlist: ['lineage-toolkit'] } },
      context
    );
    expect(allowlisted.repositories).toHaveLength(1);
  });
});
