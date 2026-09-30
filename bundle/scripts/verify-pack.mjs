#!/usr/bin/env node
/**
 * 打真 tarball 的打包自检门禁（移植自 dsh-genui scripts/verify-pack.mjs，按本插件裁剪）。
 *
 * 为什么需要它：`files`/`exports` 写错时 npm 装出来的包缺文件，只有真打包才能发现；
 * `npm pack --json` 的 stdout 被程序化消费（CI 等），因此本脚本自身日志全部走 stderr。
 *
 * 检查项：
 *   1. 必含清单：package.json / LICENSE / README.md / CHANGELOG.md / cordis.patch.yml /
 *      SKILL.md，以及遍历 pkg.exports 收集到的全部字符串目标；
 *   2. 禁止清单：*.map / *.tsbuildinfo / node_modules 泄漏；
 *   3. 体积上限：tarball ≤ GENUI_PACK_MAX_TARBALL，unpacked ≤ GENUI_PACK_MAX_UNPACKED
 *      （环境变量可调，但注释即契约：只能调、绝不静默放宽）。
 *
 * 用法：node scripts/verify-pack.mjs [--keep]
 *   --keep：保留 tarball 到临时目录，并把 tarball=<path> / sha256=<hex> 追加到
 *           $GITHUB_OUTPUT（供 CI 冒烟步使用）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const keep = process.argv.includes("--keep");

const MAX_TARBALL = Number(process.env.DSH_HTML_UI_PACK_MAX_TARBALL ?? 3 * 1024 * 1024);
const MAX_UNPACKED = Number(process.env.DSH_HTML_UI_PACK_MAX_UNPACKED ?? 10 * 1024 * 1024);

const log = (msg) => process.stderr.write(`[verify-pack] ${msg}\n`);
const fail = (msg) => {
  process.stderr.write(`[verify-pack] FAIL ${msg}\n`);
  process.exit(1);
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** 遍历 pkg.exports 收集全部字符串目标（相对路径）。 */
function exportTargets(exportsField) {
  const out = [];
  const walk = (node) => {
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  walk(exportsField);
  return out;
}

/** 归一化产物路径：npm pack --json 报 `./lib/index.js`，exports 目标同带 `./` 前缀。 */
const norm = (p) => String(p).replace(/^\.\//, "");

const required = [
  "package.json",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "cordis.patch.yml",
  ...exportTargets(pkg.exports).map(norm),
  // 插件运行面：宿主半边 / 客户端半边 / 共享校验器 / 反馈环 / 打包 skill
  "lib/index.js",
  "lib/client.js",
  "lib/validate.mjs",
  "lib/feedback.mjs",
  "skills/dsh-html-ui/SKILL.md",
].map(norm);

const forbidden = [/\.map$/, /\.tsbuildinfo$/, /(^|\/)node_modules\//];

// 1. 打真 tarball（stdout 走 stderr：npm pack --json 的 stdout 必须保持干净）。
//    逃生通道：受限环境（捕获子进程 stdio 被沙箱阻断）可先用外部命令产出
//    `npm pack --json` 的结果文件，再用 DSH_HTML_UI_PACK_JSON 指过来；脚本逻辑不变。
const packJsonPath = process.env.DSH_HTML_UI_PACK_JSON;
let pack;
let dest;
if (packJsonPath) {
  pack = JSON.parse(readFileSync(packJsonPath, "utf8"));
  dest = dirname(packJsonPath);
} else {
  try {
    dest = mkdtempSync(join(tmpdir(), "dsh-html-ui-pack-"));
    const raw = execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--pack-destination", dest, "--json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    pack = JSON.parse(raw);
  } catch (error) {
    fail(`npm pack failed: ${error.message}`);
  }
}

const tarball = pack?.[0]?.filename;
if (!tarball) fail("npm pack --json did not report a tarball");
const tarballPath = join(dest, tarball);
const tarballSize = statSync(tarballPath).size;
if (tarballSize > MAX_TARBALL) fail(`tarball too large: ${tarballSize} > ${MAX_TARBALL}`);

// 2. 清单断言（npm pack --json 的 files 数组即最终产物面）
const files = (Array.isArray(pack[0].files) ? pack[0].files : []).map((f) => norm(f.path));
const missing = required.filter((r) => !files.includes(r));
if (missing.length > 0) fail(`required files missing from tarball: ${missing.join(", ")}`);
const offenders = files.filter((f) => forbidden.some((re) => re.test(f)));
if (offenders.length > 0) fail(`forbidden files present in tarball: ${offenders.join(", ")}`);

// 3. unpacked 体积上限（tarball 里的 entry size 之和）
const unpacked = (Array.isArray(pack[0].files) ? pack[0].files : []).reduce((sum, f) => sum + (f.size ?? 0), 0);
if (unpacked > MAX_UNPACKED) fail(`unpacked content too large: ${unpacked} > ${MAX_UNPACKED}`);

// 4. 资产面抽查：KaTeX 字体与引擎必须随包（浏览器端真正渲染依赖）
const hasKatex = files.some((f) => f.startsWith("lib/assets/katex/"));
if (!hasKatex) fail("lib/assets/katex/** missing — browser KaTeX would 404 at runtime");

log(`ok: ${files.length} files, tarball ${(tarballSize / 1024).toFixed(1)}KB, unpacked ${(unpacked / 1024).toFixed(1)}KB`);
log(`required=${required.length} present; forbidden=0; size caps ok`);

if (keep) {
  const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  log(`keep: ${tarballPath}`);
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `tarball=${tarballPath}\nsha256=${sha256}\n`);
  }
} else if (!packJsonPath) {
  rmSync(dest, { recursive: true, force: true });
}
process.exit(0);
