# `@career-compiler/source-chat`

Manual / Chat source 与可替换 AI fact extraction contract。V0.1 提供 deterministic extractor 和 schema validation，输出只能进入 `candidate` 状态。

Deterministic extractor 支持显式标注的 achievement block，字段包括 `Achievement`、`Project`、`Problem`、`Constraint`、`Decision`、`Action`、`Result`、`Metric`（中文标签同样可用）。字段值只会原样进入 candidate fact，不会自动补全或推断。
