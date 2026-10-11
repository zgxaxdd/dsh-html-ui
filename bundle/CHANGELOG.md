# Changelog — dsh-html-ui

本项目遵循语义化版本；围栏书写契约（v1 起）保持向后兼容，新能力一律可选。

## [4.1.0] - 2026-09-30

全面评估后的性能 / 稳定性 / 可维护性升级。**围栏书写契约与对外行为不变**（v1–v4 写法全部有效），
改动集中在热路径、失效模式与工程护栏上。每项都标注了实测数据或可复现判据。

### 阻塞级：校验器的灾难性回溯（ReDoS 形状）

正则版的三个扫描正则与 meta 解析都存在**灾难性回溯**，且全部在 1MB 上限内可达：

| 输入形状 | 80 KB 实测 | 1 MB 推算 |
|---|---|---|
| `<a "` × k（TAG_RE 属性块） | **1633 ms**（20 KB 110 ms → 40 KB 428 ms → 80 KB 1633 ms，每次翻倍 4×） | ~4.5 分钟 |
| `<!--dsh-html [` + 空格（META_RE） | 5.3 KB 已 10.7 ms | ~6 分钟 |
| `<!--` × k（COMMENT_MASK_RE） | **203 ms** | ~30 s |
| `\(` × k（LATEX_MASK_RE） | **360 ms** | ~1 分钟 |

危害与早前的 scanTags 死循环同级：浏览器端冻结标签页，宿主端 `dsh_html_check` 与回合自修环挂死；
而且 `<a "` 那类是判定为 `ok:true` 的"合法"输入。**修复方式是把这四个正则全部换成手写线性扫描**
（`scanTags` / `maskSource` / `parseMeta` / 告警探测 / `looksLikeHtmlDoc`），不是调参：

- `scanTags`：逐标签扫描 + 引号成对跳读；因"未闭合引号要让本次匹配失败并像正则一样从下一个 `<` 重试"，
  额外加了**扫描预算**（`4×正文长度 + 4096` 步）：畸形到超出预算时停止扫描并给出新告警
  `W-SCAN-LIMIT`（修复路径则直接判 `E-REPAIR-INCOMPLETE`，不产出可能改错结构的"修复版"）。
- `maskSource`：单趟左→右扫描替代两个全局惰性替换（公式闩锁 + 注释短路，都是线性的）。
- `parseMeta`：meta 头必须在正文最前，改为限定窗口的手工解析（`indexOf` 找 `-->`）。
- 告警探测：`<script[^>]*src=` / `<img[^>]*src=` 改成"定位标签起点 → 截到下一个 `>` → 局部匹配"。
- **超限输入在掩码/扫描之前短路**（`E-SIZE` 直接返回），1MB 以上的输入成本降到 O(1)。

**修复后实测**（同一批输入，80 KB）：4.1 ms / 0.1 ms / 1.7 ms / 1.1 ms；1 MB 最坏形状 ≤ 31 ms。

**等价性证明**（不是"看着对"）：写了差分模糊测试，把上游 v4.0.0 的正则实现与新的线性实现
逐个输入对比回执——**4000 条 `validateRaw` + 1500 条 `repairHtml`，0 差异**。过程中它抓出了
两个真实回归（我第一版把"未闭合引号"提交处理、第二版把"无 `>`"当成全局收工），两处都已按正则语义修正。
该差分脚本留在 `_probe2/diff-fuzz.mjs`（仓库外的工作台），CI 用 `test/validate.test.mjs` 新增的
6 条 ReDoS 形状用例做防回归。

### 性能审计驱动的客户端修复（均为实测，非估计）

16. **撤销上一轮的一个退化改动**：`findFenceCandidates` 里"先标签后结构"的顺序实测 **23.29 ms → 5.80 ms**
    （4× 退化）——因为 `labelTextOf` 内部是 `querySelectorAll("*")`（5k 节点祖先上 0.88 ms/次，
    比结构判定贵 9~100×），且不再提前 break 后会把 `<body>`/`<html>` 也拉进来。已恢复"结构判定优先且失败即 break"。
