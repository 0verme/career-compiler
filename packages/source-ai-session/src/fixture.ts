import type { CareerEvidence, SourceRunContext } from '@career-compiler/core';
import { aiSessionsToEvidence } from './evidence.js';
import { createStableId } from '@career-compiler/core';
import type { AiSessionBundle, NormalizedAiSession } from './types.js';

export const ALICE_AI_SESSION_FIXTURE_NOW = '2025-01-15T00:00:00.000Z';
export const ALICE_AI_SESSION_PROJECT_KEY = 'remote:github.com/alice/data-lineage-toolkit';

const SOURCE_PROJECT = {
  projectId: 'project_9f1d2c3b4a5e6f70',
  projectKey: ALICE_AI_SESSION_PROJECT_KEY,
  projectName: 'data-lineage-toolkit',
  repoPath: '/home/alice/work/data-lineage-toolkit',
  repoUrl: 'https://github.com/alice/data-lineage-toolkit',
  metadata: { gitCommonDir: '/home/alice/work/data-lineage-toolkit/.git' }
} as const;

const CODEX_SESSION: NormalizedAiSession = {
  source: 'codex',
  sessionId: 'codex-2025-01-12-lineage-registry',
  project: { ...SOURCE_PROJECT },
  startedAt: '2025-01-12T09:00:00.000Z',
  endedAt: '2025-01-12T09:02:30.000Z',
  models: ['gpt-5-codex'],
  toolNames: ['apply_patch', 'shell'],
  messages: [
    {
      id: 'codex-msg-001',
      role: 'user',
      text: '在 data-lineage-toolkit 里新增 contract registry，先实现 schema 校验和 owner 字段。',
      timestamp: '2025-01-12T09:00:00.000Z',
      sourceRef: {
        source: 'codex',
        sourceSessionId: 'codex-2025-01-12-lineage-registry',
        occurredAt: '2025-01-12T09:00:00.000Z',
        sourcePath: '/home/alice/.codex/sessions/2025/01/12/rollout-2025-01-12T09-00-00-lineage-registry.jsonl',
        lineStart: 4,
        lineEnd: 4
      }
    },
    {
      id: 'codex-msg-002',
      role: 'assistant',
      text: '我会先阅读现有的 ingestion contract，再添加 registry 模块和单元测试。',
      timestamp: '2025-01-12T09:00:30.000Z',
      model: 'gpt-5-codex',
      sourceRef: {
        source: 'codex',
        sourceSessionId: 'codex-2025-01-12-lineage-registry',
        occurredAt: '2025-01-12T09:00:30.000Z',
        sourcePath: '/home/alice/.codex/sessions/2025/01/12/rollout-2025-01-12T09-00-00-lineage-registry.jsonl',
        lineStart: 5,
        lineEnd: 5
      }
    },
    {
      id: 'codex-call-001',
      role: 'assistant',
      timestamp: '2025-01-12T09:01:00.000Z',
      model: 'gpt-5-codex',
      toolCalls: [
        {
          id: 'call-001',
          name: 'shell',
          arguments: { command: 'pnpm test -- contract' }
        }
      ],
      sourceRef: {
        source: 'codex',
        sourceSessionId: 'codex-2025-01-12-lineage-registry',
        occurredAt: '2025-01-12T09:01:00.000Z',
        sourcePath: '/home/alice/.codex/sessions/2025/01/12/rollout-2025-01-12T09-00-00-lineage-registry.jsonl',
        lineStart: 6,
        lineEnd: 6
      }
    },
    {
      id: 'codex-msg-003',
      role: 'user',
      text: '下一步：把 registry 接到 lineage graph service，并补一个回归测试。',
      timestamp: '2025-01-12T09:02:00.000Z',
      sourceRef: {
        source: 'codex',
        sourceSessionId: 'codex-2025-01-12-lineage-registry',
        occurredAt: '2025-01-12T09:02:00.000Z',
        sourcePath: '/home/alice/.codex/sessions/2025/01/12/rollout-2025-01-12T09-00-00-lineage-registry.jsonl',
        lineStart: 7,
        lineEnd: 7
      }
    },
    {
      id: 'codex-call-002',
      role: 'assistant',
      timestamp: '2025-01-12T09:02:30.000Z',
      model: 'gpt-5-codex',
      toolCalls: [
        {
          id: 'call-002',
          name: 'apply_patch',
          arguments: { path: 'packages/core/registry.ts' }
        }
      ],
      sourceRef: {
        source: 'codex',
        sourceSessionId: 'codex-2025-01-12-lineage-registry',
        occurredAt: '2025-01-12T09:02:30.000Z',
        sourcePath: '/home/alice/.codex/sessions/2025/01/12/rollout-2025-01-12T09-00-00-lineage-registry.jsonl',
        lineStart: 8,
        lineEnd: 8
      }
    }
  ]
};

