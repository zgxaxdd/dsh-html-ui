/**
 * dsh-html-ui v1.0.0 — L2 观察接管器（P1）
 *
 * F2/F5/F8/F9 的对策落点：
 *  - F2：确定性触发 —— 只认 label（html/dsh-html，或 requireMarker 时
 *    html-render/dsh-html），assistant 行内一律接管，零内容猜测；
 *  - F5：闭合判定不读内容（决策 2a 看结构）；内容只在接管时刻读一次；
 *    sweep 只复查"自上次扫描以来子树发生过变更的块"（observer 记录
 *    变更目标并向上定位到代码块），保留 1s 兜底扫描；
 *  - F8：只接管 assistant 消息行内的围栏（closest('[data-chat-anchor-key]')
 *    且锚点/kind 标识 assistant；用户行、工具卡内永不接管）；
 *  - F9：渲染前提恒为"围栏已闭合"（结构判定，决策 2 a/b/c 三档），
 *    取消基于时间的假结算。
 *
 * 接管是单调的，不撤销（决策 2 末尾：append-only 流上闭合判定安全）。
 */
import { wantsTakeoverRaw, isVisibleContentBlock, fnv1a32 } from './pure.js'

const PROCESSED = 'data-dsh-html-ui'
const CODE_SELECTORS = '.md-code-block, .code-block, .code-block-small'
const STREAMING = '[data-streaming]'
const SWEEP_MS = 1000
const SURFACE_HOPS = 4
const BLOCK_CONTENT_SELECTOR =
  'p, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, blockquote, hr, img, figure'

