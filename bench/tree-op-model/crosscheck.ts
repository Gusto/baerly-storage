/**
 * Cross-check of the static tree op model (`./model.ts`) against
 * counting-storage measurements of the prototype's real fold step and
 * reads (`./measure.ts`), and the per-depth table against the Workers
 * Paid and Free + R2 request ledgers.
 *
 * Trees: two document sizes (256 B and 5 KiB), each at depth 0 (the
 * depth-0 rule's 512 KiB / 2,048 rows), depth 1 (1 MiB) and depth 2
 * (Paid's fold ceilings `C` / `E`, 8 MiB; at 256 B that is also 32,768
 * rows). Paid C/E reaches no other depth under the production layout:
 * depth 3 needs more than 128 level-1 nodes, which only crafted keys
 * produce, and the per-collection chunk salt prevents that.
 *
 * Cells, each happy path and with every retried call at every attempt:
 *
 * - `point`: a cold point read under the host's read tail;
 * - `scan`: a complete scan under the same tail;
 * - `tick-pass`: a fold tick of one maintenance pass of scattered
 *   changes (the profile's `maxFoldEntriesPerPass`), the shape the
 *   model's worst tick takes;
 * - `tick-budget`: a fold tick over more scattered changes than fit,
 *   so the request budget alone ends it: the most one tick folds.
 *
 * A cell's modelled count is the model evaluated at the measured
 * collection's size and depth (`collectionShape`), the host's read tail,
 * and, for a tick, the entries the measured fold read. Measured and
 * modelled are compared per kind (GETs, PUTs) and in total: a total alone
 * would let a pessimistic create term hide a missing GET term.
 *
 *   node bench/tree-op-model/crosscheck.ts
 *
 * prints the table (it takes several seconds of CPU).
 */
import {
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  CF_PAID_REQUEST_LIMIT,
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  STORAGE_RETRY_MAX_ATTEMPTS,
} from "@baerly/protocol";
import { runAsCliEntrypoint } from "../measurement/cli-entrypoint.ts";
import {
  type BaseTree,
  buildBaseTree,
  COMMIT_HOLD,
  composedTickCalls,
  composedWriterCalls,
  chargedByKind,
  type FaultMode,
  measureFold,
  measurePointRead,
  measureScan,
  openBucket,
  pointTarget,
  totalOf,
  withComposed,
  Workload,
} from "./measure.ts";
import {
  ALL_ATTEMPTS,
  collectionShape,
  DEFAULT_ASSUMPTIONS,
  FREE_R2_HOST,
  foldTickCalls,
  HAPPY_PATH,
  type HostProfile,
  type KindCounts,
  PAID_HOST,
  pointReadCalls,
  PROTOTYPE_TREE_DEFAULTS,
  type RetryPolicy,
  scanCalls,
  sumCalls,
  type TreeShape,
} from "./model.ts";

/** The `tail_hint` lag the model's scenarios assume (`MAINTENANCE_TAIL_HINT_REFRESH_WRITES`-bounded). */
export const TAIL_HINT_LAG = 128;

export type CellOp = "point" | "scan" | "tick-pass" | "tick-budget";

export interface CrossCell {
  readonly host: string;
  readonly docBytes: number;
  readonly depth: number;
  readonly rows: number;
  readonly bytes: number;
  readonly leaves: number;
  readonly op: CellOp;
  readonly policy: "happy" | "all";
  /** Measured, plus the composed calls for a tick, as the ledger charges them. */
  readonly measured: KindCounts;
  /** The measured part alone. */
  readonly measuredPart: KindCounts;
  /** The composed part alone (zero for a read). */
  readonly composedPart: KindCounts;
  /** The model's charge for the same cell, by kind. */
  readonly modelled: KindCounts;
  /** Node GETs the measured operation issued (each call once). */
  readonly nodeGets: number;
  /** What the operation may spend: a read the ledger, a tick the ledger less the write route and commit hold. */
  readonly budget: number;
  /** The model's own budget for the cell (a tick's uses the modelled write route). */
  readonly modelledBudget: number;
  /** For a tick: entries folded (accepted) and read. */
  readonly folded?: number;
  readonly entriesRead?: number;
  /** Why the measured fold or read stopped short, if it did. */
  readonly note?: string;
  /** For a scan: the admission check's charge of the base GETs, at every attempt. */
  readonly admissionCharge?: number;
  /** For a scan: it was refused with `CapacityExceeded` before its first base GET. */
  readonly refused?: boolean;
}

