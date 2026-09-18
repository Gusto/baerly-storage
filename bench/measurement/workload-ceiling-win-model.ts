/* eslint-disable no-underscore-dangle -- `__enc` is the encode-hook
 * counter bag; `_id` is the locked primary-key field. */
/**
 * Workload-ceiling win model.
 *
 * ONE QUESTION: in encode bytes per mutation folded, how does the shipped
 * `planChunkedFold` compare to a monolithic rebuild, and how does that
 * compare to one builder run at the already-admitted prefix?
 *
 * WHY IT EXISTS. Program docs mixed two planners: append-ordered figures
 * from a counterfactual one-build-at-the-prefix walk (`prefixWin`), uniform
 * figures from the shipped planner (`plannerWin`). This probe reports both
 * on every cell, from one run, and does not pick between them. The shipped
 * planner is what a production fold would pay; the prefix walk is the
 * ADR-007-item-4-illegal upper bound (selection is not free —
 * `split_increments` is non-monotone).
 *
 * MARGINS, NOT A VERDICT. The table reports `plannerWin` (whatever
 * `planChunkedFold` currently does), `prefixWin` (one `buildSnapshotChunks`
 * at the admitted prefix), and hash-call counts for each. Picking a number
 * to publish is a human documentation decision, not a measurement.
 *
 * BASE PACKING. The base is packed POLICY-CONSISTENTLY, not via even-count
 * grouping: a count-split fixture is not a state `splitGroupDocsGreedily`
 * can produce, and feeding one to the builder measures the fixture, not
 * the format. This packer predates the builder's shrink-on-overflow
 * backoff (`99be8eee`) and throws `canonical body exceeds 1048576 bytes`
 * for `c1024-r4096` at the 1 / 2 / 4 MiB cells. That is not a kernel
 * defect; those cells have no win-model data. Recorded as a finding, not
 * fixed here.
 *
 * MEASURES ONLY. Changes no constant, no planner, no production behaviour.
 *
 * This module has NO module-scope side effects — the test imports it. The
 * runnable entrypoint is `workload-ceiling-win-model-run.ts` and must be
 * loaded under `workload-ceiling-win-model-hooks.mjs`.
 */
import {
  encodeJsonBytes,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotHash,
  type DocumentData,
  type LogEntry,
} from "@baerly/protocol";
import { encodeSnapshotBody } from "@baerly/server";
import {
  encodeSnapshotChunk,
  snapshotChunkKey,
  type SnapshotChunkDescriptor,
} from "@baerly/server/_internal/testing";
import {
  type ChunkedFoldBudget,
  planChunkedFold,
} from "../../packages/server/src/chunked-fold-planner.ts";
import {
  buildSnapshotChunks,
  CHUNK_BOUNDARY_POLICIES,
  type SnapshotChunkBoundaryPolicy,
} from "../../packages/server/src/snapshot-chunk-builder.ts";

export const WIN_MODEL_VERSION = "baerly.workload-ceiling-win-model/v1" as const;

export const WIN_MODEL_COLLECTION = "tickets";
export const WIN_MODEL_COLLECTION_PREFIX = "app/demo/tenant/acme/manifests/tickets";
export const WIN_MODEL_INCARNATION = "00112233445566778899aabbccddeeff";

/** Planner budget: the format-contract values, matching chunked-fold-planner.test.ts. */
export const WIN_MODEL_BUDGET: ChunkedFoldBudget = {
  max_log_entries: 100,
  max_mutation_bytes: 1024 * 1024,
  max_touched_chunks: 8,
  max_touched_bytes: 2 * 1024 * 1024,
  max_split_increments: 4,
  max_neighbor_chunks: 1,
};

export const WIN_MODEL_CELLS = [
  { label: "0.5MiB", rows: 256 },
  { label: "1MiB", rows: 512 },
  { label: "2MiB", rows: 1024 },
  { label: "4MiB", rows: 2048 },
] as const;

export const WIN_MODEL_MUTATIONS = 20 as const;
export const WIN_MODEL_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export const WIN_MODEL_DOCUMENT_BYTES = 2048 as const;

export type WinModelLocality = "uniform" | "append";
export type WinModelPolicyName = keyof typeof CHUNK_BOUNDARY_POLICIES;

