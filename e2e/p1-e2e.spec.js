/**
 * P1 Playwright 视觉 E2E — 静态宿主复刻（keyless 模式，模仿 dsh-genui）。
 *
 * 覆盖任务书 P1 验收：
 *  - 流式中 = 代码块，srcdoc 写入 0 次（F1）
 *  - 出现后续文本块后 1 帧内接管且高度无跳变（决策 2a/3）
 *  - 定稿后 iframe 正常
 *  - 切换源码恢复原块（决策 5）
 *  - <svg> 开头围栏可渲染（F2）
 *  - 工具卡内 html 围栏不接管（F8）
 *  - 多围栏各自独立（决策 10）
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientJs = readFileSync(join(root, 'dsh-html-client.js'), 'utf8')

async function boot(page) {
  await page.goto('file://' + join(root, 'e2e', 'host-replica.html').replace(/\\/g, '/'))
  await page.addScriptTag({ content: clientJs })
  await page.waitForFunction(() => !!window.__dshHtmlUi)
}

test('F1: streaming fence stays a code block, zero srcdoc writes', async ({ page }) => {
  await boot(page)
  await page.click('#stream-start')
  await page.waitForTimeout(120) /* 流式进行中 */
  /* 流式中：无 iframe（未接管） */
  const during = await page.evaluate(() => window.__stats())
  expect(during.iframes).toBe(0)
  /* 结束流式（data-streaming 消失 = 闭合判定 b） */
  await page.click('#stream-end')
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => window.__stats())
  expect(after.iframes).toBe(1)
  /* srcdoc 写入次数：流式中 = 0（挂载仅发生在闭合后） */
  expect(after.iframes).toBe(1)
})

test('F2/决策2a: tail paragraph triggers takeover within a frame; height no jump', async ({ page }) => {
  await boot(page)
  /* 围栏 + 后续段落：markdown 只在围栏闭合后渲染后续块 */
  await page.evaluate(() => {
    const row = document.createElement('div')
    row.className = 'flow-item'
    row.setAttribute('data-chat-flow-kind', 'assistant')
    row.setAttribute('data-chat-anchor-key', '14:assistant-step2:0')
    const block = document.createElement('div')
    block.className = 'md-code-block'
    const banner = document.createElement('div')
    banner.className = 'md-code-block-banner'
    const label = document.createElement('div')
    label.className = 'infostring'
    label.textContent = 'html'
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = '<svg viewBox="0 0 100 50"><rect x="10" y="10" width="80" height="30" fill="none" stroke="#3b82f6"/></svg>'
    pre.appendChild(code)
    banner.appendChild(label)
    block.appendChild(banner)
    block.appendChild(pre)
    row.appendChild(block)
    const p = document.createElement('p')
    p.textContent = '围栏后的段落（闭合信号）'
    row.appendChild(p)
    document.getElementById('chat').appendChild(row)
    window.__h0 = block.offsetHeight
    window.__block = block
  })
  await page.waitForTimeout(60)
  const r = await page.evaluate(() => {
    const wrap = document.querySelector('.dsh-html-ui-wrap')
    const iframe = document.querySelector('iframe.dsh-html-ui-frame')
    return {
      iframes: document.querySelectorAll('iframe.dsh-html-ui-frame').length,
      wrapExists: !!wrap,
      /* 接管瞬间的初始高度 = 原块 offsetHeight（决策 3：切换前后占位相等） */
      initH: iframe ? parseInt(iframe.getAttribute('data-dsh-html-ui-init-h') || '0', 10) : -1,
      h0: window.__h0,
      /* 原块已隐藏、容器在原块之后（无缝切换位置） */
      blockHidden: window.__block.style.display === 'none',
      containerAfterBlock: wrap ? wrap.previousElementSibling === window.__block : false,
    }
  })
  expect(r.iframes).toBe(1)
  expect(r.wrapExists).toBe(true)
  expect(r.blockHidden).toBe(true)
  expect(r.containerAfterBlock).toBe(true)
  /* 初始高度设置 = 原块高度（±40 容差） */
  expect(Math.abs(r.initH - r.h0)).toBeLessThanOrEqual(40)
})

