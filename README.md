# dsh-html-ui — DSH 聊天内联 HTML 渲染器

**让模型回复里的 HTML 直接在聊天流里"活"起来**——确定性接管、零 CPU 空闲、流式零闪烁；
v4 起带**输出前自查工具**（回执含可直接采用的修复版源码）与**同回合围栏自修闭环**。

```html
<!-- 模型写： --> ```html <div style="padding:8px;border:1px solid #3b82f6;border-radius:8px">渲染成功 ✓</div> ```
<!-- 用户看到：沙箱 iframe 里真渲染的 HTML，悬浮出工具栏（源码/预览/新标签/复制/重载/下载） -->
```

## 安装

```sh
# bundle 形态（当前部署真相源；v2.0.0 起 hand-maintained，构建链 tools/build.mjs 为 v1.0.0 遗产）
dsh plugin --profile web add link:D:\path\to\dsh-html-ui\bundle   # 本地 link
dsh plugin --profile web add dsh-html-ui                          # npm 形态（发布后）

# 重启 DSH host + 浏览器硬刷新（Ctrl+F5）
```

## 仓库布局

| 路径 | 角色 |
|---|---|
| **`bundle/`** | **部署真相源**：DSH 插件包（`lib/{index,client,validate,feedback}.mjs`、skills、test、scripts、docs）。link 安装指向这里 |
| `src/` `tools/` | v1.0.0 时代的未打包源码 + esbuild 构建链（历史保留；`src/` 停留在 v1.0.0，不再回填） |
| `test/` `e2e/` `examples/` | v1.0.0 时代的 vitest / Playwright 测试与示例（同上） |
| `vendor/katex/` | v1.0.0 时代的 KaTeX 资产副本；浏览器端实际加载的是 `bundle/lib/assets/katex/` |
| `skills/dsh-html-ui/SKILL.md` | marketplace 镜像，与 `bundle/skills/dsh-html-ui/SKILL.md` 同步 |
| `docs/` | 设计文档（`DESIGN-BASELINE.md` v2 重写基线、`V3-DESIGN.md`、`V4-DESIGN.md`） |
| `dsh-html-client.js` | v1.0.0 页面级 IIFE 产物（历史保留） |

## 能力总览（v4.0.0）

1. ` ```html `/` ```dsh-html ` 围栏 → 沙箱 iframe 真渲染（本地脚本、块级 KaTeX、主题自适应、事件驱动高度）
2. `dsh_html_check` 模型侧自查工具：输出复杂围栏前校验，回执带 `next` 动作与 **`repaired_html`**（可直接采用的修复版源码）
3. **同回合围栏自修**：不可渲染的围栏在回合结束前收到一次修正通知（每回合一次 / 每围栏一次 / 子代理不触发）
4. 规则集 4 诊断：稳定错误码 + 行号 + 修复指令；last-good 保留上次成功渲染；懒渲染 + 自适应扫描
5. 自包含导出（.html，随附源码）；en/zh 本地化；无障碍补全

详细契约见 [bundle/README.md](bundle/README.md)（能力矩阵、校验回执表、配置项、调试 API）与
[bundle/skills/dsh-html-ui/SKILL.md](bundle/skills/dsh-html-ui/SKILL.md)（模型侧书写协议）。

## 开发与回归

```sh
npm test           # → bundle：feedback + validate + parity + load 四套件
npm run check      # → bundle：四个模块语法检查
npm run verify:pack # → bundle：打真 tarball 自检（必含清单 / 体积上限 / KaTeX 资产）
npm run build      # v1.0.0 构建链（tools/build.mjs）——仅供追溯，不会回填 v2+ 的 hand-maintained bundle
```

修改校验规则：改 `bundle/lib/validate.mjs` → `node bundle/test/embed-validate.mjs` → `npm test`
（双实现一致性由 `bundle/test/parity.test.mjs` 逐用例锁死）。

## 版本史

见 [CHANGELOG.md](CHANGELOG.md)：v1.0.0（确定性重写）→ v2.0.0（渲染前校验 + last-good）→
v3.0.0（`dsh_html_check` 自查工具 + meta 头）→ **v4.0.0（自修反馈环 + 规则集 4 + 修复版回执）**。
