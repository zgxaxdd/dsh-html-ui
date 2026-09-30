# dsh-html-ui v4.0.0（DSH profile bundle）

在 DeepSeek Harness 聊天流内联渲染任意 HTML 的插件：` ```html `（或 ` ```dsh-html `）围栏 → 沙箱 iframe 真渲染（本地交互脚本、块级 KaTeX 公式、主题自适应、事件驱动高度）。v3 起模型可通过 **`dsh_html_check` 工具在输出前自查围栏源码**；v4 起**修复版源码直接进回执**（`repaired_html`），且**渲染失败的围栏会在同一回合收到一次修正通知**，从"人肉复制修复提示"变成"模型自动重发对的围栏"。

```sh
dsh plugin --profile web add dsh-html-ui
# 本地迭代：
dsh plugin --profile web add link:<本目录绝对路径>
# 卸载：
dsh plugin --profile web remove dsh-html-ui
```

版本史见 [CHANGELOG.md](CHANGELOG.md)；v3 评估与设计决策见 [docs/V3-DESIGN.md](docs/V3-DESIGN.md)，v4 设计决策见 [docs/V4-DESIGN.md](docs/V4-DESIGN.md)。

## 兼容性

| 项 | 声明 |
|---|---|
| 目标宿主 | `@deepseek-ai/dsh >= 0.1.7-alpha.2 < 0.3.0-0`（契约在 0.1.7 与 0.2.x 类型声明上逐项复核） |
| Node | `^22.19.0 \|\| >= 24.0.0`（`dsh plugin` 依赖 pnpm ≥11.7） |
| 宿主契约 | `window.__ModuleLoader__.load` · `dsh.bundle.patch` · `dsh.client.*` · `systemPrompt.section` · `systemPrompt.getSectionOrder` · `skills.registerProvider` · **`tools.register`** · `webServer.register` · `ctx.reflect.get` · `internal/service` · **`session/event` · `session/disposed` · `agent/turn-stopping` · `agent.steer`** |
| DOM 契约 | `.md-code-block`/`.code-block`/`.code-block-small` · `data-streaming` · `data-chat-anchor-key` · `--dsw-alias-*` |
| 兼容承诺 | **v1/v2/v3 围栏写法零破坏**；v4 新能力（meta `full`、`repaired_html`、自修通知）全部可选/兜底 |

## v4 能力总览

1. **围栏自修反馈环** ⭐：回合结束时校验本回合围栏，不可渲染者按"每回合一次、每围栏一次、子代理不触发、可取消"的边界，把带诊断+修复版源码的修正通知 steer 回同一回合——模型趁用户还看着原文时重发对的围栏。借鉴 dsh-genui issue #160。
2. **`dsh_html_check` 升级**：参数容错（字符串 / `{"html":…}` / `{arguments:…}` / 裸 JSON 串，防宿主工具桥形状漂移）；回执新增 `next` 动作与 `repaired_html`（**把修好的源码交给模型，比重写一遍更不容易再出错**）；新增工具卡标题。
3. **规则集 4（ruleSet 4）**：诊断携带行号（`div@L12`）；新增 `W-LINE-LIMIT`（行数软上限，meta `{"full":true}` 放宽到 500）、`W-DOCTYPE`（骨架噪声）；`lib/validate.mjs` 与 `lib/client.js` 内嵌实现由 parity 测试逐用例锁死。
4. **`repairHtml()` 自动修复**：删除多余闭合标签、补齐未闭合标签（含 `script/style` raw-text）；产出"可直接采用"的修复版，注入诊断条「复制修复提示」与回执 `repaired_html`。
5. **白名单式无标签回退**（客户端）：只放行宿主"通用代码块"标签（Code / Code block / 代码块）且正文完整通过 render 前校验的围栏——不再因为"长得像 HTML"就接管普通代码块。借鉴 dsh-genui `isGenericGenuiFence`。
6. **围栏位置红线**：常驻契约明确"围栏只写回答正文，写在 reasoning/思考块里不渲染"（dsh-genui 同款真实教训）。
7. **systemPrompt 节序自适应**：优先 `getSectionOrder('STRUCTURED_OUTPUT')`，取不到回退 106。
8. 既有能力：last-good 保留上次成功渲染、懒渲染（IntersectionObserver）、自适应扫描（1s→4s 退避）、多表面围栏发现、自包含导出（随附源码）、en/zh 本地化、无障碍补全。

