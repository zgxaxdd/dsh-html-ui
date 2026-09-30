---
name: dsh-html-ui
description: 当回复内容用纯文字难以表达时（结构图/流程图、多卡讲义、对照大表、计算卡、交互小部件、整页交付物），主动生成 ```html（或 ```dsh-html）围栏 —— 由渲染器在聊天窗口内直接渲染为真 HTML（样式/本地脚本/块级 KaTeX 公式全支持，无边框融入对话流）。v4：输出前可用 dsh_html_check 工具自查源码，回执含可直接采用的修复版（repaired_html）与 next 动作；渲染失败时宿主会发回一次 [dsh-html-fence-repair] 修正通知。普通问答、短答、公式推导仍用正常 Markdown，避免滥用。
---

# dsh-html 内联 HTML 输出协议（v4）

渲染能力由部署级 dsh-html-ui 渲染器提供（全局，无需配置）。本协议分层：**速览必须记牢，细节随用随查**。

## 0. 一页速览

**何时用**：多卡讲义（≥4 联）/ 流程图·结构图·SVG 示意图 / 对照大表（≥15 行、多级表头）/ 步骤计算卡 / 交互小部件 / 整页交付物 → `html` 围栏；小表·2~4 步流程·单卡·清单 → Markdown 或平台原生组件；纯问答/短答/公式推导 → Markdown。

**五条硬约定**：① 围栏自带精简 `<style>`，半透明中性底（`rgba(128,128,128,.08)` 级），不写死背景/文字色；② 脚本仅围栏内本地交互（`addEventListener` 集中绑定），禁网络/iframe/父页/外链库；③ 块级公式 `$$…$$` 或 `\[…\]`（**行内 `$…$` 不渲染**），不要转实体/图片；④ 红字用 `<mark>`，图片优先内联 SVG（外链图默认不渲染）；⑤ 限额 ≤3 围栏/回合、各 ≤250 行，整页交付物单围栏 ≤500 行、≤1MB。

**位置红线**：围栏只写在**回答正文**。写在 reasoning/思考块里不会渲染、用户看不到——在思考里自查，正文再输出同一份。

**输出流程**：定形状 → 写围栏 → **复杂围栏先 `dsh_html_check` 自查** → 按回执修复 → 输出（可带 meta 头）。

## 1. 输出前自查（v4，写错必读）

复杂围栏（**>50 行 / 含 `<script>` / 整页交付物**）在输出前调用一次 `dsh_html_check` 工具：传入围栏内 HTML 源码（字符串，或 `{"html":"…"}` 对象均可），返回结构化回执（`ok` / `errors` / `warnings` / `next` / `repaired_html`，每条诊断带 `code` + `fix`，错误定位到行）。**`E-…` 错误必须修复后再输出；`W-…` 警告按 fix 采纳**。简单围栏可跳过。

**`next` 动作表**（回执里照此行动）：

| `next` 值 | 含义 | 动作 |
|---|---|---|
| `emit_fence` | 校验通过、无警告 | 直接输出该围栏 |
| `fix_warnings_then_emit` | 仅有 `W-…` 警告 | 按警告 fix 改写后输出 |
| `emit_repaired_html` | `E-…` 可自动修复 | **原样输出回执里的 `repaired_html`**（修好的源码，直接采用，别自己重写——重写才会引入下一个错） |
| `fix_and_revalidate` | `E-…` 不可自动修复 | 按 `fix` 逐条修复，再调一次 `dsh_html_check` 复查 |

**meta 头（可选）**：围栏首行写 `<!--dsh-html {"title":"公差配合对照表"}-->` —— `title` 用于导出 .html 的文件名、iframe 可访问名、工具栏标识；`{"full":true}` 声明整页交付物，行数上限从 250 放宽到 500。未知键忽略；JSON 写错只警告（`W-META-INVALID`）不阻断。

**看到浏览器里的诊断条 = 上一版写错了**：诊断条列错误码（带行号）+修复建议，点「复制修复提示」可得一段含修复版源码的模型可读指令 —— 按其修复后重新输出该围栏，不要置之不理。

## 2. 校验错误码 → 修复动作

| 码 | 含义 | 修复动作 |
|---|---|---|
| `E-EMPTY` | 围栏内容为空 | 补齐 HTML 内容后重新输出 |
| `E-SIZE` | 源码 >1MB | 拆分为多个围栏或精简内联资源 |
| `E-UNCLOSED` | 标签未闭合（detail 给 `标签@行号`） | 补上配对的闭合标签后重新输出 |
| `E-STRAY-CLOSE` | 多余闭合标签（detail 给 `标签@行号`） | 删除多余的闭合标签或为其补配对 |
| `W-IMPLICIT-CLOSE` | 结构标签靠隐式闭合收尾 | 为结构标签显式写出闭合标签 |
| `W-SCRIPT-EXT` | `<script src>` 外链脚本 | 改用围栏内联脚本（被沙箱阻断） |
| `W-SCRIPT-NET` | 脚本含网络 API | 交互数据在围栏内本地计算（被阻断） |
| `W-EXT-IMG` | 外链图片 | 改用内联 SVG 或 data URI |
| `W-INLINE-EVENT` | `onclick` 等行内事件 | 改用 addEventListener 集中绑定 |
| `W-META-INVALID` | meta 头 JSON 非法 | 修正 JSON 或删除该注释 |
| `W-IFRAME` | 内嵌 iframe | 移除，内容直接平铺 |
| `W-LINE-LIMIT` | 行数超上限（detail 给 `行数/上限`） | 拆分围栏或精简；整页交付物在 meta 写 `{"full":true}` |
| `W-DOCTYPE` | 含 `<!doctype>`/`<html>`/`<head>`/`<body>` 骨架 | 移除骨架，围栏内直接写内容 |

