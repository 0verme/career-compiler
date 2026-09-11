# Career Compiler

> **Career Compiler is not another AI resume builder.**
>
> **Compile your work into a career.**

Career Compiler 是一个 local-first、evidence-backed 的 Career Data Engine。用户维护的不是一份 Resume JSON，而是可追溯的职业证据、职业事实和 Career Profile：

```text
GitHub + Local Git + Conversation
        ↓
      Evidence
        ↓
   Career Facts
        ↓
      Career IR
        ↓
Resume.md + GitHub Profile README.md
```

## V0.1 已提供

- TypeScript + pnpm workspace 工程骨架
- `CareerEvidence`、`CareerFact`、`CareerProfile`、`CareerIR` 等 Core Domain
- Evidence 与 Fact 的多对多 provenance link
- `candidate` / `confirmed` / `rejected` / future statuses
- SQLite local storage（Core 不依赖 SQLite）
- GitHub REST metadata source：profile、repository、languages、topics、commits、issues、PR metadata
- GitHub Identity Attribution：区分 owned、authored、contributed、context；fork 默认 context-only
- External authored PR discovery：受 `maxExternalContributions` 限制，不把 activity count 当作能力评分
- Local Git source：显式授权目录、repository metadata、branch、remote、history metadata、contributors、languages、README metadata、tags
- Manual / Chat source：deterministic/mock fact extraction 与可替换 `AIProvider` contract
- Markdown Resume renderer
- Markdown GitHub Profile renderer
- versioned Career IR JSON export/import
- Alice synthetic golden path fixture

## 快速开始

要求：Node.js `>=22.5.0`、pnpm `>=10`。

```bash
pnpm install
pnpm build
pnpm demo
```

Golden path 会生成：

- `examples/fixtures/alice/candidate-facts.json`
- `examples/fixtures/alice/confirmed-facts.json`
- `examples/fixtures/alice/career-ir.json`
- `examples/output/resume.md`
- `examples/output/github-profile.md`

CLI 使用前先运行 `pnpm build`：

```bash
career-compiler add "我负责一个18人的湖仓团队，上游180多个系统，下游120多个系统。"
career-compiler facts list candidate
career-compiler facts confirm <fact-id>
career-compiler render resume --output resume.md
career-compiler render github-profile --output github-profile.md
```

也可以从 workspace 运行：

```bash
pnpm --filter @career-compiler/cli start scan local ./workspace --json
pnpm --filter @career-compiler/cli start scan github <username>
pnpm --filter @career-compiler/cli start scan github 0verme --max-repositories 5 --max-external-contributions 10 --json
```

建议在配置文件中声明 identity 和扫描上限：

```json
{
  "identity": {
    "githubUsername": "0verme",
    "git": {
      "authorNames": ["Your Name"],
      "authorEmails": ["you@example.invalid"]
    }
  },
  "github": {
    "tokenEnv": "GITHUB_TOKEN",
    "maxRepositories": 20,
    "maxActivityItems": 10,
    "maxExternalContributions": 20
  }
}
```

Career Compiler **不认为 repository activity == user contribution**。GitHub repository 是 project context；Source 先根据声明的 identity 判断 attribution，再把 evidence 提升为 candidate facts。无法可靠确认的 activity 会保留为 `context`/`unknown`，而不是写入用户职业档案。

默认 SQLite 数据库位于用户级 application data 目录，不写入被扫描的 repository：

- Windows：`%APPDATA%/career-compiler/career-compiler.sqlite`
- macOS：`~/Library/Application Support/career-compiler/career-compiler.sqlite`
- Linux：`$XDG_DATA_HOME/career-compiler/career-compiler.sqlite` 或 `~/.local/share/career-compiler/career-compiler.sqlite`

可用 `--data-dir`、`CAREER_COMPILER_DATA_DIR` 或 `career-compiler.config.json` 覆盖。普通配置优先放在配置文件；GitHub token 只通过 `GITHUB_TOKEN`（或配置的 `tokenEnv`）读取，不会打印。

## 设计边界

- Source 只负责发现、扫描、抽取 Evidence；它不拥有 Career Facts。
- Evidence 是观察到的 metadata，Fact 是可审阅的规范化 claim；二者分开存储。
- 未确认的 AI/Mock 结果只能进入 `candidate`，Profile projection 只使用 `confirmed` facts。
- Candidate promotion 只使用高置信度 attribution；context-only repository activity 不直接产生 CareerFact。
- AI 可以 extract、classify、summarize、suggest，但不会静默改写 confirmed history。
- Local Git 默认只读取 metadata 与受限 README 摘要，不把源码递归上传给 LLM；scanner 有 allowlist/denylist，并排除 secrets、依赖、Git objects、binary 与 build/cache artifacts。
- Renderer 只消费 Career IR，不理解 GitHub、Pi、Claude 或 Local Git 的来源细节。

## 暂不实现

V0.1 明确不包含 Web Dashboard、Tauri、PDF/DOCX、OAuth、LinkedIn/X、ChatGPT/Claude/Pi/Codex history scanner、Vector DB、RAG、Knowledge Graph、MCP、账号系统、云同步、SaaS backend、自动发布 GitHub README。

## 文档

- [Architecture overview](docs/architecture/overview.md)
- [Career IR](docs/architecture/career-ir.md)
- [Source contract](docs/architecture/source-contract.md)
- [GitHub Identity Attribution](docs/architecture/github-attribution.md)
- [Renderer contract](docs/architecture/renderer-contract.md)
- [Product vision](docs/product/vision.md)
- [V0.1 scope](docs/product/v0.1.md)

## 开发命令

```bash
pnpm test       # build + 全量单元测试
pnpm typecheck  # TypeScript project references
pnpm lint       # ESLint
pnpm build      # TypeScript build
```

MIT License。
