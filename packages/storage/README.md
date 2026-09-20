# `@career-compiler/storage`

提供 local-first SQLite 实现。数据库只保存结构化 evidence、fact、fact-evidence links、可导出的 Career IR，以及独立的 Target Job 上下文与 Resume Compilation 产物，不让 Core Domain 依赖具体数据库。CareerAchievement 不单独建表，它是 confirmed facts 在 IR 构建时的 deterministic projection。

`target_jobs` 表保存 `TargetJob`（`id` / `company` / `title` / `raw_jd` / `raw_jd_hash` / 时间戳）并从属于独立的 `TargetJobRepository` contract；长 raw JD 逐字存入 TEXT，写入与读取都重新校验 hash，因此 JD 内容与分析所依赖的 fingerprint 不会静默失配。该表是纯新增的，既有数据库在打开时自动创建，evidence / facts / profiles 不受影响；Career IR 文档本身不包含 Target Job。

`resume_patch_proposals` / `resume_variants` / `compilation_snapshots` 保存 Resume Compilation 层：proposal 内容寻址，variant 以 `target_job_id` 唯一约束保证每个 Target Job 至多一条链，snapshot 保存 apply 前的 variant 状态。apply / revert 通过单个事务提交，失败不会留下半写入的 variant。这些表同样是纯新增，不进入 Career IR。

实现使用 Node.js 22.5+ 的 `node:sqlite`，数据目录默认位于用户级 application data 目录。加载旧版 `schemaVersion: 0.1` IR 文档时会显式迁移到 `0.2`，保存时写回当前版本。
