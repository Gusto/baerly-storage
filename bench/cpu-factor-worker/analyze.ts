// Analysis for the deployed CPU-factor bench.
//   pnpm bench:cpu-factor:analyze <events> [node-baseline.json]
//
// Input: the `wrangler tail --format json` capture (a stream of JSON events,
// one per invocation; multi-line or one per line both parse), or an NDJSON
// export with one object per invocation carrying the request URL (or a
// `cell` field) and the CPU time in ms (`cpuTime`, `cpuTimeMs`, or
// `$workers.cpuTimeMs`). Warm-up requests (`&warmup=1`) and invocations that
// log `"cold":true` are dropped.
//
// Output, per cell: deployed p50/p90/p99 cpuTime, killed count, and the
// deployed/Node factor. Then the measured factor, the compactor-11 gate
// verdict re-run with it, the largest C and E that pass, the tree fold-step
// table (leaves per step that fit under 10 ms, measured directly, no
// factor), and the S1 probe results.
//
// The factor is a diagnostic comparison between matched subjects. It is
// labelled EXPLORATORY unless the Node baseline was captured on a quiet
// machine, and factor extrapolation alone never establishes a safe C/E.
import {
  CELLS,
  type Cell,
  type CellKind,
  type TreePath,
  treePath,
  treePathNodes,
} from "./src/cells.ts";

export const PASS_MS = 8;
export const FREE_LIMIT_MS = 10;
/** One-minute load average per CPU at or above which a baseline counts as loaded. */
export const LOADED_LOAD_PER_CPU = 0.25;
/** Node p50 below which a cell is dominated by the fixed request cost. */
const MIN_NODE_P50_MS = 0.5;
const MIN_OK_SAMPLES = 50;

export interface NodeCellStats {
  readonly p50: number;
  readonly p90?: number;
  readonly p99: number;
  readonly n?: number;
}

export interface NodeBaseline {
  host: string;
  samples: number;
  cells: Record<string, NodeCellStats>;
  load?: { loadavgBefore: number; loadavgAfter: number; cpus: number; loaded: boolean };
}

type Json = Record<string, any>;

/** Split a stream of concatenated JSON values (any whitespace between). */
export const parseStream = (text: string): Json[] => {
  const out: Json[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)) as Json);
        } catch {
          // a non-JSON line that happened to contain braces; skip it
        }
        start = -1;
      }
    }
  }
  return out;
};

const urlOf = (e: Json): unknown =>
  e?.["event"]?.["request"]?.["url"] ??
  e?.["request"]?.["url"] ??
  e?.["$workers"]?.["event"]?.["request"]?.["url"] ??
  e?.["url"];
/** Query parameters of a request URL; undefined when the URL does not parse. */
const searchParamsOf = (url: string): URLSearchParams | undefined => {
  try {
    return new URL(url).searchParams;
  } catch {
    return undefined;
  }
};
const cpuOf = (e: Json): unknown =>
  e?.["cpuTime"] ??
  e?.["cpuTimeMs"] ??
  e?.["$workers"]?.["cpuTimeMs"] ??
  e?.["$metadata"]?.["cpuTimeMs"];
/**
 * A record without an outcome is not evidence of success: a capture that drops
 * the field would otherwise count killed invocations as ok samples.
 */
const MISSING_OUTCOME = "missing";
const outcomeOf = (e: Json): string =>
  e?.["outcome"] ?? e?.["$workers"]?.["outcome"] ?? MISSING_OUTCOME;
const logLineOf = (e: Json): Json | undefined => {
  for (const log of e?.["logs"] ?? []) {
    const message = log?.message;
    for (const m of Array.isArray(message) ? message : [message]) {
      if (typeof m === "string" && m.startsWith("CPUFACTOR ")) {
        return JSON.parse(m.slice(10)) as Json;
      }
    }
  }
  return undefined;
};

export const pct = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) {
    return Number.NaN;
  }
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

export type PercentileMethod = "nearest-rank" | "r7";
export const PERCENTILE_METHODS: readonly PercentileMethod[] = ["nearest-rank", "r7"];

