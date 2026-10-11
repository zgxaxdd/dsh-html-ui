# Changelog

本文件记录**仓库级**版本史（根 manifest 与部署包 `bundle/` 同步发版）。
`bundle/CHANGELOG.md` 另有部署包自己的条目（含 `ruleSet`、回执协议等细节），两者版本号一致。

## [4.1.0] - 2026-09-30

性能 / 稳定性 / 可维护性升级。**围栏书写契约与对外行为不变**（v1–v4 写法全部有效）。
完整条目（每项附实测数据、修复依据与回归用例）见 [bundle/CHANGELOG.md](bundle/CHANGELOG.md) 的 `[4.1.0]` 一节；此处只列要点：

### 阻塞级
- **校验器的灾难性回溯（ReDoS 形状）**：正则版的标签扫描、注释掩码、meta 解析与公式掩码全部可被 1MB 内的畸形输入拖到分钟级（`<a "` × k 在 80 KB 时 1633 ms、`<!--` × k 203 ms）。四个正则**全部换成手写线性扫描**（`scanTags` / `maskSource` / `parseMeta` / 告警探测 / `looksLikeHtmlDoc`），并给标签扫描加**预算**（`4×正文长度 + 4096` 步），超出即报 `E-SCAN-LIMIT` 而不是给出可能改错结构的"修复版"。修复后同一批 80 KB 输入 4.1 / 0.1 / 1.7 / 1.1 ms，1MB 最坏形状 ≤ 31 ms。
- **等价性证明**：4000 条 `validateRaw` + 1500 条 `repairHtml` 与 v4.0.0 的正则实现逐条差分对比，**0 差异**；过程中抓出并修掉两个真实回归。CI 以 `test/validate.test.mjs` 的 6 条 ReDoS 形状用例防回归。

### 性能（按实测收益排序）
- 诊断行号：O(N) × 诊断数 → O(N) + O(log N)（1 MB 畸形围栏 + 200 条诊断：**153.4 ms → 4.1 ms**）。
- 流式期间不再为"未定稿"代码块做整篇校验（256 KB 块每秒曾白烧 121 ms 主线程）。
- 全文档扫描降为兜底（MutationObserver 已给出变更块），空闲仍为 0。
- `hasTagAttribute` 二次方（932 KB 曾 17 487 ms → 10 ms）；`looksLikeHtmlDoc` 二次方（112 KB 曾 3575 ms → 4 ms）。
- 资产路由：HEAD 不再回 body，补 `content-length` 与 `405 Allow`。

