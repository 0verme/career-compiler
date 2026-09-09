#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import type {
  CareerFact,
  CareerFactStatus,
  CareerIR,
  CareerRepository,
  SourceRunContext
} from '@career-compiler/core';
import {
  buildCareerIR,
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
import { LocalGitSource } from '@career-compiler/source-local-git';
import {
  SQLiteCareerRepository,
  getDefaultDatabasePath
} from '@career-compiler/storage';
import {
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
  repository: CareerRepository;
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

function nowContext(): SourceRunContext {
  return { now: new Date().toISOString() };
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
  return { config: loaded.config, dataDir, profileId, repository };
}

function effectiveProfileSeed(runtime: Runtime): ReturnType<typeof profileSeed> {
  const existing = runtime.repository.loadCareerIR(runtime.profileId);
  const configured = profileSeed(runtime.config);
  return {
    id: runtime.profileId,
    displayName:
      runtime.config.profile?.displayName ?? existing?.profile.displayName ?? configured.displayName,
    ...(runtime.config.profile?.headline ?? existing?.profile.headline
      ? { headline: runtime.config.profile?.headline ?? existing?.profile.headline }
      : {}),
    ...(runtime.config.profile?.about ?? existing?.profile.about
      ? { about: runtime.config.profile?.about ?? existing?.profile.about }
      : {})
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
  .action(async (username: string, options: Record<string, string>, command: Command) => {
    await withRuntime(command, async (runtime) => {
      const maxRepositories = parsePositiveInteger(options.maxRepositories, '--max-repositories');
      const maxActivityItems = parsePositiveInteger(options.maxActivityItems, '--max-activity-items');
      const tokenEnv = options.tokenEnv ?? runtime.config.github?.tokenEnv ?? 'GITHUB_TOKEN';
      const source = new GitHubSource({
        token: process.env[tokenEnv],
        apiBaseUrl: runtime.config.github?.apiBaseUrl,
        maxRepositories: maxRepositories ?? runtime.config.github?.maxRepositories,
        maxActivityItems: maxActivityItems ?? runtime.config.github?.maxActivityItems
      });
      const context = nowContext();
      const discovery = await source.discover(
        options.repository ? { repository: options.repository } : { username },
        context
      );
      const result = await source.scan(discovery, context);
      const evidence = await source.extractEvidence(result, context);
      ingest(runtime, evidence);
      printValue(command, {
        source: 'github',
        repositories: result.repositories.length,
        evidence: evidence.length,
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
      const context: SourceRunContext = { ...nowContext(), scanner: policy };
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
