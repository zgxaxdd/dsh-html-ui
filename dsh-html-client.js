(() => {
  // src/pure.js
  var DEFAULT_CONFIG = Object.freeze({
    latex: true,
    // F3：LaTeX 通道开关（默认开；false 则原文直出）
    allowRemoteImages: false,
    // F7：默认禁外链图片；true 仅追加 https:
    requireMarker: false,
    // 架构决策 1：true 时仅接管 info=html-render/dsh-html
    maxHeight: 12e3,
    // iframe 高度上限 px
    heightPad: 8,
    maxBytes: 1024 * 1024,
    // 源码 >1MB → 仅源码视图 mount（架构决策 8）
    maxFencesPerRow: 50,
    // 单行围栏数上限（防御）
    TEX_MAX_LEN: 2e3,
    // 单条公式源码上限
    TEX_MAX_COUNT: 200,
    // 单围栏公式数量上限
    TEX_CACHE_MAX: 300
    // KaTeX 结果缓存上限
  });
  function wantsTakeoverRaw(label, raw, config) {
    var cfg = config || DEFAULT_CONFIG;
    var l = (label || "").trim().toLowerCase();
    if (cfg.requireMarker) {
      return l === "html-render" || l === "dsh-html";
    }
    return l === "html" || l === "dsh-html";
  }
  function buildCsp(allowRemoteImages, tab) {
    var img = "img-src data: blob:";
    if (allowRemoteImages) img += " https:";
    var base = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " + img + "; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'";
    return '<meta http-equiv="Content-Security-Policy" content="' + (tab ? base + "; sandbox allow-scripts" : base) + '">';
  }
  function replaceLatex(raw, renderFn, config, phPrefix) {
    var cfg = config || DEFAULT_CONFIG;
    var tex = renderFn || function(s, display, full) {
      return full;
    };
    var PH = phPrefix || "\uE000" + Math.random().toString(36).slice(2, 8) + "-";
    var tokens = [];
    var kept = raw.replace(
      /<script[\s\S]*?<\/script\s*>|<style[\s\S]*?<\/style\s*>|<pre[\s\S]*?<\/pre\s*>|<code[\s\S]*?<\/code\s*>|<[^>]*>/gi,
      function(m) {
        tokens.push(m);
        return PH + (tokens.length - 1) + PH;
      }
    );
    var texCount = 0;
    function run(s, display, full) {
      if (++texCount > cfg.TEX_MAX_COUNT) return full;
      if (s.length > cfg.TEX_MAX_LEN) return full;
      try {
        return tex(s, display, full);
      } catch (e) {
        return full;
      }
    }
    kept = kept.replace(/\$\$([\s\S]+?)\$\$/g, function(m, s) {
      return run(s, true, m);
    }).replace(/\\\[([\s\S]+?)\\\]/g, function(m, s) {
      return run(s, true, m);
    }).replace(/\\\(([\s\S]+?)\\\)/g, function(m, s) {
      return run(s, false, m);
    });
    var re = new RegExp(PH + "(\\d+)" + PH, "g");
    return kept.replace(re, function(m, i) {
      var idx = +i;
      return idx >= 0 && idx < tokens.length ? tokens[idx] : m;
    });
  }
  function clampHeight(h, max) {
    return Math.max(40, Math.min(h, max));
  }
  function fnv1a32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h >>> 0;
  }
  function safeColor(c, fb) {
    if (typeof c !== "string") return fb;
    if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
    if (/^rgba?\([\d\s.,%]+\)$/.test(c)) return c;
    if (/^[a-z]+$/i.test(c)) return c;
    return fb;
  }
  function isVisibleContentBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return false;
    if (tag === "PRE" || tag === "CODE") return true;
    try {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        var cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
      }
    } catch (e) {
    }
    return true;
  }

  // src/kernel.js
  var VERSION = 1;
  var LOCALES = {
    zh: {
      toolbar: {
        label: "HTML",
        source: "\u6E90\u7801",
        preview: "\u9884\u89C8",
        tab: "\u65B0\u6807\u7B7E\u6253\u5F00",
        copy: "\u590D\u5236",
        copied: "\u5DF2\u590D\u5236",
        copyFailed: "\u590D\u5236\u5931\u8D25",
        reload: "\u91CD\u8F7D",
        truncated: "\u9AD8\u5EA6\u5DF2\u622A\u65AD",
        rendering: "\u6E32\u67D3\u4E2D\u2026",
        sourceOnly: "\u4EC5\u6E90\u7801"
      },
      oversized: { warn: "\u5185\u5BB9\u8D85\u8FC7 1MB \u4E0A\u9650\uFF0C\u4EC5\u663E\u793A\u6E90\u7801\u3002" },
      error: { loadFailed: "\u9884\u89C8\u52A0\u8F7D\u5931\u8D25\uFF0C\u5DF2\u56DE\u9000\u4E3A\u6E90\u7801\u89C6\u56FE\u3002", closed: "\u56F4\u680F\u672A\u95ED\u5408\uFF0C\u6682\u4EE5\u6E90\u7801\u663E\u793A\u3002" },
      aria: {
        toolbar: "dsh-html \u9884\u89C8\u5DE5\u5177\u680F",
        source: "\u5207\u6362\u6E90\u7801\u548C\u9884\u89C8",
        tab: "\u5728\u65B0\u6807\u7B7E\u9875\u6253\u5F00\u9884\u89C8",
        copy: "\u590D\u5236 HTML \u6E90\u7801",
        reload: "\u91CD\u65B0\u6E32\u67D3\u9884\u89C8",
        frame: "dsh-html \u9884\u89C8"
      }
    },
    en: {
      toolbar: {
        label: "HTML",
        source: "Source",
        preview: "Preview",
        tab: "Open in tab",
        copy: "Copy",
        copied: "Copied",
        copyFailed: "Copy failed",
        reload: "Reload",
        truncated: "Height truncated",
        rendering: "Rendering\u2026",
        sourceOnly: "Source only"
      },
      oversized: { warn: "Content exceeds the 1MB limit; showing source only." },
      error: { loadFailed: "Preview failed to load; showing source.", closed: "Fence not closed; showing source." },
      aria: {
        toolbar: "dsh-html preview toolbar",
        source: "Toggle source and preview",
        tab: "Open preview in a new tab",
        copy: "Copy HTML source",
        reload: "Re-render preview",
        frame: "dsh-html preview"
      }
    }
  };
  function createRenderer(options = {}) {
    var win = options.window || window;
    var doc = options.document || win.document;
    var config = Object.assign({}, DEFAULT_CONFIG, options.config || {});
    var assetsBase = options.assetsBase || (win.__dshHtmlUiAssetsBase || "/plugins/dsh-html-ui/assets/katex/");
    var texRenderer = options.texRenderer || null;
    var themeProvider = options.themeProvider || null;
    var dict = options.locale || LOCALES.zh;
    var debug = !!options.debug;
    var onError = options.onError || null;
    var errCount = 0;
    function dbg(e) {
      errCount++;
      if (debug) {
        try {
          win.console && win.console.debug("[dsh-html-ui]", e);
        } catch (x) {
        }
      }
      if (onError) {
        try {
          onError(e);
        } catch (x) {
        }
      }
    }
    var katexState = null;
    var katexAttempts = 0;
    var katexQueue = null;
    var katexFailQueue = null;
    var katexCssCache = null;
    var katexCssPromise = null;
    var texCache = /* @__PURE__ */ new Map();
    function hasLatex(raw) {
      if (raw.indexOf("$$") !== -1) return true;
      if (/\\[\(\[][\s\S]*?\\[\)\]]/.test(raw)) return true;
      return false;
    }
    function ensureKatex(cb, onFail) {
      if (win.katex && typeof win.katex.renderToString === "function") {
        katexState = "ok";
        cb();
        return;
      }
      if (katexState === "ok") {
        cb();
        return;
      }
      if (katexState === "loading") {
        katexQueue.push(cb);
        if (onFail) katexFailQueue.push(onFail);
        return;
      }
      if (katexState === "fail") {
        if (onFail) onFail();
        return;
      }
      katexState = "loading";
      katexQueue = [cb];
      katexFailQueue = onFail ? [onFail] : [];
      var sc = doc.createElement("script");
      sc.src = assetsBase + "katex.min.js?v=" + VERSION;
      sc.async = true;
      sc.onload = function() {
        katexState = "ok";
        katexAttempts = 0;
        var q = katexQueue;
        katexQueue = null;
        katexFailQueue = null;
        for (var i = 0; i < q.length; i++) {
          try {
            q[i]();
          } catch (e) {
            dbg(e);
          }
        }
      };
      sc.onerror = function() {
        katexAttempts++;
        katexState = "fail";
        var qf = katexFailQueue;
        katexQueue = null;
        katexFailQueue = null;
        for (var j = 0; qf && j < qf.length; j++) {
          try {
            qf[j]();
          } catch (e) {
            dbg(e);
          }
        }
        if (katexAttempts < 3) {
          var wait = 1e3 * katexAttempts * katexAttempts;
          win.setTimeout(function() {
            if (katexState === "fail") katexState = null;
          }, wait);
        }
      };
      (doc.head || doc.documentElement).appendChild(sc);
    }
    function ensureKatexCss(cb) {
      if (typeof katexCssCache === "string") {
        cb(katexCssCache);
        return;
      }
      if (katexCssPromise) {
        katexCssPromise.then(cb);
        return;
      }
      katexCssPromise = win.fetch(assetsBase + "katex.inline.css?v=" + VERSION).then(function(r) {
        return r.ok ? r.text() : null;
      }).then(function(inline) {
        if (inline) {
          inline += ".katex-display{overflow-x:auto;overflow-y:hidden;padding:2px 0}";
          katexCssCache = inline;
          return inline;
        }
        return win.fetch(assetsBase + "katex.min.css?v=" + VERSION).then(function(r) {
          return r.ok ? r.text() : null;
        }).then(function(txt) {
          if (!txt) {
            katexCssPromise = null;
            return null;
          }
          var out = txt.replace(
            /url\(["']?fonts\/([^)"']+)["']?\)/g,
            "url(" + assetsBase + "fonts/$1?v=" + VERSION + ")"
          );
          out += ".katex-display{overflow-x:auto;overflow-y:hidden;padding:2px 0}";
          katexCssCache = out;
          return out;
        });
      }).catch(function() {
        katexCssCache = null;
        katexCssPromise = null;
        return null;
      });
      katexCssPromise.then(cb);
    }
    function renderTex(src, display, fallback) {
      if (texRenderer) {
        try {
          return texRenderer(src, display) || fallback;
        } catch (e) {
          dbg(e);
          return fallback;
        }
      }
      try {
        if (!win.katex) return fallback;
        var key = (display ? "D:" : "I:") + src;
        if (texCache.has(key)) return texCache.get(key);
        var out = win.katex.renderToString(src, {
          displayMode: display,
          throwOnError: false,
          strict: false,
          trust: false,
          output: "html",
          maxExpand: 1e3,
          maxSize: 50
        });
        if (texCache.size >= config.TEX_CACHE_MAX) texCache.clear();
        texCache.set(key, out);
        return out;
      } catch (e) {
        dbg(e);
        return fallback;
      }
    }
    function enrichRaw(raw, cb) {
      if (!config.latex || !hasLatex(raw)) {
        cb(raw, null);
        return;
      }
      ensureKatex(function() {
        ensureKatexCss(function(css) {
          cb(replaceLatex(raw, renderTex, config), css);
        });
      }, function() {
        cb(raw, null);
      });
    }
    var paletteCache = { t: 0, bg: null, fg: null };
    function hostPalette() {
      var now = Date.now();
      if (now - paletteCache.t < 1e4) return paletteCache;
      var bg = null;
      var fg = null;
      function scan(start) {
        var el = start;
        for (var n = 0; el && n < 12; n++, el = el.parentElement) {
          if (!el || el === doc.documentElement) break;
          var cs = win.getComputedStyle(el);
          if (!bg) {
            var b = cs.backgroundColor;
            if (b && b !== "transparent" && b.indexOf("rgba(0, 0, 0, 0)") !== 0 && b.indexOf("rgba(0,0,0,0)") !== 0) bg = b;
          }
          if (!fg) {
            var c = cs.color;
            if (c && c !== "transparent" && c.indexOf("rgba(0, 0, 0, 0)") !== 0 && c.indexOf("rgba(0,0,0,0)") !== 0) fg = c;
          }
          if (bg && fg) break;
        }
      }
      scan(doc.querySelector("[data-chat-anchor-key]"));
      scan(doc.body);
      paletteCache = { t: now, bg: safeColor(bg, "Canvas"), fg: safeColor(fg, "CanvasText") };
      return paletteCache;
    }
    function currentPalette() {
      var pal = themeProvider ? themeProvider() || {} : hostPalette();
      return { bg: safeColor(pal.bg, "Canvas"), fg: safeColor(pal.fg, "CanvasText") };
    }
    function helperScript(mid) {
      return "<script>(function(){var MID=" + (mid | 0) + ",MAX=" + config.maxHeight + ",PAD=" + config.heightPad + ',last=0,raf=0;function contentH(){var b=document.body,h=document.documentElement;var y1=b?b.getBoundingClientRect().bottom:0;var y2=h?h.getBoundingClientRect().bottom:0;return Math.ceil(Math.max(y1,y2));}function report(){raf=0;var full=contentH()+PAD;var h=Math.min(full,MAX);if(h===last)return;last=h;try{parent.postMessage({kind:"dsh-html-ui-height",id:MID,h:h,full:full},"*")}catch(e){}}function bump(){if(raf)return;raf=requestAnimationFrame(function(){requestAnimationFrame(report)})}window.addEventListener("load",bump);if(document.readyState!=="loading")bump();if(window.ResizeObserver){try{new ResizeObserver(bump).observe(document.documentElement)}catch(e){}try{new ResizeObserver(bump).observe(document.body)}catch(e){}}if(window.MutationObserver){try{new MutationObserver(bump).observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true})}catch(e){}}if(document.fonts&&document.fonts.ready){try{document.fonts.ready.then(bump)}catch(e){}}})()<\/script>';
    }
    function wrapDocument(raw, katexCss, mid, tab) {
      var headExtra = katexCss ? "<style>" + katexCss + "</style>" : "";
      var pal = currentPalette();
      return '<!doctype html><html><head><meta charset="utf-8">' + buildCsp(config.allowRemoteImages, tab) + headExtra + '</head><body style="margin:4px 6px;color-scheme:light dark;background:' + pal.bg + ";color:" + pal.fg + ';">' + raw + /* alert/confirm/prompt → 页内 toast（保留旧版实现） */
      '<script>try{(function(){function toast(m){var d=document.createElement("div");d.style.cssText="position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(30,41,59,.96);color:#e2e8f0;border-radius:8px;padding:8px 14px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4);max-width:80%;pointer-events:none";d.textContent=m;document.body.appendChild(d);setTimeout(function(){d.remove()},2600)}window.alert=function(m){toast("[alert] "+m)};window.confirm=function(){toast("[confirm] \u88AB\u6C99\u7BB1\u963B\u65AD\uFF0C\u5DF2\u6309\u201C\u786E\u5B9A\u201D\u8FD4\u56DE false");return false};window.prompt=function(){toast("[prompt] \u88AB\u6C99\u7BB1\u963B\u65AD");return null}})()}catch(e){}<\/script>' + helperScript(mid == null ? 0 : mid) + "</body></html>";
    }
    var STYLE_ID = "dsh-html-ui-style-v" + VERSION;
    var styleInjected = false;
    function injectStyle() {
      if (styleInjected) return;
      styleInjected = true;
      var existing = doc.querySelector('[id^="dsh-html-ui-style"]');
      if (existing) existing.remove();
      var style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = /* 撑满父容器宽度（块级 + flex/grid 子项兼容：min-width:0 防内容
       * 把容器撑出；flex:1 1 0 让 flex 父容器下也占满剩余空间） */
      '.dsh-html-ui-wrap{position:relative;margin:6px 0;width:100%;min-width:0;flex:1 1 0;box-sizing:border-box}.dsh-html-ui-frame{width:100%;border:0;display:block}.dsh-html-ui-toolbar{position:absolute;top:6px;right:8px;z-index:5;display:flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid rgba(128,128,128,.3);border-radius:8px;background:rgba(255,255,255,.92);background:light-dark(rgba(255,255,255,.92),rgba(28,32,46,.86));color:#555;color:light-dark(#444,#e6e9f2);box-shadow:0 2px 10px rgba(0,0,0,.16);backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .15s ease;font:11px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap}.dsh-html-ui-wrap:hover .dsh-html-ui-toolbar,.dsh-html-ui-toolbar:focus-within{opacity:1;pointer-events:auto}.dsh-html-ui-wrap.dsh-html-ui-src-mode .dsh-html-ui-toolbar{opacity:1;pointer-events:auto}.dsh-html-ui-wrap.dsh-html-ui-src-mode{min-height:34px}@media(hover:none){.dsh-html-ui-toolbar{opacity:1;pointer-events:auto}}.dsh-html-ui-toolbar button:focus-visible{outline:2px solid #38bdf8;outline-offset:1px}@media (prefers-reduced-motion: reduce){.dsh-html-ui-toolbar{transition:none}}.dsh-html-ui-toolbar .lbl{font-weight:600}.dsh-html-ui-toolbar .st{color:#b58900}.dsh-html-ui-toolbar button{border:1px solid rgba(128,128,128,.45);background:transparent;border-radius:6px;padding:1px 7px;font:inherit;color:inherit;cursor:pointer}.dsh-html-ui-toolbar button:hover{background:rgba(128,128,128,.16)}.dsh-html-ui-toolbar button:disabled{opacity:.45;cursor:default}.dsh-html-ui-warn{padding:6px 8px;color:#b58900;font:12px/1.6 system-ui,sans-serif}.dsh-html-ui-src{max-height:420px;overflow:auto;padding:10px 12px;margin:0;font:12px/1.6 ui-monospace,Consolas,"SF Mono",monospace;white-space:pre;background:rgba(128,128,128,.06);color:light-dark(#1f2937,#e5e7eb);border-radius:8px}';
      (doc.head || doc.documentElement).appendChild(style);
    }
    var mounts = /* @__PURE__ */ new Map();
    var liveFrames = /* @__PURE__ */ new Map();
    var mountSeq = 0;
    function makeToolbar() {
      var bar = doc.createElement("div");
      bar.className = "dsh-html-ui-toolbar";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", dict.aria.toolbar);
      var lbl = doc.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = dict.toolbar.label;
      var st = doc.createElement("span");
      st.className = "st";
      var bSrc = doc.createElement("button");
      bSrc.textContent = dict.toolbar.source;
      bSrc.setAttribute("aria-label", dict.aria.source);
      var bTab = doc.createElement("button");
      bTab.textContent = dict.toolbar.tab;
      bTab.setAttribute("aria-label", dict.aria.tab);
      var bCopy = doc.createElement("button");
      bCopy.textContent = dict.toolbar.copy;
      bCopy.setAttribute("aria-label", dict.aria.copy);
      var bReload = doc.createElement("button");
      bReload.textContent = dict.toolbar.reload;
      bReload.setAttribute("aria-label", dict.aria.reload);
      bar.appendChild(lbl);
      bar.appendChild(st);
      bar.appendChild(bSrc);
      bar.appendChild(bTab);
      bar.appendChild(bCopy);
      bar.appendChild(bReload);
      return { bar, lbl, st, bSrc, bTab, bCopy, bReload };
    }
    var contentCache = /* @__PURE__ */ new Map();
    var cacheHits = 0;
    var cacheMisses = 0;
    function cacheGet(key) {
      var rec = contentCache.get(key);
      if (!rec) return null;
      contentCache.delete(key);
      contentCache.set(key, rec);
      cacheHits++;
      return rec;
    }
    function cacheSet(key, rec) {
      if (contentCache.size >= 200) contentCache.delete(contentCache.keys().next().value);
      contentCache.set(key, rec);
      cacheMisses++;
    }
    function renderFrame(mount) {
      if (!mount.iframe || mount._enriching) {
        mount._pending = true;
        return;
      }
      var raw = mount.raw;
      var pal = currentPalette();
      var key = fnv1a32(raw + "" + pal.bg + "" + pal.fg);
      var cached = cacheGet(key);
      if (cached) {
        mount.lastBody = cached.body;
        mount.lastCss = cached.css;
        var docHit = wrapDocument(cached.body, cached.css, mount.id, false);
        if (mount.iframe.srcdoc !== docHit) mount.iframe.srcdoc = docHit;
        return;
      }
      mount._enriching = true;
      enrichRaw(raw, function(html, css) {
        mount._enriching = false;
        if (mount._detached) return;
        if (mount._pending) {
          mount._pending = false;
          renderFrame(mount);
          return;
        }
        var rec2 = { body: html, css };
        cacheSet(key, rec2);
        mount.lastBody = html;
        mount.lastCss = css;
        var doc2 = wrapDocument(html, css, mount.id, false);
        if (mount.iframe.srcdoc !== doc2) mount.iframe.srcdoc = doc2;
      });
    }
    function mountBlock(block, raw, opts) {
      opts = opts || {};
      if (opts.sourceOnly) {
        var c = doc.createElement("div");
        c.className = "dsh-html-ui-wrap";
        var soUi = makeToolbar();
        soUi.lbl.textContent = dict.toolbar.sourceOnly;
        var warn = doc.createElement("div");
        warn.className = "dsh-html-ui-warn";
        warn.textContent = dict.oversized.warn;
        c.appendChild(soUi.bar);
        c.appendChild(warn);
        block.after(c);
        var soMount = {
          id: ++mountSeq,
          block,
          container: c,
          iframe: null,
          ui: soUi,
          view: null,
          raw,
          lastRaw: raw,
          lastBody: null,
          lastCss: null,
          settled: true,
          truncated: false,
          sourceView: true,
          oversized: true,
          _detached: false,
          _enriching: false,
          _pending: false,
          unmount: function() {
            soMount._detached = true;
            c.remove();
            block.style.display = "";
            block.removeAttribute("data-dsh-html-ui");
          }
        };
        mounts.set(block, soMount);
        block.style.display = "none";
        block.setAttribute("data-dsh-html-ui", "");
        return soMount;
      }
      var initialHeight = opts.height || block.offsetHeight || 180;
      var container = doc.createElement("div");
      container.className = "dsh-html-ui-wrap";
      var ui = makeToolbar();
      var view = doc.createElement("div");
      var frame = doc.createElement("iframe");
      frame.className = "dsh-html-ui-frame";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("loading", "eager");
      frame.setAttribute("title", dict.aria.frame);
      frame.style.height = Math.max(40, initialHeight) + "px";
      frame.setAttribute("data-dsh-html-ui-init-h", String(Math.max(40, initialHeight)));
      view.appendChild(frame);
      container.appendChild(ui.bar);
      container.appendChild(view);
      block.after(container);
      var mount = {
        id: ++mountSeq,
        block,
        container,
        iframe: frame,
        ui,
        view,
        raw,
        lastRaw: raw,
        lastBody: null,
        lastCss: null,
        settled: true,
        truncated: false,
        sourceView: false,
        _detached: false,
        _enriching: false,
        _pending: false,
        unmount: function() {
          mount._detached = true;
          liveFrames.delete(mount.id);
          container.remove();
          block.style.display = "";
          block.removeAttribute("data-dsh-html-ui");
        }
      };
      mounts.set(block, mount);
      liveFrames.set(mount.id, {
        iframe: frame,
        onHeight: function(h, trunc) {
          if (mount.truncated !== trunc) {
            mount.truncated = trunc;
            mount.ui.st.textContent = trunc ? dict.toolbar.truncated : "";
          }
        }
      });
      ui.bSrc.addEventListener("click", function() {
        try {
          mount.sourceView = !mount.sourceView;
          if (mount.sourceView) {
            frame.style.display = "none";
            view.textContent = "";
            var pre = doc.createElement("pre");
            pre.className = "dsh-html-ui-src";
            pre.textContent = mount.raw;
            view.appendChild(pre);
            container.classList.add("dsh-html-ui-src-mode");
            ui.bSrc.textContent = dict.toolbar.preview;
          } else {
            view.textContent = "";
            view.appendChild(frame);
            frame.style.display = "block";
            container.classList.remove("dsh-html-ui-src-mode");
            ui.bSrc.textContent = dict.toolbar.source;
            renderFrame(mount);
          }
        } catch (e) {
          dbg(e);
        }
      });
      ui.bTab.addEventListener("click", function() {
        try {
          var cssInline = "";
          var pal = currentPalette();
          cssInline += "background:" + pal.bg + ";color:" + pal.fg + ";";
          var docTab = wrapDocument(mount.lastBody || raw, mount.lastCss || null, mount.id, true);
          docTab = docTab.replace(/<body style="[^"]*"/, '<body style="' + cssInline + 'margin:4px 6px;color-scheme:light dark;"');
          var url = win.URL.createObjectURL(new Blob([docTab], { type: "text/html" }));
          win.open(url, "_blank", "noopener");
          win.setTimeout(function() {
            try {
              win.URL.revokeObjectURL(url);
            } catch (e) {
              dbg(e);
            }
          }, 3e5);
        } catch (e) {
          dbg(e);
        }
      });
      ui.bCopy.addEventListener("click", function() {
        var done = function() {
          ui.bCopy.textContent = dict.toolbar.copied;
          win.setTimeout(function() {
            ui.bCopy.textContent = dict.toolbar.copy;
          }, 900);
        };
        var fail = function() {
          ui.bCopy.textContent = dict.toolbar.copyFailed;
          win.setTimeout(function() {
            ui.bCopy.textContent = dict.toolbar.copy;
          }, 1200);
        };
        function legacy() {
          try {
            var ta = doc.createElement("textarea");
            ta.value = mount.raw;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            doc.body.appendChild(ta);
            ta.select();
            var ok = doc.execCommand("copy");
            doc.body.removeChild(ta);
            ok ? done() : fail();
          } catch (e) {
            dbg(e);
            fail();
          }
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(mount.raw).then(done, legacy);
          } else legacy();
        } catch (e) {
          dbg(e);
          try {
            legacy();
          } catch (x) {
            dbg(x);
          }
        }
      });
      ui.bReload.addEventListener("click", function() {
        try {
          renderFrame(mount);
        } catch (e) {
          dbg(e);
        }
      });
      frame.addEventListener("error", function() {
        errCount++;
        try {
          frame.style.display = "none";
          block.style.display = "";
          var warn2 = doc.createElement("div");
          warn2.className = "dsh-html-ui-warn";
          warn2.textContent = dict.error.loadFailed;
          view.appendChild(warn2);
        } catch (e) {
          dbg(e);
        }
      });
      try {
        renderFrame(mount);
      } catch (e) {
        dbg(e);
        mount.unmount();
        mounts.delete(block);
        return;
      }
      block.style.display = "none";
      block.setAttribute("data-dsh-html-ui", "");
      return mount;
    }
    var heightQueue = /* @__PURE__ */ new Map();
    var heightRaf = null;
    function flushHeights() {
      heightRaf = null;
      if (heightQueue.size === 0) return;
      var items = Array.from(heightQueue.values());
      heightQueue.clear();
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        try {
          if (!it.rec.iframe || !it.rec.iframe.isConnected) continue;
          it.rec.iframe.style.height = it.h + "px";
          if (it.rec.onHeight) it.rec.onHeight(it.h, it.trunc);
        } catch (e) {
          dbg(e);
        }
      }
    }
    function queueHeight(rec, h, trunc) {
      heightQueue.set(rec.id != null ? rec.id : rec, { rec, h, trunc });
      if (heightRaf === null) heightRaf = win.requestAnimationFrame(flushHeights);
    }
    win.addEventListener("message", function(ev) {
      var d = ev && ev.data;
      if (!d) return;
      if (d.kind === "dsh-html-ui-height") {
        if (typeof d.h !== "number" || typeof d.id !== "number" || !ev.source) return;
        var rec = liveFrames.get(d.id);
        if (!rec || !rec.iframe || rec.iframe.contentWindow !== ev.source) return;
        queueHeight(rec, clampHeight(d.h, config.maxHeight), typeof d.full === "number" ? d.full > config.maxHeight : false);
      }
    });
    var themeObserver = null;
    function invalidateTheme() {
      paletteCache.t = 0;
      for (var m of mounts.values()) {
        if (m.iframe) {
          try {
            renderFrame(m);
          } catch (e) {
            dbg(e);
          }
        }
      }
    }
    function setupThemeFollow() {
      try {
        var mq = win.matchMedia("(prefers-color-scheme: dark)");
        var onScheme = function() {
          invalidateTheme();
        };
        if (mq.addEventListener) mq.addEventListener("change", onScheme);
        else if (mq.addListener) mq.addListener(onScheme);
      } catch (e) {
        dbg(e);
      }
      try {
        themeObserver = new MutationObserver(function() {
          invalidateTheme();
        });
        themeObserver.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ["class", "style", "data-theme", "data-color-mode"]
        });
      } catch (e) {
        dbg(e);
      }
    }
    var api = {
      version: VERSION,
      config,
      /* ---- scheduler 挂钩（P1 使用） ---- */
      _dbg: dbg,
      mountBlock,
      unmountBlock: function(block) {
        var m = mounts.get(block);
        if (!m) return;
        mounts.delete(block);
        m.unmount();
      },
      hasMount: function(block) {
        return mounts.has(block);
      },
      stats: function() {
        var trunc = 0;
        for (var m of mounts.values()) if (m.truncated) trunc++;
        return {
          version: VERSION,
          mounts: mounts.size,
          liveFrames: liveFrames.size,
          truncated: trunc,
          katex: katexState,
          katexAttempts,
          texCache: texCache.size,
          contentCache: contentCache.size,
          cacheHits,
          cacheMisses,
          errors: errCount,
          palette: { bg: paletteCache.bg, fg: paletteCache.fg }
        };
      },
      resetKatex: function() {
        katexState = null;
        katexAttempts = 0;
        katexCssCache = null;
        katexCssPromise = null;
        texCache.clear();
      },
      setLocale: function(l) {
        dict = l || LOCALES.zh;
      },
      setTheme: function() {
        invalidateTheme();
      },
      setAssetsBase: function(b) {
        assetsBase = b || assetsBase;
        api.resetKatex();
      },
      disable: function() {
        if (disposed) return;
        disposed = true;
        if (themeObserver) {
          try {
            themeObserver.disconnect();
          } catch (e) {
          }
        }
        if (heightRaf !== null) win.cancelAnimationFrame(heightRaf);
        for (var entry of mounts.values()) {
          try {
            entry.unmount();
          } catch (e) {
            dbg(e);
          }
        }
        mounts.clear();
        liveFrames.clear();
        contentCache.clear();
        if (win.__dshHtmlUi === api) {
          try {
            delete win.__dshHtmlUi;
          } catch (e) {
          }
        }
      }
    };
    var disposed = false;
    try {
      injectStyle();
    } catch (e) {
      dbg(e);
    }
    setupThemeFollow();
    return api;
  }

  // src/scheduler.js
  var PROCESSED = "data-dsh-html-ui";
  var CODE_SELECTORS = ".md-code-block, .code-block, .code-block-small";
  var STREAMING = "[data-streaming]";
  var SWEEP_MS = 1e3;
  var SURFACE_HOPS = 4;
  var BLOCK_CONTENT_SELECTOR = "p, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, blockquote, hr, img, figure";
  function installScheduler(kernel, options = {}) {
    var win = options.window || window;
    var doc = options.document || win.document;
    var config = kernel.config || {};
    var getLabel = options.getLabel || labelTextOf;
    var mounts = /* @__PURE__ */ new Map();
    var changedBlocks = /* @__PURE__ */ new Set();
    var settleState = /* @__PURE__ */ new Map();
    var disposed = false;
    var rafId = null;
    var intervalId = null;
    var mo = null;
    function rawOf(block) {
      var pre = block.querySelector("pre");
      if (!pre) return "";
      var text = "";
      for (var i = 0; i < pre.childNodes.length; i++) text += pre.childNodes[i].textContent || "";
      return text;
    }
    function labelTextOf(block) {
      var pre = block.querySelector("pre");
      var els = block.querySelectorAll("*");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.childElementCount !== 0) continue;
        if (pre && pre.contains(el)) continue;
        return el.textContent || "";
      }
      return "";
    }
    function isPlausibleFenceSurface(candidate) {
      var pres = candidate.querySelectorAll("pre");
      if (pres.length > 1) return false;
      var pre = pres[0] || null;
      var els = candidate.querySelectorAll(BLOCK_CONTENT_SELECTOR);
      for (var i = 0; i < els.length; i++) {
        if (pre && pre.contains(els[i])) continue;
        return false;
      }
      return true;
    }
    function isAssistantRow(block) {
      var row = block.closest("[data-chat-anchor-key]");
      if (row) {
        var anchor = row.getAttribute("data-chat-anchor-key") || "";
        if (anchor.indexOf("assistant") !== -1) return true;
      }
      var kind = block.closest("[data-chat-flow-kind]");
      if (kind) {
        var k = kind.getAttribute("data-chat-flow-kind") || "";
        if (k === "assistant") return true;
      }
      return false;
    }
    function findFenceCandidates() {
      var seen = /* @__PURE__ */ new Set();
      var out = [];
      var els = doc.querySelectorAll(CODE_SELECTORS);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.parentElement && el.parentElement.closest && el.parentElement.closest(CODE_SELECTORS)) continue;
        if (seen.has(el)) continue;
        if (!isPlausibleFenceSurface(el)) continue;
        out.push(el);
        seen.add(el);
      }
      var pres = doc.querySelectorAll("pre");
      for (var j = 0; j < pres.length; j++) {
        var pre = pres[j];
        if (pre.closest && pre.closest(CODE_SELECTORS)) continue;
        var el2 = pre.parentElement;
        for (var hops = 0; el2 && hops < SURFACE_HOPS; hops++, el2 = el2.parentElement) {
          if (!isPlausibleFenceSurface(el2)) break;
          var lbl = labelTextOf(el2);
          if (lbl !== "html" && lbl !== "dsh-html" && lbl !== "html-render") continue;
          if (seen.has(el2)) continue;
          seen.add(el2);
          out.push(el2);
          break;
        }
      }
      return out;
    }
    function blockOf(node) {
      var el = node && node.nodeType === 1 ? node : node && node.parentElement;
      if (!el) return null;
      var found = el.closest ? el.closest(CODE_SELECTORS) : null;
      if (found && isPlausibleFenceSurface(found)) return found;
      if (el.tagName === "PRE" && !el.closest(CODE_SELECTORS)) {
        var cur = el;
        for (var hops = 0; cur && hops < SURFACE_HOPS; hops++, cur = cur.parentElement) {
          if (!isPlausibleFenceSurface(cur)) continue;
          var lbl = labelTextOf(cur);
          if (lbl === "html" || lbl === "dsh-html" || lbl === "html-render") return cur;
        }
      }
      return null;
    }
    function isClosed(block, state) {
      var next = block.nextElementSibling;
      if (next && isVisibleContentBlock(next)) return { closed: true, via: "next-block" };
      var streaming = block.closest(STREAMING);
      if (!streaming) return { closed: true, via: "streaming-gone" };
      var hash = fnv1a32(rawOf(block));
      if (!state) state = { lastHash: hash, noChangeStreak: 0, charDirty: true };
      if (state.charDirty) {
        state.charDirty = false;
        state.lastHash = hash;
        state.noChangeStreak = 0;
        return { closed: false, via: "streaming", state };
      }
      if (hash === state.lastHash) {
        state.noChangeStreak++;
        if (state.noChangeStreak >= 2) return { closed: true, via: "no-change", state };
      } else {
        state.lastHash = hash;
        state.noChangeStreak = 0;
      }
      return { closed: false, via: "streaming", state };
    }
    function takeOver(block, raw) {
      if (mounts.has(block)) return;
      if (raw.length > config.maxBytes) {
        kernel.mountBlock(block, raw, { height: block.offsetHeight, sourceOnly: true });
        mounts.set(block, true);
        return;
      }
      var h = block.offsetHeight || 180;
      var mount = kernel.mountBlock(block, raw, { height: h });
      if (!mount) {
        console.warn("[dsh-html-ui] \u56F4\u680F\u63A5\u7BA1\u5931\u8D25\uFF0C\u4FDD\u7559\u539F\u751F\u4EE3\u7801\u5757\u3002");
        return;
      }
      mounts.set(block, mount);
    }
    function unmountBlock(block) {
      var m = mounts.get(block);
      if (!m) return;
      mounts.delete(block);
      kernel.unmountBlock(block);
    }
    function processBlock(block) {
      if (disposed || !block || !block.isConnected) return;
      if (kernel.hasMount(block)) {
        repairSurgery(block);
        return;
      }
      if (!isAssistantRow(block)) return;
      var label = getLabel(block);
      if (!wantsTakeoverRaw(label, "", config)) return;
      var raw = rawOf(block);
      if (raw.trim() === "") return;
      var state = settleState.get(block);
      var verdict = isClosed(block, state);
      if (state) settleState.set(block, verdict.state || state);
      if (!verdict.closed) return;
      settleState.delete(block);
      takeOver(block, raw);
    }
    function repairSurgery(block) {
      var m = mounts.get(block);
      if (!m) return;
      var container = m.container;
      if (!block.isConnected) {
        unmountBlock(block);
        return;
      }
      if (container && container.isConnected) {
        if (container.parentElement !== block.parentElement || container.previousElementSibling !== block) {
          block.after(container);
        }
        return;
      }
      mounts.delete(block);
      var raw = rawOf(block);
      if (raw.trim() !== "") takeOver(block, raw);
    }
    function sweep() {
      if (disposed) return;
      if (doc.visibilityState === "hidden") return;
      for (var b of Array.from(mounts.keys())) {
        try {
          repairSurgery(b);
        } catch (e) {
          kernel._dbg ? kernel._dbg(e) : 0;
        }
      }
      if (changedBlocks.size > 0) {
        var items = Array.from(changedBlocks);
        changedBlocks.clear();
        for (var i = 0; i < items.length; i++) {
          try {
            processBlock(items[i]);
          } catch (e) {
          }
        }
      }
    }
    function fullSweep() {
      if (disposed) return;
      var candidates = findFenceCandidates();
      for (var i = 0; i < candidates.length; i++) {
        try {
          processBlock(candidates[i]);
        } catch (e) {
        }
      }
    }
    function schedule() {
      if (disposed || rafId !== null) return;
      rafId = win.requestAnimationFrame(function() {
        rafId = null;
        if (disposed) return;
        sweep();
      });
    }
    function start() {
      mo = new MutationObserver(function(muts) {
        if (disposed) return;
        var touched = false;
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === "childList") {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var an = m.addedNodes[j];
              if (an.nodeType !== 1) continue;
              var blk = blockOf(an);
              if (blk) {
                changedBlocks.add(blk);
                touched = true;
              } else {
                var subs = an.querySelectorAll ? an.querySelectorAll(CODE_SELECTORS) : [];
                for (var k = 0; k < subs.length; k++) {
                  var sb = blockOf(subs[k]);
                  if (sb) {
                    changedBlocks.add(sb);
                    touched = true;
                  }
                }
              }
            }
            for (var j2 = 0; j2 < m.removedNodes.length; j2++) {
              var rn = m.removedNodes[j2];
              if (rn.nodeType !== 1) continue;
              if (mounts.has(rn)) {
                unmountBlock(rn);
                touched = true;
                continue;
              }
              var rm = rn.querySelectorAll ? rn.querySelectorAll("[" + PROCESSED + "]") : [];
              for (var k2 = 0; k2 < rm.length; k2++) {
                var rb = rm[k2];
                if (mounts.has(rb)) {
                  unmountBlock(rb);
                  touched = true;
                }
              }
              if (rn.classList && rn.classList.contains("dsh-html-ui-wrap")) {
                for (var mm of mounts) {
                  if (mm[1] && mm[1].container === rn) {
                    changedBlocks.add(mm[0]);
                    touched = true;
                  }
                }
              }
            }
          } else if (m.type === "attributes" && m.attributeName === "data-streaming") {
            var rowEl = m.target && m.target.nodeType === 1 ? m.target : null;
            if (rowEl) {
              var inside = rowEl.querySelectorAll ? rowEl.querySelectorAll(CODE_SELECTORS) : [];
              for (var bi = 0; bi < inside.length; bi++) {
                if (isPlausibleFenceSurface(inside[bi])) {
                  changedBlocks.add(inside[bi]);
                  touched = true;
                }
              }
              if (rowEl.matches && rowEl.matches(CODE_SELECTORS)) {
                changedBlocks.add(rowEl);
                touched = true;
              }
            }
          } else if (m.type === "characterData") {
            var blk2 = blockOf(m.target);
            if (blk2) {
              var st = settleState.get(blk2);
              if (st) st.charDirty = true;
              changedBlocks.add(blk2);
              touched = true;
            }
          }
        }
        if (touched) schedule();
      });
      mo.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-streaming"],
        characterData: true
      });
      fullSweep();
      intervalId = win.setInterval(function() {
        if (disposed || doc.visibilityState === "hidden") return;
        fullSweep();
      }, SWEEP_MS);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (mo) mo.disconnect();
      if (intervalId) win.clearInterval(intervalId);
      if (rafId !== null) win.cancelAnimationFrame(rafId);
      for (var b of Array.from(mounts.keys())) {
        try {
          kernel.unmountBlock(b);
        } catch (e) {
        }
      }
      mounts.clear();
      changedBlocks.clear();
      settleState.clear();
    }
    start();
    return dispose;
  }

  // src/entry.js
  (function() {
    "use strict";
    if (window.__dshHtmlRenderer) {
      try {
        console.warn(
          "[dsh-html-ui] \u68C0\u6D4B\u5230\u65E7\u7248\u6E32\u67D3\u5668 window.__dshHtmlRenderer \u4ECD\u5B58\u5728\uFF08dsh-html-render \u63D2\u4EF6\uFF09\u3002\u4E24\u7248\u4E0D\u5171\u5B58\uFF1A\u8BF7\u5148\u5378\u8F7D\u65E7\u63D2\u4EF6\uFF08dsh plugin --profile web remove dsh-html-render\uFF09\u5E76\u91CD\u542F\uFF0C\u5426\u5219\u672C\u63D2\u4EF6\u4E0D\u63A5\u7BA1\u56F4\u680F\u3002"
        );
      } catch (e) {
      }
      return;
    }
    if (window.__dshHtmlUi) {
      var oldVersion = window.__dshHtmlUi.version || 0;
      if (oldVersion >= VERSION) return;
      try {
        if (typeof window.__dshHtmlUi.disable === "function") window.__dshHtmlUi.disable();
      } catch (e) {
      }
    }
    try {
      var kernel = createRenderer();
      window.__dshHtmlUi = kernel;
      kernel._schedulerDispose = installScheduler(kernel);
      var origDisable = kernel.disable;
      kernel.disable = function() {
        try {
          if (kernel._schedulerDispose) kernel._schedulerDispose();
        } catch (e) {
        }
        origDisable.call(kernel);
      };
    } catch (e) {
      try {
        console.error("[dsh-html-ui] renderer failed to start:", e);
      } catch (x) {
      }
    }
  })();
})();