### 正确性与边界
- **HTML5 自闭合语义**：`<div/>` 在 HTML 内容里按开标签处理（只有外来内容 svg/math 才自闭合）——旧实现会把 `<div/>x</div>y` 的"修复版"改成 `<div/>xy`，**修复改变了渲染结果**。
- 注释 / CDATA / bogus comment / PI 里的标签不再被当成真标签（旧实现会把 `</div>` 修复**塞进注释里**）。
- raw-text 结束标签的其它合法形式（`</script/>`、`</script x>`）被正确识别。
- `extractHtmlFences` 不再在四反引号 / `~~~` 字面块里"发明"围栏；围栏抽取支持 CRLF/CR 行尾（旧实现 CRLF 回复**一个围栏都抽不到**，自修环静默跳过）；开围栏支持 3 个以上反引号。
- 自修环通道卫生：指纹白名单、修复版正文里的 ``` 不再提前闭合 steer 消息的代码块。
- 工具入参深度上限、反馈环监听器判空（模型入参属不可信输入）。

### 工程护栏
- `tools/build.mjs`（v1 构建链，会 `rmSync(bundle/)`）**默认拒绝执行**，需显式 `DSH_HTML_UI_ALLOW_V1_BUILD=1`。
- `node test/embed-validate.mjs --check`：内嵌校验段的同步从"跑一遍（永远成功）"变成可失败的检查，已接入 `npm test` 首步。
- 调度节奏可注入（`installScheduler` 的 `sweepMs` / `sweepMsSlow` / `quietSweepsStop` / `fullSweepEvery`），线上默认值不变。
- `npm test` 扩为 7 步；新增 `test/fence.test.mjs`（23 条）。

### 评估中确认"不必动"的项
- `katex.inline.css`（字体内联 data-URI）随 iframe srcdoc 内联：改外链需放宽 `font-src`/`style-src`，牺牲离线可用与 `connect-src 'none'`，收益仅是字符串长度——维持现状。
- `.code-block` / `.code-block-small` 选择器在当前宿主已不存在，保留为其它宿主兜底。
- `replaceLatex` 前进游标：当前规模下收益不可测，仅作最坏情况护栏保留。

## [4.0.0] - 2026-09-30

自迭代升级（评估 → 开源调研 → 设计 → 实施）。上游参考：[omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui) main @ `ffb89fd`（v0.11.3）；完整决策记录见 [docs/V4-DESIGN.md](docs/V4-DESIGN.md) 与 [bundle/docs/V4-DESIGN.md](bundle/docs/V4-DESIGN.md)。

### 新增
- **围栏自修反馈环**（旗舰）：回合结束时校验本回合 html/dsh-html 围栏，不可渲染者把「诊断 + 可直接采用的修复版源码」steer 回**同一回合**（`agent/turn-stopping` + `agent.steer`）。边界与 dsh-genui issue #160 同款：默认开启（`fenceFeedback:false` 可关）、每回合一次、每围栏正文一次（内容指纹 sha256/12）、子代理不触发、取消即退、指纹先入账后发送。新增 `bundle/lib/feedback.mjs`。
- **`repairHtml()` 自动修复**（共享校验器）：删除多余闭合标签、补齐未闭合标签（含 `script/style` raw-text）；产出"可直接采用"的修复版，注入诊断条「复制修复提示」与工具回执 `repaired_html`。
- **`dsh_html_check` 回执新增 `next` 动作表**（`emit_fence` / `fix_warnings_then_emit` / `emit_repaired_html` / `fix_and_revalidate`）与 `repaired_html` 字段——把修好的源码交给模型，而不是让它就诊断描述自己重写。
- **规则集 4 新诊断**：`W-LINE-LIMIT`（行数软上限 250，meta `{"full":true}` 放宽到 500）、`W-DOCTYPE`（骨架噪声）；所有结构诊断携带行号（`div@L12`）。
- **工具参数容错**：接受字符串 / `{"html":…}` / `{arguments:…}` / 裸 JSON 串；新增 `presentCall`/`presentResult` 工具卡。
- **工程资产**：`bundle/scripts/verify-pack.mjs`（真 tarball 自检）、`.github/workflows/ci.yml`（Node 22/24 + Windows 打包）、根 `npm test` / `check` / `verify:pack` 委托到 bundle。
- **meta 头第二个键** `full: true`：整页交付物声明，行数上限 250 → 500。

### 兼容性
- `engines.dsh` 拓宽为 `>=0.1.7-alpha.2 <0.3.0-0`（覆盖 DSH 0.1.7-alpha.x 与 0.2.x，排除未来 0.3 破坏性变更）；`engines.node` 拓宽为 `^22.19.0 || >=24.0.0`。
- systemPrompt 节序自适应：优先 `ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT')`，取不到回退 106。
- webServer 资产路由保持双通道（`reflect.get` + `internal/service` 兜底），0.1.7 与 0.2.x 均验证可用。

### 变更
- 常驻 systemPrompt 契约重写（562 字符）：新增**围栏位置红线**（只写回答正文；写在 reasoning/思考块里不渲染）与 `repaired_html` 指引。
- 客户端无标签代码块回退收紧为**白名单式**（借鉴 dsh-genui `isGenericGenuiFence`）：只放行宿主"通用代码块"标签（Code / Code block / 代码块）且正文完整通过 render 前校验的围栏。
- SKILL.md 升级到 v4 协议：`next` 动作表、`repaired_html` 采用指引、自修通知处置约定、新错误码。
- 调试 API `window.__dshHtmlUi` 新增 `repair(raw)`。
- 仓库布局：`bundle/` 成为部署真相源（v2.0.0 起 hand-maintained）；`src/`、`tools/`、`test/`、`e2e/`、`examples/`、`vendor/` 为 v1.0.0 遗产，保留供追溯，README 已注明。

### 测试
- `bundle/test/feedback.test.mjs`（新增，18 断言）；`bundle/test/validate.test.mjs` 升级规则集 4；`bundle/test/parity.test.mjs` 29 例双实现一致；`bundle/test/load.test.mjs` 覆盖版本一致性 / 反馈环三事件 / `getSectionOrder` / 工具语义 / SKILL 范例。`verify:pack` 通过（44 文件 / 656.8KB）。

