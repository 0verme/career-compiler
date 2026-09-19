# `@career-compiler/storage`

提供 local-first SQLite 实现。数据库只保存结构化 evidence、fact、fact-evidence links、可导出的 Career IR，以及独立的 Target Job 上下文，不让 Core Domain 依赖具体数据库。CareerAchievement 不单独建表，它是 confirmed facts 在 IR 构建时的 deterministic projection。

`target_jobs` 表保存 `TargetJob`（`id` / `company` / `title` / `raw_jd` / `raw_jd_hash` / 时间戳）并从属于独立的 `TargetJobRepository` contract；长 raw JD 逐字存入 TEXT，写入与读取都重新校验 hash，因此 JD 内容与分析所依赖的 fingerprint 不会静默失配。该表是纯新增的，既有数据库在打开时自动创建，evidence / facts / profiles 不受影响；Career IR 文档本身不包含 Target Job。

实现使用 Node.js 22.5+ 的 `node:sqlite`，数据目录默认位于用户级 application data 目录。加载旧版 `schemaVersion: 0.1` IR 文档时会显式迁移到 `0.2`，保存时写回当前版本。
