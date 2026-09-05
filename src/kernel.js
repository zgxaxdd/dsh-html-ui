/* dsh-html-ui v1.0.0 — L1 渲染内核工厂（Prism 风格，零 cordis 依赖）
 * dsh-html-ui version: 1
 *
 * F1–F10 修复要点：
 *  - F1：流式期间禁止任何 srcdoc 写入（闭合判定见 scheduler，本文件只负责
 *    renderWhenClosed 一次性挂载 + 源码/主题/重载三时机重建）
 *  - F4：iframe 内测高完全事件驱动（ResizeObserver + MutationObserver +
 *    fonts.ready + rAF 双帧复核），零定时器
 *  - F7：CSP 默认禁外链；allowRemoteImages 仅加 https:
 *  - F8：范围过滤（assistant 行）由 scheduler 做，本文件不管
 *  - 无缝切换：接管时刻用原块 offsetHeight 作为 iframe 初始高度（决策 3）
 *  - 源码视图 = 保留隐藏原代码块，切换即交换可见性（决策 5）
 */
import {
  wantsTakeoverRaw, buildCsp, replaceLatex, clampHeight, fnv1a32,
  safeColor, isVisibleContentBlock, DEFAULT_CONFIG,
} from './pure.js'

export const VERSION = 1

export {
  wantsTakeoverRaw, buildCsp, replaceLatex, clampHeight, fnv1a32,
  safeColor, isVisibleContentBlock, DEFAULT_CONFIG,
}

/* ------------------------------------------------------------------ *
 * 默认文案字典（zh/en；L3 可 setLocale 切换）
 * ------------------------------------------------------------------ */
export const LOCALES = {
  zh: {
    toolbar: {
      label: 'HTML',
      source: '源码', preview: '预览',
      tab: '新标签打开', copy: '复制', copied: '已复制', copyFailed: '复制失败',
      reload: '重载', truncated: '高度已截断', rendering: '渲染中…',
      sourceOnly: '仅源码',
    },
    oversized: { warn: '内容超过 1MB 上限，仅显示源码。' },
    error: { loadFailed: '预览加载失败，已回退为源码视图。', closed: '围栏未闭合，暂以源码显示。' },
    aria: {
      toolbar: 'dsh-html 预览工具栏', source: '切换源码和预览',
      tab: '在新标签页打开预览', copy: '复制 HTML 源码', reload: '重新渲染预览',
      frame: 'dsh-html 预览',
    },
  },
  en: {
    toolbar: {
      label: 'HTML',
      source: 'Source', preview: 'Preview',
      tab: 'Open in tab', copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed',
      reload: 'Reload', truncated: 'Height truncated', rendering: 'Rendering…',
      sourceOnly: 'Source only',
    },
    oversized: { warn: 'Content exceeds the 1MB limit; showing source only.' },
    error: { loadFailed: 'Preview failed to load; showing source.', closed: 'Fence not closed; showing source.' },
    aria: {
      toolbar: 'dsh-html preview toolbar', source: 'Toggle source and preview',
      tab: 'Open preview in a new tab', copy: 'Copy HTML source', reload: 'Re-render preview',
      frame: 'dsh-html preview',
    },
  },
}

/* ------------------------------------------------------------------ *
 * createRenderer — 内核工厂
 * ------------------------------------------------------------------ */
