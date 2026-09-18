# Career IR

## 定义

Career IR（Career Intermediate Representation）是 Sources 与 Renderers 之间的 versioned、portable domain document。V0.1 使用：

```json
{
  "kind": "career-ir",
  "schemaVersion": "0.2",
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
- 可选 `attribution`：`owned`、`authored`、`contributed`、`reviewed`、`context` 或 `unknown`
- 可选 `externalContribution`，表示 authored work 发生在非本人 owner 的 repository

例如 GitHub repository description、Local Git current branch、某条 commit metadata、conversation message 都是 evidence。Evidence 可以没有任何 fact，也不应被伪装成能力评价。GitHub repository activity 不会因为属于一个 repository 就自动成为当前 identity 的 authored evidence。

### Fact

`CareerFact` 是对 evidence 的规范化 claim。它必须包含 `evidenceRefs`，并有 `status`、`confidence`、时间戳和可选 `canonicalKey`。一个 fact 可以关联多个 evidence；同一个 repository 的 GitHub metadata、Local Git metadata 和 Conversation 可以共同支持一个 project fact。

Profile 可以在 `profile.identity.sources` 中声明 GitHub username 和 Git author names/emails。这个 identity 不是账户系统，而是 Source attribution 时使用的声明。

Fact lifecycle 至少是：

```text
candidate → confirmed
candidate → rejected
```

未来可以增加 `superseded` 与 `conflicted`。AI/Mock 的输出永远先进入 `candidate`；只有用户动作才能进入 `confirmed`。Core 的 profile projection 只消费 confirmed facts，因此 AI 不能静默改写已经确认的历史。

### Achievement

`CareerAchievement` 是 confirmed facts 的 deterministic 编译单元，用来承载一个可独立成段的职业成就：

```text
Problem → Constraint → Decision → Action → Result
```

模型至少包含：

- `statement` 以及可选的 `problem` / `constraint` / `decision` / `action` / `result` / `metric`；
- `status: "confirmed"`：只有 confirmed facts 能产生正式 Achievement，candidate 内容留在 Fact 层；
- `factRefs`：每条 fact 支撑哪些组件（`contributes`）；project/experience 关联使用 `relation: "context"`，且 context 的 `contributes` 必须为空；非 context 的 factRef 必须至少声明一个组件；
- `evidenceRefs`：直接支撑组件的 contributing confirmed facts 的 evidence 并集；context fact 的 evidence 不混入，仍可经 `factRefs` → context fact → `fact.evidenceRefs` 追踪；
- 可选 `projectId` / `experienceId`：由 canonicalKey 或 name/role 确定性解析，且必须能由某条 context factRef 推导出来；解析不到即留空。

编译规则（`compileAchievements`）：

- 只读取 confirmed facts；
- `achievement` / `metric` facts 是 Achievement 来源，`project` / `experience` / `role` facts 只作为关联对象；
- 组件值只从 fact `normalizedData` 原样 trim，缺什么就是空什么；
- 禁止生成数字、结果、因果关系、技术决策，禁止跨 fact 拼接句子；
- 关联解析不得依赖排序：canonical key 精确匹配优先；name / role fallback 只在唯一 confirmed candidate 时关联；0 个或多个候选（重名、重复 canonicalKey）一律留空；
- 一个 Project / Experience 可以承载多个 Achievement；
- 相同 facts 输入必须产生相同 ID、顺序和内容。

`validateCareerIR()` 强制 component-level provenance：`contributes` 声明的每个组件必须与来源 confirmed fact 的原始值逐字段相等（`statement` 对应 `fact.statement`，其余对应 `fact.normalizedData[...]`）。fact 缺少被声明的组件、`context` 带 `contributes`、非 context 无 `contributes`、没有任何 factRef 声明 `statement`、`projectId` / `experienceId` 无 context factRef 支撑、或 contributing fact 的 evidence 缺失，都会被拒绝。

Fact 描述 claim，Achievement 是 claim 的结构化单元，Resume Bullet 只是该单元的 presentation。Renderer 不允许用 fact 自己猜 Achievement。

### Presentation

Resume bullet、GitHub README 的 section 顺序、Markdown link 形式、面向某个职位的措辞都属于 renderer/template。它们可以重写表达，但不能创造 Core 中不存在的事实。比如“Led a 12-person team”是 fact 的 presentation；`teamSize: 12` 和对应 evidence link 才是 Core data。

## 哪些信息不能进入 Core

以下内容不应因为某个输出格式方便而进入 Career Core：

- Resume-only 的 bullet 文案、ATS keyword、页数和排版字段
- GitHub README-only 的 badge、SVG、动画、访问量组件
- 某一家 LLM 的 prompt、model name、temperature 或私有 response 格式
- Source-specific API pagination/cache 状态
- repository activity 与用户 identity 之间未经归因的推断
- 由 commit 数、代码量或 activity count 直接推导的“能力评分”
- 没有 provenance 的任意 AI 生成句子
- secrets、token、`.env` 内容、私有源码正文

Source-specific metadata 可以作为 Evidence 的 normalized payload；只有跨 renderer 需要且能解释 provenance 的职业语义才进入 Fact/Profile。

## Source 与 Renderer 如何解耦

本轮没有新增 `contribution` fact type：external authored PR 和 fork 中明确 authored work 使用现有 `achievement` candidate 表达，确认后由 Achievement compiler 编译为带 provenance 的 unit，再由 renderer 呈现。

## Source 实现

Source 实现 `CareerSource<TRequest, TDiscovery, TScan>`：

```text
discover(request) → scan(discovery) → extractEvidence(scan)
```

它只返回 Evidence。Core pipeline 负责 candidate facts、status 和 profile projection。Renderer 实现 `CareerRenderer`，输入 `CareerIR`，输出一个带 `rendererId`、`format`、`fileName` 和 `content` 的 artifact。它不接触 source adapter，也不从 SQLite 查询。

## 迁移策略

任何持久化或交换文件都必须带 `schemaVersion`。当前版本为 `0.2`；`0.1` → `0.2` 的迁移在解析时显式执行：

- `CareerAchievement.factIds` 迁移为 `factRefs`（`relation: "derived-from"`，`contributes` 至少包含 `statement`，存在 `metric` 时包含 `metric`）；
- 旧 Achievement 标记为 `status: "confirmed"`，因为 V0.1 的 profile projection 只消费 confirmed facts；
- 迁移结果按 0.2 规则重新校验：Achievement 必须引用 IR 内存在的 confirmed fact，且其 evidence 必须存在；`contributes` 声明的组件必须与来源 fact 的原始值逐字段相等。

`parseCareerIR` 接受 0.1 与 0.2；`serializeCareerIR` 始终输出当前版本。未知版本应拒绝导入，而不是静默丢字段。没有 provenance 的 Achievement（例如 legacy `factIds` 为空）会被拒绝，而不是自动补造。
