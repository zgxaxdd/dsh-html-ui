# 安全策略（Security Policy）

## 这个插件在信任边界上的位置

`dsh-html-ui` 会把**模型生成、因而不可信**的 HTML 送进浏览器执行——这是它的设计目的（让围栏"活"起来），
也意味着它是整条链路上最该被审视的一环。提示注入、模型幻觉、用户从别处粘贴的恶意围栏，
最终都会以"一段 HTML"的形态到达这里。

因此请按下表理解信任边界：

| 位置 | 信任级别 | 职责 |
|---|---|---|
| 聊天记录 DOM（代码块文本） | **不可信数据** | 被读取、被校验，但不被当作指令 |
| 校验器（`bundle/lib/validate.mjs`） | 受信代码 | 只做纯字符串分析：结构诊断、体积/行数上限、修复建议；**不执行**围栏内容 |
| 宿主半边（`bundle/lib/index.js`） | 受信代码 | 注册 `dsh_html_check` 工具、路由 KaTeX 资产、回合末自修反馈环；**不执行**围栏内容 |
| 沙箱 iframe（围栏内容的实际运行处） | **不可信内容** | 围栏里的 HTML/CSS/JS 在这里真实执行 |
| 宿主页面 | 受信代码 | 只负责挂载 iframe、收高度消息、画工具栏 |

## 已实施的缓解

- **渲染沙箱**：围栏内容运行在内层 `sandbox="allow-scripts"` 的 iframe 中——**没有** `allow-same-origin`、
  `allow-forms`、`allow-popups`、`allow-top-navigation`、`allow-modals`。围栏脚本因此拿不到宿主的
  cookie / localStorage / DOM，也无法导航或打开窗口。
- **CSP `default-src 'none'`**：只放行内联样式与内联脚本（`style-src 'unsafe-inline'`、
  `script-src 'unsafe-inline'`），字体仅 `data:`；`connect-src 'none'` 禁网络、`form-action 'none'` 禁表单、
  `frame-src 'none'` 禁嵌套、`base-uri 'none'`。外链脚本/图片被拦截，`<script src>` 与 `<img src>` 会被
  校验器以 `W-SCRIPT-EXT` / `W-EXT-IMG` 提前告警。
- **`postMessage` 严格配对**：iframe 高度消息只在 `ev.source === iframe.contentWindow` 时采纳，
  不接受来自其它窗口/iframe 的同名消息。
- **渲染前校验**（`dsh_html_check` 与客户端内嵌的同一套规则集 4）：空内容、>1 MB、标签未闭合、
  多余闭合标签、行数超限、HTML 骨架噪声等都在渲染前给出稳定错误码 + 行号 + 修复指令。
  **只有 `E-…` 错误会挡住渲染**：>1 MB（`E-SIZE`）与畸形到超出扫描预算（`E-SCAN-LIMIT`）降级为
  源码视图（>1 MB 的挂载点根本不建 iframe）；行数超限（`W-LINE-LIMIT`）只是警告，围栏照常渲染。
  其它 `E-…` 错误默认进源码视图，但工具栏的「源码/预览」切换与「重载」会置 `renderAnyway`
  强制渲染——这是给用户的逃生通道，不是绕过校验的自动路径。
- **不可信输入的解析成本有上界**：标签扫描带预算（`4 × 正文长度 + 4096` 步），畸形到超出预算时报
  `E-SCAN-LIMIT` 而不是继续扫描；1 MB 以上的输入在掩码/扫描之前就短路返回。v4.1.0 已消除全部
  灾难性回溯形状（详见 [CHANGELOG.md](CHANGELOG.md)）。
- **导出文件沿用同一套 CSP**：工具栏「下载」得到的自包含 `.html` 不会比聊天里的 iframe 更宽松。
- **模型侧自修反馈环**（v4）：回合结束时校验本回合围栏，不可渲染者把诊断 + 修复版源码 steer 回同一回合，
  让"写错的围栏"在下一次输出时被改对，而不是让用户对着一段源码猜哪里错了。

## 已知残余风险（诚实清单）

以下**不是**漏洞，但你需要知道：

1. **围栏内的脚本会在该 iframe 里真实执行**——这正是设计目的（交互小部件、计算卡）。它不能联网、
   不能碰宿主，但**可以消耗 CPU**。请不要渲染来路不明的超长/死循环脚本（例如从不可信来源复制的围栏）。
2. **插件不防御宿主 DOM 结构漂移**：DSH 改版后若代码块表面（`.md-code-block` 等）改名，插件会**失效降级**
   （围栏显示为普通代码块），不会误执行任何内容。这类问题请开 issue，附上控制台里
   `window.__dshHtmlUi.stats()` 的输出。
3. **提示注入的边界**：插件无法判断"这条围栏是不是模型被诱导写出来的"。它能做的是限制这段 HTML
   能触及的范围（沙箱 + CSP + 校验），而不是判断它的意图。
4. **KaTeX 资产随包分发**（0.18.5，MIT，Khan Academy）：上游副本 `vendor/katex/` 的完整性可双向复核
   （列出即存在、存在即列出）：

   ```sh
   node tools/verify-sha256sums.mjs vendor/katex/SHA256SUMS vendor/katex
   ```

   发布包里的 `bundle/lib/assets/katex/` 与之一致，只多一个**构建期生成**的 `katex.inline.css`
   （`tools/build.mjs` 把字体换成 data-URI 内联）。该文件不在清单内，所以**不要把这个脚本指向
   发布包目录**——它会报 `unlisted file` 并退出 1。见 [NOTICE](NOTICE)。

## 上报漏洞

请**优先**使用 GitHub 的私有漏洞上报通道：

<https://github.com/zgxaxdd/dsh-html-ui/security/advisories/new>

也可以在 <https://github.com/zgxaxdd/dsh-html-ui/issues> 开 issue，但**不要在公开 issue 里粘贴可直接利用的 PoC**——
先描述影响范围，我们会在私有通道里跟你要细节。

请尽量附上：围栏源码（最小可复现）、DSH 版本（`dsh --version`）、插件版本、浏览器与操作系统、
以及控制台输出。

**响应时限**：3 个工作日内首次回复。确认为漏洞后，修复版本发布时会在
[CHANGELOG.md](CHANGELOG.md) 中记录（必要时附 GHSA 编号）。

## 支持的版本

只维护最新的 minor 线（当前 **4.1.x**）。更早的 3.x / 2.x / 1.x 不再接收安全修复，
但欢迎附上修复补丁——围栏书写契约在 v1–v4 之间保持向后兼容，所以升级通常不需要改围栏。
