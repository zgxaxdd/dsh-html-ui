# Changelog

## v1.0.0 — 重写：确定性接管 + 事件驱动 + 零 CPU 空闲（dsh-html-ui version: 1）

**背景**：dsh-html-render v3.4.1/v4 的流式体验差、行为不可预测、CPU 占用高。v2 逐条修复已知缺陷 F1–F10。

**修复清单（F1–F10 对照见 README）**
- F1 流式零 srcdoc 写入；F2 确定性接管（无内容猜测）；F3 单 $ 永不处理；
- F4 测高零定时器（ResizeObserver+MO+fonts.ready+rAF 双帧）；F5 变更驱动 sweep；
- F6 删除裸片段通道；F7 默认禁外链图片（allowRemoteImages 才加 https:）；
- F8 仅 assistant 行内接管；F9 无时间假结算（结构闭合判定 a>b>c）；
- F10 inject 最小化 + 全部可选注入。

**架构**
- L1 内核 `createRenderer`（零依赖，srcdoc 组装/CSP/主题/工具栏/降级矩阵）
- L2 调度 `installScheduler`（observer 增量发现/闭合判定/一次性接管/修复手术/卸载还原）
- L3 包装 `__dshHtmlUi` 命名空间（与旧版 `__dshHtmlRenderer` 不共存，检测即提示）

**测试**：33 vitest 用例（含安全样本集）+ 8 Playwright E2E（复用系统 Edge）。