## 架构（两半 + 共享规则集 + 反馈环）

- **Host 半边**（`lib/index.js`）：KaTeX 资产路由（immutable）+ systemPrompt 硬契约（STRUCTURED_OUTPUT 位，已按渐进披露精简至 562 字符）+ `dsh_html_check` 工具注册 + **`installFenceFeedback` 反馈环** + 打包 skill。
- **反馈环**（`lib/feedback.mjs`）：围栏抽取（info string 精确匹配）→ 指纹（sha256/12）→ 失败诊断（与渲染器同一 `validateRaw`）→ 修正文本（协议块 + 修复版源码）→ `agent/turn-stopping` 边界 steer（先入账后发送，标记幂等）。
- **共享校验器**（`lib/validate.mjs`）：同构纯函数，规则集 v4（meta 解析、行号诊断、`repairHtml` 修复表）；宿主工具、反馈环、浏览器端与测试共用。
- **Client 半边**（`lib/client.js`）：内嵌同一校验器（由 `test/embed-validate.mjs` 同步，`test/parity.test.mjs` 逐用例锁死）→ 内核（KaTeX/沙箱 iframe/高度 postMessage/主题/工具栏/懒渲染）→ 调度器（多表面发现/白名单回退/settle 检测/自适应扫描）→ wrapper（theme/locale 接入）。
- **安全边界**（显式声明，防后续迭代误放松）：iframe `sandbox="allow-scripts"` + CSP `default-src 'none'`（禁网/禁表单/禁父页）；高度消息经 `ev.source === iframe.contentWindow` 严格配对；导出文件沿用 tab 模式 CSP。

## 校验回执（规则集 4）

| 码 | 含义 | 修复 |
|---|---|---|
| `E-EMPTY` / `E-SIZE` | 空内容 / >1MB | 补齐 / 拆分 |
| `E-UNCLOSED` | 标签未闭合（`标签@行号`） | 补配对闭合标签 |
| `E-STRAY-CLOSE` | 多余闭合标签（`标签@行号`） | 删除或配对 |
| `W-IMPLICIT-CLOSE` | 结构标签隐式闭合 | 显式闭合 |
| `W-SCRIPT-EXT` / `W-SCRIPT-NET` | 外链脚本 / 网络 API | 内联脚本 / 本地计算 |
| `W-EXT-IMG` / `W-INLINE-EVENT` | 外链图 / 行内事件 | 内联 SVG / addEventListener |
| `W-META-INVALID` | meta 头 JSON 非法 | 修正或删除 |
| `W-IFRAME` | 内嵌 iframe | 移除平铺 |
| `W-LINE-LIMIT` | 行数超上限（`行数/上限`） | 拆分或精简；整页写 `{"full":true}` |
| `W-DOCTYPE` | HTML 骨架噪声 | 移除 `<!doctype>/<html>/<head>/<body>` |

`next` 动作：`emit_fence` / `fix_warnings_then_emit` / `emit_repaired_html` / `fix_and_revalidate`。

## 关闭反馈环

```jsonc
// dsh 插件配置（profile 级）
{ "fenceFeedback": false }
```

关闭后仍保留浏览器诊断条与 `dsh_html_check` 自查；仅不再自动 steer 修正通知。

## 开发与回归

```sh
npm run check        # 语法（index/client/validate/feedback）
npm test             # feedback + validate（v4 含 repairHtml）+ parity（双实现 29 例）+ load（工具/版本/反馈环/schema/skill 范例）
node test/embed-validate.mjs   # 修改 lib/validate.mjs 后同步进 client.js
npm run verify:pack  # 打真 tarball 自检（必含清单/禁止清单/体积上限）
```

全局调试：`window.__dshHtmlUi.stats()` / `.validate(raw)` / `.repair(raw)`。

## 从 v3 升级

```sh
dsh plugin --profile web remove dsh-html-ui
dsh plugin --profile web add link:<本目录绝对路径>
# 重启 dsh web + 浏览器强刷，新开会话
```

v3 写法全部有效；验证升级成功：console 见 `client active; v4`，模型工具列表出现 `dsh_html_check`（回执带 `repaired_html`/`next`）。

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)（v1.0.0 / v2.0.0 / v3.0.0 / v4.0.0 全史）。
