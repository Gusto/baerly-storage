/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the run seeds doc bodies with it. */

/**
 * Steady-state request costs on Workers Free with storage reached through
 * `fetch` (S3 over HTTP), where every storage call is one of the 50
 * external subrequests an invocation may make.
 *
 * Unlike the route grid in `request-count-grid.ts`, a cell here is a whole
 * request: the route plus the write tick it dispatches, since a Workers
 * `ctx.waitUntil` tick shares the invocation's subrequest cap. The tick
 * options are {@link FREE_FETCH_TICK_OPTIONS}, which
 * `packages/adapter-cloudflare/src/worker-maintenance.test.ts` pins to what
 * `cfMaintenanceDispatch` builds when handed non-binding storage.
 *
 * A run starts from a 100-doc snapshot and issues writes of one kind. GC runs
 * with the production grace period over a ledger seeded with a backlog of
 * replaced snapshots already past it, so every GC slice sweeps its full
 * `gcMaxSweeps`, the worst a collection older than the grace period pays.
 * The log retention window is shrunk so retirement is live from the first
 * ticks, deleting what each fold moved the floor by, as it does past the
 * production window.
 * After each write commits, and before its tick runs, the reads below are
 * measured too: a `waitUntil` tick lands after the response, so a read
 * racing it sees the tail the write left. Each cell records the most
 * expensive request of its kind over the run.
 */

import {
  casUpdateCurrentJson,
  createCurrentJson,
  createGcPending,
  GC_MAX_PENDING_CANDIDATES,
  GC_PENDING_SCHEMA_VERSION,
  gcPendingKey,
  CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES,
  CF_FREE_FETCH_GC_MAX_SWEEPS,
  CURRENT_JSON_SCHEMA_VERSION,
  type DocumentData,
  type IndexDefinition,
  MAINTENANCE_PROFILE_CF_FREE,
  MemoryStorage,
  GC_STARVATION_GUARD,
  type Storage,
  WRITE_TICK_GC_INTERVAL,
} from "@baerly/protocol";
import { compact, type InternalCompactOptions } from "../../packages/server/src/compactor.ts";
import { Db } from "../../packages/server/src/db.ts";
import { snapshotKey } from "../../packages/server/src/snapshot.ts";
import type { InternalBoundedMaintenanceOptions } from "../../packages/server/src/maintenance-options.ts";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import {
  type CallCounts,
  CallTally,
  requestCountingStorage,
  totalCalls,
} from "./request-counting-storage.ts";

const APP = "rc";
const TENANT = "t";
const COLL = "docs";
const MANIFEST_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_JSON_KEY = `${MANIFEST_PREFIX}/current.json`;
const SNAPSHOT_DOCS = 100;
const VALUE_CARDINALITY = 10;

/** The commit interval at which a write tick runs GC ahead of any fold. */
const HARD_GC_INTERVAL = WRITE_TICK_GC_INTERVAL * GC_STARVATION_GUARD;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Writes per run. Where folds land relative to the GC cadence repeats every
 * `lcm(trigger, HARD_GC_INTERVAL)` commits, so one full cycle after a
 * warm-up interval reaches every phase, the worst included.
 */
const runWrites = (trigger: number | undefined): number =>
  HARD_GC_INTERVAL +
  (trigger === undefined
    ? 4 * HARD_GC_INTERVAL
    : (trigger * HARD_GC_INTERVAL) / gcd(trigger, HARD_GC_INTERVAL));
/** Log retention window for the run, small so retirement is live early. */
const RUN_RETENTION_WINDOW = 16;
/** The largest `$in` list measured. */
export const FREE_FETCH_IN_SIZE = 16;

/**
 * The write-tick options the Cloudflare adapter builds on the free profile
 * for storage other than the R2 binding. Pinned against
 * `cfMaintenanceDispatch` by the adapter's own tests, which run under
 * workerd; this program has no Workers globals to import the adapter with.
 */
export const FREE_FETCH_TICK_OPTIONS: InternalBoundedMaintenanceOptions = {
  phasesPerTick: "single",
  profile: { ...MAINTENANCE_PROFILE_CF_FREE, gcMaxSweeps: CF_FREE_FETCH_GC_MAX_SWEEPS },
  foldAtTailEntries: CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES,
};

export type FreeFetchWrite = "insert" | "update" | "mixed";
export const FREE_FETCH_WRITES: readonly FreeFetchWrite[] = ["insert", "update", "mixed"];

export type FreeFetchRead = "get" | "indexed-query" | "in-query";
export const FREE_FETCH_READS: readonly FreeFetchRead[] = ["get", "indexed-query", "in-query"];

const indexDefs = (n: number): IndexDefinition[] =>
  Array.from({ length: n }, (_, k) => ({ name: `by_f${k}`, on: `f${k}` }));

