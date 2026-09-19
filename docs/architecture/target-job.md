# Target Job

## 定义

`TargetJob` 是用户想申请的目标岗位上下文，例如“某券商 - 数据平台负责人”。它是独立于职业证据链的第二条输入线：

```text
Career Evidence → CareerFact → CareerAchievement → CareerProfile / CareerIR
                                                              │
                                                              ├── Target Job A
                                                              ├── Target Job B
                                                              └── Target Job C

TargetJob → JD Requirement → Evidence Matcher → JD Evidence Matrix → Resume Variant
```

Target Job **不是** Career Fact：

- 它不进入 `CareerIR`，不属于 `CareerProfile`，也不是“用户已经具备某项能力”的证明；
- 保存、更新 Target Job 不会修改 `CareerEvidence`、`CareerFact`、`CareerAchievement` 或 `CareerProfile`；
- 未来的汇合点是独立的 Evidence Matcher，而不是把 JD 写进事实模型。

## Contract

```ts
TargetJob {
  id: string;          // 稳定身份
  company?: string;    // 可选
  title: string;       // 岗位名称
  rawJd: string;       // 用户输入的原始 JD，逐字保存
  rawJdHash: string;   // rawJd 的内容指纹
  createdAt: string;
  updatedAt: string;
}
```

### Stable ID

- `id` 在创建时生成（`targetjob_<uuid>`），此后不因为修改 company、title 或 raw JD 而变化；
- identity ≠ content hash：同一家公司、同一个岗位名称可以保存多个互相独立的 Target Job；
- 修改 JD 不是“新建一个逻辑 Target Job”，而是同一个 Target Job 的内容变化。

`rawJdHash` 也不是 identity：两个内容相同的 Target Job 仍然是两个独立对象。

### rawJd 是 source-of-truth input

`rawJd` 逐字保存用户输入，包括换行、缩进和尾部空白；domain 只要求它非空。未来的 Requirement Parser 必须能够基于完整 raw JD 重跑，因此不允许只保存 keywords、summary 或 normalized text。

### rawJdHash 与 stale 语义

`rawJdHash` 是 `rawJd` 的确定性内容指纹，与仓库既有 stable id 一样使用 32-bit FNV-1a。它是变化检测器，不是安全哈希：

```text
rawJd 未变化 → rawJdHash 不变 → 已有分析仍然有效
rawJd 变化   → rawJdHash 变化 → 未来的 parsed requirements / matrix / variant 可能 stale
```

本轮没有 parsed requirements、evidence matrix 或 resume variant，因此不引入 stale graph。`rawJdHash` + `updatedAt` 是这一语义的最小基础：未来的派生对象记录自己读取的 `rawJdHash`，与当前值比较即可判断是否过期。

`validateTargetJob()` 强制 `rawJdHash` 与 `rawJd` 一致，因此不一致的 hash 无法被保存或读取，而不是被静默接受。

### Lifecycle

```text
create → update（id 稳定）→ …
```

- `create`：`createTargetJob()` 生成 id、时间戳和 `rawJdHash`；
- `update`：`updateTargetJob()` 只应用 patch 中出现的字段，`company: null` 表示清除公司；patch 没有实际变化时返回原对象，`updatedAt` 不抖动；
- 更新 raw JD 后 `id` / `createdAt` 不变，`rawJdHash` / `updatedAt` 更新；
- 本轮不提供 delete。删除语义（以及未来 analysis / variant 的级联规则）留到对应功能实现时再定义，避免提前引入不完整的 cascade。

## Storage

Target Job 持久化在 `target_jobs` 表：

```sql
CREATE TABLE target_jobs (
  id TEXT PRIMARY KEY,
  company TEXT,
  title TEXT NOT NULL,
  raw_jd TEXT NOT NULL,
  raw_jd_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- `raw_jd` 使用 SQLite TEXT 完整保存长 JD；
- repository contract 是 `TargetJobRepository`（`saveTargetJob` / `getTargetJob` / `listTargetJobs` / `updateTargetJob`），与 `CareerRepository` 分开；
- 写入与读取都经过 `validateTargetJob()`，持久层不会接受与 raw JD 不一致的 hash；
- 这是纯新增表：旧数据库在打开时自动创建它，既有 evidence / facts / profiles 数据不受影响；
- Target Job 不参与 Career IR export/import；IR 文档仍然不包含目标岗位。

## CLI

```bash
career-compiler target add --title "Data Platform Lead" --company Acme --jd-file jd.md
career-compiler target list
career-compiler target show <id>
career-compiler target update <id> --jd-file jd-v2.md
```

- raw JD 是长文本，因此优先支持 `--jd-file <path>`、`--jd-file -` 与 stdin（`cat jd.md | career-compiler target add --title "…"`）；`--jd` 只适合短文本；
- `target list` 只输出 id / company / title / updatedAt，不打印 JD 正文；
- `target show` 输出完整记录（含 raw JD）；
- `target update` 保持 id 不变，只更新 patch 中出现的字段。

## 非目标（本阶段）

本轮只实现 domain + storage + minimal CLI：

- 不做 JD Requirement Parser，不解析 raw JD；
- 不做 LLM、prompt、embedding、vector DB 或 RAG；
- 不做 Evidence Matcher、JD Evidence Matrix、Strength / Gap；
- 不做 Resume Variant 或 target-aware resume；
- 不做 ATS 分数、关键词 stuffing、职位抓取或自动投递；
- 不自动修改 CareerFact / CareerAchievement。

> JD is data, not intelligence.

## 下一阶段

```text
TargetJob → JD Requirement Parser
```

Requirement Parser 读取 `rawJd`，产出可审阅的 structured requirements，并保留原文引用；它需要记录输入 `rawJdHash`，以便 JD 修改后被识别为 stale。本阶段不实现该能力。
