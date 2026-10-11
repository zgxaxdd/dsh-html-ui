// 围栏抽取边界测试：node test/fence.test.mjs
//
// 历史缺陷（本套用例锁死）：
//  - CRLF/CR 行尾让按行匹配整体失效 → CRLF 回复里的围栏一个都抽不到，自修环静默跳过；
//  - 只认三反引号 → ```` ```html `` 这类合法围栏抽不到，且"围栏里示范围栏"会被内层
//    三反引号提前截断；
//  - 标记白名单在客户端 / 自修环两处各写一份 → html-render 判据曾经打架。
import { HTML_FENCE_MARKERS } from "../lib/validate.mjs";
import { extractHtmlFences, fenceFingerprint } from "../lib/feedback.mjs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " -> " + extra : ""}`);
};

const BT = "`".repeat(3);
const wrap = (nl, info, body, fence = BT) => `前言${nl}${fence}${info}${nl}${body}${nl}${fence}${nl}后记`;

// --- 行尾归一化 ---
for (const [name, nl] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
  const fences = extractHtmlFences(wrap(nl, "html", "<div>a</div>"));
  ok(`extract ${name}`, fences.length === 1 && fences[0].raw === "<div>a</div>" && fences[0].closed === true, JSON.stringify(fences));
}

// --- 多围栏 + CRLF ---
{
  const text = `a\r\n${BT}html\r\n<div>1</div>\r\n${BT}\r\nmid\r\n${BT}dsh-html\r\n<div>2</div>\r\n${BT}\r\n`;
  const fences = extractHtmlFences(text);
  ok("two fences CRLF", fences.length === 2 && fences[0].raw === "<div>1</div>" && fences[1].raw === "<div>2</div>", JSON.stringify(fences.map((f) => f.raw)));
}

// --- 反引号数量语义 ---
{
  const four = "`".repeat(4);
  const fences = extractHtmlFences(`x\n${four}html\n<div>a</div>\n${four}\n`);
  ok("four-backtick fence", fences.length === 1 && fences[0].raw === "<div>a</div>", JSON.stringify(fences));
}
{
  // 四反引号围栏里含一个三反引号围栏示例：内层不得提前闭合外层。
  const four = "`".repeat(4);
  const inner = `${BT}html\n<div>示例</div>\n${BT}`;
  const fences = extractHtmlFences(`x\n${four}html\n${inner}\n${four}\n`);
  ok("nested fence not truncated", fences.length === 1 && fences[0].raw.includes("<div>示例</div>"), JSON.stringify(fences.map((f) => f.raw)));
}
{
  // 短于开围栏的闭围栏不算闭合。
  const five = "`".repeat(5);
  const fences = extractHtmlFences(`x\n${five}html\n<div>a</div>\n${BT}\n${five}\n`);
  ok("short close does not close", fences.length === 1 && fences[0].raw.includes("```"), JSON.stringify(fences.map((f) => f.raw)));
}

// --- 不应被当成围栏 ---
ok("indent 4 is not a fence", extractHtmlFences(`x\n    ${BT}html\n<div>a</div>\n    ${BT}\n`).length === 0);
ok("extra info string is not a fence", extractHtmlFences(`x\n${BT}html title=x\n<div>a</div>\n${BT}\n`).length === 0);
ok("plain code fence is not a fence", extractHtmlFences(`x\n${BT}js\nvar a=1;\n${BT}\n`).length === 0);
ok("inline backticks are not a fence", extractHtmlFences("text with `html` inline\nmore\n").length === 0);

// --- 大小写与首尾空白 ---
ok("uppercase info", extractHtmlFences(`x\n${BT}HTML\n<div>a</div>\n${BT}\n`).length === 1);
ok("trailing spaces", extractHtmlFences(`x\n${BT}html  \n<div>a</div>\n${BT}  \n`).length === 1);
ok("indent 2", extractHtmlFences(`x\n  ${BT}html\n<div>a</div>\n  ${BT}\n`).length === 1);

// --- 未闭合 / 上限 ---
{
  const fences = extractHtmlFences(`x\n${BT}html\n<div>a</div>\n`);
  ok("unterminated at EOF", fences.length === 1 && fences[0].closed === false, JSON.stringify(fences));
}
{
  const many = Array.from({ length: 45 }, (_, i) => `${BT}html\n<div>${i}</div>\n${BT}`).join("\n");
  ok("MAX_FENCES cap", extractHtmlFences(many).length === 40, String(extractHtmlFences(many).length));
}

// --- 标记白名单单一事实源 ---
for (const marker of HTML_FENCE_MARKERS) {
  ok(`marker accepted: ${marker}`, extractHtmlFences(`x\n${BT}${marker}\n<div>a</div>\n${BT}\n`).length === 1);
}
ok("marker list is the shared one", HTML_FENCE_MARKERS.join(",") === "html,dsh-html,html-render", HTML_FENCE_MARKERS.join(","));
ok("near-miss marker rejected", extractHtmlFences(`x\n${BT}htmlx\n<div>a</div>\n${BT}\n`).length === 0);

// --- 指纹稳定性 ---
ok("fingerprint stable across line endings", fenceFingerprint("<div>a</div>\r\n") === fenceFingerprint("<div>a</div>\n"));
ok("fingerprint differs on content", fenceFingerprint("<div>a</div>") !== fenceFingerprint("<div>b</div>"));

console.log(fails === 0 ? "FENCE PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
