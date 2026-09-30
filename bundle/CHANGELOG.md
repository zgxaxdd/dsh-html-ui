# Changelog — dsh-html-ui

本项目遵循语义化版本；围栏书写契约（v1 起）保持向后兼容，新能力一律可选。

## [4.0.0] - 2026-09-30

自迭代升级（评估 → 开源调研 → 设计 → 实施）。上游参考：[omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui) main @ `ffb89fd`（v0.11.3，27 tags / 460 commits），逐项核验后可移植的做法，完整决策记录见 [docs/V4-DESIGN.md](docs/V4-DESIGN.md)。

### 新增
- **围栏自修反馈环**（旗舰）：回合结束时按渲染器同一 `validateRaw` 校验本回合围栏，不可渲染者把「诊断 + 可直接采用的修复版源码」steer 回**同一回合**（`agent/turn-stopping` + `agent.steer`），模型趁用户还看着原文时重发对的围栏。边界与 dsh-genui issue #160 同款：默认开启（`fenceFeedback:false` 可关）、每回合一次、每围栏正文一次（内容指纹 sha256/12）、子代理不触发、取消即退、指纹先入账后发送。新增 `lib/feedback.mjs`（Host 半边，纯 Node）。
- **`repairHtml()` 自动修复**（共享校验器）：删除多余闭合标签、补齐未闭合标签（含 `script/style` raw-text，按栈序），产出"可直接采用"的修复版源码；诊断条「复制修复提示」与工具回执 `repaired_html` 共用。
- **`dsh_html_check` 回执新增 `next` 动作表**（`emit_fence` / `fix_warnings_then_emit` / `emit_repaired_html` / `fix_and_revalidate`）与 **`repaired_html`** 字段——把修好的源码交给模型，而不是让它就诊断描述自己重写（重写才会引入下一个错）。
- **规则集 4 新诊断**：`W-LINE-LIMIT`（行数软上限 250，meta `{"full":true}` 放宽到 500）、`W-DOCTYPE`（`<!doctype>/<html>/<head>/<body>` 骨架噪声）；所有结构诊断携带行号（`div@L12`）。
- **工具参数容错**：`dsh_html_check` 接受字符串 / `{"html":…}` / `{arguments:…}` / 裸 JSON 串——宿主工具桥真实观测到过多层包装形状（dsh-genui tool.ts 同款教训）；新增 `presentCall`/`presentResult` 工具卡（「检查 dsh-html 围栏」）。
- **工程资产**：`scripts/verify-pack.mjs`（打真 tarball 自检：必含清单 / exports 目标遍历 / 禁止清单 / 体积上限）、`LICENSE`（MIT）、`.npmrc`、`.gitignore`、`.github/workflows/ci.yml`（Node 22/24 双档 + Windows 打包 job）。
- **meta 头第二个键** `full: true`：整页交付物声明，行数上限 250 → 500。

### 兼容性
- `engines.dsh` 拓宽为 `>=0.1.7-alpha.2 <0.3.0-0`（覆盖 DSH 0.1.7-alpha.x 与 0.2.x 列车，排除未来 0.3 破坏性变更；上游 dsh-genui 0.11.3 同款策略）；`engines.node` 拓宽为 `^22.19.0 || >=24.0.0`；`engines.pnpm` 声明 `>=11.7.0 <12`。
- systemPrompt 节序自适应：优先 `ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT')`（宿主集中分配的结构化输出位），取不到回退 106——固定 order 在宿主改版后会落到错误分组。
- webServer 资产路由保持双通道（`reflect.get` + `internal/service` 兜底），0.1.7 与 0.2.x 宿主均验证可用。

### 变更
- 常驻 systemPrompt 契约重写（562 字符）：新增**围栏位置红线**（只写回答正文；写在 reasoning/思考块里不渲染、用户看不到——上游 genui 两次真实会话踩坑）与 `repaired_html` 指引；风格库/错误码表/`next` 动作表仍全部在 SKILL.md 按需加载（渐进披露）。
- 客户端无标签代码块回退收紧为**白名单式**（借鉴 dsh-genui `isGenericGenuiFence`）：只放行宿主"通用代码块"标签（Code / Code block / 代码块）且正文完整通过 render 前校验的围栏；不再因"长得像 HTML"接管普通代码块（易误接管 xml/json 等代码）。`config.inferUnlabeled=false` 仍可完全关闭。
- SKILL.md 升级到 v4 协议：`next` 动作表、`repaired_html` 采用指引、自修通知处置约定、新错误码两行、meta `full`。
- 调试 API `window.__dshHtmlUi` 新增 `repair(raw)`。