const docBody = (id: string | undefined, i: number): DocumentData => ({
  ...(id !== undefined && { _id: id }),
  f0: `v${i % VALUE_CARDINALITY}`,
  f1: `v${i % VALUE_CARDINALITY}`,
  f2: `v${i % VALUE_CARDINALITY}`,
  n: i,
});

const snapId = (i: number): string => `s${String(i).padStart(3, "0")}`;

const makeDb = (storage: Storage, indexes: number): Db =>
  Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    config: { collections: { [COLL]: { indexes: indexDefs(indexes) } } },
  });

const seed = async (indexes: number): Promise<MemoryStorage> => {
  const storage = new MemoryStorage();
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "request-count-free-fetch", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
  const coll = makeDb(storage, indexes).collection(COLL);
  await runWithContext(
    createObservabilityContext({ maintenance: { dispatch: () => {} } }),
    async () => {
      for (let i = 0; i < SNAPSHOT_DOCS; i++) {
        await coll.insert(docBody(snapId(i), i));
      }
    },
  );
  const res = await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
    maxEntriesPerRun: SNAPSHOT_DOCS,
    minEntriesToCompact: 1,
  } as InternalCompactOptions);
  if (!res.written) {
    throw new Error(`free-fetch run: seed fold did not land (${res.skippedReason})`);
  }
  const cur = await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({
    ...c,
    tail_hint: c.log_seq_start,
    // Retirement already caught up to the window, as on a collection in
    // steady state; the seed's own entries below it stay unretired.
    log_delete_floor: c.log_seq_start - RUN_RETENTION_WINDOW,
  }));
  // A full ledger of replaced snapshots already past the grace period, so
  // every GC slice in the run sweeps its cap. The objects need not exist:
  // a DELETE of an absent key costs the same call.
  const floor = cur.json.log_seq_start;
  await createGcPending(storage, gcPendingKey(MANIFEST_PREFIX), {
    schema_version: GC_PENDING_SCHEMA_VERSION,
    candidates: Array.from({ length: GC_MAX_PENDING_CANDIDATES }, (_, i) => ({
      key: snapshotKey(MANIFEST_PREFIX, 0, 1 + (i % (floor - 1)), i.toString(16).padStart(64, "0")),
      due_at: new Date(0).toISOString(),
      reason: "orphan-snapshot" as const,
      ...(cur.json.generation !== undefined && { generation: cur.json.generation }),
    })),
    last_swept_at: "",
  });
  return storage;
};

const worse = (a: CallCounts | undefined, b: CallCounts): CallCounts =>
  a === undefined || totalCalls(b) > totalCalls(a) ? b : a;

export interface FreeFetchRun {
  /** Most expensive whole request (route + tick) per write kind. */
  readonly writes: Record<FreeFetchWrite, CallCounts>;
  /** Most expensive read per kind, at any state a `mixed` request left. */
  readonly reads: Partial<Record<FreeFetchRead, CallCounts>>;
}

/**
 * Run each write kind at `indexes` indexes. `foldAtTailEntries` overrides
 * the adapter's trigger; `null` runs the ratio trigger alone.
 */
