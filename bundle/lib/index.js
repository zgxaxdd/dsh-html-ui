/**
 * dsh-html-ui — host half (v4.0.0, hand-maintained).
 *
 * Registers:
 *  1. a webserver prefix route serving the KaTeX engine/fonts (immutable cache);
 *  2. a system-prompt section teaching the html/dsh-html fence contract
 *     (order from the host's STRUCTURED_OUTPUT placement, 106 fallback),
 *     trimmed to the hard rules (details live in the bundled skill — progressive disclosure);
 *  3. the `dsh_html_check` model-facing tool: pre-render self-check over the SAME rule
 *     set the browser renderer uses (shared with lib/validate.mjs), now handing the
 *     model the repaired source (repaired_html) instead of asking it to re-author;
 *  4. the fence repair feedback loop (lib/feedback.mjs): a reply whose fence the
 *     renderer cannot render gets one bounded correction steered into the same turn;
 *  5. a bundled skill (skills/dsh-html-ui/SKILL.md).
 *
 * Verified host contract: @deepseek-ai/dsh ^0.1.7-alpha.2 … 0.2.x
 * (systemPrompt.section / skills.registerProvider / tools.register /
 *  webServer.register / ctx.reflect.get("webServer") / internal/service /
 *  session/event + agent/turn-stopping + agent.steer).
 * Zero runtime `@deepseek-ai/*` imports on purpose: the bundle resolves no harness
 * module graph under profile installs (pnpm isolation).
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { repairHtml, validateRaw } from "./validate.mjs";
import { installFenceFeedback } from "./feedback.mjs";

const VERSION = "4.1.0";

const F3 = String.fromCharCode(96, 96, 96);
const ASSET_ROUTE_PATH = "/plugins/dsh-html-ui/assets";
const ALLOWED_RE = /\.(js|css|woff2|json)$/;
const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

const here = dirname(fileURLToPath(import.meta.url));
const assetDir = join(here, "assets", "katex");

async function serveAsset(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return }
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname) }
  catch { res.writeHead(400); res.end(); return }
  const prefix = ASSET_ROUTE_PATH + "/katex/"
  if (!pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return }
  const rel = pathname.slice(prefix.length)
  const file = normalize(rel)
  if (file.startsWith("..") || !ALLOWED_RE.test(file)) { res.writeHead(404); res.end(); return }
  const full = join(assetDir, file)
  if (!full.startsWith(assetDir) || !existsSync(full)) { res.writeHead(404); res.end(); return }
  try {
    const body = readFileSync(full)
    res.writeHead(200, {
      "content-type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream",
      "content-length": String(body.length),
      "cache-control": "public, max-age=31536000, immutable",
    })
    // HEAD 只回头：旧实现把整个 body 也发出去（272KB 的 katex.min.js 白传一遍）。
    res.end(req.method === "HEAD" ? undefined : body)
  } catch { res.writeHead(404); res.end() }
}

const SECTION_TEXT = [
  "你可以用 " + F3 + "html 围栏（或 " + F3 + "dsh-html 围栏）输出任意原始 HTML，由渲染器在聊天流内联渲染（样式/本地交互脚本/块级 KaTeX 公式全支持，无边框融入对话流）。",
  "触发：结构图/流程图、多卡讲义、对照大表、计算卡、交互小部件、整页交付物 —— 命中即用；普通问答/短答/公式推导仍用 Markdown。",
  "位置：围栏只写在回答正文；写在 reasoning/思考块里不会渲染、用户看不到 —— 思考里自查，正文再输出。",
  "硬约定：围栏自带精简 <style>（半透明中性底、不写死文字色）；脚本仅围栏内本地交互（禁网络/iframe/父页）；块级公式 $$…$$（行内 $ 不渲染）；红字 <mark>；图片内联 SVG；写法与风格库见 dsh-html-ui skill。",
  "复杂围栏（>50 行 / 含 <script> / 整页交付物）先调 dsh_html_check 工具校验源码，按回执 fix 修复后再输出（可直接采用的修复版在回执 repaired_html 里）；首行可写 <!--dsh-html {\"title\":\"…\"}--> 供导出命名，整页交付物写 {\"full\":true} 放宽行数上限。",
  "限额：≤3 围栏/回合、各 ≤250 行；整页交付物单围栏 ≤500 行、≤1MB。",
].join("\n");

const bundledSkillPath = join(here, "..", "skills", "dsh-html-ui", "SKILL.md");
const SKILL_PROVIDER = "dsh-html-ui";
const SKILL_DESCRIPTION = "dsh-html 围栏输出协议：触发判定、样式库、校验错误码与修复回执、安全红线与限额。";
const SKILL_WHEN_TO_USE = "当回复内容用纯文字难以表达（结构图/流程图、多卡讲义、对照大表、计算卡、交互小部件、整页交付物），或模型需查阅 html 围栏的书写规范、风格库与校验错误码时使用。";

function bundledSkillProvider() {
  const raw = existsSync(bundledSkillPath) ? readFileSync(bundledSkillPath, "utf8") : "";
  // 取闭合 --- 之后的第一行正文：旧实现固定 slice(end + 5)，隐含"分隔行后必有一个空行"
  // （LF=3+2 恰好对；CRLF 与"紧随正文"两种写法会各自多切/少切一个字符）。
  const fmEnd = raw.indexOf("---", 4);
  const bodyStart = fmEnd < 0 ? -1 : raw.indexOf("\n", fmEnd + 3);
  const body = bodyStart < 0 ? raw : raw.slice(bodyStart + 1).replace(/^\r?\n/, "");
  const end = fmEnd;
  const meta = {
    name: "dsh-html-ui",
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "bundled",
    provider: SKILL_PROVIDER,
    path: bundledSkillPath,
    resourceBase: { kind: "directory", path: dirname(bundledSkillPath) },
    rank: 600,
    locator: bundledSkillPath,
  };
  return {
    name: SKILL_PROVIDER,
    list: () => Promise.resolve(end >= 0 ? [meta] : []),
    get: () => Promise.resolve(Object.assign({}, meta, { content: body })),
  };
}

/**
 * systemPrompt 节序：优先用宿主集中分配的结构化输出位（dsh-genui 同款做法，
 * 宿主改版后固定 order 可能落到错误分组）。
 *
 * 兜底值 9900 与实测宿主一致：0.1.7-alpha.2 与 0.2.0-rc.2 的
 * `SECTION_ORDERS.STRUCTURED_OUTPUT` 都是 9900（HARNESS_SOURCE 10000 之前），
 * 而本插件声明的最低宿主 0.1.7-alpha.2 已经提供 getSectionOrder，兜底分支只在
 * 更老的宿主上生效——旧值 106 会插进 runtime-context 段（110/115/120）之前。
 */
