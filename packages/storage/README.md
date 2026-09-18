# `@career-compiler/storage`

提供 local-first SQLite 实现。数据库只保存结构化 evidence、fact、fact-evidence links 和可导出的 Career IR，不让 Core Domain 依赖具体数据库。CareerAchievement 不单独建表，它是 confirmed facts 在 IR 构建时的 deterministic projection。

实现使用 Node.js 22.5+ 的 `node:sqlite`，数据目录默认位于用户级 application data 目录。加载旧版 `schemaVersion: 0.1` IR 文档时会显式迁移到 `0.2`，保存时写回当前版本。