自查习惯：闭合标签成对写（尤其 `<div>`/`<section>`/`<svg>`/`<style>`/`<script>`）；SVG 自闭合（`<line/>`、`<circle/>`）合法；`$$…$$` 内的 `<`、`>` 不参与校验，放心写不等式。

## 3. 渲染失败后的同回合自修通知（v4）

围栏无法渲染时，宿主可能往**同一个回合**发回一条用户角色修正通知（前缀 `[dsh-html-fence-repair #<指纹>]`）：

```
[html-fence-repair] status=render_failed fences=1 next=resend_corrected_fence_only
```

处置约定：**只重发修正后的那个围栏**（按其 detail/fix 修，或直接采用随通知给出的修复版源码）；已正常渲染的内容不要重复输出；围栏写在回答正文。

## 4. 渲染事实（按此书写，两端一致）

- 每个围栏 = 一个**独立渲染文档**：自带 `<style>`（精简到实际用到的类），围栏间互不污染；无需 `<!DOCTYPE html>`/`<html>` 骨架（写了会收到 `W-DOCTYPE`）。
- **无痕外观**：不写死背景色 —— 半透明中性底 + 半透明边框，深浅主题自动融合宿主；文字色继承宿主（不设 color 即可），主题强调色用中等明度（#3b82f6/#16a34a/#d97706）。
- **块级公式**：`$$…$$`、`\[…\]`、`\(…\)` 由本地 KaTeX 渲染；超宽公式仅公式内部横向滚动。行内公式用 `\(…\)` 或走 Markdown 通道。
- **脚本安全**：沙箱 `allow-scripts` + CSP 阻断网络/表单/弹窗/localStorage；`alert/confirm/prompt` 被页内 toast 化 —— 反馈一律用页内 DOM。
- **红字强调**：`<mark>`（`==…==` 只属于 Markdown 通道）。
- **图片**：优先内联 SVG（零外网、主题自适应）；外链图默认不渲染。
- **工具栏**（悬停出现）：源码/预览、新标签打开、复制、重载、**下载自包含 .html**（导出文件内联公式样式并随附源码，可离线打开、可转发）。
- **渲染失败不劣化**：重渲失败自动保留上一次成功渲染（last-good）。

## 5. 风格库（按内容域大胆选视觉语言——严禁千篇一律灰卡片）

上方"半透明中性底"是风格 A（无痕融入，默认）。下列是**完整视觉语言**，按域选用、可与 A 混排；面板类（B/C/E）自带底色属"有意出跳"。

**B · 驾驶舱面板** —— 监控/仪表/实时数据/IoT 域：

```html
<div class="cp"><h4>系统监控</h4><div class="tile"><span class="num">98.2%</span> 可用率 <span class="led"></span> 正常 <span class="warn">1 项待处理</span><div class="bar"><i style="width:72%"></i></div></div></div>
<style>.cp{background:linear-gradient(160deg,#0b1220,#12203a);border:1px solid rgba(56,189,248,.3);border-radius:14px;padding:14px 16px;color:#d6e9ff;font:12.5px/1.6 ui-monospace,Consolas,monospace}.cp h4{margin:0 0 10px;color:#7dd3fc;font-size:13px;letter-spacing:1px}.cp .num{font-size:22px;font-weight:700;color:#38bdf8}.cp .tile{background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.22);border-radius:10px;padding:10px}.cp .led{display:inline-block;width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399}.cp .warn{color:#fbbf24}.cp .crit{color:#fb7185}.cp .bar{height:6px;border-radius:4px;background:rgba(56,189,248,.15)}.cp .bar>i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#0ea5e9,#34d399)}</style>
```

**C · 工程蓝图** —— 制图/公差/机构简图/图纸交付域（机械设计首选）：