export function installScheduler(kernel, options = {}) {
  var win = options.window || window
  var doc = options.document || win.document
  var config = kernel.config || {}
  var getLabel = options.getLabel || labelTextOf

  var mounts = new Map()        // block -> kernel mount
  var changedBlocks = new Set() // F5：observer 记录的变更目标（向上定位）
  var settleState = new Map()   // block -> { lastHash, noChangeStreak }（决策 2c）
  var disposed = false
  var rafId = null
  var intervalId = null
  var mo = null

  /* ------------------------------------------------------------------ *
   * 基础 DOM 工具
   * ------------------------------------------------------------------ */
  function rawOf(block) {
    var pre = block.querySelector('pre')
    if (!pre) return ''
    var text = ''
    for (var i = 0; i < pre.childNodes.length; i++) text += pre.childNodes[i].textContent || ''
    return text
  }

  /* 横幅语言标签：代码体外第一个叶子元素文本（流式中可能为空）。 */
  function labelTextOf(block) {
    var pre = block.querySelector('pre')
    var els = block.querySelectorAll('*')
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el.childElementCount !== 0) continue
      if (pre && pre.contains(el)) continue
      return el.textContent || ''
    }
    return ''
  }

  /* 只含「横幅 + 一个代码体」的才是围栏表面；含段落/多代码体的整行容器
   * 绝不接管（否则会隐藏整条回复）。 */
  function isPlausibleFenceSurface(candidate) {
    var pres = candidate.querySelectorAll('pre')
    if (pres.length > 1) return false
    var pre = pres[0] || null
    var els = candidate.querySelectorAll(BLOCK_CONTENT_SELECTOR)
    for (var i = 0; i < els.length; i++) {
      if (pre && pre.contains(els[i])) continue
      return false
    }
    return true
  }

  /* F8：仅 assistant 消息行内的围栏。
   * data-chat-anchor-key = routedNode.key（如 "14:assistant-step3:0"），
   * data-chat-flow-kind = user/assistant/steering…。两者任一带 assistant
   * 语义即通过；工具卡（tool 行）与用户行被排除。 */
  function isAssistantRow(block) {
    var row = block.closest('[data-chat-anchor-key]')
    if (row) {
      var anchor = row.getAttribute('data-chat-anchor-key') || ''
      if (anchor.indexOf('assistant') !== -1) return true
    }
    var kind = block.closest('[data-chat-flow-kind]')
    if (kind) {
      var k = kind.getAttribute('data-chat-flow-kind') || ''
      if (k === 'assistant') return true
    }
    /* 无任何行锚点/kind：不接管（无法确证是 assistant 行） */
    return false
  }

  /* 完整候选发现（兜底全扫用）。 */
  function findFenceCandidates() {
    var seen = new Set()
    var out = []
    var els = doc.querySelectorAll(CODE_SELECTORS)
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el.parentElement && el.parentElement.closest && el.parentElement.closest(CODE_SELECTORS)) continue
      if (seen.has(el)) continue
      if (!isPlausibleFenceSurface(el)) continue
      out.push(el)
      seen.add(el)
    }
    /* 结构性兜底：任何「pre + 标签为 html/dsh-html 的祖先」也可被识别 */
    var pres = doc.querySelectorAll('pre')
    for (var j = 0; j < pres.length; j++) {
      var pre = pres[j]
      if (pre.closest && pre.closest(CODE_SELECTORS)) continue
      var el2 = pre.parentElement
      for (var hops = 0; el2 && hops < SURFACE_HOPS; hops++, el2 = el2.parentElement) {
        if (!isPlausibleFenceSurface(el2)) break
        var lbl = labelTextOf(el2)
        if (lbl !== 'html' && lbl !== 'dsh-html' && lbl !== 'html-render') continue
        if (seen.has(el2)) continue
        seen.add(el2)
        out.push(el2)
        break
      }
    }
    return out
  }

  /* F5：从变更目标定位到代码块表面（observer 记录用）。
   * 只接受"目标自身或其后代是代码表面"——绝不向上爬到祖先（否则会把
   * 包含围栏的整条消息行误判为围栏，隐藏整条回复；dsh-genui issue#13/#19
   * 教训）。结构性兜底仅限 pre 节点（未知宿主形态下 pre 可能是围栏体）。 */
  function blockOf(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement)
    if (!el) return null
    var found = el.closest ? el.closest(CODE_SELECTORS) : null
    if (found && isPlausibleFenceSurface(found)) return found
    /* 仅当目标是 pre 且不在已知表面内：向上找带 html 标签的祖先 */
    if (el.tagName === 'PRE' && !el.closest(CODE_SELECTORS)) {
      var cur = el
      for (var hops = 0; cur && hops < SURFACE_HOPS; hops++, cur = cur.parentElement) {
        if (!isPlausibleFenceSurface(cur)) continue
        var lbl = labelTextOf(cur)
        if (lbl === 'html' || lbl === 'dsh-html' || lbl === 'html-render') return cur
      }
    }
    return null
  }

  /* ------------------------------------------------------------------ *
   * 闭合判定（决策 2，按优先级 a > b > c）：
   *  a. 代码块的下一个元素兄弟是渲染可见的内容块（结构判定，不读内容）；
   *  b. 所在消息行的 [data-streaming] 属性消失；
   *  c. 宿主无 data-streaming 时的降级：连续 2 次 sweep 内容无变化
   *     且无新的字符变更事件。
   * 返回 { closed, via }
   * ------------------------------------------------------------------ */
  function isClosed(block, state) {
    /* a. 下一个兄弟是可见内容块（markdown 只在围栏闭合后才渲染后续块） */
    var next = block.nextElementSibling
    if (next && isVisibleContentBlock(next)) return { closed: true, via: 'next-block' }

    /* b. 行内 data-streaming 消失 */
    var streaming = block.closest(STREAMING)
    if (!streaming) return { closed: true, via: 'streaming-gone' }

    /* c. 降级：无 data-streaming 属性可见时（宿主 DOM 漂移），连续 2 次
     * 无内容变化且无字符变更事件视为闭合（F9：不设时间假结算）。 */
    var hash = fnv1a32(rawOf(block))
    if (!state) state = { lastHash: hash, noChangeStreak: 0, charDirty: true }
    if (state.charDirty) {
      state.charDirty = false
      state.lastHash = hash
      state.noChangeStreak = 0
      return { closed: false, via: 'streaming', state }
    }
    if (hash === state.lastHash) {
      state.noChangeStreak++
      if (state.noChangeStreak >= 2) return { closed: true, via: 'no-change', state }
    } else {
      state.lastHash = hash
      state.noChangeStreak = 0
    }
    return { closed: false, via: 'streaming', state }
  }

  /* ------------------------------------------------------------------ *
   * 接管 / 卸载
   * ------------------------------------------------------------------ */
  function takeOver(block, raw) {
    if (mounts.has(block)) return
    /* 降级矩阵（决策 8）：>1MB 仅源码视图 mount（kernel 侧支持） */
    if (raw.length > config.maxBytes) {
      kernel.mountBlock(block, raw, { height: block.offsetHeight, sourceOnly: true })
      mounts.set(block, true)
      return
    }
    var h = block.offsetHeight || 180
    var mount = kernel.mountBlock(block, raw, { height: h })
    if (!mount) {
      /* 接管失败（决策 8：立即还原，绝不隐藏原块） */
      console.warn('[dsh-html-ui] 围栏接管失败，保留原生代码块。')
      return
    }
    mounts.set(block, mount)
  }

  function unmountBlock(block) {
    var m = mounts.get(block)
    if (!m) return
    mounts.delete(block)
    kernel.unmountBlock(block)
  }

  /* ------------------------------------------------------------------ *
   * sweep（F5：只复查变更过的块 + 1s 全扫兜底）
   * ------------------------------------------------------------------ */
  function processBlock(block) {
    if (disposed || !block || !block.isConnected) return
    if (kernel.hasMount(block)) {
      /* 已接管：修复手术（决策 9）——容器被宿主重渲染移出时在 observer
       * 微任务内重钉回原位。sweep 是兜底。 */
      repairSurgery(block)
      return
    }
    if (!isAssistantRow(block)) return   // F8
    var label = getLabel(block)
    if (!wantsTakeoverRaw(label, '', config)) return  // F2：label 门
    var raw = rawOf(block)               // F5：内容只在接管时刻读一次
    if (raw.trim() === '') return
    var state = settleState.get(block)
    var verdict = isClosed(block, state)
    if (state) settleState.set(block, verdict.state || state)
    if (!verdict.closed) return          // F9：未闭合不渲染（保持源码高亮）
    settleState.delete(block)
    takeOver(block, raw)
  }

  function repairSurgery(block) {
    var m = mounts.get(block)
    if (!m) return
    var container = m.container
    if (!block.isConnected) {
      unmountBlock(block)
      return
    }
    if (container && container.isConnected) {
      if (container.parentElement !== block.parentElement || container.previousElementSibling !== block) {
        block.after(container)
      }
      return
    }
    /* 容器掉了但 block 活着 → 重新接管（保持不隐藏原块原则） */
    mounts.delete(block)
    var raw = rawOf(block)
    if (raw.trim() !== '') takeOver(block, raw)
  }

  function sweep() {
    if (disposed) return
    if (doc.visibilityState === 'hidden') return
    /* 1) 已接管：修复手术（sweep 兜底，主路径在 observer 微任务） */
    for (var b of Array.from(mounts.keys())) {
      try { repairSurgery(b) } catch (e) { kernel._dbg ? kernel._dbg(e) : 0 }
    }
    /* 2) 变更驱动：只复查 observer 记录的块（F5） */
    if (changedBlocks.size > 0) {
      var items = Array.from(changedBlocks)
      changedBlocks.clear()
      for (var i = 0; i < items.length; i++) {
        try { processBlock(items[i]) } catch (e) { /* 单块异常不阻断 */ }
      }
    }
  }

  function fullSweep() {
    if (disposed) return
    var candidates = findFenceCandidates()
    for (var i = 0; i < candidates.length; i++) {
      try { processBlock(candidates[i]) } catch (e) {}
    }
  }

  function schedule() {
    if (disposed || rafId !== null) return
    rafId = win.requestAnimationFrame(function () {
      rafId = null
      if (disposed) return
      sweep()
    })
  }

  /* ------------------------------------------------------------------ *
   * 观察器 + 兜底
   * ------------------------------------------------------------------ */
  function start() {
    mo = new MutationObserver(function (muts) {
      if (disposed) return
      var touched = false
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i]
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var an = m.addedNodes[j]
            if (an.nodeType !== 1) continue
            var blk = blockOf(an)
            if (blk) { changedBlocks.add(blk); touched = true }
            else {
              /* 新节点含代码块后代（宿主批量渲染） */
              var subs = an.querySelectorAll ? an.querySelectorAll(CODE_SELECTORS) : []
              for (var k = 0; k < subs.length; k++) {
                var sb = blockOf(subs[k])
                if (sb) { changedBlocks.add(sb); touched = true }
              }
            }
          }
          for (var j2 = 0; j2 < m.removedNodes.length; j2++) {
            var rn = m.removedNodes[j2]
            if (rn.nodeType !== 1) continue
            /* 已接管块被移除 → 卸载 */
            if (mounts.has(rn)) { unmountBlock(rn); touched = true; continue }
            var rm = rn.querySelectorAll ? rn.querySelectorAll('[' + PROCESSED + ']') : []
            for (var k2 = 0; k2 < rm.length; k2++) {
              var rb = rm[k2]
              if (mounts.has(rb)) { unmountBlock(rb); touched = true }
            }
            /* 容器被 React 移出但 block 还在 → 标记变更（修复手术） */
            if (rn.classList && rn.classList.contains('dsh-html-ui-wrap')) {
              for (var mm of mounts) {
                if (mm[1] && mm[1].container === rn) {
                  changedBlocks.add(mm[0]); touched = true
                }
              }
            }
          }
        } else if (m.type === 'attributes' && m.attributeName === 'data-streaming') {
          var t = blockOf(m.target)
          if (t) { changedBlocks.add(t); touched = true }
        } else if (m.type === 'characterData') {
          /* F5：字符变更 → 标记所在块（闭合判定 c 用 charDirty） */
          var blk2 = blockOf(m.target)
          if (blk2) {
            var st = settleState.get(blk2)
            if (st) st.charDirty = true
            changedBlocks.add(blk2)
            touched = true
          }
        }
      }
      if (touched) schedule()
    })
    mo.observe(doc.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['data-streaming'],
      characterData: true,
    })
    /* 初始全扫（页面刚加载/首屏批量渲染） */
    fullSweep()
    /* 1s 兜底（决策 9：保留；F5：不作为主路径） */
    intervalId = win.setInterval(function () {
      if (disposed || doc.visibilityState === 'hidden') return
      fullSweep()
    }, SWEEP_MS)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (mo) mo.disconnect()
    if (intervalId) win.clearInterval(intervalId)
    if (rafId !== null) win.cancelAnimationFrame(rafId)
    for (var b of Array.from(mounts.keys())) {
      try { kernel.unmountBlock(b) } catch (e) {}
    }
    mounts.clear()
    changedBlocks.clear()
    settleState.clear()
  }

  start()
  return dispose
}
