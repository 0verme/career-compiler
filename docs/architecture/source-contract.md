# Source Contract

## 稳定接口

Core 定义：

```ts
interface CareerSource<TRequest, TDiscovery = unknown, TScan = unknown> {
  readonly sourceType: SourceType;
  discover(request: TRequest, context: SourceRunContext): Promise<TDiscovery>;
  scan(discovery: TDiscovery, context: SourceRunContext): Promise<TScan>;
  extractEvidence(scan: TScan, context: SourceRunContext): Promise<CareerEvidence[]>;
}
```

三个阶段刻意分开：

- `discover`：根据用户请求找到目标，不产生职业结论。
- `scan`：访问 API 或本地 metadata，得到 source-specific scan result。
- `extractEvidence`：把 scan result 转换为稳定的 `CareerEvidence`，保存 raw/normalized provenance 与 attribution。

`SourceRunContext.identity` 提供当前 Career Identity。Source 必须先判断“谁的贡献”，再把观察保存为 evidence；没有可靠归因时使用 `context` 或 `unknown`，不能为了 recall 猜测 authored。

Source 可以有自己的 request/scan types，但返回的 Evidence 必须通过 Core validation。

## V0.1 adapters

### GitHub

`GitHubSource` 使用原生 `fetch` 调 REST API，可注入 `fetchImpl` 做测试。支持 user 与 `owner/name` repository 请求，提取：

- profile metadata
- repository description/default branch/topics/languages
- commit metadata
- issue metadata
- pull request metadata，包括 author、created/updated/merged timestamps、state 和 merge 状态
- 有限的 external authored PR discovery（GitHub Search API `author:<username> type:pr`）
- `owned` / `authored` / `context` attribution，以及 fork 和 `externalContribution` 语义

repository 是 project context，不等于用户贡献。非 fork owned repository 只产生保守的 `Maintains` / `Works on` candidate；fork 默认 context-only。它不会把 commit、PR、star、fork 或 activity count 当作能力评级，也不会把 GitHub activity 自动写成 confirmed fact。

### Local Git

`LocalGitSource` 只接受用户显式传入的目录。它通过 Git 命令读取 remote、branch、有限 commit history metadata、contributors、tags，并以 tracked file path 的 extension 推断语言；不会读取源码内容。README 只抽取受限 title/excerpt，`package.json` 只抽取 name/description。

Local Git 通过 `SourceRunContext.identity` 中的 `git.authorNames` / `git.authorEmails` 预留身份匹配：匹配的 commit 标记 `authored`，未匹配的 commit 标记 `context`；没有配置 identity 时为 `unknown`，不会默认把本地 repository 归给用户。

Scanner policy 支持：

- `allowlist`
- `denylist`
- `maxDepth`
- `maxCommits`
- `maxFiles`

默认排除 secrets、credentials、`.env`、`.git`/objects、依赖、build/cache 和 binary。allowlist/denylist 是 scanner 层策略，不是 AI prompt。

### Manual / Chat

`ManualChatSource` 将用户输入保存为 conversation Evidence。`DeterministicFactExtractor` 是无外部服务的 V0.1 fallback；它只返回可验证 schema 的 candidates。未来的 `ProviderFactExtractor` 通过 `AIProvider` 接入任何 OpenAI-compatible、Gemini、Claude、DeepSeek 或 local model，但 provider 输出必须先经过 `validateFactExtractionOutput`。

### AI Session

`AiSessionSource` 消费 AIUsage 已经归一化的本地 AI session contract（`ai-session-bundle/1`），**不重新实现** Codex / Claude Code / Pi JSONL parser：

- 输入：`NormalizedAiSession` bundle（JSON 或 JSONL），包含 messages、tool calls、`ProjectIdentity` 与 `sourceRef`；
- 输出：每个 session 一条 `ai-session` evidence，每条 message 一条 `ai-session-message` evidence，tool call metadata 挂在 message 上；
- Provenance：`source` / `sourceSessionId` / `occurredAt` / `sourcePath` / `sourcePathHash` / `lineStart` / `lineEnd` 保存在 `normalized.sourceRef`，不修改 Core schema；
- Project identity：优先 canonical `repoUrl`，其次 `metadata.gitCommonDir`，保证 main workspace 与 linked worktree 归并为同一 `projectId`，而不是三个项目；
- Privacy：默认不写绝对路径与 tool arguments，不扫描磁盘、不读取 auth/secrets 文件；
- Boundary：只产生 `CareerEvidence`；`attribution` 为 `context`，不生成 candidate fact，也不进入 Achievement。

依赖策略：career-compiler 复制的是 contract，不是 scanner。`@aiusage/memory-core` 目前 `private` 且只导出 `src/index.ts`，`memory-sessions.ts` / `memory-project.ts` 仍是 CLI 内部实现，因此本轮以 JSON contract + adapter 解耦；未来再评估 `@0verme/ai-session-core` / `@0verme/ai-session-scanner`。

## Privacy 与失败策略

- Source 原始输入留在本地 storage；导出前由用户决定是否携带 local path。
- `AIProvider` 接收的是显式传入的 normalized evidence，不默认获得整个 repository 或 raw secret material。
- 网络错误、Git 命令错误和 schema 错误应显式失败；不能以空事实静默掩盖扫描失败。
- GitHub required request 遇到 rate limit 必须明确提示 token、减少范围或稍后重试；可选 external search 可返回 warning 并保留其他 evidence。
- Source 的重复运行使用稳定 evidence id，storage 通过 upsert 保持可重复导入；confirmed fact 不可被 candidate rescan 静默降级或改写。

## 新 Source checklist

1. 定义 request/discovery/scan 类型。
2. 实现 `discover → scan → extractEvidence`。
3. 为每类 Evidence 设计稳定 `id`/`sourceId`。
4. 分离 `raw` 与 `normalized` metadata。
5. 不产生 confirmed facts，不把 activity count 变成能力评价。
6. 增加 fixture、normalization test 和 privacy denylist test。
7. 在 docs 中说明哪些内容永远不离开本机。
