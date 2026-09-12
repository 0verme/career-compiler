import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  CareerIdentity,
  ScannerPolicy,
  SourceIdentity
} from '@career-compiler/core';
import { DEFAULT_SCANNER_POLICY } from '@career-compiler/core';
import { getDefaultDataDirectory } from '@career-compiler/storage';

export interface CareerCompilerConfig {
  dataDir?: string;
  profile?: {
    id?: string;
    displayName?: string;
    headline?: string;
    about?: string;
  };
  github?: {
    /** Legacy location; prefer identity.githubUsername. */
    username?: string;
    tokenEnv?: string;
    apiBaseUrl?: string;
    maxRepositories?: number;
    maxActivityItems?: number;
    maxExternalContributions?: number;
  };
  identity?: {
    githubUsername?: string;
    git?: {
      authorNames?: string[];
      authorEmails?: string[];
    };
  };
  scanner?: Partial<ScannerPolicy>;
}

export interface LoadedConfig {
  config: CareerCompilerConfig;
  path?: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return values.length > 0 ? [...new Set(values.map((item) => item.trim()))] : [];
}

function parseConfig(value: unknown): CareerCompilerConfig {
  const root = objectValue(value) ?? {};
  const profile = objectValue(root.profile);
  const github = objectValue(root.github);
  const identity = objectValue(root.identity);
  const gitIdentity = objectValue(identity?.git);
  const githubUsername = stringValue(identity?.githubUsername) ?? stringValue(github?.username);
  const authorNames = stringArray(gitIdentity?.authorNames);
  const authorEmails = stringArray(gitIdentity?.authorEmails);
  const scanner = objectValue(root.scanner);
  return {
    ...(stringValue(root.dataDir) ? { dataDir: stringValue(root.dataDir) } : {}),
    ...(profile
      ? {
          profile: {
            ...(stringValue(profile.id) ? { id: stringValue(profile.id) } : {}),
            ...(stringValue(profile.displayName) ? { displayName: stringValue(profile.displayName) } : {}),
            ...(stringValue(profile.headline) ? { headline: stringValue(profile.headline) } : {}),
            ...(stringValue(profile.about) ? { about: stringValue(profile.about) } : {})
          }
        }
      : {}),
    ...(github
      ? {
          github: {
            ...(githubUsername ? { username: githubUsername } : {}),
            ...(stringValue(github.tokenEnv) ? { tokenEnv: stringValue(github.tokenEnv) } : {}),
            ...(stringValue(github.apiBaseUrl) ? { apiBaseUrl: stringValue(github.apiBaseUrl) } : {}),
            ...(positiveInteger(github.maxRepositories)
              ? { maxRepositories: positiveInteger(github.maxRepositories) }
              : {}),
            ...(positiveInteger(github.maxActivityItems)
              ? { maxActivityItems: positiveInteger(github.maxActivityItems) }
              : {}),
            ...(nonNegativeInteger(github.maxExternalContributions) !== undefined
              ? { maxExternalContributions: nonNegativeInteger(github.maxExternalContributions) }
              : {})
          }
        }
      : {}),
    ...(githubUsername || authorNames !== undefined || authorEmails !== undefined
      ? {
          identity: {
            ...(githubUsername ? { githubUsername } : {}),
            ...(authorNames !== undefined || authorEmails !== undefined
              ? {
                  git: {
                    ...(authorNames !== undefined ? { authorNames } : {}),
                    ...(authorEmails !== undefined ? { authorEmails } : {})
                  }
                }
              : {})
          }
        }
      : {}),
    ...(scanner
      ? {
          scanner: {
            ...(positiveInteger(scanner.maxDepth) ? { maxDepth: positiveInteger(scanner.maxDepth) } : {}),
            ...(positiveInteger(scanner.maxCommits) ? { maxCommits: positiveInteger(scanner.maxCommits) } : {}),
            ...(positiveInteger(scanner.maxFiles) ? { maxFiles: positiveInteger(scanner.maxFiles) } : {}),
            ...(Array.isArray(scanner.allowlist)
              ? { allowlist: scanner.allowlist.filter((item): item is string => typeof item === 'string') }
              : {}),
            ...(Array.isArray(scanner.denylist)
              ? { denylist: scanner.denylist.filter((item): item is string => typeof item === 'string') }
              : {})
          }
        }
      : {})
  };
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Continue until all configured locations have been checked.
    }
  }
  return undefined;
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [
        resolve('career-compiler.config.json'),
        join(homedir(), '.career-compiler', 'config.json'),
        join(getDefaultDataDirectory(), 'config.json')
      ];
  const path = await firstExisting(candidates);
  if (!path) {
    return { config: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read config ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { config: parseConfig(parsed), path };
}

export function resolveDataDirectory(
  config: CareerCompilerConfig,
  cliDataDirectory?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return resolve(cliDataDirectory ?? env.CAREER_COMPILER_DATA_DIR ?? config.dataDir ?? getDefaultDataDirectory(env));
}

export function scannerPolicy(config: CareerCompilerConfig): ScannerPolicy {
  return {
    ...DEFAULT_SCANNER_POLICY,
    ...config.scanner,
    allowlist: config.scanner?.allowlist ?? DEFAULT_SCANNER_POLICY.allowlist,
    denylist: config.scanner?.denylist ?? DEFAULT_SCANNER_POLICY.denylist
  };
}

export function careerIdentity(config: CareerCompilerConfig): CareerIdentity | undefined {
  const sources: SourceIdentity[] = [];
  const githubUsername = config.identity?.githubUsername ?? config.github?.username;
  if (githubUsername) {
    sources.push({ provider: 'github', externalId: githubUsername, username: githubUsername });
  }
  const names = config.identity?.git?.authorNames ?? [];
  const emails = config.identity?.git?.authorEmails ?? [];
  if (names.length > 0 || emails.length > 0) {
    sources.push({
      provider: 'git',
      externalId: emails[0] ?? names[0] ?? 'configured-git',
      ...(names.length > 0 ? { names } : {}),
      ...(emails.length > 0 ? { emails } : {})
    });
  }
  return sources.length > 0 ? { sources } : undefined;
}

export function profileSeed(config: CareerCompilerConfig) {
  const identity = careerIdentity(config);
  return {
    id: config.profile?.id ?? 'default',
    displayName: config.profile?.displayName ?? 'Career Profile',
    ...(config.profile?.headline ? { headline: config.profile.headline } : {}),
    ...(config.profile?.about ? { about: config.profile.about } : {}),
    ...(identity ? { identity } : {})
  };
}
