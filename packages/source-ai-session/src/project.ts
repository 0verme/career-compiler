import { createStableId } from '@career-compiler/core';
import type { AiSessionProject } from './types.js';

export type AiSessionProjectIdentityBasis =
  | 'remote'
  | 'git-common-dir'
  | 'repository-path'
  | 'upstream-key'
  | 'unknown';

export interface CanonicalAiSessionProject {
  projectId: string;
  projectName: string;
  identityBasis: AiSessionProjectIdentityBasis;
  /** Present only when the upstream identity had a remote origin. */
  repoUrl?: string;
  /** Present when the session ran inside a linked Git worktree. */
  isWorktree?: boolean;
  /** Upstream AIUsage project id, kept for cross-referencing. */
  upstreamProjectId?: string;
}

interface ProjectKey {
  key: string;
  basis: AiSessionProjectIdentityBasis;
}

function normalizeRemote(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  // git@github.com:owner/repo.git -> github.com/owner/repo
  const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !raw.includes('://')) {
    const host = scp[1]!.toLowerCase();
    const path = normalizeRemotePath(scp[2]!);
    return path ? `${host}/${path}` : undefined;
  }
  try {
    const parsed = new URL(raw);
    const path = normalizeRemotePath(parsed.pathname);
    return path ? `${parsed.hostname.toLowerCase()}/${path}` : undefined;
  } catch {
    const path = normalizeRemotePath(raw.replace(/^git\+/, ''));
    return path.includes('/') ? path : undefined;
  }
}

function normalizeRemotePath(value: string): string {
  return value
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replaceAll('\\', '/');
}

/** Normalize local paths for identity comparison across Windows and POSIX. */
export function normalizeProjectPath(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  const replaced = raw.replaceAll('\\', '/');
  const prefix = replaced.match(/^[A-Za-z]:/)?.[0]?.toLowerCase() ?? '';
  const hasRoot = replaced.startsWith('/') || Boolean(prefix);
  const body = prefix ? replaced.slice(2) : replaced;
  const segments: string[] = [];
  for (const segment of body.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') {
      segments.pop();
    } else if (segment !== '..') {
      segments.push(segment);
    }
  }
  const path = segments.join('/');
  if (prefix) {
    return `${prefix}/${path}`.replace(/\/$/, '');
  }
  if (hasRoot) {
    return `/${path}`.replace(/\/$/, '') || '/';
  }
  return path || '.';
}

function normalizeUpstreamKey(value: string): string {
  if (value.startsWith('remote:')) {
    const remote = normalizeRemote(value.slice('remote:'.length));
    return remote ? `remote:${remote}` : value;
  }
  if (value.startsWith('git:')) {
    return `git:${normalizeProjectPath(value.slice('git:'.length)) ?? value.slice('git:'.length)}`;
  }
  if (value.startsWith('path:')) {
    return `path:${normalizeProjectPath(value.slice('path:'.length)) ?? value.slice('path:'.length)}`;
  }
  return value;
}

export function canonicalizeAiSessionProject(
  project: AiSessionProject | undefined
): CanonicalAiSessionProject {
  const projectKey = project?.projectKey?.trim();
  const remote =
    normalizeRemote(project?.repoUrl) ??
    (projectKey?.startsWith('remote:')
      ? normalizeRemote(projectKey.slice('remote:'.length))
      : undefined);
  const commonDir = stringMetadata(project?.metadata, 'gitCommonDir') ??
    (projectKey?.startsWith('git:') ? projectKey.slice('git:'.length) : undefined);
  const repositoryPath =
    project?.repoPath ?? (projectKey?.startsWith('path:') ? projectKey.slice('path:'.length) : undefined);

  let candidate: ProjectKey;
  if (remote) {
    candidate = { key: `remote:${remote}`, basis: 'remote' };
  } else if (commonDir) {
    candidate = { key: `git:${normalizeProjectPath(commonDir) ?? commonDir}`, basis: 'git-common-dir' };
  } else if (repositoryPath) {
    candidate = {
      key: `path:${normalizeProjectPath(repositoryPath) ?? repositoryPath}`,
      basis: 'repository-path'
    };
  } else if (projectKey) {
    candidate = { key: normalizeUpstreamKey(projectKey), basis: 'upstream-key' };
  } else if (project?.projectId?.trim()) {
    candidate = { key: `upstream:${project.projectId.trim()}`, basis: 'upstream-key' };
  } else {
    candidate = { key: 'unknown', basis: 'unknown' };
  }

  const projectName =
    project?.projectName?.trim() ||
    basename(project?.repoPath ?? project?.worktreePath) ||
    remote?.split('/').filter(Boolean).at(-1) ||
    'unknown';

  return {
    projectId: createStableId('aiproject', candidate.key),
    projectName,
    identityBasis: candidate.basis,
    ...(project?.repoUrl?.trim() ? { repoUrl: project.repoUrl.trim() } : {}),
    ...(project?.worktreePath?.trim() ? { isWorktree: true } : {}),
    ...(project?.projectId?.trim() ? { upstreamProjectId: project.projectId.trim() } : {})
  };
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function basename(value: string | undefined): string | undefined {
  const path = value?.replaceAll('\\', '/').replace(/\/+$/, '');
  const name = path?.split('/').filter(Boolean).at(-1);
  return name || undefined;
}
