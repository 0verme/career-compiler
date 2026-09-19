#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import type {
  CareerFact,
  CareerFactStatus,
  CareerIdentity,
  CareerIR,
  CareerRepository,
  SourceRunContext,
  TargetJob,
  TargetJobPatch,
  TargetJobRepository
} from '@career-compiler/core';
import {
  buildCareerIR,
  createTargetJob,
  deriveCandidateFacts,
  mergeCandidateFacts,
  parseCareerIR,
  serializeCareerIR
} from '@career-compiler/core';
import { GitHubProfileMarkdownRenderer } from '@career-compiler/renderer-github-profile';
import { ResumeMarkdownRenderer } from '@career-compiler/renderer-resume';
import {
  DeterministicFactExtractor,
  ManualChatSource,
  extractionToCandidateFacts
} from '@career-compiler/source-chat';
import { GitHubSource } from '@career-compiler/source-github';
import { AiSessionSource } from '@career-compiler/source-ai-session';
import { LocalGitSource } from '@career-compiler/source-local-git';
import {
  SQLiteCareerRepository,
  getDefaultDatabasePath
} from '@career-compiler/storage';
import {
  careerIdentity,
  loadConfig,
  profileSeed,
  resolveDataDirectory,
  scannerPolicy,
  type CareerCompilerConfig
} from './config.js';

interface RootOptions {
  dataDir?: string;
  config?: string;
  json?: boolean;
}

interface Runtime {
  config: CareerCompilerConfig;
  dataDir: string;
  profileId: string;
  identity?: CareerIdentity;
  repository: CareerRepository & TargetJobRepository;
}

const FACT_STATUSES: CareerFactStatus[] = [
  'candidate',
  'confirmed',
  'rejected',
  'superseded',
  'conflicted'
];

function rootCommand(command: Command): Command {
  let current = command;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function rootOptions(command: Command): RootOptions {
  return rootCommand(command).opts() as RootOptions;
}

function nowContext(identity?: CareerIdentity): SourceRunContext {
  return {
    now: new Date().toISOString(),
    ...(identity ? { identity } : {})
  };
}

function parsePositiveInteger(value: string | undefined, optionName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, optionName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return parsed;
}

function parseStatus(value: string | undefined): CareerFactStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  for (const status of FACT_STATUSES) {
    if (status === value) {
      return status;
    }
  }
  throw new Error(`Unknown fact status: ${value}. Use ${FACT_STATUSES.join(', ')}`);
}

async function openRuntime(command: Command, profileOverride?: string): Promise<Runtime> {
  const options = rootOptions(command);
  const loaded = await loadConfig(options.config);
  const dataDir = resolveDataDirectory(loaded.config, options.dataDir);
  const profileId = profileOverride ?? loaded.config.profile?.id ?? 'default';
  const repository = new SQLiteCareerRepository({
    filePath: resolve(dataDir, 'career-compiler.sqlite')
  });
  return {
    config: loaded.config,
    dataDir,
    profileId,
    identity: careerIdentity(loaded.config),
    repository
  };
}

function effectiveProfileSeed(runtime: Runtime): ReturnType<typeof profileSeed> {
  const existing = runtime.repository.loadCareerIR(runtime.profileId);
  const configured = profileSeed(runtime.config);
  const identity = runtime.identity ?? existing?.profile.identity;
  return {
    id: runtime.profileId,
    displayName:
      runtime.config.profile?.displayName ?? existing?.profile.displayName ?? configured.displayName,
    ...(runtime.config.profile?.headline ?? existing?.profile.headline
      ? { headline: runtime.config.profile?.headline ?? existing?.profile.headline }
      : {}),
    ...(runtime.config.profile?.about ?? existing?.profile.about
      ? { about: runtime.config.profile?.about ?? existing?.profile.about }
      : {}),
    ...(identity ? { identity } : {})
  };
}

function rebuildCareerIR(runtime: Runtime, exportedAt = new Date().toISOString()): CareerIR {
  const ir = buildCareerIR({
    profile: effectiveProfileSeed(runtime),
    facts: runtime.repository.listFacts(),
    evidence: runtime.repository.listEvidence(),
    exportedAt
  });
  runtime.repository.saveCareerIR(ir);
  return ir;
}

