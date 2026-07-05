/**
 * Bolt-on agent-rules writer. The CLI enables this by default for
 * existing wrangler projects and lets users opt out with
 * `--no-agent-rules`. It drops a delimited block that tells the user's
 * AI agent (Claude / Cursor / Copilot) that
 * `node_modules/@gusto/baerly-storage/dist/API.md` is the canonical API
 * surface and that the patterns those agents' training data is densest
 * with (Postgres/Prisma/Drizzle, Mongo, Firebase) don't apply.
 *
 * Scaffolded apps already get this via the per-template `AGENTS.md`
 * shipped by `scaffold()`. This module is for the bolt-on path —
 * `pnpm create @gusto/baerly-storage@latest .` in an existing wrangler
 * project — where no template file is copied.
 *
 * Target detection (first match wins):
 *   1. `.claude/rules/` exists → write `.claude/rules/baerly.md`.
 *   2. `AGENTS.md` exists at repo root → append a delimited block.
 *   3. `.cursor/rules/` exists → write `.cursor/rules/baerly.md`.
 *   4. None of the above → create `AGENTS.md` at repo root.
 *
 * Idempotent: a second run with the same target replaces the
 * delimited block in place rather than duplicating it.
 */

import { constants } from "node:fs";
import { mkdir, readFile, writeFile, access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BLOCK_START = "<!-- baerly:start -->";
const BLOCK_END = "<!-- baerly:end -->";

/**
 * The literal block content emitted into the chosen target file.
 * Wording mirrors the per-template `AGENTS.md` preamble shipped by
 * `scaffold()` so an agent dropped into a bolt-on repo gets the
 * same orientation a scaffolded-app agent gets.
 *
 * Wrapped in `BLOCK_START` / `BLOCK_END` so a second run replaces
 * in place.
 */
const AGENT_RULES_BLOCK = `${BLOCK_START}
## @gusto/baerly-storage

This repo uses @gusto/baerly-storage. Before writing or modifying storage code:

- Read **\`node_modules/@gusto/baerly-storage/dist/API.md\`** — public-API
  quickref. Every method, every error code, every example. If a
  pattern you want to use is not here, it does not exist in baerly.
- Common mistakes keyed by the exact error string live in
  \`node_modules/@gusto/baerly-storage/dist/RECIPES.md\`.
- Type contracts live in \`node_modules/@gusto/baerly-storage/dist/*.d.ts\`.
  The whole API is \`Db\`, \`Collection<T>\`, \`Query<T>\`, and \`Predicate<T>\`.

Anti-patterns that compile but are wrong:

- \`db.collection(...).insertOne(...)\` — no such method. Use
  \`db.collection(...).insert(...)\`.
- \`.useIndex("name")\` — does not exist. The query planner picks
  indexes automatically from registered \`IndexDefinition\`s.
- \`z.string().nullable()\` — \`DocumentValue\` excludes \`null\`. Use
  \`.optional()\`; \`null\` in update patches is the RFC 7386 deletion
  sentinel.
- SQL strings, raw \`WHERE\` clauses — the API is a method-chain
  only: \`.where({ field: value }).all()\` (object literal, equality)
  or \`.where(q => q.gte("field", n)).all()\` (callback DSL,
  operators: \`eq\` / \`gt\` / \`gte\` / \`lt\` / \`lte\` / \`in\`).
- \`.all()\` on a hot path — page or cursor-iterate. \`.all()\` is for
  bounded result sets only.
${BLOCK_END}
`;

type AgentRulesAction = "created" | "appended" | "replaced";

export interface AgentRulesResult {
  /** Absolute path of the file written. */
  readonly path: string;
  readonly action: AgentRulesAction;
}

/**
 * Target-file resolution. Exported for tests; callers should use
 * `writeAgentRulesBlock` directly.
 */
interface AgentRulesTarget {
  /** Absolute path. */
  readonly path: string;
  /**
   * `dedicated` → write a fresh file owned entirely by us (we are
   * inside `.claude/rules/` or `.cursor/rules/`). `shared` → append
   * to / replace inside a file the user may also edit (root
   * `AGENTS.md`).
   */
  readonly mode: "dedicated" | "shared";
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const dirExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
};

const detectAgentRulesTarget = async (outDir: string): Promise<AgentRulesTarget> => {
  if (await dirExists(resolve(outDir, ".claude", "rules"))) {
    return { path: resolve(outDir, ".claude", "rules", "baerly.md"), mode: "dedicated" };
  }
  if (await fileExists(resolve(outDir, "AGENTS.md"))) {
    return { path: resolve(outDir, "AGENTS.md"), mode: "shared" };
  }
  if (await dirExists(resolve(outDir, ".cursor", "rules"))) {
    return { path: resolve(outDir, ".cursor", "rules", "baerly.md"), mode: "dedicated" };
  }
  return { path: resolve(outDir, "AGENTS.md"), mode: "shared" };
};

/**
 * `Indices` plural intentionally: returns the indices of the first
 * START and the matching END so callers can slice surrounding
 * content cleanly. Returns null when the file has no managed block.
 */
const findBlockRange = (text: string): { start: number; end: number } | null => {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) {
    return null;
  }
  const endTag = text.indexOf(BLOCK_END, start + BLOCK_START.length);
  if (endTag === -1) {
    return null;
  }
  return { start, end: endTag + BLOCK_END.length };
};

export const writeAgentRulesBlock = async (outDir: string): Promise<AgentRulesResult> => {
  const target = await detectAgentRulesTarget(outDir);

  if (target.mode === "dedicated") {
    // .claude/rules/ or .cursor/rules/ — we own the whole file.
    // First run: `created`. Second run: `replaced` (idempotent
    // overwrite is byte-identical since the block constant is the
    // whole file).
    await mkdir(dirname(target.path), { recursive: true });
    const existed = await fileExists(target.path);
    await writeFile(target.path, AGENT_RULES_BLOCK, "utf8");
    return { path: target.path, action: existed ? "replaced" : "created" };
  }

  // Shared mode: AGENTS.md at repo root. Three sub-cases.
  if (!(await fileExists(target.path))) {
    await writeFile(target.path, AGENT_RULES_BLOCK, "utf8");
    return { path: target.path, action: "created" };
  }

  const existing = await readFile(target.path, "utf8");
  const range = findBlockRange(existing);
  if (range !== null) {
    const before = existing.slice(0, range.start);
    const after = existing.slice(range.end);
    // Drop the leading newline of our block when the preceding text
    // already ends with one — keeps replace byte-identical to the
    // append case.
    const trimmedBlock = before.endsWith("\n")
      ? AGENT_RULES_BLOCK.replace(/\n$/, "")
      : `\n${AGENT_RULES_BLOCK.replace(/\n$/, "")}`;
    await writeFile(target.path, `${before}${trimmedBlock}${after}`, "utf8");
    return { path: target.path, action: "replaced" };
  }

  // Append. Ensure the user's existing content is byte-identical
  // before the appended block: introduce a single blank-line gap
  // when the existing file doesn't already end with `\n\n`.
  let gap: string;
  if (existing.endsWith("\n\n")) {
    gap = "";
  } else if (existing.endsWith("\n")) {
    gap = "\n";
  } else {
    gap = "\n\n";
  }
  await writeFile(target.path, `${existing}${gap}${AGENT_RULES_BLOCK}`, "utf8");
  return { path: target.path, action: "appended" };
};