const POLICIES: readonly (readonly ["happy" | "all", RetryPolicy, FaultMode])[] = [
  ["happy", HAPPY_PATH, "happy"],
  ["all", ALL_ATTEMPTS, "all-attempts"],
];

const ZERO_KINDS: KindCounts = { get: 0, put: 0, delete: 0, listPage: 0 };

/** The trees measured: two document sizes at every depth Paid C/E reaches. */
export const TREE_SPECS: readonly {
  readonly docBytes: number;
  readonly rows: number;
  readonly depth: number;
}[] = [
  { docBytes: 256, rows: MAINTENANCE_MAX_FOLD_ROWS, depth: 0 },
  { docBytes: 256, rows: 4096, depth: 1 },
  { docBytes: 256, rows: PAID_HOST.collection.rows, depth: 2 },
  { docBytes: 5120, rows: Math.floor(MAINTENANCE_MAX_FOLD_BYTES_DEFAULT / 5120), depth: 0 },
  { docBytes: 5120, rows: Math.floor((1024 * 1024) / 5120), depth: 1 },
  { docBytes: 5120, rows: Math.floor(PAID_HOST.collection.bytes / 5120), depth: 2 },
];

/** The model's worst shape of `base`'s collection at its depth. */
const shapeOf = (depth: number, bytes: number, rows: number): TreeShape => {
  const shape = collectionShape(depth, PROTOTYPE_TREE_DEFAULTS, { bytes, rows });
  if (shape === null) {
    throw new Error(`the model has no depth-${depth} shape for ${bytes} B / ${rows} rows`);
  }
  return shape;
};

const readInput = (base: BaseTree, host: HostProfile) => ({
  shape: shapeOf(base.depth, base.bytes, base.rows),
  tailEntries: host.tailEntries,
  emptyBase: false,
});

const tailOf = (base: BaseTree, length: number, seed: number): ReturnType<Workload["next"]>[] => {
  const workload = new Workload(base, seed, pointTarget(base));
  return Array.from({ length }, () => workload.next());
};

const readCells = async (
  base: BaseTree,
  host: HostProfile,
): Promise<{ cells: CrossCell[]; pointCharge: Map<string, number> }> => {
  const cells: CrossCell[] = [];
  const pointCharge = new Map<string, number>();
  const tail = tailOf(base, host.tailEntries, 1);
  for (const [name, policy, mode] of POLICIES) {
    for (const op of ["point", "scan"] as const) {
      const bucket = await openBucket(base, tail, TAIL_HINT_LAG);
      const m =
        op === "point"
          ? await measurePointRead(bucket, base, mode, host.ledger.internal)
          : await measureScan(bucket, base, mode, host.ledger.internal);
      const calls =
        op === "point" ? pointReadCalls(readInput(base, host)) : scanCalls(readInput(base, host));
      if (op === "point") {
        pointCharge.set(name, totalOf(m.attempts));
      }
      cells.push({
        ...cellBase(base, host, op, name),
        measured: m.attempts,
        measuredPart: m.attempts,
        composedPart: ZERO_KINDS,
        modelled: chargedByKind(calls, policy),
        nodeGets: m.logicalGets.node,
        budget: host.ledger.internal,
        modelledBudget: host.ledger.internal,
        ...(m.refused !== undefined && {
          refused: true,
          note: "refused (CapacityExceeded) before the first base GET",
        }),
        ...(m.admissionCharge !== undefined && { admissionCharge: m.admissionCharge }),
      });
    }
  }
  return { cells, pointCharge };
};