export interface EncodeCounters {
  readonly jsonCalls: number;
  readonly jsonBytes: number;
  readonly chunkCalls: number;
  readonly chunkBytes: number;
  readonly chunkDocs: number;
  readonly bodyCalls: number;
  readonly bodyBytes: number;
  readonly hashCalls: number;
  readonly hashBytes: number;
}

type MutableEncodeCounters = {
  -readonly [K in keyof EncodeCounters]: EncodeCounters[K];
};

type GlobalWithEnc = typeof globalThis & { __enc?: MutableEncodeCounters };

export const emptyEncodeCounters = (): MutableEncodeCounters => ({
  jsonCalls: 0,
  jsonBytes: 0,
  chunkCalls: 0,
  chunkBytes: 0,
  chunkDocs: 0,
  bodyCalls: 0,
  bodyBytes: 0,
  hashCalls: 0,
  hashBytes: 0,
});

export const resetEncodeCounters = (): void => {
  (globalThis as GlobalWithEnc).__enc = emptyEncodeCounters();
};

export const snapshotEncodeCounters = (): EncodeCounters => {
  const bag = (globalThis as GlobalWithEnc).__enc;
  if (bag === undefined) {
    throw new Error(
      "run under workload-ceiling-win-model-hooks.mjs — encode counters were never seeded",
    );
  }
  return { ...bag };
};

/**
 * Encode bytes per mutation folded, chunked / monolithic. Values > 1 mean
 * chunked encoded fewer bytes per admitted mutation than the monolithic
 * rebuild of the same 20-mutation tail.
 */
export const winRatio = (monoBytesPerMutation: number, foldBytesPerMutation: number): number =>
  foldBytesPerMutation === 0 ? Number.NaN : monoBytesPerMutation / foldBytesPerMutation;

export const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

export const rangeLabel = (values: readonly number[]): string => {
  if (values.length === 0) {
    return "-";
  }
  return `${Math.min(...values).toFixed(2)}-${Math.max(...values).toFixed(2)}`;
};

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildRows(rowCount: number, documentBytes: number): DocumentData[] {
  const width = String(rowCount - 1).length;
  const rows: DocumentData[] = [];
  for (let i = 0; i < rowCount; i++) {
    const id = `row-${String(i).padStart(width, "0")}`;
    const bare = encodeJsonBytes({ _id: id, payload: "" }).byteLength;
    rows.push({ _id: id, payload: "x".repeat(Math.max(0, documentBytes - bare)) });
  }
  return rows;
}

export function entriesOf(
  rows: readonly DocumentData[],
  n: number,
  mode: WinModelLocality,
  seed: number,
  docBytes: number,
): LogEntry[] {
  const rnd = mulberry32(seed);
  const out: LogEntry[] = [];
  const width = String(rows.length - 1).length;
  for (let i = 0; i < n; i++) {
    let docId: string;
    let op: "I" | "U";
    let after: DocumentData;
    if (mode === "uniform") {
      const k = Math.floor(rnd() * rows.length);
      const row = rows[k]!;
      docId = row["_id"] as string;
      op = "U";
      const payload = typeof row["payload"] === "string" ? row["payload"] : "";
      after = { ...row, payload: payload.slice(0, -1) + "y" };
    } else {
      docId = `row-${String(rows.length + i).padStart(width, "0")}`;
      op = "I";
      const bare = encodeJsonBytes({ _id: docId, payload: "" }).byteLength;
      after = { _id: docId, payload: "x".repeat(Math.max(0, docBytes - bare)) };
    }
    out.push({
      lsn: `0000000000_s_${i.toString(32).padStart(6, "0")}`,
      commit_ts: "2026-08-15T10:00:00.000Z",
      op,
      collection: WIN_MODEL_COLLECTION,
      doc_id: docId,
      after,
      session: "s",
      seq: i + 1,
    });
  }
  return out;
}

export interface PackedBase {
  readonly descriptors: readonly SnapshotChunkDescriptor[];
  readonly loaded: ReadonlyMap<string, readonly DocumentData[]>;
}

