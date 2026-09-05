/* dsh-html-ui v1.0.0 — 页面级入口（IIFE，构建产物形态）
 *
 * 命名空间 __dshHtmlUi（与旧版 __dshHtmlRenderer 不同，架构决策 9）：
 *  - 检测到旧版 __dshHtmlRenderer 仍注册 → console 明确提示先卸载旧插件，
 *    不共存、不接管；
 *  - 同版本 double-load → 让位（保留旧版守卫教训）；
 *  - 绑定 window.__dshHtmlUi = createRenderer()（全默认参数）。
 */
import { createRenderer, VERSION } from './kernel.js'
import { installScheduler } from './scheduler.js'

;(function () {
  'use strict'
  if (window.__dshHtmlRenderer) {
    try {
      console.warn(
        '[dsh-html-ui] 检测到旧版渲染器 window.__dshHtmlRenderer 仍存在（dsh-html-render 插件）。' +
        '两版不共存：请先卸载旧插件（dsh plugin --profile web remove dsh-html-render）并重启，' +
        '否则本插件不接管围栏。'
      )
    } catch (e) {}
    return
  }
  if (window.__dshHtmlUi) {
    var oldVersion = window.__dshHtmlUi.version || 0
    if (oldVersion >= VERSION) return
    try {
      if (typeof window.__dshHtmlUi.disable === 'function') window.__dshHtmlUi.disable()
    } catch (e) {}
  }
  try {
    var kernel = createRenderer()
    window.__dshHtmlUi = kernel
    /* 观察接管器；返回 dispose 挂到 api 供 disable 调用 */
    kernel._schedulerDispose = installScheduler(kernel)
    var origDisable = kernel.disable
    kernel.disable = function () {
      try { if (kernel._schedulerDispose) kernel._schedulerDispose() } catch (e) {}
      origDisable.call(kernel)
    }
  } catch (e) {
    try { console.error('[dsh-html-ui] renderer failed to start:', e) } catch (x) {}
  }
})()
