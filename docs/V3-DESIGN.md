# dsh-html-ui v3 设计文档 —— 系统评估、开源调研与改进决策

> 本文档是 v2.0.0 → v3.0.0 自迭代的完整设计记录：先评估、再调研、后决策。每项改进都标注理由与出处。

## 一、v2.0.0 系统评估

### 1.1 优点（保留并强化）

| # | 优点 | 证据 | v3 处置 |
|---|------|------|---------|
| S1 | **围栏契约零破坏**：语法/风格库 A–E/限额稳定，模型侧学习成本一次性摊销 | v1→v2 迁移无写法变化 | 保持，v3 仅新增可选 meta 头 |
| S2 | **纵深沙箱安全**：iframe `sandbox="allow-scripts"` + CSP（禁网/禁表单/禁父页）+ alert/confirm/prompt 页内化 | buildCsp 双模式（内嵌/tab） | 保持；导出文件的 CSP 策略显式化（E2） |
| S3 | **渲染前原子校验 + 稳定错误码**（E-/W-）+ 修复建议 | validateRaw 16 用例回归 | 升级为规则集 v3，回执结构化 `fix` 字段（A2） |
| S4 | **Last-good**：重渲失败保留上一次成功渲染 | applyDoc() 回退链 | 保持并入回执面板标识（C1） |
| S5 | **事件驱动高度**（postMessage + rAF 合帧）、内容缓存 LRU 200、KaTeX 双缓存 | 实测零 CPU 空闲 | 保持；新增懒渲染进一步降耗（B3） |
| S6 | **多表面围栏发现 + 漂移告警 + 无标签识别** | scheduler 三表面 + pre→banner 回退 | 保持 |
| S7 | **自包含导出** | 工具栏下载 .html | 增强：meta.title 命名 + 源码随附（B2） |
| S8 | **激活自检 + 调试 API**（stats/validate） | console 自检行 | 保持 |
| S9 | **回归测试随包**（校验器 + 加载冒烟） | bundle/test/ | 扩展（D2） |

### 1.2 不足（v3 必须解决）

| # | 不足 | 影响 | v3 对策 |
|---|------|------|---------|
| W1 | **校验结果只在 DOM 呈现，模型不可见**：围栏写错时用户看到诊断条，但模型不知道，无法当回合自修复 | 核心闭环缺失（对比 dsh-genui 的 fence auto-repair / validate 工具） | F1 模型侧 `dsh_html_check` 工具 + C1 复制修复提示 |
| W2 | **无机器可读的围栏元数据**：导出文件名、可访问名、标题全靠猜 | 交付物确定性差（对比 archify 的 typed IR） | F2 可选 `<!--dsh-html {...}-->` meta 头 |
| W3 | **校验器仅浏览器侧**：host/工具链无法复用同一套规则 | 规则双端漂移风险 | F3 共享 `lib/validate.mjs` + 一致性回归测试 |
| W4 | **性能天花板**：每秒全文档 querySelectorAll×2，长会话持续耗 CPU；所有 iframe 立即渲染 | 大会话体感与耗电 | B3 IntersectionObserver 懒渲染 + B4 自适应扫描周期 |
| W5 | **回执不可行动**：错误码表在 SKILL.md，但诊断条上没有"给模型的修复指令"，人工转述成本高 | 修复回执只完成一半 | C1 一键复制模型可读修复提示 |
| W6 | **systemPrompt 常驻偏长**（每回合 567 字符） | token 经济性 | D3 精简 section，细节移交 skill（渐进披露） |
| W7 | **版本/契约散文化**：升级说明只在 README，无 CHANGELOG；版本常量多处手工同步 | 维护风险 | D1 CHANGELOG.md + 版本一致性测试 |
| W8 | **无错误码规则版本号**：回执不含规则集版本，长期难以判读历史回执 | 可观测性 | A2 回执携带 `ruleSet: 3` |

## 二、开源调研摘要（借鉴对象与可迁移经验）

