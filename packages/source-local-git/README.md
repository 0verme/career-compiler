# `@career-compiler/source-local-git`

面向用户显式授权目录的 privacy-first Git scanner。只提取 repository metadata 和 Git history metadata；默认跳过 secrets、依赖目录、Git objects、binary、build/cache artifacts，不上传源码。通过 `CareerIdentity` 的 Git author names/emails 匹配 commit：匹配为 `authored`，未匹配为 `context`，没有 identity 时为 `unknown`。
