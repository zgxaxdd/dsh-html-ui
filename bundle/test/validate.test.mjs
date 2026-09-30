// v4 校验器回归测试：node test/validate.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "lib", "client.js"), "utf8");
const pure = src.slice(src.indexOf("// src/pure.js"), src.indexOf("// src/validate.js"));
const val = src.slice(src.indexOf("// src/validate.js"), src.indexOf("// src/kernel.js"));
const factory = new Function(pure + "\n" + val + "\nreturn { validateRaw, looksLikeHtmlDoc, parseMeta, repairPrompt, repairHtml, DEFAULT_CONFIG };");
const { validateRaw, looksLikeHtmlDoc, parseMeta, repairPrompt, repairHtml, DEFAULT_CONFIG } = factory();

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
};
const t = (name, raw, expect) => {
  const r = validateRaw(raw, DEFAULT_CONFIG);
  const codes = r.errors.map((e) => e.code).concat(r.warnings.map((w) => w.code)).sort();
  const want = [...expect].sort();
  ok(name, JSON.stringify(codes) === JSON.stringify(want), `codes=${JSON.stringify(codes)} want=${JSON.stringify(want)}`);
};

// --- 结构校验（v2 用例保持） ---
t("balanced", '<div><p>hi</p><span>x</span></div><svg viewBox="0 0 1 1"><line/></svg><path d="M0 0"/>', []);
t("unclosed", "<div><section><p>abc</section>", ["E-UNCLOSED"]);
t("stray", "<div>a</span></div>", ["E-STRAY-CLOSE"]);
t("optional-close", "<ul><li>a<li>b<li>c</ul>", []);
t("latex-lt", "<p>$$x < y$$ and $$a<b$$</p>", []);
t("latex-display", "\\[a < b\\]\n<div>ok</div>", []);
t("net-script", '<div><script>fetch("http://x")</script></div>', ["W-SCRIPT-NET"]);
t("ext-script", '<script src="https://x/a.js"></script>', ["W-SCRIPT-EXT"]);
t("ext-img", '<img src="https://x/a.png">', ["W-EXT-IMG"]);
t("inline-on", '<button onclick="x()">k</button>', ["W-INLINE-EVENT"]);
t("empty", "   ", ["E-EMPTY"]);
t("implicit-close", "<div><p>a<p>b</div>", []);
t("structural-implicit", "<div><section>a<div>b</section></div>", ["W-IMPLICIT-CLOSE"]);
t("raw-text-skip", "<div><style>a>b{color:red}</style><p>ok</p></div>", []);
t("comment-lt", "<!-- <div> --><p>ok</p>", []);
t("svg-stack", '<svg><g><circle cx="1" cy="1" r="1"/><rect width="2" height="2"/></g></svg>', []);

// --- v3 规则 ---
t("iframe", "<div><iframe src=\"x\"></iframe></div>", ["W-IFRAME"]);
t("meta-ok", '<!--dsh-html {"title":"测试"}-->\n<div>ok</div>', []);
t("meta-bad-json", "<!--dsh-html {bad json}-->\n<div>ok</div>", ["W-META-INVALID"]);
t("meta-not-object", "<!--dsh-html [1,2]-->\n<div>ok</div>", ["W-META-INVALID"]);
t("meta-with-script", '<!--dsh-html {"title":"t"}-->\n<div><script>fetch("x")</script></div>', ["W-SCRIPT-NET"]);

// --- v4 新规则 ---
t("skeleton-doctype", "<!doctype html><html><body><p>ok</p></body></html>", ["W-DOCTYPE"]);
t("skeleton-head", "<head><style>a{color:red}</style></head><div>ok</div>", ["W-DOCTYPE"]);
t("line-limit", "<div>" + "<p>x</p>\n".repeat(260) + "</div>", ["W-LINE-LIMIT"]);
t("line-limit-full-page", '<!--dsh-html {"full":true}-->\n' + "<div>" + "<p>x</p>\n".repeat(260) + "</div>", []);
t("line-limit-full-page-cap", '<!--dsh-html {"full":true}-->\n' + "<div>" + "<p>x</p>\n".repeat(510) + "</div>", ["W-LINE-LIMIT"]);