17. **`labelTextOf` 改为有界 DFS**（上限 400 个元素）：不再物化整棵子树，同一场景下标签读取从 0.88 ms 降到微秒级。
18. **`repairSurgery` 的正文变更检测改为按时间摊薄**（`RAW_RECHECK_MS = 500`）：上一版用
    `block.textContent.length` 当廉价探针仍然太贵——实测 2 万节点挂载点 1.83 ms/次、40 个挂载点每帧 2.93 ms。
    现在同一挂载点最多每 500 ms 做一次完整比对（`rawRecheckMs` 可注入）。
19. **未标注代码块路径不再重复校验**：`processBlock` 已算出的回执透传进 `mountBlock`
    （1MB 正文实测省掉第二次 23.7 ms）。
20. **`contentCache` 不再缓存"未增强正文"**（正确性）：KaTeX 未就绪时那次会把含原始 `$$` 的正文写进缓存，
    之后即使 KaTeX 可用也永远命中旧结果（实测 `hits:1` 后公式不再渲染）。缓存键并入增强状态位。
21. **`replaceLatex` 三处收敛**：无公式区时跳过三次全文 replace（1MB 零公式正文省约 21 ms）；
    无标签 token 时跳过还原替换；标签保护从惰性正则改为线性扫描（`protectTags`，并自带 ASCII 工具，
    不再隐式依赖另一段的内部函数）。
22. **行首表改为按需构建**：干净的 1MB 正文（0 诊断）不再白付 2 ms。

### 边界与语义修复（第三方边界猎取报告驱动）

23. **`hasTagAttribute` 二次方**（本轮新代码引入，MAJOR）：`'<script '.repeat(k)` 932 KB → **17 487 ms**
    （80 KB 127 ms → 160 KB 501 ms → 320 KB 2036 ms，翻倍 4×）；`'<img '×k` 655 KB → 7 680 ms。
    成因：每个 occurrence 都从零 `indexOf(">")`，无 `>` 时还 `slice` 到文末再做正则。
    修法与判断依据：更靠后的 occurrence 判定窗口必然是当前窗口的**子区间**，因此一次判定即可覆盖，
    判定完直接跳到该 `>` 之后。现在 932 KB = **10 ms**。
24. **HTML5 自闭合语义**（MAJOR，上游既有缺陷）：`<div/>x</div>y` 曾报 `E-STRAY-CLOSE`，
    而"修复版" `<div/>xy` 会把 `y` 搬进 div 里 —— 修复改变了渲染结果。
    按规范：自闭合标记只在**外来内容**（svg/math）有效，HTML 内容里被忽略。现已跟踪命名空间：
    `<div/>`/`<span/>`/自定义元素按开标签处理（对应的闭合标签合法），`<svg><rect/></svg>` 仍按自闭合，
    且其后多余的 `</rect>` 按浏览器行为忽略。测试夹具有一处 `<path/>` 写在了 `<svg>` 之外，
    按新语义是真开标签，夹具已修正（旧期望建立在错误模型上）。
25. **注释/CDATA/bogus comment/PI 里的标签不再被当成真标签**：`<p>ok</p><!-- <div>` 曾报
    `E-UNCLOSED:div` 并把 `</div>` 修复**塞进注释里**；`<![CDATA[ <div> ]]>`、`<!x <div> >`、
    `<?xml <div> ?>` 同样误报。现在未闭合注释掩码到文末，`<!…`/`<?…` 按 bogus comment 掩码到第一个 `>`。
26. **raw-text 结束标签的其它合法形式**：`</script/>`、`</script x>`、`</style/>` 现在都被识别
    （HTML5 script-data end tag 规则：`</name` 后跟空白、`/` 或 `>`，再跳到它自己的 `>`）。
27. **扫描预算耗尽改为错误码 `E-SCAN-LIMIT`**（原为警告 `W-SCAN-LIMIT`）：`ok` 是消费方的唯一门
    （`fenceFailures` 跳过 `ok`、内核据此决定是否挂载），截断结果不能冒充"已验证通过"。
