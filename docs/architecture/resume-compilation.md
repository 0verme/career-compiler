# Resume Compilation（Proposal / Strategy / Variant）

## 定义

Resume Compilation 是 Career Truth 与 Renderer 之间的**编译与审阅边界**：

```text
Evidence → Fact → Achievement → CareerProfile / CareerIR   （Career Truth，只读）
                                        │
                                        ├── Target Job A → Proposal → Variant A
                                        ├── Target Job B → Proposal → Variant B
                                        └── Target Job C → Proposal → Variant C

Variant（结构 view）→ Renderer → Markdown
```

同一份 Career Profile 可以针对不同目标岗位、不同关注点编译出多个互不覆盖的 Variant；变化的是**事实的选择、顺序与可见性**，而不是事实本身。

## 三个对象的分工

| 对象 | 角色 | 是否可变 |
| --- | --- | --- |
| `ResumePatchProposal` | 可审阅的修改建议；内容寻址、可复现、可拒绝 | 仅 `draft → applied / rejected` |
| `CompilationStrategy` | 把显式 directives（未来是 JD / Matrix 分析）变成 proposal | 无状态 contract |
| `ResumeVariant` | 已生效的 presentation 状态；只保存结构 view | apply 递增 revision，revert 回退 |
| `CompilationSnapshot` | apply 前的 Variant 状态，用于单步回滚 | revert 后消费 |

### 为什么不直接改 CareerProfile / CareerIR

Proposal 的操作对象是 **CareerIR 的 presentation projection**，而不是事实层：

- patch 不修改 `CareerFact` / `CareerEvidence` / `CareerAchievement` 内容；
- variant 不复制 content，只记录“选中 / 隐藏 / 顺序 / 可见性 / 强调”；
- 被 hide 的成就仍然存在于 Career Truth，其他 Variant 仍可引用；
- 因此不存在“为了适配 JD 而篡改职业事实”的路径。

v1 的 Proposal 是**绝对目标视图**：apply 会用 proposal 规范化出的 view 整体替换 Variant 的 view。需要保留上一次选择时，应在 directives 中继续显式给出。

## Contract

```ts
ResumePatchProposal {
  id: string;               // 内容寻址：同一 IR + strategy + target + operations → 同一 id
  baseIrHash: string;       // 编译所基于的 CareerIR 语义指纹（SHA-256）
  targetJobId?: string;
  strategyId: string;       // v1: structural-v1
  operations: ResumePatchOperation[];
  status: 'draft' | 'applied' | 'rejected';
  createdAt: string;
  appliedAt?: string;
  rejectedAt?: string;
}

ResumeViewConfig {
  sectionOrder: ResumeSectionId[];         // 完整排列
  hiddenSections: ResumeSectionId[];
  achievementOrder: string[];              // 显式顺序前缀
  hiddenAchievementIds: string[];
  emphasizedSkillIds: string[];            // 移到技能列表前面，不新增技能
}

ResumeVariant {
  id: string;
  targetJobId?: string;                    // 一个 Target Job 至多一条 variant 链
  baseIrHash: string;
  proposalId: string;
  view: ResumeViewConfig;
  revision: number;                        // apply / revert 单调
  createdAt: string;
  updatedAt: string;
}

CompilationSnapshot {
  id: string;
  variantId: string;
  baseIrHash: string;
  proposalId: string;
  previous: ResumeVariantState | null;     // null = 这次 apply 创建了 variant
  createdAt: string;
}
```

### PatchOperation（v1 仅结构操作）

```text
select-achievement       选中某条 achievement 进入 Variant
hide-achievement         从 Variant 中排除某条 achievement
reorder-achievements     调整 achievement 顺序
set-section-order        调整 section 顺序（必须给出完整排列）
set-section-visibility   section 显示 / 隐藏
emphasize-skill          技能强调（移到前面，不新增技能）
```

每条 operation 都带 `reason`。v1 不存在“自由改写文本”的 operation，也没有 AI rewrite、set-summary 生成或 keyword stuffing。

## Lifecycle