function sectionOrder(ctx) {
  try {
    const sp = ctx.systemPrompt;
    const fn = sp && typeof sp.getSectionOrder === "function" ? sp.getSectionOrder : null;
    if (fn) {
      const order = fn.call(sp, "STRUCTURED_OUTPUT");
      if (typeof order === "number") return order;
    }
  } catch (e) { /* older host: no getSectionOrder */ }
  return DEFAULT_SECTION_ORDER;
}

const CHECK_TOOL_NAME = "dsh_html_check";
/** 宿主缺 getSectionOrder 时的兜底节序；与 0.1.7-alpha.2 / 0.2.0-rc.2 的 STRUCTURED_OUTPUT 一致。 */
const DEFAULT_SECTION_ORDER = 9900;
const RECEIPT_ITEM_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string" },
    detail: { type: "string" },
    fix: { type: "string" },
  },
  required: ["code", "detail", "fix"],
  additionalProperties: false,
};

/**
 * 防御性读取围栏源码。宿主工具桥实际观测到过多种参数形状（dsh-genui tool.ts 同款教训）：
 *  - `{html: "<source>"}`（约定形状）；
 *  - 裸字符串；
 *  - `{arguments: "..."}` / `{arguments: {html}}`（SDK 工具桥双层包装）；
 *  - `{spec: "..."}` / `{source: "..."}`（模型换名）。
 * 逐层剥开，保证校验器拿到真正的源码而不是包装层。
 * 带深度上限：模型给出的 `{spec:{spec:{spec:…}}}` 这种病态包装不能把栈打穿
 * （工具入参来自模型，属于不可信输入）。
 */
const HTML_OF_MAX_DEPTH = 4;
function htmlOf(args, depth) {
  const level = depth || 0;
  if (level > HTML_OF_MAX_DEPTH) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object" || args === null) return "";
  const record = args;
  for (const key of ["html", "source", "content", "fence"]) {
    const v = record[key];
    if (typeof v === "string") return v;
  }
  if ("arguments" in record) return htmlOf(record.arguments, level + 1);
  if ("spec" in record) return htmlOf(record.spec, level + 1);
  return "";
}

/** 回执 → 模型可读的下一动作（dsh-genui [genui-validation] next= 的同款思路）。 */
function nextAction(receipt, repaired) {
  if (receipt.errors.length === 0) {
    return receipt.warnings.length === 0 ? "emit_fence" : "fix_warnings_then_emit";
  }
  return repaired ? "emit_repaired_html" : "fix_and_revalidate";
}

/**
 * 模型侧围栏自查工具：与浏览器渲染器共用 lib/validate.mjs 的规则集，
 * 返回结构化回执（稳定错误码 + 修复指令 + 可直接采用的修复版源码）。
 * 定义为手写 ToolDefinition —— 注册校验点为 output.render 为函数 +
 * output.schema 落在受支持 JSON Schema 子集。
 */