const cellBase = (base: BaseTree, host: HostProfile, op: CellOp, policy: "happy" | "all") => ({
  host: host.name,
  docBytes: base.spec.docBytes,
  depth: base.depth,
  rows: base.rows,
  bytes: base.bytes,
  leaves: base.levelNodes[0]!,
  op,
  policy,
});

const tickCells = async (
  base: BaseTree,
  host: HostProfile,
  pointCharge: ReadonlyMap<string, number>,
  depthZero: boolean,
): Promise<CrossCell[]> => {
  const cells: CrossCell[] = [];
  const writer = composedWriterCalls(TAIL_HINT_LAG);
  const tickComposed = composedTickCalls();
  for (const [name, policy, mode] of POLICIES) {
    const route = pointCharge.get(name)! + totalOf(chargedByKind(writer, policy));
    const tickBudget = host.ledger.internal - route - COMMIT_HOLD;
    const composedPart = chargedByKind(tickComposed, policy);
    const foldBudget = tickBudget - totalOf(composedPart);
    const modelRoute = totalOf(
      chargedByKind(sumCalls(pointReadCalls(readInput(base, host)), writer), policy),
    );
    for (const op of ["tick-pass", "tick-budget"] as const) {
      const length =
        op === "tick-pass"
          ? host.entriesPerPass
          : Math.ceil(foldBudget / STORAGE_RETRY_MAX_ATTEMPTS) + 32;
      const bucket = await openBucket(base, tailOf(base, length, 2), TAIL_HINT_LAG);
      const m = await measureFold(
        bucket,
        base,
        length,
        mode,
        foldBudget,
        depthZero ? { maxBytes: host.collection.bytes, maxRows: host.collection.rows } : undefined,
      );
      if (op === "tick-pass" && m.folded !== length) {
        throw new Error(
          `${host.name} pass tick folded ${m.folded} of ${length} entries (${m.stop})`,
        );
      }
      if (op === "tick-budget" && m.stop?.startsWith("budget") !== true) {
        throw new Error(
          `${host.name} budget tick ended for ${m.stop ?? "the tail"}, not the budget`,
        );
      }
      const logicalLog = m.logicalGets.log;
      // The model's tail probe is one GET at the observed tail; every
      // other log GET is an entry the tick read.
      const entriesRead = logicalLog - 1;
      const shape = shapeOf(
        Math.max(m.before.depth, m.after.depth),
        Math.max(m.before.bytes, m.after.bytes),
        Math.max(m.before.rows, m.after.rows),
      );
      const calls = foldTickCalls({
        shape,
        changedLeaves: Math.min(entriesRead, shape.leaves),
        sharing: "distinct",
        entriesFolded: entriesRead,
        emptyBase: false,
        concurrentCommits: 0,
        headCasLost: true,
        assumptions: DEFAULT_ASSUMPTIONS,
      });
      cells.push({
        ...cellBase(base, host, op, name),
        measured: withComposed(m.attempts, tickComposed, policy),
        measuredPart: m.attempts,
        composedPart,
        modelled: chargedByKind(calls, policy),
        nodeGets: m.logicalGets.node,
        budget: tickBudget,
        modelledBudget: host.ledger.internal - modelRoute - COMMIT_HOLD,
        folded: m.folded,
        entriesRead,
        ...(m.stop !== undefined && { note: `stop: ${m.stop}` }),
      });
    }
  }
  return cells;
};