## [3.0.0]

部署包自迭代升级（评估 → 开源调研 → 设计 → 实施，完整记录见 bundle/docs/V3-DESIGN.md）。

### Added
- **`dsh_html_check` 模型侧自查工具**（旗舰）：宿主注册，模型输出复杂围栏前自查源码，返回与浏览器渲染器完全一致的结构化校验回执（稳定错误码 + `fix` 修复指令）。
- **可选 meta 头** `<!--dsh-html {"title":"…"}-->`：导出文件名 / iframe 可访问名 / 工具栏标识。
- **修复回执面板 v3**：诊断条带错误码徽章 + 「复制修复提示」一键生成模型可读修复指令 + last-good 标识。
- **共享校验器 `bundle/lib/validate.mjs`**（宿主/测试共用同一规则集）+ `bundle/test/embed-validate.mjs` 同步工具 + parity 双实现逐用例一致性测试。
- **懒渲染**：视口外挂载推迟 `srcdoc` 注入（IntersectionObserver）。
- **导出增强**：meta.title 命名文件与 `<title>`；导出文件内附围栏源码，可再编辑。
- **CHANGELOG.md** + 版本一致性测试（package.json ↔ index.js ↔ client.js 三处同源断言）。

### Changed
- systemPrompt 常驻契约精简（~567 → ~330 字符）：硬约定与自查工具指引常驻，风格库/错误码表/示例移交 SKILL.md 按需加载（渐进披露）。
- 调度器扫描自适应：活跃期 1s，连续静默退避至 4s。

### Fixed
- 诊断条在 last-good 保留时明确标注；dispose 改用 `clearTimeout` 与自适应扫描计时器精确配对。

## [2.0.0]

### Added
- 渲染前原子校验 + 修复回执（`E-EMPTY/E-SIZE/E-UNCLOSED/E-STRAY-CLOSE`，警告 `W-…`），错误回退源码视图。
- last-good：重渲失败保留上一次成功渲染。
- 多表面围栏发现（`md-code-block`/`code-block`/`code-block-small`）+ 宿主 DOM 漂移一次性告警。
- 无语言标签代码块结构识别；自包含导出（工具栏「下载」.html）。
- 激活自检日志 + 调试 API（`window.__dshHtmlUi.stats()/validate()`）。
- 无障碍补全（aria-live、focus-visible、prefers-reduced-motion）；`engines`/`manifestVersion` 声明。

### Fixed
- SVG 自闭合元素误入标签栈导致的误报；可选闭合标签（li/p/td…）触发的噪声警告。

## [1.0.0] — 重写：确定性接管 + 事件驱动 + 零 CPU  idle（dsh-html-ui version: 1）

**背景**：dsh-html-render v3.4.1/v4 的流式体验差、行为不可预测、CPU 占用高。v2 逐条修复已知缺陷 F1–F10。

**修复清单（F1–F10 对照见 git 历史 README）**
- F1 流式零 srcdoc 写入；F2 确定性接管（无内容猜测）；F3 单 $ 永不处理；
- F4 测高零定时器（ResizeObserver+MO+fonts.ready+rAF 双帧）；F5 变更驱动 sweep；
- F6 删除裸片段通道；F7 默认禁外链图片（allowRemoteImages 才加 https:）；
- F8 仅 assistant 行内接管；F9 无时间假结算（结构闭合判定 a>b>c）；
- F10 inject 最小化 + 全部可选注入。

**架构**
- L1 内核 `createRenderer`（零依赖，srcdoc 组装/CSP/主题/工具栏/降级矩阵）
- L2 调度 `installScheduler`（observer 增量发现/闭合判定/一次性接管/修复手术/卸载还原）
- L3 包装 `__dshHtmlUi` 命名空间（与旧版 `__dshHtmlRenderer` 不共存，检测即提示）

**测试**：33 vitest 用例（含安全样本集）+ 8 Playwright E2E（复用系统 Edge）。

> 附：部署包 bundle 侧的 v1.0.0 初版条目（`html`/`dsh-html` 围栏接管渲染：沙箱 iframe + CSP、本地交互脚本、块级 KaTeX、主题/语言接入、事件驱动高度、工具栏、SKILL.md 风格库 A–E、KaTeX 资产路由）见 bundle/CHANGELOG.md 末尾。