/**
 * Longest prefix within both policy thresholds. Throws on a singleton
 * that exceeds `MAX_CHUNK_BYTES` — the known packer staleness for
 * `c1024-r4096` at large cells.
 */
export async function packedBase(
  rows: readonly DocumentData[],
  policy: SnapshotChunkBoundaryPolicy,
): Promise<PackedBase> {
  const descriptors: SnapshotChunkDescriptor[] = [];
  const loaded = new Map<string, DocumentData[]>();
  let cur: DocumentData[] = [];
  const flush = async (): Promise<void> => {
    if (cur.length === 0) {
      return;
    }
    const firstId = cur[0]!["_id"] as string;
    const lastId = cur.at(-1)!["_id"] as string;
    const bytes = encodeSnapshotChunk({
      schema_version: 2,
      collection: WIN_MODEL_COLLECTION,
      incarnation: WIN_MODEL_INCARNATION,
      first_id: firstId,
      last_id: lastId,
      docs: cur,
    });
    const key = snapshotChunkKey(
      WIN_MODEL_COLLECTION_PREFIX,
      WIN_MODEL_INCARNATION,
      await snapshotHash(bytes),
    );
    descriptors.push({
      first_id: firstId,
      last_id: lastId,
      key,
      byte_length: bytes.byteLength,
      row_count: cur.length,
    });
    loaded.set(key, cur);
    cur = [];
  };
  for (const row of rows) {
    const trial = [...cur, row];
    const bytes = encodeSnapshotChunk({
      schema_version: 2,
      collection: WIN_MODEL_COLLECTION,
      incarnation: WIN_MODEL_INCARNATION,
      first_id: trial[0]!["_id"] as string,
      last_id: trial.at(-1)!["_id"] as string,
      docs: trial,
    });
    if (bytes.byteLength > policy.target_chunk_bytes || trial.length > policy.target_rows) {
      await flush();
      cur = [row];
    } else {
      cur = trial;
    }
  }
  await flush();
  return { descriptors, loaded };
}

async function monoJsonBytes(
  rows: readonly DocumentData[],
  entries: readonly LogEntry[],
): Promise<number> {
  const base = new Map<string, DocumentData>();
  for (const row of rows) {
    base.set(row["_id"] as string, row);
  }
  for (const entry of entries) {
    if (entry.after !== undefined) {
      base.set(entry.doc_id, entry.after);
    }
  }
  const sorted = [...base.entries()]
    .toSorted(([left], [right]) => {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    })
    .map(([id, body]) => ({ _id: id, body }));
  resetEncodeCounters();
  const bytes = encodeSnapshotBody({
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: entries.length,
    collection: WIN_MODEL_COLLECTION,
    docs: sorted,
  });
  await snapshotHash(bytes);
  return snapshotEncodeCounters().jsonBytes;
}

export interface WinModelTrial {
  readonly seed: number;
  readonly admitted: number;
  readonly plannerJsonBytes: number;
  readonly plannerHashCalls: number;
  readonly prefixJsonBytes: number;
  readonly prefixHashCalls: number;
  readonly monoJsonBytes: number;
  readonly plannerWin: number;
  readonly prefixWin: number;
}

export interface WinModelRow {
  readonly cell: string;
  readonly policy: WinModelPolicyName;
  readonly descriptors: number;
  readonly locality: WinModelLocality;
  readonly kMedian: number;
  readonly kMin: number;
  readonly kMax: number;
  readonly plannerWinMedian: number;
  readonly plannerWinRange: string;
  readonly prefixWinMedian: number;
  readonly prefixWinRange: string;
  readonly plannerHashMedian: number;
  readonly prefixHashMedian: number;
  readonly trials: readonly WinModelTrial[];
}

export interface WinModelSkip {
  readonly cell: string;
  readonly policy: WinModelPolicyName;
  readonly reason: string;
}

export interface WinModelRecord {
  readonly version: typeof WIN_MODEL_VERSION;
  readonly subject_commit: string;
  readonly rows: readonly WinModelRow[];
  readonly skips: readonly WinModelSkip[];
  readonly findings: readonly string[];
}

