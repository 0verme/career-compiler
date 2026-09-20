# Career Compiler

> **Career Compiler is not another AI resume builder.**
>
> **Compile your work into a career.**

Career Compiler 是一个 local-first、evidence-backed 的 Career Data Engine。用户维护的不是一份 Resume JSON，而是可追溯的职业证据、职业事实和 Career Profile：

```text
GitHub + Local Git + Conversation + AI Session
        ↓
      Evidence
        ↓
   Career Facts
        ↓
 Career Achievements
        ↓
      Career IR
        ↓
Resume.md + GitHub Profile README.md
```

## V0.1 已提供

- TypeScript + pnpm workspace 工程骨架
- `CareerEvidence`、`CareerFact`、`CareerAchievement`、`CareerProfile`、`CareerIR` 等 Core Domain
- `Fact → Achievement` deterministic 编译层：Problem / Constraint / Decision / Action / Result 组件、component 级 `factRefs`、`evidenceRefs` 与 confirmation boundary
- Evidence 与 Fact 的多对多 provenance link
- `candidate` / `confirmed` / `rejected` / future statuses
- SQLite local storage（Core 不依赖 SQLite）
- GitHub REST metadata source：profile、repository、languages、topics、commits、issues、PR metadata
- GitHub Identity Attribution：区分 owned、authored、contributed、context；fork 默认 context-only
- External authored PR discovery：受 `maxExternalContributions` 限制，不把 activity count 当作能力评分
- Local Git source：显式授权目录、repository metadata、branch、remote、history metadata、contributors、languages、README metadata、tags
- Manual / Chat source：deterministic/mock fact extraction 与可替换 `AIProvider` contract
- AI Session source：消费 AIUsage 归一化的 Codex / Claude Code / Pi session contract，生成 session / message 级 Career Evidence（含 source path + line range provenance）
- Target Job domain：稳定 ID、可选 company、title、逐字保存的 raw JD 与 `rawJdHash`，持久化到独立 `target_jobs` 表；`target add/list/show/update` CLI 可管理多个目标岗位
- JD Requirement Parser：deterministic 规则把 raw JD 解析为可追溯的 `JdRequirement`（category / priority / statement / 逐字 `rawQuote` + 定位 / confidence），默认 `parsed`，支持 list / confirm / reject / edit 与 stale 识别；只理解岗位文本，不匹配职业证据
- Resume Compilation 层：内容寻址 `ResumePatchProposal`、deterministic structural `CompilationStrategy`、`ResumeVariant` 与最小 `CompilationSnapshot`；只有 draft 且 `baseIrHash`（canonical SHA-256）与当前 CareerIR 一致的 proposal 才能 apply，apply / reject / revert 不修改 Career Truth
- Markdown Resume renderer
- Markdown GitHub Profile renderer
- versioned Career IR JSON export/import（当前 `0.2`，加载 `0.1` 文档时显式迁移）
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
career-compiler target add --title "Data Platform Lead" --company "某券商" --jd-file jd.md
career-compiler target list
career-compiler target show <target-job-id>
career-compiler target update <target-job-id> --jd-file jd-v2.md
career-compiler jd parse <target-job-id>
career-compiler jd list <target-job-id>
career-compiler jd confirm <requirement-id>
career-compiler jd edit <requirement-id> --category domain --priority preferred --statement "..."
career-compiler compile propose --target <target-job-id> --hide-achievement <achievement-id> --section-order skills,achievements,summary,experience,projects
career-compiler compile apply <proposal-id>
career-compiler render resume --variant <variant-id> --output resume.md
career-compiler compile revert <snapshot-id>
career-compiler render resume --output resume.md
career-compiler render github-profile --output github-profile.md
```

`target add` / `target update` 的长文本 raw JD 可以来自 `--jd-file <path>`、`--jd-file -` 或 stdin；`target list` 不打印 JD 正文。Target Job 的边界见 [Target Job](docs/architecture/target-job.md)。

也可以从 workspace 运行：

```bash
pnpm --filter @career-compiler/cli start scan local ./workspace --json
pnpm --filter @career-compiler/cli start scan ai-session ./normalized-sessions.jsonl --json
pnpm --filter @career-compiler/cli start scan github <username>
pnpm --filter @career-compiler/cli start scan github 0verme --max-repositories 5 --max-external-contributions 10 --json
```

`scan ai-session` 的输入是 AIUsage 归一化后的 session bundle（`ai-session-bundle/1`）；它只写入 Career Evidence，不生成 candidate fact，默认不把绝对路径与 tool arguments 写入 evidence。格式与 privacy 选项见 [Source contract](docs/architecture/source-contract.md)。

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
- Achievement 是 confirmed facts 的确定性编译单元，只负责组织结构化信息（Problem / Constraint / Decision / Action / Result）与 provenance；缺字段保持为空，不编造数字、结果或技术决策。
- 未确认的 AI/Mock 结果只能进入 `candidate`，Profile projection 只使用 `confirmed` facts。
- Candidate promotion 只使用高置信度 attribution；context-only repository activity 不直接产生 CareerFact。
- AI 可以 extract、classify、summarize、suggest，但不会静默改写 confirmed history。
- Local Git 默认只读取 metadata 与受限 README 摘要，不把源码递归上传给 LLM；scanner 有 allowlist/denylist，并排除 secrets、依赖、Git objects、binary 与 build/cache artifacts。
- AI Session source 不解析 vendor JSONL、不扫描磁盘，只消费上游归一化的 session contract；本地 session 尚无可靠 identity 绑定，因此统一标记 `context`，停在 Evidence 层。
- Renderer 只消费 Career IR，不理解 GitHub、Pi、Claude 或 Local Git 的来源细节。
- Target Job 是目标上下文，不是职业事实：它单独存储，不进入 Career IR，也不会因为保存或修改 JD 而改写 CareerFact / CareerAchievement / CareerProfile。修改 raw JD 只会改变 `rawJdHash`，作为未来派生分析 stale 的基础。
- JD Requirement Parser 只把 raw JD 理解为可审阅的 candidate requirement：解析结果默认 `parsed`，只有用户 confirm 后才能进入正式匹配；`rawQuote` 逐字保留且可定位，解析失败不留半成品。完整语义见 [JD Requirement Parser](docs/architecture/jd-requirement.md)。
- Resume Compilation 只做可审阅的结构投影：proposal 不修改 Career Truth，variant 只记录选择 / 顺序 / 可见性 / 强调；stale proposal 与 stale variant 都会被拒绝。完整语义见 [Resume Compilation](docs/architecture/resume-compilation.md)。

## 暂不实现

V0.1 明确不包含 Web Dashboard、Tauri、PDF/DOCX、OAuth、LinkedIn/X、ChatGPT/Claude/Pi/Codex raw history scanner（只消费 AIUsage 归一化 contract）、Vector DB、RAG、Knowledge Graph、MCP、账号系统、云同步、SaaS backend、自动发布 GitHub README。

Target Job 目前做到 domain + storage + minimal CLI；JD Requirement Parser 已提供 deterministic 解析与 review 流程；Resume Compilation 已提供 structural proposal / variant 与最小回退。当前仍不做 LLM/prompt/embedding、不做 Evidence Matcher / JD Evidence Matrix / Gap、不做 ATS 分数或职位抓取；AI rewrite、PDF/DOCX 与完整 presentation 契约也不在本轮。下一阶段是 `confirmed Requirement → Evidence Matcher`（#17）。

## 文档

- [Architecture overview](docs/architecture/overview.md)
- [Career IR](docs/architecture/career-ir.md)
- [Target Job](docs/architecture/target-job.md)
- [JD Requirement Parser](docs/architecture/jd-requirement.md)
- [Resume Compilation](docs/architecture/resume-compilation.md)
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