const PI_SESSION: NormalizedAiSession = {
  source: 'pi',
  sessionId: 'pi-2025-01-13-lineage-worktree',
  project: {
    ...SOURCE_PROJECT,
    worktreePath: '/home/alice/work/data-lineage-toolkit-wt-42'
  },
  startedAt: '2025-01-13T10:00:00.000Z',
  endedAt: '2025-01-13T10:01:30.000Z',
  models: ['claude-sonnet-4'],
  toolNames: ['edit', 'read'],
  messages: [
    {
      id: 'pi-msg-001',
      role: 'user',
      text: '在 worktree 里继续 lineage graph 的 contract 接入，保持 registry schema 不变。',
      timestamp: '2025-01-13T10:00:00.000Z',
      sourceRef: {
        source: 'pi',
        sourceSessionId: 'pi-2025-01-13-lineage-worktree',
        occurredAt: '2025-01-13T10:00:00.000Z',
        sourcePath:
          '/home/alice/.pi/agent/sessions/--home-alice-work-data-lineage-toolkit-wt-42--/2025-01-13T10-00-00-000Z_pi.jsonl',
        lineStart: 1,
        lineEnd: 1
      }
    },
    {
      id: 'pi-msg-002',
      role: 'assistant',
      text: '我会复用上个 session 的 schema，只调整 adapter 层。',
      timestamp: '2025-01-13T10:00:30.000Z',
      model: 'claude-sonnet-4',
      sourceRef: {
        source: 'pi',
        sourceSessionId: 'pi-2025-01-13-lineage-worktree',
        occurredAt: '2025-01-13T10:00:30.000Z',
        sourcePath:
          '/home/alice/.pi/agent/sessions/--home-alice-work-data-lineage-toolkit-wt-42--/2025-01-13T10-00-00-000Z_pi.jsonl',
        lineStart: 2,
        lineEnd: 2
      }
    },
    {
      id: 'pi-call-001',
      role: 'assistant',
      timestamp: '2025-01-13T10:01:00.000Z',
      model: 'claude-sonnet-4',
      toolCalls: [
        {
          id: 'tool-2',
          name: 'read',
          arguments: { path: 'packages/core/registry.ts' }
        }
      ],
      sourceRef: {
        source: 'pi',
        sourceSessionId: 'pi-2025-01-13-lineage-worktree',
        occurredAt: '2025-01-13T10:01:00.000Z',
        sourcePath:
          '/home/alice/.pi/agent/sessions/--home-alice-work-data-lineage-toolkit-wt-42--/2025-01-13T10-00-00-000Z_pi.jsonl',
        lineStart: 3,
        lineEnd: 3
      }
    },
    {
      id: 'pi-msg-003',
      role: 'user',
      text: '顺便把 onboarding 时间从六周降到一周的指标写进 docs。',
      timestamp: '2025-01-13T10:01:20.000Z',
      sourceRef: {
        source: 'pi',
        sourceSessionId: 'pi-2025-01-13-lineage-worktree',
        occurredAt: '2025-01-13T10:01:20.000Z',
        sourcePath:
          '/home/alice/.pi/agent/sessions/--home-alice-work-data-lineage-toolkit-wt-42--/2025-01-13T10-00-00-000Z_pi.jsonl',
        lineStart: 4,
        lineEnd: 4
      }
    },
    {
      id: 'pi-call-002',
      role: 'assistant',
      timestamp: '2025-01-13T10:01:30.000Z',
      model: 'claude-sonnet-4',
      toolCalls: [
        {
          id: 'tool-3',
          name: 'edit',
          arguments: { path: 'docs/lineage-onboarding.md' }
        }
      ],
      sourceRef: {
        source: 'pi',
        sourceSessionId: 'pi-2025-01-13-lineage-worktree',
        occurredAt: '2025-01-13T10:01:30.000Z',
        sourcePath:
          '/home/alice/.pi/agent/sessions/--home-alice-work-data-lineage-toolkit-wt-42--/2025-01-13T10-00-00-000Z_pi.jsonl',
        lineStart: 5,
        lineEnd: 5
      }
    }
  ]
};

/** Synthetic, anonymous AI session bundle: one project, two local AI sessions. */
export function createAliceAiSessionBundle(): AiSessionBundle {
  return {
    schemaVersion: 'ai-session-bundle/1',
    generatedAt: ALICE_AI_SESSION_FIXTURE_NOW,
    sessions: [structuredClone(CODEX_SESSION), structuredClone(PI_SESSION)]
  };
}

/** JSONL form of the same fixture: one normalized session per line. */
export function createAliceAiSessionJsonl(): string {
  return createAliceAiSessionBundle()
    .sessions.map((session) => JSON.stringify(session))
    .join('\n');
}

/** Canonical Career Compiler project id the fixture is expected to resolve to. */
export function aliceAiSessionProjectId(): string {
  return createStableId('aiproject', ALICE_AI_SESSION_PROJECT_KEY);
}

export function createAliceAiSessionFixtureEvidence(
  discoveredAt = ALICE_AI_SESSION_FIXTURE_NOW
): CareerEvidence[] {
  const context: SourceRunContext = { now: discoveredAt };
  return aiSessionsToEvidence(createAliceAiSessionBundle().sessions, context);
}