const PACKER_STALENESS_FINDING =
  "policy-consistent packer has no shrink-on-overflow backoff, so c1024-r4096 at 1 / 2 / 4 MiB throws `canonical body exceeds 1048576 bytes` and those cells have no win-model data. Not a kernel defect — builder backoff landed in 99be8eee.";

export const PACKER_STALENESS_FINDING_TEXT = PACKER_STALENESS_FINDING;

async function measureTrial(
  rows: readonly DocumentData[],
  descriptors: readonly SnapshotChunkDescriptor[],
  loaded: ReadonlyMap<string, readonly DocumentData[]>,
  policy: SnapshotChunkBoundaryPolicy,
  locality: WinModelLocality,
  seed: number,
): Promise<WinModelTrial> {
  const entries = entriesOf(rows, WIN_MODEL_MUTATIONS, locality, seed, WIN_MODEL_DOCUMENT_BYTES);
  resetEncodeCounters();
  const plan = await planChunkedFold({
    collection: WIN_MODEL_COLLECTION,
    collectionPrefix: WIN_MODEL_COLLECTION_PREFIX,
    entries,
    descriptors,
    loadedChunks: loaded,
    budget: WIN_MODEL_BUDGET,
    incarnation: WIN_MODEL_INCARNATION,
    policy,
    baseLogSeq: 0,
  });
  const plannerEnc = snapshotEncodeCounters();
  const admitted =
    plan === null ? 0 : entries.findIndex((entry) => entry.seq === plan.log_seq_end) + 1;
  if (admitted === 0 || plan === null) {
    return {
      seed,
      admitted: 0,
      plannerJsonBytes: plannerEnc.jsonBytes,
      plannerHashCalls: plannerEnc.hashCalls,
      prefixJsonBytes: 0,
      prefixHashCalls: 0,
      monoJsonBytes: 0,
      plannerWin: Number.NaN,
      prefixWin: Number.NaN,
    };
  }

  const mutations = new Map(
    entries
      .slice(0, admitted)
      .map((entry) => [
        entry.doc_id,
        entry.op === "D"
          ? { op: "D" as const, doc_id: entry.doc_id }
          : { op: entry.op, doc_id: entry.doc_id, after: entry.after! },
      ]),
  );
  resetEncodeCounters();
  await buildSnapshotChunks({
    collection: WIN_MODEL_COLLECTION,
    collectionPrefix: WIN_MODEL_COLLECTION_PREFIX,
    descriptors,
    loadedChunks: loaded,
    mutations,
    incarnation: WIN_MODEL_INCARNATION,
    policy,
    lockedDirectOwnerIndex: plan.prefetch.leftmost_direct_owner_index,
    selectedNeighborIndex: plan.prefetch.selected_neighbor_index,
  });
  const prefixEnc = snapshotEncodeCounters();
  const monoBytes = await monoJsonBytes(rows, entries);
  return {
    seed,
    admitted,
    plannerJsonBytes: plannerEnc.jsonBytes,
    plannerHashCalls: plannerEnc.hashCalls,
    prefixJsonBytes: prefixEnc.jsonBytes,
    prefixHashCalls: prefixEnc.hashCalls,
    monoJsonBytes: monoBytes,
    plannerWin: winRatio(monoBytes / WIN_MODEL_MUTATIONS, plannerEnc.jsonBytes / admitted),
    prefixWin: winRatio(monoBytes / WIN_MODEL_MUTATIONS, prefixEnc.jsonBytes / admitted),
  };
}

export const deriveFindings = (
  rows: readonly WinModelRow[],
  skips: readonly WinModelSkip[],
): readonly string[] => {
  const findings: string[] = [PACKER_STALENESS_FINDING];
  if (skips.length > 0) {
    findings.push(
      `${skips.length} cell/policy pairs skipped (packer throw): ${skips
        .map((skip) => `${skip.cell}/${skip.policy}`)
        .join(", ")}.`,
    );
  }
  const plannerWins = rows
    .flatMap((row) => row.trials.map((trial) => trial.plannerWin))
    .filter(Number.isFinite);
  const prefixWins = rows
    .flatMap((row) => row.trials.map((trial) => trial.prefixWin))
    .filter(Number.isFinite);
  if (plannerWins.length > 0) {
    findings.push(
      `plannerWin range (shipped planChunkedFold, all cells): ${rangeLabel(plannerWins)}x.`,
    );
  }
  if (prefixWins.length > 0) {
    findings.push(
      `prefixWin range (one build at the admitted prefix, all cells): ${rangeLabel(prefixWins)}x. Not a legal planner under ADR-007 item 4.`,
    );
  }
  findings.push(
    "No verdict: plannerWin is what ships; prefixWin is the counterfactual the sequential scan forbids. Publish from one planner.",
  );
  return findings;
};

