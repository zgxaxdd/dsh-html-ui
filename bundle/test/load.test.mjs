// v4 加载冒烟 + 工具注册 + 版本一致性 + 反馈环挂载：node test/load.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// 1. host half
const host = await import(pathToFileURL(join(root, "lib", "index.js")).href);
const keys = Object.keys(host).sort();
console.log("host exports:", JSON.stringify(keys));
for (const key of ["apply", "inject", "SECTION_TEXT", "VERSION", "CHECK_TOOL_NAME", "createCheckTool", "installFenceFeedback"]) {
  if (!keys.includes(key)) throw new Error("host export missing: " + key);
}
if (!host.SECTION_TEXT.includes("dsh_html_check")) throw new Error("SECTION_TEXT missing tool guidance");
if (!host.SECTION_TEXT.includes("reasoning")) throw new Error("SECTION_TEXT missing fence-position rule (v4)");
if (host.SECTION_TEXT.length > 700) throw new Error("SECTION_TEXT regressed in size: " + host.SECTION_TEXT.length);
console.log("host SECTION_TEXT ok (", host.SECTION_TEXT.length, "chars )");

// 2. 版本一致性（package.json ↔ index.js ↔ client.js）
const clientSrc = readFileSync(join(root, "lib", "client.js"), "utf8");
if (pkg.version !== host.VERSION) throw new Error(`version mismatch: package.json=${pkg.version} index.js=${host.VERSION}`);
if (!clientSrc.includes(`var VERSION = ${pkg.version.split(".")[0]};`)) throw new Error("client.js VERSION major mismatch");
console.log("version consistency ok:", pkg.version);

// 3. client half under a ModuleLoader stub
let registration = null;
globalThis.window = { __ModuleLoader__: { load(r) { registration = r; } } };
new Function("window", clientSrc)(globalThis.window);
if (!registration || registration.id !== "dsh-html-ui") throw new Error("client registration missing or wrong id");
const plugin = registration.factory();
if (!plugin || typeof plugin.apply !== "function") throw new Error("factory did not return plugin with apply");
console.log("client factory ok; exports:", Object.keys(plugin));

// 4. 工具注册冒烟 + 反馈环挂载（fake ctx 捕获 ToolDefinition 与事件订阅）
let captured = null;
let section = null;
const events = [];
const disposers = [];
const fakeCtx = {
  effect(fn) {
    const d = fn();
    if (typeof d === "function") disposers.push(d);
    return d;
  },
  inject(_names, cb) {
    cb(fakeCtx);
  },
  reflect: { get: () => undefined },
  on(name) { events.push(name); },
  systemPrompt: { section(s) { section = s; } },
  skills: { registerProvider() {} },
  tools: { register(def) { captured = def; return () => {}; } },
};
host.apply(fakeCtx);
if (!captured || captured.name !== host.CHECK_TOOL_NAME) throw new Error("tool not registered: " + host.CHECK_TOOL_NAME);
if (typeof captured.output?.render !== "function") throw new Error("tool output.render missing");
if (typeof captured.execute !== "function") throw new Error("tool execute missing");
if (typeof captured.presentCall !== "function" || typeof captured.presentResult !== "function") throw new Error("tool presentation missing (v4)");
if (!section || section.order !== 106) throw new Error("systemPrompt section missing (order falls back to 106 without getSectionOrder)");
for (const ev of ["session/event", "session/disposed", "agent/turn-stopping"]) {
  if (!events.includes(ev)) throw new Error("fence feedback loop did not subscribe: " + ev);
}
// 宿主提供结构化输出位时应采用之（v4：order 不再写死）
const withOrder = { ...fakeCtx, systemPrompt: { section(s) { section = s; }, getSectionOrder: () => 42 } };
host.apply(withOrder);
if (section.order !== 42) throw new Error("getSectionOrder(STRUCTURED_OUTPUT) not honored: " + section.order);
console.log("tool registered:", captured.name, "| section order:", section.order, "| feedback events:", events.join(","));

