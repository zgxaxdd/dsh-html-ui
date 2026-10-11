# dsh-html-ui

[English](README.en.md) | **中文**

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node: ^22.19 || >=24](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg)](package.json)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-6f42c1.svg)](https://github.com/zgxaxdd/dsh-html-ui)

**让模型回复里的 HTML 在聊天流里"活"起来**——` ```html ` / ` ```dsh-html ` 围栏不再是一段代码，
而是在沙箱 iframe 里真渲染的页面：样式生效、交互可用、公式可排版，且**零外网请求**。

## 它解决什么问题

DeepSeek Harness（DSH）默认把 ` ```html ` 围栏当普通代码块显示。于是模型明明能画出对照表、
流程图、计算卡，你看到的却是一屏源码。

装上这个插件后，同一段围栏会变成真正的页面：

````
模型写：                                   用户看到：
```dsh-html                                ┌──────────────────────────┐
<div class="card">                         │  ┌────────────────────┐  │
  <h3>带传动速比</h3>                       │  │ 带传动速比          │  │
  <input id="d2" type="number" value="250"> │  │ 主动轮 ⌀100  从动轮 ⌀[250]│
  <p>传动比 <b id="out">2.500</b></p>       │  │ 传动比 2.500        │  │
  <style>.card{...}</style>                 │  └────────────────────┘  │
  <script>…即时重算…</script>                │  悬浮工具栏：源码/预览/下载 │
</div>                                      └──────────────────────────┘
```
````

（示意图。真实效果请在 DSH 里粘贴 [`examples/`](examples/) 里的围栏查看。）

## 能力总览

### v1.0.0 · 基线（确定性接管）

- ` ```html ` / ` ```dsh-html ` 围栏 → 沙箱 iframe 真渲染：本地脚本、块级 KaTeX、主题自适应。
- **事件驱动高度**（ResizeObserver + MutationObserver + `fonts.ready` + rAF 双帧），**零定时器测高**。
- **零 CPU 空闲**：没有变化就不扫描；静默一段时间后停表。
- 沙箱 `allow-scripts` + CSP `default-src 'none'`（禁网络/表单/弹窗/父页）；单 `$` 永不当作公式。
- 悬浮工具栏（源码 / 预览 / 新标签 / 复制 / 重载 / **下载自包含 .html**）、en/zh 本地化、无障碍补全。

### v2.0.0 · 渲染前校验

- **原子校验**：空内容、>1 MB、标签未闭合、多余闭合标签在渲染前拦下，稳定错误码 + 修复指令。
- **last-good**：重渲失败保留上一次成功渲染，不闪空白。
- 多表面围栏发现 + 宿主 DOM 漂移一次性告警；超限输入降级为源码视图。

### v3.0.0 · 模型侧自查

- **`dsh_html_check` 工具**：模型输出复杂围栏前自查源码，拿到与浏览器渲染器**同一套规则集**的回执。
- 可选 meta 头 `<!--dsh-html {"title":"…"}-->`（导出文件名 / iframe 名）与 `{"full":true}`（整页交付物，行数上限 250 → 500）。
- 诊断条带错误码徽章 + 「复制修复提示」一键生成模型可读修复指令；懒渲染（视口外不挂载）。

### v4.0.0 · 自修闭环

- **`repaired_html`**：回执里直接给出**修好的源码**——把结果交给模型，比重写一遍更不容易再错。
- **同回合围栏自修** ⭐：回合结束时校验本回合围栏，不可渲染者把「诊断 + 修复版源码」steer 回**同一回合**。
  边界：每回合一次、每围栏一次（内容指纹）、子代理不触发、可取消；配置 `{"fenceFeedback": false}` 可关。
- `next` 动作表（`emit_fence` / `fix_warnings_then_emit` / `emit_repaired_html` / `fix_and_revalidate`）。
- 规则集 4：诊断携带行号（`div@L12`），新增 `W-LINE-LIMIT`、`W-DOCTYPE`；无标签代码块回退收紧为白名单式。

### v4.1.0 · 性能与边界（当前版本）

- **消除校验器的灾难性回溯**：`<a "` × k 在 80 KB 时曾 **1633 ms**、`<!--` × k **203 ms**——四个正则
  全部换成手写线性扫描；修复后同批输入 4.1 / 0.1 / 1.7 / 1.1 ms，1 MB 最坏形状 ≤ 31 ms。
  等价性由 **4000 条 `validateRaw` + 1500 条 `repairHtml` 与 v4.0.0 逐条差分对比，0 差异**背书。
- **诊断行号** O(N × 诊断数) → O(N) + O(log N)（1 MB + 200 条诊断：**153.4 ms → 4.1 ms**）。
- **流式期间不再为未定稿代码块做整篇校验**（256 KB 块每秒曾白烧 121 ms 主线程）；全文档扫描降为兜底。
- **HTML5 自闭合语义修正**：`<div/>` 在 HTML 内容里按开标签处理——旧实现给出的"修复版"会改变渲染结果。
- 注释 / CDATA 里的标签不再误报；围栏抽取支持 CRLF/CR 与 4 个以上反引号；扫描预算耗尽改报 `E-SCAN-LIMIT`。

完整实测数据见 [CHANGELOG.md](CHANGELOG.md) 与 [bundle/CHANGELOG.md](bundle/CHANGELOG.md)。

## 安装

```sh
# npm 形态（发布后）
dsh plugin --profile web add dsh-html-ui

# 本地形态：link 到仓库内的 bundle 目录（bundle/ 才是插件包）
dsh plugin --profile web add link:<仓库内 bundle 的绝对路径>

# 卸载
dsh plugin --profile web remove dsh-html-ui
```

装完**重启 `dsh web` + 浏览器硬刷新（Ctrl+F5）**，并**新开一个会话**。

验证是否生效：控制台出现 `[dsh-html-ui] client active; v4; …`，
且 `window.__dshHtmlUi.stats().version` 为当前版本号。

**升级**：v1–v4 的围栏写法**零破坏**，升级不需要改任何既有围栏。

## 怎么写围栏

围栏只写在**回答正文**里——写在 reasoning / 思考块里的围栏不会渲染（这是设计如此，不是 bug）。

五条硬约定：

1. 围栏自带精简 `<style>`；底色用**半透明中性色**（如 `rgba(128,128,128,.08)`），**不要写死背景色与文字色**——
   深浅主题才能自动融合。
2. 脚本仅限**围栏内本地交互**（`addEventListener` 集中绑定）；**禁**网络请求、外链库、iframe、父页访问、
   行内 `onclick`。
3. 公式只走**块级**通道：`$$…$$` 或 `\[…\]`；行内单 `$…$` 不渲染（避免误伤金额）。
4. 红字用 `<mark>`；图片优先**内联 SVG**（外链图默认不渲染）。
5. 限额：≤3 个围栏/回合，每个 ≤250 行；整页交付物单围栏 ≤500 行并在 meta 头写 `{"full":true}`。

### 示例一 · 静态卡片

````
```dsh-html
<!--dsh-html {"title":"公差配合速查"}-->
<div class="t">
  <style>
    .t{font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
    .t table{border-collapse:collapse;width:100%;font-size:13px}
    .t th,.t td{border:1px solid rgba(128,128,128,.35);padding:5px 9px;text-align:left}
    .t .k{font-family:ui-monospace,Consolas,monospace;color:#3b82f6}
  </style>
  <table>
    <tr><th>配合</th><th>孔</th><th>轴</th><th>类别</th></tr>
    <tr><td class="k">H7/g6</td><td>+0.021/0</td><td>−0.009/−0.020</td><td>间隙配合</td></tr>
    <tr><td class="k">H7/k6</td><td>+0.021/0</td><td>+0.015/+0.002</td><td>过渡配合</td></tr>
  </table>
  <p>关键值用 <mark>等宽字体</mark> 突出，深色主题下自动适配。</p>
</div>
```
````

### 示例二 · 交互计算卡 + 块级公式

````
```dsh-html
<!--dsh-html {"title":"带传动速比计算"}-->
<div class="c">
  <style>
    .c{font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:620px}
    .c .row{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}
    .c label{display:flex;flex-direction:column;gap:4px;font-size:12px;opacity:.85}
    .c input{font:inherit;font-size:13px;padding:6px 8px;border-radius:8px;
             border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.08);color:inherit}
    .c .out{font:600 20px/1.4 ui-monospace,Consolas,monospace;color:#3b82f6}
  </style>
  <p>传动比与从动轮转速：</p>
  $$i=\frac{d_2}{d_1},\qquad n_2=\frac{n_1\,d_1\,(1-\varepsilon)}{d_2}$$
  <div class="row">
    <label>主动轮 d₁ (mm)<input id="d1" type="number" value="100"></label>
    <label>从动轮 d₂ (mm)<input id="d2" type="number" value="250"></label>
    <label>转速 n₁ (r/min)<input id="n1" type="number" value="1440"></label>
  </div>
  <p>传动比 <span class="out" id="oi">2.500</span> ·
     从动轮转速 <span class="out" id="on2">567.4</span> r/min</p>
  <script>
    (function () {
      var g = function (id) { return document.getElementById(id); };
      function calc() {
        var d1 = parseFloat(g('d1').value) || 100;
        var d2 = parseFloat(g('d2').value) || 250;
        var n1 = parseFloat(g('n1').value) || 1440;
        g('oi').textContent = (d2 / d1).toFixed(3);
        g('on2').textContent = (n1 * d1 * 0.985 / d2).toFixed(1);
      }
      ['d1', 'd2', 'n1'].forEach(function (id) { g(id).addEventListener('input', calc); });
      calc();
    })();
  </script>
</div>
```
````

更多可粘贴示例见 [`examples/`](examples/)：`00-intro.md`（插件介绍页）、
`01-mechanical.md`（齿轮传动计算卡 + 公差表 + 机构简图）、`02-dashboard.md`（监控驾驶舱 + 实时曲线）。

模型侧的完整书写协议（风格库 A–E、错误码表、`next` 动作表）见
[bundle/skills/dsh-html-ui/SKILL.md](bundle/skills/dsh-html-ui/SKILL.md)。

## 架构

<img src="docs/assets/architecture.svg" alt="dsh-html-ui 架构：宿主半边、共享校验器、浏览器半边与自修反馈环" width="820">

- **宿主半边** `bundle/lib/index.js`：注册 `dsh_html_check` 工具、注入 systemPrompt 硬契约（精简至 562 字符，
  细节移交 SKILL.md 按需加载）、路由 KaTeX 资产、安装自修反馈环。
- **共享校验器** `bundle/lib/validate.mjs`：同构纯函数，规则集 4。**模型侧工具、宿主自修环、浏览器端渲染前校验
  共用同一份**——浏览器半边内嵌一份副本，由 `test/embed-validate.mjs` 同步、`test/parity.test.mjs` 逐用例锁死。
- **浏览器半边** `bundle/lib/client.js`：围栏发现（多表面 + 白名单回退）→ 校验 → 沙箱 iframe 渲染 →
  高度 `postMessage`（严格 `ev.source` 配对）→ 工具栏 / 导出 / 诊断条；调度器带 1s→4s 退避，静默即停表。
- **自修反馈环** `bundle/lib/feedback.mjs`：回合末抽取围栏 → 内容指纹 → 诊断 → 在 `agent/turn-stopping`
  边界把修正消息 steer 回同一回合。
- **安全边界**（防后续迭代误放松）：内层 iframe `sandbox="allow-scripts"`，CSP `default-src 'none'`，
  导出文件沿用同一套 CSP。详见 [SECURITY.md](SECURITY.md)。

## 仓库布局

| 路径 | 角色 |
|---|---|
| **`bundle/`** | **部署真相源**：DSH 插件包（也是唯一的 npm 发布物）。link 安装指向这里 |
| `skills/dsh-html-ui/SKILL.md` | marketplace 镜像，与 `bundle/skills/dsh-html-ui/SKILL.md` 逐字节一致 |
| `docs/` | 设计文档（`DESIGN-BASELINE.md` v2 重写基线、`V3-DESIGN.md`、`V4-DESIGN.md`）与架构图 |
| `examples/` | 可直接粘贴进 DSH 会话的围栏示例 |
| `src/` `tools/` `test/` `e2e/` | v1.0.0 时代的源码 / esbuild 构建链 / vitest / Playwright（历史保留，不再回填） |
| `vendor/katex/` | KaTeX 资产的**上游固定副本**：v1 构建链的输入 + 完整性校验对象（`tools/verify-sha256sums.mjs`）。浏览器端实际加载的是 `bundle/lib/assets/katex/` |
| `dsh-html-client.js` | v1.0.0 页面级 IIFE 产物（历史保留） |

## 开发与回归

```sh
npm run check        # 4 个模块的语法检查（index / client / validate / feedback）
npm test             # 7 步回归
npm run verify:pack  # 真 tarball 打包自检（必含清单 / exports 遍历 / 禁止清单 / 体积上限）
```

`npm test` 跑 7 个测试文件：`test/embed-validate.mjs --check`（内嵌副本同步检查）、`test/fence.test.mjs`、
`test/feedback.test.mjs`、`test/validate.test.mjs`、`test/parity.test.mjs`、`test/load.test.mjs`、
`test/client-apply.test.mjs`。

**改校验规则**：只改 `bundle/lib/validate.mjs` → `node bundle/test/embed-validate.mjs`（同步进 `client.js`
的内嵌段）→ `npm test`。**不要手改** `client.js` 里 `// src/validate.js` 与 `// src/kernel.js` 之间的内容。
详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

调试 API：`window.__dshHtmlUi.stats()` / `.validate(raw)` / `.repair(raw)`。

## 安全

本插件渲染的是**模型生成的不可信 HTML**。围栏内容运行在内层 `sandbox="allow-scripts"` 的 iframe 中
（无 `allow-same-origin`），CSP `default-src 'none'` 禁网络、禁表单、禁弹窗、禁父页；渲染前先过校验器，
超限输入降级为源码视图。**残余风险与上报渠道见 [SECURITY.md](SECURITY.md)**——请勿在公开 issue 里
粘贴可直接利用的 PoC。

## 第三方组件

随包分发 **KaTeX 0.18.5**（MIT，Copyright (c) 2013-2020 Khan Academy and other contributors），
位于 `bundle/lib/assets/katex/`。详见 [NOTICE](NOTICE)。

## 许可

[MIT](LICENSE) · Copyright (c) 2026 zgxaxdd
