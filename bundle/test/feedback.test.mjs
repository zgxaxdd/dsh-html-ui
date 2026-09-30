// v4 围栏自修反馈环纯函数测试：node test/feedback.test.mjs
// 只测不依赖宿主的部分：围栏抽取 / 指纹 / 失败诊断 / 修正文本 / 规划器 / 标记识别。
import {
  extractHtmlFences,
  fenceFingerprint,
  fenceFailures,
  fenceCorrectionText,
  createFeedbackMessage,
  planFenceFeedback,
  markersIn,
  isFeedbackSource,
  MARKER_PREFIX,
} from "../lib/feedback.mjs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
};

// --- 围栏抽取 ---
const reply = [
  "开头文字",
  "```html",
  "<div>ok</div>",
  "```",
  "中间文字",
  "   ```dsh-html",
  "<div>bad</section>", // 多余闭合（不可渲染）
  "```",
  "```html-render",
  "<div>unclosed",
].join("\n");
const fences = extractHtmlFences(reply);
ok("extract.count", fences.length === 3, String(fences.length));
ok("extract.labels", fences[0].raw === "<div>ok</div>" && fences[1].raw.includes("</section>") && fences[2].raw === "<div>unclosed", JSON.stringify(fences.map((f) => f.raw)));
ok("extract.closed", fences[0].closed === true && fences[2].closed === false);
ok("extract.index", fences.map((f) => f.index).join(",") === "1,2,3");

// 只认 info string 恰为目标语言；其他围栏/缩进散文不被抽取
const notOurs = [
  "```js",
  "const a = 1",
  "```",
  "```html-dark",
  "<div>x</div>",
  "```",
  "    ```html", // 4 空格缩进 = 代码块，不是围栏行
  "<div>y</div>",
  "```",
  "这里提到 ```html 也不该触发",
].join("\n");
ok("extract.exact-match-only", extractHtmlFences(notOurs).length === 0);

// 单条回复围栏数上限
ok("extract.max-fences", extractHtmlFences(("<p>a</p>\n```\n").repeat(80)).length <= 40);

// --- 指纹 ---
ok("fingerprint.stable", fenceFingerprint(" <div>a</div> ") === fenceFingerprint("<div>a</div>"));
ok("fingerprint.differs", fenceFingerprint("<div>a</div>") !== fenceFingerprint("<div>b</div>"));

// --- 失败诊断 ---
// 回复含 3 个围栏：第 1 个健康；第 2 个（dsh-html）有多余闭合；第 3 个（html-render）未闭围栏。
const failures = fenceFailures(reply);
ok("failures.count", failures.length === 2, JSON.stringify(failures.map((f) => f.index)));
ok("failures.indexes", failures.map((f) => f.index).join(",") === "2,3");
ok("failures.detail", failures[0].detail.includes("E-STRAY-CLOSE") && failures[0].detail.includes("为其补配对"), failures[0].detail);
ok("failures.repaired", failures[0].repaired === "<div>bad</div>", JSON.stringify(failures[0].repaired));
const unclosedReply = "```html\n<div>abc";
const unclosedFailures = fenceFailures(unclosedReply);
ok("failures.unterminated", unclosedFailures.length === 1 && unclosedFailures[0].detail.includes("unterminated_fence"));
ok("failures.healthy-silent", fenceFailures("```html\n<div>ok</div>\n```").length === 0);

// --- 修正文本 ---
const text = fenceCorrectionText(failures);
ok("correction.marker", text.includes(MARKER_PREFIX + failures[0].fingerprint + "]") && text.includes(MARKER_PREFIX + failures[1].fingerprint + "]"));
ok("correction.protocol", text.includes("[dsh-html-fence-repair]") && text.includes("status=render_failed") && text.includes("next=resend_corrected_fence_only"));
ok("correction.repaired", text.includes("```html\n<div>bad</div>\n```"));
ok("correction.position-rule", text.includes("fence_position=reply_body_not_reasoning"));

// --- 消息构造（与宿主 createUserMessage 形状一致） ---
const msg = createFeedbackMessage(text, 4);
ok("message.shape", msg.role === "user" && Array.isArray(msg.content) && msg.content[0].type === "text" && msg.content[0].text === text);
ok("message.frozen", Object.isFrozen(msg) && Object.isFrozen(msg.content));
ok("message.source.v4", msg.source.kind === "plugin:dsh-html-ui" && msg.source.form === "notice");
const legacy = createFeedbackMessage(text, 3);
ok("message.source.legacy", legacy.source.kind === "plugin" && legacy.source.plugin === "dsh-html-ui");
ok("message.source.default", createFeedbackMessage(text).source.plugin === "dsh-html-ui");

// --- 标记识别 ---
ok("markers.roundtrip", JSON.stringify(markersIn(text)) === JSON.stringify(failures.map((f) => f.fingerprint)));
ok("markers.legacy", markersIn("[dsh-html 自修 #abc123]").join("") === "abc123");
ok("markers.none", markersIn("no markers here").length === 0);
ok("source.current", isFeedbackSource({ kind: "plugin:dsh-html-ui" }) === true);
ok("source.legacy", isFeedbackSource({ kind: "plugin", plugin: "dsh-html-ui" }) === true);
ok("source.other", isFeedbackSource({ kind: "plugin", plugin: "someone-else" }) === false);

// --- 规划器边界 ---
const base = { text: reply, turn: 3, lastCorrectedTurn: undefined, corrected: new Set(), aborted: false };
const plan = planFenceFeedback(base);
ok("plan.fires", plan !== null && plan.turn === 3 && plan.fingerprints.length === 2, JSON.stringify(plan && plan.fingerprints));
ok("plan.once-per-turn", planFenceFeedback({ ...base, lastCorrectedTurn: 3 }) === null);
ok("plan.once-per-fence", planFenceFeedback({ ...base, corrected: new Set(plan.fingerprints) }) === null);
ok("plan.aborted", planFenceFeedback({ ...base, aborted: true }) === null);
ok("plan.empty", planFenceFeedback({ ...base, text: "   " }) === null);
ok("plan.healthy", planFenceFeedback({ ...base, text: "```html\n<div>ok</div>\n```" }) === null);
ok("plan.subagent-safe", plan !== null);

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