/** Hyndman-Fan type 7 (R's default, Excel's PERCENTILE.INC): linear interpolation at (n-1)p. */
export const pctR7 = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) {
    return Number.NaN;
  }
  const s = xs.toSorted((a, b) => a - b);
  const h = ((s.length - 1) * p) / 100;
  const lo = Math.floor(h);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
};

export const percentile = (xs: readonly number[], p: number, method: PercentileMethod): number =>
  method === "r7" ? pctR7(xs, p) : pct(xs, p);

export interface CellRow {
  readonly cell: Cell;
  readonly n: number;
  readonly killed: number;
  readonly other: number;
  readonly cold: number;
  /** Every non-warmup event attributed to this cell, whatever its outcome. */
  readonly invocations: number;
  /**
   * URL-attributed events tagged `&warmup=1` for this cell (excluded from every
   * statistic). An event with an explicit `cell` field is never a warmup.
   */
  readonly warmups: number;
  /**
   * `&i=` request ids of this cell's non-warmup events, in capture order
   * (`run-cells.sh` numbers requests 1..N). Repeats are kept.
   */
  readonly requestIds: string[];
  /** Non-warmup events of this cell with no `&i=` request id. */
  readonly missingRequestId: number;
  readonly fits: boolean;
  readonly d: { readonly p50: number; readonly p90: number; readonly p99: number };
  readonly node: NodeCellStats | undefined;
  readonly fP50: number;
  readonly fP99: number;
  readonly fNet: number;
}

export interface Factor {
  readonly p50: number;
  readonly p99: number;
  readonly n: number;
}

export interface ProbeSummary {
  readonly runs: number;
  readonly skipped: number;
  /** 1-based failing call index per run that failed. */
  readonly failedAt: number[];
  readonly completed: number[];
  readonly errors: string[];
  readonly cleanRuns: number;
}

export interface TreeRow {
  /** Path mode; older cells without one are "shared". */
  readonly path: TreePath;
  /** Path nodes re-encoded and hashed per step (cells.ts `treePathNodes`). */
  readonly nodes: number;
  readonly k: number;
  readonly bKiB: number;
  readonly d: number;
  readonly row: CellRow;
}

export interface Analysis {
  readonly exploratory: boolean;
  readonly exploratoryReasons: string[];
  readonly baselineHost: string;
  readonly baselineSamples: number;
  readonly events: number;
  readonly unmatched: number;
  /** Unmatched non-warmup events whose outcome is not `ok` (kills, errors, missing). */
  readonly unmatchedNonOk: number;
  readonly missingCpu: number;
  /** Matched events with no outcome field; counted under `other`, never as ok. */
  readonly missingOutcome: number;
  /** Percentile method behind every p50/p90/p99 in this analysis. */
  readonly method: PercentileMethod;
  /** Non-warmup events missing a parseable URL, an outcome or a CPU time. */
  readonly incomplete: IncompleteEvent[];
  readonly rows: CellRow[];
  readonly noop: { readonly deployed: number; readonly node: number };
  readonly factor: {
    readonly overall: Factor;
    readonly perKind: Record<string, Factor>;
    /** Distinct-path tree cells only; excluded from overall and perKind. */
    readonly distinct: Factor;
  };
  readonly gate: Array<{ g: "C" | "E"; ms: number; how: string; pass: boolean }>;
  readonly largestPassing: { c: number | undefined; e: number | undefined };
  readonly tree: {
    readonly rows: TreeRow[];
    /** Per (path, bKiB, d): largest k whose measured p99 fits, and every smaller k fits too. */
    readonly maxLeaves: Array<{
      path: TreePath;
      bKiB: number;
      d: number;
      underPass: number;
      measured: boolean;
      underFree: number;
    }>;
  };
  readonly probes: Record<string, ProbeSummary>;
}

export interface IncompleteEvent {
  /** 0-based position in the parsed stream. */
  readonly index: number;
  /** Cell the event is attributed to, or null when it cannot be. */
  readonly cell: string | null;
  readonly missing: Array<"url" | "outcome" | "cpuTime">;
}

interface Slot {
  ok: number[];
  killed: number;
  other: number;
  cold: number;
  invocations: number;
  warmups: number;
  requestIds: string[];
  missingRequestId: number;
  probes: Json[];
}

export interface AnalyzeOptions {
  /** Defaults to nearest-rank; a preregistration selects one explicitly. */
  readonly method?: PercentileMethod;
}

