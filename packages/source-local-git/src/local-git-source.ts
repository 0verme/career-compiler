import { execFile as execFileCallback } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CareerEvidence,
  CareerSource,
  EvidenceAttribution,
  JsonObject,
  ScannerPolicy,
  SourceIdentity,
  SourceRunContext
} from '@career-compiler/core';
import {
  createEvidenceId,
  DEFAULT_SCANNER_POLICY
} from '@career-compiler/core';

const execFile = promisify(execFileCallback);

export interface LocalGitSourceOptions {
  policy?: Partial<ScannerPolicy>;
  identity?: SourceIdentity;
  gitRunner?: GitRunner;
}

export interface LocalGitRequest {
  directory: string;
  policy?: Partial<ScannerPolicy>;
}

export interface LocalGitDiscovery {
  rootDirectory: string;
  repositories: string[];
  policy: ScannerPolicy;
}

export interface LocalGitCommit {
  hash: string;
  authorDate?: string;
  committerDate?: string;
  author: string;
  authorEmail?: string;
  subject: string;
}

export interface LocalGitRepositoryScan {
  path: string;
  name: string;
  remote?: string;
  currentBranch?: string;
  commits: LocalGitCommit[];
  firstActivity?: string;
  lastActivity?: string;
  contributors: string[];
  languages: string[];
  tags: string[];
  readme?: {
    path: string;
    title?: string;
    excerpt?: string;
  };
  projectMetadata?: {
    name?: string;
    description?: string;
  };
}

export interface LocalGitScanResult {
  repositories: LocalGitRepositoryScan[];
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const DEFAULT_DENYLIST = [
  '.git',
  '.git/objects',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'credentials',
  'secrets'
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.css': 'CSS',
  '.go': 'Go',
  '.graphql': 'GraphQL',
  '.h': 'C/C++',
  '.hpp': 'C++',
  '.html': 'HTML',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.json': 'JSON',
  '.kt': 'Kotlin',
  '.php': 'PHP',
  '.py': 'Python',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.scss': 'SCSS',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.swift': 'Swift',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.vue': 'Vue'
};

const BINARY_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.bmp',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.eot',
  '.exe',
  '.gif',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.ttf',
  '.wasm',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip'
]);

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

function localIdentityMatches(commit: LocalGitCommit, identity: SourceIdentity | undefined): boolean {
  if (!identity || identity.provider !== 'git') {
    return false;
  }
  const names = new Set((identity.names ?? []).map(normalizedText));
  const emails = new Set((identity.emails ?? []).map(normalizedText));
  const externalId = normalizedText(identity.externalId);
  return names.has(normalizedText(commit.author)) ||
    (commit.authorEmail ? emails.has(normalizedText(commit.authorEmail)) : false) ||
    externalId === normalizedText(commit.author) ||
    (commit.authorEmail ? externalId === normalizedText(commit.authorEmail) : false);
}

function attributionForCommit(
  commit: LocalGitCommit,
  identity: SourceIdentity | undefined
): EvidenceAttribution {
  if (!identity) {
    return 'unknown';
  }
  return localIdentityMatches(commit, identity) ? 'authored' : 'context';
}

function jsonObject(entries: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) {
      continue;
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.filter(
        (item): item is string | number | boolean | null =>
          item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      );
    } else if (typeof value === 'object') {
      result[key] = jsonObject(value as Record<string, unknown>);
    }
  }
  return result;
}

