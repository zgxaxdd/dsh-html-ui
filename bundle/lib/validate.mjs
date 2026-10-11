/**
 * dsh-html-ui v4 —— 同构校验器（宿主工具 / 浏览器端 / 测试共用同一套规则）。
 * 纯函数：无 DOM、无 Node API。回执结构稳定（archify 式稳定错误码 + 修复指令）：
 *   { ok, ruleSet, errors: [{code, detail, fix}], warnings: [...], meta, stats, lines }
 *
 * 与 lib/client.js 内嵌的 `src/validate.js` 为同一实现的两份拷贝，
 * 由 test/parity.test.mjs 逐用例锁死一致性（test/embed-validate.mjs 负责同步）。
 *
 * v4（ruleSet 4）在 v3 之上新增：
 *  - 诊断携带行号（detail 形如 `div@L12`），模型定位成本从"猜"降到"读"；
 *  - W-LINE-LIMIT / W-DOCTYPE 两条书写卫生警告（meta {"full":true} 放宽行数上限到 500）；
 *  - repairHtml()：按同一扫描结果产出"可直接采用"的修复版源码
 *    （借鉴 dsh-genui：把修好的内容交给模型，比重写一遍更不容易再出错）。
 */

export const RULESET_VERSION = 4;

/**
 * 接管围栏的 info string 白名单 —— 单一事实源。
 * 浏览器端（client.js 内嵌副本）与宿主自修环（feedback.mjs）必须一致：
 * 两处各写一份正是历史上 `html-render` 判据打架的根因。
 * @type {readonly string[]}
 */
export const HTML_FENCE_MARKERS = Object.freeze(["html", "dsh-html", "html-render"]);

export const DEFAULT_CONFIG = Object.freeze({
  latex: true,
  allowRemoteImages: false,
  requireMarker: false,
  maxHeight: 12e3,
  heightPad: 8,
  maxBytes: 1024 * 1024,
  maxFencesPerRow: 50,
  maxLines: 250,
  maxLinesFullPage: 500,
  TEX_MAX_LEN: 2e3,
  TEX_MAX_COUNT: 200,
  TEX_CACHE_MAX: 300,
  inferUnlabeled: true,
});

/** 稳定修复指令表：错误码 → 模型可执行的修复动作。 */
export const FIX = Object.freeze({
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
export function parseMeta(raw) {
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
export function maskSource(raw) {
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
export function scanTags(masked, budget) {
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

export function validateRaw(raw, config) {
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
export function repairHtml(raw, config) {
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
export function looksLikeHtmlDoc(raw) {
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
export function fenceFor(text) {
  let max = 2;
  const runs = String(text || "").match(/`+/g);
  if (runs) for (const run of runs) if (run.length > max) max = run.length;
  return "`".repeat(max + 1);
}

export function repairPrompt(receipt, repairedHtml) {
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
