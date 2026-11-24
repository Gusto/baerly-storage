/**
 * Join a run's driver log with its tail capture and report CPU per cell.
 *
 *   pnpm bench:tree-fold-cpu:analyze normalize <tail.json>  > events.jsonl
 *   pnpm bench:tree-fold-cpu:analyze report <drive.jsonl> <events.jsonl> [--node=<node-baseline.json>]
 *
 * `normalize` keeps only what the report reads from each `wrangler tail
 * --format json` event of a `/bench/fold` request (tag, cell, outcome,
 * `cpuTime`, `wallTime`): tail events also carry request headers, the bench
 * secret among them, so store the normalized file, never the raw capture.
 * `report` accepts either.
 *
 * Per cell: measured samples (warmup and cold invocations dropped, counted),
 * median deployed `cpuTime` with its range, median entries folded, ledger
 * charge, nodes written, client wall time, CPU per entry, the paired Node
 * median and the workerd/Node factor. Then a least-squares fit
 * `cpu = a + b * entries` per fixture and storage over every measured
 * sample.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runAsCliEntrypoint } from "../measurement/cli-entrypoint.ts";
import { median, type NodeBaseline } from "./node-baseline.ts";

/** Every JSON value in `text`: JSON Lines or concatenated (pretty) JSON. */
export const parseJsonStream = (text: string): unknown[] => {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        values.push(JSON.parse(text.slice(start, i + 1)));
      }
    }
  }
  if (depth !== 0) {
    throw new Error("truncated JSON stream");
  }
  return values;
};

