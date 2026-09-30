/**
 * dsh-html-ui v4 —— 围栏自修反馈环（host 半边，纯 Node）。
 *
 * 借鉴 dsh-genui issue #160 的 fence-feedback：一条回复里的 html/dsh-html 围栏
 * 若无法渲染（保留为源码视图），读者看到的仍是坏围栏。宿主的 `agent/turn-stopping`
 * 边界允许插件把输入塞回**同一个回合**——模型重读收件箱再走一步，趁用户还看着
 * 原文时把修正版围栏发出来。
 *
 * 边界刻意收紧（与 genui 同款契约）：
 *  - 默认开启，插件配置 `fenceFeedback: false` 关闭；
 *  - 每回合最多一次修正、每个围栏正文（内容指纹）在整个进程内最多一次——修正本身
 *    写错也不会死循环；
 *  - 子代理会话不触发（子会话的围栏属于父回复）；
 *  - 只认 info string 恰为 html / dsh-html / html-render 的围栏，
 *    带缩进的散文、提及名字的文本永不被改写；
 *  - 指纹在 steer 之前入账，重入边界不会重复投递；
 *  - 回合中止或会话缺失时安静退出。
 *
 * 校验完全复用 lib/validate.mjs（与浏览器渲染器同一规则集），修复版源码由
 * repairHtml 产出——把修好的内容直接交给模型，比重写一遍更不容易再出错
 * （dsh-genui validate_dsh_ui 的同款思路，v4 补齐到反馈环最后 100 米）。
 */

import { createHash, randomUUID } from "node:crypto";
import { repairHtml, validateRaw } from "./validate.mjs";

/** 插件名：写入每条被环 steer 的消息 source，也用于识别自己的历史修正。 */
export const FEEDBACK_PLUGIN_NAME = "dsh-html-ui";
/** Session format v4 起使用的 source kind。 */
export const FEEDBACK_SOURCE_KIND = "plugin:" + FEEDBACK_PLUGIN_NAME;
/** 修正文本内的标记前缀：`[dsh-html-fence-repair #<fingerprint>]`。 */
export const MARKER_PREFIX = "[dsh-html-fence-repair #";
/** 旧版插件写过的标记前缀（若曾命名不同，保持兼容读取）。 */
export const LEGACY_MARKER_PREFIX = "[dsh-html 自修 #";

/** 开围栏：info string 恰为 html / dsh-html / html-render（≤3 空格缩进）。 */
const FENCE_OPEN = /^ {0,3}```[ \t]*(?:html|dsh-html|html-render)[ \t]*$/iu;
/** 任意闭围栏。 */
const FENCE_CLOSE = /^ {0,3}```[ \t]*$/u;
/** 单条回复检查的围栏数上限——回复是文本，不是语料库。 */
const MAX_FENCES = 40;

/** 一条回复里的一个 html 围栏。 */
export function extractHtmlFences(text) {
  const lines = String(text || "").split("\n");
  const fences = [];
  let open = null;
  for (let line = 0; line < lines.length; line++) {
    const current = lines[line] || "";
    if (open === null) {
      if (FENCE_OPEN.test(current)) open = { start: line + 1, index: fences.length + 1 };
      continue;
    }
    if (!FENCE_CLOSE.test(current)) continue;
    fences.push({ raw: lines.slice(open.start, line).join("\n"), closed: true, index: open.index });
    open = null;
    if (fences.length >= MAX_FENCES) return fences;
  }
  if (open !== null && fences.length < MAX_FENCES) {
    fences.push({ raw: lines.slice(open.start).join("\n"), closed: false, index: open.index });
  }
  return fences;
}

/** 围栏正文的稳定指纹（同正文 → 同指纹，trim 后取哈希前 12 位）。 */
export function fenceFingerprint(raw) {
  return createHash("sha256").update(String(raw || "").trim()).digest("hex").slice(0, 12);
}

/**
 * 按浏览器渲染器的实际判据（渲染前 validateRaw）找出会退化成源码视图的围栏。
 * @returns {{index:number, fingerprint:string, detail:string, repaired:string|null}[]}
 */