/** Every cell: Paid ticks and reads at each depth, the Free + R2 depth-0 tick, and Free reads at each depth. */
export const runCrosscheck = async (): Promise<CrossCell[]> => {
  const cells: CrossCell[] = [];
  for (const [index, spec] of TREE_SPECS.entries()) {
    const base = await buildBaseTree({ docBytes: spec.docBytes, rows: spec.rows }, 1000 + index);
    if (base.depth !== spec.depth) {
      throw new Error(
        `a ${spec.rows}-row tree of ${spec.docBytes} B documents is depth ${base.depth}, not ${spec.depth}`,
      );
    }
    for (const host of [PAID_HOST, FREE_R2_HOST]) {
      const reads = await readCells(base, host);
      cells.push(...reads.cells);
      // Free publishes depth-0 roots only, within its C / E.
      if (host === PAID_HOST || base.depth === 0) {
        cells.push(...(await tickCells(base, host, reads.pointCharge, host === FREE_R2_HOST)));
      }
    }
  }
  return cells;
};

/** Kinds where the measurement exceeds the model, empty when the cell holds. */
export const exceedances = (cell: CrossCell): string[] => {
  const over: string[] = [];
  for (const kind of ["get", "put", "delete", "listPage"] as const) {
    if (cell.measured[kind] > cell.modelled[kind]) {
      over.push(`${kind} ${cell.measured[kind]} > ${cell.modelled[kind]}`);
    }
  }
  if (totalOf(cell.measured) > totalOf(cell.modelled)) {
    over.push(`total ${totalOf(cell.measured)} > ${totalOf(cell.modelled)}`);
  }
  return over;
};

export const cellName = (c: CrossCell): string =>
  `${c.host} ${c.docBytes} B depth ${c.depth} ${c.op} ${c.policy}`;

const pad = (s: string | number, w: number): string => String(s).padStart(w);

/** The per-depth table. */
export const formatTable = (cells: readonly CrossCell[]): string => {
  const lines = [
    [
      "host".padEnd(9),
      pad("doc", 5),
      pad("d", 2),
      pad("rows", 6),
      pad("KiB", 5),
      pad("leaves", 6),
      "op".padEnd(11),
      pad("pol", 5),
      pad("meas", 6),
      pad("(+comp)", 7),
      pad("model", 6),
      pad("budget", 6),
      pad("mbudget", 7),
      pad("headroom", 8),
      pad("nodeGET", 7),
      pad("k", 5),
      "  note",
    ].join(" "),
  ];
  for (const c of cells) {
    const measured = totalOf(c.measured);
    lines.push(
      [
        c.host.padEnd(9),
        pad(c.docBytes, 5),
        pad(c.depth, 2),
        pad(c.rows, 6),
        pad(Math.round(c.bytes / 1024), 5),
        pad(c.leaves, 6),
        c.op.padEnd(11),
        pad(c.policy, 5),
        pad(measured, 6),
        pad(totalOf(c.composedPart) === 0 ? "" : `+${totalOf(c.composedPart)}`, 7),
        pad(totalOf(c.modelled), 6),
        pad(c.budget, 6),
        pad(c.modelledBudget, 7),
        pad(c.refused === true ? "refused" : c.budget - measured, 8),
        pad(c.nodeGets, 7),
        pad(c.folded ?? "", 5),
        `  ${[c.note, c.admissionCharge === undefined ? undefined : `admission ${c.admissionCharge}`].filter(Boolean).join("; ")}`,
      ].join(" "),
    );
  }
  return lines.join("\n");
};

const main = async (): Promise<number> => {
  const started = performance.now();
  const cells = await runCrosscheck();
  console.log(formatTable(cells));
  const bad = cells.filter((c) => exceedances(c).length > 0);
  for (const c of bad) {
    console.log(`MEASURED > MODELLED: ${cellName(c)}: ${exceedances(c).join(", ")}`);
  }
  console.log(
    `ledgers: Paid ${CF_PAID_REQUEST_LIMIT}, Free + R2 ${CF_FREE_INTERNAL_REQUEST_LIMIT}; ${cells.length} cells in ${Math.round(performance.now() - started)} ms`,
  );
  return bad.length === 0 ? 0 : 1;
};

await runAsCliEntrypoint(import.meta.url, main);
