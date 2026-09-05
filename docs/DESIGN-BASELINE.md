# dsh-html-ui v1.0.0 — 设计基线（P0 开工前）

## 宿主契约核实（0.1.2-rc.1 实测，浏览器实际加载的 bundle）

| 契约 | 真实形态（证据） | 用途 |
|---|---|---|
| 代码块表面 | `.md-code-block`（web-frontend dist CodeBlock 组件） | 围栏发现 |
| 行锚点 | `data-chat-anchor-key`（chat bundle: `"data-chat-anchor-key": routedNode.key`） | 行身份/范围过滤（F8） |
| 行 kind | `data-chat-flow-kind`（= user/assistant/steering…） | assistant 判定 |
| 流式标记 | `data-streaming`（AssistantMarkdown 根：`"data-streaming": streaming \|\| void 0`） | 闭合判定（架构决策 2b） |
| KaTeX 资产 | 旧版 `bundle/lib/assets/katex/`（katex.min.js/css + 20 字体 + SHA256SUMS）可复用 | 公式通道 |

> 注意：`data-streaming`/`data-chat-anchor-key` 不在 web-frontend dist，而在
> **dsh-client-ui-chat 的 client bundle**（经 /plugins 组合加载）—— 第一轮搜索
> 落空即因此。已从运行服务器/安装物双重确认。

## F1–F10 → 对策映射

| # | 缺陷 | v2 对策 | 落点 |
|---|---|---|---|
| F1 | 流式 450ms srcdoc 重载 | 流式期间禁止 srcdoc 写入；闭合前保持原代码块 | scheduler 闭合判定 + frame.mount |
| F2 | 内容启发式漏判 | 确定性接管：assistant 行内 ```html/```dsh-html 一律接管 | wantsTakeover 重写 |
| F3 | 单 $ 误伤 | 只处理 $$…$$/\[…\]/\(…\)；latex:false 关闭 | replaceLatex + config |
| F4 | 400ms 高度轮询 | ResizeObserver+MO+fonts.ready+rAF 双帧，零定时器 | HtmlFrame 测高 |
| F5 | 流式全量 sweep | 闭合判定不读内容；observer 记录变更目标向上定位；1s 兜底 | scheduler 变更追踪 |
| F6 | 裸片段通道 | 删除；围栏唯一协议 | 不实现 |
| F7 | 外链 http/https | img-src data: blob:；allowRemoteImages 才加 https: | CSP builder |
| F8 | 工具卡误伤 | 仅 assistant 行内；closest('[data-chat-anchor-key]') 且 kind=assistant | 范围过滤 |
| F9 | 30s 假结算 | 渲染前提=已闭合（结构判定）；无时间假结算 | 闭合判定 |
| F10 | inject 硬激活 | inject 最小化；其余 ctx.inject 可选 | client-wrapper |

## 性能预算（验收硬指标）
- 流式长 HTML：单次 sweep <5ms；srcdoc 写入 = 0
- 空闲：零定时器零 CPU
- 接管：闭合判定满足后 1 帧内

## 结构
```
dsh-html-ui/
├── src/kernel.js         L1 内核（工厂，零依赖）
├── src/pure.js           纯函数（csp/闭合判定/latex/hash）
├── src/entry.js          页面级 IIFE（__dshHtmlUi 命名空间）
├── src/client-wrapper.js L3 ModuleLoader 包装（inject 最小化 + 可选注入）
├── bundle/               build.mjs 产出（index.js/client.js/assets/skills）
├── tools/build.mjs      esbuild 构建
├── test/                vitest（纯函数 + DOM 冒烟 + 安全样本）
├── e2e/                 Playwright 静态宿主复刻（P1）
└── skills/dsh-html-ui/SKILL.md（风格库 A-E + 机械设计 C 示例）
```