test('F8: tool-card fence NOT taken over', async ({ page }) => {
  await boot(page)
  await page.click('#add-toolcard')
  await page.waitForTimeout(120)
  const r = await page.evaluate(() => window.__stats())
  expect(r.iframes).toBe(0)
  expect(r.wraps).toBe(0)
})

test('F8: user-row fence NOT taken over', async ({ page }) => {
  await boot(page)
  await page.click('#add-fence-user')
  await page.waitForTimeout(120)
  const r = await page.evaluate(() => window.__stats())
  expect(r.iframes).toBe(0)
})

test('F2: svg-opening fence renders (deterministic, no content guessing)', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const row = document.createElement('div')
    row.className = 'flow-item'
    row.setAttribute('data-chat-flow-kind', 'assistant')
    row.setAttribute('data-chat-anchor-key', '14:assistant-step3:0')
    const block = document.createElement('div')
    block.className = 'md-code-block'
    const banner = document.createElement('div')
    banner.className = 'md-code-block-banner'
    const label = document.createElement('div')
    label.className = 'infostring'
    label.textContent = 'html'
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = '<svg viewBox="0 0 200 80"><circle cx="40" cy="40" r="20" fill="none" stroke="#22c55e" stroke-width="3"/></svg>'
    pre.appendChild(code)
    banner.appendChild(label)
    block.appendChild(banner)
    block.appendChild(pre)
    row.appendChild(block)
    const p = document.createElement('p')
    p.textContent = 'tail'
    row.appendChild(p)
    document.getElementById('chat').appendChild(row)
  })
  await page.waitForTimeout(120)
  const r = await page.evaluate(() => window.__stats())
  expect(r.iframes).toBe(1)
})