export function fenceFailures(text) {
  const failures = [];
  for (const fence of extractHtmlFences(text)) {
    let detail = null;
    let repaired = null;
    if (!fence.closed) {
      detail = "error=unterminated_fence\nrequired=closing_fence";
    } else {
      const receipt = validateRaw(fence.raw);
      if (receipt.ok) continue;
      const lines = [];
      for (const it of receipt.errors.concat(receipt.warnings)) {
        lines.push(it.code + (it.detail && it.detail !== "-" ? "(" + it.detail + ")" : "") + " -> " + (it.fix || "按错误码修复"));
      }
      detail = lines.join("\n");
      const fix = repairHtml(fence.raw);
      if (fix && fix.repairable && typeof fix.text === "string") repaired = fix.text;
    }
    failures.push({ index: fence.index, fingerprint: fenceFingerprint(fence.raw), detail, repaired });
  }
  return failures;
}

/**
 * 组装 steer 进当前回合的修正文本。
 * 与 dsh-genui 的 [genui-fence-repair] 协议块同构：status/next/repeat_rendered_content。
 */
export function fenceCorrectionText(failures) {
  const body = failures
    .map(function (f) {
      const parts = ["fence=" + f.index, "fingerprint=" + f.fingerprint, f.detail];
      if (f.repaired) {
        parts.push("repaired=available\nfix_by=copy_repaired_html");
      }
      return parts.join("\n");
    })
    .join("\n\n");
  const repairedBlocks = failures
    .filter(function (f) { return f.repaired; })
    .map(function (f) {
      return "fence=" + f.index + "\n```html\n" + f.repaired + "\n```";
    })
    .join("\n\n");
  const marker = failures.map(function (f) { return MARKER_PREFIX + f.fingerprint + "]"; }).join(" ");
  return [
    marker,
    "",
    "[dsh-html-fence-repair]",
    "status=render_failed",
    "fences=" + failures.length,
    "next=resend_corrected_fence_only",
    "repeat_rendered_content=false",
    "fence_position=reply_body_not_reasoning",
    "reply_language=conversation",
    "",
    body,
    repairedBlocks ? "\n可直接采用的修复版源码（原样粘贴进围栏即可）：\n\n" + repairedBlocks + "\n" : "",
  ].join("\n");
}

/**
 * 构造被 steer 的 user 角色消息。
 * 复刻 @deepseek-ai/dsh-llm 的 createUserMessage（id + role + frozen content + source），
 * 但不运行时依赖该包：插件 node 半边刻意不 import 任何 @deepseek-ai/* 运行时模块，
 * 链接安装与 npm 安装在各宿主上解析行为一致。
 */
export function createFeedbackMessage(text, sessionFormatVersion) {
  const source = typeof sessionFormatVersion === "number" && sessionFormatVersion >= 4
    ? { kind: FEEDBACK_SOURCE_KIND, form: "notice", summary: "dsh-html-ui fence repair requested" }
    : { kind: "plugin", plugin: FEEDBACK_PLUGIN_NAME, form: "notice", summary: "dsh-html-ui fence repair requested" };
  const message = {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source,
  };
  Object.freeze(message.content);
  return Object.freeze(message);
}

/** 纯规划器的输入（每个边界可独立测试，无需宿主）。 */
export function planFenceFeedback(input) {
  if (input.aborted) return null;
  if (input.lastCorrectedTurn === input.turn) return null;
  if (String(input.text || "").trim() === "") return null;
  const failures = fenceFailures(input.text).filter(function (f) {
    return !input.corrected || !input.corrected.has(f.fingerprint);
  });
  if (failures.length === 0) return null;
  return {
    text: fenceCorrectionText(failures),
    fingerprints: failures.map(function (f) { return f.fingerprint; }),
    turn: input.turn,
  };
}

