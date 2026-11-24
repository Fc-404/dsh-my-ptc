// my-ptc 预设 bundle 自带的 bili 活动记忆启动插件（与预设合成同一个 bundle）。
// 职责：DSH 启动后，幂等地确保 billion-context（bili）压缩提示词包含「活动记忆」规则，
//       并触发热重载。bili 是独立进程，本插件只写它的配置文件 + 调它的 reload 接口。
//
// 设计原则（不要引入问题）：
//  - 自包含：四段内核默认文本与活动记忆规则都内嵌在本文件，不依赖任何外部模板文件。
//  - 幂等：只在内容确实不同才写文件、才 reload；已包含「活动记忆」标记的段落一律不动（尊重手改）。
//  - 只动 minimal 字段：compress.prompts 四段 + compress.acknowledgePromptsRisk，其他键原样保留。
//  - 绝不阻塞/打断 DSH 启动：所有 IO 异步、整段 try/catch，任何失败只记日志。
//  - 原子写：同目录临时文件 + rename；写入前保留一份带时间戳的备份。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const name = "bili-active-memory";
export const inject = [];

const MARK = "活动记忆";

const KERNEL = {
  "compressPhilosophy": "Compression Philosophy:\n- All compression serves the primary task, but be frugal.\n- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.\n- Compress by need, not by percentage.\n- Work from summaries, not raw tool outputs. All listed ranges (user prompts, tool outputs, code, logs, exploration, intermediate steps) should be compressed to summary format — the ONLY exceptions are protected content, content the current step is actively using, or critical content you cannot reconstruct.",
  "howToCompressRules": "HOW TO COMPRESS\n\nWhen you call `compress`, the summary you write becomes the only record of the replaced conversation. Make it self-contained and complete: every user request, experiment purpose, and work task in the range must be accurately captured. A later reader (or you, after decompressing) should be able to continue the task WITHOUT needing the original. The summary records the PAST as of this block's creation: label recorded task state as history (\"TASK AS OF THIS BLOCK: ...\") — never as a live instruction, so a later reader treats it as settled context, not something to re-execute. Write plain text with real unicode characters; never copy \\uXXXX escape sequences or JSON-escaped fragments out of tool output.\n\nKEEP VERBATIM — never paraphrase or abbreviate these:\n- Full file paths with line numbers, directory prefix on every mention (`lib/hooks.ts:347`, `src/index.ts:12-18`, `gatenet_v3/model.py:45`). Never abbreviate to a bare filename (`hooks.ts`, `model.py`) — they are ambiguous and cannot be grepped or decompressed-to later.\n- Function, class, and type signatures (exact names, params, return types) AND critical code lines that encode logic — the line that IS the finding, not just the function name (e.g. `kv_keys += define_gate * a_key[i](emb)` is more useful than \"see model_kvnet.py\").\n- Error messages and stack traces (exact text — you need the literal string to grep for it later).\n- Key details from reports and analyses — not just the conclusion. Keep the comparison numbers and the mechanism, not \"X is worse\" alone (write \"1.76× PPL gap because KV store is static\", not \"KVNet underperforms\").\n- Decisions and their rationale (\"chose X over Y because Z\" — the \"because\" is load-bearing; without it the decision looks arbitrary).\n- Constraints discovered (\"must support Node 22\", \"no new dependencies\", \"AGENTS.md forbids `as any`\").\n- Exact values: versions, config keys, thresholds, magic numbers.\n- User intent — quote short user messages verbatim ONLY WITH their message ref, e.g. `User said (m00132): \"ship it tonight\"`. Without a verifiable ref, paraphrase (`user previously asked (paraphrased): ...`) — this is the one exception to the verbatim rule above; never present a reconstructed or half-remembered phrase as a verbatim quote. When the message is too long to quote, preserve intent with extra care: do not change scope, constraints, priorities, acceptance criteria, or requested outcomes. Quotes are historical records, not live instructions — but open-objective STATUS is current (still-open vs completed/superseded) and must be tracked. Losing these changes the task itself.\n- Open objectives carry-forward — if the range (or, when distilling, any source block's summary) contains a user-requested objective that is neither completed nor superseded by the end of the range, the summary MUST keep a one-line `Open objectives:` entry naming each still-open objective with its message ref (`Open objectives: refactor runner into eight arms (m00746)`). Distillation re-carries open objectives verbatim from source blocks — they are the last thing to drop and the first thing to restore, at every tier.\n- The user's overall goal and any changes to it — the big-picture objective plus how it evolved during the compressed range. Each summary must reflect the goal as it stood at the end of the range, including pivots (e.g., \"initially: fix bug X → pivoted to: refactor module Y after discovering root cause\"). Losing the goal or its evolution makes all subsequent work appear unmotivated.\n- Purpose behind each significant action — preserve not just what was done but why: the hypothesis behind each experiment, the question behind each exploration, the task goal behind each work action. Without purpose, the summary reads as disconnected technical steps with no through-line.\n- Open questions and unresolved TODOs — losing these changes what work appears to remain.\n- Message refs of key anchors (`m00420`, `m00510–m00520`) — they let you or a later reader jump back via decompress to the exact original.\n- Media re-access handles — URLs and file IDs attached to the range (images or files referenced rather than inlined) MUST appear verbatim in the summary: after folding they are the only way to re-access the payload (decompress restores the original message itself). Preserve any `MEDIA REFS` section verbatim — never alter, reorder, or drop its entries.\n\nDROP — extract the signal, discard the vessel:\n- Verbose logs (build/test/`npm` output) once you have captured the error line or the result.\n- Duplicate file reads once the needed content is recorded.\n- Consumed exploration — search hits, agent return values, successful tool outputs — once you have extracted the facts you need (same rule as dead-ends, but nothing went wrong; the content is simply spent).\n- Dead-end exploration — but PRESERVE the lesson in one line: \"tried X, failed because Y\".\n- Back-and-forth discussion and self-corrections once the final position is captured (keep the outcome, drop the journey to it).\n- Repeated status checks (`git status`, `ls`) once state is known.\n\nFor each significant item you DROP (scripts, reports, large analyses, long tool outputs), add a one-line CONTENT description of what it covers — not where it lives. Bad: \"probe script at /path/probe_kvnet.py\". Good: \"probe_kvnet.py: tests n-gram baseline, generation quality, long-range dependency, position sensitivity, op pipeline, QUERY attention.\" This lets a later decompress target the right block by relevance, not by guessing locations.\n\nPRIORITY — when the summary must be compact, preserve in this order:\n1. User's overall goal, goal evolution, intent, and hard constraints (losing these changes the task).\n2. Decisions and rationale.\n3. Exact technical artifacts: paths, signatures, errors, values.\n4. Conclusions and key findings.\n5. Lessons learned: what failed and why.\n\nWrite dense, scannable bullets — not narrative prose. If the range spans distinct concerns (request → findings → decision), group bullets under short thematic headers so a reader can scan to the part they need. Every line must earn its place. Do not mimic the style of existing summaries in context; follow these rules.",
  "tier2DistillRules": "TIER 2 COMPRESSION — DISTILLATION\n\nYou are compressing historical summaries (not raw conversation). These summaries have already captured the details. Your job is to DISTILL them: extract only what matters for future work, discard the process.\n\nKEEP — these are the only things that survive distillation:\n- Decisions and their rationale (\"chose X over Y because Z\" — the \"because\" is load-bearing).\n- Final outcomes: version numbers shipped, PR numbers merged/closed, bugs fixed or deferred.\n- Key lessons: what failed and why (\"tried X, failed because Y\"). These prevent repeating mistakes.\n- Critical constraints discovered (\"must support Node 22\", \"AGENTS.md forbids as any\").\n- Design decisions with architectural impact (\"chose compress-as-anchor over synthetic messages because prefix cache\").\n- User quotes and task state only as attributed history: keep the source ref with any user quote; never carry an UNVERIFIED tier-1 \"CURRENT TASK\" claim forward as a live directive — relabel it \"TASK AS OF THIS BLOCK\". A ref-backed objective that no later source marks completed or superseded is not unverified: it carries in the `Open objectives:` entry (next bullet), not as a directive.\n- Open objectives — if ANY source block's summary names a user-requested objective that no later source block marks completed or superseded, the distilled summary MUST keep a one-line `Open objectives:` entry re-carrying each still-open objective verbatim with its original ref. They are the last thing to drop and the first thing to restore.\n- Media re-access handles — carry every entry of any source block's `MEDIA REFS` section verbatim (URLs/file IDs are re-access handles, not detail to distill away).\n- Whether content is OBSOLETE or SUPERSEDED — mark with one line: \"[SUPERSEDED by PR #NNN]\" or \"[OBSOLETE: deleted in vX.Y.Z]\". Do NOT keep the obsolete content's details — just the marker and reason.\n- Function/class/type names and module paths that are the SUBJECT of the work — e.g., \"fixed filterCompressedRanges in prune.ts\", \"added SessionStateRegistry in state.ts\". Not exact line numbers or full signatures — just enough to LOCATE the code without searching.\n- Exploration findings: if a block was exploratory with no decision, keep the CONCLUSION in one line (\"explored X, not viable because Y\"). Do not keep the exploration process.\n\nDROP — these were useful during the work but are no longer needed:\n- Exact line numbers, diffs, verbose function signatures, full code listings.\n- Build/deploy process details, test execution steps.\n- Review process details (who reviewed, what rounds, test counts).\n- Verbose logs, command output, intermediate debugging steps.\n\nFORMAT:\n- Start each distilled block with a source header line:\n  `Source: bN+bM+... (XK→YK tok, Zx). [original topic]`\n  Example: `Source: b5+b7 (56K+44K→268 tok, 375x). [Tool-result recap + publish]`\n- 3-5 bullet points per source block, each a self-contained fact.\n- Dense, scannable — no narrative prose.\n- Start with the outcome, not the process: \"v1.13.0 shipped (7 PRs bundled)\" not \"implemented 7 PRs then reviewed then merged\".\n- Cross-block synthesis: if multiple source blocks cover the same topic (same PR, same feature, same bug), MERGE them into a single group of bullets. Do not repeat the same fact from different blocks — keep it once under the most relevant source header.\n\nSIZE TARGET: 50-150 tokens per source block (excluding the header). If you can't fit it in 150 tokens, you're keeping too much process. If a block has nothing worth keeping (pure noise), output just the header followed by \"[no actionable content].\"",
  "tier3CondenseRules": "TIER 3 COMPRESSION — ULTRA-CONDENSATION\n\nYou are compressing distilled summaries (Tier 2) into ultra-condensed facts (Tier 3). The distilled summaries already contain only decisions and outcomes. Your job is to reduce them to bare factual references.\n\nPRIORITY — when a source block has more facts than the size target allows, keep in this order:\n1. Shipped outcomes (versions released, PRs merged) — these are permanent record.\n2. Open work — PRs/issues still pending AND still-open user-requested objectives (re-carry any source block's `Open objectives:` entries verbatim); these may need follow-up.\n3. Key decisions with architectural impact (\"chose X over Y because Z\").\n4. Critical constraints (\"must support Node 22\").\n5. Media re-access handles — carry any source block's `MEDIA REFS` entries verbatim when present; handles must survive condensation.\nDrop everything else. Tier 3 is a lookup index, not a knowledge base.\n\nFORMAT:\n- Start with a source header line:\n  `Source: bN+bM+... (XK→YK tok, Zx). [original topic]`\n- Output 1-3 facts per source block. Each fact is a single line: subject + outcome.\n- No explanations, no rationale, no process — just the fact.\n- Format: \"[PR/Issue/Version] — [outcome in ≤8 words]\"\n- Merge related facts from different source blocks if they concern the same topic.\n\nEXAMPLES:\n- \"v1.13.0 shipped — quality gate + GC fix (7 PRs)\"\n- \"PR #196 merged — preserve-first-user (supersedes #169)\"\n- \"Bug 1214 fixed — compress consumed all user messages\"\n- \"Objective (m00746) — eight-arm runner refactor, still open\"\n- \"Chose compress-as-anchor — prefix cache benefit over synthetic injection\"\n- \"Constraint: AGENTS.md forbids as any — never suppress types\"\n\nDROP:\n- Multi-sentence context. If a fact needs >1 sentence, it's too detailed for Tier 3.\n- Lessons learned (\"tried X, failed because Y\") — drop UNLESS the failure is likely to recur and the block is <30 days old.\n- Design rationale details — keep the decision, drop the \"because\" unless it's a critical constraint.\n- Anything marked [OBSOLETE] or [SUPERSEDED] — drop entirely, note \"[N blocks obsolete]\" in the summary.\n\nSIZE TARGET: 30-60 tokens per source block (including header). For a batch of N source blocks, total output ≈ N × 40 tokens. If a source block has only one trivial fact, output just the header + one line."
};

