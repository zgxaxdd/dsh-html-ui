# 贡献指南（Contributing）

感谢愿意花时间。本文件只讲**怎么改、改完怎么验、什么绝对不能动**。

## 1. 开发环境

- **Node**：`^22.19.0 || >=24.0.0`（与 `bundle/package.json` 的 `engines` 一致）。
- **依赖**：**不需要 `npm install`**。`bundle/` 是零运行时依赖的纯 ESM，测试脚本只用 Node 内置模块。
  仓库根的 `devDependencies`（esbuild / eslint / vitest / playwright）只服务于 v1.0.0 遗留构建链，
  改插件本体用不到。
- **编辑器**：任何文本编辑器都行；文件统一 LF（`.gitattributes` 已固定 `eol=lf`），保存时不要改成 CRLF。

## 2. 代码地图

| 路径 | 职责 |
|---|---|
| `bundle/lib/index.js` | **宿主半边**：注册 `dsh_html_check` 工具、systemPrompt 硬契约、KaTeX 资产路由、安装自修反馈环 |
| `bundle/lib/client.js` | **浏览器半边**：围栏发现 → 校验 → 沙箱 iframe 渲染 → 高度 postMessage → 工具栏/导出/诊断条。**内含一份校验器的内嵌副本** |
| `bundle/lib/validate.mjs` | **共享校验器**（单一真相源）：`validateRaw` / `repairHtml` / `parseMeta` / `maskSource` / `scanTags` / `looksLikeHtmlDoc` |
| `bundle/lib/feedback.mjs` | **自修反馈环**：回合末抽取围栏 → 指纹 → 诊断 → 组装修正消息 → `agent/turn-stopping` 边界 steer |
| `bundle/skills/dsh-html-ui/SKILL.md` | **模型侧书写协议**：何时用、五条硬约定、风格库 A–E、错误码表、示例 |
| `bundle/test/*.mjs` | 7 个测试文件（见下） |
| `bundle/scripts/verify-pack.mjs` | 真 tarball 打包自检（必含清单 / exports 遍历 / 禁止清单 / 体积上限） |
| `src/ tools/ test/ e2e/ vendor/ dsh-html-client.js` | v1.0.0 遗产，仅供追溯。`vendor/katex` 仍被 `tools/build.mjs` 与 `tools/verify-sha256sums.mjs` 引用，**不要删** |

## 3. 本地跑起来（热验证）

```sh
# 把本地工作副本 link 进 DSH profile（路径换成你自己的 bundle 目录）
dsh plugin --profile web add link:<仓库内 bundle 的绝对路径>

# 改完代码后：重启 dsh web，再在浏览器里 Ctrl+F5 硬刷新，并新开一个会话
dsh plugin --profile web remove dsh-html-ui   # 卸载
```

在浏览器控制台可以拿到运行时状态：

```js
window.__dshHtmlUi.stats()        // 版本 / 挂载数 / 扫描节奏
window.__dshHtmlUi.validate(raw)  // 对一段围栏源码跑校验，回执与模型侧一致
window.__dshHtmlUi.repair(raw)    // 拿到修复版源码
```

## 4. 提交前必须跑的三条命令

```sh
npm run check        # 4 个模块的语法检查（index / client / validate / feedback）
npm test             # 7 步回归（见下）
npm run verify:pack  # 真 tarball 打包自检
```

`npm test` 实际跑 7 个文件：

1. `node test/embed-validate.mjs --check` —— 校验器内嵌副本是否与 `validate.mjs` 同步
2. `test/fence.test.mjs` —— 围栏抽取（CRLF/CR、四反引号、嵌套、缩进、未闭合到 EOF…）
3. `test/feedback.test.mjs` —— 自修环边界（每回合一次 / 每围栏一次 / 子代理不触发）
4. `test/validate.test.mjs` —— 规则集 4 诊断 + `repairHtml` + ReDoS 形状防回归
5. `test/parity.test.mjs` —— 双实现（`.mjs` 与 `client.js` 内嵌）逐用例一致
6. `test/load.test.mjs` —— 宿主加载 / 版本一致性 / 工具语义 / 资产路由生命周期
7. `test/client-apply.test.mjs` —— 客户端 `apply()` 与调度器在假 DOM 上真跑

CI（`.github/workflows/ci.yml`）会在 Node 22/24 上跑同样的东西，外加一个 Windows 打包 job。

## 5. 改校验规则的正确姿势

`bundle/lib/validate.mjs` 是**唯一真相源**，`bundle/lib/client.js` 里有一份逐字同步的内嵌副本
（位于 `// src/validate.js` 与 `// src/kernel.js` 两个标记之间）。流程固定：

```sh
# 1) 只改 validate.mjs
# 2) 把改动同步进 client.js 的内嵌段
node bundle/test/embed-validate.mjs
# 3) 全量回归（parity 会逐用例比对两份实现，不同步必挂）
npm test
```

**不要直接手改 `client.js` 里那两个标记之间的内容**——它会被 `embed-validate.mjs` 覆盖；
`--check` 模式（已接入 `npm test` 首步）会在两者不一致时直接失败。

## 6. 提交与 PR

- 提交信息沿用本仓库既有风格：`fix:` / `docs:` / `chore(release):` 是既有用法（另有 `ci:`、`enhance:`
  与少量无前缀的历史提交），`feat:` / `test:` / `perf:` 按需新增。前缀后跟**中文**正文。
  一个提交讲清一件事；版本发布类提交写 `chore(release): vX.Y.Z —— <一句话>`。
- PR 请说明：**动机**（要解决什么真实问题）、**改动面**（碰了哪些文件/契约）、
  **验证方式**（贴 `npm test` / `verify:pack` 的实际输出）。
- 触碰校验规则或围栏契约的 PR，请额外说明：是否影响 v1–v4 既有围栏写法（**向后兼容是硬承诺**）、
  parity 测试如何通过、有没有新增回归用例。
- 新增行为请**带测试**：本仓库的既有缺陷几乎每一个都有对应回归用例，照这个标准来。
- **不要提交**临时目录与产物：`.tmp-*`、`*.tgz`、`coverage/`、`node_modules/`（`.gitignore` 已覆盖）。

## 7. 想改文档？

- `README.md`（中文主 README）与 `README.en.md`（英文）请成对更新。
- `bundle/README.md` 是 npm 包内 README（面向安装者），改动请保持精简、不要与根 README 大段重复。
- 用户可见的能力变化必须同时更新 `CHANGELOG.md`（仓库根，记要点）与
  `bundle/CHANGELOG.md`（发布包，记细节与实测数据），两者版本号保持一致。
- 文档里的版本号、测试文件数量、命令请**照实写**——本仓库的文档曾经落后于代码，这类漂移当 bug 处理。