function mergePolicy(
  sourcePolicy: Partial<ScannerPolicy> | undefined,
  requestPolicy: Partial<ScannerPolicy> | undefined,
  contextPolicy: ScannerPolicy | undefined
): ScannerPolicy {
  return {
    maxDepth: requestPolicy?.maxDepth ?? sourcePolicy?.maxDepth ?? contextPolicy?.maxDepth ?? DEFAULT_SCANNER_POLICY.maxDepth,
    maxCommits: requestPolicy?.maxCommits ?? sourcePolicy?.maxCommits ?? contextPolicy?.maxCommits ?? DEFAULT_SCANNER_POLICY.maxCommits,
    maxFiles: requestPolicy?.maxFiles ?? sourcePolicy?.maxFiles ?? contextPolicy?.maxFiles ?? DEFAULT_SCANNER_POLICY.maxFiles,
    allowlist: requestPolicy?.allowlist ?? sourcePolicy?.allowlist ?? contextPolicy?.allowlist ?? DEFAULT_SCANNER_POLICY.allowlist,
    denylist: [
      ...DEFAULT_DENYLIST,
      ...(contextPolicy?.denylist ?? []),
      ...(sourcePolicy?.denylist ?? []),
      ...(requestPolicy?.denylist ?? [])
    ]
  };
}

function matchesPattern(value: string, pattern: string): boolean {
  const normalizedValue = value.replaceAll('\\', '/').toLowerCase();
  const normalizedPattern = pattern.replaceAll('\\', '/').toLowerCase();
  if (!normalizedPattern.includes('*')) {
    return normalizedValue === normalizedPattern || normalizedValue.endsWith(`/${normalizedPattern}`);
  }
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(normalizedValue);
}

function isDeniedPath(relativePath: string, policy: ScannerPolicy): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  return policy.denylist.some((pattern) => {
    const lowerPattern = pattern.toLowerCase();
    return matchesPattern(normalized, lowerPattern) || normalized.split('/').some((part) => matchesPattern(part, lowerPattern));
  });
}

function isAllowedPath(path: string, rootDirectory: string, policy: ScannerPolicy): boolean {
  if (policy.allowlist.length === 0 || path === rootDirectory) {
    return true;
  }
  const relativePath = relative(rootDirectory, path).replaceAll(sep, '/').toLowerCase();
  const normalizedPath = path.replaceAll('\\', '/').toLowerCase();
  return policy.allowlist.some((pattern) => {
    const normalizedPattern = pattern.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '');
    return (
      matchesPattern(relativePath, normalizedPattern) ||
      matchesPattern(normalizedPath, normalizedPattern) ||
      relativePath.startsWith(`${normalizedPattern}/`) ||
      normalizedPath.startsWith(`${normalizedPattern}/`)
    );
  });
}

function isSensitiveFile(relativePath: string, policy: ScannerPolicy): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  const fileName = basename(normalized).toLowerCase();
  if (fileName === '.env' || fileName.startsWith('.env.') || fileName.includes('credential') || fileName.includes('secret')) {
    return true;
  }
  if (isDeniedPath(normalized, policy)) {
    return true;
  }
  return BINARY_EXTENSIONS.has(extname(fileName));
}

