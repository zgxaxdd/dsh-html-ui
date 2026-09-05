# dsh-html-ui（DSH profile bundle）

由仓库根 `tools/build.mjs` 生成，请勿手改。

```sh
dsh plugin --profile web add dsh-html-ui
dsh plugin --profile web add link:<本目录绝对路径>
```

- Host 半边（lib/index.js）：KaTeX 资产路由（immutable）+ systemPrompt 围栏契约 + 打包 skill
- Client 半边（lib/client.js）：ModuleLoader 包装（v1.0.0，inject 最小化，全可选）
- 卸载：`dsh plugin --profile web remove dsh-html-ui`