28. **`looksLikeHtmlDoc` 二次方**（潜伏，导出 API）：`'<style '×k` 112 KB 曾 3 575 ms，现在 4 ms。
29. **`extractHtmlFences` 不再在字面块里"发明"围栏**：四反引号或 `~~~` 块内的 ```html 示例
    曾被抽取并 steer 一次修复（用户看到的是代码块）；现在整体跳过字面块到其配对的闭合行。
30. **自修环通道卫生**：`markersIn` 只接受十六进制指纹（围栏正文里的任意文本都会被原样搬进修正消息）；
    修复版正文里的 ``` 行不再提前闭合 steer 消息的代码块（围栏长度按正文最长反引号串选取）。
31. **CR-only 行尾**：`lines` 与 `@L` 现在按 CRLF/CR/LF 三种行尾计（旧实现只数 `\n`，CR 正文的
    行号恒为 1、`W-LINE-LIMIT` 永不触发）；`parseMeta` 的前导空白恢复 `\s` 语义（含 BOM/NBSP/Unicode 空格）。
32. 移除 `scanTags`/`repairHtml` 里从未被产出的 `raw-unterminated` 死分支。

### 渲染效率（按实测收益排序）

1. **诊断行号：O(N) × 诊断数 → O(N) + O(log N)**（`lib/validate.mjs`）
   旧实现 `lineOf()` 对每条诊断从 0 线性扫到下标。实测 1 MB 畸形围栏 + 200 条 `E-UNCLOSED`：
   **153.4 ms → 4.1 ms（37×）**。该路径同时被浏览器挂载、`dsh_html_check` 工具与宿主自修环调用，
   即每一次渲染、每一次工具调用都在付这笔钱。改为一次性建行首表 + 二分查找。
2. **流式期间不再为"未定稿"的块做整篇校验**（`lib/client.js` `processBlock`）
   旧顺序：先跑白名单探针（对未标注代码块做整篇 `validateRaw`），再判"是否定稿"。
   实测单次探针：8 KB → 0.34 ms、64 KB → 1.48 ms、**256 KB → 6.06 ms**；
   按流式 20 块/秒算，256 KB 的块每秒白烧 **121 ms 主线程**（64 KB 也有 29.7 ms/s）。
   现在把结算门槛提前，未定稿直接返回；正文提取也从两次收敛为一次（`isClosed` 复用已读正文）。
3. **全文档扫描降为兜底**（`lib/client.js` `tick`/`schedule`）
   `MutationObserver` 已经给出具体变更块，旧实现却每个 tick 都做两次 `querySelectorAll` 全文档扫描。
   现在只在"自上次扫描有 DOM 变更"或每 4 个 tick 时扫一次，其余 tick 只遍历已挂载块（与文档规模无关）。
   稳态全文档扫描降到 ≤1/4，空闲仍为 0（静默约 15s 停表）。
4. **候选发现：先便宜的标签、后昂贵的结构判定**（`findFenceCandidates`）
   旧顺序对每个 `<pre>` 的每一跳都先跑 `isPlausibleFenceSurface()`（内部还有 `querySelectorAll`），
   才发现标签根本不是标记。已对调。
5. **超限（sourceOnly）挂载不参与正文变更比对**（`repairSurgery`）
   旧实现每轮 sweep 都对每个挂载点重建 `rawOf()`（拼接子节点文本）。现在先用原生
   `textContent.length` 当廉价变更探针，只有长度变了才完整比对；>1 MB 的源码视图挂载直接跳过。
6. **公式区间判定 O(N·M) → O(N+M)**（`replaceLatex` 的 `tagStartsInMath` 改前进游标）。
   实测 100 公式 × 500 标签：0.251 ms → 0.246 ms —— **当前规模下收益不可测**；
   保留是因为它消除了二次方最坏情况且成本为零，不当作收益宣传。
7. **HEAD 不再回 body + `content-length` + `405 Allow`**（host 资产路由）。
   旧实现 HEAD 也把 272 KB 的 `katex.min.js` 整个发出去。

### 稳定性与边界

