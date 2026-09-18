# `@career-compiler/renderer-resume`

将同一个 versioned Career IR 渲染为可重复生成的 Markdown resume。Presentation 文案留在 renderer/template 层，不进入 Core Domain。

Achievement section 直接呈现 `CareerProfile.achievements` 中已存在的结构化组件（Problem / Constraint / Decision / Action / Result）；renderer 不读取 facts，也不推断 achievement。
