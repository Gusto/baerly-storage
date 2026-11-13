import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureRequestCounts } from "../tests/fixtures/request-count-grid.ts";
import {
  type CallCounts,
  STORAGE_CALL_KINDS,
  totalCalls,
} from "../tests/fixtures/request-counting-storage.ts";

/**
 * The committed record. Each cell is one line,
 * `get=<n> put=<n> delete=<n> listPage=<n> total=<n>`, so `git diff` and
 * `grep` show exactly which cell moved. Policy:
 * docs/contributing/conventions/request-counts.md.
 */
export interface RequestCountSnapshot {
  $comment?: string;
  cells: Record<string, string>;
}

/** One cell's on-disk form. `total` is derived, written for the reader. */
export const formatCell = (c: CallCounts): string =>
  `${STORAGE_CALL_KINDS.map((k) => `${k}=${c[k]}`).join(" ")} total=${totalCalls(c)}`;

/** Inverse of {@link formatCell}; throws on a hand edit it cannot read. */
export const parseCell = (cell: string, text: string): CallCounts => {
  const fields = new Map(
    text.split(" ").map((pair) => {
      const [k, v] = pair.split("=");
      return [k, Number(v)] as const;
    }),
  );
  const out = {} as CallCounts;
  for (const kind of STORAGE_CALL_KINDS) {
    const n = fields.get(kind);
    if (n === undefined || !Number.isInteger(n)) {
      throw new Error(`request-counts: cell "${cell}" has no integer "${kind}" in "${text}"`);
    }
    out[kind] = n;
  }
  return out;
};

export type CountChange =
  | { kind: "changed"; cell: string; before: CallCounts; after: CallCounts }
  | { kind: "added"; cell: string; after: CallCounts }
  | { kind: "removed"; cell: string; before: CallCounts };

/**
 * Every cell that differs from the snapshot, in grid order. Exact
 * equality: the counts are deterministic, so any change, up or down, is
 * a behavior change someone should look at.
 */
export const compareCounts = (
  snapshot: RequestCountSnapshot,
  measured: Record<string, CallCounts>,
): CountChange[] => {
  const changes: CountChange[] = [];
  for (const [cell, after] of Object.entries(measured)) {
    const text = snapshot.cells[cell];
    if (text === undefined) {
      changes.push({ kind: "added", cell, after });
      continue;
    }
    const before = parseCell(cell, text);
    if (STORAGE_CALL_KINDS.some((k) => before[k] !== after[k])) {
      changes.push({ kind: "changed", cell, before, after });
    }
  }
  for (const [cell, text] of Object.entries(snapshot.cells)) {
    if (!(cell in measured)) {
      changes.push({ kind: "removed", cell, before: parseCell(cell, text) });
    }
  }
  return changes;
};

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** `get 5 -> 6 (+1), total 6 -> 7 (+1)`: only the kinds that moved, then the total. */
const describeDelta = (before: CallCounts, after: CallCounts): string => {
  const parts = STORAGE_CALL_KINDS.filter((k) => before[k] !== after[k]).map(
    (k) => `${k} ${before[k]} -> ${after[k]} (${signed(after[k] - before[k])})`,
  );
  const b = totalCalls(before);
  const a = totalCalls(after);
  parts.push(`total ${b} -> ${a} (${signed(a - b)})`);
  return parts.join(", ");
};

/**
 * The gate's failure text, one line per cell. Exported so the test pins
 * its shape: a green run never prints it.
 */
export const formatChanges = (changes: readonly CountChange[]): string => {
  const lines = changes.map((c) => {
    switch (c.kind) {
      case "changed": {
        return `CHANGED ${c.cell}: ${describeDelta(c.before, c.after)}`;
      }
      case "added": {
        return `ADDED   ${c.cell}: ${formatCell(c.after)}`;
      }
      case "removed": {
        return `REMOVED ${c.cell}: was ${formatCell(c.before)}`;
      }
    }
  });
  return [
    `request-counts: ${changes.length} cell(s) differ from request-counts.json`,
    ...lines,
    `If intended: \`pnpm request-counts --write\`, and say why in the commit message.`,
    `Policy: docs/contributing/conventions/request-counts.md`,
  ].join("\n");
};

const SNAPSHOT_PATH = fileURLToPath(new URL("../request-counts.json", import.meta.url));

/** The committed snapshot; the CLI and the test read the same file through this. */
export const loadRequestCountSnapshot = (): RequestCountSnapshot =>
  JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as RequestCountSnapshot;

const COMMENT =
  "Exact happy-path storage calls per route and maintenance tick over MemoryStorage. " +
  "Regenerate with `pnpm request-counts --write`. " +
  "Policy: docs/contributing/conventions/request-counts.md";

/** The snapshot `--write` commits: every measured cell, in grid order. */
export const nextRequestCountSnapshot = (
  measured: Record<string, CallCounts>,
): RequestCountSnapshot => ({
  $comment: COMMENT,
  cells: Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, formatCell(v)])),
});

const runCli = async (): Promise<void> => {
  const write = process.argv.includes("--write");
  const reportOnly = process.argv.includes("--report");
  if (write && reportOnly) {
    console.error("FAIL --write and --report are mutually exclusive; run one, then the other.");
    process.exit(1);
  }

  const measured = await measureRequestCounts();

  if (reportOnly) {
    for (const [cell, c] of Object.entries(measured)) {
      console.log(`REQUEST_COUNT ${cell} ${formatCell(c)}`);
    }
    return;
  }

  if (write) {
    writeFileSync(
      SNAPSHOT_PATH,
      `${JSON.stringify(nextRequestCountSnapshot(measured), null, 2)}\n`,
    );
    // Keep the file oxfmt-owned, as bundle-sizes.ts does, so a rebaseline
    // never leaves `format:check` red.
    const formatted = spawnSync("pnpm", ["exec", "oxfmt", SNAPSHOT_PATH], { stdio: "inherit" });
    if (formatted.status !== 0) {
      throw new Error("request-counts: oxfmt failed on the regenerated snapshot");
    }
    console.log("request-counts: wrote request-counts.json");
    return;
  }

  const changes = compareCounts(loadRequestCountSnapshot(), measured);
  if (changes.length > 0) {
    console.error(formatChanges(changes));
    process.exit(1);
  }
  console.log(`request-counts: ok (${Object.keys(measured).length} cells)`);
};

// Direct-invocation guard, matching scripts/bundle-sizes.ts.
const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await runCli();
}
