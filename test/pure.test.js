/**
 * P0 纯函数单测 — F2/F3/F7/F9 对策验证。
 */
import { describe, it, expect } from 'vitest'
import {
  wantsTakeoverRaw, buildCsp, replaceLatex, clampHeight, fnv1a32,
  safeColor, isVisibleContentBlock, DEFAULT_CONFIG,
} from '../src/pure.js'

describe('F2: wantsTakeoverRaw — deterministic trigger', () => {
  it('html/dsh-html labels always take over (no content guessing)', () => {
    expect(wantsTakeoverRaw('html', '<svg>…', DEFAULT_CONFIG)).toBe(true)
    expect(wantsTakeoverRaw('html', 'plain text', DEFAULT_CONFIG)).toBe(true)
    expect(wantsTakeoverRaw('html', '<p>only a paragraph</p>', DEFAULT_CONFIG)).toBe(true)
    expect(wantsTakeoverRaw('dsh-html', 'anything', DEFAULT_CONFIG)).toBe(true)
    expect(wantsTakeoverRaw('HTML', 'x', DEFAULT_CONFIG)).toBe(true)
    expect(wantsTakeoverRaw('Dsh-Html', 'x', DEFAULT_CONFIG)).toBe(true)
  })
  it('non-matching labels never take over', () => {
    expect(wantsTakeoverRaw('python', '<div>x</div>', DEFAULT_CONFIG)).toBe(false)
    expect(wantsTakeoverRaw('json', '<div>x</div>', DEFAULT_CONFIG)).toBe(false)
    expect(wantsTakeoverRaw('', '<div>x</div>', DEFAULT_CONFIG)).toBe(false)
  })
  it('requireMarker=true narrows to html-render / dsh-html only', () => {
    const cfg = { ...DEFAULT_CONFIG, requireMarker: true }
    expect(wantsTakeoverRaw('html-render', 'x', cfg)).toBe(true)
    expect(wantsTakeoverRaw('dsh-html', 'x', cfg)).toBe(true)
    expect(wantsTakeoverRaw('html', 'x', cfg)).toBe(false)
    expect(wantsTakeoverRaw('dsh-html-ui', 'x', cfg)).toBe(false)
  })
})

describe('F3: replaceLatex — never processes single $', () => {
  const render = (s, display) => (display ? '[BLOCK:' + s + ']' : '[INLINE:' + s + ']')

  it('processes $$…$$ / \\[…\\] / \\(…\\)', () => {
    expect(replaceLatex('a $$x^2$$ b', render, DEFAULT_CONFIG)).toBe('a [BLOCK:x^2] b')
    expect(replaceLatex('\\[z\\]', render, DEFAULT_CONFIG)).toBe('[BLOCK:z]')
    expect(replaceLatex('\\(w\\)', render, DEFAULT_CONFIG)).toBe('[INLINE:w]')
  })
  it('single $ (money/prices) untouched — F3 core fix', () => {
    const raw = '单价 $50，总价 $100，变量 $x 不渲染'
    expect(replaceLatex(raw, render, DEFAULT_CONFIG)).toBe(raw)
  })
  it('single $ with latex math-look is still untouched', () => {
    expect(replaceLatex('E = $mc^2$', render, DEFAULT_CONFIG)).toBe('E = $mc^2$')
  })
  it('never touches code/pre/script/style contents (D2)', () => {
    const raw = '<code>a $b$ c $$d$$</code><pre>$$raw$$</pre><script>var s="$x$";</script><style>.a{content:"$$"}</style>'
    const out = replaceLatex(raw, render, DEFAULT_CONFIG)
    expect(out).toContain('<code>a $b$ c $$d$$</code>')
    expect(out).toContain('<pre>$$raw$$</pre>')
    expect(out).toContain('var s="$x$";')
    expect(out).toContain('.a{content:"$$"}')
  })
  it('renderer throw keeps full match (fence never dies)', () => {
    const thrower = () => { throw new Error('boom') }
    expect(replaceLatex('a $$x$$ b', thrower, DEFAULT_CONFIG)).toBe('a $$x$$ b')
  })
  it('over-count formulas left intact', () => {
    const many = Array.from({ length: DEFAULT_CONFIG.TEX_MAX_COUNT + 3 }, (_, i) => '$$v' + i + '$$').join(' ')
    const out = replaceLatex(many, render, DEFAULT_CONFIG)
    expect(out).toContain('$$v' + DEFAULT_CONFIG.TEX_MAX_COUNT + '$$')
  })
})

describe('F7: buildCsp — remote images off by default', () => {
  it('default CSP has no http/https image source', () => {
    const csp = buildCsp(false, false)
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('img-src data: blob:')
    expect(csp).not.toContain('http:')
    expect(csp).not.toContain('https:')
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("font-src data:")
  })
  it('allowRemoteImages=true appends https: only', () => {
    const csp = buildCsp(true, false)
    expect(csp).toContain('img-src data: blob: https:')
    expect(csp).not.toContain('http:')
  })
  it('tab variant appends sandbox directive', () => {
    expect(buildCsp(false, true)).toContain('sandbox allow-scripts')
  })
})

describe('clampHeight / fnv1a32 / safeColor', () => {
  it('clamps [40, max]', () => {
    expect(clampHeight(100, 12000)).toBe(100)
    expect(clampHeight(10, 12000)).toBe(40)
    expect(clampHeight(99999, 12000)).toBe(12000)
  })
  it('fnv1a32 deterministic and 32-bit', () => {
    expect(fnv1a32('x')).toBe(fnv1a32('x'))
    expect(fnv1a32('<div>a</div>')).not.toBe(fnv1a32('<div>b</div>'))
    expect(fnv1a32('y')).toBeGreaterThanOrEqual(0)
    expect(fnv1a32('y')).toBeLessThanOrEqual(0xffffffff)
  })
  it('safeColor whitelist', () => {
    expect(safeColor('#a1b2c3', 'Canvas')).toBe('#a1b2c3')
    expect(safeColor('rgba(0, 0, 0, .5)', 'Canvas')).toBe('rgba(0, 0, 0, .5)')
    expect(safeColor('javascript:alert(1)', 'Canvas')).toBe('Canvas')
    expect(safeColor(null, 'Canvas')).toBe('Canvas')
  })
})

describe('isVisibleContentBlock (决策 2a)', () => {
  it('rejects script/style/template', () => {
    const el = { nodeType: 1, tagName: 'SCRIPT', getBoundingClientRect: () => ({ width: 100, height: 20 }) }
    expect(isVisibleContentBlock(el)).toBe(false)
  })
  it('accepts pre/code and generic blocks', () => {
    const pre = { nodeType: 1, tagName: 'PRE', getBoundingClientRect: () => ({ width: 100, height: 20 }) }
    expect(isVisibleContentBlock(pre)).toBe(true)
    const p = { nodeType: 1, tagName: 'P', getBoundingClientRect: () => ({ width: 100, height: 20 }) }
    expect(isVisibleContentBlock(p)).toBe(true)
  })
  it('zero-size non-hidden elements stay visible (jsdom-safe)', () => {
    const zero = { nodeType: 1, tagName: 'P', getBoundingClientRect: () => ({ width: 0, height: 0 }) }
    expect(isVisibleContentBlock(zero)).toBe(true) // no getComputedStyle in jsdom fallback
  })
})
