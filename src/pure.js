/**
 * dsh-html-ui v1.0.0 — L1 纯函数模块（零 DOM 依赖，vitest 直测）。
 *
 * F2/F3/F7/F9 的对策落点：
 *  - wantsTakeoverRaw：确定性接管（F2）——html/dsh-html 一律接管，无内容猜测
 *  - replaceLatex：只处理 $$…$$ / \[…\] / \(…\)（F3，永不处理单 $）
 *  - buildCsp：默认禁外链（F7），allowRemoteImages 才加 https:
 *  - clampHeight / fnv1a32：高度钳制与内容哈希
 *  - isClosedHeuristic：闭合判定的结构性辅助（架构决策 2a）
 */

/* ------------------------------------------------------------------ *
 * 默认配置（createRenderer 可覆盖）
 * ------------------------------------------------------------------ */
export const DEFAULT_CONFIG = Object.freeze({
  latex: true,                // F3：LaTeX 通道开关（默认开；false 则原文直出）
  allowRemoteImages: false,   // F7：默认禁外链图片；true 仅追加 https:
  requireMarker: false,       // 架构决策 1：true 时仅接管 info=html-render/dsh-html
  maxHeight: 12000,           // iframe 高度上限 px
  heightPad: 8,
  maxBytes: 1024 * 1024,      // 源码 >1MB → 仅源码视图 mount（架构决策 8）
  maxFencesPerRow: 50,        // 单行围栏数上限（防御）
  TEX_MAX_LEN: 2000,          // 单条公式源码上限
  TEX_MAX_COUNT: 200,         // 单围栏公式数量上限
  TEX_CACHE_MAX: 300,         // KaTeX 结果缓存上限
})

/* ------------------------------------------------------------------ *
 * wantsTakeoverRaw — F2 确定性触发
 * 仅 label 与行身份决定接管；不做"像不像 HTML"的内容猜测。
 *   - 'html' / 'dsh-html' → 接管（requireMarker=false）
 *   - requireMarker=true → 仅 'html-render' / 'dsh-html'
 * 内容为空时由调用方跳过（渲染前提，非判定的一部分）。
 * ------------------------------------------------------------------ */
export function wantsTakeoverRaw(label, raw, config) {
  var cfg = config || DEFAULT_CONFIG
  var l = (label || '').trim().toLowerCase()
  if (cfg.requireMarker) {
    return l === 'html-render' || l === 'dsh-html'
  }
  return l === 'html' || l === 'dsh-html'
}

/* ------------------------------------------------------------------ *
 * buildCsp — 文档内 CSP meta（F7：默认禁外网；allowRemoteImages 仅加 https:）
 * ------------------------------------------------------------------ */
export function buildCsp(allowRemoteImages, tab) {
  var img = 'img-src data: blob:'
  if (allowRemoteImages) img += ' https:'
  var base = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    img + '; media-src data: blob:; font-src data:; ' +
    "connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'"
  return '<meta http-equiv="Content-Security-Policy" content="' +
    (tab ? base + '; sandbox allow-scripts' : base) +
    '">'
}

/* ------------------------------------------------------------------ *
 * replaceLatex — F3：只处理 $$…$$ / \[…\] / \(…\)（永不处理单 $）
 * 替换前摘除 HTML 标签与 script/style/pre/code 块（公式绝不进代码）；
 * 失败保留完整匹配；renderFn 抛错回退原文。
 * ------------------------------------------------------------------ */
export function replaceLatex(raw, renderFn, config, phPrefix) {
  var cfg = config || DEFAULT_CONFIG
  var tex = renderFn || function (s, display, full) { return full }
  var PH = phPrefix || ('\uE000' + Math.random().toString(36).slice(2, 8) + '-')
  var tokens = []
  var kept = raw.replace(
    /<script[\s\S]*?<\/script\s*>|<style[\s\S]*?<\/style\s*>|<pre[\s\S]*?<\/pre\s*>|<code[\s\S]*?<\/code\s*>|<[^>]*>/gi,
    function (m) { tokens.push(m); return PH + (tokens.length - 1) + PH }
  )
  var texCount = 0
  function run(s, display, full) {
    if (++texCount > cfg.TEX_MAX_COUNT) return full
    if (s.length > cfg.TEX_MAX_LEN) return full
    try { return tex(s, display, full) } catch (e) { return full }
  }
  kept = kept
    .replace(/\$\$([\s\S]+?)\$\$/g, function (m, s) { return run(s, true, m) })
    .replace(/\\\[([\s\S]+?)\\\]/g, function (m, s) { return run(s, true, m) })
    .replace(/\\\(([\s\S]+?)\\\)/g, function (m, s) { return run(s, false, m) })
    /* 注意：没有单 $ 分支 —— F3 修复，金额文本永不被当作公式 */
  var re = new RegExp(PH + '(\\d+)' + PH, 'g')
  return kept.replace(re, function (m, i) {
    var idx = +i
    return idx >= 0 && idx < tokens.length ? tokens[idx] : m
  })
}

/* ------------------------------------------------------------------ *
 * clampHeight — 高度钳制 [40, max]
 * ------------------------------------------------------------------ */
export function clampHeight(h, max) {
  return Math.max(40, Math.min(h, max))
}

/* ------------------------------------------------------------------ *
 * fnv1a32 — 内容哈希（L2 缓存 key，~1μs）
 * ------------------------------------------------------------------ */
export function fnv1a32(str) {
  var h = 0x811c9dc5
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

/* ------------------------------------------------------------------ *
 * safeColor — 注入 iframe 的主题色白名单（架构决策 4）
 * ------------------------------------------------------------------ */
export function safeColor(c, fb) {
  if (typeof c !== 'string') return fb
  if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c
  if (/^rgba?\([\d\s.,%]+\)$/.test(c)) return c
  if (/^[a-z]+$/i.test(c)) return c
  return fb
}

/* ------------------------------------------------------------------ *
 * isVisibleContentBlock — 架构决策 2a 的可见性判定
 * 围栏的下一个元素兄弟是否是"渲染可见的内容块"（p/标题/列表/表格/引用/
 * 另一代码块/图片/水平线等；排除 script/style/template 与零尺寸节点）。
 * ------------------------------------------------------------------ */
export function isVisibleContentBlock(el) {
  if (!el || el.nodeType !== 1) return false
  var tag = el.tagName
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return false
  if (tag === 'PRE' || tag === 'CODE') return true
  /* 零尺寸节点（隐藏/绝对定位占位）不算 */
  try {
    var r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) {
      var cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false
    }
  } catch (e) { /* 无布局环境（jsdom）默认视为可见 */ }
  return true
}