| 项目 | 成熟实践 | 迁移到 v3 |
|------|----------|-----------|
| **[cure53/DOMPurify](https://github.com/cure53/DOMPurify)**（Wiki） | 白名单配置 + 决策点 hooks；[hook 误用教训](https://mizu.re/post/exploring-the-dompurify-library-hunting-for-misconfigurations)：大小写归一、在 hook 里 setAttribute 绕过校验 | 校验器标签名统一小写归一（已做）；规则表集中配置化（fix 注解）；不信任二次注入的属性 |
| **[mermaid](https://mermaid-js-mermaid.mintlify.app/advanced/error-handling)** | **parse 与 render 分离**（`mermaid.parse()` 先校验再渲染）；`parseError` 可插拠；错误不崩 UI | v2 已是"先校验后渲染"，v3 把校验暴露为独立工具（F1）与共享模块（F3）；渲染失败永不落错误内容到屏幕（last-good） |
| **[iframe-resizer](https://github.com/davidjbradshaw/iframe-resizer)** | postMessage 高度同步的安全边界：消息来源校验 | 保持 `ev.source === iframe.contentWindow` 严格配对（已做）；在设计文档明示此为安全边界 |
| **[omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui)** | `validate_dsh_ui` **模型侧校验工具**；fence auto-repair（同回合自修复）；多表面 DOM 发现；激活自检日志；导出 artifact；自愈限额 | F1 工具、C1 修复提示（auto-repair 的无 API 依赖替代）、S6/S8 保持、A2 回执 |
| **[tt-a1i/archify](https://github.com/tt-a1i/archify)** | typed JSON IR；**原子验证 + 稳定错误码 + supportedFixes 修复回执**；last-good 交付；自包含 HTML；源码随附可再编辑 | A1 meta 头（轻量 typed 契约）、A2 结构化 fix、B2 导出随附源码、S4 保持 |
| **Anthropic Skills 生态实践**（SKILL.md 渐进披露） | description/whenToUse 路由化，正文分层：速览在前、细节在后、示例可执行 | D3/SKILL.md v3 重写：协议速览 → meta → 工具 → 错误码 → 风格库 → 示例 → 红线 |
| **DSH 宿主 `@deepseek-ai/dsh-tools`**（本地契约核查） | `ctx.tools.register` + JSON Schema 子集（type/oneOf/properties/required/additionalProperties/items/enum/const）+ `output.render` 纯投影 | F1 工具按此契约手写定义（不 import 宿主包，规避 pnpm 隔离） |

## 三、v3.0.0 改进点与理由（逐项）

### F1 · `dsh_html_check` 模型侧自查工具 ⭐旗舰
- **内容**：宿主注册同名工具，模型在输出复杂围栏（>50 行 / 含 `<script>` / 整页交付物）前传入围栏源码，返回与浏览器端**完全一致**的校验回执（ok/errors/warnings/stats，稳定错误码 + 修复指令）。
- **理由**：v2 最大缺口（W1）。Mermaid 的 parse/render 分离与 dsh-genui 的 `validate_dsh_ui` 都证明"渲染前可自查"是正确分层；修在发送前 ≫ 修在渲染后。SKILL.md 同步教学"先自查再输出"。
- **权衡**：不引入对 `@deepseek-ai/dsh-tools` 的运行时 import（profile 隔离下不可解析），改为手写 ToolDefinition（已核对注册校验点：`output.render` 为函数 + `assertSupportedJsonSchema(output.schema)`）。

### F2 · 可选 meta 头 `<!--dsh-html {...}-->`
- **内容**：围栏首行可选 JSON 注释：`{"title":"…","name":"…"}`；title 用于导出文件名、iframe 可访问名、诊断条标识；未知键保留忽略；JSON 非法 → `W-META-INVALID` 警告（不阻断）。
- **理由**：archify typed IR 的轻量迁移——交付物（导出 .html）需要确定性命名，但强制 schema 会破坏"散文式围栏"的低门槛。可选 + 宽容解析是两者的平衡点。

### F3 · 共享校验器 `lib/validate.mjs`
- **内容**：校验器抽为同构 ESM 模块（无 DOM/Node 依赖），宿主工具与测试共用；client.js 内嵌同一实现；**一致性回归测试**逐用例比对双实现回执。
- **理由**：W3。规则双端漂移是自迭代插件的典型腐化路径；用测试锁死一致性（重复代码 + 契约测试 > 无构建步骤的生成链路，见 D1 权衡）。

### A2 · 回执结构化（ruleSet + fix）
- **内容**：回执项 `{code, detail, fix}`，整体携带 `ruleSet: 3`；错误码排序确定性。
- **理由**：W8 + archify 的 `supportedFixes` 实践——回执要"可行动"，修复指令必须机器可读地跟码走。

### C1 · 修复回执面板 v3
- **内容**：诊断条升级——错误码徽章、**一键复制模型可读修复提示**（`请修复以下 dsh-html 围栏问题并重新输出：E-UNCLOSED(div) 补上配对闭合标签…`）、last-good 标识。
- **理由**：W5。dsh-genui 的 fence auto-repair 需要 steering API；在无该 API 依赖的前提下，"复制修复提示"以最小复杂度完成人→模型的闭环。

### B3 · IntersectionObserver 懒渲染
- **内容**：视口外的挂载推迟 `srcdoc` 注入，进入视口才渲染；配合高度占位防跳动。
- **理由**：W4。长会话几十个围栏时，iframe 同步渲染是纯浪费；"零 CPU 空闲"承诺应覆盖离屏内容。

### B4 · 自适应扫描周期
- **内容**：调度器全量扫描 2s 基准；连续 3 轮无变化退避到 5s，任何 DOM 活动立即复位。
- **理由**：W4 的另一半——settle 检测已把渲染做对，扫描频率应随会话活跃度收缩。

### B2 · 导出增强
- **内容**：meta.title 命名导出文件；导出文件尾部注释内附**原始围栏源码**（可再编辑，archify "editable source" 实践）。
- **理由**：交付物应可追溯、可二次加工。

### D1 · CHANGELOG.md + 版本一致性测试
- **内容**：随包 CHANGELOG（v1/v2/v3 全史）；测试断言 package.json version === client VERSION === index.js VERSION。
- **理由**：W7。自迭代项目没有变更史就无法审计；版本常量多点同步必须由测试守护。

### D3 · systemPrompt 精简（渐进披露）
- **内容**：常驻 section 从 567 字符压缩到 ~330：只留触发判定、硬红线、错误码处置一句话、自查工具指引；风格库/错误码表/示例全部只在 SKILL.md（按需加载）。
- **理由**：token 经济性（W6）+ Skills 渐进披露最佳实践：常驻契约最小化，细节随 skill 调用进入上下文。

### E2 · 导出 CSP 显式化
- **内容**：导出文件沿用 tab 模式 CSP（`sandbox allow-scripts`），并在设计文档/README 明示安全边界与 postMessage 来源校验策略。
- **理由**：DOMPurify 调研的教训——安全属性必须显式文档化，防止后续迭代误放松。

## 四、明确不做的（负决策）

| 不做 | 理由 |
|------|------|
| 完整 fence auto-repair（同回合 steer 重发） | 依赖宿主 steering/inbox API，跨版本稳定性未知；C1 已闭环大部分价值 |
| 强制 schema 围栏（类 dsh-ui JSON spec） | 与插件定位冲突：本插件卖点是"任意 HTML 自由度"；强制 schema 是另一个产品（dsh-genui） |
| 运行时 import `@deepseek-ai/*` 宿主包 | pnpm profile 隔离下解析不可靠（已核实 bundle 无依赖声明） |
| 构建步骤/生成器（client.js 由 validate.mjs 生成） | 手维护 bundle 是既定决策；双实现一致性由测试锁死，复杂度更低 |
| 跨会话状态持久化 | dsh-genui roadmap 同结论：replay 重置是更正确的默认 |

## 五、验收标准

1. `npm test` 全绿：校验器 v3 用例（含 meta 头）+ 双实现一致性 + 加载冒烟 + 工具注册 + 版本一致性。
2. `node --check` 通过全部 JS。
3. v2 写法零破坏（旧围栏不带 meta 头照常渲染）。
4. `dsh_html_check` 在工具列表可见且返回结构化回执。
5. SKILL.md/README/CHANGELOG 与实现一致。
