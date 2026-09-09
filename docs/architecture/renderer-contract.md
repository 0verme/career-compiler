# Renderer Contract

## 稳定接口

Core 定义：

```ts
interface CareerRenderer<TOptions extends RendererOptions = RendererOptions> {
  readonly rendererId: string;
  readonly format: 'markdown';
  render(ir: CareerIR, options?: TOptions): RenderedArtifact;
}

interface RenderedArtifact {
  rendererId: string;
  format: 'markdown';
  fileName: string;
  content: string;
}
```

V0.1 的两个 renderer 也接受 `CareerProfile` 作为 convenience input，并在内部包成最小 Career IR；正式 pipeline 应传入完整 `CareerIR`。

## 设计规则

- Renderer 只消费 `CareerIR.profile` 的规范化 profile projection。
- Renderer 不查询 SQLite、不调用 Source、不调用 AI。
- Renderer 不读取 candidate/rejected facts 来填充输出。
- 输出不包含动态生成时间，确保相同 IR 产生相同 Markdown。
- template 是 presentation extension；`{{name}}`、`{{projects}}` 等 token 不改变 Core 数据。
- 新格式（HTML、PDF、DOCX）应新增 renderer package，不把格式字段加入 Core。

## V0.1 实现

### Resume Markdown

`@career-compiler/renderer-resume` 输出：

- Summary
- Experience
- Projects
- Skills
- Achievements

### GitHub Profile Markdown

`@career-compiler/renderer-github-profile` 输出：

- About
- What I'm Building
- Selected Projects
- Skills / Focus Areas
- GitHub project links

两个 renderer 使用同一份 `CareerIR`，没有 Resume-only fields 污染 Core。

## Determinism test

Renderer test 应固定 `exportedAt` 与 fixture input，连续两次 render 比较完整 content；不要用当前时间插入正文。template test 应验证 token 被替换且 output 不保留 `{{...}}`。
