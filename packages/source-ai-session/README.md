# `@career-compiler/source-ai-session`

把已经归一化的本地 AI session（Codex CLI / Claude Code / Pi）转换成 `CareerEvidence` 的 CareerSource adapter。

本 package **不解析 vendor JSONL**、**不扫描磁盘**、**不依赖 `aiusage` CLI 或其私有 workspace package**：session 发现、vendor format 解析、project / Git worktree 归一化仍然由 AIUsage 侧负责，输入边界是一个与 AIUsage `NormalizedSession` 结构兼容的 normalized session contract。

```text
Codex / Claude Code / Pi
        ↓  (AIUsage 负责)
NormalizedSession（JSON / JSONL contract）
        ↓  (本 adapter 负责)
CareerEvidence（session 级 + message 级）
        ↓  用户确认（本轮不做）
candidate CareerFact → CareerAchievement
```

## 输入 contract

`AiSessionBundle`（`schemaVersion: "ai-session-bundle/1"`）或直接传入 `sessions` / `NormalizedAiSession[]`：

```ts
interface NormalizedAiSession {
  source: string; // "codex" | "claude-code" | "pi" | ...
  sessionId: string;
  project: {
    projectId?: string;
    projectKey?: string;        // AIUsage 形式：remote: / git: / path:
    projectName?: string;
    repoPath?: string;
    repoUrl?: string;
    worktreePath?: string;
    metadata?: { gitCommonDir?: string };
  };
  startedAt: string;
  endedAt: string;
  models?: string[];
  toolNames?: string[];
  messages: AiSessionMessage[]; // text / toolCalls / sourceRef
}
```

字段与 AIUsage `packages/memory-core/src/types.ts` 中的 `NormalizedSession` / `ProjectIdentity` / `MemorySourceReference` 保持结构兼容；本 package 只消费这份 contract，不 import `@aiusage/memory-core`（该 package 目前 `private` 且只导出 `src/index.ts`，跨 repo 不可用）。

## 输出 evidence

每个 session 产生：

- 1 条 `evidenceType: "ai-session"` 的 session 级证据；
- 每条 message 1 条 `evidenceType: "ai-session-message"` 的证据（tool call metadata 挂在 message 上）。

`normalized.sourceRef` 保留：

```text
source / sourceSessionId / occurredAt / sourcePath / sourcePathHash / lineStart / lineEnd
```

`lineStart` / `lineEnd` 放在 `normalized` metadata 中，因此不需要修改 `packages/core` 的 `CareerEvidence` schema。

## Privacy

- local-first：只读取调用方显式传入的 bundle / 文件，不遍历磁盘，不读取 auth / secrets 文件；
- 默认 `sourcePath: "relative"`：evidence 不写绝对路径，只保留 `sessions/...` 相对后缀与不可逆 `sourcePathHash`；需要完整本地路径时可显式 `sourcePath: "absolute"`；
- 默认不写 tool arguments（可能包含 credentials）；需要时显式 `includeToolArguments: true`；
- repo / worktree 绝对路径不会进入 evidence，只保留 canonical `projectId`、`projectName`、可选 `repoUrl` 与 `isWorktree`；
- IR export 会包含 evidence 本体，因此把它当作本地/私有文档；renderer 只读取 `CareerIR.profile`，不会输出 evidence path。

## Candidate boundary

`attribution` 统一为 `context`：本地 session 目前没有与 Career Identity 的可靠绑定，adapter 不声称“用户掌握某技能/负责某项目”。本 package 只输出 `CareerEvidence`，不生成 candidate fact、不会 confirm、不会进入 `CareerAchievement` 或 Resume。

## 使用

```ts
import { AiSessionSource } from '@career-compiler/source-ai-session';

const source = new AiSessionSource();
const context = { now: new Date().toISOString() };
const discovery = await source.discover({ filePath: 'normalized-sessions.jsonl' }, context);
const scan = await source.scan(discovery, context);
const evidence = await source.extractEvidence(scan, context);
```
