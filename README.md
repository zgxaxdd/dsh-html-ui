# dsh-html-ui — DSH 聊天内联 HTML 渲染器（v2 重写）

**让模型回复里的 HTML 直接在聊天流里"活"起来**——确定性接管、零 CPU 空闲、
流式零闪烁。修复了旧版 dsh-html-render 的全部已知缺陷（F1–F10）。

## 安装

```sh
# 1) 安装（bundle 形态，一条命令）
dsh plugin --profile web add link:D:\path\to\dsh-html-ui\bundle   # 本地 link
dsh plugin --profile web add dsh-html-ui                          # npm 形态（发布后）

# 2) 重启 DSH host + 浏览器硬刷新（Ctrl+F5）
# 3) 在任意会话粘贴测试围栏：
#    ```html <div style="padding:8px;border:1px solid #3b82f6;border-radius:8px">渲染成功 ✓</div> ```
```

## 配置项（bundle/package.json#dsh.client 或内核 options.config）

| 配置 | 默认 | 说明 |
|---|---|---|
| `requireMarker` | `false` | `true` 时仅接管 info string 为 `html-render`/`dsh-html` 的围栏 |
| `latex` | `true` | `false` 时关闭 KaTeX 通道（公式原样显示） |
| `allowRemoteImages` | `false` | `true` 时仅追加 `https:` 图片源（仍禁 http:） |
| `maxHeight` | `12000` | iframe 高度上限 px |

## 与旧版（dsh-html-render）的差异（F1–F10 对照）

| # | 缺陷 | v2 修复 |
|---|---|---|
| F1 | 流式 450ms 重设 srcdoc（白闪/丢状态） | 流式期间**零 srcdoc 写入**；未闭合前保持宿主代码块 |
| F2 | 内容启发式漏判（不认 svg/p/h3） | **确定性接管**：assistant 行内 html/dsh-html 一律接管，零内容猜测 |
| F3 | 单 `$` 误伤金额文本 | LaTeX 只处理 `$$…$$`/`\[…\]`/`\(…\)`，**永不处理单 $**；`latex:false` 可整体关闭 |
| F4 | iframe 内 400ms 永久轮询 | 完全事件驱动（ResizeObserver+MO+fonts.ready+rAF 双帧），**零定时器** |
| F5 | 流式全页 sweep + 全文遍历 | 闭合判定不读内容；内容只在接管时刻读一次；sweep 只复查变更过的块 |
| F6 | 裸 mdt 片段通道与宿主打架 | **删除该通道**；围栏是唯一协议 |
| F7 | 外链 http/https 图片 | 默认 `img-src data: blob:`（无外网）；`allowRemoteImages` 才加 `https:` |
| F8 | 工具卡内 html 被误接管 | 仅 `[data-chat-anchor-key]` 含 assistant（或 flow-kind=assistant）的行内围栏 |
| F9 | 30s 强制假结算 | 渲染前提恒为"围栏已闭合"（结构判定），无时间假结算 |
| F10 | inject 三服务硬激活，缺席静默死 | inject 最小化（空）；theme/locale 全部 `ctx.inject` 可选注入 |

## 安全模型

- iframe `sandbox="allow-scripts"` 不透明源；**永不** allow-same-origin/popups/top-navigation
- 文档内 CSP：`default-src 'none'`；`connect-src 'none'`（禁网络）；`frame-src 'none'`（禁嵌套 iframe）
- 模型 HTML 永不进入主文档 DOM；无 dangerouslySetInnerHTML / innerHTML 解析 / eval
- 安全样本集单测全绿（外链脚本/内联事件/base/表单/嵌套 iframe/window.open/fetch/localStorage/伪造 postMessage/超长输入）
- `window.__dshHtmlUi.disable()` / `stats()` 控制台诊断

## 开发

```sh
npm install
npm run build       # esbuild 产出 IIFE + bundle
npm run test        # vitest（纯函数 + DOM 冒烟 + 安全样本）
npx playwright test # P1 E2E（复用系统 Edge）
npm run check       # 语法 + 校验和
npm run lint        # ESLint
```

## 卸载

```sh
dsh plugin --profile web remove dsh-html-ui
```
