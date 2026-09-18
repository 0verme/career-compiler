import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCareerIR,
  deriveCandidateFacts,
  validateCareerEvidence,
  type CareerEvidence,
  type JsonObject
} from '@career-compiler/core';
import {
  AiSessionSource,
  aiSessionsToEvidence,
  aliceAiSessionProjectId,
  canonicalizeAiSessionProject,
  createAliceAiSessionBundle,
  createAliceAiSessionFixtureEvidence,
  createAliceAiSessionJsonl,
  parseAiSessionBundle,
  parseAiSessionJsonl,
  type AiSessionRequest
} from '@career-compiler/source-ai-session';
import { SQLiteCareerRepository } from '@career-compiler/storage';

const execFile = promisify(execFileCallback);
const NOW = '2025-01-15T00:00:00.000Z';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function runSource(request: AiSessionRequest, now = NOW): Promise<CareerEvidence[]> {
  const source = new AiSessionSource();
  const context = { now };
  const discovery = await source.discover(request, context);
  const scan = await source.scan(discovery, context);
  return source.extractEvidence(scan, context);
}

function messageEvidence(evidence: CareerEvidence[], sourceId: string): CareerEvidence | undefined {
  return evidence.find((item) => item.sourceId === sourceId);
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'career-compiler-ai-session-'));
  temporaryDirectories.push(root);
  return root;
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = await execFile('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  return result.stdout.trim();
}

