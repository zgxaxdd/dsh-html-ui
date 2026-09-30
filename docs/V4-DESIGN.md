# dsh-html-ui v4 设计文档 —— 上游调研、可移植项与实施记录

上游参考：[omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui) main @ `ffb89fd`（v0.11.3，npm 名 `@changfenhuang/dsh-genui`，27 tags / 460 commits）。
研究方式：git 直连被本机 schannel 凭证栈阻断（`SEC_E_NO_CREDENTIALS`），改用 `git -c http.sslBackend=openssl -c credential.helper=` 克隆 + raw/API 云抓取，逐文件核验后摘出可迁移做法；本机实测 host 契约（DSH desktop `0.2.0-rc.2` / profile `web`）验证 API 可用性。

## 一、上游事实摘录（可复现定位）

| 机制 | 上游位置 | 关键事实 |
|---|---|---|
| 同回合围栏自修 | `src/plugin/fence-feedback.ts` | `session/event` 记回复文本 → `agent/turn-stopping` 边界 `agent.steer()` 修正消息；边界：每回合一次、每围栏一次（sha256/12 指纹）、子代理不触发、取消即退、指纹先入账 |
| 校验工具返回修复版 | `src/plugin/tool.ts` `validate_dsh_ui` | JSON 坏但可修时返回 `repaired_json` 并 `next=emit_repaired_fence`——"把修好的内容交给模型，重写才会引入下一个错" |
| 参数形状容错 | `src/plugin/tool.ts` `specOf` | 宿主工具桥实际观测到 `{spec}` / `{arguments}` / 裸串 / 双层嵌套四种形状，逐层剥开 |
| 白名单式通用代码块回退 | `src/client/dom-fence.tsx` `isGenericGenuiFence` | 只放行标签 ∈ {Code, Code block, 代码块} + `[data-code-block-banner]` + settled + 源语言不可用 + 正文过与带标签路径同一档修复；tier-2 结构修复刻意不参与 |
| 会话源数据恢复语言 | `src/client/source-fence.ts` | 从 ChatSnapshot assistant 文本 mdast 重解析，按行内代码块序号对齐；`openingLineComplete` 防流式误确认 |
| 先挂载后隐藏 + 失败还原 | `src/client/dom-fence.tsx` `renderBlock`/`sweep` | `data-genui-rendered` 幂等；raw/settled 变化才重渲染；失败必还原原代码块 |
| 常驻/按需分层 | `src/plugin/index.ts` `GENUI_SECTION_TEXT` | 常驻只留"必须有"的契约（3400 字符预算门禁），类目细则全部在 SKILL.md |
| 围栏位置红线 | 同上游 Rules | "`dsh-ui` 只写在回答正文；写在 reasoning/思考块里不渲染、用户看不到" |
| 节序不写死 | `src/plugin/index.ts` `apply()` | `order: ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT')` |
| 宿主兼容声明 | `package.json` | peerDependencies 显式多段 `^0.1.2-rc.1 \|\| … \|\| >=0.2.0-rc.1 <0.3.0-0`，规避严格 semver 下 prerelease 不匹配 |
| 打包自检 | `scripts/verify-pack.mjs` | `npm pack --json` 后断言必含清单（含遍历 exports 目标）、禁止清单、体积上限 |
| pack stdout 卫生 | `scripts/prepack.mjs` | `npm pack --json` 把 stdout 当 JSON，构建横幅泄漏即毁发布链 |
| CHANGELOG 规范 | `CHANGELOG.md` | `## [x.y.z] - 日期` + 固定分组；每条「现象—根因—做法—量化收益」 |
| 范例即 CI | `tests/genui-skill-examples.spec.ts` | SKILL.md 里的好范例必须过真实 guard、坏范例必须被拒 |

## 二、v4 移植项（逐项对应上游）

