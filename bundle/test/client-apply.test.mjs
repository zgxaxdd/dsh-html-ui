// 客户端半边 apply() 冒烟测试：node test/client-apply.test.mjs
//
// 为什么需要它：load.test.mjs 只断言「注册了 id」与「factory 返回了带 apply 的对象」，
// 从不真正调用 apply()。于是 apply 内部的运行时错误（例如 ensurePolling 引用了嵌在
// start() 里的 tick → `tick is not defined`）能一路穿过 npm test 与 parity，
// 直到真实启动才炸成 "web boot: 1 entry did not activate / dsh-html-ui: failed"。
// 本测试用一个最小 DOM stub 真正跑一遍 apply()/dispose()。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "lib", "client.js"), "utf8");

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
};

/** 最小元素 stub：只实现 client.js 实际触碰的成员。 */
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    childNodes: [],
    children: [],
    attributes: {},
    isConnected: true,
    parentElement: null,
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.childNodes.push(c); this.children.push(c); if (c) c.parentElement = this; return c; },
    insertBefore(c) { return this.appendChild(c); },
    removeChild(c) { return c; },
    remove() { this.isConnected = false; },
    after() {},
    before() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ bottom: 0, top: 0, height: 0 }),
    focus() {},
    click() {},
    matches: () => false,
    set textContent(v) { this._text = v; },
    get textContent() { return this._text ?? ""; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html ?? ""; },
    get offsetHeight() { return 120; },
    get childElementCount() { return this.children.length; },
    get nextElementSibling() { return null; },
    get firstChild() { return this.childNodes[0] ?? null; },
  };
  return el;
}

const documentStub = {
  visibilityState: "visible",
  documentElement: makeEl("html"),
  head: makeEl("head"),
  body: makeEl("body"),
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  createDocumentFragment: () => makeEl("fragment"),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  execCommand: () => false,
  fonts: { ready: Promise.resolve() },
};

class ObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
}

// 定时器/动画帧给出有限预算并真的执行回调：这样 tick()/fullSweep()/sweep()/flushHeights()
// 这些只在异步路径里跑的代码也会被走到（tick 引用了嵌在 start() 里的函数这事故就发生在这一层）。
let timerBudget = 3;
let frameBudget = 3;
let asyncError = null;
const runBounded = (fn) => {
  try {
    fn();
  } catch (error) {
    asyncError = asyncError ?? error;
  }
};

const windowStub = {
  document: documentStub,
  navigator: { clipboard: null, userAgent: "test" },
  location: { href: "http://127.0.0.1/", origin: "http://127.0.0.1" },
  console,
  setTimeout: (fn) => { if (timerBudget-- > 0) runBounded(fn); return 1; },
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  requestAnimationFrame: (fn) => { if (frameBudget-- > 0) runBounded(fn); return 1; },
  cancelAnimationFrame: () => {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  MutationObserver: ObserverStub,
  IntersectionObserver: ObserverStub,
  ResizeObserver: ObserverStub,
  getComputedStyle: () => ({ backgroundColor: "", color: "" }),
  addEventListener() {},
  removeEventListener() {},
  URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
  Blob: class {},
  fetch: () => Promise.resolve({ ok: false, text: () => Promise.resolve("") }),
  open: () => null,
};

let registration = null;
windowStub.__ModuleLoader__ = { load(r) { registration = r; } };
windowStub.window = windowStub;

new Function(
  "window", "document", "navigator", "MutationObserver", "IntersectionObserver",
  "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "self", "globalThis",
  src,
)(windowStub, documentStub, windowStub.navigator, ObserverStub, ObserverStub, windowStub.requestAnimationFrame, windowStub.cancelAnimationFrame, windowStub.getComputedStyle, windowStub, windowStub);

ok("registration id", registration !== null && registration.id === "dsh-html-ui", registration && registration.id);

const plugin = registration.factory();
ok("factory returns apply", plugin && typeof plugin.apply === "function", Object.keys(plugin || {}).join(","));

// 假 cordis ctx：inject 回调里 get() 一律 undefined —— 正好走"未接主题/语言服务"的分支，
// 也就是 installScheduler + 各类监听器真正落地的那条路径。
const disposers = [];
const scope = {
  get: () => undefined,
  on: () => () => {},
  effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
};
const ctx = {
  inject(_names, cb) { cb(scope); return () => {}; },
  on: () => () => {},
  effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
  get: () => undefined,
};

let dispose = null;
let applyError = null;
try {
  dispose = plugin.apply(ctx);
} catch (error) {
  applyError = error;
}
ok("apply() does not throw", applyError === null, applyError ? `${applyError.name}: ${applyError.message}` : "");
ok("apply() returns a disposer", typeof dispose === "function", typeof dispose);
ok("scheduler ticks without throwing", asyncError === null, asyncError ? `${asyncError.name}: ${asyncError.message}` : "");

const kernel = windowStub.__dshHtmlUi;
ok("kernel exposed", !!kernel, typeof kernel);
if (kernel) {
  const stats = kernel.stats();
  ok("stats().version is 4", stats && stats.version === 4, JSON.stringify(stats && stats.version));
  ok("validate/repair exposed", typeof kernel.validate === "function" && typeof kernel.repair === "function");
  const receipt = kernel.validate("<div><section>a</section>");
  ok("kernel.validate works", receipt && receipt.ok === false && receipt.errors[0].code === "E-UNCLOSED", JSON.stringify(receipt && receipt.errors));
}

if (typeof dispose === "function") {
  let disposeError = null;
  try {
    dispose();
  } catch (error) {
    disposeError = error;
  }
  ok("dispose() does not throw", disposeError === null, disposeError ? `${disposeError.name}: ${disposeError.message}` : "");
}

console.log(fails === 0 ? "CLIENT APPLY PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
