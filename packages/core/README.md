# `@career-compiler/core`

Career Compiler 的 framework-independent domain model：`CareerIdentity`、`CareerEvidence`、`CareerFact`、`CareerAchievement`、`CareerProfile`、`CareerIR`、source/renderer/repository contracts，以及可验证的 attribution-aware candidate fact pipeline。`context` evidence 不会自动晋升为 CareerFact。

`Fact → Achievement` 是一个 deterministic 编译层：只消费 confirmed facts，把 `problem` / `constraint` / `decision` / `action` / `result` 组件原样带入 `CareerAchievement`，并保留 `factRefs` 与 `evidenceRefs` provenance。缺字段保持为空，不编造数字、结果或技术决策。

该 package 不依赖 SQLite、HTTP client 或任何 AI provider。