function createCheckTool() {
  return {
    name: CHECK_TOOL_NAME,
    description: "渲染前自查 dsh-html/html 围栏的 HTML 源码。传入围栏内容（不含 ``` 围栏标记，字符串或 {\"html\":\"…\"} 对象均可），返回与浏览器渲染器完全一致的校验回执：E-… 是必须修复的错误，W-… 是警告；每条带 fix 修复指令，可修复错误另附 repaired_html（可直接采用的修复版源码）。输出复杂围栏（>50 行、含 <script>、或整页交付物）前调用一次，修复后再输出围栏。",
    parameters: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description: "围栏内的完整 HTML 源码（不含 ``` 围栏标记）。",
        },
      },
      required: ["html"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          ruleSet: { type: "integer" },
          next: { type: "string", description: "Recommended next action: emit_fence / fix_warnings_then_emit / emit_repaired_html / fix_and_revalidate." },
          errors: { type: "array", items: RECEIPT_ITEM_SCHEMA },
          warnings: { type: "array", items: RECEIPT_ITEM_SCHEMA },
          repaired_html: { type: "string", description: "Auto-repaired fence source, present only when E-… errors are mechanically repairable." },
          meta: {
            type: "object",
            properties: {
              found: { type: "boolean" },
              title: { type: "string" },
            },
            required: ["found"],
            additionalProperties: false,
          },
          stats: {
            type: "object",
            properties: {
              bytes: { type: "integer" },
              tags: { type: "integer" },
              lines: { type: "integer" },
            },
            required: ["bytes", "tags", "lines"],
            additionalProperties: false,
          },
        },
        required: ["ok", "ruleSet", "next", "errors", "warnings", "meta", "stats"],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value, null, 2) }];
      },
    },
    presentCall() {
      return { card: "generic", title: "检查 dsh-html 围栏", kind: "other" };
    },
    presentResult() {
      return { card: "generic", title: "检查 dsh-html 围栏" };
    },
    async execute(args) {
      const receipt = validateRaw(htmlOf(args));
      const meta = { found: !!(receipt.meta && receipt.meta.found) };
      const title = receipt.meta && receipt.meta.value && typeof receipt.meta.value.title === "string" ? receipt.meta.value.title : "";
      const repaired = receipt.ok ? null : repairHtml(htmlOf(args));
      const repairedHtml = repaired && repaired.repairable ? repaired.text : null;
      const out = {
        ok: receipt.ok,
        ruleSet: receipt.ruleSet,
        next: nextAction(receipt, repairedHtml),
        errors: receipt.errors.map((r) => ({ code: r.code, detail: r.detail, fix: r.fix })),
        warnings: receipt.warnings.map((r) => ({ code: r.code, detail: r.detail, fix: r.fix })),
        meta: title ? { ...meta, title } : meta,
        stats: { bytes: receipt.stats.bytes, tags: receipt.stats.tags, lines: receipt.lines },
      };
      if (repairedHtml) out.repaired_html = repairedHtml;
      return out;
    },
  };
}

const inject = ["systemPrompt"];

/** 插件配置（宿主原样传入，未做 schema 校验：node 半边刻意不依赖任何校验库）。 */
function apply(ctx, config) {
  ctx.effect(() => {
    ctx.systemPrompt.section({
      name: "dsh-html-ui:fence",
      order: sectionOrder(ctx),
      text: SECTION_TEXT,
    });
  }, "dsh-html-ui.systemPrompt.section()");
  // 围栏自修反馈环：默认开启，config.fenceFeedback === false 关闭（dsh-genui 同款配置面）。
  installFenceFeedback(ctx, !(config && config.fenceFeedback === false));
  ctx.inject(["skills"], (skillCtx) => {
    skillCtx.skills.registerProvider(() => bundledSkillProvider());
  });
  ctx.inject(["tools"], (toolCtx) => {
    // effect 必须挂在注入作用域上：宿主重新提供 tools 时旧注册随作用域释放，
    // 挂外层 ctx 会在重注入时留下重复注册（tools 层内重名会抛错）。
    toolCtx.effect(() => toolCtx.tools.register(createCheckTool()), "dsh-html-ui.tools.register()");
  });
  // 资产路由：ctx.inject 负责 webServer 的晚绑定与替换，webCtx.effect 负责释放。
  // 旧写法直接 register 且不留 disposer：服务先于插件激活时能装上，但插件重载
  // （HMR / 配置更新 / 插件管理面板开关）时旧路由不释放，第二次注册撞上
  // `webserver: duplicate prefix route`，整个 host 半边加载失败（已实测复现）。
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.reflect.get("webServer");
    if (webServer === void 0 || webServer === null) return;
    webCtx.effect(
      () => webServer.register({ kind: "prefix", path: ASSET_ROUTE_PATH, handler: serveAsset }),
      "dsh-html-ui.webServer.register()",
    );
  });
}

export { CHECK_TOOL_NAME, DEFAULT_SECTION_ORDER, SECTION_TEXT, VERSION, apply, createCheckTool, inject, installFenceFeedback };