export const measureFreeFetchRun = async (
  indexes: number,
  foldAtTailEntries?: number | null,
): Promise<FreeFetchRun> => {
  const writes = {} as Record<FreeFetchWrite, CallCounts>;
  const writesPerRun = runWrites(
    foldAtTailEntries === undefined
      ? CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES
      : (foldAtTailEntries ?? undefined),
  );
  const reads = {} as Record<FreeFetchRead, CallCounts>;
  for (const kind of FREE_FETCH_WRITES) {
    const storage = await seed(indexes);
    /**
     * One write request: the route, then its queued tick, both counted.
     * `between` runs after the commit and before the tick.
     */
    const request = async (
      write: (coll: ReturnType<Db["collection"]>) => Promise<unknown>,
      between: () => Promise<void>,
    ): Promise<CallCounts> => {
      const tally = new CallTally();
      const counted = requestCountingStorage(storage, tally);
      const { foldAtTailEntries: adapterTrigger, ...rest } = FREE_FETCH_TICK_OPTIONS;
      const trigger = foldAtTailEntries === undefined ? adapterTrigger : foldAtTailEntries;
      const options: InternalBoundedMaintenanceOptions = {
        ...rest,
        ...(trigger !== null && trigger !== undefined && { foldAtTailEntries: trigger }),
        logRetention: { window: RUN_RETENTION_WINDOW },
      };
      // `waitUntil` runs the tick after the response; queue it so `between`
      // sees the state the write left.
      const pending: Array<() => Promise<void>> = [];
      const ctx = createObservabilityContext({
        maintenance: { options, dispatch: (task) => void pending.push(task) },
      });
      await runWithContext(ctx, () => write(makeDb(counted, indexes).collection(COLL)));
      await between();
      await runWithContext(ctx, async () => {
        for (const task of pending) {
          await task();
        }
      });
      return tally.read();
    };
    const measureReads = async (): Promise<void> => {
      for (const read of FREE_FETCH_READS) {
        if (read === "in-query" && indexes === 0) {
          continue;
        }
        const tally = new CallTally();
        const r = makeDb(requestCountingStorage(storage, tally), indexes).collection(COLL);
        if (read === "get") {
          await r.get(snapId(1));
        } else if (read === "indexed-query") {
          await r.where(indexes > 0 ? { f0: "v3" } : { n: 3 }).all();
        } else {
          const values = Array.from({ length: FREE_FETCH_IN_SIZE }, (_, v) => `v${v}`);
          await r.where((q) => q.in("f0", values)).all();
        }
        reads[read] = worse(reads[read], tally.read());
      }
    };
    for (let i = 0; i < writesPerRun; i++) {
      const patch = { f0: `w${i}`, f1: `w${i}`, f2: `w${i}`, n: -i };
      // A doc not written since its fold: its pre-image is outside the
      // post-commit walk, the update worst case.
      const cold = snapId(1 + (i % (SNAPSHOT_DOCS - 1)));
      const fixedStep: Record<FreeFetchWrite, number> = { insert: 0, update: 1, mixed: i % 4 };
      const step = fixedStep[kind];
      const counts = await request(
        (c) => {
          if (step === 0) {
            return c.insert(docBody(undefined, i));
          }
          if (step === 1) {
            return c.update(cold, patch);
          }
          // `mixed` also rewrites one hot doc, whose pre-image is one entry
          // back so its stale markers are DELETEd, and deletes cold docs, so
          // folds and GC ticks land on every kind of write.
          return step === 2 ? c.update(snapId(0), patch) : c.delete(cold);
          // Reads are measured on the `mixed` run only: the trigger, not the
          // write kind, sets the tail a read replays.
        },
        kind === "mixed" ? measureReads : async () => {},
      );
      writes[kind] = worse(writes[kind], counts);
    }
  }
  return { writes, reads };
};

/**
 * External subrequests one Workers Free invocation may spend on storage:
 * the 50-subrequest cap less 5 for the verifier and platform.
 */
export const FREE_FETCH_BUDGET = 45;

/**
 * Cache API calls the Worker adds to a request, which share the subrequest
 * quota: `match` plus `put` on a GET by id that misses, and one `delete`
 * on a PATCH or DELETE. `insert` (POST) and queries bypass the cache.
 * This program has no Cache API, so the values are measured through the
 * real Worker under workerd by
 * `packages/adapter-cloudflare/src/worker-maintenance.test.ts`, which fails
 * if they drift.
 */
export const FREE_FETCH_CACHE_API_CALLS: Record<FreeFetchWrite | FreeFetchRead, number> = {
  insert: 0,
  update: 1,
  mixed: 1,
  get: 2,
  "indexed-query": 0,
  "in-query": 0,
};

/** One measured free-fetch cell: its name, counts, and the Cache API calls on top. */
export interface FreeFetchCell {
  readonly name: string;
  readonly counts: CallCounts;
  readonly cacheApiCalls: number;
}

/**
 * Runs are deterministic, so one per module load serves both the snapshot
 * gate and the budget assertion in the same test file.
 */
const runs = new Map<string, Promise<FreeFetchRun>>();

/** The free-fetch cells at `indexes` indexes, named like the route grid's. */
export const freeFetchCells = async (
  indexes: number,
  foldAtTailEntries?: number | null,
): Promise<FreeFetchCell[]> => {
  const key = `${indexes}/${String(foldAtTailEntries)}`;
  let pending = runs.get(key);
  if (pending === undefined) {
    pending = measureFreeFetchRun(indexes, foldAtTailEntries);
    runs.set(key, pending);
  }
  const run = await pending;
  const suffix = ` idx=${indexes} snap=${SNAPSHOT_DOCS}`;
  const cells: FreeFetchCell[] = FREE_FETCH_WRITES.map((kind) => ({
    name: `free-fetch:${kind}+tick${suffix}`,
    counts: run.writes[kind],
    cacheApiCalls: FREE_FETCH_CACHE_API_CALLS[kind],
  }));
  for (const read of FREE_FETCH_READS) {
    const counts = run.reads[read];
    if (counts !== undefined) {
      const op = read === "in-query" ? `in-query[${FREE_FETCH_IN_SIZE}]` : read;
      cells.push({
        name: `free-fetch:${op}${suffix}`,
        counts,
        cacheApiCalls: FREE_FETCH_CACHE_API_CALLS[read],
      });
    }
  }
  return cells;
};