export const analyze = (
  events: readonly Json[],
  base: NodeBaseline,
  options: AnalyzeOptions = {},
): Analysis => {
  const method = options.method ?? "nearest-rank";
  const q = (xs: readonly number[], p: number) => percentile(xs, p, method);
  const median = (xs: readonly number[]) => q(xs, 50);
  const incomplete: IncompleteEvent[] = [];
  const byCell = new Map<string, Slot>(
    CELLS.map((c) => [
      c.name,
      {
        ok: [],
        killed: 0,
        other: 0,
        cold: 0,
        invocations: 0,
        warmups: 0,
        requestIds: [],
        missingRequestId: 0,
        probes: [],
      },
    ]),
  );
  let unmatched = 0;
  let unmatchedNonOk = 0;
  let missingCpu = 0;
  let missingOutcome = 0;
  for (const [index, e] of events.entries()) {
    // An explicit `cell` field wins and its URL is never consulted for the
    // cell or the warmup tag; only URL-attributed events can be warmups.
    let cell: string | null | undefined = e?.["cell"];
    const url = urlOf(e);
    const params = typeof url === "string" ? searchParamsOf(url) : undefined;
    if (cell === undefined && typeof url === "string") {
      if (params?.get("warmup") === "1") {
        const warm = byCell.get(params.get("cell") ?? "");
        if (warm !== undefined) {
          warm.warmups++;
        }
        continue;
      }
      cell = params?.get("cell") ?? null;
    }
    const slot = cell === null || cell === undefined ? undefined : byCell.get(cell);
    const missing: IncompleteEvent["missing"] = [];
    if (params === undefined) {
      missing.push("url");
    }
    if (outcomeOf(e) === MISSING_OUTCOME) {
      missing.push("outcome");
    }
    if (typeof cpuOf(e) !== "number") {
      missing.push("cpuTime");
    }
    if (missing.length > 0) {
      incomplete.push({ index, cell: slot === undefined ? null : cell!, missing });
    }
    if (slot === undefined) {
      unmatched++;
      if (outcomeOf(e) !== "ok") {
        unmatchedNonOk++;
      }
      continue;
    }
    slot.invocations++;
    const requestId = params?.get("i");
    if (requestId === null || requestId === undefined) {
      slot.missingRequestId++;
    } else {
      slot.requestIds.push(requestId);
    }
    const line = logLineOf(e);
    if (line?.["probe"] !== undefined) {
      slot.probes.push(line["probe"]);
    }
    const outcome = outcomeOf(e);
    if (outcome === "exceededCpu" || outcome === "exceededResources") {
      slot.killed++;
      continue;
    }
    if (outcome !== "ok") {
      if (outcome === MISSING_OUTCOME) {
        missingOutcome++;
      }
      slot.other++;
      continue;
    }
    if (line?.["cold"] === true) {
      slot.cold++;
      continue;
    }
    const cpu = cpuOf(e);
    if (typeof cpu !== "number") {
      missingCpu++;
      continue;
    }
    slot.ok.push(cpu);
  }

  const reasons: string[] = [];
  if (base.load === undefined) {
    reasons.push("the Node baseline records no load average");
  } else if (base.load.loaded) {
    reasons.push(
      `the Node baseline was captured under load (loadavg ${base.load.loadavgBefore.toFixed(2)} before, ${base.load.loadavgAfter.toFixed(2)} after, ${base.load.cpus} cpus)`,
    );
  }

  const noopSlot = byCell.get("noop")!;
  const noopDep = median(noopSlot.ok);
  const noopNode = base.cells["noop"]?.p50 ?? 0;
  const rows: CellRow[] = CELLS.map((c) => {
    const s = byCell.get(c.name)!;
    const n = base.cells[c.name];
    const d = { p50: q(s.ok, 50), p90: q(s.ok, 90), p99: q(s.ok, 99) };
    const total = s.ok.length + s.killed;
    const fits = total > 0 && s.killed / total < 0.01 && s.ok.length >= MIN_OK_SAMPLES;
    return {
      cell: c,
      n: s.ok.length,
      killed: s.killed,
      other: s.other,
      cold: s.cold,
      invocations: s.invocations,
      warmups: s.warmups,
      requestIds: s.requestIds,
      missingRequestId: s.missingRequestId,
      fits,
      d,
      node: n,
      fP50: n === undefined ? Number.NaN : d.p50 / n.p50,
      fP99: n === undefined ? Number.NaN : d.p99 / n.p99,
      fNet:
        c.name === "noop" || n === undefined ? Number.NaN : (d.p50 - noopDep) / (n.p50 - noopNode),
    };
  });

  const FACTOR_KINDS: CellKind[] = ["fold", "tree"];
  // Headline factors keep their pre-distinct meaning (fold + shared-path tree
  // cells); distinct-path cells get their own factor.
  const usable = rows.filter(
    (r) =>
      r.fits &&
      FACTOR_KINDS.includes(r.cell.kind) &&
      !isDistinct(r.cell) &&
      r.node !== undefined &&
      r.node.p50 >= MIN_NODE_P50_MS,
  );
  const factorFor = (pred: (r: CellRow) => boolean): Factor => {
    const xs = usable.filter(pred);
    return { p50: median(xs.map((r) => r.fP50)), p99: median(xs.map((r) => r.fP99)), n: xs.length };
  };
  const overall = factorFor(() => true);
  const distinctXs = rows.filter(
    (r) => r.fits && isDistinct(r.cell) && r.node !== undefined && r.node.p50 >= MIN_NODE_P50_MS,
  );
  const distinct: Factor = {
    p50: median(distinctXs.map((r) => r.fP50)),
    p99: median(distinctXs.map((r) => r.fP99)),
    n: distinctXs.length,
  };
  const perKind = Object.fromEntries(
    FACTOR_KINDS.map((k) => [k, factorFor((r) => r.cell.kind === k)]),
  );

  // A cell's diagnostic deployed p99: measured when it fits, else Node p99 x the kind's
  // p50-basis factor (the overall one when fewer than 2 of the kind's cells
  // fit), marked estimated. The p50 basis is used because the p99/p99 ratio
  // is noisy and the cells that fit under 10 ms are a size-selected sample.
  const factorUsed = (kind: CellKind): number =>
    (perKind[kind]?.n ?? 0) >= 2 ? perKind[kind]!.p50 : overall.p50;
  const deployedP99 = (r: CellRow): { ms: number; how: string } => {
    if (r.fits) {
      return { ms: r.d.p99, how: "measured" };
    }
    const f = factorUsed(r.cell.kind);
    return {
      ms: (r.node?.p99 ?? Number.NaN) * f,
      how: `estimated (node p99 x ${f.toFixed(2)}; ${r.killed} killed)`,
    };
  };

  const gate = (["C", "E"] as const).flatMap((g) => {
    const r = rows.find((x) => x.cell.kind === "fold" && x.cell.gate === g);
    if (r === undefined) {
      return [];
    }
    const p = deployedP99(r);
    return [{ g, ms: p.ms, how: p.how, pass: r.fits && r.d.p99 <= PASS_MS }];
  });

  const largest = (key: "ladder" | "rowsLadder"): number | undefined => {
    let best: number | undefined;
    const ladder = rows
      .filter((r) => r.cell.kind === "fold" && r.cell[key] !== undefined)
      .toSorted((a, b) => a.cell[key]! - b.cell[key]!);
    for (const r of ladder) {
      if (!(r.fits && r.d.p99 <= PASS_MS)) {
        break;
      }
      best = r.cell[key];
    }
    return best;
  };

  const treeRows: TreeRow[] = rows
    .filter((r) => r.cell.kind === "tree")
    .map((row) => ({
      path: treePath(row.cell.tree!),
      nodes: treePathNodes(row.cell.tree!),
      k: row.cell.tree!.k,
      bKiB: row.cell.tree!.bKiB,
      d: row.cell.tree!.d,
      row,
    }));
  const groups = new Map<string, TreeRow[]>();
  for (const t of treeRows) {
    const key = `${t.path}/${t.bKiB}/${t.d}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const maxLeaves = [...groups.values()].map((g) => {
    const sorted = g.toSorted((a, b) => a.k - b.k);
    const under = (limit: number) => {
      let best = 0;
      for (const t of sorted) {
        if (!(t.row.fits && t.row.d.p99 <= limit)) {
          break;
        }
        best = t.k;
      }
      return best;
    };
    return {
      path: g[0]!.path,
      bKiB: g[0]!.bKiB,
      d: g[0]!.d,
      underPass: under(PASS_MS),
      underFree: under(FREE_LIMIT_MS),
      // No ok samples at all: the capture predates these cells.
      measured: g.some((t) => t.row.n > 0),
    };
  });

  const probes: Record<string, ProbeSummary> = {};
  for (const c of CELLS) {
    if (c.kind !== "probe") {
      continue;
    }
    const rs = byCell.get(c.name)!.probes;
    const failed = rs.filter((r) => typeof r["failedAt"] === "number");
    probes[c.probe!] = {
      runs: rs.length,
      skipped: rs.filter((r) => r["skipped"] !== undefined).length,
      failedAt: failed.map((r) => r["failedAt"] as number),
      completed: rs.filter((r) => r["skipped"] === undefined).map((r) => r["completed"] as number),
      errors: [...new Set(failed.map((r) => `${r["error"]?.name}: ${r["error"]?.message}`))],
      cleanRuns: rs.filter((r) => r["skipped"] === undefined && r["failedAt"] === null).length,
    };
  }

  return {
    exploratory: reasons.length > 0,
    exploratoryReasons: reasons,
    baselineHost: base.host,
    baselineSamples: base.samples,
    events: events.length,
    unmatched,
    unmatchedNonOk,
    missingCpu,
    missingOutcome,
    method,
    incomplete,
    rows,
    noop: { deployed: noopDep, node: noopNode },
    factor: { overall, perKind, distinct },
    gate,
    largestPassing: { c: largest("ladder"), e: largest("rowsLadder") },
    tree: { rows: treeRows, maxLeaves },
    probes,
  };
};

const isDistinct = (c: Cell): boolean => c.tree !== undefined && treePath(c.tree) === "distinct";

const f2 = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? x.toFixed(2) : "-");

const probeLine = (name: string, p: ProbeSummary): string => {
  if (p.runs === 0) {
    return `  ${name}: no events`;
  }
  if (p.skipped === p.runs) {
    return `  ${name}: skipped in all ${p.runs} runs (no binding)`;
  }
  const failing = p.failedAt.length === 0 ? "none (no failure)" : p.failedAt.join(",");
  const errors = p.errors.length === 0 ? "none" : p.errors.join(" | ");
  return `  ${name}: ${p.runs - p.skipped} runs; completed ${p.completed.join(",")}; first failing call ${failing}; clean runs ${p.cleanRuns}; errors: ${errors}`;
};

const treeLine = (t: TreeRow, withPath: boolean): string =>
  `${withPath ? `${t.path} | ` : ""}${t.k} | ${t.bKiB} | ${t.d} | ${withPath ? `${t.nodes} | ` : ""}${t.row.n} | ${t.row.killed} | ${f2(t.row.d.p50)} / ${f2(t.row.d.p90)} / ${f2(t.row.d.p99)}${t.row.fits ? "" : "  (does not fit)"}`;

const leavesLine = (m: Analysis["tree"]["maxLeaves"][number], withPath: boolean): string =>
  `  ${withPath ? "distinct paths, " : ""}leaf ${m.bKiB} KiB, d=${m.d}: ${
    m.measured
      ? `<= ${PASS_MS} ms: ${m.underPass}; <= ${FREE_LIMIT_MS} ms: ${m.underFree}`
      : "not measured (no samples in this capture)"
  }`;

export const formatReport = (a: Analysis): string => {
  const out: string[] = [];
  if (a.exploratory) {
    out.push(
      "EXPLORATORY: factors below are not decision-bearing.",
      ...a.exploratoryReasons.map((r) => `  - ${r}`),
      "",
    );
  }
  out.push(
    `Node baseline: ${a.baselineHost}, ${a.baselineSamples} samples per cell`,
    `Events parsed: ${a.events}; unmatched: ${a.unmatched}; missing cpuTime: ${a.missingCpu}; missing outcome: ${a.missingOutcome}`,
    "",
    "Cell CPU below is warm-isolate (cold invocations dropped), not a cold-start cost.",
    "cell | n ok | killed | other | deployed p50 / p90 / p99 ms | node p50 / p99 ms | factor p50 | factor p99 | factor p50 net of noop",
  );
  for (const r of a.rows) {
    out.push(
      `${r.cell.name} | ${r.n} | ${r.killed} | ${r.other} | ${f2(r.d.p50)} / ${f2(r.d.p90)} / ${f2(r.d.p99)} | ${f2(r.node?.p50)} / ${f2(r.node?.p99)} | ${f2(r.fP50)} | ${f2(r.fP99)} | ${f2(r.fNet)}${r.fits || r.cell.kind === "probe" ? "" : "  (does not fit: excluded from factors)"}`,
    );
  }
  out.push(
    "",
    `Measured deployed/Node factor (median over fitting cells)${a.exploratory ? " [exploratory]" : ""}:`,
    `  overall: p50-basis ${f2(a.factor.overall.p50)}x, p99-basis ${f2(a.factor.overall.p99)}x (${a.factor.overall.n} cells)`,
    ...Object.entries(a.factor.perKind).map(
      ([k, f]) => `  ${k}: p50-basis ${f2(f.p50)}x, p99-basis ${f2(f.p99)}x (${f.n} cells)`,
    ),
    "",
    `Gate (compactor-11 Task 1): pass iff both C and E fit (>= ${MIN_OK_SAMPLES} ok samples, < 1% kills) and measured deployed p99 <= ${PASS_MS} ms; Free limit ${FREE_LIMIT_MS} ms. Estimates are diagnostic only.${a.exploratory ? " Estimated rows use the exploratory factor." : ""}`,
    `  main: ${a.gate.map((v) => `${v.g} p99 ${f2(v.ms)} ms ${v.how}`).join("; ")} => ${a.gate.every((v) => v.pass) ? "PASS" : "FAIL"}`,
    "",
    `Largest passing size (fitting cells with measured deployed p99 <= ${PASS_MS} ms, every smaller size passing too):`,
    `  main: C ${a.largestPassing.c === undefined ? "none (fails at 16 KiB)" : `${a.largestPassing.c} KiB (2 KiB docs)`}; E ${a.largestPassing.e === undefined ? "none (fails at 256 rows)" : `${a.largestPassing.e} rows (~240 B docs)`}`,
    "",
    "Tree fold step (direct deployed CPU, WARM-ISOLATE: JIT-hot, cold invocations dropped, uniform `x` padding is a best case for JSON; not a cold fold cost; one shared path, so the best case for d path nodes):",
    "k | leaf KiB | d | n ok | killed | deployed p50 / p90 / p99 ms",
    ...a.tree.rows.filter((t) => t.path === "shared").map((t) => treeLine(t, false)),
    `Leaves per step that fit (measured p99; every smaller k fits too; 0 = none of the grid):`,
    ...a.tree.maxLeaves.filter((m) => m.path === "shared").map((m) => leavesLine(m, false)),
    "",
    `Tree fold step, DISTINCT paths (k leaves on k distinct root-to-leaf paths; nodes = 1 + k*(d-1) for k <= 64; same warm-isolate caveats; its factor is separate from the headline factors above: p50-basis ${f2(a.factor.distinct.p50)}x, p99-basis ${f2(a.factor.distinct.p99)}x, ${a.factor.distinct.n} cells):`,
    "path | k | leaf KiB | d | nodes | n ok | killed | deployed p50 / p90 / p99 ms",
    ...a.tree.rows.filter((t) => t.path === "distinct").map((t) => treeLine(t, true)),
    `Leaves per step that fit, distinct paths (measured p99; every smaller k fits too; 0 = none of the grid):`,
    ...a.tree.maxLeaves.filter((m) => m.path === "distinct").map((m) => leavesLine(m, true)),
    "",
    "S1 probe (calls before failure; 60 sequential calls per run; valid only on a Workers FREE account, on Paid every probe reads clean):",
    "  probe-cache-match is INCONCLUSIVE on *.workers.dev (the Cache API is a no-op there); only a custom-domain route can show whether Cache API calls count against 50.",
    ...Object.entries(a.probes).map(([name, p]) => probeLine(name, p)),
  );
  return `${out.join("\n")}\n`;
};
