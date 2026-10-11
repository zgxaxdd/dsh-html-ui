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
  /**
   * 接管标记的统一判据。白名单来自共享校验段（HTML_FENCE_MARKERS，由
   * lib/validate.mjs 同步进来）：发现器 / 接管器 / 宿主自修环因此不可能再各写一份而打架。
   */
  function isHtmlMarkerLabel(text) {
    var l = (text || "").trim().toLowerCase();
    return HTML_FENCE_MARKERS.indexOf(l) !== -1;
  }
  function wantsTakeoverRaw(label, raw, config) {
    var cfg = config || DEFAULT_CONFIG;
    var l = (label || "").trim().toLowerCase();
    if (cfg.requireMarker) {
      // 严格模式：只认显式标记（`html` 太容易撞上普通代码块，故排除）。
      return l === "dsh-html" || l === "html-render";
    }
    return isHtmlMarkerLabel(l);
  }
  function buildCsp(allowRemoteImages) {
    var img = "img-src data: blob:";
    if (allowRemoteImages) img += " https:";
    return '<meta http-equiv="Content-Security-Policy" content="' + ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " + img + "; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'") + '">';
  }
  function replaceLatex(raw, renderFn, config, phPrefix) {
    var cfg = config || DEFAULT_CONFIG;
    var tex = renderFn || function(s, display, full) {
      return full;
    };
    var PH = phPrefix || "\uE000" + Math.random().toString(36).slice(2, 8) + "-";
    var text = String(raw);
    // 公式区里的 <、> 不是标签（与 validate.mjs 的 maskSource 同序）。这里先算出公式
    // 区间，标签掩码跳过"起点落在公式内"的匹配，其余保持原顺序——顺序很关键：
    // pre/code/script/style 必须整体先被掩码，否则其中的 $$…$$ 会被渲染。
    // 旧实现没有区间保护：`$$a < b$$` 会被 <[^>]*> 连公式一起吞掉，
    // `$$x<y$$</div>` 还会把真实标记当成公式内容喂给 KaTeX 并从文档里删除。
    var mathRanges = [];
    var scanRe = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
    var scanMatch;
    while ((scanMatch = scanRe.exec(text))) mathRanges.push([scanMatch.index, scanMatch.index + scanMatch[0].length]);
    // 区间天然按出现顺序递增，标签匹配也是从左到右：游标只前进，判定整体 O(N+M)，
    // 而不是每个标签都对全部公式做一次线性扫描（旧写法在 100 公式 × 300 标签时是这个量级的乘积）。
    var mathCursor = 0;
    function tagStartsInMath(index) {
      while (mathCursor < mathRanges.length && mathRanges[mathCursor][1] <= index) mathCursor++;
      var range = mathRanges[mathCursor];
      return !!range && index >= range[0] && index < range[1];
    }
    // 手工扫描替代 `<script[\s\S]*?<\/script\s*>|…|<[^>]*>`：那组惰性 `[\s\S]*?`
    // 在"只有开标签、没有闭标签"的畸形输入上会二次方回溯（与校验器那批正则同源）。
    var tokens = [];
    var kept = protectTags(text, tokens, PH, tagStartsInMath);
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
    // 没有公式标记就整段跳过三次全文 replace（实测 1MB 正文即使零公式也要白跑 ~21 ms）。
    if (mathRanges.length > 0) {
      kept = kept.replace(/\$\$([\s\S]+?)\$\$/g, function(m, s) {
        return run(s, true, m);
      }).replace(/\\\[([\s\S]+?)\\\]/g, function(m, s) {
        return run(s, true, m);
      }).replace(/\\\(([\s\S]+?)\\\)/g, function(m, s) {
        return run(s, false, m);
      });
    }
    if (tokens.length === 0) return kept;
    var re = new RegExp(PH + "(\\d+)" + PH, "g");
    return kept.replace(re, function(m, i) {
      var idx = +i;
      return idx >= 0 && idx < tokens.length ? tokens[idx] : m;
    });
  }
  /** replaceLatex 保护的标签名（内容里的 $$ 不能被当成公式渲染）。 */
  var PROTECT_TAGS = { script: 1, style: 1, pre: 1, code: 1 };
  // 本段自带 ASCII 工具：pure.js 不依赖 validate 段（后者由脚本同步生成，
  // 两段之间不该有隐式依赖，否则单测里单独抽取 pure 段就会炸）。
  function isAsciiNameChar(c) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 45;
  }
  function isAsciiSpace(c) {
    return c === 32 || c === 9 || c === 10 || c === 13;
  }
  function indexOfAsciiCI(text, needleLower, from) {
    var n = text.length;
    var m = needleLower.length;
    for (var i = from; i + m <= n; i++) {
      var ok = true;
      for (var j = 0; j < m; j++) {
        if ((text.charCodeAt(i + j) | 32) !== (needleLower.charCodeAt(j) | 32)) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }
  /**
   * 把 pre/code/script/style 整体与普通标签替换成占位符，返回替换后的文本。
   * @param {string} src 源码
   * @param {string[]} tokens 输出：被保护的原文
   * @param {string} PH 占位符前缀
   * @param {(index:number)=>boolean} skipAt 起点是否落在公式区内（落在区内则不保护）
   */
  function protectTags(src, tokens, PH, skipAt) {
    var out = "";
    var cursor = 0;
    var i = 0;
    var n = src.length;
    while (i < n) {
      var lt = src.indexOf("<", i);
      if (lt < 0) break;
      var j = lt + 1;
      var closing = src.charCodeAt(j) === 47;
      if (closing) j++;
      var nameStart = j;
      while (j < n && isAsciiNameChar(src.charCodeAt(j))) j++;
      var name = src.slice(nameStart, j).toLowerCase();
      var end = -1;
      if (!closing && PROTECT_TAGS[name]) {
        var close = indexOfAsciiCI(src, "</" + name, j);
        if (close >= 0) {
          var p = close + name.length + 2;
          while (p < n && isAsciiSpace(src.charCodeAt(p))) p++;
          if (src.charCodeAt(p) === 62) end = p + 1;
        }
      }
      if (end < 0) {
        var gt = src.indexOf(">", j);
        if (gt < 0) break; // 无 `>` 的尾巴：原正则同样不匹配，保持原样
        end = gt + 1;
      }
      if (!skipAt(lt)) {
        out += src.slice(cursor, lt) + PH + tokens.length + PH;
        tokens.push(src.slice(lt, end));
        cursor = end;
      }
      i = end;
    }
    return out + src.slice(cursor);
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

  /**
   * 接管围栏的 info string 白名单 —— 单一事实源。
   * 浏览器端（client.js 内嵌副本）与宿主自修环（feedback.mjs）必须一致：
   * 两处各写一份正是历史上 `html-render` 判据打架的根因。
   * @type {readonly string[]}
   */
  var HTML_FENCE_MARKERS = Object.freeze(["html", "dsh-html", "html-render"]);



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
    "W-SCAN-LIMIT": "源码畸形程度超出扫描预算（已截断校验），请检查未闭合的 < 与引号后重新输出",
    "E-SCAN-LIMIT": "源码畸形到无法完成结构校验（已截断）；请检查未闭合的 < 与引号后重新输出",
  });

  const VOID_TAGS = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
  const RAW_TEXT_TAGS = { script: 1, style: 1, textarea: 1, title: 1 };
  /** 出现即视为"整页骨架"的标签（渲染器自带文档结构，骨架纯属噪声）。 */
  const SKELETON_TAGS = { html: 1, head: 1, body: 1 };
  const OPTIONAL_CLOSE = { p: 1, li: 1, dt: 1, dd: 1, rt: 1, rp: 1, optgroup: 1, option: 1, colgroup: 1, caption: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, td: 1, th: 1 };
  /*
   * 扫描器全部手写、单趟线性 —— 这里刻意不用正则。
   *
   * 历史缺陷（实测）：`<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>`
   * 这类"属性块可被多种方式切分"的模式在畸形输入上会灾难性回溯：无 `>` 的
   * `'<a "'.repeat(k)` 20KB→110ms、40KB→428ms、80KB→1633ms（每次翻倍 4×），
   * 1MB 推算约 4.5 分钟，而且判定结果是 `ok:true`。同样形状的还有
   * `<!--[\s\S]*?-->`（80KB→203ms）、`\$\$[\s\S]+?\$\$|…`（80KB→360ms）、
   * `^\s*<!--…[\s\S]*?)\s*-->`（5KB→11ms）。这些都在 1MB 上限内可达，
   * 浏览器端会冻结标签页、宿主端会挂死进程 —— 与早期那个 scanTags 死循环同级。
   * 手写扫描器每字符只访问一次，且失败即终止（见 scanTags 的说明）。
   */
  const LT = 60; /* < */ const GT = 62; /* > */ const SLASH = 47; /* / */ const BANG = 33; /* ! */
  const DQUOTE = 34; const SQUOTE = 39; const DASH = 45; const BRACKET_L = 91; const BACKSLASH = 92; const PAREN_L = 40;

  /** ASCII 大小写无关的 indexOf（不用 toLowerCase 整串拷贝：某些 Unicode 字符小写后长度会变）。 */
  function indexOfAsciiCI(text, needleLower, from) {
    const n = text.length;
    const m = needleLower.length;
    for (let i = from; i + m <= n; i++) {
      let ok = true;
      for (let j = 0; j < m; j++) {
        if ((text.charCodeAt(i + j) | 32) !== (needleLower.charCodeAt(j) | 32)) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  function isNameStart(c) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  }
  function isNameChar(c) {
    return isNameStart(c) || (c >= 48 && c <= 57) || c === 95 /* _ */ || c === 58 /* : */ || c === 45 /* - */;
  }
  function isSpaceChar(c) {
    return c === 32 || c === 9 || c === 10 || c === 13;
  }
  /**
   * meta 头允许的前导空白：等价于原正则的 `^\s*`（含 BOM/NBSP/Unicode 空格）。
   * 标签扫描用的 isSpaceChar 是 HTML 语义（只有 space/tab/LF/CR/FF），两者不能混用。
   */
  function isMetaSpace(c) {
    if (c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0xfeff || c === 0x1680) return true;
    if (c >= 0x2000 && c <= 0x200a) return true;
    return c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  }

  function item(code, detail) {
    return { code, detail: detail == null || detail === "" ? "-" : String(detail), fix: FIX[code] || "" };
  }

  /**
   * 行号查询器（1-based）。行号让模型定位成本从"猜"降到"读"。
   *
   * 旧实现对每条诊断都从 0 线性扫到 index —— O(N) × 诊断数：1MB 围栏带 50 条
   * 未闭合诊断就是约 50MB 的无谓扫描。这里一次性建行首表，之后二分查找 O(log N)。
   * @param {string} text 源码
   * @returns {(index:number)=>number} 下标 → 行号
   */
  function lineIndexFactory(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return function lineAt(index) {
      if (!(index > 0)) return 1;
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
  }

  /**
   * 解析可选 meta 头 `<!--dsh-html {...}-->`。宽容：找不到 → found:false；JSON 坏 → error。
   *
   * 手写扫描替代 `^\s*<!--\s*dsh-html\s*([\[{"][\s\S]*?)\s*-->`：后者的惰性体 + 尾部 `\s*`
   * 在 `<!--dsh-html [` + 大量空格上每次扩张都要重扫一遍空格，实测 5KB 就要 11ms（四次翻倍 4×）。
   * meta 头必须在正文最前面，所以扫描窗口天然很小：只在开头有限字符内找。
   */
  const META_SCAN_LIMIT = 4096;
  function parseMeta(raw) {
    const s = typeof raw === "string" ? raw : "";
    let i = 0;
    const n = Math.min(s.length, META_SCAN_LIMIT);
    while (i < n && isMetaSpace(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== LT || s.charCodeAt(i + 1) !== BANG) return { found: false, value: null, error: null };
    if (s.slice(i + 2, i + 4) !== "--") return { found: false, value: null, error: null };
    let p = i + 4;
    while (p < n && isMetaSpace(s.charCodeAt(p))) p++;
    if (indexOfAsciiCI(s, "dsh-html", p) !== p) return { found: false, value: null, error: null };
    p += "dsh-html".length;
    while (p < n && isMetaSpace(s.charCodeAt(p))) p++;
    const first = s.charAt(p);
    if (first !== "[" && first !== "{" && first !== '"') return { found: false, value: null, error: null };
    const close = s.indexOf("-->", p);
    if (close < 0) return { found: false, value: null, error: null };
    let end = close;
    while (end > p && isMetaSpace(s.charCodeAt(end - 1))) end--;
    try {
      const value = JSON.parse(s.slice(p, end));
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
   *
   * 手写单趟扫描替代两个全局惰性正则（见文件顶部关于回溯的说明）：
   * 两阶段顺序与原实现完全一致（先公式、后注释，注释在公式掩码之上再找），只是每阶段都是线性的。
   */
  function maskBlock(chunk) {
    return chunk.replace(/[^\n]/g, "\u0001");
  }
  /** 收集公式区（与 `\$\$[\s\S]+?\$\$|\\\[…|\\\(…` 等价，线性）。 */
  function collectLatexRanges(s, out) {
    const n = s.length;
    let i = 0;
    // 关键：某种闭合串一旦在当前位置之后完全不存在，它对后面任何起点也不存在 ——
    // 用一个闩锁记住，避免每个起点都重扫到字符串末尾（那正是二次方的来源：
    // 实测 `'\('.repeat(k)` 会在 80KB 上烧掉 2.5 秒）。
    let noDollar = false;
    let noBracket = false;
    let noParen = false;
    while (i < n) {
      // 用原生 indexOf 找"最近的一个起手符"，替代逐字符 walk（1MB 正文上差好几毫秒）。
      let at = -1;
      let kind = 0;
      if (!noDollar) {
        const p = s.indexOf("$$", i);
        if (p >= 0) { at = p; kind = 1; }
      }
      if (!noBracket) {
        const p = s.indexOf("\\[", i);
        if (p >= 0 && (at < 0 || p < at)) { at = p; kind = 2; }
      }
      if (!noParen) {
        const p = s.indexOf("\\(", i);
        if (p >= 0 && (at < 0 || p < at)) { at = p; kind = 3; }
      }
      if (at < 0) return;
      const openerLen = 2;
      const closer = kind === 1 ? "$$" : kind === 2 ? "\\]" : "\\)";
      const end = s.indexOf(closer, at + openerLen);
      if (end > at + openerLen) { out.push([at, end + openerLen]); i = end + openerLen; continue; }
      // end < 0：后面再没有该闭合串；end === at+2：紧邻（如 `$$$$`），正则同样不匹配。
      if (end < 0) {
        if (kind === 1) noDollar = true;
        else if (kind === 2) noBracket = true;
        else noParen = true;
      }
      i = at + 1;
    }
  }
  /** 收集注释区（与 `/<!--[\s\S]*?-->/g` 等价，线性）。 */
  function collectCommentRanges(s, out) {
    const n = s.length;
    let i = 0;
    while (i < n) {
      const lt = s.indexOf("<", i);
      if (lt < 0) return;
      const c1 = s.charCodeAt(lt + 1);
      if (c1 === BANG) {
        if (s.startsWith("<!--", lt)) {
          const end = s.indexOf("-->", lt + 4);
          // 注释未闭合 → 一直到文末都是注释（HTML tokenizer 同款行为）。
          // 旧实现直接放弃掩码，于是注释里的 `<div>` 被当成真标签 → 误报 E-UNCLOSED，
          // 而"修复"还会把 </div> 塞进注释里。
          if (end < 0) { out.push([lt, n]); return; }
          out.push([lt, end + 3]);
          i = end + 3;
          continue;
        }
        // `<![CDATA[ … ]]>` / `<!x … >` / `<!doctype …>`：HTML 里都是 bogus comment，到第一个 `>` 为止。
        const gt = s.indexOf(">", lt + 2);
        if (gt < 0) { out.push([lt, n]); return; }
        out.push([lt, gt + 1]);
        i = gt + 1;
        continue;
      }
      if (c1 === 63 /* ? */) {
        // `<?xml … ?>` 等处理指令：HTML 里同样是 bogus comment。
        const gt = s.indexOf(">", lt + 2);
        if (gt < 0) { out.push([lt, n]); return; }
        out.push([lt, gt + 1]);
        i = gt + 1;
        continue;
      }
      i = lt + 1;
    }
  }
  function applyRanges(s, ranges) {
    if (ranges.length === 0) return s;
    let out = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start < cursor) continue;
      out += s.slice(cursor, start) + maskBlock(s.slice(start, end));
      cursor = end;
    }
    return out + s.slice(cursor);
  }
  function maskSource(raw) {
    const s = String(raw || "");
    const latex = [];
    collectLatexRanges(s, latex);
    // 注释必须在公式掩码之后找（原实现同序）：落在公式里的 `<!--` 已经被掩掉，不再算注释。
    const afterLatex = applyRanges(s, latex);
    const comments = [];
    collectCommentRanges(afterLatex, comments);
    return applyRanges(afterLatex, comments);
  }

  /**
   * 对掩码文本做一次标签扫描，产出事件序列（validateRaw 与 repairHtml 共用，
   * 保证"诊断"与"修复"看到的是同一份事实）。
   * 事件：{kind:"open"|"close"|"void"|"stray"|"optional-close"|"ignored-void-close"|"implicit-close", name, index, length}
   *
   * 手写线性扫描：遇到"属性段扫到字符串末尾都没见到 `>`"就整体收工 —— 那段文本后面
   * 的任何一个 `<` 同样不可能闭合出标签，继续尝试只会退化成二次方（正则版就是这样）。
   */
  function scanTags(masked, budget) {
    const events = [];
    const stack = [];
    let tagCount = 0;
    const n = masked.length;
    /** 自闭合的外来元素名 → 计数：后续多余闭合按浏览器行为忽略，不报 E-STRAY-CLOSE。 */
    const selfClosedForeign = Object.create(null);
    /** 当前是否位于外来内容（svg/math）内部：那里自闭合标记才是有效的。 */
    let foreignDepth = 0;
    /** 把标签栈截断到 len，同时维护 foreignDepth。 */
    function dropTo(len) {
      for (let x = stack.length - 1; x >= len; x--) if (stack[x].foreign) foreignDepth--;
      stack.length = len;
    }
    let i = 0;
    let noMoreGt = false;
    while (i < n) {
      const lt = masked.indexOf("<", i);
      if (lt < 0) break;
      i = lt + 1;
      let j = lt + 1;
      let isClose = false;
      if (masked.charCodeAt(j) === SLASH) { isClose = true; j++; }
      if (!isNameStart(masked.charCodeAt(j))) continue;
      const nameStart = j;
      j++;
      while (j < n && isNameChar(masked.charCodeAt(j))) j++;
      const name = masked.slice(nameStart, j).toLowerCase();
      // 属性段语义与正则 `((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>` 完全一致：引号只能由成对的
      // 引号段消费（[^>"'] 不含引号），未闭合的引号让本次匹配失败，然后像正则那样从下一个
      // `<` 重试。重试是精确语义所必需的（差分模糊测试证明：从失败点继续会跳过中间的合法标签）。
      //
      // 但逐字符 walk 的常数比原生正则大得多（实测 1MB 良性正文 15.9 ms vs 正则 4.1 ms），
      // 所以走"跳读快路径"：用原生 indexOf 直接跳到下一个 `>` 或引号，中间字符一个不看。
      // 只有畸形输入才会退回逐字符路径，而那正是 budget 兜底的对象。
      let k = j;
      let closed = false;
      let lastSignificant = -1;
      while (k < n) {
        if (budget && budget.left <= 0) { budget.exhausted = true; break; }
        const gt = masked.indexOf(">", k);
        if (gt < 0) {
          // k 之后没有 `>` 了，但注意 k 可能已经被"引号整段跳读"推到了某个 `>` 之后 ——
          // 所以只有**标签起点 lt 之后**也没有 `>` 时，才能断定后续起点同样无解并整体收工。
          // （差分模糊测试给出的反例：`<a "a > b</b>` 里首起点失败，但 `</b>` 用的是被跳过的那个 `>`。）
          if (budget) budget.left -= n - k;
          if (masked.indexOf(">", lt) < 0) { noMoreGt = true; break; }
          break;
        }
        if (budget) budget.left -= gt - k + 1; // 本次搜索实际扫过的距离都记入预算
        const dq = masked.indexOf('"', k);
        const sq = masked.indexOf("'", k);
        let q = -1;
        if (dq >= 0 && (sq < 0 || dq < sq)) q = dq;
        else if (sq >= 0) q = sq;
        if (q < 0 || q > gt) {
          // 快路径：标签内没有引号 → 直接落在 `>` 上。
          k = gt;
          closed = true;
          break;
        }
        // 慢路径：引号只能由成对引号消费；未闭合即本次匹配失败（随后从下一个 `<` 重试）。
        const pair = masked.indexOf(masked[q], q + 1);
        if (pair < 0) break;
        lastSignificant = pair;
        k = pair + 1;
      }
      if (budget && budget.exhausted) break;
      if (noMoreGt) break;
      if (!closed) {
        // 本次不是标签（未闭合引号或没有 `>`）：继续找下一个 `<`（与正则一致）。
        continue;
      }
      // selfClose：`>` 之前最后一个非空白字符是不是 `/`（等价于原正则的 mm[4]==="/" || /\/\s*$/）。
      if (lastSignificant < k) {
        let p = k - 1;
        while (p > lt && isSpaceChar(masked.charCodeAt(p))) p--;
        lastSignificant = masked.charCodeAt(p) === GT ? -1 : p;
      }
      const rawLength = k + 1 - lt;
      const selfClose = lastSignificant >= 0 && masked.charCodeAt(lastSignificant) === SLASH;
      // 下一个扫描位置必须在整个标签之后：属性段里可以出现 `<`（与原正则 [^>"'] 一致），
      // 若不跳过就会把属性里的 `<` 当成新标签起点。
      i = k + 1;
      tagCount++;
      const ev = { kind: "open", name, index: lt, length: rawLength };
      if (isClose) {
        if (VOID_TAGS[name]) {
          ev.kind = "ignored-void-close";
          events.push(ev);
          continue;
        }
        if (OPTIONAL_CLOSE[name]) {
          // 注意：stack 里放的是事件对象，`stack.lastIndexOf(name)` 永远返回 -1
          // （字符串和对象恒不相等）——旧实现因此从未真正截断过栈，只是"看起来没事"。
          const oi = findInStack(stack, name);
          if (oi === -1) {
            // 没有可配对的开放标签 = 多余闭合（可选闭合不等于可以凭空闭合）。
            ev.kind = selfClosedForeign[name] ? "ignored-void-close" : "stray";
            if (selfClosedForeign[name]) selfClosedForeign[name]--;
            events.push(ev);
            continue;
          }
          dropTo(oi);
          ev.kind = "optional-close";
          events.push(ev);
          continue;
        }
        if (stack.length && stack[stack.length - 1].name === name) {
          dropTo(stack.length - 1);
          ev.kind = "close";
          events.push(ev);
          continue;
        }
        const wi = findInStack(stack, name);
        if (wi !== -1) {
          const skipped = stack.slice(wi + 1).filter(function (n) { return !OPTIONAL_CLOSE[n.name]; });
          ev.kind = "implicit-close";
          ev.skipped = skipped;
          dropTo(wi);
          events.push(ev);
          continue;
        }
        // 自闭合的外来元素（<svg><rect/></svg>）后面再写 </rect>：浏览器按"忽略多余结束标签"处理。
        if (selfClosedForeign[name]) {
          selfClosedForeign[name]--;
          ev.kind = "ignored-void-close";
          events.push(ev);
          continue;
        }
        ev.kind = "stray";
        events.push(ev);
        continue;
      }
      if (VOID_TAGS[name]) {
        ev.kind = "void";
        events.push(ev);
        continue;
      }
      if (selfClose && foreignDepth === 0) {
        // HTML 内容里自闭合标记被解析器**忽略**：`<div/>x</div>` 里的 `</div>` 是合法闭合。
        // 旧实现把它当 void，于是合法 HTML 被报 E-STRAY-CLOSE，而"修复"还会删掉那个闭合标签、
        // 让后面的文本跑进 div 里 —— 修复版渲染结果与原意不同。
        ev.kind = "open";
      } else if (selfClose) {
        // 外来内容（SVG/MathML）里自闭合有效：不压栈，并记住名字以便忽略后续多余闭合。
        selfClosedForeign[name] = (selfClosedForeign[name] || 0) + 1;
        ev.kind = "void";
        events.push(ev);
        continue;
      }
      if (name === "p") {
        while (stack.length && stack[stack.length - 1].name === "p") dropTo(stack.length - 1);
      } else if (OPTIONAL_CLOSE[name] && stack.length && stack[stack.length - 1].name === name) {
        dropTo(stack.length - 1);
      }
      if (name === "svg" || name === "math") {
        ev.foreign = true;
        foreignDepth++;
      }
      stack.push(ev);
      events.push(ev);
      if (RAW_TEXT_TAGS[name]) {
        // raw-text 内容不是标记：跳到配对的闭标签之后继续。
        // 手写查找（ASCII 大小写无关）替代 /<\/name\s*>/i —— 后者在这个位置每次都要
        // 新建正则对象，且一旦写错标志位就会退化成"永远找到第一个闭标签"的死循环。
        // 结束标签的合法形式：`</name` 后跟空白、`/` 或 `>`（HTML5 script-data end tag 规则），
        // 之后再跳到它自己的 `>`；旧实现只认 `</name>` 与 `</name   >`。
        const needle = "</" + name;
        let at = k + 1;
        let closeAt = -1;
        for (;;) {
          const idx = indexOfAsciiCI(masked, needle, at);
          if (idx < 0) break;
          const after = masked.charCodeAt(idx + needle.length);
          if (after === GT || after === SLASH || isSpaceChar(after)) {
            const gt = masked.indexOf(">", idx + needle.length);
            if (gt >= 0) { closeAt = gt + 1; break; }
          }
          at = idx + 1;
        }
        if (closeAt < 0) {
          // 未闭合 raw-text：保留在栈上（repairHtml 会按栈序补齐 </style>…），
          // 停止扫描（后续文本都属于这个 raw-text 元素）。
          break;
        }
        i = closeAt;
        dropTo(stack.length - 1);
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

  /**
   * 是否存在"某个 <tag …> 标签内满足条件"的情况，等价于 /<tag[^>]*COND/i 但不会回溯。
   *
   * 关键优化：每个 occurrence 的判定窗口是 [at, 下一个 `>`]，而更靠后的 occurrence 的窗口
   * 一定是它的**子区间**；所以一次判定就覆盖了窗口内所有更靠后的 occurrence —— 判定完直接
   * 跳到该 `>` 之后继续。没有 `>` 时窗口延伸到文末，同理一次判定即可收工。
   * （旧写法对每个 occurrence 都从零 indexOf + slice 到文末：实测 `'<script '.repeat(k)`
   *  932 KB 要 17.5 秒 —— 正是这一轮在别处刚清掉的那类二次方。）
   */
  function hasTagAttribute(s, tag, condition) {
    const needle = "<" + tag;
    const n = s.length;
    let from = 0;
    for (;;) {
      const at = indexOfAsciiCI(s, needle, from);
      if (at < 0) return false;
      const after = s.charCodeAt(at + needle.length);
      const boundary = after === GT || after === SLASH || isSpaceChar(after) || Number.isNaN(after);
      if (!boundary) {
        from = at + needle.length;
        continue;
      }
      const gt = s.indexOf(">", at + needle.length);
      const end = gt < 0 ? n : gt + 1;
      if (condition.test(s.slice(at, end))) return true;
      if (gt < 0) return false; // 窗口已到文末，后续 occurrence 的窗口都是它的子区间
      from = gt + 1;
    }
  }

  function validateRaw(raw, config) {
    const cfg = config || DEFAULT_CONFIG;
    const errors = [];
    const warnings = [];
    const s = typeof raw === "string" ? raw : "";
    const meta = parseMeta(s);
    // 行数按 CRLF/CR/LF 三种行尾计（旧实现只数 \n：CR-only 正文的 @L 全是 1、W-LINE-LIMIT 永不触发）。
    const lines = s === "" ? 0 : s.split(/\r\n|\r|\n/).length;
    if (s.trim() === "") {
      errors.push(item("E-EMPTY", "-"));
      return { ok: false, ruleSet: RULESET_VERSION, errors, warnings, meta, stats: { bytes: 0, tags: 0 }, lines };
    }
    if (s.length > cfg.maxBytes) {
      // 超限输入直接短路：后面每一步（掩码、扫描、告警探测）都是 O(N) 以上，
      // 而对一个注定被拒的围栏继续分析只是把 4.5 分钟的回溯预算留给攻击面。
      errors.push(item("E-SIZE", s.length + "/" + cfg.maxBytes));
      return {
        ok: false,
        ruleSet: RULESET_VERSION,
        errors,
        warnings,
        meta,
        stats: { bytes: s.length, tags: 0 },
        lines,
      };
    }
    if (meta.found && meta.error) warnings.push(item("W-META-INVALID", meta.error));
    // 行首表按需构建：干净的 1MB 正文（0 诊断）本不该付 2 ms 去建一张没人查的表。
    let lineIndex = null;
    const lineAt = (index) => (lineIndex === null ? (lineIndex = lineIndexFactory(s)) : lineIndex)(index);
    const masked = maskSource(s);
    // 扫描预算：正常正文的标签扫描步数约等于正文长度，4 倍 + 4096 的余量足够；
    // 只有"畸形到让正则二次方回溯"的那类输入才会触碰上限，届时截断并显式告警。
    const budget = { left: 4 * s.length + 4096, exhausted: false };
    const scan = scanTags(masked, budget);
    // 必须是**错误**而不是警告：`ok` 是消费方的唯一门（fenceFailures 跳过 ok、kernel 据此挂载），
    // 截断的结果不能冒充"已验证通过"—— 否则一个坏围栏会被静默接受、永远不进自修环。
    if (budget.exhausted) errors.push(item("E-SCAN-LIMIT", s.length + "B"));
    for (const ev of scan.events) {
      switch (ev.kind) {
        case "stray":
          errors.push(item("E-STRAY-CLOSE", ev.name + "@L" + lineAt(ev.index)));
          break;
        case "implicit-close": {
          const skipped = (ev.skipped || []).map(function (n) { return n.name; }).join(",");
          if (skipped) warnings.push(item("W-IMPLICIT-CLOSE", skipped + "@L" + lineAt(ev.index)));
          break;
        }
        default:
          break;
      }
    }
    for (let i = scan.stack.length - 1; i >= 0; i--) {
      const ev = scan.stack[i];
      if (!OPTIONAL_CLOSE[ev.name]) {
        errors.push(item("E-UNCLOSED", ev.name + "@L" + lineAt(ev.index)));
      }
    }
    // 告警探测：`<script[^>]*\bsrc\s*=` 这类"属性段扫到行尾"的正则在无 `>` 的畸形输入上
    // 同样会二次方回溯（每个 `<script` 起点都扫到末尾）。改成"定位标签起点 → 截到下一个 > →
    // 在这段内做局部匹配"，语义等价（[^>]* 本来就不允许跨 `>`），整体线性。
    if (hasTagAttribute(s, "script", /\bsrc\s*=/i)) warnings.push(item("W-SCRIPT-EXT", "script[src]"));
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|navigator\.sendBeacon|\bimport\s*\(/.test(s)) warnings.push(item("W-SCRIPT-NET", "network-api"));
    if (!cfg.allowRemoteImages && hasTagAttribute(s, "img", /\bsrc\s*=\s*["']?https?:/i)) warnings.push(item("W-EXT-IMG", "img[src]"));
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
    // 同 validateRaw：行首表按需构建（修复路径大多数情况下只查几条诊断）。
    let lineIndex = null;
    const lineAt = (index) => (lineIndex === null ? (lineIndex = lineIndexFactory(s)) : lineIndex)(index);
    const masked = maskSource(s);
    const budget = { left: 4 * s.length + 4096, exhausted: false };
    const scan = scanTags(masked, budget);
    if (budget.exhausted) {
      // 扫描被截断时不产出"修复版"：修复表是按事件序列算的，截断后可能改错结构。
      return { repairable: false, text: null, repairs: [], unrecoverable: ["E-REPAIR-INCOMPLETE"] };
    }
    const drops = [];
    const repairs = [];
    for (const ev of scan.events) {
      if (ev.kind !== "stray") continue;
      drops.push([ev.index, ev.index + ev.length]);
      repairs.push("remove-stray-close:" + ev.name + "@L" + lineAt(ev.index));
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
      repairs.push("append-close:" + ev.name + "@L" + lineAt(ev.index));
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

  /** `<style …>…</style>` 是否存在（线性；替代贪婪的 /<style[\s>][\s\S]*<\/style>/i）。 */
  function hasStyleElement(s) {
    let from = 0;
    for (;;) {
      const at = indexOfAsciiCI(s, "<style", from);
      if (at < 0) return false;
      const after = s.charCodeAt(at + 6);
      if (after === GT || isSpaceChar(after)) {
        const close = indexOfAsciiCI(s, "</style", at + 6);
        // 之后没有 `</style` 了：更靠后的 `<style` 同样找不到对方，一次收工（避免二次方）。
        if (close < 0) return false;
        let p = close + 7;
        while (p < s.length && isSpaceChar(s.charCodeAt(p))) p++;
        if (s.charCodeAt(p) === GT) return true;
        from = close + 7;
        continue;
      }
      from = at + 6;
    }
  }

  /** 无语言标签代码块的结构化识别（0.1.7 generic banner 兼容）。 */
  function looksLikeHtmlDoc(raw) {
    const s = (raw || "").trim();
    if (s.length < 40 || s.charAt(0) !== "<") return false;
    if (/^<!doctype\s+html|^<html[\s>]/i.test(s)) return true;
    if (hasStyleElement(s) && /<[a-zA-Z][\w:-]*(\s|>|\/)/.test(s)) return true;
    return false;
  }

  /** 由回执生成模型可读的修复提示（诊断条"复制修复提示"按钮与围栏反馈环共用）。
   * repairedHtml 非空时附上可直接采用的修复版源码（v4：闭环最后 100 米）。
   */
  /** 选一个不会被正文里已有的反引号提前闭合的围栏标记（至少 3 个反引号）。 */
  function fenceFor(text) {
    let max = 2;
    const runs = String(text || "").match(/`+/g);
    if (runs) for (const run of runs) if (run.length > max) max = run.length;
    return "`".repeat(max + 1);
  }

  function repairPrompt(receipt, repairedHtml) {
    const lines = [];
    const all = (receipt.errors || []).concat(receipt.warnings || []);
    for (const it of all) {
      lines.push("- " + it.code + (it.detail && it.detail !== "-" ? "(" + it.detail + ")" : "") + "：" + (FIX[it.code] || it.fix || "按错误码修复"));
    }
    let out = "请修复以下 dsh-html 围栏问题并重新输出完整围栏（写在回答正文，不要写在思考块里）：\n" + lines.join("\n");
    if (typeof repairedHtml === "string" && repairedHtml) {
      // 围栏长度必须大于正文里最长的反引号串：否则正文里的一行 ``` 会提前闭合代码块，
      // 后续文本掉出代码块（实测修复版里带 ``` 时会出现三条围栏行）。
      const fence = fenceFor(repairedHtml);
      out += "\n\n也可以直接采用下面这份已修复的源码（原样粘贴进围栏即可）：\n" + fence + "html\n" + repairedHtml + "\n" + fence;
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
      var inner = '<!doctype html><html><head><meta charset="utf-8">' + buildCsp(config.allowRemoteImages) + headExtra + '</head><body style="margin:4px 6px;color-scheme:light dark;background:' + pal.bg + ";color:" + pal.fg + ';">' + raw + /* alert/confirm/prompt → 页内 toast（保留旧版实现） */
      '<script>try{(function(){function toast(m){var d=document.createElement("div");d.style.cssText="position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(30,41,59,.96);color:#e2e8f0;border-radius:8px;padding:8px 14px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.4);max-width:80%;pointer-events:none";d.textContent=m;document.body.appendChild(d);setTimeout(function(){d.remove()},2600)}window.alert=function(m){toast("[alert] "+m)};window.confirm=function(){toast("[confirm] \u88AB\u6C99\u7BB1\u963B\u65AD\uFF0C\u5DF2\u6309\u201C\u786E\u5B9A\u201D\u8FD4\u56DE false");return false};window.prompt=function(){toast("[prompt] \u88AB\u6C99\u7BB1\u963B\u65AD");return null}})()}catch(e){}<\/script>' + helperScript(mid == null ? 0 : mid) + "</body></html>";
      if (!tab) return inner;
      // 新标签/导出曾经直接把这个文档塞进 blob: URL 打开，并指望 meta 里的
      // `sandbox allow-scripts` 沙箱化它——而 CSP 的 sandbox 指令在 <meta> 中被浏览器
      // 直接忽略（MDN），blob: 文档又继承创建者源：模型 HTML 会以"应用同源 + 未沙箱"
      // 身份运行（可读 localStorage/IndexedDB、可自我导航外发数据）。
      // 改为外层静态壳（插件自有标记）+ 内层真正的 sandbox="allow-scripts" iframe(srcdoc)。
      var escaped = inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      return '<!doctype html><html><head><meta charset="utf-8"><title>dsh-html-ui</title><style>html,body{margin:0;height:100%;background:' + pal.bg + '}iframe{border:0;width:100%;height:100vh;display:block}</style></head><body><iframe sandbox="allow-scripts" title="dsh-html-ui" srcdoc="' + escaped + '"></iframe></body></html>';
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
      // 缓存键必须体现"这次结果是否已经过 KaTeX 增强"：只按 raw+配色做键时，KaTeX 尚未
      // 就绪（脚本加载中或 onerror）那一次会把**未增强**的正文写进缓存，之后即使 KaTeX
      // 可用，命中的仍是含原始 $$ 的旧正文（实测 hits:1 之后再也不会渲染公式）。
      // 把状态位并入键即可自愈：状态一变，键就变。
      var enrichOk = !config.latex || !hasLatex(raw) || katexState === "ok";
      key += enrichOk ? ":e" : ":r";
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
        c.className = "dsh-html-ui-wrap dsh-html-ui-src-mode";
        var soUi = makeToolbar();
        soUi.lbl.textContent = dict.toolbar.sourceOnly;
        var warn = doc.createElement("div");
        warn.className = "dsh-html-ui-warn";
        warn.textContent = dict.oversized.warn;
        // 源码必须真的显示出来：旧实现只挂告警条就把原块隐藏了，围栏内容在对话里
        // 整个消失（"仅显示源码"名不副实），且工具栏按钮全哑（监听器在早返回之后才挂）。
        var soPre = doc.createElement("pre");
        soPre.className = "dsh-html-ui-src";
        soPre.textContent = raw;
        c.appendChild(soUi.bar);
        c.appendChild(warn);
        c.appendChild(soPre);
        block.after(c);
        // 无 iframe：预览/重载不适用，隐藏；复制/下载/新标签保留并接线。
        soUi.bSrc.style.display = "none";
        soUi.bReload.style.display = "none";
        soUi.bCopy.addEventListener("click", function() {
          var done = function() {
            soUi.bCopy.textContent = dict.toolbar.copied;
            win.setTimeout(function() {
              soUi.bCopy.textContent = dict.toolbar.copy;
            }, 900);
          };
          var fail = function() {
            soUi.bCopy.textContent = dict.toolbar.copyFailed;
            win.setTimeout(function() {
              soUi.bCopy.textContent = dict.toolbar.copy;
            }, 1200);
          };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(raw).then(done, fail);
              return;
            }
          } catch (e) {
            dbg(e);
          }
          fail();
        });
        soUi.bDown.addEventListener("click", function() {
          try {
            var out = "<!doctype html>\n<!-- dsh-html-ui v" + VERSION + " self-contained export (source only) -->\n<script type=\"text/plain\" id=\"dsh-html-source\">" + raw.replace(/<\//g, "<\\/") + "<\/script>";
            var url = win.URL.createObjectURL(new Blob([out], { type: "text/html;charset=utf-8" }));
            var a = doc.createElement("a");
            a.href = url;
            a.download = "dsh-html-" + fnv1a32(raw).toString(16) + ".html";
            doc.body.appendChild(a);
            a.click();
            a.remove();
            win.setTimeout(function() {
              try {
                win.URL.revokeObjectURL(url);
              } catch (e) {
                dbg(e);
              }
            }, 1e4);
          } catch (e) {
            dbg(e);
          }
        });
        soUi.bTab.addEventListener("click", function() {
          try {
            var tabDoc = wrapDocument(raw, null, 0, true);
            var tabUrl = win.URL.createObjectURL(new Blob([tabDoc], { type: "text/html" }));
            win.open(tabUrl, "_blank", "noopener");
            win.setTimeout(function() {
              try {
                win.URL.revokeObjectURL(tabUrl);
              } catch (e) {
                dbg(e);
              }
            }, 3e5);
          } catch (e) {
            dbg(e);
          }
        });
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
      // 调用方（未标注代码块的接管路径）可能已经校验过同一份正文，直接复用其回执。
      var diag = opts.receipt || validateRaw(raw, config);
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
          // wrapDocument 已按 currentPalette() 写好配色；tab 模式下正文被关进
          // srcdoc 里转义过，外层再改 <body style> 只会打空（旧代码在此重复注入，已删）。
          var docTab = wrapDocument(mount.lastBody || raw, mount.lastCss || null, mount.id, true);
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
      // iframe 对 srcdoc 加载失败并不触发 error（旧处理器是死代码），一旦真触发，
      // 旧写法只把原块放回来、wrap+iframe 仍在 DOM 里 —— 同一个围栏显示两遍且每次事件
      // 追加一个告警节点。改为整块卸载 + 计数（与其它失败路径一致）。
      frame.addEventListener("error", function() {
        errCount++;
        try {
          mounts.delete(block);
          mount.unmount();
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
    function onHostMessage(ev) {
      var d = ev && ev.data;
      if (!d) return;
      if (d.kind === "dsh-html-ui-height") {
        if (typeof d.h !== "number" || typeof d.id !== "number" || !ev.source) return;
        var rec = liveFrames.get(d.id);
        if (!rec || !rec.iframe || rec.iframe.contentWindow !== ev.source) return;
        queueHeight(rec, clampHeight(d.h, config.maxHeight), typeof d.full === "number" ? d.full > config.maxHeight : false);
      }
    }
    win.addEventListener("message", onHostMessage);
    var themeObserver = null;
    var schemeMedia = null;
    var onSchemeChange = null;
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
        schemeMedia = win.matchMedia("(prefers-color-scheme: dark)");
        onSchemeChange = function() {
          invalidateTheme();
        };
        if (schemeMedia.addEventListener) schemeMedia.addEventListener("change", onSchemeChange);
        else if (schemeMedia.addListener) schemeMedia.addListener(onSchemeChange);
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
      setTheme: function(p) {
        // 接入宿主 --dsw-alias-* 令牌（wrapper 已从 theme.getTheme() 取好 bg/fg）。
        // 旧实现丢弃实参，主题只能靠 getComputedStyle 扫描跟随，令牌契约形同虚设。
        if (p && (p.bg || p.fg)) {
          var fixed = p;
          themeProvider = function() {
            return fixed;
          };
        }
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
        // 宿主监听器随 disable 摘除：插件重载时旧闭包不再累积。
        try {
          win.removeEventListener("message", onHostMessage);
        } catch (e) {
        }
        try {
          if (schemeMedia && onSchemeChange) {
            if (schemeMedia.removeEventListener) schemeMedia.removeEventListener("change", onSchemeChange);
            else if (schemeMedia.removeListener) schemeMedia.removeListener(onSchemeChange);
          }
        } catch (e) {
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
  /** 连续多少次"无变化"轮询后停表（等 MO/IO 唤醒）；约 15s 静默后进入零轮询空闲。 */
  var QUIET_SWEEPS_STOP = 6;
  var SURFACE_HOPS = 4;
  /** 每隔多少次 tick 做一次全文档兜底扫描（其余 tick 只处理 DOM 变更标记过的块）。 */
  var FULL_SWEEP_EVERY = 4;
  /** labelTextOf 的有界 DFS 访问上限（文本横幅总在开头；超出即视为无标签）。 */
  var LABEL_SCAN_LIMIT = 400;
  /** 同一挂载点两次"正文变更比对"之间的最小间隔（毫秒）：把 rAF 级的 O(子树) 读取摊薄。 */
  var RAW_RECHECK_MS = 500;
  var BLOCK_CONTENT_SELECTOR = "p, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, blockquote, hr, img, figure";
  function installScheduler(kernel, options = {}) {
    var win = options.window || window;
    var doc = options.document || win.document;
    var config = kernel.config || {};
    var getLabel = options.getLabel || labelTextOf;
    // 调度节奏全部走 options：默认值即线上行为，测试可以注入确定性数值。
    var sweepMs = options.sweepMs || SWEEP_MS;
    var sweepMsSlow = options.sweepMsSlow || SWEEP_MS_SLOW;
    var quietSweepsStop = options.quietSweepsStop || QUIET_SWEEPS_STOP;
    var fullSweepEvery = options.fullSweepEvery || FULL_SWEEP_EVERY;
    var rawRecheckMs = options.rawRecheckMs || RAW_RECHECK_MS;
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
    /** 自上次全文档扫描以来 DOM 是否变过（由 MutationObserver 经 schedule() 置位）。 */
    var domDirty = true;
    var tickCount = 0;
    function rawOf(block) {
      var pre = block.querySelector("pre");
      if (!pre) return "";
      var text = "";
      for (var i = 0; i < pre.childNodes.length; i++) text += pre.childNodes[i].textContent || "";
      return text;
    }
    /**
     * 取第一个"不在 <pre> 里的叶子元素"文本作为语言标签。
     *
     * 旧实现 `block.querySelectorAll("*")` 会把整棵子树物化成数组：实测在 5k 节点的祖先上
     * 0.88 ms/次，而结构判定只要 0.008 ms —— 相差 9~100×，且因为不再提前 break，
     * 12 个裸 <pre> 的扫描从 5.80 ms 涨到 23.29 ms。改为"有界 DFS"：文本横幅总在开头，
     * 访问到 LABEL_SCAN_LIMIT 个元素就放弃（返回空 = 视为无标签）。
     */
    function labelTextOf(block) {
      var pre = block.querySelector("pre");
      var stack = [];
      var kids = block.children;
      for (var i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      var visited = 0;
      while (stack.length > 0 && visited < LABEL_SCAN_LIMIT) {
        var el = stack.pop();
        visited++;
        if (pre && (el === pre || pre.contains(el))) continue;
        if (el.childElementCount !== 0) {
          var cs = el.children;
          for (var j = cs.length - 1; j >= 0; j--) stack.push(cs[j]);
          continue;
        }
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
          // 顺序很关键：结构判定便宜且失败即 break（实测同一 DOM：先结构 5.80 ms，
          // 先标签 23.29 ms —— 后者会把 body/html 也拉进标签扫描）。
          if (!isPlausibleFenceSurface(el2)) break;
          var lbl = labelTextOf(el2);
          if (!isHtmlMarkerLabel(lbl)) continue;
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
          if (isHtmlMarkerLabel(lbl)) return cur;
        }
      }
      return null;
    }
    /**
     * 定稿判定。`rawText` 可选：调用方已经读过正文时直接传进来，
     * 避免流式路径上对同一块文本重复做 O(N) 提取（哈希只需要这一次读取）。
     */
    function isClosed(block, state, rawText) {
      var next = block.nextElementSibling;
      if (next && isVisibleContentBlock(next)) return { closed: true, via: "next-block" };
      var streaming = block.closest(STREAMING);
      if (!streaming) return { closed: true, via: "streaming-gone" };
      var hash = fnv1a32(rawText === void 0 ? rawOf(block) : rawText);
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
    function takeOver(block, raw, receipt) {
      if (mounts.has(block)) return;
      if (raw.length > config.maxBytes) {
        // 存真正的 mount（旧实现存 true）：否则 repairSurgery 取不到 container，
        // 每轮 sweep 都会把这块当"容器失联"重新挂载一次，DOM 无限增长。
        var soMount = kernel.mountBlock(block, raw, { height: block.offsetHeight, sourceOnly: true, receipt: receipt });
        if (soMount) mounts.set(block, soMount);
        return;
      }
      var h = block.offsetHeight || 180;
      // receipt 透传：未标注代码块的接管路径已经校验过一次，没必要对同一份正文再验一遍
      // （实测 1MB 正文重复校验 = 白烧 23.7 ms）。
      var mount = kernel.mountBlock(block, raw, { height: h, receipt: receipt });
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
      // 正文只取一次：旧顺序里 rawOf 被调两遍（白名单探针一遍、挂载一遍），
      // isClosed 内部还会再算一次哈希 —— 流式期间每次字符变更都要重读整块文本。
      var raw = rawOf(block);
      if (raw.trim() === "") return;
      // 结算门槛提到最前：未定稿的块直接返回，不再为它跑 O(N) 的白名单校验。
      // （流式中的大代码块此前每次变更都要整篇 validateRaw 一次，纯属白烧 CPU。）
      var state = settleState.get(block);
      var verdict = isClosed(block, state, raw);
      if (state) settleState.set(block, verdict.state || state);
      if (!verdict.closed) return;
      settleState.delete(block);
      var label = getLabel(block);
      if (!wantsTakeoverRaw(label, "", config)) {
        // v4：白名单式内容回退（借鉴 dsh-genui isGenericGenuiFence）——只放行
        // 宿主"通用代码块"标签（Code / Code block / 代码块）、且正文完整通过
        // render 前校验的围栏；绝不因为"长得像 HTML"就接管普通代码块。
        if ((label || "").trim() !== "" || config.inferUnlabeled === false) return;
        var lbl0 = labelTextOf(block).trim().toLowerCase();
        var GENERIC_LABELS = { code: 1, "code block": 1, "\u4ee3\u7801\u5757": 1 };
        if (!GENERIC_LABELS[lbl0]) return;
        // 超限正文注定过不了校验（E-SIZE），先按长度短路，省掉整篇扫描。
        if (raw.length > config.maxBytes) return;
        var receipt = validateRaw(raw, config);
        if (!receipt.ok) return;
        inferredCount++;
        // 回执透传给 mountBlock：否则同一份正文会被连验两次（1MB 正文实测 2×23.7 ms）。
        takeOver(block, raw, receipt);
        return;
      }
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
        // 正文变更检测：mount.raw 只在挂载时抓一次，宿主原地重渲染/流式收尾后
        // iframe、源码视图、复制、下载、修复提示都会停在半截快照上（lastRaw 本为此存在）。
        //
        // 但"每轮 sweep 都读一遍正文"太贵：实测 `textContent.length` 仍是 O(子树) 且会
        // 分配整条字符串（2 万节点挂载点 1.83 ms，40 个挂载点每帧 2.93 ms）。改为按时间摊薄：
        // 同一挂载点最多每 RAW_RECHECK_MS 做一次完整比对，其余轮次直接跳过。
        // 超限（sourceOnly）挂载不参与——它们不重渲染，正文还可能是 MB 级。
        if (m.oversized !== true) {
          var now = Date.now();
          if (m._rawCheckedAt === void 0) {
            m._rawCheckedAt = now;
          } else if (now - m._rawCheckedAt >= rawRecheckMs) {
            m._rawCheckedAt = now;
            var nowRaw = rawOf(block);
            if (nowRaw.trim() !== "" && nowRaw !== m.lastRaw) {
              unmountBlock(block); // 先释放旧 mount（含 liveFrames），否则每次重挂泄一份
              takeOver(block, nowRaw);
            }
          }
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
            kernel._dbg ? kernel._dbg(e) : 0;
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
    function ensurePolling() {
      if (disposed || intervalId) return;
      quietSweeps = 0;
      intervalId = win.setTimeout(tick, SWEEP_MS);
    }
    function onVisibility() {
      if (!disposed && doc.visibilityState !== "hidden") ensurePolling();
    }
    function schedule() {
      sweepActive = true;
      domDirty = true; // 有变更 → 让下一次 tick 做全文档兜底扫描
      // 有动静就确保轮询在跑（停表后由这里唤醒）。
      ensurePolling();
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
      ensurePolling();
      try {
        doc.addEventListener("visibilitychange", onVisibility);
      } catch (e) {
      }
    }
    /**
     * 轮询的一次 tick。必须与 ensurePolling/schedule 同层：它们是互相唤醒的关系，
     * 把 tick 嵌在 start() 里会让 ensurePolling 抛 `tick is not defined` —— 那会让
     * installScheduler 直接抛错、客户端 entry 激活失败（表现为
     * "web boot: 1 entry did not activate / dsh-html-ui: failed"）。
     */
    function tick() {
      intervalId = null;
      if (disposed) return;
      if (doc.visibilityState !== "hidden") {
        tickCount++;
        // 全文档扫描是兜底，不是主路径：MutationObserver 已经指出具体变更块，
        // 所以只在"自上次扫描后有 DOM 变更"或每 fullSweepEvery 次 tick 时做一次；
        // 其余 tick 只跑 sweep()（只遍历已挂载块 + 变更集合，与文档规模无关）。
        if (domDirty || tickCount % fullSweepEvery === 0) {
          domDirty = false;
          fullSweep();
        } else {
          sweep();
        }
        if (sweepActive) {
          sweepActive = false;
          quietSweeps = 0;
        } else if (quietSweeps < quietSweepsStop) {
          quietSweeps++;
        }
      }
      // 长时间无变化就停表（文档承诺"零 CPU 空闲"）：MutationObserver /
      // IntersectionObserver 一旦有动静会经 schedule() 重新起表，可见性恢复也会重启。
      if (quietSweeps >= quietSweepsStop) return;
      intervalId = win.setTimeout(tick, quietSweeps >= 3 ? sweepMsSlow : sweepMs);
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (mo) mo.disconnect();
      try {
        doc.removeEventListener("visibilitychange", onVisibility);
      } catch (e) {
      }
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
              // locale.getLocale() 返回的是快照对象 { active, locales, revision }，不是语言字符串：
              // 旧写法 `cur.indexOf("en")` 在对象上直接抛 TypeError（被 catch 吞掉），
              // 于是英文界面下渲染器的工具栏/诊断条永远停在中文。改成读 snapshot.active，
              // 并订阅 locale/change，切换语言时即时跟随（旧实现只在注入那一刻看一次）。
              var applyLocale = function(snap) {
                var active = snap && typeof snap === "object" ? snap.active : snap;
                if (typeof active === "string" && active.indexOf("en") === 0) kernel.setLocale(LOCALES.en);
                else kernel.setLocale(LOCALES.zh);
              };
              try {
                applyLocale(localeSvc.getLocale && localeSvc.getLocale());
              } catch (e) {
              }
              try {
                scope.on("locale/change", applyLocale);
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
