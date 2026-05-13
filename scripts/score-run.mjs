#!/usr/bin/env node
/**
 * Score a single agent run.
 *
 * Ingests a Claude Code or Codex CLI transcript (JSONL) plus an
 * acceptance-check JSON written by the sibling acceptance script,
 * emits a one-page markdown scorecard plus a machine-readable
 * `metrics.json`. Zero runtime dependencies — pure Node 22+ APIs.
 *
 * Usage:
 *   node scripts/score-run.mjs \
 *     --transcript <path.jsonl> \
 *     --acceptance <path.json> \
 *     [--env <path.txt>] \
 *     [--diff <path.diff>] \
 *     [--out <score.md>] \
 *     [--metrics <metrics.json>] \
 *     [--tool claude|codex|auto]
 *
 * Exit codes:
 *   0 — scored (regardless of score value)
 *   1 — input I/O error or malformed JSON
 *   2 — unrecognized transcript shape
 *
 * Spec: `.claude/research/planning/tickets/80-score-run-script.md`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

// Pricing snapshot as of 2026-05-13. Update when models rotate.
// Rates are USD per 1M tokens.
const PRICING = {
  "claude-opus-4-7": { input: 15.0, cached_input: 1.5, output: 75.0, cache_creation: 18.75 },
  "claude-sonnet-4-7": { input: 3.0, cached_input: 0.3, output: 15.0, cache_creation: 3.75 },
  "gpt-5": { input: 2.5, cached_input: 0.25, output: 10.0, cache_creation: null },
  "gpt-5-mini": { input: 0.25, cached_input: 0.025, output: 2.0, cache_creation: null },
};

const HUMAN_QUESTION_PATTERNS = [
  /could you clarify/i,
  /what would you like/i,
  /would you prefer/i,
  /which (option|approach) do you/i,
  /please specify/i,
  /let me know if/i,
  /should i (use|pick|choose)/i,
  /do you want/i,
  /which one/i,
];

const DEP_ALLOWLIST = new Set([
  "@baerly/server",
  "@baerly/client",
  "react",
  "react-dom",
  "aws4fetch",
  "idb-keyval",
  "@xmldom/xmldom",
]);

const CLAUDE_TYPES = new Set([
  "assistant",
  "user",
  "system",
  "attachment",
  "ai-title",
  "last-prompt",
  "permission-mode",
  "agent-name",
  "queue-operation",
  "file-history-snapshot",
]);

const CODEX_STREAM_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.completed",
  "error",
]);

// ──────────────────────────────────────────────────────────────────────
// CLI parsing
// ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { tool: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transcript") out.transcript = argv[++i];
    else if (a === "--acceptance") out.acceptance = argv[++i];
    else if (a === "--env") out.env = argv[++i];
    else if (a === "--diff") out.diff = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--metrics") out.metrics = argv[++i];
    else if (a === "--tool") out.tool = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return out;
}

function usage() {
  return [
    "node scripts/score-run.mjs --transcript <path> --acceptance <path>",
    "  [--env <path>] [--diff <path>] [--out <path>] [--metrics <path>]",
    "  [--tool claude|codex|auto]",
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// I/O helpers
// ──────────────────────────────────────────────────────────────────────

async function readJsonl(path) {
  const raw = await readFile(path, "utf8");
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    lines.push(JSON.parse(trimmed));
  }
  return lines;
}

async function readJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

async function tryReadText(path) {
  if (!path) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Tool auto-detection
// ──────────────────────────────────────────────────────────────────────

function detectTool(lines) {
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const t = line.type;
    if (typeof t === "string") {
      if (CLAUDE_TYPES.has(t)) return "claude";
      if (CODEX_STREAM_TYPES.has(t)) return "codex";
    }
    if (line.payload && typeof line.payload === "object" && typeof line.payload.type === "string") {
      return "codex";
    }
    // First non-blank object that isn't a known shape — bail.
    return null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Claude transcript parser
// ──────────────────────────────────────────────────────────────────────

function parseClaude(lines) {
  let input_tokens = 0;
  let cache_read_tokens = 0;
  let cache_creation_tokens = 0;
  let output_tokens = 0;
  let assistant_messages = 0;
  let end_turn_count = 0;
  let user_turns = 0;
  let thinking_blocks = 0;
  let retry_count = 0;
  const requestIds = new Set();
  const timestamps = [];
  const toolCallsByName = {};
  let tool_calls_total = 0;
  const toolUseById = new Map(); // id → { name, file_path }
  const toolResults = []; // { tool_use_id, is_error }
  const readsByFile = new Map(); // path → count
  const filesWritten = new Set();
  const filesEdited = new Set();
  const filesRead = new Set();
  let human_questions = 0;
  let tool_version = "unknown";
  let model = null;
  let toolName = "claude";

  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (typeof line.timestamp === "string") {
      const ms = Date.parse(line.timestamp);
      if (!Number.isNaN(ms)) timestamps.push(ms);
    }
    if (typeof line.cliVersion === "string" && tool_version === "unknown") {
      tool_version = `claude-code ${line.cliVersion}`;
    }
    if (typeof line.version === "string" && tool_version === "unknown") {
      tool_version = `claude-code ${line.version}`;
    }

    if (line.type === "assistant" && line.message && typeof line.message === "object") {
      assistant_messages++;
      const msg = line.message;
      if (typeof msg.model === "string" && !model) model = msg.model;
      if (msg.stop_reason === "end_turn") end_turn_count++;
      if (typeof line.requestId === "string") requestIds.add(line.requestId);
      const msgUsage = msg.usage;
      if (msgUsage && typeof msgUsage === "object") {
        input_tokens += Number(msgUsage.input_tokens) || 0;
        cache_read_tokens += Number(msgUsage.cache_read_input_tokens) || 0;
        cache_creation_tokens += Number(msgUsage.cache_creation_input_tokens) || 0;
        output_tokens += Number(msgUsage.output_tokens) || 0;
        if (Array.isArray(msgUsage.iterations)) {
          retry_count += Math.max(0, msgUsage.iterations.length - 1);
        }
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      let matchedQuestion = false;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          tool_calls_total++;
          const name = typeof block.name === "string" ? block.name : "unknown";
          toolCallsByName[name] = (toolCallsByName[name] || 0) + 1;
          const id = block.id;
          const input = block.input ?? {};
          toolUseById.set(id, { name, input });
          const file_path = typeof input.file_path === "string" ? input.file_path : null;
          if (file_path) {
            if (name === "Read") {
              readsByFile.set(file_path, (readsByFile.get(file_path) || 0) + 1);
              filesRead.add(file_path);
            } else if (name === "Write") {
              filesWritten.add(file_path);
            } else if (name === "Edit" || name === "NotebookEdit") {
              filesEdited.add(file_path);
            }
          }
        } else if (block.type === "thinking") {
          thinking_blocks++;
        } else if (block.type === "text" && typeof block.text === "string" && !matchedQuestion) {
          if (HUMAN_QUESTION_PATTERNS.some((re) => re.test(block.text))) {
            human_questions++;
            matchedQuestion = true;
          }
        }
      }
    } else if (line.type === "user" && line.message && typeof line.message === "object") {
      const msg = line.message;
      if (msg.role === "user" && line.isMeta !== true && typeof msg.content === "string") {
        user_turns++;
      }
      // Tool results (content is an array of tool_result blocks)
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && block.type === "tool_result") {
            toolResults.push({
              tool_use_id: block.tool_use_id,
              is_error: block.is_error === true,
            });
          }
        }
      }
    }
  }

  // Failed tool calls — count by joining tool_use_id back to tool_use entries
  let failed_tool_calls = 0;
  for (const r of toolResults) {
    if (r.is_error) failed_tool_calls++;
  }

  // Repeat reads — for each file read >1, count (n - 1)
  let repeat_reads = 0;
  for (const count of readsByFile.values()) {
    if (count > 1) repeat_reads += count - 1;
  }

  // Cap human questions at 99
  if (human_questions > 99) human_questions = 99;

  const wall_clock_s =
    timestamps.length > 0
      ? Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1000)
      : 0;
  const date =
    timestamps.length > 0
      ? new Date(Math.min(...timestamps)).toISOString()
      : new Date().toISOString();

  // Files touched (Write/Edit only; reads are not "touched")
  const filesTouched = new Set([...filesWritten, ...filesEdited]);

  const cache_total_input = cache_read_tokens + cache_creation_tokens + input_tokens;
  const cache_hit_rate =
    cache_total_input > 0 ? Number((cache_read_tokens / cache_total_input).toFixed(3)) : 0;

  return {
    tool: toolName,
    tool_version,
    model,
    date,
    wall_clock_s,
    turns: end_turn_count > 0 ? end_turn_count : user_turns,
    assistant_messages,
    end_turn_count,
    tool_calls_total,
    tool_calls_by_name: toolCallsByName,
    tokens_in: input_tokens,
    tokens_out: output_tokens,
    cache_read_tokens,
    cache_creation_tokens,
    cache_hit_rate,
    reasoning_tokens: null,
    files_touched_count: filesTouched.size,
    files_read: filesRead.size,
    files_written: filesWritten.size,
    files_edited: filesEdited.size,
    repeat_reads,
    failed_tool_calls,
    human_questions,
    request_count: requestIds.size,
    retry_count,
    thinking_blocks,
    subagent_count: 0,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Codex transcript parser
// ──────────────────────────────────────────────────────────────────────

function parseCodex(lines) {
  let input_tokens = 0;
  let cache_read_tokens = 0;
  let output_tokens = 0;
  let reasoning_tokens = 0;
  let user_turns = 0;
  let assistant_messages = 0;
  let tool_calls_total = 0;
  let failed_tool_calls = 0;
  const toolCallsByName = {};
  const timestamps = [];
  let model = null;
  let fallback_model = false;
  const filesRead = new Set();
  const filesWritten = new Set();
  const filesEdited = new Set();
  let human_questions = 0;
  let priorTotal = 0;

  const TOOL_ITEM_TYPES = new Set([
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
  ]);

  function ingestUsage(u) {
    if (!u || typeof u !== "object") return;
    input_tokens += Number(u.input_tokens) || 0;
    cache_read_tokens += Number(u.cached_input_tokens ?? u.cache_read_input_tokens) || 0;
    output_tokens += Number(u.output_tokens) || 0;
    reasoning_tokens += Number(u.reasoning_output_tokens) || 0;
  }

  for (const line of lines) {
    if (!line || typeof line !== "object") continue;

    if (typeof line.timestamp === "string") {
      const ms = Date.parse(line.timestamp);
      if (!Number.isNaN(ms)) timestamps.push(ms);
    }

    // Stream shape — events have top-level `type`
    if (typeof line.type === "string" && CODEX_STREAM_TYPES.has(line.type)) {
      if (line.type === "turn.started") user_turns++;
      else if (line.type === "turn.completed") {
        ingestUsage(line.usage);
        assistant_messages++;
      } else if (line.type === "item.completed") {
        const item = line.item ?? {};
        if (TOOL_ITEM_TYPES.has(item.type)) {
          tool_calls_total++;
          toolCallsByName[item.type] = (toolCallsByName[item.type] || 0) + 1;
          if (item.status === "failed") failed_tool_calls++;
          // Best-effort file path extraction
          const file_path = typeof item.path === "string" ? item.path : null;
          if (file_path) {
            if (item.type === "file_change") filesEdited.add(file_path);
          }
        } else if (item.type === "agent_message" && typeof item.text === "string") {
          if (HUMAN_QUESTION_PATTERNS.some((re) => re.test(item.text))) human_questions++;
        }
      }
      continue;
    }

    // Rollout shape — { timestamp, type, payload }
    if (line.payload && typeof line.payload === "object") {
      const p = line.payload;
      if (line.type === "event_msg") {
        if (p.type === "user_message") user_turns++;
        else if (p.type === "token_count") {
          const last = p.info?.last_token_usage;
          const total = p.info?.total_token_usage;
          if (last) {
            ingestUsage(last);
          } else if (total) {
            ingestUsage({
              input_tokens: (Number(total.input_tokens) || 0) - priorTotal,
            });
            priorTotal = Number(total.input_tokens) || priorTotal;
          }
          const ctxModel = p.info?.turn_context?.model;
          if (typeof ctxModel === "string" && !model) model = ctxModel;
        }
      } else if (line.type === "turn_context") {
        if (typeof p.model === "string" && !model) model = p.model;
      } else if (line.type === "response_item") {
        if (p.role === "assistant") assistant_messages++;
      }
    }
  }

  if (!model) {
    model = "gpt-5";
    fallback_model = true;
  }

  if (human_questions > 99) human_questions = 99;

  const wall_clock_s =
    timestamps.length > 0
      ? Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1000)
      : 0;
  const date =
    timestamps.length > 0
      ? new Date(Math.min(...timestamps)).toISOString()
      : new Date().toISOString();

  const filesTouched = new Set([...filesWritten, ...filesEdited]);

  return {
    tool: "codex",
    tool_version: "codex-cli unknown",
    model,
    date,
    wall_clock_s,
    turns: user_turns,
    assistant_messages,
    end_turn_count: assistant_messages,
    tool_calls_total,
    tool_calls_by_name: toolCallsByName,
    tokens_in: input_tokens,
    tokens_out: output_tokens,
    cache_read_tokens,
    cache_creation_tokens: 0,
    cache_hit_rate: null,
    reasoning_tokens,
    files_touched_count: filesTouched.size,
    files_read: filesRead.size,
    files_written: filesWritten.size,
    files_edited: filesEdited.size,
    repeat_reads: 0,
    failed_tool_calls,
    human_questions,
    request_count: assistant_messages,
    retry_count: 0,
    thinking_blocks: 0,
    subagent_count: 0,
    fallback_model,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Acceptance + diff
// ──────────────────────────────────────────────────────────────────────

function summarizeAcceptance(acc) {
  const bullets = Array.isArray(acc?.bullets) ? acc.bullets : [];
  const total = bullets.length;
  const passed = bullets.filter((b) => b?.pass === true).length;
  const pass_rate = total > 0 ? passed / total : 0;
  const findBullet = (id) => bullets.find((b) => b?.id === id);
  const tc = findBullet("typecheck");
  const lint = findBullet("lint");
  const test = findBullet("test");
  const failing = bullets.filter((b) => b?.pass === false);
  return {
    app: typeof acc?.app === "string" ? acc.app : "unknown",
    pass_count: passed,
    pass_total: total,
    pass_rate,
    all_pass: total > 0 && passed === total,
    compile_pass: tc?.pass === true ? 1 : 0,
    lint_pass: lint?.pass === true ? 1 : 0,
    test_pass: test?.pass === true ? 1 : 0,
    failing,
  };
}

function detectAntiPatterns(diffText) {
  if (!diffText) return { hits: 0, skipped: true };
  let hits = 0;
  let pkgJsonBlock = null;
  let inPkgJson = false;
  const pkgJsonLines = [];

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
      if (inPkgJson) {
        pkgJsonBlock = pkgJsonLines.join("\n");
      }
      inPkgJson = line.endsWith("package.json");
      if (!inPkgJson) {
        pkgJsonLines.length = 0;
      }
      continue;
    }
    if (inPkgJson) pkgJsonLines.push(line);
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const added = line.slice(1);
    // Branded-type widens in apps/server/src or apps/web/src — we look
    // at the file context from the most recent `+++ b/` header. Simpler
    // approximation: count anywhere in the diff; cap saturates anyway.
    if (/\bas (string|number)\b/.test(added)) hits++;
    if (/\.skip\(|test\.skip\(|it\.skip\(/.test(added)) hits++;
  }
  if (inPkgJson && pkgJsonLines.length > 0) {
    pkgJsonBlock = pkgJsonLines.join("\n");
  }

  // Parse package.json post-state for out-of-allowlist deps.
  if (pkgJsonBlock) {
    // Reconstruct post-state by taking lines that don't start with '-'.
    const postLines = pkgJsonBlock
      .split(/\r?\n/)
      .filter((l) => !l.startsWith("-") || l.startsWith("---"))
      .map((l) => (l.startsWith("+") && !l.startsWith("+++") ? l.slice(1) : l));
    const post = postLines.join("\n");
    try {
      // The slice we have may be a hunk — find the dependencies object directly.
      const depMatch = post.match(/"dependencies"\s*:\s*\{([\s\S]*?)\}/);
      if (depMatch) {
        const body = depMatch[1];
        const nameRe = /"([^"]+)"\s*:\s*"[^"]*"/g;
        let m;
        while ((m = nameRe.exec(body)) !== null) {
          if (!DEP_ALLOWLIST.has(m[1])) hits++;
        }
      }
    } catch {
      // ignore parse failures
    }
  }

  return { hits, skipped: false };
}

function diffLocChanged(diffText) {
  if (!diffText) return 0;
  let count = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) count++;
  }
  return count;
}

// ──────────────────────────────────────────────────────────────────────
// Pricing + score
// ──────────────────────────────────────────────────────────────────────

function computeCost(model, parsed) {
  let pricing = PRICING[model];
  let fallback = false;
  if (!pricing) {
    fallback = true;
    pricing = parsed.tool === "claude" ? PRICING["claude-opus-4-7"] : PRICING["gpt-5"];
  }
  let cost =
    (parsed.tokens_in * pricing.input) / 1e6 +
    (parsed.cache_read_tokens * pricing.cached_input) / 1e6 +
    (parsed.tokens_out * pricing.output) / 1e6;
  if (pricing.cache_creation != null) {
    cost += (parsed.cache_creation_tokens * pricing.cache_creation) / 1e6;
  }
  return { cost_usd: Number(cost.toFixed(4)), fallback };
}

function computeScore(m) {
  if (m.compile_pass !== 1) return 0;

  const P10 = 0.05;
  const P90 = 2.0;
  const effort_score = Math.max(0, Math.min(1, 1 - (m.cost_usd - P10) / (P90 - P10)));

  const friction_norm = Math.max(
    0,
    Math.min(1, (m.repeat_reads + m.failed_tool_calls + 3 * m.human_questions) / 20),
  );

  const human_edit_norm = Math.max(0, Math.min(1, m.human_edit_loc / 200));
  const anti_pattern_norm = Math.max(0, Math.min(1, m.anti_pattern_hits / 5));

  return (
    40 * m.pass_rate +
    15 * m.lint_pass +
    15 * m.test_pass +
    10 * effort_score +
    8 * (1 - friction_norm) +
    7 * (1 - human_edit_norm) +
    5 * (1 - anti_pattern_norm)
  );
}

// ──────────────────────────────────────────────────────────────────────
// Output formatting
// ──────────────────────────────────────────────────────────────────────

function fmtNumber(n) {
  if (n == null) return "—";
  if (typeof n !== "number") return String(n);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function renderMarkdown(metrics, ctx) {
  const score = Math.round(metrics.score);
  const scoreLine = `**${score}** / 100`;
  const compile_glyph = metrics.compile_pass ? "✓" : "✗";
  const lint_glyph = metrics.lint_pass ? "✓" : "✗";
  const test_glyph = metrics.test_pass ? "✓" : "✗";
  const cacheRow = metrics.cache_hit_rate == null ? "—" : metrics.cache_hit_rate.toFixed(3);
  const oneLine =
    `${metrics.app}   ${metrics.tool}-${metrics.model || "unknown"}   score=${score}` +
    `  pass=${metrics.pass_count}/${metrics.pass_total}` +
    `  comp=${compile_glyph} lint=${lint_glyph} test=${test_glyph}` +
    `  cost=$${metrics.cost_usd.toFixed(2)}` +
    `  turns=${metrics.turns}` +
    `  files=${metrics.files_touched}` +
    `  fric=${metrics.repeat_reads + metrics.failed_tool_calls + metrics.human_questions}` +
    `  edits=${metrics.human_edit_loc}loc`;

  const lines = [];
  lines.push(
    `# Scaffolding score — ${metrics.app} / ${metrics.tool} / ${metrics.model || "unknown"}`,
  );
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Score | ${scoreLine} |`);
  lines.push(`| Tool | ${metrics.tool_version} |`);
  lines.push(`| Model | ${metrics.model || "unknown"} |`);
  lines.push(`| Date (UTC) | ${metrics.date} |`);
  lines.push(`| Wall clock | ${metrics.wall_clock_s} s |`);
  lines.push(`| App | ${metrics.app} |`);
  lines.push(`| Acceptance | ${metrics.pass_count} of ${metrics.pass_total} bullets pass |`);
  lines.push("");
  lines.push("## One-line row");
  lines.push("");
  lines.push("```");
  lines.push(oneLine);
  lines.push("```");
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| pass_rate | ${metrics.pass_rate.toFixed(3)} |`);
  lines.push(`| compile_pass | ${metrics.compile_pass} |`);
  lines.push(`| lint_pass | ${metrics.lint_pass} |`);
  lines.push(`| test_pass | ${metrics.test_pass} |`);
  lines.push(`| turns | ${metrics.turns} |`);
  lines.push(`| tool_calls | ${metrics.tool_calls_total} |`);
  lines.push(`| wall_clock_s | ${metrics.wall_clock_s} |`);
  lines.push(`| tokens_in | ${fmtNumber(metrics.tokens_in)} |`);
  lines.push(`| tokens_out | ${fmtNumber(metrics.tokens_out)} |`);
  lines.push(`| cache_read_tokens | ${fmtNumber(metrics.cache_read_tokens)} |`);
  lines.push(`| cache_creation_tokens | ${fmtNumber(metrics.cache_creation_tokens)} |`);
  lines.push(`| cache_hit_rate | ${cacheRow} |`);
  lines.push(`| cost_usd | ${metrics.cost_usd.toFixed(2)} |`);
  lines.push(`| files_touched | ${metrics.files_touched} |`);
  lines.push(`| repeat_reads | ${metrics.repeat_reads} |`);
  lines.push(`| failed_tool_calls | ${metrics.failed_tool_calls} |`);
  lines.push(`| human_questions | ${metrics.human_questions} |`);
  lines.push(`| anti_pattern_hits | ${metrics.anti_pattern_hits} |`);
  lines.push(`| human_edit_loc | ${metrics.human_edit_loc} |`);
  lines.push("");

  if (ctx.failing.length > 0) {
    lines.push("## What went wrong");
    lines.push("");
    for (const b of ctx.failing) {
      const id = b?.id ?? "unknown";
      const stderr = truncate(typeof b?.stderr === "string" ? b.stderr : "", 300);
      lines.push(`- **${id}** — ${stderr}`);
    }
    lines.push("");
  }

  if (ctx.antiPatternSkipped) {
    lines.push("> Note: Anti-pattern check skipped — no diff supplied.");
    lines.push("");
  }
  if (metrics.cost_pricing_fallback) {
    lines.push("> Note: Cost estimate uses fallback pricing.");
    lines.push("");
  }

  if (ctx.envText) {
    lines.push("## Run header (verbatim)");
    lines.push("");
    lines.push("```");
    lines.push(ctx.envText.trim());
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n${usage()}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (!args.transcript || !args.acceptance) {
    process.stderr.write(`error: --transcript and --acceptance are required\n${usage()}\n`);
    return 1;
  }

  let lines;
  try {
    lines = await readJsonl(args.transcript);
  } catch (err) {
    process.stderr.write(`error: failed to read transcript ${args.transcript}: ${err.message}\n`);
    return 1;
  }
  let acceptance;
  try {
    acceptance = await readJson(args.acceptance);
  } catch (err) {
    process.stderr.write(`error: failed to read acceptance ${args.acceptance}: ${err.message}\n`);
    return 1;
  }

  let tool = args.tool;
  if (tool === "auto" || tool == null) {
    tool = detectTool(lines);
    if (tool == null) {
      process.stderr.write(
        `error: unrecognized transcript shape in ${args.transcript}; expected Claude Code JSONL or Codex CLI JSONL\n`,
      );
      return 2;
    }
  }

  let parsed;
  try {
    parsed = tool === "claude" ? parseClaude(lines) : parseCodex(lines);
  } catch (err) {
    process.stderr.write(`error: parser threw on ${tool} transcript: ${err.message}\n`);
    return 1;
  }

  const acc = summarizeAcceptance(acceptance);

  const diffText = args.diff ? await tryReadText(args.diff) : null;
  const envText = args.env ? await tryReadText(args.env) : null;
  const anti = detectAntiPatterns(diffText);
  const human_edit_loc = diffLocChanged(diffText);

  const { cost_usd, fallback } = computeCost(parsed.model, parsed);

  const metrics = {
    schema_version: 1,
    score: 0,
    compile_pass: acc.compile_pass,
    all_pass: acc.all_pass,
    pass_rate: acc.pass_rate,
    pass_count: acc.pass_count,
    pass_total: acc.pass_total,
    lint_pass: acc.lint_pass,
    test_pass: acc.test_pass,
    tool: parsed.tool,
    tool_version: parsed.tool_version,
    model: parsed.model || "unknown",
    date: parsed.date,
    app: acc.app,
    wall_clock_s: parsed.wall_clock_s,
    turns: parsed.turns,
    assistant_messages: parsed.assistant_messages,
    end_turn_count: parsed.end_turn_count,
    tool_calls_total: parsed.tool_calls_total,
    tool_calls_by_name: parsed.tool_calls_by_name,
    tokens_in: parsed.tokens_in,
    tokens_out: parsed.tokens_out,
    cache_read_tokens: parsed.cache_read_tokens,
    cache_creation_tokens: parsed.cache_creation_tokens,
    cache_hit_rate: parsed.cache_hit_rate,
    reasoning_tokens: parsed.reasoning_tokens,
    cost_usd,
    cost_pricing_fallback: fallback,
    files_touched: parsed.files_touched_count,
    files_read: parsed.files_read,
    files_written: parsed.files_written,
    files_edited: parsed.files_edited,
    repeat_reads: parsed.repeat_reads,
    failed_tool_calls: parsed.failed_tool_calls,
    human_questions: parsed.human_questions,
    anti_pattern_hits: anti.hits,
    human_edit_loc,
    request_count: parsed.request_count,
    retry_count: parsed.retry_count,
    thinking_blocks: parsed.thinking_blocks,
    subagent_count: parsed.subagent_count,
    fallback_model: parsed.fallback_model === true,
  };

  metrics.score = computeScore(metrics);

  const md = renderMarkdown(metrics, {
    failing: acc.failing,
    antiPatternSkipped: anti.skipped,
    envText,
  });

  const transcriptDir = dirname(resolvePath(args.transcript));
  const outPath = args.out ? resolvePath(args.out) : resolvePath(transcriptDir, "score.md");
  const metricsPath = args.metrics
    ? resolvePath(args.metrics)
    : resolvePath(transcriptDir, "metrics.json");

  try {
    await writeFile(outPath, md, "utf8");
    await writeFile(metricsPath, JSON.stringify(metrics, null, 2) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`error: failed to write outputs: ${err.message}\n`);
    return 1;
  }

  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
