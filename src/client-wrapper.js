/**
 * dsh-html-ui v1.0.0 — L3 客户端包装（构建产物 bundle/lib/client.js 的真相源）。
 *
 * F10 修复：inject 最小化。
 *  - package.json#dsh.client.inject 只声明真正消费且宿主必然提供的服务；
 *  - 其余一律 ctx.inject([...], cb) 可选注入（dsh-genui 纪律）——
 *    不因声明而把 apply() 卡死。
 *
 * 本插件核心渲染（DOM 观察 + iframe）不需要任何宿主服务即可独立运行；
 * 主题服务（ctx.theme）为可选增强：可用则接管主题直推，不可用则内核
 * DOM 采样兜底。
 */
import { createRenderer, LOCALES, VERSION } from './kernel.js'
import { installScheduler } from './scheduler.js'

window.__ModuleLoader__.load({
  id: 'dsh-html-ui',
  factory: function () {
    window.__dshHtmlUiAssetsBase = '/plugins/dsh-html-ui/assets/katex/'

    /* 旧版共存检测（决策 9）：不共存，明确提示。 */
    if (window.__dshHtmlRenderer) {
      try {
        console.warn(
          '[dsh-html-ui] 检测到旧版渲染器 window.__dshHtmlRenderer 仍存在（dsh-html-render 插件）。' +
          '两版不共存：请先卸载旧插件并重启，本插件不接管围栏。'
        )
      } catch (e) {}
      return {
        apply: function () { return function () {} },
      }
    }

    /* 版本守卫 */
    if (window.__dshHtmlUi) {
      var oldVersion = window.__dshHtmlUi.version || 0
      if (oldVersion >= VERSION) {
        return { apply: function () { return function () {} } }
      }
      try {
        if (typeof window.__dshHtmlUi.disable === 'function') window.__dshHtmlUi.disable()
      } catch (e) {}
    }

    return {
      apply: function (ctx) {
        var kernel = createRenderer({
          assetsBase: '/plugins/dsh-html-ui/assets/katex/',
        })
        window.__dshHtmlUi = kernel
        /* 观察接管器（P1）；dispose 挂到 disable */
        kernel._schedulerDispose = installScheduler(kernel)
        var origDisable = kernel.disable
        kernel.disable = function () {
          try { if (kernel._schedulerDispose) kernel._schedulerDispose() } catch (e) {}
          origDisable.call(kernel)
        }

        /* 可选服务：theme 直推（F10：绝不硬声明） */
        try {
          ctx.inject(['theme'], function (scope) {
            var themeSvc = scope.get('theme')
            if (!themeSvc) return
            var sync = function (snap) {
              var toks = snap && snap.active && snap.active.tokens
              var bg = toks && toks['--dsw-alias-bg-base']
              var fg = toks && toks['--dsw-alias-label-primary']
              kernel.setTheme({ bg, fg })
            }
            scope.on('theme/change', sync)
            try { sync(themeSvc.getTheme()) } catch (e) {}
          })
        } catch (e) {}

        /* 可选服务：i18n 字典 */
        try {
          ctx.inject(['locale'], function (scope) {
            var localeSvc = scope.get('locale')
            if (!localeSvc) return
            try { localeSvc.register('dsh-html-ui', { zh: LOCALES.zh, en: LOCALES.en }) } catch (e) {}
            try {
              var cur = localeSvc.getLocale && localeSvc.getLocale()
              if (cur === 'en' || (cur && cur.indexOf('en') === 0)) kernel.setLocale(LOCALES.en)
            } catch (e) {}
          })
        } catch (e) {}

        return function dispose() {
          try { if (window.__dshHtmlUi === kernel) kernel.disable() } catch (e) {}
        }
      },
    }
  },
})
