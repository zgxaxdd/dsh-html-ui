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
    maxLines: 250,
    // v4：行数软上限（W-LINE-LIMIT）
    maxLinesFullPage: 500,
    // v4：meta {"full":true} 整页交付物的行数上限
    TEX_MAX_LEN: 2e3,
    // 单条公式源码上限
    TEX_MAX_COUNT: 200,
    // 单围栏公式数量上限
    TEX_CACHE_MAX: 300,
    // KaTeX 结果缓存上限
    inferUnlabeled: true
    // v2：无语言标签的代码块按内容结构识别为 HTML（0.1.7 generic banner 兼容）
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

  // src/validate.js —— v4 规则集（由 test/embed-validate.mjs 从 lib/validate.mjs 同步，勿手改本段）
var RULESET_VERSION = 4;



  var FIX = Object.freeze({
    "E-EMPTY": "补齐 HTML 内容后重新输出该围栏",
    "E-SIZE": "拆分为多个围栏或精简内联资源",
    "E-UNCLOSED": "补上配对的闭合标签后重新输出",
    "E-STRAY-CLOSE": "删除多余的闭合标签或为其补配对",
    "W-IMPLICIT-CLOSE": "为结构标签显式写出闭合标签",
    "W-SCRIPT-EXT": "改用围栏内联脚本（外链脚本被沙箱阻断）",
    "W-SCRIPT-NET": "交互数据在围栏内本地计算（网络 API 被沙箱阻断）",
    "W-EXT-IMG": "改用内联 SVG 或 data URI 图片",
    "W-INLINE-EVENT": "改用 addEventListener 集中绑定事件",
    "W-META-INVALID": "修正首行 meta 注释内的 JSON，或删除该注释",
    "W-IFRAME": "移除 iframe（沙箱内嵌不生效），内容直接平铺",
    "W-LINE-LIMIT": "拆分围栏或精简内容（整页交付物在 meta 写 {\"full\":true} 放宽到 500 行）",
    "W-DOCTYPE": "移除 HTML 骨架（<!doctype>/<html>/<head>/<body>），围栏内直接写内容",
  });

  const VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
  const RAW_TEXT_TAGS = { script: 1, style: 1, textarea: 1, title: 1 };
  /** 出现即视为"整页骨架"的标签（渲染器自带文档结构，骨架纯属噪声）。 */
  const SKELETON_TAGS = { html: 1, head: 1, body: 1 };
  const OPTIONAL_CLOSE = { p: 1, li: 1, dt: 1, dd: 1, rt: 1, rp: 1, optgroup: 1, option: 1, colgroup: 1, caption: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, td: 1, th: 1 };
  const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  const META_RE = /^\s*<!--\s*dsh-html\s*([\[{"][\s\S]*?)\s*-->/;
  const LATEX_MASK_RE = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
  const COMMENT_MASK_RE = /<!--[\s\S]*?-->/g;

  function item(code, detail) {
    return { code, detail: detail == null || detail === "" ? "-" : String(detail), fix: FIX[code] || "" };
  }

  /** 源码第几行（1-based）。行号让模型定位成本从"猜"降到"读"。 */
  function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  /** 解析可选 meta 头 `<!--dsh-html {...}-->`。宽容：找不到 → found:false；JSON 坏 → error。 */
  function parseMeta(raw) {
    const s = typeof raw === "string" ? raw : "";
    const m = META_RE.exec(s);
    if (!m) return { found: false, value: null, error: null };
    try {
      const value = JSON.parse(m[1]);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { found: true, value: null, error: "meta must be a JSON object" };
      }
      return { found: true, value, error: null };
    } catch (e) {
      return { found: true, value: null, error: String((e && e.message) || e) };
    }
  }

  /**
   * 长度保持型掩码：$$…$$ 数学、注释整体替换为同长占位符。
   * 占位符不含 `<`/`>`，标签扫描因此不会误入公式与注释；
   * 替换保持字符数与换行位置，故 masked 下标可 1:1 映射回原文（repairHtml 依赖这一点）。
   */
  function maskSource(raw) {
    let masked = String(raw || "").replace(LATEX_MASK_RE, function (mm) {
      return mm.replace(/[^\n]/g, "\u0001");
    });
    masked = masked.replace(COMMENT_MASK_RE, function (mm) {
      return mm.replace(/[^\n]/g, "\u0001");
    });
    return masked;
  }

  /**
   * 对掩码文本做一次标签扫描，产出事件序列（validateRaw 与 repairHtml 共用，
   * 保证"诊断"与"修复"看到的是同一份事实）。
   * 事件：{kind:"open"|"close"|"stray"|"raw-unterminated", name, index, length}
   */
  function scanTags(masked) {
    const events = [];
    const stack = [];
    let tagCount = 0;
    TAG_RE.lastIndex = 0;
    let mm;
    while ((mm = TAG_RE.exec(masked))) {
      const isClose = mm[1] === "/";
      const name = mm[2].toLowerCase();
      const selfClose = mm[4] === "/" || /\/\s*$/.test(mm[3] || "");
      tagCount++;
      const ev = { kind: "open", name, index: mm.index, length: mm[0].length };
      if (isClose) {
        if (VOID_TAGS[name]) {
          ev.kind = "ignored-void-close";
          events.push(ev);
          continue;
        }
        if (OPTIONAL_CLOSE[name]) {
          const oi = stack.lastIndexOf(name);
          if (oi !== -1) stack.length = oi;
          ev.kind = "optional-close";
          events.push(ev);
          continue;
        }
        if (stack.length && stack[stack.length - 1].name === name) {
          stack.pop();
          ev.kind = "close";
          events.push(ev);
          continue;
        }
        const wi = findInStack(stack, name);
        if (wi !== -1) {
          const skipped = stack.slice(wi + 1).filter(function (n) { return !OPTIONAL_CLOSE[n.name]; });
          ev.kind = "implicit-close";
          ev.skipped = skipped;
          stack.length = wi;
          events.push(ev);
          continue;
        }
        ev.kind = "stray";
        events.push(ev);
        continue;
      }
      if (VOID_TAGS[name] || selfClose) {
        ev.kind = "void";
        events.push(ev);
        continue;
      }
      if (name === "p") {
        while (stack.length && stack[stack.length - 1].name === "p") stack.pop();
      } else if (OPTIONAL_CLOSE[name] && stack.length && stack[stack.length - 1].name === name) {
        stack.pop();
      }
      stack.push(ev);
      events.push(ev);
      if (RAW_TEXT_TAGS[name]) {
        const closeRe = new RegExp("</" + name + "\\s*>", "i");
        closeRe.lastIndex = TAG_RE.lastIndex;
        const cm = closeRe.exec(masked);
        if (!cm) {
          // 未闭合的 raw-text 标签：保留在栈上（repairHtml 会按栈序补齐 </style>…），
          // 停止继续扫描（raw-text 内容里的标签不是真标签）。
          break;
        }
        TAG_RE.lastIndex = cm.index + cm[0].length;
        stack.pop();
      }
    }
    return { events, stack, tagCount };
  }

  function findInStack(stack, name) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === name) return i;
    }
    return -1;
  }

  function validateRaw(raw, config) {
    const cfg = config || DEFAULT_CONFIG;
    const errors = [];
    const warnings = [];
    const s = typeof raw === "string" ? raw : "";
    const meta = parseMeta(s);
    const lines = s === "" ? 0 : s.split("\n").length;
    if (s.trim() === "") {
      errors.push(item("E-EMPTY", "-"));
      return { ok: false, ruleSet: RULESET_VERSION, errors, warnings, meta, stats: { bytes: 0, tags: 0 }, lines };
    }
    if (s.length > cfg.maxBytes) errors.push(item("E-SIZE", s.length + "/" + cfg.maxBytes));
    if (meta.found && meta.error) warnings.push(item("W-META-INVALID", meta.error));
    const masked = maskSource(s);
    const scan = scanTags(masked);
    for (const ev of scan.events) {
      switch (ev.kind) {
        case "stray":
          errors.push(item("E-STRAY-CLOSE", ev.name + "@L" + lineOf(s, ev.index)));
          break;
        case "implicit-close": {
          const skipped = (ev.skipped || []).map(function (n) { return n.name; }).join(",");
          if (skipped) warnings.push(item("W-IMPLICIT-CLOSE", skipped + "@L" + lineOf(s, ev.index)));
          break;
        }
        default:
          break;
      }
    }
    for (let i = scan.stack.length - 1; i >= 0; i--) {
      const ev = scan.stack[i];
      if (!OPTIONAL_CLOSE[ev.name]) {
        errors.push(item("E-UNCLOSED", ev.name + "@L" + lineOf(s, ev.index)));
      }
    }
    if (/<script[^>]*\bsrc\s*=/i.test(s)) warnings.push(item("W-SCRIPT-EXT", "script[src]"));
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|navigator\.sendBeacon|\bimport\s*\(/.test(s)) warnings.push(item("W-SCRIPT-NET", "network-api"));
    if (/<img[^>]*\bsrc\s*=\s*["']?https?:/i.test(s) && !cfg.allowRemoteImages) warnings.push(item("W-EXT-IMG", "img[src]"));
    if (/\son[a-z]+\s*=/i.test(s)) warnings.push(item("W-INLINE-EVENT", "on*="));
    if (/<iframe[\s>]/i.test(s)) warnings.push(item("W-IFRAME", "iframe"));
    if (/<!doctype[\s>]|<\s*html[\s>]|<\s*head[\s>]|<\s*body[\s>]/i.test(s)) warnings.push(item("W-DOCTYPE", "skeleton"));
    const fullPage = !!(meta.found && meta.value && meta.value.full === true);
    const lineCap = fullPage && typeof cfg.maxLinesFullPage === "number" ? cfg.maxLinesFullPage : cfg.maxLines;
    if (typeof lineCap === "number" && lines > lineCap) {
      warnings.push(item("W-LINE-LIMIT", lines + "/" + lineCap));
    }
    return {
      ok: errors.length === 0,
      ruleSet: RULESET_VERSION,
      errors,
      warnings,
      meta,
      stats: { bytes: s.length, tags: scan.tagCount },
      lines,
    };
  }

  /**
   * 按扫描事实自动修复可修复的问题，产出"可直接采用"的修复版源码。
   * 借鉴 dsh-genui validate_dsh_ui：把修好的内容交给模型，比重写一遍更不容易再出错。
   *
   * 修复策略（只动错误级问题，警告一律不自动改）：
   *  - E-STRAY-CLOSE：删除多余闭合标签；
   *  - E-UNCLOSED（含 script/style 未闭合）：在文末按栈逆序补齐闭合标签。
   *
   * @returns {{repairable:boolean, text:string|null, repairs:string[], unrecoverable:string[]}}
   *   text 为 null 表示该围栏无法自动修复（空内容/超限，或无需修复）。
   */
  function repairHtml(raw, config) {
    const s = typeof raw === "string" ? raw : "";
    const receipt = validateRaw(s, config);
    if (receipt.errors.length === 0) {
      return { repairable: false, text: null, repairs: [], unrecoverable: [] };
    }
    const unrecoverable = [];
    for (const e of receipt.errors) {
      if (e.code !== "E-UNCLOSED" && e.code !== "E-STRAY-CLOSE") unrecoverable.push(e.code);
    }
    if (unrecoverable.length > 0) {
      return { repairable: false, text: null, repairs: [], unrecoverable };
    }
    const masked = maskSource(s);
    const scan = scanTags(masked);
    const drops = [];
    const repairs = [];
    for (const ev of scan.events) {
      if (ev.kind === "stray") {
        drops.push([ev.index, ev.index + ev.length]);
        repairs.push("remove-stray-close:" + ev.name + "@L" + lineOf(s, ev.index));
      } else if (ev.kind === "raw-unterminated") {
        repairs.push("append-close:" + ev.name + "@L" + lineOf(s, ev.index));
      }
    }
    let text = s;
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      text = text.slice(0, d[0]) + text.slice(d[1]);
    }
    for (let i = scan.stack.length - 1; i >= 0; i--) {
      const ev = scan.stack[i];
      if (VOID_TAGS[ev.name]) continue;
      text += "</" + ev.name + ">";
      repairs.push("append-close:" + ev.name + "@L" + lineOf(s, ev.index));
    }
    const after = validateRaw(text, config);
    const done = after.errors.length === 0;
    return {
      repairable: done,
      text: done ? text : null,
      repairs,
      unrecoverable: done ? [] : ["E-REPAIR-INCOMPLETE"],
    };
  }

  /** 无语言标签代码块的结构化识别（0.1.7 generic banner 兼容）。 */
  function looksLikeHtmlDoc(raw) {
    const s = (raw || "").trim();
    if (s.length < 40 || s.charAt(0) !== "<") return false;
    if (/^<!doctype\s+html|^<html[\s>]/i.test(s)) return true;
    if (/<style[\s>][\s\S]*<\/style>/i.test(s) && /<[a-zA-Z][\w:-]*(\s|>|\/)/.test(s)) return true;
    return false;
  }

  /**
   * 由回执生成模型可读的修复提示（诊断条"复制修复提示"按钮与围栏反馈环共用）。
   * repairedHtml 非空时附上可直接采用的修复版源码（v4：闭环最后 100 米）。
   */
  function repairPrompt(receipt, repairedHtml) {
    const lines = [];
    const all = (receipt.errors || []).concat(receipt.warnings || []);
    for (const it of all) {
      lines.push("- " + it.code + (it.detail && it.detail !== "-" ? "(" + it.detail + ")" : "") + "：" + (FIX[it.code] || it.fix || "按错误码修复"));
    }
    let out = "请修复以下 dsh-html 围栏问题并重新输出完整围栏（写在回答正文，不要写在思考块里）：\n" + lines.join("\n");
    if (typeof repairedHtml === "string" && repairedHtml) {
      out += "\n\n也可以直接采用下面这份已修复的源码（原样粘贴进围栏即可）：\n```html\n" + repairedHtml + "\n```";
    }
    return out;
  }

  // src/kernel.js
  var VERSION = 4;
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
        sourceOnly: "\u4EC5\u6E90\u7801",
        download: "下载",
        downloaded: "已下载"
      },
      oversized: { warn: "\u5185\u5BB9\u8D85\u8FC7 1MB \u4E0A\u9650\uFF0C\u4EC5\u663E\u793A\u6E90\u7801\u3002" },
      error: { loadFailed: "\u9884\u89C8\u52A0\u8F7D\u5931\u8D25\uFF0C\u5DF2\u56DE\u9000\u4E3A\u6E90\u7801\u89C6\u56FE\u3002", closed: "\u56F4\u680F\u672A\u95ED\u5408\uFF0C\u6682\u4EE5\u6E90\u7801\u663E\u793A\u3002" },
      diag: {
        title: "渲染前校验未通过，已回退为源码视图",
        titleLastGood: "渲染前校验未通过，已保留上一次成功渲染",
        warnTitle: "校验警告（不阻断渲染）",
        lastGood: "已保留上一次成功渲染",
        copyFix: "复制修复提示",
        copied: "修复提示已复制",
        codes: {
          "E-EMPTY": ["围栏内容为空", "补齐 HTML 内容后重新输出"],
          "E-SIZE": ["源码超过 1MB 上限", "拆分为多个围栏或精简内联资源"],
          "E-UNCLOSED": ["标签未闭合", "补上配对闭合标签后重新输出"],
          "E-STRAY-CLOSE": ["多余的闭合标签", "删除或配对该闭合标签"],
          "W-IMPLICIT-CLOSE": ["存在隐式闭合", "显式写出闭合标签更稳"],
          "W-SCRIPT-EXT": ["外部脚本将被沙箱阻断", "改用围栏内联脚本"],
          "W-SCRIPT-NET": ["脚本含网络 API，将被沙箱阻断", "数据请在围栏内本地计算"],
          "W-EXT-IMG": ["外链图片默认不渲染", "改用内联 SVG 或 data URI"],
          "W-INLINE-EVENT": ["行内事件属性", "改用 addEventListener 集中绑定"],
          "W-META-INVALID": ["meta 头 JSON 非法", "修正 JSON 或删除该注释"],
          "W-IFRAME": ["内嵌 iframe 不生效", "移除，内容直接平铺"],
          "W-LINE-LIMIT": ["围栏行数超上限", "拆分围栏或精简；整页交付物在 meta 写 {\"full\":true}"],
          "W-DOCTYPE": ["含 HTML 骨架（噪声）", "移除 <!doctype>/<html>/<head>/<body>"]
        }
      },
      aria: {
        toolbar: "dsh-html \u9884\u89C8\u5DE5\u5177\u680F",
        source: "\u5207\u6362\u6E90\u7801\u548C\u9884\u89C8",
        tab: "\u5728\u65B0\u6807\u7B7E\u9875\u6253\u5F00\u9884\u89C8",
        copy: "\u590D\u5236 HTML \u6E90\u7801",
        reload: "\u91CD\u65B0\u6E32\u67D3\u9884\u89C8",
        download: "下载自包含 HTML",
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
        sourceOnly: "Source only",
        download: "Download",
        downloaded: "Saved"
      },
      oversized: { warn: "Content exceeds the 1MB limit; showing source only." },
      error: { loadFailed: "Preview failed to load; showing source.", closed: "Fence not closed; showing source." },
      diag: {
        title: "Pre-render validation failed; showing source view",
        titleLastGood: "Pre-render validation failed; kept the last successful render",
        warnTitle: "Validation warnings (non-blocking)",
        lastGood: "Kept the last successful render",
        copyFix: "Copy repair prompt",
        copied: "Repair prompt copied",
        codes: {
          "E-EMPTY": ["Fence content is empty", "Emit the fence again with HTML content"],
          "E-SIZE": ["Source exceeds the 1MB limit", "Split into several fences or trim inline assets"],
          "E-UNCLOSED": ["Tag not closed", "Add the matching close tag and re-emit"],
          "E-STRAY-CLOSE": ["Stray close tag", "Remove or pair the close tag"],
          "W-IMPLICIT-CLOSE": ["Implicit close detected", "Write explicit close tags"],
          "W-SCRIPT-EXT": ["External script will be blocked by the sandbox", "Use inline scripts inside the fence"],
          "W-SCRIPT-NET": ["Script uses network APIs (blocked)", "Keep data computation inside the fence"],
          "W-EXT-IMG": ["Remote images are not rendered by default", "Use inline SVG or data URIs"],
          "W-INLINE-EVENT": ["Inline event attribute", "Bind events with addEventListener"],
          "W-META-INVALID": ["Meta header JSON is invalid", "Fix the JSON or drop the comment"],
          "W-IFRAME": ["Nested iframe is inert", "Remove it and inline the content"],
          "W-LINE-LIMIT": ["Fence exceeds the line cap", "Split or trim; write {\"full\":true} in meta for full-page deliverables"],
          "W-DOCTYPE": ["HTML skeleton is noise", "Drop <!doctype>/<html>/<head>/<body>"]
        }
      },
      aria: {
        toolbar: "dsh-html preview toolbar",
        source: "Toggle source and preview",
        tab: "Open preview in a new tab",
        copy: "Copy HTML source",
        reload: "Re-render preview",
        download: "Download self-contained HTML",
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
      '.dsh-html-ui-wrap{position:relative;margin:6px 0;width:100%;min-width:0;flex:1 1 0;box-sizing:border-box}.dsh-html-ui-frame{width:100%;border:0;display:block}.dsh-html-ui-toolbar{position:absolute;top:6px;right:8px;z-index:5;display:flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid rgba(128,128,128,.3);border-radius:8px;background:rgba(255,255,255,.92);background:light-dark(rgba(255,255,255,.92),rgba(28,32,46,.86));color:#555;color:light-dark(#444,#e6e9f2);box-shadow:0 2px 10px rgba(0,0,0,.16);backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .15s ease;font:11px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap}.dsh-html-ui-wrap:hover .dsh-html-ui-toolbar,.dsh-html-ui-toolbar:focus-within{opacity:1;pointer-events:auto}.dsh-html-ui-wrap.dsh-html-ui-src-mode .dsh-html-ui-toolbar{opacity:1;pointer-events:auto}.dsh-html-ui-wrap.dsh-html-ui-src-mode{min-height:34px}@media(hover:none){.dsh-html-ui-toolbar{opacity:1;pointer-events:auto}}.dsh-html-ui-toolbar button:focus-visible{outline:2px solid #38bdf8;outline-offset:1px}@media (prefers-reduced-motion: reduce){.dsh-html-ui-toolbar{transition:none}}.dsh-html-ui-toolbar .lbl{font-weight:600}.dsh-html-ui-toolbar .st{color:#b58900}.dsh-html-ui-toolbar button{border:1px solid rgba(128,128,128,.45);background:transparent;border-radius:6px;padding:1px 7px;font:inherit;color:inherit;cursor:pointer}.dsh-html-ui-toolbar button:hover{background:rgba(128,128,128,.16)}.dsh-html-ui-toolbar button:disabled{opacity:.45;cursor:default}.dsh-html-ui-warn{padding:6px 8px;color:#b58900;font:12px/1.6 system-ui,sans-serif}.dsh-html-ui-src{max-height:420px;overflow:auto;padding:10px 12px;margin:0;font:12px/1.6 ui-monospace,Consolas,"SF Mono",monospace;white-space:pre;background:rgba(128,128,128,.06);color:light-dark(#1f2937,#e5e7eb);border-radius:8px}.dsh-html-ui-diag{margin:6px 0 0;padding:8px 10px;border:1px solid rgba(217,119,6,.45);border-left:3px solid #d97706;border-radius:8px;background:rgba(217,119,6,.08);font:12px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;color:inherit}.dsh-html-ui-diag.warn-only{border-color:rgba(128,128,128,.35);border-left-color:rgba(128,128,128,.6);background:rgba(128,128,128,.07)}.dsh-html-ui-diag-title{font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-html-ui-diag-badge{padding:0 8px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(22,163,74,.18);color:#16a34a}.dsh-html-ui-diag-fix{margin-left:auto;border:1px solid rgba(128,128,128,.45);background:transparent;border-radius:6px;padding:1px 9px;font:11px/1.7 inherit;color:inherit;cursor:pointer}.dsh-html-ui-diag-fix:hover{background:rgba(128,128,128,.16)}.dsh-html-ui-diag ul{margin:0;padding-left:18px}.dsh-html-ui-diag li{margin:2px 0}.dsh-html-ui-diag code{font:11px/1.6 ui-monospace,Consolas,monospace;padding:0 4px;border-radius:4px;background:rgba(128,128,128,.16)}';
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
      var bDown = doc.createElement("button");
      bDown.textContent = dict.toolbar.download;
      bDown.setAttribute("aria-label", dict.aria.download);
      bar.appendChild(lbl);
      bar.appendChild(st);
      bar.appendChild(bSrc);
      bar.appendChild(bTab);
      bar.appendChild(bCopy);
      bar.appendChild(bReload);
      bar.appendChild(bDown);
      st.setAttribute("aria-live", "polite");
      return { bar, lbl, st, bSrc, bTab, bCopy, bReload, bDown };
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
    function applyDoc(mount, docStr) {
      try {
        if (mount.iframe.srcdoc !== docStr) mount.iframe.srcdoc = docStr;
        mount.lastGoodDoc = docStr;
      } catch (e) {
        dbg(e);
        if (mount.lastGoodDoc) {
          try {
            if (mount.iframe.srcdoc !== mount.lastGoodDoc) mount.iframe.srcdoc = mount.lastGoodDoc;
            if (mount.ui && mount.ui.st) mount.ui.st.textContent = dict.diag.lastGood;
          } catch (x) {
            dbg(x);
          }
        }
      }
    }
    function renderFrame(mount) {
      if (!mount.iframe || mount._enriching) {
        mount._pending = true;
        return;
      }
      if (mount.diag && !mount.diag.ok && !mount.renderAnyway) return;
      var raw = mount.raw;
      var pal = currentPalette();
      var key = fnv1a32(raw + "" + pal.bg + "" + pal.fg);
      var cached = cacheGet(key);
      if (cached) {
        mount.lastBody = cached.body;
        mount.lastCss = cached.css;
        var docHit = wrapDocument(cached.body, cached.css, mount.id, false);
        applyDoc(mount, docHit);
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
        applyDoc(mount, doc2);
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
      var diag = validateRaw(raw, config);
      var metaInfo = parseMeta(raw);
      var metaTitle = metaInfo && metaInfo.found && metaInfo.value && typeof metaInfo.value.title === "string" ? metaInfo.value.title.trim().slice(0, 60) : "";
      var initialHeight = opts.height || block.offsetHeight || 180;
      var container = doc.createElement("div");
      container.className = "dsh-html-ui-wrap";
      var ui = makeToolbar();
      if (metaTitle) ui.lbl.textContent = metaTitle;
      var view = doc.createElement("div");
      var frame = doc.createElement("iframe");
      frame.className = "dsh-html-ui-frame";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("loading", "eager");
      frame.setAttribute("title", dict.aria.frame + (metaTitle ? "：" + metaTitle : ""));
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
        diag: diag,
        metaTitle: metaTitle,
        lastGoodDoc: null,
        renderAnyway: false,
        _io: null,
        settled: true,
        truncated: false,
        sourceView: false,
        _detached: false,
        _enriching: false,
        _pending: false,
        unmount: function() {
          mount._detached = true;
          if (mount._io) {
            try {
              mount._io.disconnect();
            } catch (e) {
            }
            mount._io = null;
          }
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
            mount.renderAnyway = true;
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
          mount.renderAnyway = true;
          renderFrame(mount);
        } catch (e) {
          dbg(e);
        }
      });
      ui.bDown.addEventListener("click", function() {
        try {
          var out = wrapDocument(mount.lastBody || mount.raw, mount.lastCss || null, 0, true);
          var safeTitle = (mount.metaTitle || "").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
          if (safeTitle) out = out.replace("<head>", "<head><title>" + safeTitle + "</title>");
          out = out.replace("<!doctype html>", "<!doctype html>\n<!-- dsh-html-ui v" + VERSION + " self-contained export -->");
          out += "\n<script type=\"text/plain\" id=\"dsh-html-source\">" + mount.raw.replace(/<\//g, "<\\/") + "<\/script>";
          var fname = "dsh-html-" + (safeTitle || fnv1a32(mount.raw).toString(16)) + ".html";
          var url = win.URL.createObjectURL(new Blob([out], { type: "text/html;charset=utf-8" }));
          var a = doc.createElement("a");
          a.href = url;
          a.download = fname;
          doc.body.appendChild(a);
          a.click();
          a.remove();
          win.setTimeout(function() {
            try {
              win.URL.revokeObjectURL(url);
            } catch (e) {
              dbg(e);
            }
          }, 3e4);
          ui.bDown.textContent = dict.toolbar.downloaded;
          win.setTimeout(function() {
            ui.bDown.textContent = dict.toolbar.download;
          }, 1200);
        } catch (e) {
          dbg(e);
        }
      });
      function copyText(text, okLabel, failLabel, btn) {
        var label0 = btn._label0 || btn.textContent;
        var done = function() {
          btn.textContent = okLabel;
          win.setTimeout(function() {
            btn.textContent = label0;
          }, 1400);
        };
        var fail = function() {
          btn.textContent = failLabel;
          win.setTimeout(function() {
            btn.textContent = label0;
          }, 1600);
        };
        function legacy() {
          try {
            var ta = doc.createElement("textarea");
            ta.value = text;
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
            navigator.clipboard.writeText(text).then(done, legacy);
          } else legacy();
        } catch (e) {
          dbg(e);
          try {
            legacy();
          } catch (x) {
            dbg(x);
          }
        }
      }
      function refreshDiag() {
        var old = container.querySelector(".dsh-html-ui-diag");
        if (old) old.remove();
        if (!mount.diag || mount.diag.ok && !mount.diag.warnings.length) return;
        var bar = doc.createElement("div");
        bar.className = "dsh-html-ui-diag" + (mount.diag.ok ? " warn-only" : "");
        bar.setAttribute("role", "status");
        var head = doc.createElement("div");
        head.className = "dsh-html-ui-diag-title";
        var t = doc.createElement("span");
        t.textContent = mount.diag.ok ? dict.diag.warnTitle : mount.lastGoodDoc ? dict.diag.titleLastGood : dict.diag.title;
        head.appendChild(t);
        var fixBtn = doc.createElement("button");
        fixBtn.type = "button";
        fixBtn.className = "dsh-html-ui-diag-fix";
        fixBtn._label0 = dict.diag.copyFix;
        fixBtn.textContent = dict.diag.copyFix;
        fixBtn.addEventListener("click", function() {
          // v4：错误可自动修复时，修复提示附带可直接采用的修复版源码（repairHtml 与校验同规则集）。
          var repairedHtml = null;
          if (!mount.diag.ok) {
            try {
              var fix2 = repairHtml(mount.raw, config);
              if (fix2 && fix2.repairable) repairedHtml = fix2.text;
            } catch (e) {
              dbg(e);
            }
          }
          copyText(repairPrompt(mount.diag, repairedHtml), dict.diag.copied, dict.toolbar.copyFailed, fixBtn);
        });
        head.appendChild(fixBtn);
        bar.appendChild(head);
        var ul = doc.createElement("ul");
        var items = mount.diag.ok ? mount.diag.warnings : mount.diag.errors.concat(mount.diag.warnings);
        for (var i = 0; i < items.length && i < 6; i++) {
          var li = doc.createElement("li");
          var pair = dict.diag.codes[items[i].code] || [items[i].code, items[i].fix || ""];
          var codeEl = doc.createElement("code");
          codeEl.textContent = items[i].code;
          li.appendChild(codeEl);
          li.appendChild(doc.createTextNode(" " + pair[0] + (items[i].detail && items[i].detail !== "-" ? "（" + items[i].detail + "）" : "") + " → " + pair[1]));
          ul.appendChild(li);
        }
        bar.appendChild(ul);
        container.insertBefore(bar, view);
      }
      refreshDiag();
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
        if (!diag.ok) {
          ui.bSrc.click();
        } else if (win.IntersectionObserver) {
          mount._io = new win.IntersectionObserver(function(entries) {
            for (var i = 0; i < entries.length; i++) {
              if (entries[i].isIntersecting) {
                if (mount._io) {
                  mount._io.disconnect();
                  mount._io = null;
                }
                renderFrame(mount);
                break;
              }
            }
          }, { rootMargin: "300px 0px" });
          mount._io.observe(container);
        } else {
          renderFrame(mount);
        }
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
      validate: validateRaw,
      repair: repairHtml,
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
  var SWEEP_MS_SLOW = 4e3;
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
    var warnedDrift = false;
    var inferredCount = 0;
    var quietSweeps = 0;
    var sweepActive = false;
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
      if (!wantsTakeoverRaw(label, "", config)) {
        // v4：白名单式内容回退（借鉴 dsh-genui isGenericGenuiFence）——只放行
        // 宿主"通用代码块"标签（Code / Code block / 代码块）、且正文完整通过
        // render 前校验的围栏；绝不因为"长得像 HTML"就接管普通代码块。
        if ((label || "").trim() !== "" || config.inferUnlabeled === false) return;
        var lbl0 = labelTextOf(block).trim().toLowerCase();
        var GENERIC_LABELS = { code: 1, "code block": 1, "\u4ee3\u7801\u5757": 1 };
        if (!GENERIC_LABELS[lbl0]) return;
        var probe = rawOf(block);
        if (!validateRaw(probe, config).ok) return;
        label = "html";
        inferredCount++;
      }
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
      if (!warnedDrift && doc.querySelector("pre") && !doc.querySelector(CODE_SELECTORS)) {
        warnedDrift = true;
        try {
          win.console && win.console.warn("[dsh-html-ui] host DOM drift: no element matches " + CODE_SELECTORS + "; fallback pre-banner scan is active");
        } catch (e) {
        }
      }
      var candidates = findFenceCandidates();
      for (var i = 0; i < candidates.length; i++) {
        try {
          processBlock(candidates[i]);
        } catch (e) {
        }
      }
    }
    function schedule() {
      sweepActive = true;
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
      try {
        win.console && win.console.info("[dsh-html-ui] client active; v" + VERSION + "; surfaces=" + CODE_SELECTORS.replace(/\s+/g, "") + (config.inferUnlabeled === false ? "" : "; unlabeled-html=whitelist"));
      } catch (e) {
      }
      fullSweep();
      function tick() {
        if (disposed) return;
        if (doc.visibilityState !== "hidden") {
          fullSweep();
          if (sweepActive) {
            sweepActive = false;
            quietSweeps = 0;
          } else if (quietSweeps < 6) {
            quietSweeps++;
          }
        }
        intervalId = win.setTimeout(tick, quietSweeps >= 3 ? SWEEP_MS_SLOW : SWEEP_MS);
      }
      intervalId = win.setTimeout(tick, SWEEP_MS);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (mo) mo.disconnect();
      if (intervalId) win.clearTimeout(intervalId);
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

  // src/client-wrapper.js
  window.__ModuleLoader__.load({
    id: "dsh-html-ui",
    factory: function() {
      window.__dshHtmlUiAssetsBase = "/plugins/dsh-html-ui/assets/katex/";
      if (window.__dshHtmlRenderer) {
        try {
          console.warn(
            "[dsh-html-ui] \u68C0\u6D4B\u5230\u65E7\u7248\u6E32\u67D3\u5668 window.__dshHtmlRenderer \u4ECD\u5B58\u5728\uFF08dsh-html-render \u63D2\u4EF6\uFF09\u3002\u4E24\u7248\u4E0D\u5171\u5B58\uFF1A\u8BF7\u5148\u5378\u8F7D\u65E7\u63D2\u4EF6\u5E76\u91CD\u542F\uFF0C\u672C\u63D2\u4EF6\u4E0D\u63A5\u7BA1\u56F4\u680F\u3002"
          );
        } catch (e) {
        }
        return {
          apply: function() {
            return function() {
            };
          }
        };
      }
      if (window.__dshHtmlUi) {
        var oldVersion = window.__dshHtmlUi.version || 0;
        if (oldVersion >= VERSION) {
          return { apply: function() {
            return function() {
            };
          } };
        }
        try {
          if (typeof window.__dshHtmlUi.disable === "function") window.__dshHtmlUi.disable();
        } catch (e) {
        }
      }
      return {
        apply: function(ctx) {
          var kernel = createRenderer({
            assetsBase: "/plugins/dsh-html-ui/assets/katex/"
          });
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
          try {
            ctx.inject(["theme"], function(scope) {
              var themeSvc = scope.get("theme");
              if (!themeSvc) return;
              var sync = function(snap) {
                var toks = snap && snap.active && snap.active.tokens;
                var bg = toks && toks["--dsw-alias-bg-base"];
                var fg = toks && toks["--dsw-alias-label-primary"];
                kernel.setTheme({ bg, fg });
              };
              scope.on("theme/change", sync);
              try {
                sync(themeSvc.getTheme());
              } catch (e) {
              }
            });
          } catch (e) {
          }
          try {
            ctx.inject(["locale"], function(scope) {
              var localeSvc = scope.get("locale");
              if (!localeSvc) return;
              try {
                localeSvc.register("dsh-html-ui", { zh: LOCALES.zh, en: LOCALES.en });
              } catch (e) {
              }
              try {
                var cur = localeSvc.getLocale && localeSvc.getLocale();
                if (cur === "en" || cur && cur.indexOf("en") === 0) kernel.setLocale(LOCALES.en);
              } catch (e) {
              }
            });
          } catch (e) {
          }
          return function dispose() {
            try {
              if (window.__dshHtmlUi === kernel) kernel.disable();
            } catch (e) {
            }
          };
        }
      };
    }
  });
})();