| 编号 | v4 做法 | 上游出处 |
|---|---|---|
| F1 | 围栏自修反馈环 `lib/feedback.mjs` | `plugin/fence-feedback.ts` |
| F2 | `repairHtml()` + 回执 `repaired_html` + `next` 动作表 | `plugin/tool.ts` `validate_dsh_ui` |
| F3 | 工具参数形状容错（字符串/`{html}`/`{arguments}`/裸串） | `plugin/tool.ts` `specOf` |
| F4 | 白名单式无标签回退（标签白名单 + 过 `validateRaw`） | `client/dom-fence.tsx` `isGenericGenuiFence` |
| F5 | 常驻契约新增围栏位置红线 + `repaired_html` 指引（562 字符） | `plugin/index.ts` Rules |
| F6 | `getSectionOrder('STRUCTURED_OUTPUT')` 优先、106 兜底 | `plugin/index.ts` `apply()` |
| F7 | `engines` 拓宽（dsh `<0.3.0-0`、Node 22.19+/24+） | `package.json` peerDependencies |
| F8 | `scripts/verify-pack.mjs` + `npm run verify:pack` | `scripts/verify-pack.mjs` |
| F9 | CHANGELOG 换用 `## [x.y.z] - 日期` + 分组 + 量化条目 | `CHANGELOG.md` |
| F10 | meta 头第二键 `full:true`（整页行数放宽 250→500） | 上游 `panel`/规模规则思路的本地化 |
| F11 | SKILL.md `next` 动作表与工具协议同词汇（诊断可索引回文档） | `tests/skill-md.spec.ts` + tool 协议 |

## 三、明确不做（负决策与理由）

1. **不引入 mdast 会话源数据恢复语言**（`source-fence.ts`）：客户端需新增 ChatSnapshot 订阅 + AST 解析 + 序号对齐三层机制，而本插管的围栏语言（`html`/`dsh-html`）在宿主改版后由 F4 白名单回退覆盖；性价比不足，留待 v5 若白名单回退仍不够再上。
2. **不做栅格化组件词汇/白名单 schema**：上游是 JSON spec + 组件守卫的"生成式 UI"，本插件是**任意 HTML + 沙箱 iframe**，组件词汇不适用；结构校验（标签配对/raw-text/尺寸/行数）+ 自动修复才是同构对应物。
3. **不做 `render_ui` 工具行通道**：任意 HTML 进工具行卡片没有对应扩展点价值，围栏内联是主通道。
4. **不引入 React/预编译/tsdown 构建链**：无构建纯 ESM 是既有部署事实（link 安装即生效）；工程化只补打包自检与 CI。
5. **不做 npm OIDC 自动发布**：仓库在中国区网络 + 用户自有凭据策略下先走 GitHub；release.yml 留作后续（上游 `.github/workflows/release.yml` 是现成模板）。
6. **`webServer.register` 不改为 `ctx.inject(['webServer'])` 唯一通道**：v3 的 `reflect.get` + `internal/service` 双通道在 0.1.7 与 0.2.x 均实测可用，改动收益仅是卸载时序，暂不值得承担回归风险。

## 四、v4 验收（本机实测）

- `npm run check`：`lib/{index,client,validate,feedback}` 四个模块 `node --check` 全过。
- `npm test`：
  - `feedback.test.mjs` 18 断言全过（抽取/指纹/诊断/修正文本/消息形状/规划器边界）；
  - `validate.test.mjs` 全过（规则集 4：行号、`W-LINE-LIMIT` 含 `full` 放宽与 500 封顶、`W-DOCTYPE`、`repairHtml` 6 例）；
  - `parity.test.mjs` 29 例双实现一致（含 `repairHtml` 逐用例）；
  - `load.test.mjs` 全过（版本一致性、反馈环三事件、`getSectionOrder`、schema 子集、`next`/`repaired_html`/参数容错、SKILL.md 范例）。
- `npm run verify:pack`：打真 tarball 自检通过（必含清单 / exports 目标 / 体积上限）。
- 宿主 API 实证：profile `web` 已安装的 `@changfenhuang/dsh-genui@0.11.1` `lib/index.js` 内含 `session/event`、`agent/turn-stopping`、`agent.steer`、`source.kind==="plugin"` 的消息形状——本插件反馈环使用的同款 API 在该宿主真实运行。

## 五、遗留与后续候选

- mdast 源语言恢复（见负决策 1）；`/panel` 类会话面板不适用（上游能力为组件树持久化）。
- 反馈环上线后统计"自动修正救回的围栏数"（上游有 `scripts/genui-usage-audit.mjs` 同款审计思路），用真实数据决定 v5。
