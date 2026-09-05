// @vitest-environment happy-dom
/**
 * P0 DOM 冒烟 + 安全样本集（非协商约束 4 安全样本必须全绿）。
 * 用构建产物（dsh-html-client.js）验证：
 *  - 入口启动 __dshHtmlUi 命名空间
 *  - 安全样本在 iframe 内无效/无害（CSP 禁止网络/iframe/父页访问）
 *  - srcdoc 不含 allow-same-origin；CSP 基线
 *  - F7：默认禁 http/https 图片源
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientJs = readFileSync(join(root, 'dsh-html-client.js'), 'utf8')

function makeWindow() {
  const win = new Window({ url: 'http://localhost:3080/' })
  win.matchMedia = win.matchMedia || (() => ({ addEventListener() {}, addListener() {}, matches: false }))
  win.IntersectionObserver = class { observe() {} disconnect() {} }
  win.fetch = async () => ({ ok: true, text: async () => '' })
  win.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  return win
}

/* 构造宿主风格的 assistant 行内围栏：行锚点含 assistant + .md-code-block */
function makeFence(win, content, lang) {
  const row = win.document.createElement('div')
  row.setAttribute('data-chat-anchor-key', '14:assistant-step1:0')
  row.setAttribute('data-chat-flow-kind', 'assistant')
  const block = win.document.createElement('div')
  block.className = 'md-code-block'
  const banner = win.document.createElement('div')
  banner.className = 'md-code-block-banner'
  const label = win.document.createElement('div')
  label.className = 'infostring'
  label.textContent = lang || 'html'
  banner.appendChild(label)
  const pre = win.document.createElement('pre')
  const code = win.document.createElement('code')
  code.textContent = content
  pre.appendChild(code)
  block.appendChild(banner)
  block.appendChild(pre)
  row.appendChild(block)
  return { row, block }
}

describe('P0 entry boots dsh-html-ui namespace', () => {
  it('window.__dshHtmlUi exists with version 1', () => {
    const win = makeWindow()
    win.eval(clientJs)
    expect(win.__dshHtmlUi).toBeTruthy()
    expect(win.__dshHtmlUi.version).toBe(1)
  })

  it('stats() shape and disable() idempotent', () => {
    const win = makeWindow()
    win.eval(clientJs)
    const s = win.__dshHtmlUi.stats()
    expect(typeof s.mounts).toBe('number')
    expect(typeof s.errors).toBe('number')
    const r = win.__dshHtmlUi
    r.disable()
    expect(win.__dshHtmlUi).toBeUndefined()
  })
})

describe('P0 deterministic takeover (F2) + assistant scope (F8)', () => {
  it('assistant html fence with plain text content is taken over', async () => {
    const win = makeWindow()
    const { row, block } = makeFence(win, '<div style="padding:8px">hi</div>', 'html')
    win.document.body.appendChild(row)
    win.eval(clientJs)
    await new Promise((r) => setTimeout(r, 30))
    const wrap = win.document.querySelector('.dsh-html-ui-wrap')
    expect(wrap).toBeTruthy()
    expect(win.__dshHtmlUi.stats().mounts).toBe(1)
    /* 原块隐藏（先渲染后隐藏原则） */
    expect(block.style.display).toBe('none')
    expect(block.getAttribute('data-dsh-html-ui')).toBe('')
  })

  it('user row fence is NOT taken over (F8)', async () => {
    const win = makeWindow()
    const { row } = makeFence(win, '<div>x</div>', 'html')
    row.setAttribute('data-chat-anchor-key', '9:user-step1:0')
    row.setAttribute('data-chat-flow-kind', 'user')
    win.document.body.appendChild(row)
    win.eval(clientJs)
    await new Promise((r) => setTimeout(r, 30))
    expect(win.document.querySelector('.dsh-html-ui-wrap')).toBeFalsy()
    expect(win.__dshHtmlUi.stats().mounts).toBe(0)
  })

  it('tool-card fence (no assistant anchor) is NOT taken over (F8)', async () => {
    const win = makeWindow()
    const { row } = makeFence(win, '<div>x</div>', 'html')
    row.removeAttribute('data-chat-anchor-key')
    row.removeAttribute('data-chat-flow-kind')
    win.document.body.appendChild(row)
    win.eval(clientJs)
    await new Promise((r) => setTimeout(r, 30))
    expect(win.document.querySelector('.dsh-html-ui-wrap')).toBeFalsy()
  })
})

describe('P0 security sample set (非协商约束 4)', () => {
  const samples = [
    '<script src="https://evil.example/x.js"></script><div>ok</div>',
    '<img src="http://evil.example/p.png"><img src="https://evil.example/p.png">',
    '<div onclick="alert(1)">x</div><img onerror="fetch(1)">',
    '<base href="https://evil.example/">',
    '<form action="https://evil.example"><input></form>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg><script>parent.postMessage("pwn","*")</script></svg>',
    '<a href="javascript:alert(1)">x</a>',
    'x'.repeat(200000) + '</div>', // 超长单行
  ]

  for (const [i, sample] of samples.entries()) {
    it(`sample ${i + 1} stays inert: srcdoc CSP forbids it`, async () => {
      const win = makeWindow()
      const { row } = makeFence(win, sample, 'html')
      win.document.body.appendChild(row)
      win.eval(clientJs)
      await new Promise((r) => setTimeout(r, 30))
      const wrap = win.document.querySelector('.dsh-html-ui-wrap')
      /* 要么接管且 CSP 防护，要么未接管 —— 父页永不受影响 */
      if (wrap) {
        const frame = win.document.querySelector('iframe.dsh-html-ui-frame')
        expect(frame).toBeTruthy()
        const srcdoc = frame.srcdoc || frame.getAttribute('srcdoc') || ''
        expect(srcdoc).toContain("default-src 'none'")
        expect(srcdoc).not.toContain('allow-same-origin')
        expect(srcdoc).toContain("connect-src 'none'")
        /* F7: 默认禁 http/https 图片 */
        expect(srcdoc).toContain('img-src data: blob:')
        expect(srcdoc).not.toContain('img-src data: blob: https:')
      } else {
        /* 未接管（如超长触发送达路径外）→ 原块保留，父页无恙 */
        expect(win.__dshHtmlUi.stats().errors).toBe(0)
      }
    })
  }
})

describe('P0 F7 remote image toggle', () => {
  it('default srcdoc CSP rejects https images', async () => {
    const win = makeWindow()
    const { row } = makeFence(win, '<img src="https://x/y.png">', 'html')
    win.document.body.appendChild(row)
    win.eval(clientJs)
    await new Promise((r) => setTimeout(r, 30))
    const frame = win.document.querySelector('iframe.dsh-html-ui-frame')
    const srcdoc = frame ? (frame.srcdoc || '') : ''
    /* 只检查 CSP meta 指令（用户内容里可能自带 https URL，不算 CSP 违规） */
    const cspMeta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(srcdoc)?.[1] || ''
    expect(cspMeta).toContain('img-src data: blob:')
    expect(cspMeta).not.toContain('https:')
    expect(cspMeta).not.toContain('http:')
  })
})
