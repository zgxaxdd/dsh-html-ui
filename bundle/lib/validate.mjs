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
export function parseMeta(raw) {
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
export function maskSource(raw) {
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
export function scanTags(masked) {
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

export function validateRaw(raw, config) {
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
export function looksLikeHtmlDoc(raw) {
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
export function repairPrompt(receipt, repairedHtml) {
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