const APPEND = {
  "compressPhilosophy": "\n\n- 活动记忆（摘要最前面的「活动记忆」段）优先于一切技术细节：预算紧张时先压缩技术细节，绝不清空或省略活动记忆。",
  "howToCompressRules": "\n\n## 活动记忆（ACTIVE MEMORY，追加规则）\n\n每次压缩时，摘要最前面必须固定保留「活动记忆」段，记录当前会话中用户明确说过的需求、约束与已确认决策。它是实时状态，不是日志：每次压缩前先对照最新对话更新它。\n\n## 活动记忆（ACTIVE MEMORY）\n- R1: <用户要什么>（ref mNNNNN）\n- C1: <约束/禁止/必须>（ref mNNNNN）\n- D1: <已确认决策>（ref mNNNNN）\n- A1: <可检查的验收标准>（ref mNNNNN）\n\n规则：\n- 每条一行，活跃条目总数 ≤12 条；只写“要什么/不要什么/怎么算完成/定了什么”，不写技术细节。\n- 每次压缩前先重读最新对话：用户新提出的需求追加新编号（R/C/D/A 各自递增，永不复用）；用户改动或推翻旧需求时，直接改写对应条目并保留原编号与 ref，同时把旧内容标 (superseded) 移入归档；完成的标 (done)，撤销的标 (rejected)。\n- 归档（ARCHIVE）每条一行短记录；活动条目永不因预算被删除，预算不足时先压缩归档区与技术细节。\n- 该段与后文冲突时，以该段为准；只以用户消息与用户确认过的内容为准，不写模型自己的猜测。",
  "tier2DistillRules": "\n\n- 「活动记忆」段必须原样逐字承接（含编号、ref、归档子区），不得改写、浓缩或省略；只允许合并归档区条目。",
  "tier3CondenseRules": "\n\n- 「活动记忆」段必须原样逐字承接；预算紧张时先压缩其他内容，优先保留该段。"
};