/** 取一条 assistant 消息的全部文本块（按序拼接）。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map(function (block) {
      if (typeof block !== "object" || block === null) return "";
      const record = block;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(function (part) { return part !== ""; })
    .join("\n");
}

/** 已 steer 的修正文本里记录过的指纹（插件重载后重新观察到时采纳，避免重复修正）。 */
export function markersIn(text) {
  const out = [];
  let cursor = 0;
  const s = String(text || "");
  while (cursor < s.length) {
    const current = s.indexOf(MARKER_PREFIX, cursor);
    const legacy = s.indexOf(LEGACY_MARKER_PREFIX, cursor);
    if (current < 0 && legacy < 0) break;
    const useLegacy = legacy >= 0 && (current < 0 || legacy < current);
    const prefix = useLegacy ? LEGACY_MARKER_PREFIX : MARKER_PREFIX;
    const index = useLegacy ? legacy : current;
    const end = s.indexOf("]", index + prefix.length);
    if (end < 0) break;
    out.push(s.slice(index + prefix.length, end));
    cursor = end + 1;
  }
  return out;
}

/** 跨当前与迁移后的会话形状识别本插件 source。 */
export function isFeedbackSource(source) {
  if (!source) return false;
  return source.kind === FEEDBACK_SOURCE_KIND
    || (source.kind === "plugin" && source.plugin === FEEDBACK_PLUGIN_NAME);
}

/**
 * 安装围栏反馈环。宿主无 agent 服务时任何 ctx.on 都是空转，不会抛出。
 * @param ctx cordis/DSH 宿主上下文
 * @param enabled 插件配置开关；false 时整体惰化
 */
export function installFenceFeedback(ctx, enabled) {
  if (!enabled) return;
  const sessions = new Map();
  const stateOf = function (sessionId) {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { text: "", corrected: new Set(), lastCorrectedTurn: undefined };
      sessions.set(sessionId, state);
    }
    return state;
  };

  ctx.on("session/disposed", function (session) {
    sessions.delete(String(session.id));
  });

  ctx.on("session/event", function (session, event) {
    const sessionId = String(session.id);
    if (event && event.type === "assistant/message") {
      const text = textOfContent(event.data && event.data.message && event.data.message.content);
      if (extractHtmlFences(text).length === 0) {
        const state = sessions.get(sessionId);
        if (state !== undefined) state.text = "";
        return;
      }
      stateOf(sessionId).text = text;
      return;
    }
    if (!event || event.type !== "user/message") return;
    const data = event.data || {};
    if (isFeedbackSource(data.source)) {
      // 自己的修正（插件重载后重新观察到）：采纳其指纹，第二个边界不会重复投递。
      const fingerprints = markersIn(textOfContent(data.content));
      if (fingerprints.length === 0) return;
      const state = stateOf(sessionId);
      for (const fp of fingerprints) state.corrected.add(fp);
      return;
    }
    // 真正的用户提问开启新回合：上一条回复已定版。
    const state = sessions.get(sessionId);
    if (state !== undefined) state.text = "";
  });

  ctx.on("agent/turn-stopping", function (payload) {
    const agent = payload && payload.agent;
    if (!agent) return;
    // 子会话的围栏属于父回复；中止的回合正在退场——都不要 steer。
    if (agent.session && agent.session.header && agent.session.header.parentSession !== undefined) return;
    const state = sessions.get(String(agent.session && agent.session.id));
    if (state === undefined) return;
    const signal = payload.signal || { aborted: false };
    const plan = planFenceFeedback({
      text: state.text,
      turn: payload.turn,
      lastCorrectedTurn: state.lastCorrectedTurn,
      corrected: state.corrected,
      aborted: !!signal.aborted,
    });
    if (plan === null) return;
    // 先入账再发送：重入边界不得投递两次。
    for (const fp of plan.fingerprints) state.corrected.add(fp);
    state.lastCorrectedTurn = plan.turn;
    try {
      const header = agent.session && agent.session.header;
      agent.steer(createFeedbackMessage(plan.text, header && typeof header.version === "number" ? header.version : undefined));
    } catch (error) {
      if (ctx.logger && typeof ctx.logger.warn === "function") {
        ctx.logger.warn("dsh-html-ui: fence feedback steering failed (" + (error && error.message ? error.message : String(error)) + ")");
      }
    }
  });
}