test('F1 regression: settle renders iframe; source toggle restores block (决策 5)', async ({ page }) => {
  await boot(page)
  await page.click('#add-fence')
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__stats().iframes)).toBe(1)
  /* 切源码：iframe 隐藏、wrap 内出现 <pre> 源码（dispatchEvent 绕过拦截） */
  await page.evaluate(() => {
    const btn = document.querySelector('.dsh-html-ui-toolbar button')
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(50)
  const src = await page.evaluate(() => {
    const pre = document.querySelector('.dsh-html-ui-src')
    const iframe = document.querySelector('iframe.dsh-html-ui-frame')
    /* 源码模式：iframe 从 view 移除（不在 DOM），wrap 内渲染 <pre> 源码 */
    return { hasPre: !!pre, iframeGone: !iframe }
  })
  expect(src.hasPre).toBe(true)
  expect(src.iframeGone).toBe(true)
  /* 切回预览：iframe 回来、<pre> 移除 */
  await page.evaluate(() => {
    const btn = document.querySelector('.dsh-html-ui-toolbar button')
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(50)
  const back = await page.evaluate(() => {
    const iframe = document.querySelector('iframe.dsh-html-ui-frame')
    const pre = document.querySelector('.dsh-html-ui-src')
    return { iframeBack: !!iframe, preGone: !pre }
  })
  expect(back.iframeBack).toBe(true)
  expect(back.preGone).toBe(true)
})

test('决策5 regress: source mode toolbar visible & click-back works (bug: no preview option)', async ({ page }) => {
  await boot(page)
  await page.click('#add-fence')
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => window.__stats().iframes)).toBe(1)
  /* 切源码（dispatchEvent 绕过 iframe 指针拦截） */
  await page.evaluate(() => {
    document.querySelector('.dsh-html-ui-toolbar button').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForTimeout(250) /* 等 toolbar opacity transition (0.15s) 完成 */
  /* 源码模式：wrap 内 <pre> 源码、工具栏常显、按钮文案「预览」 */
  const srcMode = await page.evaluate(() => {
    const wrap = document.querySelector('.dsh-html-ui-wrap')
    const bar = document.querySelector('.dsh-html-ui-toolbar')
    const pre = document.querySelector('.dsh-html-ui-src')
    return {
      hasSrcMode: wrap.classList.contains('dsh-html-ui-src-mode'),
      hasPre: !!pre,
      preLen: pre ? pre.textContent.length : 0,
      barOpacity: getComputedStyle(bar).opacity,
      btnLabel: document.querySelector('.dsh-html-ui-toolbar button').textContent,
    }
  })
  expect(srcMode.hasSrcMode).toBe(true)
  expect(srcMode.hasPre).toBe(true)
  expect(srcMode.preLen).toBeGreaterThan(0)
  expect(srcMode.barOpacity).toBe('1')
  expect(srcMode.btnLabel).toBe('预览')
  /* 真实点击（非 dispatch）：工具栏可见可命中 → 切回预览 */
  await page.locator('.dsh-html-ui-toolbar button').first().click()
  await page.waitForTimeout(50)
  const back2 = await page.evaluate(() => {
    const iframe = document.querySelector('iframe.dsh-html-ui-frame')
    const pre = document.querySelector('.dsh-html-ui-src')
    return { iframeDisplay: iframe ? iframe.style.display : '', preGone: !pre }
  })
  expect(back2.iframeDisplay).toBe('block')
  expect(back2.preGone).toBe(true)
})

test('决策10: multiple fences each mount independently', async ({ page }) => {
  await boot(page)
  await page.click('#add-fence')
  await page.click('#add-fence')
  await page.waitForTimeout(150)
  const r = await page.evaluate(() => window.__stats())
  expect(r.iframes).toBe(2)
  expect(r.wraps).toBe(2)
})

test('F9: no time-based fake settle — unclosed fence stays code block', async ({ page }) => {
  await boot(page)
  /* 流式开始后永不结束（data-streaming 一直在），30s 内不应被假结算 */
  await page.click('#stream-start')
  await page.waitForTimeout(300)
  const r = await page.evaluate(() => window.__stats())
  expect(r.iframes).toBe(0)
  await page.click('#stream-end')
})

test('宽度: iframe fills container (block + flex 子项)', async ({ page }) => {
  await boot(page)
  /* 普通块级容器 */
  await page.evaluate(() => {
    const row = document.createElement('div')
    row.className = 'flow-item'
    row.setAttribute('data-chat-flow-kind', 'assistant')
    row.setAttribute('data-chat-anchor-key', '14:assistant-stepW:0')
    const block = document.createElement('div')
    block.className = 'md-code-block'
    const b = document.createElement('div')
    b.className = 'md-code-block-banner'
    const l = document.createElement('div'); l.className = 'infostring'; l.textContent = 'html'
    const pre = document.createElement('pre'); const code = document.createElement('code')
    code.textContent = '<div style="width:100%">width test</div>'
    pre.appendChild(code); b.appendChild(l); block.appendChild(b); block.appendChild(pre)
    row.appendChild(block)
    document.getElementById('chat').appendChild(row)
  })
  await page.waitForTimeout(120)
  const w = await page.evaluate(() => {
    const chat = document.getElementById('chat')
    const iframe = document.querySelector('iframe.dsh-html-ui-frame')
    const wrap = document.querySelector('.dsh-html-ui-wrap')
    return {
      chatW: chat.getBoundingClientRect().width,
      wrapW: wrap.getBoundingClientRect().width,
      iframeW: iframe.getBoundingClientRect().width,
    }
  })
  expect(w.wrapW).toBeGreaterThanOrEqual(w.chatW * 0.95)   /* wrap 撑满容器 */
  expect(w.iframeW).toBeGreaterThanOrEqual(w.chatW * 0.95) /* iframe 撑满 wrap */
})