const DEFAULTS = {
  port: 18787,
  retries: 8,
  enabled: true,
};

let started = false;

function log(ctx, level, ...args) {
  const message = args.map((a) => (a instanceof Error ? (a && a.stack ? a.stack : String(a)) : String(a))).join(" ");
  try {
    const logger = ctx && ctx.logger;
    const fn = logger && logger[level];
    if (typeof fn === "function") {
      fn.call(logger, "[bili-active-memory]", message);
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    console.log("[bili-active-memory]", message);
  } catch {
    /* ignore */
  }
}

function resolveConfigPath(config) {
  if (config && typeof config.configPath === "string" && config.configPath.trim().length > 0) {
    return config.configPath.trim();
  }
  const explicit = process.env.BILI_CONFIG || process.env.BILI_CONFIG_FILE;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const dir = process.env.BILI_CONFIG_DIR;
  if (dir && dir.trim().length > 0) return path.join(dir.trim(), "billion-context.json");
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg.trim() : path.join(os.homedir(), ".config");
  return path.join(base, "billion-context", "billion-context.json");
}

function buildPrompt(current, kernelText, append, marker) {
  const cur = typeof current === "string" ? current : "";
  if (cur.includes(marker)) return cur; // 已包含活动记忆规则（含用户手改版）：保留，不覆盖
  if (cur.trim().length === 0) return kernelText + append;
  return cur + append; // 用户已有自定义文本：保留其内容，仅在末尾追加规则
}

function buildPrompts(existing) {
  const cur = existing && typeof existing === "object" && existing.compress && typeof existing.compress === "object" ? existing.compress.prompts : undefined;
  const p = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
  return {
    compressPhilosophy: buildPrompt(p.compressPhilosophy, KERNEL.compressPhilosophy, APPEND.compressPhilosophy, MARK),
    howToCompressRules: buildPrompt(p.howToCompressRules, KERNEL.howToCompressRules, APPEND.howToCompressRules, MARK),
    tier2DistillRules: buildPrompt(p.tier2DistillRules, KERNEL.tier2DistillRules, APPEND.tier2DistillRules, MARK),
    tier3CondenseRules: buildPrompt(p.tier3CondenseRules, KERNEL.tier3CondenseRules, APPEND.tier3CondenseRules, MARK),
  };
}

function readConfig(configPath, ctx) {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log(ctx, "warn", "配置不是 JSON 对象，跳过：" + configPath);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") return { providers: {} };
    log(ctx, "warn", "读取 bili 配置失败（跳过，不覆盖）：" + configPath + " — " + (err && err.message ? err.message : err));
    return null;
  }
}