```html
<div class="bp"><table class="tb"><tr><th>配合</th><th>孔 H7</th><th>轴 g6</th><th>类别</th></tr><tr><td>H7/g6</td><td>+0.021/0</td><td class="tol">−0.009/−0.020</td><td>间隙配合</td></tr></table><svg viewBox="0 0 200 60" style="max-width:100%"><circle cx="40" cy="30" r="18"/><circle cx="120" cy="30" r="10"/><line x1="40" y1="30" x2="120" y2="30"/><text x="46" y="18" font-size="9">A</text></svg><span class="stamp">审核通过</span></div>
<style>.bp{background:linear-gradient(160deg,#0e2a4d,#0a1f3c);background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0 1px,transparent 1px 24px),repeating-linear-gradient(90deg,rgba(255,255,255,.05) 0 1px,transparent 1px 24px);border:1px solid rgba(147,197,253,.4);border-radius:10px;padding:16px;color:#dbeafe}.bp .tb{width:100%;border-collapse:collapse;font-size:11px}.bp .tb th,.bp .tb td{border:1px solid rgba(147,197,253,.5);padding:4px 8px}.bp .tol{color:#fbbf24;font-family:Consolas,monospace}.bp .stamp{display:inline-block;border:2px solid #f87171;color:#f87171;border-radius:6px;padding:2px 10px;font-weight:700;transform:rotate(-6deg)}.bp svg text{fill:#dbeafe}.bp svg line,.bp svg polyline,.bp svg rect,.bp svg circle{stroke:#dbeafe;fill:none}.bp svg circle{fill:rgba(30,58,138,.35)}</style>
```

**D · 杂志编辑** —— 深度讲义/复盘/叙事长文域：

```html
<div class="ed"><div class="hd">带传动速比设计要点</div><div class="lead">速比决定从动轮转速，也是选型第一约束。</div><div class="pull">先定速比，再反推带长与中心距。</div><div class="cols2"><div class="bignum">3.5×</div>典型增速比区间 2~4×；超过 4× 建议改用二级传动。V 带滑动率约 1%~2%，精确速比需复核。</div><hr class="rule"></div>
<style>.ed{font:15px/1.9 Georgia,'Times New Roman','Songti SC',SimSun,serif}.ed .hd{font-size:26px;line-height:1.3;font-weight:700;margin:2px 0 6px}.ed .lead::first-letter{float:left;font-size:44px;line-height:1;padding:2px 8px 0 0;font-weight:700;color:#8b5cf6}.ed .pull{border-left:3px solid rgba(139,92,246,.5);padding:4px 14px;font-size:16px;font-style:italic;opacity:.92;margin:12px 0}.ed .bignum{font-size:42px;font-weight:700;color:#8b5cf6}.ed .cols2{column-count:2;column-gap:26px}.ed .rule{border:0;border-top:1px solid rgba(128,128,128,.35);margin:12px 0}</style>
```

**E · 终端日志** —— 命令/日志/调试记录域：

```html
<div class="tm"><div><span class="p">$</span> dsh plugin --profile web add dsh-html-ui</div><div class="cm"># 输出：已安装 dsh-html-ui@4.0.0（link）</div><div class="er">warn: 重启 dsh web 后生效</div></div>
<style>.tm{background:rgba(10,14,24,.94);border:1px solid rgba(52,211,153,.25);border-radius:10px;padding:12px 14px;color:#a7f3d0;font:12.5px/1.7 ui-monospace,Consolas,monospace}.tm .p{color:#34d399}.tm .cm{color:#64748b}.tm .er{color:#fb7185}</style>
```

选风格口诀：**数据看板 B、图纸公差 C、长文讲义 D、日志命令 E、其余 A**；一条回复可混排。

## 6. 非标机械设计专属示例（风格 C 的 3 个典型用法）

**C1 · 机构简图（纯 SVG，零外链）**：皮带/齿轮/连杆简图用 `<svg viewBox>` 绘制，线宽 2-4px、铰点圆点标注 A/B/C、载荷红色虚线箭头。示例骨架：

```html
<svg viewBox="0 0 400 120" style="max-width:100%;font:11px sans-serif"><!-- 主动轮→从动轮 两圆 + 皮带切线 --></svg>
```

**C2 · 公差配合对照表**：用 `.bp .tb` 表格列 H7/g6、H8/f7 等配合的孔/轴极限偏差与过盈/间隙判定，关键值用 `.tol`（黄色等宽）突出。

**C3 · 交互式参数计算卡**：`<input>` 或 `<select>` 绑 `input` 事件即时重算（如带传动速比/轴径扭矩），结果区显示 `$$…$$` 公式与计算值，脚本全部 `addEventListener` 本地绑定；复杂版先 `dsh_html_check` 自查。

## 7. 长度红线与输出前自查清单

- ≤3 个围栏/回合，每个 ≤250 行；整页交付物单围栏 ≤500 行（≤1MB，meta 写 `{"full":true}`）。
- 围栏只写回答正文（不写 reasoning/思考块）。
- 同一条公式不在 Markdown 与 HTML 双通道重复；同一数据不 HTML+原生组件双呈现。

自查清单：形状触发 ✓（未命中不硬上）/ 围栏数与行数 ✓ / 围栏写在正文 ✓ / 复杂围栏已 dsh_html_check ✓ / E-… 全部修复（或采用 repaired_html）✓ / next= 动作已执行 ✓ / 样式自足且半透明底 ✓ / 脚本纯净本地 ✓ / 公式只走块级 ✓ / 图片内联 SVG ✓ / `<mark>` 红字 ✓ / meta 头（可选）✓。