export async function runWinModelGrid(
  onRow?: (row: WinModelRow | WinModelSkip) => void,
): Promise<Pick<WinModelRecord, "rows" | "skips">> {
  snapshotEncodeCounters();
  const rows: WinModelRow[] = [];
  const skips: WinModelSkip[] = [];
  const policyNames = Object.keys(CHUNK_BOUNDARY_POLICIES) as WinModelPolicyName[];
  for (const cell of WIN_MODEL_CELLS) {
    const baseRows = buildRows(cell.rows, WIN_MODEL_DOCUMENT_BYTES);
    for (const policyName of policyNames) {
      const policy = CHUNK_BOUNDARY_POLICIES[policyName];
      let packed: PackedBase;
      try {
        packed = await packedBase(baseRows, policy);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const skip: WinModelSkip = { cell: cell.label, policy: policyName, reason };
        skips.push(skip);
        onRow?.(skip);
        continue;
      }
      for (const locality of ["uniform", "append"] as const) {
        const trials: WinModelTrial[] = [];
        for (const seed of WIN_MODEL_SEEDS) {
          trials.push(
            await measureTrial(
              baseRows,
              packed.descriptors,
              packed.loaded,
              policy,
              locality,
              seed * 7919 + cell.rows,
            ),
          );
        }
        const admitted = trials.map((trial) => trial.admitted);
        const plannerWins = trials.map((trial) => trial.plannerWin).filter(Number.isFinite);
        const prefixWins = trials.map((trial) => trial.prefixWin).filter(Number.isFinite);
        const row: WinModelRow = {
          cell: cell.label,
          policy: policyName,
          descriptors: packed.descriptors.length,
          locality,
          kMedian: median(admitted),
          kMin: Math.min(...admitted),
          kMax: Math.max(...admitted),
          plannerWinMedian: median(plannerWins),
          plannerWinRange: rangeLabel(plannerWins),
          prefixWinMedian: median(prefixWins),
          prefixWinRange: rangeLabel(prefixWins),
          plannerHashMedian: median(trials.map((trial) => trial.plannerHashCalls)),
          prefixHashMedian: median(trials.map((trial) => trial.prefixHashCalls)),
          trials,
        };
        rows.push(row);
        onRow?.(row);
      }
    }
  }
  return { rows, skips };
}

export const renderTable = (
  rows: readonly WinModelRow[],
  skips: readonly WinModelSkip[],
): string => {
  const header =
    "cell | policy | D | locality | K med (min-max) | plannerWin med [range] | prefixWin med [range] | plannerHash med | prefixHash med";
  const body = rows.map((row) =>
    [
      row.cell,
      row.policy,
      `D=${row.descriptors}`,
      row.locality,
      `K=${row.kMedian} (${row.kMin}-${row.kMax})`,
      `planner=${row.plannerWinMedian.toFixed(2)}x [${row.plannerWinRange}]`,
      `prefix=${row.prefixWinMedian.toFixed(2)}x [${row.prefixWinRange}]`,
      `h=${row.plannerHashMedian}`,
      `h=${row.prefixHashMedian}`,
    ].join(" | "),
  );
  const skipLines = skips.map((skip) => `${skip.cell} | ${skip.policy} | SKIP ${skip.reason}`);
  return [header, ...body, ...skipLines].join("\n");
};

export const buildWinModelRecord = (input: {
  readonly rows: readonly WinModelRow[];
  readonly skips: readonly WinModelSkip[];
  readonly subject_commit: string;
}): WinModelRecord => ({
  version: WIN_MODEL_VERSION,
  subject_commit: input.subject_commit,
  rows: input.rows,
  skips: input.skips,
  findings: deriveFindings(input.rows, input.skips),
});
