# `@career-compiler/source-github`

GitHub REST `CareerSource` adapter。它提取 profile、repository、language/topic、commit、issue 和 pull request metadata，并基于 `SourceRunContext.identity` 标记 `owned`、`authored`、`context` 等 attribution。

非 fork owned repository 才能进入 project candidate；fork 默认 context-only。扫描用户时还可以通过 `author:<username> type:pr` 发现受限的 external authored PR。它不使用 commit、PR、star 或 fork 数量评价能力。
