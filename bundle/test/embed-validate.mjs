// 同步工具：把 lib/validate.mjs 的规则实现嵌入 lib/client.js 的 `src/validate.js` 段。
// 修改校验规则时：改 lib/validate.mjs → 运行 `node test/embed-validate.mjs` → 跑 npm test。
// 一致性由 test/parity.test.mjs 逐用例锁死；本工具只是搬运，不构建其他内容。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const validatePath = join(root, "lib", "validate.mjs");
const clientPath = join(root, "lib", "client.js");

const src = readFileSync(validatePath, "utf8");
const client = readFileSync(clientPath, "utf8");

const BEGIN = "  // src/validate.js";
const END = "  // src/kernel.js";
const beginAt = client.indexOf(BEGIN);
const endAt = client.indexOf(END);
if (beginAt < 0 || endAt < 0 || endAt <= beginAt) {
  throw new Error("client.js: validate.js section markers not found");
}

// 1. 去掉模块头注释（保留一段简短说明）与 export 关键字
let body = src.slice(src.indexOf("*/") + 2);
body = body.replace(/^export const /gm, "var ");
body = body.replace(/^export function /gm, "function ");

// 2. 客户端沿用 pure.js 的 DEFAULT_CONFIG（含 inferUnlabeled），删除模块内的重复声明
body = body.replace(/\/\*\* 稳定修复指令表[\s\S]*?\nvar FIX = /, "var FIX = ");
const cfgStart = body.indexOf("var DEFAULT_CONFIG = Object.freeze({");
if (cfgStart >= 0) {
  const cfgEnd = body.indexOf("});", cfgStart);
  if (cfgEnd < 0) throw new Error("DEFAULT_CONFIG block not closed");
  body = body.slice(0, cfgStart) + body.slice(cfgEnd + 3);
}

// 3. 统一缩进到 IIFE 内层（2 空格）
const indented = body
  .split("\n")
  .map((line) => (line.trim() === "" ? "" : "  " + line))
  .join("\n");

const section =
  BEGIN +
  " —— v4 规则集（由 test/embed-validate.mjs 从 lib/validate.mjs 同步，勿手改本段）\n" +
  indented.trimStart() +
  "\n" +
  END;

const next = client.slice(0, beginAt) + section + client.slice(endAt + END.length);
writeFileSync(clientPath, next, "utf8");
console.log("embedded validate.mjs into client.js (", section.length, "chars )");
