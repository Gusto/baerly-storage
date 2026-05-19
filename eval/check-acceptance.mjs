#!/usr/bin/env node
/**
 * Per-app acceptance checker for the scaffolding eval.
 *
 * Walks a scaffolded app for the binary acceptance criteria of one of
 * the seven corpus apps (`todo`, `notes`, `rsvp`, `chat`, `shortlink`,
 * `kanban`, `bookmarks`) and emits an `acceptance.json` document on
 * stdout. Zero runtime deps — pure Node 22+ APIs (`node:child_process`
 * + `node:fs/promises` + `node:fs` + `node:path`).
 *
 * Usage:
 *   node eval/check-acceptance.mjs <app> [<scaffold-root>]
 *
 * `<scaffold-root>` defaults to `process.cwd()`. Output goes to stdout
 * (`> acceptance.json` to capture).
 *
 * Exit codes:
 *   0 — checker ran to completion; JSON is on stdout (independent of
 *       whether the scaffold passed; even a totally broken scaffold
 *       returns 0 with `pass: false` on every bullet).
 *   1 — invalid CLI args (unknown app, missing scaffold root).
 *   2 — internal error (failed to spawn `pnpm`, etc.).
 *
 * Bullet states:
 *   `pass: true`   — criterion satisfied.
 *   `pass: false`  — criterion checked and failed; `stderr` carries
 *                    diagnostic (truncated to ~4 KB).
 *   `pass: null`   — not tested by the harness (live HTTP probes,
 *                    interactive checks, deferred to ticket 84).
 *                    The scoring script's denominator filters these
 *                    out, so they are invisible to the score.
 *
 * Spec: `.claude/research/planning/tickets/81-check-acceptance-script.md`.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".baerly", "build", "out"]);

const SPAWN_TIMEOUT_MS = 120_000;
const STDERR_CAP = 4096;

const VALID_APPS = ["todo", "notes", "rsvp", "chat", "shortlink", "kanban", "bookmarks"];

// ──────────────────────────────────────────────────────────────────────
// Shell + grep primitives
// ──────────────────────────────────────────────────────────────────────

async function run(cmd, args, cwd) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, SPAWN_TIMEOUT_MS);

  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: ac.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return { code: 127, stdout: "", stderr: String(error).slice(0, STDERR_CAP) };
  }

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });

  try {
    const [code] = await once(proc, "close");
    return {
      code: code ?? 1,
      stdout,
      stderr: (timedOut ? `timed out after ${SPAWN_TIMEOUT_MS / 1000}s` : stderr).slice(
        0,
        STDERR_CAP,
      ),
    };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: (timedOut ? `timed out after ${SPAWN_TIMEOUT_MS / 1000}s` : String(error)).slice(
        0,
        STDERR_CAP,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

function walk(root, exts) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent)) {
        continue;
      }
      const p = join(dir, ent);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        visit(p);
      } else if (exts.some((e) => ent.endsWith(e))) {
        out.push(p);
      }
    }
  };
  if (existsSync(root)) {
    visit(root);
  }
  return out;
}

async function grepCount(root, exts, pattern) {
  let total = 0;
  for (const f of walk(root, exts)) {
    let content;
    try {
      content = await readFile(f, "utf8");
    } catch {
      continue;
    }
    const matches = content.match(pattern);
    if (matches) {
      total += matches.length;
    }
  }
  return total;
}

async function grepCoOccurFile(root, exts, regexA, regexB) {
  for (const f of walk(root, exts)) {
    let content;
    try {
      content = await readFile(f, "utf8");
    } catch {
      continue;
    }
    if (regexA.test(content) && regexB.test(content)) {
      return true;
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Bullet factories
// ──────────────────────────────────────────────────────────────────────

function shellBullet(id, cmd, args) {
  return async ({ root }) => {
    const cmdResult = await run(cmd, args, root);
    if (cmdResult.code === 0) {
      return { id, pass: true, stderr: "" };
    }
    const tail =
      cmdResult.stderr.length > 0 ? cmdResult.stderr : cmdResult.stdout.slice(-STDERR_CAP);
    return {
      id,
      pass: false,
      stderr: `${cmd} ${args.join(" ")} exit ${cmdResult.code}: ${tail}`.slice(0, STDERR_CAP),
    };
  };
}

function grepZeroBullet(id, exts, regex, subdir) {
  return async ({ root }) => {
    const target = subdir ? join(root, subdir) : root;
    const hits = await grepCount(target, exts, regex);
    if (hits === 0) {
      return { id, pass: true, stderr: "" };
    }
    return {
      id,
      pass: false,
      stderr: `expected zero matches for ${regex} under ${subdir ?? "."}, found ${hits}`,
    };
  };
}

function grepAnyBullet(id, exts, regex, subdir) {
  return async ({ root }) => {
    const target = subdir ? join(root, subdir) : root;
    const hits = await grepCount(target, exts, regex);
    if (hits > 0) {
      return { id, pass: true, stderr: "" };
    }
    return {
      id,
      pass: false,
      stderr: `no matches for ${regex} under ${subdir ?? "."}`,
    };
  };
}

function grepCoOccurBullet(id, exts, regexA, regexB, subdir) {
  return async ({ root }) => {
    const target = subdir ? join(root, subdir) : root;
    const found = await grepCoOccurFile(target, exts, regexA, regexB);
    if (found) {
      return { id, pass: true, stderr: "" };
    }
    return {
      id,
      pass: false,
      stderr: `${regexA} and ${regexB} did not co-occur in any file under ${subdir ?? "."}`,
    };
  };
}

function crudPresentBullet(id, tableName) {
  return async ({ root }) => {
    const target = join(root, "apps/server/src");
    const tableRegex = new RegExp(`["']${tableName}["']`);
    const tableHits = await grepCount(target, [".ts"], tableRegex);
    const verbs = ["insert", "update", "delete", "where"];
    const missing = [];
    if (tableHits === 0) {
      missing.push(`"${tableName}" table-name literal`);
    }
    for (const verb of verbs) {
      const verbHits = await grepCount(target, [".ts"], new RegExp(`\\b${verb}\\b`));
      if (verbHits === 0) {
        missing.push(verb);
      }
    }
    if (missing.length === 0) {
      return { id, pass: true, stderr: "" };
    }
    return {
      id,
      pass: false,
      stderr: `apps/server/src/ missing: ${missing.join(", ")}`,
    };
  };
}

function nullBullet(id, reason) {
  return async () => ({ id, pass: null, stderr: reason });
}

// Composite `test` bullet: spawn `pnpm test`; if exit 0 AND `wantsCoOccur`
// is set, additionally check that *some* test file under the scaffold
// contains both `insert` and the given table name (a heuristic "did the
// agent write an insert-then-read test").
function testBullet({ tableName }) {
  return async ({ root }) => {
    const cmdResult = await run("pnpm", ["test"], root);
    if (cmdResult.code !== 0) {
      const tail =
        cmdResult.stderr.length > 0 ? cmdResult.stderr : cmdResult.stdout.slice(-STDERR_CAP);
      return {
        id: "test",
        pass: false,
        stderr: `pnpm test exit ${cmdResult.code}: ${tail}`.slice(0, STDERR_CAP),
      };
    }
    if (!tableName) {
      return { id: "test", pass: true, stderr: "" };
    }
    const insertHits = await grepCount(root, [".test.ts", ".test.tsx"], /insert/);
    const tableHits = await grepCount(root, [".test.ts", ".test.tsx"], new RegExp(tableName));
    if (insertHits > 0 && tableHits > 0) {
      return { id: "test", pass: true, stderr: "" };
    }
    return {
      id: "test",
      pass: false,
      stderr: `tests passed but no insert-then-read coverage for ${tableName} was found`,
    };
  };
}

// Composite bullet: a real (non-`sharedSecret`-only) verifier is wired.
function realVerifierBullet() {
  return async ({ root }) => {
    const target = join(root, "apps/server/src");
    const realRegex = /cloudflareAccess|bearerJwt/;
    const sharedRegex = /sharedSecret/;
    const files = walk(target, [".ts"]);
    let sawReal = false;
    for (const f of files) {
      let content;
      try {
        content = await readFile(f, "utf8");
      } catch {
        continue;
      }
      if (realRegex.test(content)) {
        sawReal = true;
        break;
      }
    }
    if (sawReal) {
      return { id: "real_verifier", pass: true, stderr: "" };
    }
    // Distinguish "only sharedSecret" from "no verifier at all" for the message.
    const sharedHits = await grepCount(target, [".ts"], sharedRegex);
    const reason =
      sharedHits > 0
        ? "only sharedSecret is wired; rsvp requires cloudflareAccess or bearerJwt"
        : "no verifier (sharedSecret/cloudflareAccess/bearerJwt) found in apps/server/src/";
    return { id: "real_verifier", pass: false, stderr: reason };
  };
}

// Heuristic proximity check: regex `near` regex within `windowLines` lines.
function grepProximityBullet({ id, exts, anchor, near, windowLines, subdir, mode }) {
  return async ({ root }) => {
    const target = subdir ? join(root, subdir) : root;
    let anyAnchor = false;
    let proximityHit = false;
    for (const f of walk(target, exts)) {
      let content;
      try {
        content = await readFile(f, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (anchor.test(lines[i])) {
          anyAnchor = true;
          const end = Math.min(lines.length, i + windowLines + 1);
          for (let j = i; j < end; j++) {
            if (near.test(lines[j])) {
              proximityHit = true;
              break;
            }
          }
          if (proximityHit) {
            break;
          }
        }
      }
      if (proximityHit) {
        break;
      }
    }
    if (mode === "expect-proximity") {
      if (proximityHit) {
        return { id, pass: true, stderr: "" };
      }
      const reason = anyAnchor
        ? `${anchor} found but no ${near} within ${windowLines} lines`
        : `no ${anchor} found under ${subdir ?? "."}`;
      return { id, pass: false, stderr: reason };
    }
    // mode === "expect-no-proximity"
    if (!proximityHit) {
      return { id, pass: true, stderr: "" };
    }
    return {
      id,
      pass: false,
      stderr: `${anchor} is followed by ${near} within ${windowLines} lines — should not be`,
    };
  };
}

// `sender_from_verifier` for chat: pass if (sender AND any of sub/verifier/claim
// co-occur in apps/server/src/*.ts) OR if the schema has no sender_name field.
function senderFromVerifierBullet() {
  return async ({ root }) => {
    const target = join(root, "apps/server/src");
    const senderRegex = /sender/;
    const verifierRegex = /\bsub\b|verifier|claim/;
    const coOccur = await grepCoOccurFile(target, [".ts"], senderRegex, verifierRegex);
    if (coOccur) {
      return { id: "sender_from_verifier", pass: true, stderr: "" };
    }
    // Schema has no sender_name field — also acceptable.
    const senderName = await grepCount(target, [".ts"], /sender_name/);
    if (senderName === 0) {
      return { id: "sender_from_verifier", pass: true, stderr: "" };
    }
    return {
      id: "sender_from_verifier",
      pass: false,
      stderr:
        "sender_name appears in schema but no verifier identity wiring (sub/verifier/claim) was found",
    };
  };
}

// `no_busy_poll` for chat: zero `setInterval` near `.all()` (within 3 lines).
function noBusyPollBullet() {
  return grepProximityBullet({
    id: "no_busy_poll",
    exts: [".ts", ".tsx"],
    anchor: /setInterval/,
    near: /\.all\(\)/,
    windowLines: 3,
    subdir: "apps",
    mode: "expect-no-proximity",
  });
}

// `caller_supplied_id` for shortlink: `_id` AND `code` in a `.insert({...})`
// block — heuristic: same line or within 3 lines of a `.insert(` call.
function callerSuppliedIdBullet() {
  return async ({ root }) => {
    const target = join(root, "apps/server/src");
    for (const f of walk(target, [".ts"])) {
      let content;
      try {
        content = await readFile(f, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/\.insert\(\{/.test(lines[i])) {
          const end = Math.min(lines.length, i + 4);
          let hasId = false;
          let hasCode = false;
          for (let j = i; j < end; j++) {
            if (/_id\s*:/.test(lines[j])) {
              hasId = true;
            }
            if (/\bcode\b/.test(lines[j])) {
              hasCode = true;
            }
          }
          if (hasId && hasCode) {
            return { id: "caller_supplied_id", pass: true, stderr: "" };
          }
        }
      }
    }
    return {
      id: "caller_supplied_id",
      pass: false,
      stderr: "no .insert({...}) block in apps/server/src/ co-locates `_id:` with `code`",
    };
  };
}

// `no_unbounded_array` for shortlink: link doc type does NOT embed `clicks: []`.
function noUnboundedArrayBullet() {
  return async ({ root }) => {
    const candidates = [
      join(root, "apps/server/src/types.ts"),
      join(root, "apps/server/src/schema.ts"),
    ];
    // Also scan any file containing an `interface Link` block.
    const interfaceFiles = [];
    for (const f of walk(join(root, "apps"), [".ts"])) {
      let content;
      try {
        content = await readFile(f, "utf8");
      } catch {
        continue;
      }
      if (/interface\s+Link\b/.test(content)) {
        interfaceFiles.push(f);
      }
    }
    const seen = new Set();
    for (const f of [...candidates, ...interfaceFiles]) {
      if (seen.has(f)) {
        continue;
      }
      seen.add(f);
      if (!existsSync(f)) {
        continue;
      }
      let content;
      try {
        content = await readFile(f, "utf8");
      } catch {
        continue;
      }
      if (/clicks\??:\s*[^;,\n]*\[\]/.test(content)) {
        return {
          id: "no_unbounded_array",
          pass: false,
          stderr: `${f} embeds clicks as an array on the link doc`,
        };
      }
    }
    return { id: "no_unbounded_array", pass: true, stderr: "" };
  };
}

// `catches_conflict` for kanban: `"Conflict"` AND (catch OR BaerlyError) in
// the same file under apps/server/src/.
function catchesConflictBullet() {
  return async ({ root }) => {
    const target = join(root, "apps/server/src");
    const found = await grepCoOccurFile(
      target,
      [".ts"],
      /"Conflict"|'Conflict'/,
      /\bcatch\b|BaerlyError/,
    );
    if (found) {
      return { id: "catches_conflict", pass: true, stderr: "" };
    }
    return {
      id: "catches_conflict",
      pass: false,
      stderr: '"Conflict" did not co-occur with catch/BaerlyError in any apps/server/src/ file',
    };
  };
}

// `declares_by_tag_index` for notes: baerly.config.ts contains "by_tag" AND "tag".
function declaresByTagIndexBullet() {
  return async ({ root }) => {
    const cfg = join(root, "baerly.config.ts");
    if (!existsSync(cfg)) {
      return {
        id: "declares_by_tag_index",
        pass: false,
        stderr: "baerly.config.ts not found at scaffold root",
      };
    }
    let content;
    try {
      content = await readFile(cfg, "utf8");
    } catch (error) {
      return {
        id: "declares_by_tag_index",
        pass: false,
        stderr: `failed to read baerly.config.ts: ${error.message}`,
      };
    }
    if (/by_tag/.test(content) && /tag/.test(content)) {
      return { id: "declares_by_tag_index", pass: true, stderr: "" };
    }
    return {
      id: "declares_by_tag_index",
      pass: false,
      stderr: 'baerly.config.ts does not declare a "by_tag" index on "tag"',
    };
  };
}

// `by_domain_index` for bookmarks: baerly.config.ts declares the
// `by_domain` index on the bookmarks collection. The auto-planner
// picks the index off the config — the rubric no longer asserts a
// hand-written index-hint call.
function byDomainIndexBullet() {
  return async ({ root }) => {
    const cfg = join(root, "baerly.config.ts");
    if (!existsSync(cfg)) {
      return {
        id: "by_domain_index",
        pass: false,
        stderr: "baerly.config.ts is missing",
      };
    }
    let cfgHas = false;
    try {
      const content = await readFile(cfg, "utf8");
      cfgHas = /by_domain/.test(content);
    } catch {
      cfgHas = false;
    }
    if (cfgHas) {
      return { id: "by_domain_index", pass: true, stderr: "" };
    }
    return {
      id: "by_domain_index",
      pass: false,
      stderr: 'baerly.config.ts does not declare a "by_domain" index',
    };
  };
}

// `tags_string_array` for bookmarks.
function tagsStringArrayBullet() {
  return async ({ root }) => {
    const candidates = [join(root, "apps/server/src/types.ts")];
    for (const f of walk(join(root, "apps"), [".ts"])) {
      candidates.push(f);
    }
    const seen = new Set();
    for (const f of candidates) {
      if (seen.has(f)) {
        continue;
      }
      seen.add(f);
      if (!existsSync(f)) {
        continue;
      }
      let content;
      try {
        content = await readFile(f, "utf8");
      } catch {
        continue;
      }
      if (/interface\s+Bookmark\b/.test(content) || f.endsWith("types.ts")) {
        if (/tags\s*:\s*string\[\]/.test(content)) {
          return { id: "tags_string_array", pass: true, stderr: "" };
        }
      }
    }
    return {
      id: "tags_string_array",
      pass: false,
      stderr:
        "no `tags: string[]` field found on a Bookmark interface or in apps/server/src/types.ts",
    };
  };
}

// ──────────────────────────────────────────────────────────────────────
// Per-app dispatch table
// ──────────────────────────────────────────────────────────────────────

const APPS = {
  todo: {
    bullets: [
      shellBullet("typecheck", "pnpm", ["verify"]),
      shellBullet("lint", "pnpm", ["lint"]),
      testBullet({ tableName: "todos" }),
      grepZeroBullet("no_raw_access", [".ts", ".tsx"], /\bdb\._raw\b/, "apps"),
      grepAnyBullet("uses_table_api", [".ts", ".tsx"], /\bdb\.table\(/, "apps"),
      grepAnyBullet(
        "verifier_wired",
        [".ts"],
        /sharedSecret|bearerJwt|cloudflareAccess/,
        "apps/server/src",
      ),
      crudPresentBullet("crud_routes_present", "todos"),
      nullBullet("spa_renders", "Not tested by harness"),
    ],
  },
  notes: {
    bullets: [
      shellBullet("typecheck", "pnpm", ["verify"]),
      shellBullet("lint", "pnpm", ["lint"]),
      testBullet({}),
      grepZeroBullet("no_raw_access", [".ts", ".tsx"], /\bdb\._raw\b/, "apps"),
      grepAnyBullet("uses_table_api", [".ts", ".tsx"], /\bdb\.table\(/, "apps"),
      declaresByTagIndexBullet(),
      grepProximityBullet({
        id: "updated_at_maintained",
        exts: [".ts"],
        anchor: /\.update\(/,
        near: /updated_at/,
        windowLines: 5,
        subdir: "apps/server/src",
        mode: "expect-proximity",
      }),
      grepCoOccurBullet(
        "order_by_updated_at",
        [".ts", ".tsx"],
        /updated_at[\s\S]*?(?:desc|["']desc["'])/,
        /\.limit\(20\)|limit\(20\)/,
        "apps",
      ),
    ],
  },
  rsvp: {
    bullets: [
      shellBullet("typecheck", "pnpm", ["verify"]),
      shellBullet("lint", "pnpm", ["lint"]),
      testBullet({}),
      grepZeroBullet("no_raw_access", [".ts", ".tsx"], /\bdb\._raw\b/, "apps"),
      grepAnyBullet("uses_table_api", [".ts", ".tsx"], /\bdb\.table\(/, "apps"),
      realVerifierBullet(),
      grepAnyBullet(
        "created_by_on_doc",
        [".ts"],
        /created_by|createdBy|userId|sub:/,
        "apps/server/src",
      ),
      nullBullet("doctor_clean", "Not tested by harness"),
      nullBullet("anon_rejected", "Not tested by harness"),
    ],
  },
  chat: {
    bullets: [
      shellBullet("typecheck", "pnpm", ["verify"]),
      shellBullet("lint", "pnpm", ["lint"]),
      testBullet({}),
      grepZeroBullet("no_raw_access", [".ts", ".tsx"], /\bdb\._raw\b/, "apps"),
      grepAnyBullet("uses_table_api", [".ts", ".tsx"], /\bdb\.table\(/, "apps"),
      grepAnyBullet("long_poll_present", [".ts", ".tsx"], /useChanges|\.since\(/, "apps"),
      noBusyPollBullet(),
      senderFromVerifierBullet(),
      nullBullet("windows_sync", "Not tested by harness"),
    ],
  },
  shortlink: {
    bullets: [
      shellBullet("typecheck", "pnpm", ["verify"]),
      shellBullet("lint", "pnpm", ["lint"]),
      testBullet({}),
      grepZeroBullet("no_raw_access", [".ts", ".tsx"], /\bdb\._raw\b/, "apps"),
      grepAnyBullet("uses_table_api", [".ts", ".tsx"], /\bdb\.table\(/, "apps"),
      grepCoOccurBullet(
        "two_collections",
        [".ts"],
        /["']links["']/,
        /["']clicks["']/,
        "apps/server/src",
      ),
      callerSuppliedIdBullet(),
      grepAnyBullet("server_side_filter", [".ts"], /where\(\{\s*link_id/, "apps/server/src"),
      noUnboundedArrayBullet(),
    ],
  },
  kanban: {
    bullets: [
      shellBullet("typecheck", "pnpm", ["verify"]),
      shellBullet("lint", "pnpm", ["lint"]),
      testBullet({}),
      grepZeroBullet("no_raw_access", [".ts", ".tsx"], /\bdb\._raw\b/, "apps"),
      grepAnyBullet("uses_table_api", [".ts", ".tsx"], /\bdb\.table\(/, "apps"),
      grepAnyBullet("uses_transaction", [".ts"], /db\.transaction\(["']cards/, "apps/server/src"),
      catchesConflictBullet(),
      grepAnyBullet("eventual_on_fetch", [".ts", ".tsx"], /\.consistency\(["']eventual/, "apps"),
      grepAnyBullet("long_poll_present", [".ts", ".tsx"], /useChanges|\.since\(/, "apps"),
      nullBullet("drag_drop", "Not tested by harness"),
    ],
  },
  bookmarks: {
    bullets: [
      shellBullet("typecheck", "pnpm", ["verify"]),
      shellBullet("lint", "pnpm", ["lint"]),
      testBullet({}),
      grepZeroBullet("no_raw_access", [".ts", ".tsx"], /\bdb\._raw\b/, "apps"),
      grepAnyBullet("uses_table_api", [".ts", ".tsx"], /\bdb\.table\(/, "apps"),
      grepAnyBullet(
        "eventual_on_autorefresh",
        [".ts", ".tsx"],
        /\.consistency\(["']eventual/,
        "apps",
      ),
      grepProximityBullet({
        id: "strong_on_post_insert",
        exts: [".ts", ".tsx"],
        anchor: /\.insert\(/,
        near: /\.consistency\(["']eventual/,
        windowLines: 10,
        subdir: "apps",
        mode: "expect-no-proximity",
      }),
      grepProximityBullet({
        id: "domain_extracted_at_insert",
        exts: [".ts"],
        anchor: /\.insert\(\{/,
        near: /domain\s*:/,
        windowLines: 5,
        subdir: "apps/server/src",
        mode: "expect-proximity",
      }),
      byDomainIndexBullet(),
      tagsStringArrayBullet(),
    ],
  },
};

// ──────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────

function usage() {
  return [
    "Usage: node eval/check-acceptance.mjs <app> [<scaffold-root>]",
    `Valid apps: ${VALID_APPS.join(", ")}`,
  ].join("\n");
}

async function main(argv) {
  const [app, scaffoldRootArg] = argv;
  if (!app) {
    process.stderr.write(`error: <app> is required\n${usage()}\n`);
    return 1;
  }
  if (!Object.prototype.hasOwnProperty.call(APPS, app)) {
    process.stderr.write(`error: unknown app "${app}"\n${usage()}\n`);
    return 1;
  }
  const root = resolvePath(scaffoldRootArg ?? process.cwd());
  if (!existsSync(root)) {
    process.stderr.write(`error: scaffold root does not exist: ${root}\n`);
    return 1;
  }

  const spec = APPS[app];
  const results = [];
  for (const bullet of spec.bullets) {
    try {
      const res = await bullet({ root });
      results.push(res);
    } catch (error) {
      // A bullet evaluator threw — surface as internal error so the
      // eval runner can distinguish "scaffold is broken" from "checker
      // is broken".
      process.stderr.write(`internal error in bullet: ${error.stack || error}\n`);
      return 2;
    }
  }

  const out = {
    schema_version: 1,
    app,
    scaffold_root: root,
    checked_at: new Date().toISOString(),
    bullets: results,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
