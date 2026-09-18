# `@career-compiler/core`

Career Compiler 的 framework-independent domain model：`CareerIdentity`、`CareerEvidence`、`CareerFact`、`CareerAchievement`、`CareerProfile`、`CareerIR`、source/renderer/repository contracts，以及可验证的 attribution-aware candidate fact pipeline。`context` evidence 不会自动晋升为 CareerFact。

`Fact → Achievement` 是一个 deterministic 编译层：只消费 confirmed facts，把 `problem` / `constraint` / `decision` / `action` / `result` 组件原样带入 `CareerAchievement`，并保留 `factRefs` 与 `evidenceRefs` provenance。缺字段保持为空，不编造数字、结果或技术决策。

关联与 provenance hardening：重名 project / role 或重复 canonical key 只在唯一 confirmed candidate 时关联，否则留空；`relation: "context"` 只表示关联、`contributes` 必须为空，context evidence 不进入 `achievement.evidenceRefs`，但仍可经 context factRef 追踪；`validateCareerIR()` 强制组件值与来源 fact 的原始值逐字段相等。

该 package 不依赖 SQLite、HTTP client 或任何 AI provider。