async function defaultGitRunner(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${message}`);
  }
}

async function optionalGit(git: GitRunner, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const value = (await git(cwd, args)).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseCommits(serialized: string): LocalGitCommit[] {
  return serialized
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, authorDate, committerDate, author, authorEmail, subject] = record.split('\x1f');
      return {
        hash: hash ?? '',
        ...(stringValue(authorDate) ? { authorDate: stringValue(authorDate) } : {}),
        ...(stringValue(committerDate) ? { committerDate: stringValue(committerDate) } : {}),
        author: stringValue(author) ?? 'Unknown contributor',
        ...(stringValue(authorEmail) ? { authorEmail: stringValue(authorEmail) } : {}),
        subject: stringValue(subject) ?? '(no subject)'
      };
    })
    .filter((commit) => commit.hash.length > 0);
}

function parseContributors(serialized: string): string[] {
  return [
    ...new Set(
      serialized
        .split('\n')
        .map((line) => line.replace(/^\s*\d+\s+/, '').trim())
        .filter(Boolean)
    )
  ].sort((left, right) => left.localeCompare(right));
}

function parseTags(serialized: string): string[] {
  return [...new Set(serialized.split('\n').map((tag) => tag.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function languageForPath(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

async function readProjectMetadata(
  repositoryPath: string,
  policy: ScannerPolicy
): Promise<LocalGitRepositoryScan['projectMetadata']> {
  const packagePath = join(repositoryPath, 'package.json');
  if (isSensitiveFile(relative(repositoryPath, packagePath), policy) || !(await pathExists(packagePath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
    const name = stringValue(parsed.name);
    const description = stringValue(parsed.description);
    return name || description ? { ...(name ? { name } : {}), ...(description ? { description } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

async function readReadme(
  repositoryPath: string,
  policy: ScannerPolicy
): Promise<LocalGitRepositoryScan['readme']> {
  const candidates = ['README.md', 'Readme.md', 'readme.md', 'README'];
  for (const candidate of candidates) {
    const readmePath = join(repositoryPath, candidate);
    if (!(await pathExists(readmePath)) || isSensitiveFile(relative(repositoryPath, readmePath), policy)) {
      continue;
    }
    try {
      const content = (await readFile(readmePath, 'utf8')).slice(0, 4096);
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
      const excerpt = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('```'))[0]
        ?.slice(0, 500);
      return {
        path: relative(repositoryPath, readmePath).replaceAll(sep, '/'),
        ...(title ? { title } : {}),
        ...(excerpt ? { excerpt } : {})
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function listLanguages(
  repositoryPath: string,
  policy: ScannerPolicy,
  git: GitRunner
): Promise<string[]> {
  const serialized = await optionalGit(git, repositoryPath, ['ls-files', '-z']);
  if (!serialized) {
    return [];
  }
  const languages = new Set<string>();
  let inspected = 0;
  for (const file of serialized.split('\0')) {
    if (!file || inspected >= policy.maxFiles || isSensitiveFile(file, policy)) {
      continue;
    }
    inspected += 1;
    const language = languageForPath(file);
    if (language) {
      languages.add(language);
    }
  }
  return [...languages].sort((left, right) => left.localeCompare(right));
}

async function scanRepository(
  repositoryPath: string,
  policy: ScannerPolicy,
  git: GitRunner
): Promise<LocalGitRepositoryScan> {
  const remote = await optionalGit(git, repositoryPath, ['config', '--get', 'remote.origin.url']);
  const currentBranch = await optionalGit(git, repositoryPath, ['branch', '--show-current']);
  const commitLog =
    (await optionalGit(git, repositoryPath, [
      'log',
      '--all',
      '--date=iso-strict',
      `--format=%H%x1f%aI%x1f%cI%x1f%an%x1f%ae%x1f%s%x1e`,
      '-n',
      String(policy.maxCommits)
    ])) ?? '';
  const commits = parseCommits(commitLog);
  const dates = commits
    .flatMap((commit) => [commit.authorDate, commit.committerDate].filter((date): date is string => Boolean(date)))
    .sort((left, right) => left.localeCompare(right));
  const contributors = parseContributors(
    (await optionalGit(git, repositoryPath, ['shortlog', '-sne', '--all'])) ?? ''
  );
  const tags = parseTags((await optionalGit(git, repositoryPath, ['tag', '--sort=creatordate'])) ?? '');
  const languages = await listLanguages(repositoryPath, policy, git);
  const readme = await readReadme(repositoryPath, policy);
  const projectMetadata = await readProjectMetadata(repositoryPath, policy);
  return {
    path: repositoryPath,
    name: basename(repositoryPath),
    ...(remote ? { remote } : {}),
    ...(currentBranch ? { currentBranch } : {}),
    commits,
    ...(dates[0] ? { firstActivity: dates[0] } : {}),
    ...(dates.at(-1) ? { lastActivity: dates.at(-1) } : {}),
    contributors,
    languages,
    tags,
    ...(readme ? { readme } : {}),
    ...(projectMetadata ? { projectMetadata } : {})
  };
}

export class LocalGitSource
  implements CareerSource<LocalGitRequest, LocalGitDiscovery, LocalGitScanResult>
{
  readonly sourceType = 'local-git' as const;

  private readonly sourcePolicy: Partial<ScannerPolicy>;
  private readonly identity?: SourceIdentity;
  private readonly git: GitRunner;

  constructor(options: LocalGitSourceOptions = {}) {
    this.sourcePolicy = options.policy ?? {};
    this.identity = options.identity;
    this.git = options.gitRunner ?? defaultGitRunner;
  }

  private async discoverDirectories(rootDirectory: string, policy: ScannerPolicy): Promise<string[]> {
    const repositories: string[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: rootDirectory, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || !isAllowedPath(current.path, rootDirectory, policy)) {
        continue;
      }
      const topLevel = await optionalGit(this.git, current.path, ['rev-parse', '--show-toplevel']);
      if (topLevel) {
        repositories.push(resolve(topLevel));
        continue;
      }
      if (current.depth >= policy.maxDepth) {
        continue;
      }
      let entries;
      try {
        entries = await readdir(current.path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const child = join(current.path, entry.name);
        const relativeChild = relative(rootDirectory, child).replaceAll(sep, '/');
        if (isDeniedPath(relativeChild, policy) || !isAllowedPath(child, rootDirectory, policy)) {
          continue;
        }
        queue.push({ path: child, depth: current.depth + 1 });
      }
    }
    return [...new Set(repositories)].sort((left, right) => left.localeCompare(right));
  }

  async discover(request: LocalGitRequest, context: SourceRunContext): Promise<LocalGitDiscovery> {
    const rootDirectory = resolve(request.directory);
    const directoryStats = await stat(rootDirectory);
    if (!directoryStats.isDirectory()) {
      throw new Error(`Local Git scan path is not a directory: ${request.directory}`);
    }
    const policy = mergePolicy(this.sourcePolicy, request.policy, context.scanner);
    const repositories = await this.discoverDirectories(rootDirectory, policy);
    return { rootDirectory, repositories, policy };
  }

  async scan(discovery: LocalGitDiscovery, _context?: SourceRunContext): Promise<LocalGitScanResult> {
    const repositories: LocalGitRepositoryScan[] = [];
    for (const repositoryPath of discovery.repositories) {
      repositories.push(await scanRepository(repositoryPath, discovery.policy, this.git));
    }
    return { repositories };
  }

  async extractEvidence(
    scan: LocalGitScanResult,
    context: SourceRunContext
  ): Promise<CareerEvidence[]> {
    const evidence: CareerEvidence[] = [];
    const identity = context.identity?.sources.find((item) => item.provider === 'git') ?? this.identity;
    for (const repository of scan.repositories) {
      const authoredCommits = repository.commits.filter((commit) => localIdentityMatches(commit, identity));
      const repositoryAttribution: EvidenceAttribution = authoredCommits.length > 0
        ? 'contributed'
        : identity
          ? 'context'
          : 'unknown';
      const remote = repository.remote;
      const sourceId = remote ? `${repository.name}:${remote}` : `path:${repository.path}`;
      const sourceUri = remote ?? pathToFileURL(repository.path).toString();
      const readme = repository.readme;
      const projectMetadata = repository.projectMetadata;
      const description = projectMetadata?.description ?? readme?.excerpt;
      evidence.push({
        id: createEvidenceId(this.sourceType, sourceId, 'local-repository'),
        sourceType: this.sourceType,
        sourceId,
        evidenceType: 'local-repository',
        raw: jsonObject({
          path: repository.path,
          name: repository.name,
          remote,
          currentBranch: repository.currentBranch,
          firstActivity: repository.firstActivity,
          lastActivity: repository.lastActivity,
          contributors: repository.contributors,
          languages: repository.languages,
          tags: repository.tags,
          readme,
          projectMetadata,
          attribution: repositoryAttribution
        }),
        normalized: jsonObject({
          canonicalName: repository.name,
          name: repository.name,
          ...(projectMetadata?.name ? { projectMetadataName: projectMetadata.name } : {}),
          description,
          repositoryUrl: remote,
          remote,
          currentBranch: repository.currentBranch,
          firstActivity: repository.firstActivity,
          lastActivity: repository.lastActivity,
          contributors: repository.contributors,
          languages: repository.languages,
          tags: repository.tags,
          localPath: repository.path,
          skills: repository.languages,
          attribution: repositoryAttribution,
          authoredActivityCount: authoredCommits.length
        }),
        attribution: repositoryAttribution,
        sourceUri,
        observedAt: repository.lastActivity,
        discoveredAt: context.now
      });

      for (const tag of repository.tags) {
        const tagSourceId = `${sourceId}:tag:${tag}`;
        evidence.push({
          id: createEvidenceId(this.sourceType, tagSourceId, 'tag'),
          sourceType: this.sourceType,
          sourceId: tagSourceId,
          evidenceType: 'tag',
          raw: { repository: repository.path, tag },
          normalized: { repository: repository.name, tag },
          sourceUri,
          discoveredAt: context.now
        });
      }

      for (const commit of repository.commits) {
        const commitSourceId = `${sourceId}:commit:${commit.hash}`;
        evidence.push({
          id: createEvidenceId(this.sourceType, commitSourceId, 'commit'),
          sourceType: this.sourceType,
          sourceId: commitSourceId,
          evidenceType: 'commit',
          raw: {
            repository: repository.path,
            hash: commit.hash,
            ...(commit.authorDate ? { authorDate: commit.authorDate } : {}),
            ...(commit.committerDate ? { committerDate: commit.committerDate } : {}),
            author: commit.author,
            ...(commit.authorEmail ? { authorEmail: commit.authorEmail } : {}),
            subject: commit.subject
          },
          normalized: {
            repository: repository.name,
            hash: commit.hash,
            summary: commit.subject,
            author: commit.author,
            ...(commit.authorEmail ? { authorEmail: commit.authorEmail } : {}),
            attribution: attributionForCommit(commit, identity)
          },
          attribution: attributionForCommit(commit, identity),
          sourceUri,
          observedAt: commit.committerDate ?? commit.authorDate,
          discoveredAt: context.now
        });
      }
    }
    return evidence;
  }
}

/** Synthetic local evidence used to prove cross-source corroboration in the demo. */
export function createAliceLocalGitFixtureEvidence(
  discoveredAt = '2025-01-15T00:00:00.000Z'
): CareerEvidence[] {
  const sourceId = 'data-lineage-toolkit:git@github.com:alice/data-lineage-toolkit.git';
  const remote = 'git@github.com:alice/data-lineage-toolkit.git';
  return [
    {
      id: createEvidenceId('local-git', sourceId, 'local-repository'),
      sourceType: 'local-git',
      sourceId,
      evidenceType: 'local-repository',
      raw: {
        path: 'C:/Users/alice/work/data-lineage-toolkit',
        name: 'data-lineage-toolkit',
        remote,
        currentBranch: 'main',
        firstActivity: '2024-02-01T08:00:00.000Z',
        lastActivity: '2025-01-14T12:00:00.000Z',
        contributors: ['Alice Example', 'Bob Example'],
        languages: ['Python', 'TypeScript'],
        tags: ['v1.0.0'],
        attribution: 'owned'
      },
      attribution: 'owned',
      normalized: {
        canonicalName: 'data-lineage-toolkit',
        name: 'data-lineage-toolkit',
        description: 'Local repository metadata corroborating the lineage platform project.',
        repositoryUrl: 'https://github.com/alice/data-lineage-toolkit',
        remote,
        currentBranch: 'main',
        firstActivity: '2024-02-01T08:00:00.000Z',
        lastActivity: '2025-01-14T12:00:00.000Z',
        contributors: ['Alice Example', 'Bob Example'],
        languages: ['Python', 'TypeScript'],
        tags: ['v1.0.0'],
        localPath: 'C:/Users/alice/work/data-lineage-toolkit',
        skills: ['Python', 'TypeScript'],
        attribution: 'owned'
      },
      sourceUri: 'https://github.com/alice/data-lineage-toolkit',
      observedAt: '2025-01-14T12:00:00.000Z',
      discoveredAt
    }
  ];
}