8. **围栏抽取的 CRLF/CR 失效（真实缺陷）**（`lib/feedback.mjs`）
   旧实现按 `\n` 切行后用 `^…$` 匹配，行尾的 `\r` 让**整条回复里的围栏一个都抽不到** → 自修环静默跳过。
   实测 CRLF 回复 0 个围栏 → 现在 2 个。开头统一 `\r\n?` → `\n`。
9. **反引号长度语义**（同上）：开围栏支持 3 个以上反引号，闭围栏必须 **≥ 开围栏长度**。
   修掉两个问题：```` ```html `` 这类合法围栏抽不到；"围栏里示范围栏"被内层三反引号提前截断。
10. **标记白名单单一事实源**（`HTML_FENCE_MARKERS`）：定义在共享校验器里，浏览器端（内嵌副本）与宿主
    自修环共用一份，消除 `html-render` 判据各写一份而打架的历史问题。
11. **工具入参深度上限**（`lib/index.js` `htmlOf`）：`{spec:{spec:{spec:…}}}` 这类病态包装不再递归到底
    （模型入参属不可信输入）。
12. **反馈环监听器判空**（`feedback.mjs`）：`session` 形状异常时不再抛错刷日志。

### 可维护性（工程护栏）

13. **`tools/build.mjs` 加硬闸门**：v1 构建链会先 `rmSync(bundle/)` 再重建，且不回填 v2+ 内容——
    跑一次即销毁部署物。现在直接拒绝执行（需显式 `DSH_HTML_UI_ALLOW_V1_BUILD=1`）；
    `esbuild` 改为闸门之后的动态导入，否则静态导入会抢先抛 `MODULE_NOT_FOUND`、掩盖拒绝原因。
14. **`node test/embed-validate.mjs --check`**：内嵌校验段的同步从"跑一遍脚本（永远成功，因为它自己
    把文件改好了）"变成可失败的检查，已接入 `npm test` 首步。
15. **调度节奏可注入**：`installScheduler(kernel, { sweepMs, sweepMsSlow, quietSweepsStop, fullSweepEvery })`，
    线上默认值不变，测试可确定性驱动。

### 新增回归测试

- `test/fence.test.mjs`（23 条）：CRLF/CR 行尾、四反引号、嵌套围栏、短闭围栏、缩进 4 空格不算围栏、
  info string 带附加属性不算围栏、未闭合到 EOF、40 条上限、标记白名单一致性、指纹稳定性。
- `test/client-apply.test.mjs` 加强：定时器/动画帧给有限预算并真跑回调，覆盖
  `tick/fullSweep/sweep/flushHeights`（此前只覆盖到 `apply()` 本身）。
- `npm test` 现为 7 步：embed 同步检查 → 围栏 → 反馈环 → 校验器 → parity → 加载/生命周期 → 客户端 apply。

### 评估中确认"不必动"的项（避免过度优化）

- `katex.inline.css`（369 KB 字体内联 data-URI）随每个含公式的 iframe srcdoc 内联：改外链需放宽
  `font-src`/`style-src` 到宿主源，牺牲"离线可用 + `connect-src 'none'`"的既有安全设计，收益仅是
  字符串长度；维持现状。
- `.code-block` / `.code-block-small` 选择器在当前宿主已不存在：保留为其它宿主的兜底，代价一次
  `querySelectorAll`，不动。
- `replaceLatex` 前进游标：实测无可测收益（见第 6 条），仅作最坏情况护栏保留。

## [4.0.1] - 2026-09-30

第三方评审后的缺陷修复版（不影响围栏书写契约；v1/v2/v3/v4 写法全部有效）。

### 修复（阻塞级）
- **`scanTags` 死循环 + OOM**（`lib/validate.mjs` ↔ `lib/client.js` 内嵌副本）：raw-text 闭合标签的探测正则缺 `g` 标志，`lastIndex` 赋值失效，`exec` 永远返回文档里**第一个** `</script>`；当围栏含**两个及以上同类 raw-text 元素**（`<script>a</script><script>b</script>`、两个 `<style>`/`<textarea>`/`<title>`）时，该位置在当前扫描位之前 → `TAG_RE.lastIndex` 回退 → 同一开标签被反复匹配 → `events` 无限增长。实测把堆打爆：浏览器端每个 ` ```html ` 围栏都会冻结标签页，host 端 `feedback.mjs`（回合结束逐围栏校验）与 `dsh_html_check` 会挂死 DSH 进程。修复：`new RegExp("</" + name + "\\s*>", "ig")` + `TAG_RE.lastIndex = Math.max(...)` 单调前进不变量。回归用例：`test/validate.test.mjs` 新增 5 例。

