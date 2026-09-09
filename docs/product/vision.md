# Product Vision

## 一句话

**Compile your work into a career.**

Career Compiler 不是帮用户临时生成一份 Resume 的 AI Chat。它长期维护一份有证据、有状态、可迁移的职业事实库，再从同一份 Career Profile 生成不同职业输出。

## Source of truth

```text
Career Sources
  → Career Evidence
  → Candidate / Confirmed Career Facts
  → Career Profile / Career IR
  → Resume / GitHub README / Portfolio / Bio / Interview Material
```

用户不应该分别维护 Resume、GitHub Profile README、Portfolio 和 Bio。它们是 presentation；source of truth 是 Evidence + Facts + Profile。

## 产品原则

1. **Career Data First**：先维护结构化职业事实，再生成输出。
2. **Evidence-backed**：每个 fact 都必须能回到一个或多个 evidence。
3. **Human confirmation**：AI 可以建议，不能静默重写 confirmed history。
4. **Local-first**：原始文件尽量留在本机，scanner 默认排除 secrets 和源码上传。
5. **Plugin boundaries**：Source 与 Renderer 都通过稳定 contract 扩展。
6. **Portable data**：Career IR 有 schema version，可以 export/import 与未来迁移。

## 长期方向（非 V0.1 承诺）

更多 Career Sources、可编辑 Profile UI、更多 renderer、冲突/重复管理、可选远程 AI provider，以及用户主动控制的同步能力都可以建立在现有边界上。但它们不能削弱 Evidence provenance 或让 AI 成为数据库 owner。