```text
create proposal (draft)
   ├── reject  → rejected（不产生任何 Variant / Snapshot 改动）
   └── apply   → applied + Variant(revision+1) + Snapshot
                     │
                     └── revert → proposal 回到 draft；Variant 恢复 apply 前状态
                                  （若该 apply 创建了 variant，则删除 variant）
```

- apply 前置条件：proposal 必须是 `draft`，且 `baseIrHash` 与当前 CareerIR 指纹一致；
- stale proposal 会被拒绝，而不是在变化的 Career Truth 上继续 apply；
- 同一 Target Job 的第二次 apply 产生新的 revision，并记录 `previous` 状态；
- reject 是终态；revert 后 proposal 可以重新 review 和 apply；
- 完整 revision history / 内容寻址 / 多目标 compare 属于后续 Snapshot History 阶段。

## Canonical IR Fingerprint

`baseIrHash` 使用 **canonical serialization + SHA-256**，不是仓库既有的 32-bit FNV-1a `stableHash`：

- `canonicalStringify`：对象键递归排序，数组顺序保留；
- 语义投影：
  - 排除 `exportedAt`、`profile.generatedAt`、fact `createdAt` / `updatedAt` / `confirmedAt` / `confirmedBy`、evidence `discoveredAt` / `observedAt`；
  - `facts`、`evidence`、profile 列表与 refs 按稳定 id 排序；
  - 其余参与编译与 Career Truth 的内容全部包含；
- 同一语义文档（包括集合顺序不同）得到同一 hash；事实状态、statement、normalizedData 或 profile 展示字段变化都会改变 hash。

## Storage

新增三张表（`CREATE TABLE IF NOT EXISTS`，旧数据库打开时自动创建，不修改既有表）：

```sql
CREATE TABLE resume_patch_proposals (
  id TEXT PRIMARY KEY,
  base_ir_hash TEXT NOT NULL,
  target_job_id TEXT,
  strategy_id TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  rejected_at TEXT
);

CREATE TABLE resume_variants (
  id TEXT PRIMARY KEY,
  target_job_id TEXT UNIQUE,        -- NULL 可重复：untargeted variant 各自独立
  base_ir_hash TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES resume_patch_proposals(id),
  view_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE compilation_snapshots (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL REFERENCES resume_variants(id) ON DELETE CASCADE,
  base_ir_hash TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  previous_json TEXT,
  created_at TEXT NOT NULL
);
```

- `commitResumeCompilation` / `commitResumeRevert` 在单个事务内完成 proposal、variant、snapshot 的写入，失败不会留下半成品；
- Proposal / Variant / Snapshot 都不进入 Career IR export/import，IR schema 仍是 `0.2`。

## CLI

```bash
career-compiler compile propose --target <target-job-id> \
  --hide-achievement <achievement-id> \
  --section-order skills,achievements,summary,experience,projects \
  --emphasize-skill <skill-id>
career-compiler compile proposals
career-compiler compile show <proposal-id>
career-compiler compile apply <proposal-id>
career-compiler compile reject <proposal-id>
career-compiler compile revert <snapshot-id>
career-compiler compile variants
career-compiler compile variant <variant-id>
career-compiler render resume --variant <variant-id> --output resume.md
```

- `compile apply` 输出 `variant id` / `revision` / `snapshot id`；`compile revert` 消费该 snapshot；
- `render resume --variant` 在 `baseIrHash` 与当前 CareerIR 不一致时 fail-closed，提示重新编译；
- `--variant` 与 `--template` 不能同时使用：v1 的 variant 自带 section 顺序，完整 presentation 契约（template 与 variant 组合、theme、locale）属于后续 Resume Presentation 阶段。

## 非目标（本阶段）

- AI 文本 rewrite / 润色 / set-summary 生成；
- JD Parser、Evidence Matcher、JD Evidence Matrix、Gap；
- Chat → Proposal；
- Web UI / Career Workspace；
- HTML / PDF / DOCX / theme / layout engine；
- 完整 revision history、多目标 compare、内容寻址历史；
- ATS 分数、keyword stuffing；
- LLM provider 绑定（strategy contract 不依赖任何 provider）。

Renderer 仍然只消费 CareerIR / CareerProfile；它不读取 JD、Target Job、Proposal 或 Snapshot。