function ingest(
  runtime: Runtime,
  evidence: Parameters<CareerRepository['saveEvidence']>[0][],
  additionalFacts: CareerFact[] = []
): CareerIR {
  for (const item of evidence) {
    runtime.repository.saveEvidence(item);
  }
  const facts = mergeCandidateFacts(
    runtime.repository.listFacts(),
    [...deriveCandidateFacts(evidence), ...additionalFacts]
  );
  for (const fact of facts) {
    runtime.repository.saveFact(fact);
  }
  return rebuildCareerIR(runtime);
}

function printValue(command: Command, value: unknown): void {
  if (rootOptions(command).json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function readTemplate(path: string | undefined): Promise<string | undefined> {
  return path ? readFile(resolve(path), 'utf8') : undefined;
}

function targetJobSummary(job: TargetJob): Record<string, string | null> {
  return {
    id: job.id,
    company: job.company ?? null,
    title: job.title,
    updatedAt: job.updatedAt
  };
}

function targetJobHeader(job: TargetJob): string {
  return [
    `id:        ${job.id}`,
    `company:   ${job.company ?? ''}`,
    `title:     ${job.title}`,
    `rawJdHash: ${job.rawJdHash}`,
    `createdAt: ${job.createdAt}`,
    `updatedAt: ${job.updatedAt}`
  ].join('\n');
}

/** add/update output: identity and change status, never the full raw JD. */
function printTargetJobSummary(command: Command, job: TargetJob, changed?: string[]): void {
  if (rootOptions(command).json) {
    printValue(command, job);
    return;
  }
  const lines = [targetJobHeader(job)];
  if (changed) {
    lines.push(`changed:   ${changed.length > 0 ? changed.join(', ') : '(none)'}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printTargetJobDetail(command: Command, job: TargetJob): void {
  if (rootOptions(command).json) {
    printValue(command, job);
    return;
  }
  const rawJd = job.rawJd.endsWith('\n') ? job.rawJd : `${job.rawJd}\n`;
  process.stdout.write(`${targetJobHeader(job)}\n\n--- raw JD ---\n${rawJd}`);
}

function printTargetJobList(jobs: TargetJob[]): void {
  if (jobs.length === 0) {
    process.stdout.write('(no target jobs)\n');
    return;
  }
  const header = ['ID', 'COMPANY', 'TITLE', 'UPDATED'];
  const rows = jobs.map((job) => [job.id, job.company ?? '-', job.title, job.updatedAt]);
  const widths = header.map((label, index) =>
    Math.max(label.length, ...rows.map((row) => (row[index] ?? '').length))
  );
  const format = (row: string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  process.stdout.write([format(header), ...rows.map(format)].join('\n') + '\n');
}

interface RawJdOptions {
  jd?: string;
  jdFile?: string;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Raw JD is long text, so `--jd-file` / stdin are first-class input paths.
 * The text is returned verbatim; only TargetJob validation decides if it is
 * usable.
 */
async function readRawJd(options: RawJdOptions): Promise<string> {
  if (options.jd !== undefined && options.jdFile !== undefined) {
    throw new Error('--jd 与 --jd-file 不能同时使用');
  }
  if (options.jdFile !== undefined) {
    return options.jdFile === '-' ? readStdinText() : readFile(resolve(options.jdFile), 'utf8');
  }
  if (options.jd !== undefined) {
    return options.jd;
  }
  if (process.stdin.isTTY) {
    throw new Error('缺少 raw JD：请使用 --jd、--jd-file <path>，或通过 stdin 传入');
  }
  return readStdinText();
}

async function writeArtifact(command: Command, artifact: { fileName: string; content: string }, output?: string) {
  if (output === '-') {
    process.stdout.write(artifact.content);
    return;
  }
  const target = resolve(output ?? artifact.fileName);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, artifact.content, 'utf8');
  printValue(command, { output: target, bytes: Buffer.byteLength(artifact.content, 'utf8') });
}

async function withRuntime<T>(
  command: Command,
  action: (runtime: Runtime) => Promise<T>,
  profileOverride?: string
): Promise<T> {
  const runtime = await openRuntime(command, profileOverride);
  try {
    return await action(runtime);
  } finally {
    runtime.repository.close();
  }
}

const program = new Command();
program
  .name('career-compiler')
  .description('Compile evidence-backed career data into portable Career IR and Markdown outputs.')
  .version('0.1.0')
  .option('--data-dir <path>', '用户级 Career Database 目录')
  .option('--config <path>', '配置文件路径')
  .option('--json', '以 JSON 输出命令结果');

const scan = program.command('scan').description('从 Career Source 发现并保存 Career Evidence');

scan
  .command('github <username>')
  .description('扫描 GitHub 用户或指定 repository 的 metadata')
  .option('-r, --repository <owner/name>', '只扫描指定 repository')
  .option('--token-env <name>', '读取 GitHub token 的环境变量名')
  .option('--max-repositories <number>', '最多扫描 repository 数量')
  .option('--max-activity-items <number>', '每个 repository 最多扫描的 commits/issues/PRs')
  .option('--max-external-contributions <number>', '最多发现的外部 authored pull requests，0 表示关闭')
  .action(async (username: string, options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const maxRepositories = parsePositiveInteger(options.maxRepositories, '--max-repositories');
      const maxActivityItems = parsePositiveInteger(options.maxActivityItems, '--max-activity-items');
      const maxExternalContributions = parseNonNegativeInteger(
        options.maxExternalContributions,
        '--max-external-contributions'
      );
      const tokenEnv = options.tokenEnv ?? runtime.config.github?.tokenEnv ?? 'GITHUB_TOKEN';
      const source = new GitHubSource({
        token: process.env[tokenEnv],
        apiBaseUrl: runtime.config.github?.apiBaseUrl,
        maxRepositories: maxRepositories ?? runtime.config.github?.maxRepositories,
        maxActivityItems: maxActivityItems ?? runtime.config.github?.maxActivityItems,
        maxExternalContributions:
          maxExternalContributions ?? runtime.config.github?.maxExternalContributions
      });
      const context = nowContext(runtime.identity);
      const discovery = await source.discover(
        {
          username,
          ...(options.repository ? { repository: options.repository } : {})
        },
        context
      );
      const result = await source.scan(discovery, context);
      const evidence = await source.extractEvidence(result, context);
      ingest(runtime, evidence);
      printValue(command, {
        source: 'github',
        repositories: result.repositories.length,
        externalPullRequests: result.externalPullRequests.length,
        evidence: evidence.length,
        ...(result.warnings ? { warnings: result.warnings } : {}),
        database: getDefaultDatabasePath() === resolve(runtime.dataDir, 'career-compiler.sqlite')
          ? 'default'
          : resolve(runtime.dataDir, 'career-compiler.sqlite')
      });
    });
  });

scan
  .command('local <directory>')
  .description('扫描用户显式允许的本地目录中的 Git repositories')
  .option('--max-depth <number>', 'repository discovery 最大目录深度')
  .option('--max-commits <number>', '每个 repository 最多读取的 commit metadata 数量')
  .option('--max-files <number>', '最多检查的 tracked file path 数量')
  .option('--allow <pattern...>', '额外 allowlist pattern')
  .option('--deny <pattern...>', '额外 denylist pattern')
  .action(async (directory: string, options: Record<string, string | string[]>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const basePolicy = scannerPolicy(runtime.config);
      const policy = {
        ...basePolicy,
        ...(typeof options.maxDepth === 'string'
          ? { maxDepth: parsePositiveInteger(options.maxDepth, '--max-depth') }
          : {}),
        ...(typeof options.maxCommits === 'string'
          ? { maxCommits: parsePositiveInteger(options.maxCommits, '--max-commits') }
          : {}),
        ...(typeof options.maxFiles === 'string'
          ? { maxFiles: parsePositiveInteger(options.maxFiles, '--max-files') }
          : {}),
        ...(Array.isArray(options.allow) ? { allowlist: options.allow } : {}),
        ...(Array.isArray(options.deny) ? { denylist: [...basePolicy.denylist, ...options.deny] } : {})
      };
      const source = new LocalGitSource();
      const context: SourceRunContext = { ...nowContext(runtime.identity), scanner: policy };
      const discovery = await source.discover({ directory, policy }, context);
      const result = await source.scan(discovery, context);
      const evidence = await source.extractEvidence(result, context);
      ingest(runtime, evidence);
      printValue(command, {
        source: 'local-git',
        directory: resolve(directory),
        repositories: result.repositories.length,
        evidence: evidence.length,
        database: resolve(runtime.dataDir, 'career-compiler.sqlite')
      });
    });
  });

scan
  .command('ai-session <file>')
  .description(
    '导入已归一化的本地 AI session bundle（Codex / Claude Code / Pi）；只生成 Career Evidence，不生成事实'
  )
  .option('--source-path <mode>', 'sourcePath 写入模式：relative | absolute | omitted', 'relative')
  .option('--include-tool-arguments', '把 tool call arguments 写入 evidence（可能包含敏感内容）')
  .action(async (file: string, options: Record<string, string | boolean>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const sourcePath = options.sourcePath;
      if (sourcePath !== 'relative' && sourcePath !== 'absolute' && sourcePath !== 'omitted') {
        throw new Error(`Unknown --source-path mode: ${String(sourcePath)}`);
      }
      const source = new AiSessionSource();
      const context = nowContext(runtime.identity);
      const discovery = await source.discover(
        {
          filePath: resolve(file),
          privacy: {
            sourcePath,
            includeToolArguments: options.includeToolArguments === true
          }
        },
        context
      );
      const result = await source.scan(discovery, context);
      const evidence = await source.extractEvidence(result, context);
      ingest(runtime, evidence);
      printValue(command, {
        source: 'ai-session',
        file: resolve(file),
        sessions: result.sessions.length,
        evidence: evidence.length,
        skippedRecords: result.skippedRecords,
        issues: result.issues.map((issue) => issue.reason),
        database: resolve(runtime.dataDir, 'career-compiler.sqlite')
      });
    });
  });

program
  .command('add <text>')
  .description('添加一段手工或聊天输入，并生成 candidate CareerFacts')
  .option('--conversation-id <id>', '稳定 conversation id')
  .option('--observed-at <date>', '证据观察时间')
  .action(async (text: string, options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const source = new ManualChatSource();
      const context = nowContext();
      const discovery = await source.discover(
        {
          text,
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          ...(options.observedAt ? { observedAt: options.observedAt } : {})
        },
        context
      );
      const scanResult = await source.scan(discovery, context);
      const evidence = await source.extractEvidence(scanResult, context);
      const extractor = new DeterministicFactExtractor();
      const extracted = await extractor.extract(evidence[0]!);
      const candidates = extractionToCandidateFacts(evidence[0]!, extracted, context.now);
      ingest(runtime, evidence, candidates);
      printValue(command, {
        source: 'chat',
        evidence: evidence.map((item) => item.id),
        candidateFacts: candidates.map((fact) => ({
          id: fact.id,
          type: fact.type,
          statement: fact.statement,
          confidence: fact.confidence,
          status: fact.status
        }))
      });
    });
  });

const target = program
  .command('target')
  .description('管理目标岗位（Target Job）上下文；Target Job 不是 Career 事实源');

target
  .command('add')
  .description('创建 Target Job；raw JD 可来自 --jd、--jd-file 或 stdin')
  .requiredOption('--title <title>', '岗位名称')
  .option('--company <company>', '公司名称（可选）')
  .option('--jd <text>', 'raw JD 文本（适合较短内容）')
  .option('--jd-file <path>', '从文件读取 raw JD，使用 - 读取 stdin')
  .action(async (options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const title = options.title;
      const company = options.company;
      const rawJd = await readRawJd(options);
      const job = createTargetJob({
        title: title ?? '',
        ...(company && company.trim().length > 0 ? { company } : {}),
        rawJd
      });
      runtime.repository.saveTargetJob(job);
      printTargetJobSummary(command, job);
    });
  });

target
  .command('list')
  .description('列出 Target Job 概要（不含 raw JD）')
  .action(async (_options: unknown, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const jobs = runtime.repository.listTargetJobs();
      if (rootOptions(command).json) {
        printValue(command, jobs.map(targetJobSummary));
        return;
      }
      printTargetJobList(jobs);
    });
  });

target
  .command('show <id>')
  .description('显示 Target Job 完整信息，包括 raw JD')
  .action(async (id: string, _options: unknown, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const job = runtime.repository.getTargetJob(id);
      if (!job) {
        throw new Error(`TargetJob not found: ${id}`);
      }
      printTargetJobDetail(command, job);
    });
  });

target
  .command('update <id>')
  .description('更新 Target Job 的 title / company / raw JD；id 保持不变')
  .option('--title <title>', '新的岗位名称')
  .option('--company <company>', '新的公司名称；传空字符串表示清除')
  .option('--jd <text>', '新的 raw JD 文本')
  .option('--jd-file <path>', '从文件读取新的 raw JD，使用 - 读取 stdin')
  .action(async (id: string, options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const patch: TargetJobPatch = {};
      const title = options.title;
      const company = options.company;
      if (title !== undefined) {
        patch.title = title;
      }
      if (company !== undefined) {
        patch.company = company.trim().length === 0 ? null : company;
      }
      if (options.jd !== undefined || options.jdFile !== undefined) {
        patch.rawJd = await readRawJd(options);
      }
      const before = runtime.repository.getTargetJob(id);
      if (!before) {
        throw new Error(`TargetJob not found: ${id}`);
      }
      const updated = runtime.repository.updateTargetJob(id, patch);
      if (!updated) {
        throw new Error(`TargetJob not found: ${id}`);
      }
      const changed: string[] = [];
      if (updated.title !== before.title) {
        changed.push('title');
      }
      if (updated.company !== before.company) {
        changed.push('company');
      }
      if (updated.rawJd !== before.rawJd) {
        changed.push('rawJd', 'rawJdHash');
      }
      if (updated.updatedAt !== before.updatedAt) {
        changed.push('updatedAt');
      }
      printTargetJobSummary(command, updated, changed);
    });
  });

const facts = program.command('facts').description('查看和确认 CareerFacts');
facts
  .command('list [status]')
  .description('列出 candidate/confirmed/rejected 等事实')
  .action(async (status: string | undefined, _options: unknown, command: Command) => {
    await withRuntime(command, async (runtime) => {
      printValue(command, runtime.repository.listFacts(parseStatus(status)));
    });
  });

facts
  .command('confirm <id>')
  .description('由用户确认一个 candidate fact')
  .action(async (id: string, _options: unknown, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const confirmedAt = new Date().toISOString();
      const fact = runtime.repository.updateFactStatus(id, 'confirmed', {
        confirmedAt,
        confirmedBy: 'user'
      });
      if (!fact) {
        throw new Error(`CareerFact not found: ${id}`);
      }
      const ir = rebuildCareerIR(runtime, confirmedAt);
      printValue(command, {
        fact,
        profile: ir.profile.id,
        renderable: true
      });
    });
  });

const render = program.command('render').description('从 Career IR 生成职业输出物');
render
  .command('resume')
  .description('生成 Markdown resume')
  .option('-o, --output <path>', '输出文件路径，使用 - 输出到 stdout')
  .option('--template <path>', '自定义 Markdown template 文件')
  .option('--profile <id>', 'profile id')
  .action(async (options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const ir = runtime.repository.loadCareerIR(runtime.profileId) ?? rebuildCareerIR(runtime);
      const artifact = new ResumeMarkdownRenderer().render(ir, {
        ...(await readTemplate(options.template) ? { template: await readTemplate(options.template) } : {}),
        ...(options.output && options.output !== '-' ? { fileName: options.output } : {})
      });
      await writeArtifact(command, artifact, options.output);
    }, options.profile);
  });

render
  .command('github-profile')
  .description('生成 GitHub Profile README Markdown')
  .option('-o, --output <path>', '输出文件路径，使用 - 输出到 stdout')
  .option('--template <path>', '自定义 Markdown template 文件')
  .option('--profile <id>', 'profile id')
  .action(async (options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const ir = runtime.repository.loadCareerIR(runtime.profileId) ?? rebuildCareerIR(runtime);
      const artifact = new GitHubProfileMarkdownRenderer().render(ir, {
        ...(await readTemplate(options.template) ? { template: await readTemplate(options.template) } : {}),
        ...(options.output && options.output !== '-' ? { fileName: options.output } : {})
      });
      await writeArtifact(command, artifact, options.output);
    }, options.profile);
  });

program
  .command('export [output]')
  .description('导出 versioned Career IR JSON')
  .option('--profile <id>', 'profile id')
  .action(async (output: string | undefined, options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const ir = runtime.repository.loadCareerIR(runtime.profileId) ?? rebuildCareerIR(runtime);
      const target = resolve(output ?? 'career-ir.json');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, serializeCareerIR(ir), 'utf8');
      printValue(command, { output: target, schemaVersion: ir.schemaVersion });
    }, options.profile);
  });

program
  .command('import <file>')
  .description('导入并校验 versioned Career IR JSON')
  .option('--profile <id>', 'profile id（仅用于选择数据库，文档 profile id 保持不变）')
  .action(async (file: string, options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const ir = parseCareerIR(await readFile(resolve(file), 'utf8'));
      runtime.repository.importCareerIR(ir);
      printValue(command, {
        input: resolve(file),
        profile: ir.profile.id,
        facts: ir.facts.length,
        evidence: ir.evidence.length,
        schemaVersion: ir.schemaVersion
      });
    }, options.profile);
  });

void program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