### 修复（宿主半边）
- **资产路由悬挂导致插件重载失败**：`webServer.register` 未包在 `ctx.effect` 里，路由永不释放；插件重载（HMR / 配置更新 / 插件管理面板开关）时第二次注册撞 `webserver: duplicate prefix route`，**整个 host 半边加载失败**。改为 `ctx.inject(["webServer"], (webCtx) => webCtx.effect(...))`（与 dsh-genui 同款），并删掉不再需要的 `internal/service` 兜底。回归用例：`test/load.test.mjs` 新增「dispose → 无悬挂 → 重新 apply」断言。
- `tools.register` 的 effect 错误地挂在**外层 ctx** 上：宿主重新提供 `tools` 时旧注册不随注入作用域释放，会留下重复注册。改为 `toolCtx.effect(...)`。
- 打包 skill 正文切片 `raw.slice(end + 5)` 隐含「frontmatter 分隔行后必有一个空行」，CRLF 或紧贴正文时会多切/少切字符。改为按分隔行后的首个换行定位。

### 修复（浏览器半边）
- **客户端 entry 激活失败 → 应用起不来**（本轮修复自身引入的回归，已修复并加测试锁死）：为空闲停表新增的 `ensurePolling()` 引用了**嵌在 `start()` 内部**的 `tick()`，于是 `installScheduler → start → ensurePolling` 抛 `ReferenceError: tick is not defined`，`apply()` 直接抛错，浏览器端 entry 激活失败，桌面端表现为致命错误 `web boot: 1 entry did not activate / dsh-html-ui: failed`。修复：把 `tick()` 提到与 `ensurePolling`/`schedule` 同层。
  为什么 CI 没拦住：`test/load.test.mjs` 只断言「注册了 id」与「factory 返回带 apply 的对象」，**从不调用 `apply()`**；`node --check` 只查语法不查作用域。新增 `test/client-apply.test.mjs`：用最小 DOM stub 真正执行 `apply()`（定时器/动画帧给出有限预算并真跑回调，从而覆盖 `tick/fullSweep/sweep/flushHeights`）与 `dispose()`，并断言 kernel 的 `stats/validate/repair` 可用；已接入 `npm test`。