function writeConfigAtomic(configPath, data, ctx) {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    try {
      const backup = configPath + ".bak-" + Date.now();
      fs.copyFileSync(configPath, backup);
      log(ctx, "info", "已备份原配置 → " + backup);
    } catch {
      /* 无原文件可备份：忽略 */
    }
    const tmp = configPath + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, configPath);
    return true;
  } catch (err) {
    log(ctx, "warn", "写入 bili 配置失败：" + (err && err.message ? err.message : err));
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reloadBili(port, retries, ctx) {
  const url = "http://127.0.0.1:" + port + "/__bili/config/reload";
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(url, { method: "POST", signal: controller.signal });
        if (res && res.ok) {
          log(ctx, "info", "bili 配置已热重载");
          return true;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* bili 可能尚未启动：退避重试 */
    }
    if (i < retries - 1) await sleep(Math.min(500 * Math.pow(2, i), 5000));
  }
  log(ctx, "warn", "bili reload 未成功（配置已写入，bili 下次启动时会读取）：" + url);
  return false;
}

async function ensureOnce(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === "object" ? config : {}) };
  if (cfg.enabled === false) {
    log(ctx, "info", "插件已禁用（enabled: false），跳过");
    return;
  }
  const port = Number.isFinite(cfg.port) && cfg.port > 0 ? cfg.port : DEFAULTS.port;
  const retries = Number.isFinite(cfg.retries) && cfg.retries > 0 ? cfg.retries : DEFAULTS.retries;
  const configPath = resolveConfigPath(cfg);

  const existing = readConfig(configPath, ctx);
  if (existing === null) return;

  const nextPrompts = buildPrompts(existing);
  const currentPrompts = existing.compress && existing.compress.prompts && typeof existing.compress.prompts === "object" ? existing.compress.prompts : {};
  const promptsChanged = ["compressPhilosophy", "howToCompressRules", "tier2DistillRules", "tier3CondenseRules"].some((key) => currentPrompts[key] !== nextPrompts[key]);
  const ackChanged = !(existing.compress && existing.compress.acknowledgePromptsRisk === true);

  if (!promptsChanged && !ackChanged) {
    log(ctx, "info", "活动记忆配置已存在且一致，无需改动");
    return;
  }

  const next = structuredClone(existing);
  if (!next.compress || typeof next.compress !== "object" || Array.isArray(next.compress)) next.compress = {};
  next.compress.prompts = { ...(next.compress.prompts && typeof next.compress.prompts === "object" ? next.compress.prompts : {}), ...nextPrompts };
  next.compress.acknowledgePromptsRisk = true;

  if (!writeConfigAtomic(configPath, next, ctx)) return;
  log(ctx, "info", "活动记忆配置已写入：" + configPath);
  await reloadBili(port, retries, ctx);
}

export function apply(ctx, config) {
  if (started) return;
  started = true;
  // 放到本轮 boot 之后执行，避免阻塞 DSH 启动；任何异常都在内部吞掉。
  setImmediate(() => {
    ensureOnce(ctx, config).catch((err) => {
      log(ctx, "warn", "活动记忆初始化失败（已忽略）：" + (err && err.message ? err.message : err));
    });
  });
}

export default { name, apply, inject };
