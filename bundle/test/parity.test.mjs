// 双实现一致性测试：lib/validate.mjs 与 lib/client.js 内嵌 `src/validate.js` 必须逐用例产出相同回执。
// 修改规则后：改 lib/validate.mjs → node test/embed-validate.mjs → node test/parity.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as shared from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "lib", "client.js"), "utf8");
const pure = src.slice(src.indexOf("// src/pure.js"), src.indexOf("// src/validate.js"));
const val = src.slice(src.indexOf("// src/validate.js"), src.indexOf("// src/kernel.js"));
const factory = new Function(pure + "\n" + val + "\nreturn { validateRaw, looksLikeHtmlDoc, parseMeta, repairPrompt, repairHtml, DEFAULT_CONFIG };");
const embedded = factory();

const stable = (v) => {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
};

const cases = [
  "",
  "   ",
  "<div><p>hi</p><span>x</span></div><svg viewBox=\"0 0 1 1\"><line/></svg>",
  "<div><section><p>abc</section>",
  "<div>a</span></div>",
  "<ul><li>a<li>b<li>c</ul>",
  "<p>$$x < y$$ and $$a<b$$</p>",
  "\\[a < b\\]\n<div>ok</div>",
  '<div><script>fetch("http://x")</script></div>',
  '<script src="https://x/a.js"></script>',
  '<img src="https://x/a.png">',
  '<button onclick="x()">k</button>',
  "<div><p>a<p>b</div>",
  "<div><section>a<div>b</section></div>",
  "<div><style>a>b{color:red}</style><p>ok</p></div>",
  "<!-- <div> --><p>ok</p>",
  '<svg><g><circle cx="1" cy="1" r="1"/><rect width="2" height="2"/></g></svg>',
  "<div><iframe src=\"x\"></iframe></div>",
  '<!--dsh-html {"title":"测试"}-->\n<div>ok</div>',
  "<!--dsh-html {bad json}-->\n<div>ok</div>",
  "<!--dsh-html [1,2]}-->\n<div>ok</div>",
  '<!--dsh-html {"title":"t"}-->\n<div><script>fetch("x")</script></div>',
  "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
  "<div>" + "<p>x</p>".repeat(200) + "</div>",
  'x'.repeat(1024 * 1024 + 10),
  // v4 新规则用例
  "<!doctype html><html><body><p>ok</p></body></html>",
  "<div>" + "<p>x</p>\n".repeat(260) + "</div>",
  '<!--dsh-html {"full":true}-->\n' + "<div>" + "<p>x</p>\n".repeat(260) + "</div>",
  "<div><style>a{color:red}",
];

let fails = 0;
for (const raw of cases) {
  const a = shared.validateRaw(raw, shared.DEFAULT_CONFIG);
  const b = embedded.validateRaw(raw, embedded.DEFAULT_CONFIG);
  const same = stable(a) === stable(b);
  if (!same) {
    fails++;
    console.log("FAIL receipt mismatch for:", JSON.stringify(raw.slice(0, 60)));
    console.log("  shared :", stable(a));
    console.log("  embedded:", stable(b));
  }
  const la = shared.looksLikeHtmlDoc(raw);
  const lb = embedded.looksLikeHtmlDoc(raw);
  if (la !== lb) {
    fails++;
    console.log("FAIL looksLikeHtmlDoc mismatch:", la, lb);
  }
  const pa = stable(shared.repairPrompt(a));
  const pb = stable(embedded.repairPrompt(b));
  if (pa !== pb) {
    fails++;
    console.log("FAIL repairPrompt mismatch");
  }
  // v4：修复器双实现一致（含 repairs 明细）
  const fa = shared.repairHtml(raw, shared.DEFAULT_CONFIG);
  const fb = embedded.repairHtml(raw, embedded.DEFAULT_CONFIG);
  if (stable(fa) !== stable(fb)) {
    fails++;
    console.log("FAIL repairHtml mismatch for:", JSON.stringify(raw.slice(0, 60)));
    console.log("  shared :", stable(fa));
    console.log("  embedded:", stable(fb));
  }
}
console.log(fails === 0 ? `PARITY PASS (${cases.length} cases)` : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
