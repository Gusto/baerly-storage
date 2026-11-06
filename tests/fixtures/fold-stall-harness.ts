/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the seed populates it directly. */

/**
 * Shared scaffolding for the main-10 fold-stall suites:
 * `tests/integration/maintenance-fold-stall.test.ts` (today's stall) and
 * `tests/integration/maintenance-growth-refusal.test.ts` (target refusal).
 *
 * A tiny-E profile (20 rows, 5 entries per pass, effectively unbounded
 * bytes), a Writer-level seed with in-band maintenance off, and explicit
 * fold ticks. Ticks stamp `mean_entry_bytes` high enough to meet the ratio
 * trigger for their own duration so the ratio trigger fires on tiny fixtures (the compactor
 * otherwise stamps the real, tiny mean); a deferred tick restores the prior
 * stamp, so the shortcut leaves no residue on the stored state.
 *
 * NOT a `.test.ts` file — see `docs/contributing/conventions/tests.md`.
 */

import {
  casUpdateCurrentJson,
  type Collection,
  type DocumentData,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_PROFILE_CF_FREE,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { Db, probeTailFrom } from "@baerly/server";
import { type MaintenanceProfile, runBoundedMaintenance } from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { wrapCountingStorage } from "./counting-storage.ts";
import { APP, COLLECTION, CURRENT_JSON_KEY, TABLE_PREFIX, TENANT } from "./maintenance-harness.ts";

export const E = 20;
export const PASS = 5;
export const BIG_C = 64 * 1024 * 1024;

/** A tiny-E "free-like" host: 20 rows, 5 entries per pass, effectively unbounded bytes. */
export const SMALL: MaintenanceProfile = {
  ...MAINTENANCE_PROFILE_CF_FREE,
  maxFoldEntriesPerPass: PASS,
  maxFoldRows: E,
  maxFoldBytes: BIG_C,
};

export interface Doc extends DocumentData {
  _id: string;
  n: number;
  pad: string;
}
export const id = (i: number): string => `d${i.toString().padStart(3, "0")}`;

export type SeedOp =
  | { op: "I" | "U"; i: number; n?: number; pad?: string }
  | { op: "D"; i: number };

/** Commit with in-band maintenance DISABLED so the seed is inert; ticks are explicit. */
export const commit = async (storage: Storage, ops: readonly SeedOp[]): Promise<void> => {
  const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
  await runWithContext(
    createObservabilityContext({ maintenance: { disabled: true } }),
    async () => {
      for (const o of ops) {
        if (o.op === "D") {
          await writer.commit({ op: "D", collection: COLLECTION, docId: id(o.i) });
        } else {
          const body: Doc = { _id: id(o.i), n: o.n ?? 0, pad: o.pad ?? "" };
          await writer.commit({ op: o.op, collection: COLLECTION, docId: id(o.i), body });
        }
      }
    },
  );
};

export const inserts = (from: number, to: number, pad?: string): SeedOp[] =>
  Array.from({ length: to - from }, (_, k) => ({
    op: "I" as const,
    i: from + k,
    ...(pad !== undefined && { pad }),
  }));

export interface State {
  start: number;
  tail: number;
  rows: number;
  bytes: number;
  snapshot: string | null;
  mean: number | undefined;
}
export const state = async (storage: Storage): Promise<State> => {
  const cur = (await readCurrentJson(storage, CURRENT_JSON_KEY))!.json;
  const { tail } = await probeTailFrom(
    storage,
    TABLE_PREFIX,
    Math.max(cur.log_seq_start, cur.tail_hint),
  );
  return {
    start: cur.log_seq_start,
    tail,
    rows: cur.snapshot_rows,
    bytes: cur.snapshot_bytes,
    snapshot: cur.snapshot,
    mean: cur.mean_entry_bytes,
  };
};

export interface Signals {
  records: Record<string, unknown>[];
}

export interface TickOptions {
  /** Collects `fold_deferred` records from the warn sink an adapter would carry. */
  signals?: Signals;
  /** `C` override, as the adapters thread `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`. */
  maxFoldBytes?: number;
  /** Stamp `mean_entry_bytes` up to the ratio trigger for this tick (default). `false` runs the tick as a write would. */
  restamp?: boolean;
}

/** One explicit write-tick (single phase, no GC boundary crossed). */
export const tick = async (
  storage: Storage,
  profile: MaintenanceProfile,
  opts: TickOptions = {},
): Promise<void> => {
  const before = await state(storage);
  const restamp = opts.restamp ?? true;
  if (restamp) {
    // One entry's estimate covers the whole snapshot, so even a 1-entry
    // tail meets the ratio trigger whatever the snapshot size.
    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
      ...c,
      mean_entry_bytes: Math.max(MAINTENANCE_MIN_LIVE_BYTES, c.snapshot_bytes),
    }));
  }
  const ctx = createObservabilityContext({
    maintenance: {
      warn: (event, props) => {
        if (event === "fold_deferred") {
          opts.signals?.records.push({ ...props });
        }
      },
    },
  });
  await runWithContext(ctx, () =>
    runBoundedMaintenance(
      {
        storage,
        currentJsonKey: CURRENT_JSON_KEY,
        prevSeq: before.tail,
        ...(opts.maxFoldBytes !== undefined && { maxFoldBytes: opts.maxFoldBytes }),
      },
      { profile, minEntriesToCompact: 1, phasesPerTick: "single" },
    ),
  );
  const after = await state(storage);
  if (restamp && after.start === before.start) {
    const prior = before.mean ?? MAINTENANCE_MIN_LIVE_BYTES;
    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
      ...c,
      mean_entry_bytes: prior,
    }));
  }
};

/** Tick until `log_seq_start` stops moving; returns the number of ticks that advanced it. */
export const drain = async (
  storage: Storage,
  profile: MaintenanceProfile,
  opts: { maxFoldBytes?: number } = {},
): Promise<number> => {
  let advancing = 0;
  for (let k = 0; k < 40; k++) {
    const { start: before } = await state(storage);
    await tick(storage, profile, opts);
    const { start: after } = await state(storage);
    if (after === before) {
      return advancing;
    }
    advancing++;
  }
  throw new Error("drain did not quiesce");
};

/** Live ids via a full read, outside any host context. */
export const readIds = async (storage: Storage): Promise<string[]> => {
  const db = Db.create({ storage, app: APP, tenant: TENANT });
  const rows = await (db.collection(COLLECTION) as Collection<Doc>).where({}).all();
  return rows.map((r) => r._id).toSorted();
};

/** GETs one full read issues: one per tail entry until a drain, plus the snapshot. */
export const readGets = async (storage: Storage): Promise<number> => {
  const counted = wrapCountingStorage(storage);
  const db = Db.create({ storage: counted.storage, app: APP, tenant: TENANT });
  await (db.collection(COLLECTION) as Collection<Doc>).where({}).all();
  return counted.gets;
};