// --- v4 诊断携带行号 ---
const r2 = validateRaw("<div>\n<section>a</section>", DEFAULT_CONFIG);
ok("detail.has-line", r2.errors.length === 1 && /^div@L1$/.test(r2.errors[0].detail), JSON.stringify(r2.errors));

// --- 回执结构（ruleSet / fix / meta / stats / lines） ---
const r1 = validateRaw("<div><section>a</section>", DEFAULT_CONFIG);
ok("receipt.ruleSet", r1.ruleSet === 4, String(r1.ruleSet));
ok("receipt.items.carry.fix", r1.errors.concat(r1.warnings).every((it) => it.code && it.fix && typeof it.detail === "string"), JSON.stringify(r1.errors));
ok("receipt.stats", Number.isInteger(r1.stats.bytes) && Number.isInteger(r1.stats.tags) && Number.isInteger(r1.lines), JSON.stringify(r1.stats));
const m = parseMeta('<!--dsh-html {"title":"公差表","extra":1}-->\nx');
ok("parseMeta.value", m.found && m.value.title === "公差表" && m.value.extra === 1, JSON.stringify(m));
ok("parseMeta.absent", parseMeta("<div>x</div>").found === false);

// --- repairPrompt：回执 → 模型可读修复提示（v4 附带修复版源码） ---
const prompt = repairPrompt(r1);
ok("repairPrompt", prompt.includes("E-UNCLOSED") && prompt.includes("补上配对的闭合标签"), prompt.split("\n")[1] || "");
const prompt2 = repairPrompt(r1, "<div>ok</div>");
ok("repairPrompt.with-repaired", prompt2.includes("```html") && prompt2.includes("<div>ok</div>"));

// --- repairHtml：可修复错误自动产出修复版源码 ---
const f1 = repairHtml("<div><section><p>abc</section>", DEFAULT_CONFIG);
ok("repair.unclosed.repairable", f1.repairable === true && f1.text && f1.text.includes("</div>"), JSON.stringify(f1.repairs));
ok("repair.unclosed.fixed", f1.text ? validateRaw(f1.text, DEFAULT_CONFIG).ok : false);
const f2 = repairHtml("<div>a</span></div>", DEFAULT_CONFIG);
ok("repair.stray.repairable", f2.repairable === true && f2.text === "<div>a</div>", JSON.stringify(f2.text));
const f3 = repairHtml("<div><style>a{color:red}", DEFAULT_CONFIG);
ok("repair.raw-text.repairable", f3.repairable === true && f3.text === "<div><style>a{color:red}</style></div>", JSON.stringify(f3.text));
ok("repair.raw-text.fixed", f3.text ? validateRaw(f3.text, DEFAULT_CONFIG).ok : false);
const f4 = repairHtml("<div>ok</div>", DEFAULT_CONFIG);
ok("repair.noop", f4.repairable === false && f4.text === null && f4.repairs.length === 0);
const f5 = repairHtml("", DEFAULT_CONFIG);
ok("repair.empty.unrecoverable", f5.repairable === false && f5.unrecoverable.includes("E-EMPTY"));
const f6 = repairHtml("x".repeat(1024 * 1024 + 10), DEFAULT_CONFIG);
ok("repair.oversize.unrecoverable", f6.repairable === false && f6.unrecoverable.includes("E-SIZE"));
const f7 = repairHtml("<div>\n<section>a</section>", DEFAULT_CONFIG);
ok("repair.line-ref", f7.repairs.some((s) => /append-close:div@L1/.test(s)), JSON.stringify(f7.repairs));

// --- looksLikeHtmlDoc 仍可用（v4 白名单回退之外的结构识别） ---
ok("looksLikeHtmlDoc", looksLikeHtmlDoc("<!doctype html><html><body>x</body></html>") === true && looksLikeHtmlDoc("<div>ok</div>") === false);

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