describe('AI session source', () => {
  it('maps normalized sessions to deterministic evidence with provenance', async () => {
    const first = await runSource({ bundle: createAliceAiSessionBundle() });
    const second = await runSource({ bundle: createAliceAiSessionBundle() });

    expect(second).toEqual(first);
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
    expect(first.every((item) => item.sourceType === 'ai-session')).toBe(true);
    expect(first.filter((item) => item.evidenceType === 'ai-session')).toHaveLength(2);
    expect(first.filter((item) => item.evidenceType === 'ai-session-message')).toHaveLength(10);
    for (const item of first) {
      expect(validateCareerEvidence(item)).toEqual(item);
    }

    const userMessage = messageEvidence(
      first,
      'codex:codex-2025-01-12-lineage-registry:message:id:codex-msg-001'
    );
    expect(userMessage?.normalized).toMatchObject({
      source: 'codex',
      sessionId: 'codex-2025-01-12-lineage-registry',
      role: 'user',
      actorRole: 'user',
      project: {
        projectId: aliceAiSessionProjectId(),
        projectName: 'data-lineage-toolkit',
        identityBasis: 'remote'
      },
      sourceRef: {
        source: 'codex',
        sourceSessionId: 'codex-2025-01-12-lineage-registry',
        sourcePath: 'sessions/2025/01/12/rollout-2025-01-12T09-00-00-lineage-registry.jsonl',
        lineStart: 4,
        lineEnd: 4
      }
    });
    expect(typeof userMessage?.contentHash).toBe('string');

    const worktreeMessage = messageEvidence(
      first,
      'pi:pi-2025-01-13-lineage-worktree:message:id:pi-msg-001'
    );
    expect(worktreeMessage?.normalized).toMatchObject({
      project: {
        projectId: aliceAiSessionProjectId(),
        isWorktree: true
      }
    });

    const sessionEvidence = first.find((item) => item.evidenceType === 'ai-session');
    expect(sessionEvidence?.normalized).toMatchObject({
      messageCount: 5,
      userMessageCount: 2,
      assistantMessageCount: 3
    });
  });

  it('loads the same JSONL fixture from disk', async () => {
    const root = await createRepository();
    const filePath = join(root, 'normalized-sessions.jsonl');
    await writeFile(filePath, `${createAliceAiSessionJsonl()}\n`, 'utf8');

    const evidence = await runSource({ filePath });
    expect(evidence).toEqual(await runSource({ bundle: createAliceAiSessionBundle() }));
  });

  it('merges duplicate and partial session records without duplicate evidence', async () => {
    const bundle = createAliceAiSessionBundle();
    const duplicated = {
      ...bundle,
      sessions: [...bundle.sessions.map((session) => structuredClone(session)), ...bundle.sessions]
    };
    const evidence = await runSource({ bundle: duplicated });

    expect(evidence.filter((item) => item.evidenceType === 'ai-session')).toHaveLength(2);
    expect(evidence.filter((item) => item.evidenceType === 'ai-session-message')).toHaveLength(10);
    expect(new Set(evidence.map((item) => item.id)).size).toBe(evidence.length);

    const [codexSession] = bundle.sessions;
    const firstHalf = {
      ...structuredClone(codexSession!),
      messages: codexSession!.messages.slice(0, 2)
    };
    const secondHalf = {
      ...structuredClone(codexSession!),
      messages: codexSession!.messages.slice(2)
    };
    const merged = await runSource({ bundle: { ...bundle, sessions: [firstHalf, secondHalf] } });
    const mergedCodex = merged.find((item) => item.evidenceType === 'ai-session');
    expect(mergedCodex?.normalized).toMatchObject({ messageCount: 5 });

    const repository = new SQLiteCareerRepository({ filePath: join(await createRepository(), 'career.sqlite') });
    try {
      for (const item of evidence) {
        repository.saveEvidence(item);
        repository.saveEvidence(item);
      }
      expect(repository.listEvidence('ai-session')).toHaveLength(evidence.length);
    } finally {
      repository.close();
    }
  });

  it('keeps scanning when JSONL lines are corrupt', async () => {
    const bundle = createAliceAiSessionBundle();
    const lines = [
      JSON.stringify(bundle.sessions[0]),
      '{ not valid json',
      'null',
      '{"source":"codex"}',
      '',
      JSON.stringify(bundle.sessions[1])
    ];
    const parsed = parseAiSessionJsonl(lines.join('\n'));

    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.skippedRecords).toBe(3);
    expect(parsed.issues.map((issue) => issue.reason)).toEqual([
      'invalid-json',
      'invalid-session',
      'invalid-session'
    ]);

    const root = await createRepository();
    const filePath = join(root, 'corrupt.jsonl');
    await writeFile(filePath, lines.join('\n'), 'utf8');
    const evidence = await runSource({ filePath });
    expect(evidence.filter((item) => item.evidenceType === 'ai-session')).toHaveLength(2);
    expect(evidence.filter((item) => item.evidenceType === 'ai-session-message')).toHaveLength(10);
  });

  it('rejects a malformed bundle but tolerates an invalid individual session', () => {
    expect(() => parseAiSessionBundle({ sessions: 'nope' })).toThrow(/sessions array/);
    expect(() =>
      parseAiSessionBundle({ schemaVersion: 'ai-session-bundle/99', sessions: [] })
    ).toThrow(/Unsupported AI session bundle schema/);
    const result = parseAiSessionBundle({ sessions: [null, { source: 'codex' }] });
    expect(result.sessions).toEqual([]);
    expect(result.skippedRecords).toBe(2);
  });

  it('resolves main workspace and two worktrees to one canonical project', async () => {
    const root = await createRepository();
    const main = join(root, 'toolkit');
    await git(root, ['init', 'toolkit']);
    await git(main, ['config', 'user.email', 'test@example.invalid']);
    await git(main, ['config', 'user.name', 'Synthetic Test']);
    await writeFile(join(main, 'README.md'), '# toolkit\n', 'utf8');
    await git(main, ['add', '.']);
    await git(main, ['commit', '-m', 'init']);
    const worktreeA = join(root, 'toolkit-wt-a');
    const worktreeB = join(root, 'toolkit-wt-b');
    await git(main, ['worktree', 'add', '-b', 'wt-a', worktreeA]);
    await git(main, ['worktree', 'add', '-b', 'wt-b', worktreeB]);

    const directories = [main, worktreeA, worktreeB];
    const commonDirs = await Promise.all(
      directories.map(async (directory) =>
        resolve(directory, await git(directory, ['rev-parse', '--git-common-dir']))
      )
    );
    expect(new Set(commonDirs).size).toBe(1);

    const makeSession = (directory: string, index: number, repoUrl?: string) => ({
      source: 'codex',
      sessionId: `worktree-session-${index}`,
      project: {
        projectName: 'toolkit',
        repoPath: main,
        ...(index > 0 ? { worktreePath: directory } : {}),
        ...(repoUrl ? { repoUrl } : {}),
        metadata: { gitCommonDir: commonDirs[index] }
      },
      startedAt: '2025-01-10T08:00:00.000Z',
      endedAt: '2025-01-10T08:01:00.000Z',
      messages: [
        {
          id: `worktree-message-${index}`,
          role: 'user' as const,
          text: `worktree note ${index}`,
          timestamp: '2025-01-10T08:00:00.000Z',
          sourceRef: {
            source: 'codex',
            sourceSessionId: `worktree-session-${index}`,
            occurredAt: '2025-01-10T08:00:00.000Z',
            sourcePath: `/home/alice/.codex/sessions/2025/01/10/worktree-${index}.jsonl`,
            lineStart: 1,
            lineEnd: 1
          }
        }
      ]
    });

    const byCommonDir = directories.map((directory, index) => makeSession(directory, index));
    const identities = byCommonDir.map((session) => canonicalizeAiSessionProject(session.project));
    expect(new Set(identities.map((identity) => identity.projectId)).size).toBe(1);
    expect(identities[0]?.identityBasis).toBe('git-common-dir');

    const byRemote = directories.map((directory, index) =>
      makeSession(directory, index, 'https://github.com/alice/toolkit.git')
    );
    const remoteIdentities = byRemote.map((session) => canonicalizeAiSessionProject(session.project));
    expect(new Set(remoteIdentities.map((identity) => identity.projectId)).size).toBe(1);
    expect(remoteIdentities[0]?.identityBasis).toBe('remote');

    const evidence = aiSessionsToEvidence(byCommonDir, { now: NOW });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('/home/alice');
    expect(evidence.find((item) => item.evidenceType === 'ai-session')?.normalized).toMatchObject({
      project: { identityBasis: 'git-common-dir' }
    });
  });

  it('keeps tool arguments and absolute paths out of evidence by default', async () => {
    const bundle = createAliceAiSessionBundle();
    const defaultEvidence = await runSource({ bundle });
    const defaultSerialized = JSON.stringify(defaultEvidence);

    expect(defaultSerialized).not.toContain('/home/alice');
    expect(defaultSerialized).not.toContain('pnpm test');
    expect(defaultSerialized).not.toContain('packages/core/registry.ts');

    const shellCall = messageEvidence(
      defaultEvidence,
      'codex:codex-2025-01-12-lineage-registry:message:id:codex-call-001'
    );
    expect(shellCall?.normalized).toMatchObject({
      toolCalls: [{ id: 'call-001', name: 'shell' }]
    });

    const withArguments = await runSource({ bundle, privacy: { includeToolArguments: true } });
    const shellCallWithArguments = messageEvidence(
      withArguments,
      'codex:codex-2025-01-12-lineage-registry:message:id:codex-call-001'
    );
    expect((shellCallWithArguments?.normalized.toolCalls as JsonObject[])[0]).toMatchObject({
      name: 'shell',
      arguments: { command: 'pnpm test -- contract' }
    });

    const omitted = aiSessionsToEvidence(bundle.sessions, { now: NOW }, { sourcePath: 'omitted' });
    const omittedMessage = omitted.find((item) => item.evidenceType === 'ai-session-message');
    const omittedRef = omittedMessage?.normalized.sourceRef as JsonObject;
    expect(omittedRef).not.toHaveProperty('sourcePath');
    expect(omittedRef.sourcePathHash).toEqual(expect.any(String));

    const absolute = aiSessionsToEvidence(bundle.sessions, { now: NOW }, { sourcePath: 'absolute' });
    expect(JSON.stringify(absolute)).toContain('/home/alice/.codex/sessions/');
  });

  it('never crosses the candidate / confirmed boundary', async () => {
    const evidence = createAliceAiSessionFixtureEvidence();
    expect(evidence.every((item) => item.attribution === 'context')).toBe(true);
    expect(deriveCandidateFacts(evidence)).toEqual([]);

    const ir = buildCareerIR({
      profile: { id: 'alice', displayName: 'Alice Example' },
      facts: [],
      evidence,
      exportedAt: NOW
    });
    expect(ir.profile.achievements).toEqual([]);
    expect(ir.profile.projects).toEqual([]);
    expect(ir.profile.skills).toEqual([]);
    expect(ir.evidence).toHaveLength(evidence.length);
  });
});
