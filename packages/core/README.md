# `@career-compiler/core`

Career Compiler 的 framework-independent domain model：`CareerIdentity`、`CareerEvidence`、`CareerFact`、`CareerAchievement`、`CareerProfile`、`CareerIR`、source/renderer/repository contracts，以及可验证的 attribution-aware candidate fact pipeline。`context` evidence 不会自动晋升为 CareerFact。

`Fact → Achievement` 是一个 deterministic 编译层：只消费 confirmed facts，把 `problem` / `constraint` / `decision` / `action` / `result` 组件原样带入 `CareerAchievement`，并保留 `factRefs` 与 `evidenceRefs` provenance。缺字段保持为空，不编造数字、结果或技术决策。

关联与 provenance hardening：显式 `projectKey` / `experienceKey` 采用 fail-closed 解析，key 缺失或匹配多条时留空，不回退到 name / role；只有未提供 key 时才按 name / role 的唯一 confirmed candidate 关联，candidate 按 `fact.id` 去重，重名或重复 canonical key 留空；`relation: "context"` 只表示关联、`contributes` 必须为空，context evidence 不进入 `achievement.evidenceRefs`，但仍可经 context factRef 追踪；`validateCareerIR()` 强制组件值与来源 fact 的原始值逐字段相等。

`TargetJob` 是另一条正交输入线：稳定 `id`、可选 `company`、`title`、逐字保存的 `rawJd` 与仅用于变化检测的 `rawJdHash`。`createTargetJob` / `updateTargetJob` 不生造事实，`validateTargetJob` 强制 hash 与 raw JD 一致；Target Job 不进入 `CareerIR`。

Resume Compilation 层把 Career IR 的 presentation projection 编译为可审阅的 `ResumePatchProposal`，再 apply 为 `ResumeVariant`：proposal 内容寻址、只包含 select / hide / reorder / section visibility / skill emphasis 等结构操作，`baseIrHash` 使用 canonical serialization + SHA-256；apply 前校验 IR 未变化，reject 不动 variant，revert 通过最小 `CompilationSnapshot` 回退。该层不修改 fact / evidence / achievement。

该 package 不依赖 SQLite、HTTP client 或任何 AI provider。