export function createRenderer(options = {}) {
  var win = options.window || window
  var doc = options.document || win.document
  var config = Object.assign({}, DEFAULT_CONFIG, options.config || {})
  var assetsBase = options.assetsBase || (win.__dshHtmlUiAssetsBase || '/plugins/dsh-html-ui/assets/katex/')
  var texRenderer = options.texRenderer || null
  var themeProvider = options.themeProvider || null   // () => {bg,fg}
  var dict = options.locale || LOCALES.zh
  var debug = !!options.debug
  var onError = options.onError || null

  var errCount = 0
  function dbg(e) {
    errCount++
    if (debug) { try { win.console && win.console.debug('[dsh-html-ui]', e) } catch (x) {} }
    if (onError) { try { onError(e) } catch (x) {} }
  }

  /* ------------------------------------------------------------------ *
   * KaTeX 通道（仅当 config.latex 且 hasLatex 时懒加载；资产走插件路由）
   * ------------------------------------------------------------------ */
  var katexState = null // null | 'loading' | 'ok' | 'fail'
  var katexAttempts = 0
  var katexQueue = null
  var katexFailQueue = null
  var katexCssCache = null
  var katexCssPromise = null
  var texCache = new Map()

  /* F3：只认 $$ / \[ \] / \( \) —— 单 $ 永不触发公式通道 */
  function hasLatex(raw) {
    if (raw.indexOf('$$') !== -1) return true
    if (/\\[\(\[][\s\S]*?\\[\)\]]/.test(raw)) return true
    return false
  }

  function ensureKatex(cb, onFail) {
    if (katexState === 'ok') { cb(); return }
    if (katexState === 'loading') { katexQueue.push(cb); if (onFail) katexFailQueue.push(onFail); return }
    if (katexState === 'fail') { if (onFail) onFail(); return }
    katexState = 'loading'
    katexQueue = [cb]
    katexFailQueue = onFail ? [onFail] : []
    var sc = doc.createElement('script')
    sc.src = assetsBase + 'katex.min.js?v=' + VERSION
    sc.async = true
    sc.onload = function () {
      katexState = 'ok'
      katexAttempts = 0
      var q = katexQueue
      katexQueue = null
      katexFailQueue = null
      for (var i = 0; i < q.length; i++) { try { q[i]() } catch (e) { dbg(e) } }
    }
    sc.onerror = function () {
      katexAttempts++
      katexState = 'fail'
      var qf = katexFailQueue
      katexQueue = null
      katexFailQueue = null
      for (var j = 0; qf && j < qf.length; j++) { try { qf[j]() } catch (e) { dbg(e) } }
      if (katexAttempts < 3) {
        var wait = 1000 * katexAttempts * katexAttempts
        win.setTimeout(function () { if (katexState === 'fail') katexState = null }, wait)
      }
    }
    ;(doc.head || doc.documentElement).appendChild(sc)
  }

  function ensureKatexCss(cb) {
    if (typeof katexCssCache === 'string') { cb(katexCssCache); return }
    if (katexCssPromise) { katexCssPromise.then(cb); return }
    /* 优先 data-URI 内联字体版（build.mjs 生成 katex.inline.css）——
     * 满足 CSP font-src data: 基线（F7 零外网）；404 回退 URL 改写版。 */
    katexCssPromise = win.fetch(assetsBase + 'katex.inline.css?v=' + VERSION)
      .then(function (r) { return r.ok ? r.text() : null })
      .then(function (inline) {
        if (inline) {
          inline += '.katex-display{overflow-x:auto;overflow-y:hidden;padding:2px 0}'
          katexCssCache = inline
          return inline
        }
        /* 回退：katex.min.css + 字体绝对路径改写（宿主 origin，同源可加载） */
        return win.fetch(assetsBase + 'katex.min.css?v=' + VERSION)
          .then(function (r) { return r.ok ? r.text() : null })
          .then(function (txt) {
            if (!txt) { katexCssPromise = null; return null }
            var out = txt.replace(
              /url\(["']?fonts\/([^)"']+)["']?\)/g,
              'url(' + assetsBase + 'fonts/$1?v=' + VERSION + ')'
            )
            out += '.katex-display{overflow-x:auto;overflow-y:hidden;padding:2px 0}'
            katexCssCache = out
            return out
          })
      })
      .catch(function () { katexCssCache = null; katexCssPromise = null; return null })
    katexCssPromise.then(cb)
  }

  function renderTex(src, display, fallback) {
    if (texRenderer) {
      try { return texRenderer(src, display) || fallback } catch (e) { dbg(e); return fallback }
    }
    try {
      if (!win.katex) return fallback
      var key = (display ? 'D:' : 'I:') + src
      if (texCache.has(key)) return texCache.get(key)
      var out = win.katex.renderToString(src, {
        displayMode: display, throwOnError: false, strict: false, trust: false,
        output: 'html', maxExpand: 1000, maxSize: 50,
      })
      if (texCache.size >= config.TEX_CACHE_MAX) texCache.clear()
      texCache.set(key, out)
      return out
    } catch (e) { dbg(e); return fallback }
  }

  /* enrich：latex 开启且有公式 → KaTeX 预渲染；否则原样。永不卡死。 */
  function enrichRaw(raw, cb) {
    if (!config.latex || !hasLatex(raw)) { cb(raw, null); return }
    ensureKatex(function () {
      ensureKatexCss(function (css) { cb(replaceLatex(raw, renderTex, config), css) })
    }, function () { cb(raw, null) })
  }

  /* ------------------------------------------------------------------ *
   * 主题：宿主对话区采样（safeColor 白名单）+ color-scheme
   * ------------------------------------------------------------------ */
  var paletteCache = { t: 0, bg: null, fg: null }
  function hostPalette() {
    var now = Date.now()
    if (now - paletteCache.t < 10000) return paletteCache
    var bg = null
    var fg = null
    function scan(start) {
      var el = start
      for (var n = 0; el && n < 12; n++, el = el.parentElement) {
        if (!el || el === doc.documentElement) break
        var cs = win.getComputedStyle(el)
        if (!bg) {
          var b = cs.backgroundColor
          if (b && b !== 'transparent' &&
              b.indexOf('rgba(0, 0, 0, 0)') !== 0 && b.indexOf('rgba(0,0,0,0)') !== 0) bg = b
        }
        if (!fg) {
          var c = cs.color
          if (c && c !== 'transparent' &&
              c.indexOf('rgba(0, 0, 0, 0)') !== 0 && c.indexOf('rgba(0,0,0,0)') !== 0) fg = c
        }
        if (bg && fg) break
      }
    }
    scan(doc.querySelector('[data-chat-anchor-key]'))
    scan(doc.body)
    paletteCache = { t: now, bg: safeColor(bg, 'Canvas'), fg: safeColor(fg, 'CanvasText') }
    return paletteCache
  }

  function currentPalette() {
    var pal = themeProvider ? (themeProvider() || {}) : hostPalette()
    return { bg: safeColor(pal.bg, 'Canvas'), fg: safeColor(pal.fg, 'CanvasText') }
  }

  /* ------------------------------------------------------------------ *
   * srcdoc 组装（CSP + 主题 + 测高脚本 + alert 重定向 + helper）
   * F4：测高完全事件驱动；零定时器。
   * ------------------------------------------------------------------ */
  function helperScript(mid) {
    return '<script>(function(){' +
      'var MID=' + (mid | 0) + ',MAX=' + config.maxHeight + ',PAD=' + config.heightPad + ',last=0,raf=0;' +
      'function contentH(){var b=document.body,h=document.documentElement;' +
      'var y1=b?b.getBoundingClientRect().bottom:0;' +
      'var y2=h?h.getBoundingClientRect().bottom:0;' +
      'return Math.ceil(Math.max(y1,y2));}' +
      'function report(){raf=0;var full=contentH()+PAD;var h=Math.min(full,MAX);' +
      'if(h===last)return;last=h;' +
      'try{parent.postMessage({kind:"dsh-html-ui-height",id:MID,h:h,full:full},"*")}catch(e){}}' +
      'function bump(){if(raf)return;raf=requestAnimationFrame(function(){' +
      'requestAnimationFrame(report)})}' + /* rAF 双帧复核（决策 F4） */
      'window.addEventListener("load",bump);' +
      'if(document.readyState!=="loading")bump();' +
      'if(window.ResizeObserver){' +
      'try{new ResizeObserver(bump).observe(document.documentElement)}catch(e){}' +
      'try{new ResizeObserver(bump).observe(document.body)}catch(e){}' +
      '}' +
      'if(window.MutationObserver){' +
      'try{new MutationObserver(bump).observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true})}catch(e){}' +
      '}' +
      'if(document.fonts&&document.fonts.ready){' +
      'try{document.fonts.ready.then(bump)}catch(e){}' +
      '}' +
      '})()<\/script>'
  }

  function wrapDocument(raw, katexCss, mid, tab) {
    var headExtra = katexCss ? '<style>' + katexCss + '</style>' : ''
    var pal = currentPalette()
    return (
      '<!doctype html><html><head><meta charset="utf-8">' +
      buildCsp(config.allowRemoteImages, tab) +
      headExtra +
      '</head><body style="margin:4px 6px;color-scheme:light dark;' +
      'background:' + pal.bg + ';color:' + pal.fg + ';">' +
      raw +
      /* alert/confirm/prompt → 页内 toast（保留旧版实现） */
      '<script>try{(function(){' +
      'function toast(m){var d=document.createElement("div");' +
      'd.style.cssText="position:fixed;right:12px;bottom:12px;z-index:2147483647;' +
      'background:rgba(30,41,59,.96);color:#e2e8f0;border-radius:8px;padding:8px 14px;' +
      'font:12px/1.5 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4);' +
      'max-width:80%;pointer-events:none";d.textContent=m;document.body.appendChild(d);' +
      'setTimeout(function(){d.remove()},2600)}' +
      'window.alert=function(m){toast("[alert] "+m)};' +
      'window.confirm=function(){toast("[confirm] 被沙箱阻断，已按“确定”返回 false");return false};' +
      'window.prompt=function(){toast("[prompt] 被沙箱阻断");return null}' +
      '})()}catch(e){}</script>' +
      helperScript(mid == null ? 0 : mid) +
      '</body></html>'
    )
  }

  /* ------------------------------------------------------------------ *
   * 样式（工具栏等；与旧版一致，悬停浮现）
   * ------------------------------------------------------------------ */
  var STYLE_ID = 'dsh-html-ui-style-v' + VERSION
  var styleInjected = false
  function injectStyle() {
    if (styleInjected) return
    styleInjected = true
    var existing = doc.querySelector('[id^="dsh-html-ui-style"]')
    if (existing) existing.remove()
    var style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent =
      '.dsh-html-ui-wrap{position:relative;margin:6px 0}' +
      '.dsh-html-ui-frame{width:100%;border:0;display:block}' +
      '.dsh-html-ui-toolbar{position:absolute;top:6px;right:8px;z-index:5;display:flex;' +
      'align-items:center;gap:4px;padding:3px 8px;border:1px solid rgba(128,128,128,.3);' +
      'border-radius:8px;background:rgba(255,255,255,.92);' +
      'background:light-dark(rgba(255,255,255,.92),rgba(28,32,46,.86));' +
      'color:#555;color:light-dark(#444,#e6e9f2);box-shadow:0 2px 10px rgba(0,0,0,.16);' +
      'backdrop-filter:blur(6px);opacity:0;pointer-events:none;' +
      'transition:opacity .15s ease;font:11px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'white-space:nowrap}' +
      '.dsh-html-ui-wrap:hover .dsh-html-ui-toolbar,.dsh-html-ui-toolbar:focus-within' +
      '{opacity:1;pointer-events:auto}' +
      /* 源码模式：iframe 隐藏后 wrap 塌缩、hover 区域消失 —— 工具栏常显。
       * 源码视图 = 原代码块显示在 wrap 之前，工具栏浮于其右上角。 */
      '.dsh-html-ui-wrap.dsh-html-ui-src-mode .dsh-html-ui-toolbar' +
      '{opacity:1;pointer-events:auto}' +
      '.dsh-html-ui-wrap.dsh-html-ui-src-mode{min-height:34px}' +
      '@media(hover:none){.dsh-html-ui-toolbar{opacity:1;pointer-events:auto}}' +
      '.dsh-html-ui-toolbar button:focus-visible{outline:2px solid #38bdf8;outline-offset:1px}' +
      '@media (prefers-reduced-motion: reduce){.dsh-html-ui-toolbar{transition:none}}' +
      '.dsh-html-ui-toolbar .lbl{font-weight:600}' +
      '.dsh-html-ui-toolbar .st{color:#b58900}' +
      '.dsh-html-ui-toolbar button{border:1px solid rgba(128,128,128,.45);background:transparent;' +
      'border-radius:6px;padding:1px 7px;font:inherit;color:inherit;cursor:pointer}' +
      '.dsh-html-ui-toolbar button:hover{background:rgba(128,128,128,.16)}' +
      '.dsh-html-ui-toolbar button:disabled{opacity:.45;cursor:default}' +
      '.dsh-html-ui-warn{padding:6px 8px;color:#b58900;font:12px/1.6 system-ui,sans-serif}'
    ;(doc.head || doc.documentElement).appendChild(style)
  }

  /* ------------------------------------------------------------------ *
   * HtmlFrame — 一次挂载、事件驱动高度、三时机重建（决策 5）
   * ------------------------------------------------------------------ */
  var mounts = new Map()      // block -> mount
  var liveFrames = new Map()  // id -> rec
  var mountSeq = 0

  function makeToolbar() {
    var bar = doc.createElement('div')
    bar.className = 'dsh-html-ui-toolbar'
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', dict.aria.toolbar)
    var lbl = doc.createElement('span'); lbl.className = 'lbl'; lbl.textContent = dict.toolbar.label
    var st = doc.createElement('span'); st.className = 'st'
    var bSrc = doc.createElement('button'); bSrc.textContent = dict.toolbar.source; bSrc.setAttribute('aria-label', dict.aria.source)
    var bTab = doc.createElement('button'); bTab.textContent = dict.toolbar.tab; bTab.setAttribute('aria-label', dict.aria.tab)
    var bCopy = doc.createElement('button'); bCopy.textContent = dict.toolbar.copy; bCopy.setAttribute('aria-label', dict.aria.copy)
    var bReload = doc.createElement('button'); bReload.textContent = dict.toolbar.reload; bReload.setAttribute('aria-label', dict.aria.reload)
    bar.appendChild(lbl); bar.appendChild(st); bar.appendChild(bSrc)
    bar.appendChild(bTab); bar.appendChild(bCopy); bar.appendChild(bReload)
    return { bar, lbl, st, bSrc, bTab, bCopy, bReload }
  }

  /* 内容哈希缓存（LRU）：srcdoc 与主题解耦 → 主题变化只重推 CSS 变量。
   * 注意：本版 CSP/主题色烙在 body style（决策 4），故缓存 key 含 palette；
   * 主题变化走 invalidateTheme 全量重建（决策 4 允许：主题变更是重建时机）。
   * 为降低重建成本，缓存 key = fnv(raw + palette.bg + palette.fg)。 */
  var contentCache = new Map()
  var cacheHits = 0
  var cacheMisses = 0
  function cacheGet(key) {
    var rec = contentCache.get(key)
    if (!rec) return null
    contentCache.delete(key); contentCache.set(key, rec)
    cacheHits++
    return rec
  }
  function cacheSet(key, rec) {
    if (contentCache.size >= 200) contentCache.delete(contentCache.keys().next().value)
    contentCache.set(key, rec)
    cacheMisses++
  }

  /* 渲染 srcdoc 到 iframe（enrich 异步）；仅在源码/主题/重载三时机调用。 */
  function renderFrame(mount) {
    if (!mount.iframe || mount._enriching) { mount._pending = true; return }
    var raw = mount.raw
    var pal = currentPalette()
    var key = fnv1a32(raw + '\u0001' + pal.bg + '\u0002' + pal.fg)
    var cached = cacheGet(key)
    if (cached) {
      mount.lastBody = cached.body
      mount.lastCss = cached.css
      var docHit = wrapDocument(cached.body, cached.css, mount.id, false)
      if (mount.iframe.srcdoc !== docHit) mount.iframe.srcdoc = docHit
      return
    }
    mount._enriching = true
    enrichRaw(raw, function (html, css) {
      mount._enriching = false
      if (mount._detached) return
      if (mount._pending) { mount._pending = false; renderFrame(mount); return }
      var rec2 = { body: html, css: css }
      cacheSet(key, rec2)
      mount.lastBody = html
      mount.lastCss = css
      var doc2 = wrapDocument(html, css, mount.id, false)
      if (mount.iframe.srcdoc !== doc2) mount.iframe.srcdoc = doc2
    })
  }

  /* mount(block, raw, opts)：一次性接管。opts.height = 原块 offsetHeight（决策 3）。
   * opts.sourceOnly = true → 仅源码视图（>1MB 降级，决策 8）。 */
  function mountBlock(block, raw, opts) {
    opts = opts || {}
    if (opts.sourceOnly) {
      /* 仅源码视图：工具栏 + 警告条，不建 iframe；仍纳入生命周期。 */
      var c = doc.createElement('div')
      c.className = 'dsh-html-ui-wrap'
      var soUi = makeToolbar()
      soUi.lbl.textContent = dict.toolbar.sourceOnly
      var warn = doc.createElement('div')
      warn.className = 'dsh-html-ui-warn'
      warn.textContent = dict.oversized.warn
      c.appendChild(soUi.bar)
      c.appendChild(warn)
      block.after(c)
      var soMount = {
        id: ++mountSeq,
        block, container: c, iframe: null, ui: soUi, view: null,
        raw, lastRaw: raw, lastBody: null, lastCss: null,
        settled: true, truncated: false, sourceView: true, oversized: true,
        _detached: false, _enriching: false, _pending: false,
        unmount: function () {
          soMount._detached = true
          c.remove()
          block.style.display = ''
          block.removeAttribute('data-dsh-html-ui')
        },
      }
      mounts.set(block, soMount)
      block.style.display = 'none'
      block.setAttribute('data-dsh-html-ui', '')
      return soMount
    }
    var initialHeight = opts.height || block.offsetHeight || 180
    var container = doc.createElement('div')
    container.className = 'dsh-html-ui-wrap'
    var ui = makeToolbar()
    var view = doc.createElement('div')
    var frame = doc.createElement('iframe')
    frame.className = 'dsh-html-ui-frame'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('loading', 'eager')
    frame.setAttribute('title', dict.aria.frame)
    frame.style.height = Math.max(40, initialHeight) + 'px'
    /* 无缝切换验证钩子：记录接管时刻的初始高度（决策 3） */
    frame.setAttribute('data-dsh-html-ui-init-h', String(Math.max(40, initialHeight)))
    view.appendChild(frame)
    container.appendChild(ui.bar)
    container.appendChild(view)
    block.after(container)

    var mount = {
      id: ++mountSeq,
      block, container, iframe: frame, ui, view,
      raw, lastRaw: raw, lastBody: null, lastCss: null,
      settled: true, truncated: false,
      sourceView: false,
      _detached: false, _enriching: false, _pending: false,
      unmount: function () {
        mount._detached = true
        liveFrames.delete(mount.id)
        container.remove()
        /* 还原原块可见性（决策 9：完整还原） */
        block.style.display = ''
        block.removeAttribute('data-dsh-html-ui')
      },
    }
    mounts.set(block, mount)
    liveFrames.set(mount.id, {
      iframe: frame,
      onHeight: function (h, trunc) {
        if (mount.truncated !== trunc) {
          mount.truncated = trunc
          mount.ui.st.textContent = trunc ? dict.toolbar.truncated : ''
        }
      },
    })

    /* 源码/预览切换（决策 5）：源码视图 = 显示原代码块，隐藏 iframe；
     * 源码模式下工具栏常显（wrap 塌缩后 hover 区域消失的修复）。 */
    ui.bSrc.addEventListener('click', function () {
      try {
        mount.sourceView = !mount.sourceView
        if (mount.sourceView) {
          frame.style.display = 'none'
          block.style.display = ''
          container.classList.add('dsh-html-ui-src-mode')
          ui.bSrc.textContent = dict.toolbar.preview
        } else {
          frame.style.display = 'block'
          block.style.display = 'none'
          container.classList.remove('dsh-html-ui-src-mode')
          ui.bSrc.textContent = dict.toolbar.source
          renderFrame(mount)
        }
      } catch (e) { dbg(e) }
    })
    ui.bTab.addEventListener('click', function () {
      try {
        var cssInline = ''
        var pal = currentPalette()
        cssInline += 'background:' + pal.bg + ';color:' + pal.fg + ';'
        var docTab = wrapDocument(mount.lastBody || raw, mount.lastCss || null, mount.id, true)
        docTab = docTab.replace(/<body style="[^"]*"/, '<body style="' + cssInline + 'margin:4px 6px;color-scheme:light dark;"')
        var url = win.URL.createObjectURL(new Blob([docTab], { type: 'text/html' }))
        win.open(url, '_blank', 'noopener')
        win.setTimeout(function () { try { win.URL.revokeObjectURL(url) } catch (e) { dbg(e) } }, 300000)
      } catch (e) { dbg(e) }
    })
    ui.bCopy.addEventListener('click', function () {
      var done = function () {
        ui.bCopy.textContent = dict.toolbar.copied
        win.setTimeout(function () { ui.bCopy.textContent = dict.toolbar.copy }, 900)
      }
      var fail = function () {
        ui.bCopy.textContent = dict.toolbar.copyFailed
        win.setTimeout(function () { ui.bCopy.textContent = dict.toolbar.copy }, 1200)
      }
      function legacy() {
        try {
          var ta = doc.createElement('textarea')
          ta.value = mount.raw
          ta.style.position = 'fixed'; ta.style.opacity = '0'
          doc.body.appendChild(ta); ta.select()
          var ok = doc.execCommand('copy')
          doc.body.removeChild(ta)
          ok ? done() : fail()
        } catch (e) { dbg(e); fail() }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(mount.raw).then(done, legacy)
        } else legacy()
      } catch (e) { dbg(e); try { legacy() } catch (x) { dbg(x) } }
    })
    ui.bReload.addEventListener('click', function () {
      try { renderFrame(mount) } catch (e) { dbg(e) }
    })

    /* D5：错误监听先于渲染注册 */
    frame.addEventListener('error', function () {
      errCount++
      try {
        frame.style.display = 'none'
        block.style.display = ''
        var warn = doc.createElement('div')
        warn.className = 'dsh-html-ui-warn'
        warn.textContent = dict.error.loadFailed
        view.appendChild(warn)
      } catch (e) { dbg(e) }
    })

    try {
      renderFrame(mount)
    } catch (e) {
      dbg(e)
      mount.unmount()
      mounts.delete(block)
      return
    }
    /* 先渲染后隐藏（dsh-genui 教训：mount 失败绝不隐藏原块） */
    block.style.display = 'none'
    block.setAttribute('data-dsh-html-ui', '')
    return mount
  }

  /* ------------------------------------------------------------------ *
   * 消息通道：高度（rAF 批处理写入器，F4）
   * ------------------------------------------------------------------ */
  var heightQueue = new Map()
  var heightRaf = null
  function flushHeights() {
    heightRaf = null
    if (heightQueue.size === 0) return
    var items = Array.from(heightQueue.values())
    heightQueue.clear()
    for (var i = 0; i < items.length; i++) {
      var it = items[i]
      try {
        if (!it.rec.iframe || !it.rec.iframe.isConnected) continue
        it.rec.iframe.style.height = it.h + 'px'
        if (it.rec.onHeight) it.rec.onHeight(it.h, it.trunc)
      } catch (e) { dbg(e) }
    }
  }
  function queueHeight(rec, h, trunc) {
    heightQueue.set(rec.id != null ? rec.id : rec, { rec, h, trunc })
    if (heightRaf === null) heightRaf = win.requestAnimationFrame(flushHeights)
  }

  win.addEventListener('message', function (ev) {
    var d = ev && ev.data
    if (!d) return
    if (d.kind === 'dsh-html-ui-height') {
      if (typeof d.h !== 'number' || typeof d.id !== 'number' || !ev.source) return
      var rec = liveFrames.get(d.id)
      if (!rec || !rec.iframe || rec.iframe.contentWindow !== ev.source) return
      queueHeight(rec, clampHeight(d.h, config.maxHeight), typeof d.full === 'number' ? d.full > config.maxHeight : false)
    }
  })

  /* ------------------------------------------------------------------ *
   * 主题即时跟随（决策 4：监听宿主主题变化重渲染；保留 themeObserver）
   * ------------------------------------------------------------------ */
  var themeObserver = null
  function invalidateTheme() {
    paletteCache.t = 0
    for (var m of mounts.values()) {
      if (m.iframe) { try { renderFrame(m) } catch (e) { dbg(e) } }
    }
  }
  function setupThemeFollow() {
    try {
      var mq = win.matchMedia('(prefers-color-scheme: dark)')
      var onScheme = function () { invalidateTheme() }
      if (mq.addEventListener) mq.addEventListener('change', onScheme)
      else if (mq.addListener) mq.addListener(onScheme)
    } catch (e) { dbg(e) }
    try {
      themeObserver = new MutationObserver(function () { invalidateTheme() })
      themeObserver.observe(doc.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode'],
      })
    } catch (e) { dbg(e) }
  }

  /* ------------------------------------------------------------------ *
   * 实例 API
   * ------------------------------------------------------------------ */
  var api = {
    version: VERSION,
    config,
    /* ---- scheduler 挂钩（P1 使用） ---- */
    _dbg: dbg,
    mountBlock, unmountBlock: function (block) {
      var m = mounts.get(block)
      if (!m) return
      mounts.delete(block)
      m.unmount()
    },
    hasMount: function (block) { return mounts.has(block) },
    stats: function () {
      var trunc = 0
      for (var m of mounts.values()) if (m.truncated) trunc++
      return {
        version: VERSION,
        mounts: mounts.size,
        liveFrames: liveFrames.size,
        truncated: trunc,
        katex: katexState,
        katexAttempts: katexAttempts,
        texCache: texCache.size,
        contentCache: contentCache.size,
        cacheHits, cacheMisses,
        errors: errCount,
        palette: { bg: paletteCache.bg, fg: paletteCache.fg },
      }
    },
    resetKatex: function () {
      katexState = null; katexAttempts = 0; katexCssCache = null; katexCssPromise = null; texCache.clear()
    },
    setLocale: function (l) { dict = l || LOCALES.zh },
    setTheme: function () { invalidateTheme() },
    setAssetsBase: function (b) { assetsBase = b || assetsBase; api.resetKatex() },
    disable: function () {
      if (disposed) return
      disposed = true
      if (themeObserver) { try { themeObserver.disconnect() } catch (e) {} }
      if (heightRaf !== null) win.cancelAnimationFrame(heightRaf)
      for (var entry of mounts.values()) { try { entry.unmount() } catch (e) { dbg(e) } }
      mounts.clear(); liveFrames.clear(); contentCache.clear()
      if (win.__dshHtmlUi === api) { try { delete win.__dshHtmlUi } catch (e) {} }
    },
  }
  var disposed = false

  /* 启动：注入工具栏样式 + 主题跟随（内核默认行为）。 */
  try { injectStyle() } catch (e) { dbg(e) }
  setupThemeFollow()

  return api
}
