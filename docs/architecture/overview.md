# Architecture Overview

## 目标

Career Compiler 的核心资产是 Career Data Model、Evidence Provenance、Career IR、Source Ecosystem 和 Renderer Ecosystem。CLI 只是验证领域闭环的薄入口，不是业务核心。

```text
┌──────────────────────────────────────────────────────────────┐
│ CLI                                                          │
│ scan github / scan local / add / facts / target / render     │
└───────────────┬──────────────────────────────────────────────┘
                │ orchestration
┌───────────────▼──────────────────────────────────────────────┐
│ Sources                                                      │
│ GitHub · Local Git · Manual/Chat · AI Session                │
│ discover → scan → extractEvidence                            │
└───────────────┬──────────────────────────────────────────────┘
                │ CareerEvidence (observations + attribution)
┌───────────────▼──────────────────────────────────────────────┐
│ Core Domain                                                  │
│ identity + attribution → candidate CareerFact → confirmation │
│ Fact → CareerAchievement compiler (Problem/Constraint/…)     │
│ CareerProject / Experience / Skill / Achievement projection   │
└───────────────┬──────────────────────────────────────────────┘
                │ versioned Career IR (schemaVersion: 0.2)
┌───────────────▼──────────────────────────────────────────────┐
│ Renderers                                                    │
│ Markdown Resume · GitHub Profile README                      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Target Job Domain（与事实链正交，不进入 Career IR）          │
│ TargetJob: company / title / rawJd / rawJdHash               │
│ identity ≠ content hash；raw JD 是 source-of-truth input      │
└──────────────────────────────────────────────────────────────┘

                         ↕
               Storage Contract → SQLite
```

## Workspace 边界

| Module | 责任 | 不负责 |
| --- | --- | --- |
| `packages/core` | Domain types、validation、provenance、fact pipeline、Fact → Achievement compiler、TargetJob domain contract、source/renderer/repository contracts | SQLite、HTTP、LLM、CLI、JD 解析 |
| `packages/storage` | `CareerRepository` 与 `TargetJobRepository` 的 Node.js `node:sqlite` 实现、IR import/export、用户级路径 | 事实推断、渲染、网络扫描、JD 解析 |
| `packages/source-github` | GitHub REST metadata adapter、identity attribution、limited external PR discovery | 把 metadata 直接变成 confirmed fact、把 repository activity 当作用户贡献 |
| `packages/source-local-git` | 显式目录的 Git metadata scanner 与 scanner policy | 读取/上传源码、能力评分 |
| `packages/source-chat` | Manual/Chat evidence、AIProvider contract、deterministic extractor | 直接写 confirmed history |
| `packages/source-ai-session` | 消费 AIUsage 归一化的本地 AI session contract，做 project/worktree canonicalization 与 privacy-filtered provenance，输出 CareerEvidence | 解析 vendor JSONL、扫描磁盘、生成 fact |
| `packages/renderer-*` | 从 Career IR 生成稳定 Markdown | 访问 Source、查询数据库、调用 AI |
| `apps/cli` | 编排 source → evidence → fact → IR → renderer | 持有 domain truth |

## 一次写入流程

1. Source 根据用户请求发现目标。
2. Scanner 根据 `CareerIdentity` 抽取结构化 `CareerEvidence`，保留 `raw`、`normalized` 和 `attribution`。AI session 这类无法可靠归因的本地来源统一标记 `context`，只作为证据。
3. Core 只提升 owned/authored/contributed 的高置信度 evidence；context/unknown 保留为证据，不直接创建 CareerFact。
4. Core 的 deterministic projector 或 `FactExtractor` 创建 `candidate CareerFact`。
5. 用户通过 `facts confirm <id>` 确认；confirmed fact 的 provenance 不丢失。
6. Core 的 deterministic Achievement compiler 只从 confirmed facts 构建 `CareerAchievement`（含 `factRefs` / `evidenceRefs`）；candidate 内容不会进入。
7. Core 从 confirmed facts 构建 `CareerProfile`，再封装成 versioned `CareerIR`（当前 `0.2`）。
8. Renderer 只读取 Career IR 并输出 Markdown artifact。

## 两条独立输入线

```text
Career Evidence → CareerFact → CareerAchievement ──┐
                                                   ↓
                                            Evidence Matcher（未来）
                                                   ↑
TargetJob → JD Requirement（未来）─────────────────┘
```

Career 事实链与 Target Job 正交：

- `CareerFact` / `CareerAchievement` 描述用户已经做过什么，必须由 confirmed facts 与 evidence 支持；
- `TargetJob` 描述用户想申请什么，只保存目标上下文（`company` / `title` / `rawJd` / `rawJdHash`），不是用户能力证明；
- 保存、更新 Target Job 不会修改 evidence、facts、achievements 或 profile，`TargetJob` 也不进入 `CareerIR`；
- Renderer 仍然只消费 Career IR，不读取 JD；
- 未来只有 Evidence Matcher 同时消费两条线，它的输出是可重新计算的分析结果，而不是新的事实源。

Target Job 的 contract、stale 语义与 CLI 见 [Target Job](target-job.md)。

## 隐私边界

原始文件默认留在本机。Local Git 只需要 file path、Git metadata、有限 README/project metadata；默认 denylist 包含 `.env`、credentials/secrets、`node_modules`、`.git`、build/cache 目录，binary 也不进入 language discovery。未来如增加远程 AI provider，调用方必须显式决定发送哪些 normalized evidence，Provider 不拥有数据库写入权限。

AI session 扫描与 AIUsage 的 usage scan 语义不同：usage scan 只读取 token / model / cost 字段，而 career memory scan 会读取 conversation 正文、tool call metadata 与 project identity。AI session evidence 默认只保留相对 source path 后缀与不可逆 `sourcePathHash`，绝对路径与 tool arguments 需显式开启；conversation 正文仍会进入本地 Evidence 与 Career IR export，因此 IR export 应视为本地/私有文档。AIUsage README 中 “never touches conversation content” 的表述只适用于 usage pipeline，不适用于 memory / career session 读取；这是上游文档的语义风险，本仓库仅记录，不在本任务中修改 AIUsage 文档。

## Storage 判断

V0.1 采用 SQLite，是因为 evidence、facts、many-to-many provenance links 和 versioned profile 文档都适合本地事务存储。Core 只依赖 `CareerRepository`，因此未来可以替换 IndexedDB、Tauri SQLite 或其他实现，而不改 Source/Renderer contract。默认数据库放在用户级 application data 目录，不放进被扫描的 repository。

## 明确不做

本阶段不引入 Web UI、Desktop、云同步、OAuth、账户系统、Vector DB、RAG、Knowledge Graph、Agent framework 或自动发布。Target Job 目前只保存目标上下文：不解析 JD、不做 Evidence Matching、不生成 target-aware resume。最大风险是 domain model 与 provenance 是否成立，而不是 UI 数量。