/** The fields `report` reads from one tail event of a fold request. */
export interface FoldEvent {
  readonly tag: string;
  readonly cell: string;
  readonly outcome: string | null;
  readonly cpuTime: number | null;
  readonly wallTime: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** A raw tail event or an already-normalized one, as a {@link FoldEvent}; `null` for other requests. */
export const foldEventOf = (raw: unknown): FoldEvent | null => {
  const ev = raw as Record<string, unknown>;
  if (typeof ev["tag"] === "string" && typeof ev["cell"] === "string") {
    return ev as unknown as FoldEvent;
  }
  const request = (ev["event"] as { request?: { url?: unknown } } | undefined)?.request;
  if (typeof request?.url !== "string") {
    return null;
  }
  const url = new URL(request.url);
  const tag = url.searchParams.get("tag");
  const cell = url.searchParams.get("cell");
  if (url.pathname !== "/bench/fold" || tag === null || cell === null) {
    return null;
  }
  return {
    tag,
    cell,
    outcome: typeof ev["outcome"] === "string" ? ev["outcome"] : null,
    cpuTime: num(ev["cpuTime"]),
    wallTime: num(ev["wallTime"]),
  };
};

/** A driver log line of a fold tick (the Worker's response, plus the driver's fields). */
export interface FoldLine {
  readonly kind: "fold";
  readonly cell: string;
  readonly tag: string;
  readonly warmup: boolean;
  readonly status: number;
  readonly clientMs: number;
  readonly cold?: boolean;
  readonly folded?: number;
  readonly ledgerCharged?: number;
  readonly nodesWritten?: number;
  readonly problem?: string | null;
}

/** One measured sample: a valid fold line joined to its CPU. */
export interface Sample {
  readonly cell: string;
  readonly cpuMs: number;
  readonly folded: number;
  readonly ledgerCharged: number;
  readonly nodesWritten: number;
  readonly clientMs: number;
}

export interface Joined {
  readonly samples: readonly Sample[];
  /** Fold lines dropped, by reason. */
  readonly dropped: Readonly<Record<string, number>>;
}

/** Join fold lines to tail events by tag; drop warmup, cold, failed and unmatched samples. */
export const joinSamples = (lines: readonly unknown[], events: readonly FoldEvent[]): Joined => {
  const byTag = new Map(events.map((e) => [e.tag, e]));
  const samples: Sample[] = [];
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  for (const raw of lines) {
    const line = raw as FoldLine;
    if (line.kind !== "fold") {
      continue;
    }
    const ev = byTag.get(line.tag);
    if (line.warmup) {
      drop("warmup");
    } else if (line.status !== 200 || (line.problem ?? null) !== null) {
      drop("failed");
    } else if (line.cold === true) {
      drop("cold");
    } else if (ev === undefined || ev.cpuTime === null) {
      drop("no tail event");
    } else if (ev.outcome !== "ok") {
      drop(`outcome ${String(ev.outcome)}`);
    } else {
      samples.push({
        cell: line.cell,
        cpuMs: ev.cpuTime,
        folded: line.folded ?? 0,
        ledgerCharged: line.ledgerCharged ?? 0,
        nodesWritten: line.nodesWritten ?? 0,
        clientMs: line.clientMs,
      });
    }
  }
  return { samples, dropped };
};

/** Least squares `y = a + b * x`; `null` with fewer than two distinct `x`. */
export const fitLine = (
  points: readonly (readonly [number, number])[],
): { a: number; b: number } | null => {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (n < 2 || sxx === 0) {
    return null;
  }
  const b = sxy / sxx;
  return { a: my - b * mx, b };
};

/** The fixture and storage of a cell name (`<tenant>-<cap>-<storage>`). */
const seriesOf = (cell: string): string => {
  const parts = cell.split("-");
  return `${parts[0]}-${parts.at(-1)}`;
};

export const report = (joined: Joined, node?: NodeBaseline): string[] => {
  const nodeBy = new Map(
    (node?.cells ?? []).map((c) => [c.cell.replace(/-r2$/, "-memory"), c.cpuMs]),
  );
  const cells = [...new Set(joined.samples.map((s) => s.cell))];
  const out = [
    "cell                    n  cpu ms (min-max)         folded ledger nodes client ms  ms/entry   node ms  factor",
  ];
  for (const cell of cells) {
    const xs = joined.samples.filter((s) => s.cell === cell);
    const cpu = median(xs.map((s) => s.cpuMs));
    const folded = median(xs.map((s) => s.folded));
    const nodeMs = nodeBy.get(cell.replace(/-r2$/, "-memory"));
    out.push(
      [
        cell.padEnd(22),
        String(xs.length).padStart(2),
        `${cpu.toFixed(0).padStart(7)} (${Math.min(...xs.map((s) => s.cpuMs))}-${Math.max(...xs.map((s) => s.cpuMs))})`.padEnd(
          22,
        ),
        String(folded).padStart(6),
        String(median(xs.map((s) => s.ledgerCharged))).padStart(6),
        String(median(xs.map((s) => s.nodesWritten))).padStart(5),
        median(xs.map((s) => s.clientMs))
          .toFixed(0)
          .padStart(9),
        (cpu / folded).toFixed(3).padStart(9),
        (nodeMs === undefined ? "-" : nodeMs.toFixed(0)).padStart(9),
        (nodeMs === undefined ? "-" : (cpu / nodeMs).toFixed(2)).padStart(7),
      ].join(" "),
    );
  }
  out.push("", "fit cpu = a + b * entries (ms):");
  for (const series of new Set(cells.map(seriesOf))) {
    const pts = joined.samples
      .filter((s) => seriesOf(s.cell) === series)
      .map((s) => [s.folded, s.cpuMs] as const);
    const f = fitLine(pts);
    out.push(
      `  ${series.padEnd(14)} ${f === null ? "too few points" : `a ${f.a.toFixed(1)}  b ${f.b.toFixed(3)}/entry  (${pts.length} samples)`}`,
    );
  }
  const dropped = Object.entries(joined.dropped);
  if (dropped.length > 0) {
    out.push("", `dropped: ${dropped.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  return out;
};

/** The fold events of a tail capture, raw or normalized. */
const readEvents = (file: string): FoldEvent[] =>
  parseJsonStream(readFileSync(file, "utf8"))
    .map(foldEventOf)
    .filter((e): e is FoldEvent => e !== null);

const main = async (): Promise<number> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { node: { type: "string" } },
  });
  const [command, ...files] = positionals;
  if (command === "normalize" && files.length === 1) {
    for (const e of readEvents(files[0]!)) {
      console.log(JSON.stringify(e));
    }
    return 0;
  }
  if (command === "report" && files.length === 2) {
    const lines = parseJsonStream(readFileSync(files[0]!, "utf8"));
    const node =
      values.node === undefined
        ? undefined
        : (JSON.parse(readFileSync(values.node, "utf8")) as NodeBaseline);
    for (const line of report(joinSamples(lines, readEvents(files[1]!)), node)) {
      console.log(line);
    }
    return 0;
  }
  console.error(
    "usage: analyze.ts normalize <tail.json> | report <drive.jsonl> <events> [--node=<file>]",
  );
  return 2;
};

await runAsCliEntrypoint(import.meta.url, main);