- **KaTeX 公式被标签掩码吞掉**：`replaceLatex` 先掩标签后掩公式，`$$a < b$$` 会被 `<[^>]*>` 连公式一起吞掉，`$$x<y$$</div>` 更会把真实标记当公式内容喂给 KaTeX 并从文档里删除——而校验器按相反顺序（先掩公式）判定为 `ok`，于是"校验通过但渲染错误"。改为先算出公式区间、标签掩码跳过起点落在公式内的匹配（保持 `pre/code/script/style` 整体优先掩码的顺序不变）。
- **>1MB 围栏内容消失**：`sourceOnly` 分支只挂一行告警就把原块 `display:none`，且工具栏监听器挂在早返回之后 → 源码不显示、复制/下载/新标签全哑。现在真的渲染源码 `<pre>` 并接线复制/下载/新标签（预览/重载对无 iframe 的场景隐藏）。
- **超限围栏每轮扫描重挂**：`takeOver` 在该分支往调度器 map 里存 `true` 而非 mount，`repairSurgery` 取不到 container → 每轮 sweep 都重新挂载一次，DOM 无限增长。改为存真正的 mount。
- **挂载后正文永不刷新**：`mount.lastRaw` 只写不读，宿主原地重渲染/流式收尾后 iframe、源码视图、复制、下载、诊断全部停在半截快照。`repairSurgery` 现在比对当前正文，变化则先 `unmountBlock`（避免 `liveFrames` 泄漏）再重挂。
- **新标签/导出文档实际未被沙箱化**：CSP 的 `sandbox` 指令在 `<meta>` 中被浏览器忽略，`blob:` 文档又继承创建者源 → 模型 HTML 以"应用同源 + 未沙箱"身份运行（可读 localStorage、可自我导航外发）。改为外层静态壳 + 内层真正的 `sandbox="allow-scripts"` iframe（`srcdoc`）；不再依赖 meta 里的 `sandbox`。
- `html-render` 围栏标记三处判据不一致（发现器认、接管器不认、宿主反馈环认）→ 统一为 `isHtmlMarkerLabel()`；回退扫描的标签比较同时补上 `trim().toLowerCase()`（宿主渲染成 `HTML`/` html ` 时不再漏发现）。
- `processBlock` 的两处 `catch (e) {}` 改为走 `kernel._dbg`（与相邻 mount 循环一致），系统性失败不再无声。
- 校验器：可选闭合标签的配对查找 `stack.lastIndexOf(name)` 拿字符串比对象，**永远返回 -1**（旧实现因此从未真正截断过标签栈）；改为既有的 `findInStack()`，并让无配对的多余闭合报 `E-STRAY-CLOSE`（`<div></li></div>` 不再被判合法）。
- 空闲 CPU：轮询改为静默约 15s 后停表，由 MutationObserver / IntersectionObserver / `visibilitychange` 唤醒（对齐"零 CPU 空闲"的设计声明，不再是永久 4s 全文档轮询）。
- `setTheme()` 不再丢弃实参：宿主 `--dsw-alias-*` 令牌真正接入 `themeProvider`；`message` / `matchMedia` 监听器随 `disable()` 摘除（插件重载不再累积）；iframe `error` 处理器由"重复显示原块 + 追加告警节点"改为整块卸载。
- **英文界面下渲染器文案仍是中文**：`locale.getLocale()` 返回的是快照对象 `{active, locales, revision}`（不是语言字符串），旧写法 `cur.indexOf("en")` 在对象上抛 `TypeError` 并被 `catch` 吞掉 → 永远不回退到英文。改为读 `snapshot.active` 并订阅 `locale/change`（切换语言即时跟随，而非只在注入那一刻看一次）。

### 兼容性
- **`engines.dsh` 修正为 `>=0.1.7-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`**。原范围 `<0.3.0-0` 在 semver 预发布规则下**排除所有 0.2.x 预发布版**（如桌面端实际运行的 `0.2.0-rc.2`）——即"声称支持 0.2.x，实际只覆盖 0.2.0 正式版"。注：DSH 目前不读取 `engines.dsh`（`dsh-app-boot` 的兼容门只检查 `peerDependencies` 里的 `@deepseek-ai/dsh*`），故该问题是声明失真而非安装阻断。
- `systemPrompt` 节序兜底值 106 → **9900**，与 0.1.7-alpha.2 / 0.2.0-rc.2 实测的 `SECTION_ORDERS.STRUCTURED_OUTPUT` 一致（旧值会落到 runtime-context 段之前；该分支只在缺 `getSectionOrder` 的更老宿主上生效）。

### 修复（工程/打包）
- `scripts/verify-pack.mjs` 在 Windows 上必挂：Node ≥20.12 起直接 spawn `npm.cmd`（.cmd/.bat）抛 `EINVAL`（CVE-2024-27980 的修复），仓库自带的 Windows CI 打包 job 同样会失败。改为优先用 `npm run` 注入的 `npm_execpath` 交给同一个 node 执行（无 shell、路径含空格也安全），直接执行脚本时退回 `npm.cmd` + `shell`。实测通过：`44 files, tarball 665.5KB, unpacked 1114.9KB; required=16 present; forbidden=0; size caps ok`。

### 实测环境
- DSH `0.2.0-rc.2`（桌面端 `@deepseek-ai/dsh-desktop-runtime`）+ cordis 4.0.4，用 asar 内真实 cordis 驱动 host 半边做挂载/释放/重载实测；围栏记录法与 `$$…$$`、raw-text、可选闭合等边界由 `npm test`（validate 60 例 / parity 29 例 / load / feedback）锁定。

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