### 测试
- `test/feedback.test.mjs`（新增，18 断言）：围栏抽取（info string 精确匹配 / ≤3 空格缩进 / 上限 40）/ 指纹稳定性 / 失败诊断 / 修正文本协议块 / 消息形状与冻结 / 标记识别 / 规划器全部边界（每回合一次、每围栏一次、取消、空文本、健康围栏）。
- `test/validate.test.mjs`：升级到规则集 4，新增行号诊断、`W-LINE-LIMIT`（含 `full` 放宽与 500 封顶）、`W-DOCTYPE`、`repairHtml` 6 例（unclosed / stray / raw-text / noop / empty / oversize）。
- `test/parity.test.mjs`：双实现一致性扩到 29 例，新增 `repairHtml` 双实现逐用例比对（诊断与修复同源）。
- `test/load.test.mjs`：版本一致性（4.0.0）、反馈环三事件订阅、`getSectionOrder` 优先、工具 schema 子集、`next`/`repaired_html`/参数容错/工具卡断言、SKILL.md v4 内容与范例数量。
- `test/embed-validate.mjs`：同步说明更新到 v4 规则集。

## 3.0.0

自迭代升级（评估 → 开源调研 → 设计 → 实施，完整记录见 [docs/V3-DESIGN.md](docs/V3-DESIGN.md)）。

### Added
- **`dsh_html_check` 模型侧自查工具**（旗舰）：宿主注册，模型输出复杂围栏前自查源码，返回与浏览器渲染器完全一致的结构化校验回执（稳定错误码 + `fix` 修复指令）。借鉴 dsh-genui `validate_dsh_ui`、archify `validate --json`、Mermaid parse/render 分离。
- **可选 meta 头** `<!--dsh-html {"title":"…"}-->`：导出文件名 / iframe 可访问名 / 工具栏标识；未知键容忍，JSON 非法仅警告（`W-META-INVALID`）。借鉴 archify typed IR 的轻量迁移。
- **修复回执面板 v3**：诊断条带错误码徽章 + 「复制修复提示」一键生成模型可读修复指令 + last-good 标识。
- **共享校验器 `lib/validate.mjs`**（宿主/测试共用同一规则集）+ `test/embed-validate.mjs` 同步工具 + **`test/parity.test.mjs` 双实现逐用例一致性测试**。
- **懒渲染**：视口外挂载推迟 `srcdoc` 注入（IntersectionObserver），长会话零浪费。
- **导出增强**：meta.title 命名文件与 `<title>`；导出文件内附围栏源码（`</` 转义为 `<\/`，可还原）。
- **CHANGELOG.md** + 版本一致性测试（package.json ↔ index.js ↔ client.js 三处同源断言）。
- 新校验码：`W-META-INVALID`、`W-IFRAME`；回执携带 `ruleSet: 3` 与每条 `fix`。

### Changed
- systemPrompt 常驻契约精简（~567 → ~330 字符）：硬约定与自查工具指引常驻，风格库/错误码表/示例移交 SKILL.md 按需加载（渐进披露）。
- SKILL.md 重写为分层结构（速览 → 自查 → 错误码 → 渲染事实 → 风格库 → 示例 → 红线），新增 `dsh_html_check` 与 meta 头教学。
- 调度器扫描自适应：活跃期 1s，连续静默退避至 4s（零 CPU 空闲承诺覆盖长会话）。
- 校验回执结构化：`{code, detail, fix}` + 确定性排序。

### Fixed
- 诊断条在 last-good 保留时明确标注（此前静默保留）。
- dispose 改用 `clearTimeout` 与自适应扫描计时器精确配对。

## 2.0.0

### Added
- 渲染前原子校验 + 修复回执（`E-EMPTY/E-SIZE/E-UNCLOSED/E-STRAY-CLOSE`，警告 `W-…`），错误回退源码视图。
- last-good：重渲失败保留上一次成功渲染。
- 多表面围栏发现（`md-code-block`/`code-block`/`code-block-small`）+ 宿主 DOM 漂移一次性告警。
- 无语言标签代码块结构识别（DSH 0.1.7 generic banner 兼容，`config.inferUnlabeled` 可关）。
- 自包含导出（工具栏「下载」.html）。
- 激活自检日志 + 调试 API（`window.__dshHtmlUi.stats()/validate()`）。
- 无障碍补全（aria-live、focus-visible、prefers-reduced-motion）。
- `engines`/`manifestVersion` 声明；回归测试随包（`test/`）。

### Fixed
- SVG 自闭合元素误入标签栈导致的误报；可选闭合标签（li/p/td…）触发的噪声警告。

## 1.0.0

### Added
- 初版：`html`/`dsh-html` 围栏接管渲染（沙箱 iframe + CSP）、本地交互脚本、块级 KaTeX、主题/语言接入、事件驱动高度、工具栏（源码/预览/新标签/复制/重载）、SKILL.md 风格库 A–E、KaTeX 资产路由、打包 skill。