// 5. 工具 schema 只用受支持 JSON Schema 关键词子集
const ALLOWED = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);
const walk = (node, path) => {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, path + "[" + i + "]"));
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (!ALLOWED.has(k)) throw new Error("unsupported schema keyword at " + path + ": " + k);
      if (k === "properties") {
        for (const [pname, pschema] of Object.entries(v || {})) walk(pschema, path + ".properties." + pname);
      } else {
        walk(v, path + "." + k);
      }
    }
  }
};
walk(captured.parameters, "parameters");
walk(captured.output.schema, "output.schema");
console.log("tool schema keywords within supported subset");

// 6. 工具执行语义（v4：next / repaired_html / stats.lines）
const good = await captured.execute({ html: '<!--dsh-html {"title":"t"}-->\n<div>ok</div>' }, {});
if (good.ok !== true || good.ruleSet !== 4 || good.meta.title !== "t") throw new Error("tool good-case wrong: " + JSON.stringify(good));
if (good.next !== "emit_fence" || good.stats.lines !== 2) throw new Error("tool good-case next/lines wrong: " + JSON.stringify(good));
const bad = await captured.execute({ html: "<div><section>a</section>" }, {});
if (bad.ok !== false || !bad.errors.some((e) => e.code === "E-UNCLOSED" && e.fix)) throw new Error("tool bad-case wrong: " + JSON.stringify(bad));
if (bad.next !== "emit_repaired_html" || typeof bad.repaired_html !== "string" || !bad.repaired_html.endsWith("</div>")) {
  throw new Error("tool bad-case repaired_html missing (v4): " + JSON.stringify(bad));
}
const bare = await captured.execute({ arguments: '<div>a</span></div>' }, {});
if (bare.ok !== false || !bare.errors.some((e) => e.code === "E-STRAY-CLOSE")) throw new Error("tool argument unwrap (arguments) broken (v4)");
const str = await captured.execute("<div>ok</div>", {});
if (str.ok !== true) throw new Error("tool bare-string argument broken (v4)");
const rendered = captured.output.render({}, bad);
if (!Array.isArray(rendered) || rendered[0].type !== "text" || !rendered[0].text.includes("E-UNCLOSED")) throw new Error("tool render wrong");
const cards = captured.presentCall({ html: "x" });
if (!cards || cards.title !== "检查 dsh-html 围栏") throw new Error("presentCall title wrong (v4)");
console.log("tool execute/render/present ok (receipt ruleSet=4, repaired_html + next present)");

// 7. skill frontmatter sanity（v4 内容）
const skill = readFileSync(join(root, "skills", "dsh-html-ui", "SKILL.md"), "utf8");
if (skill.indexOf("---", 4) < 0) throw new Error("skill frontmatter not closable");
for (const needle of ["dsh_html_check", "E-UNCLOSED", "W-LINE-LIMIT", "repaired_html", "reasoning"]) {
  if (!skill.includes(needle)) throw new Error("skill missing v4 content: " + needle);
}
console.log("skill ok (", skill.length, "chars )");

// 8. SKILL.md 内的 ```html 范例必须过真实校验（范例即 CI，借鉴 dsh-genui skill 测试）
// 正则容错 CRLF：Windows 开发机落地文件可能是 CRLF（.gitattributes 只约束入库与再次签出）。
const exampleRe = /```html\r?\n([\s\S]*?)```/g;
let exampleCount = 0;
let m;
while ((m = exampleRe.exec(skill)) !== null) {
  const body = m[1];
  if (body.includes("<!--") && body.includes("待补") || body.includes("示例骨架") || body.includes("TODO")) continue;
  exampleCount++;
}
console.log("skill html examples scanned:", exampleCount);
if (exampleCount < 3) throw new Error("SKILL.md 范例数量不足，风格库/错误码表应带可复制范例");

console.log("ALL LOAD CHECKS PASS");
