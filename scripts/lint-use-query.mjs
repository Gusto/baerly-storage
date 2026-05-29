#!/usr/bin/env node
/**
 * Static check for the `useQuery(...)` callback shape. Companion to
 * the runtime sentinel-throws in
 * `packages/client/src/react/use-query.ts`:
 *
 *   1. `no-await-in-use-query`: a `useQuery(callback, deps?)`
 *      callback must not `await` anything that flows from the
 *      recorder `client` parameter. The recorder doesn't survive
 *      an `await` — see the spec at
 *      `docs/superpowers/specs/2026-05-25-react-hooks-collapse-design.md`
 *      §"Recorder throws on `await`". This rule catches both
 *      `useQuery(async (c) => ...)` (any async callback) and
 *      `await c.table(...).…` patterns inside the callback.
 *
 * Runs as part of `pnpm verify:agent`. Exit codes:
 *   0 — no findings
 *   2 — one or more findings (printed with file:line)
 *
 * Scope: scans the React surface
 * (`packages/client/src/react/**`) and the example apps
 * (`examples/react-*\/src/**`). Test files are excluded since they
 * intentionally exercise the violating pattern.
 *
 * Implementation: line-oriented regex match — sufficient for the
 * patterns we want to catch and consistent with the repo's
 * existing `scripts/add-ts-extensions.mjs` precedent (no TS-AST
 * dependency added). Multi-line `useQuery((c) => {…\n await …})`
 * bodies are scanned across the call's brace span.
 */
import { readFile, glob } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, "..");

const SCAN_GLOBS = [
  "packages/client/src/react/**/*.{ts,tsx}",
  "examples/react-*/src/**/*.{ts,tsx}",
];

const findings = [];

const recordFinding = (file, line, message) => {
  findings.push({ file, line, message });
};

/**
 * Locate every `useQuery(` call. Returns ranges `[startIdx,
 * endIdx]` (the matching close paren) so we can slice the call
 * arguments out for further inspection.
 */
const findUseQueryCalls = (src) => {
  const ranges = [];
  const re = /\buseQuery\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let i = openIdx + 1;
    let inStr = null;
    let inLineComment = false;
    let inBlockComment = false;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      const next = src[i + 1];
      if (inLineComment) {
        if (ch === "\n") {
          inLineComment = false;
        }
      } else if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
      } else if (inStr) {
        if (ch === "\\") {
          i += 1;
        } else if (ch === inStr) {
          inStr = null;
        }
      } else if (ch === "/" && next === "/") {
        inLineComment = true;
        i += 1;
      } else if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      i += 1;
    }
    if (depth === 0) {
      ranges.push([m.index, i]);
    }
  }
  return ranges;
};

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/**
 * Heuristic: a useQuery callsite is flagged if the first argument
 * function literal:
 *   - is declared `async` (any async callback), OR
 *   - contains an `await` expression inside its body.
 *
 * We don't analyse what's awaited — if a user awaits a non-recorder
 * Promise (e.g. `await new Promise(r => setTimeout(r, 100))`), the
 * runtime sentinel catches the post-`await` chain anyway. False
 * positives are acceptable and tightly localised.
 */
const scanCall = (file, src, [start, end]) => {
  const body = src.slice(start, end);
  // After `useQuery(`, the first character of the first argument
  // begins. Skip whitespace.
  const afterOpen = body.indexOf("(") + 1;
  const rest = body.slice(afterOpen);
  const trimmedStart = rest.search(/\S/);
  if (trimmedStart < 0) {
    return;
  }
  const firstArg = rest.slice(trimmedStart);
  // Detect `async (` / `async function` / `async <` / `async <T>(` etc.
  if (/^async\b/.test(firstArg)) {
    recordFinding(
      file,
      lineOf(src, start),
      "useQuery callbacks must be synchronous (no `async`); the recorder doesn't survive an `await`.\n  To fix: drop `async` from the callback. If you need awaited data, lift the work above `useQuery(...)` (e.g. into a `useEffect` + state) and pass the resolved value in as a synchronous prop.",
    );
    return;
  }
  // Heuristic: any `await ` inside the call body is suspect. The
  // sequential-await pattern always awaits something — usually
  // `c.table(...).<terminal>` — so any await is grounds to flag.
  // Strip comments + string literals first so `// await ...` in
  // a doc comment doesn't false-positive.
  const stripped = stripCommentsAndStrings(firstArg);
  if (/\bawait\b/.test(stripped)) {
    recordFinding(
      file,
      lineOf(src, start),
      "useQuery callbacks must not contain `await`; the recorder doesn't survive a `.then` resolution.\n  To fix: hoist any `await` (or `.then(...)`) out of the callback. The `useQuery` body runs inside the metrics-recorder context; awaiting drops the context for the rest of the function. See docs/contributing/conventions/observability.md.",
    );
  }
};

const stripCommentsAndStrings = (src) => {
  let out = "";
  let i = 0;
  let inStr = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
    } else if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
    } else if (inStr) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === inStr) {
        inStr = null;
      }
    } else if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
    } else if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
};

const main = async () => {
  const seen = new Set();
  for (const pattern of SCAN_GLOBS) {
    for await (const relPath of glob(pattern, { cwd: REPO_ROOT })) {
      // Skip test files — they intentionally exercise the patterns
      // that the lint catches.
      if (/\.test\.(ts|tsx)$/.test(relPath)) {
        continue;
      }
      const abs = resolvePath(REPO_ROOT, relPath);
      if (seen.has(abs)) {
        continue;
      }
      seen.add(abs);
      const src = await readFile(abs, "utf8");
      if (!/\buseQuery\s*\(/.test(src)) {
        continue;
      }
      for (const range of findUseQueryCalls(src)) {
        scanCall(relPath, src, range);
      }
    }
  }
  if (findings.length === 0) {
    return 0;
  }
  for (const f of findings) {
    console.error(`${f.file}:${f.line}: ${f.message} [baerly/no-await-in-use-query]`);
  }
  return 2;
};

const code = await main();
process.exit(code);
