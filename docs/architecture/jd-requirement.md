# JD Requirement Parser

## 定义

JD Requirement Parser 负责把用户粘贴的 **岗位原文** 转成可审阅、可修正、默认未确认的结构化要求：

```text
TargetJob（rawJd / rawJdHash，逐字保存）
      ↓
JdRequirement Set（本层，只理解岗位文本）
      ↓
human review：confirm / reject / edit
      ↓
confirmed requirements（#17 Evidence Matcher 的正式输入）
```

Requirement 是**对岗位文本的结构化理解**，不是用户能力声明，也不是 Career Fact：

- 不进入 `CareerIR`，不属于 `CareerProfile`，Renderer 不读取；
- 解析、确认、编辑 requirement 不会创建或修改任何 `CareerEvidence` / `CareerFact` / `CareerAchievement`；
- `parsed` 结果默认未确认，只有用户确认后才允许进入正式匹配。

## Domain Contract

```ts
JdRequirement {
  id: string;                    // 由 targetJobId + sourceRawJdHash + quoteRange 确定性派生
  targetJobId: string;
  category: 'responsibility' | 'skill' | 'experience' | 'education'
          | 'management' | 'domain' | 'other';
  priority: 'required' | 'preferred' | 'unspecified';
  statement: string;             // 规范化描述；可被用户修正
  rawQuote: string;              // raw JD 中的逐字片段；不可编辑
  quoteRange: { start: number; end: number };  // UTF-16 偏移，end exclusive
  confidence: number;            // 0..1，仅供审阅排序
  status: 'parsed' | 'confirmed' | 'rejected';
  sourceRawJdHash: string;       // 解析时读取的 rawJdHash
  createdAt: string;
  updatedAt: string;
}

JdRequirementSet {
  targetJobId: string;
  rawJdHash: string;
  requirements: JdRequirement[];
}
```

### 关键不变量

- **可追溯**：`rawQuote` 必须等于 `rawJd.slice(quoteRange.start, quoteRange.end)`；validation 会拒绝定位失败的 requirement，保存前也会再次校验；
- **原文保留**：规范化只影响 `statement`；`rawQuote` 永远逐字保留，用户不能编辑 quote 或 range；
- **默认未确认**：解析结果一律 `status = 'parsed'`；
- **只有 confirmed 进入 matching**：#17 只能消费 `confirmedJdRequirements()` 的输出；
- **stale 可识别**：每个 requirement 记录 `sourceRawJdHash`；与 TargetJob 当前 `rawJdHash` 不一致即 stale；
- **可重跑**：解析只依赖完整 raw JD；修改 JD 后重新解析会生成绑定新 hash 的新 requirement；
- **ID 稳定**：`id` 由 `targetJobId + sourceRawJdHash + quoteRange` 派生，同一份 JD 重复解析得到同一组 id。

## Parser 边界与确定性

`JdRequirementParser` 是可替换 contract：

```ts
interface JdRequirementParser {
  readonly id: string;
  readonly version: string;
  parse(rawJd: string): JdRequirementCandidate[];
}
```

v1 实现 `DeterministicJdRequirementParser`（`deterministic-jd-rules` v1）只做确定性规则：

- 按行切分，保留 UTF-16 偏移；`rawQuote` 是行的 verbatim trim 片段；
- 识别章节 heading（职责 / 任职要求 / 加分项 等中英文变体）以确定默认 priority；
- 用关键词规则判断 category（education / experience / management / domain / skill）与 priority（preferred 关键词）；
- 首个非空行后紧跟 heading 时视为文档标题（已存于 `TargetJob.title`）并跳过；
- 不调用任何 LLM / provider，不做 embedding、keyword stuffing 或匹配。

同一份 raw JD 必须产生同一组 candidates（顺序、内容、offsets 完全确定）。未来 provider-backed parser 必须实现同一 contract，并且只产出 candidate requirement，不能直接写 confirmed 状态、不能写事实链。

### v1 已知限制

- 规则分类可能误判（例如“有金融行业经验者优先”按 experience 归类）；由人工 review 修正；
- 重新解析会用新 set 整体替换旧 set（`replaceJdRequirements` 原子替换）：同一份 JD 重跑会把已 confirm / reject 的状态重置为 `parsed`。保留 review 状态的差异合并留给 Snapshot / History 阶段；
- 解析粒度是行级，不拆分多行 bullet 或跨行句子。

## Review Lifecycle

```text
parsed ──confirm──> confirmed
   │  └──reject───> rejected
   └──edit（category / priority / statement，不改变 id 与 quote）
```

- `confirm` / `reject` 是显式用户动作；重复 confirm 返回原对象；
- `edit` 不改变 `id`、`rawQuote`、`quoteRange`、`sourceRawJdHash`；
- 状态是 requirement 自身的 review 状态，不影响 Career Truth。

## Storage

新增 `jd_requirements` 表（`CREATE TABLE IF NOT EXISTS`，旧数据库自动创建）：

```sql
CREATE TABLE jd_requirements (
  id TEXT PRIMARY KEY,
  target_job_id TEXT NOT NULL REFERENCES target_jobs(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  statement TEXT NOT NULL,
  raw_quote TEXT NOT NULL,
  quote_start INTEGER NOT NULL,
  quote_end INTEGER NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  source_raw_jd_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- `JdRequirementRepository` 与 `TargetJobRepository` 分开；
- `replaceJdRequirements` 在单个事务内删除旧 set 并写入新 set：解析失败不会留下半成品，也不会新旧混用；
- `listJdRequirements` 按 `quote_start` 输出文档顺序；
- requirement 不进入 Career IR export/import，IR schema 仍为 `0.2`。

## CLI

```bash
career-compiler target add --title "Data Platform Lead" --jd-file jd.md
career-compiler jd parse <target-job-id>          # deterministic 解析，全部 parsed
career-compiler jd list <target-job-id>           # 表格 + stale 提醒
career-compiler jd show <requirement-id>          # 含 rawQuote 与 quoteRange
career-compiler jd confirm <requirement-id>
career-compiler jd reject <requirement-id>
career-compiler jd edit <requirement-id> --category domain --priority preferred --statement "..."
```

- `jd list` 在 `sourceRawJdHash` 与当前 target job 不一致时输出 `! stale:` 提醒；
- `jd confirm` 的输出表明该 requirement 允许进入 #17 的正式匹配输入。

## 非目标（本阶段）

- Evidence Matcher / JD Evidence Matrix / Gap（#17）；
- ATS 分数、匹配率、keyword stuffing；
- embedding / vector DB / RAG；
- 自动修改 `CareerFact` / `CareerEvidence` / `CareerProfile` / Resume Variant；
- 招聘网站抓取、职位推荐、自动投递；
- 把 requirement 当作能力声明。

> Requirement 是对岗位的理解，不是对候选人的结论。
