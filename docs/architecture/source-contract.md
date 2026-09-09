# Source Contract

## 稳定接口

Core 定义：

```ts
interface CareerSource<TRequest, TDiscovery = unknown, TScan = unknown> {
  readonly sourceType: SourceType;
  discover(request: TRequest, context: SourceRunContext): Promise<TDiscovery>;
  scan(discovery: TDiscovery, context: SourceRunContext): Promise<TScan>;
  extractEvidence(scan: TScan, context: SourceRunContext): Promise<CareerEvidence[]>;
}
```

三个阶段刻意分开：

- `discover`：根据用户请求找到目标，不产生职业结论。
- `scan`：访问 API 或本地 metadata，得到 source-specific scan result。
- `extractEvidence`：把 scan result 转换为稳定的 `CareerEvidence`，保存 raw/normalized provenance。

Source 可以有自己的 request/scan types，但返回的 Evidence 必须通过 Core validation。

## V0.1 adapters

### GitHub

`GitHubSource` 使用原生 `fetch` 调 REST API，可注入 `fetchImpl` 做测试。支持 user 与 `owner/name` repository 请求，提取：

- profile metadata
- repository description/default branch/topics/languages
- commit metadata
- issue metadata
- pull request metadata

它不会把 commit 数量当作工程能力，也不会把 GitHub activity 自动写成 confirmed fact。

### Local Git

`LocalGitSource` 只接受用户显式传入的目录。它通过 Git 命令读取 remote、branch、有限 commit history metadata、contributors、tags，并以 tracked file path 的 extension 推断语言；不会读取源码内容。README 只抽取受限 title/excerpt，`package.json` 只抽取 name/description。

Scanner policy 支持：

- `allowlist`
- `denylist`
- `maxDepth`
- `maxCommits`
- `maxFiles`

默认排除 secrets、credentials、`.env`、`.git`/objects、依赖、build/cache 和 binary。allowlist/denylist 是 scanner 层策略，不是 AI prompt。

### Manual / Chat

`ManualChatSource` 将用户输入保存为 conversation Evidence。`DeterministicFactExtractor` 是无外部服务的 V0.1 fallback；它只返回可验证 schema 的 candidates。未来的 `ProviderFactExtractor` 通过 `AIProvider` 接入任何 OpenAI-compatible、Gemini、Claude、DeepSeek 或 local model，但 provider 输出必须先经过 `validateFactExtractionOutput`。

## Privacy 与失败策略

- Source 原始输入留在本地 storage；导出前由用户决定是否携带 local path。
- `AIProvider` 接收的是显式传入的 normalized evidence，不默认获得整个 repository 或 raw secret material。
- 网络错误、Git 命令错误和 schema 错误应显式失败；不能以空事实静默掩盖扫描失败。
- Source 的重复运行使用稳定 evidence id，storage 通过 upsert 保持可重复导入。

## 新 Source checklist

1. 定义 request/discovery/scan 类型。
2. 实现 `discover → scan → extractEvidence`。
3. 为每类 Evidence 设计稳定 `id`/`sourceId`。
4. 分离 `raw` 与 `normalized` metadata。
5. 不产生 confirmed facts，不把 activity count 变成能力评价。
6. 增加 fixture、normalization test 和 privacy denylist test。
7. 在 docs 中说明哪些内容永远不离开本机。
