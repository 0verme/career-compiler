# GitHub Identity Attribution

## 目标

Career Compiler 的 GitHub Source 判断的是“当前 Career Identity 能被可靠归因的工作”，而不是 repository 的活动总量。`repository` 是 project context；它本身不能证明用户创建、开发或负责了项目。

当前版本使用轻量的 `CareerIdentity`：

```ts
interface CareerIdentity {
  sources: SourceIdentity[];
}

interface SourceIdentity {
  provider: 'github' | 'git' | string;
  externalId: string;
  username?: string;
  displayName?: string;
  names?: string[];
  emails?: string[];
}
```

Profile 可以在 `CareerIR.profile.identity` 中声明它；Source run 通过 `SourceRunContext.identity` 获得判断对象。它不是账户体系，也不提供 OAuth 或登录能力。

## Attribution vocabulary

`CareerEvidence.attribution` 是 source 对单条观察的保守判断：

| Attribution | 语义 |
| --- | --- |
| `owned` | 当前 identity 拥有非 fork repository，或对应 profile |
| `authored` | 当前 identity 是 commit、issue 或 pull request 的明确 actor/author |
| `contributed` | 当前 identity 对本地 repository 有匹配的 Git author identity；它不等于 ownership |
| `reviewed` | 预留给明确的 PR review evidence；当前 GitHub Source 不抓取 reviews |
| `context` | repository 或活动属于上下文，不能归因给当前 identity |
| `unknown` | 没有足够 identity 信息，无法判断 |

GitHub activity 优先使用 API 的 `author.login` / `user.login`。`commit.commit.author.name`、贡献者名称和 `author_association` 只作为 metadata 保存，不能单独把 commit 标记为 `authored`。

PR 还保存 `repository`、`number`、`title`、`state`、`merged`、`authorLogin`、`createdAt`、`updatedAt`、`mergedAt`、source URI 与 `externalContribution`。当作者是当前 identity 且 repository owner 不是当前 identity 时，`externalContribution` 为 `true`。

## Owned、authored 与 context

- 非 fork 且 owner 是当前 GitHub username：repository `owned`。
- fork 即使 owner 是当前 username：repository `context`，不会自动产生项目事实。
- repository 中其他人的 commit、issue、PR：`context`。
- 当前 username 的 commit、issue、PR：`authored`。
- 没有可靠 login 的 commit 不会因为姓名相似而变成 `authored`。

Profile、repository、activity evidence 均保留 raw/normalized metadata；attribution 是可查询的 domain contract，而不是 renderer 文案。

## Fork 语义

fork 默认只表示用户拥有一个派生的 project context，不表示用户是上游项目作者。因此：

```text
fork repository
  └─ no authored evidence → no project candidate

fork repository
  └─ authored commits → contribution candidate

fork repository
  └─ authored PR → contribution candidate
```

候选事实使用 `Maintains` / `Works on` / `Contributed to` 等保守措辞，不会把 fork 自动渲染成 `Built`。上游作者的活动不会进入当前用户的 authored evidence。

## External Contributions

扫描 `scan github <username>` 时，Source 除了有限扫描用户 repositories，还请求 GitHub Search API：

```text
author:<username> type:pr
```

请求数量由 `github.maxExternalContributions` 控制，按页读取且每页最多 100 条；`0` 可关闭。它只发现 authored pull requests，不会全量抓取互联网，也不会把 PR count 当作能力评级。外部 authored PR 可以产生 `achievement` candidate，statement 例如：

```text
Contributed to t8y2/dbx via pull request #99: Improve dbx ingestion
```

这里复用现有 `achievement` fact type，因此不需要升级 Career IR schema，也能被现有 Resume/GitHub Profile renderer 在用户确认后消费。

## Candidate promotion

`deriveCandidateFacts()` 只提升：

- `owned` 且非 fork 的 repository：project candidate；只有 ownership 时用 `Maintains`，有 authored activity 时提高 confidence 并用 `Works on`。
- `contributed` 的 Local Git repository：project context candidate，前提是至少有匹配的 Git author identity。
- 外部 authored PR、或 fork 中明确 authored 的 PR/issue/commit：contribution/achievement candidate。

`context` / `unknown` repository 和 activity 永远不会直接产生 CareerFact。一个 candidate 仍然通过 `evidenceRefs` 关联多个 GitHub、Local Git 或 Chat evidence；SQLite 使用稳定 Evidence ID upsert。confirmed fact 在重新扫描时保留 statement、status 和 normalized claim，只追加 corroborating evidence。

## Rate limit 与配置

推荐配置：

```json
{
  "identity": {
    "githubUsername": "0verme",
    "git": {
      "authorNames": ["Alice Example"],
      "authorEmails": ["alice@example.invalid"]
    }
  },
  "github": {
    "tokenEnv": "GITHUB_TOKEN",
    "maxRepositories": 20,
    "maxActivityItems": 10,
    "maxExternalContributions": 20
  }
}
```

GitHub token 仍通过 `tokenEnv` 引用环境变量，不写入 evidence。Required API 请求遇到 rate limit 会明确提示 token、减少扫描范围或稍后重试；可选的 external search 遇到 rate limit 会保留已扫描 repository 并在 CLI 结果中输出 warning。

## Local Git 预留

Local Git 支持同一 `CareerIdentity` 的 `git.authorNames` / `git.authorEmails`。匹配到的 commit 标记为 `authored`，未匹配 commit 为 `context`；没有配置 Git identity 时使用 `unknown`，不会假装本地 repository 一定属于用户。完整的本地 ownership 语义留待后续版本。
