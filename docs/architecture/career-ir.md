# Career IR

## 定义

Career IR（Career Intermediate Representation）是 Sources 与 Renderers 之间的 versioned、portable domain document。V0.1 使用：

```json
{
  "kind": "career-ir",
  "schemaVersion": "0.1",
  "exportedAt": "2025-01-15T00:00:00.000Z",
  "profile": {},
  "facts": [],
  "evidence": []
}
```

它类似 compiler IR：不同输入先被规范化为统一领域语义，输出端不需要知道事实来自 GitHub、Local Git 还是 Conversation。

## 为什么需要 Career IR

没有 IR 时，每个 renderer 都会重复理解 source-specific data：Resume 读 GitHub API 字段，GitHub README 读聊天文本，未来 Portfolio 再复制一份规则。这样会让 source schema 渗透到 presentation 层，也会使输出难以复现与迁移。

Career IR 提供：

- 一个明确的 renderer input boundary
- 可 export/import 的 schema version
- 输出可重复生成的规范化数据
- 与数据库实现解耦的迁移边界
- provenance 在输出前仍可检查的完整文档

## Evidence、Fact、Presentation 的区别

### Evidence

`CareerEvidence` 是 source 观察到的记录，不是结论。它至少包含：

- `sourceType` / `sourceId`
- `evidenceType`
- `raw`：source 返回的受限结构化 metadata
- `normalized`：供 domain pipeline 使用的 metadata
- `sourceUri`
- `observedAt` / `discoveredAt`

例如 GitHub repository description、Local Git current branch、某条 commit metadata、conversation message 都是 evidence。Evidence 可以没有任何 fact，也不应被伪装成能力评价。

### Fact

`CareerFact` 是对 evidence 的规范化 claim。它必须包含 `evidenceRefs`，并有 `status`、`confidence`、时间戳和可选 `canonicalKey`。一个 fact 可以关联多个 evidence；同一个 repository 的 GitHub metadata、Local Git metadata 和 Conversation 可以共同支持一个 project fact。

Fact lifecycle 至少是：

```text
candidate → confirmed
candidate → rejected
```

未来可以增加 `superseded` 与 `conflicted`。AI/Mock 的输出永远先进入 `candidate`；只有用户动作才能进入 `confirmed`。Core 的 profile projection 只消费 confirmed facts，因此 AI 不能静默改写已经确认的历史。

### Presentation

Resume bullet、GitHub README 的 section 顺序、Markdown link 形式、面向某个职位的措辞都属于 renderer/template。它们可以重写表达，但不能创造 Core 中不存在的事实。比如“Led a 12-person team”是 fact 的 presentation；`teamSize: 12` 和对应 evidence link 才是 Core data。

## 哪些信息不能进入 Core

以下内容不应因为某个输出格式方便而进入 Career Core：

- Resume-only 的 bullet 文案、ATS keyword、页数和排版字段
- GitHub README-only 的 badge、SVG、动画、访问量组件
- 某一家 LLM 的 prompt、model name、temperature 或私有 response 格式
- Source-specific API pagination/cache 状态
- 由 commit 数、代码量或 activity count 直接推导的“能力评分”
- 没有 provenance 的任意 AI 生成句子
- secrets、token、`.env` 内容、私有源码正文

Source-specific metadata 可以作为 Evidence 的 normalized payload；只有跨 renderer 需要且能解释 provenance 的职业语义才进入 Fact/Profile。

## Source 与 Renderer 如何解耦

Source 实现 `CareerSource<TRequest, TDiscovery, TScan>`：

```text
discover(request) → scan(discovery) → extractEvidence(scan)
```

它只返回 Evidence。Core pipeline 负责 candidate facts、status 和 profile projection。Renderer 实现 `CareerRenderer`，输入 `CareerIR`，输出一个带 `rendererId`、`format`、`fileName` 和 `content` 的 artifact。它不接触 source adapter，也不从 SQLite 查询。

## 迁移策略

任何持久化或交换文件都必须带 `schemaVersion`。升级时增加显式 migration（例如 `0.1` → `0.2`），不要让 renderer 猜字段。未知版本应拒绝导入，而不是静默丢字段。V0.1 的 `parseCareerIR` 已对 `kind`、`schemaVersion`、evidence、facts、provenance link 做 validation。
