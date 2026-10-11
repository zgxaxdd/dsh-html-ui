<!-- 提交 PR 前请把下面每一项都填上；不适用的写"不适用"。 -->

## 动机

<!-- 这个 PR 解决什么真实问题？关联 issue 请写 "Closes #123"。 -->

## 改动面

<!-- 碰了哪些文件 / 哪些契约。 -->

- [ ] 只改文档 / 测试（无行为变化）
- [ ] 改浏览器半边 `bundle/lib/client.js`
- [ ] 改宿主半边 `bundle/lib/index.js` 或 `bundle/lib/feedback.mjs`
- [ ] **改校验规则** `bundle/lib/validate.mjs`（→ 已按 CONTRIBUTING 第 5 节同步内嵌副本）
- [ ] 改模型侧协议 `bundle/skills/dsh-html-ui/SKILL.md`

## 围栏书写契约

- [ ] 本改动**不影响** v1–v4 既有围栏写法（向后兼容是硬承诺）
- [ ] 若影响：已在下方说明破坏面与迁移方式

## 已运行的验证

<!-- 贴实际输出，不要只写"通过"。 -->

```sh
npm run check
npm test
npm run verify:pack
```

## 备注

<!-- 任何需要 reviewer 特别注意的地方（性能、安全边界、宿主版本差异…）。 -->
