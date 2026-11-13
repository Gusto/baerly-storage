/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the grid seeds doc bodies with it. */

/**
 * The deterministic grid behind `request-counts.json`: exact happy-path
 * storage-call counts per route and per maintenance tick, over
 * `MemoryStorage`, read off the request ledger's charge. Shared by `tests/unit/request-counts.test.ts` (the
 * gate) and `scripts/request-counts.ts` (`--write` / `--report`), so both
 * measure the same thing.
 *
 * Policy and how to read a failure:
 * docs/contributing/conventions/request-counts.md.
 */

import {
  casUpdateCurrentJson,
  createCurrentJson,
  CURRENT_JSON_SCHEMA_VERSION,
  type DocumentData,
  GC_STARVATION_GUARD,
  type IndexDefinition,
  MemoryStorage,
  readCurrentJson,
  type Storage,
  WRITE_TICK_GC_INTERVAL,
} from "@baerly/protocol";
import { compact, type InternalCompactOptions } from "../../packages/server/src/compactor.ts";
import { Db } from "../../packages/server/src/db.ts";
import { runBoundedMaintenance } from "../../packages/server/src/maintenance.ts";
import {
  createObservabilityContext,
  getCurrentContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import { chargedStorage } from "./ledgered-storage.ts";
import { freeFetchCells } from "./request-count-free-fetch.ts";
import type { CallCounts } from "./request-counting-storage.ts";

const APP = "rc";
const TENANT = "t";
const COLL = "docs";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_JSON_KEY = `${PREFIX}/current.json`;

/** Unfolded log entries past the snapshot. */
export const TAIL_LENGTHS = [0, 50, 200] as const;
/** Declared single-field indexes; every write touches all of them. */
export const INDEX_COUNTS = [0, 1, 3] as const;
/** Docs folded into the snapshot before the tail is written. */
export const SNAPSHOT_DOCS = [0, 100] as const;
/** `$in` list sizes for the indexed `$in` rows. */
export const IN_SIZES = [1, 2, 4, 8] as const;

/** The commit interval at which a write tick runs GC ahead of any fold. */
const HARD_GC_INTERVAL = WRITE_TICK_GC_INTERVAL * GC_STARVATION_GUARD;

/** Distinct values per indexed field, so an equality match hits 1 in 10 docs. */
const VALUE_CARDINALITY = 10;

interface StateSpec {
  readonly tail: number;
  readonly indexes: number;
  readonly snapshot: number;
}

const indexDefs = (n: number): IndexDefinition[] =>
  Array.from({ length: n }, (_, k) => ({ name: `by_f${k}`, on: `f${k}` }));

const docBody = (id: string | undefined, i: number): DocumentData => ({
  ...(id !== undefined && { _id: id }),
  f0: `v${i % VALUE_CARDINALITY}`,
  f1: `v${i % VALUE_CARDINALITY}`,
  f2: `v${i % VALUE_CARDINALITY}`,
  n: i,
});

const makeDb = (storage: Storage, indexes: number): Db =>
  Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    config: { collections: { [COLL]: { indexes: indexDefs(indexes) } } },
  });

/**
 * Run `fn` with in-band maintenance dropped, so a route's count is the
 * route alone. The tick it would dispatch is measured on its own by the
 * `tick:*` rows.
 */
const withoutTicks = <T>(fn: () => Promise<T>): Promise<T> => {
  // Keep the measuring context's ledger, so the route stays charged.
  const ledger = getCurrentContext()?.ledger;
  return Promise.resolve(
    runWithContext(
      createObservabilityContext({
        maintenance: { dispatch: () => {} },
        ...(ledger !== undefined && { ledger }),
      }),
      fn,
    ),
  );
};

/** Deep-copy every object, so a mutating route never leaks into the next cell. */
const cloneStorage = async (src: MemoryStorage): Promise<MemoryStorage> => {
  const dst = new MemoryStorage();
  for await (const { key } of src.list("")) {
    const got = await src.get(key);
    if (got !== null) {
      await dst.put(key, got.body);
    }
  }
  return dst;
};

/**
 * Build one grid state: provisioned `current.json`, `snapshot` docs folded
 * into a snapshot, then `tail` unfolded inserts. `tail_hint` is published
 * at the true tail, the state healthy maintenance converges to, so a read
 * replays exactly `tail` entries and pays no forward gallop over a stale
 * hint.
 */
const buildState = async (spec: StateSpec): Promise<MemoryStorage> => {
  const storage = new MemoryStorage();
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "request-count-grid", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
  const coll = makeDb(storage, spec.indexes).collection(COLL);
  await withoutTicks(async () => {
    for (let i = 0; i < spec.snapshot; i++) {
      await coll.insert(docBody(`s${String(i).padStart(3, "0")}`, i));
    }
  });
  if (spec.snapshot > 0) {
    const res = await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
      maxEntriesPerRun: spec.snapshot,
      minEntriesToCompact: 1,
    } as InternalCompactOptions);
    if (!res.written) {
      throw new Error(`request-count grid: seed fold did not land (${res.skippedReason})`);
    }
  }
  await withoutTicks(async () => {
    for (let i = 0; i < spec.tail; i++) {
      await coll.insert(docBody(`t${String(i).padStart(3, "0")}`, i));
    }
  });
  const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
  if (read === null) {
    throw new Error("request-count grid: current.json vanished");
  }
  const tail = read.json.log_seq_start + spec.tail;
  await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({ ...c, tail_hint: tail }));
  return storage;
};

/** A doc every state holds, when there is one: the snapshot's or the tail's first. */
const targetId = (spec: StateSpec): string => {
  if (spec.snapshot > 0) {
    return "s050";
  }
  return spec.tail > 0 ? "t000" : "absent";
};

/**
 * Count the calls `run` issues against `base`, as the request ledger
 * charges them (`chargedStorage` checks the charge equals what was
 * issued). A mutating cell runs on a private copy; `prepare` (uncounted)
 * brings that copy to the cell's starting state first.
 */
const measure = async (
  base: MemoryStorage,
  mutates: boolean,
  run: (storage: Storage) => Promise<unknown>,
  prepare?: (storage: Storage) => Promise<unknown>,
): Promise<CallCounts> => {
  const inner = mutates ? await cloneStorage(base) : base;
  await prepare?.(inner);
  const charged = chargedStorage(inner, "internal");
  await runWithContext(createObservabilityContext({ ledger: charged.ledger }), () =>
    run(charged.storage),
  );
  return charged.read();
};

const cellName = (op: string, spec: StateSpec, extra = ""): string =>
  `${op}${extra} tail=${spec.tail} idx=${spec.indexes} snap=${spec.snapshot}`;

/**
 * Measure the whole grid. Keys are stable, human-readable cell names
 * (`<op> tail=<n> idx=<n> snap=<n>`); insertion order is the grid order.
 */
export const measureRequestCounts = async (): Promise<Record<string, CallCounts>> => {
  const out: Record<string, CallCounts> = {};
  for (const snapshot of SNAPSHOT_DOCS) {
    for (const indexes of INDEX_COUNTS) {
      for (const tail of TAIL_LENGTHS) {
        const spec: StateSpec = { tail, indexes, snapshot };
        const base = await buildState(spec);
        const id = targetId(spec);
        const coll = (s: Storage) => makeDb(s, indexes).collection(COLL);
        const route = (op: string, mutates: boolean, fn: (s: Storage) => Promise<unknown>) =>
          measure(base, mutates, (s) => withoutTicks(() => fn(s))).then((c) => {
            out[cellName(op, spec)] = c;
          });

        await route("insert", true, (s) => coll(s).insert(docBody(undefined, 7)));
        await route("insert-with-id", true, (s) => coll(s).insert(docBody("new", 7)));
        // Rewrites every indexed field, so each index needs a new marker.
        const patch = { f0: "w", f1: "w", f2: "w" };
        await route("update", true, (s) => coll(s).update(id, patch));
        await route("delete", true, (s) => coll(s).delete(id));
        if (tail > 0) {
          // The newest doc: its pre-image is one log entry back, inside the
          // post-commit pre-image walk, so the stale markers are DELETEd.
          const latest = `t${String(tail - 1).padStart(3, "0")}`;
          await route("update-latest", true, (s) => coll(s).update(latest, patch));
          await route("delete-latest", true, (s) => coll(s).delete(latest));
        }
        await route("get", false, (s) => coll(s).get(id));
        await route("indexed-query", false, (s) => coll(s).where({ f0: "v3" }).all());
        await route("indexed-miss", false, (s) => coll(s).where({ f0: "absent" }).all());
        await route("scan", false, (s) => coll(s).where({ n: 3 }).all());

        if (indexes > 0) {
          for (const k of IN_SIZES) {
            const values = Array.from({ length: k }, (_, i) => `v${i}`);
            await route(`in-query[${k}]`, false, (s) =>
              coll(s)
                .where((q) => q.in("f0", values))
                .all(),
            );
          }
        }

        const read = await readCurrentJson(base, CURRENT_JSON_KEY);
        const observedTail = read!.json.tail_hint;
        // The forced write tick (`forceFold`), crossing no GC cadence
        // boundary, so the tick's one phase is the fold.
        const foldTick = (s: Storage) =>
          runBoundedMaintenance({
            storage: s,
            currentJsonKey: CURRENT_JSON_KEY,
            prevSeq: observedTail,
            observedTail,
            forceFold: true,
          });
        // A commit crossing the hard-GC boundary: the GC slice plus log
        // retirement, no fold. A cadence GC tick with no fold due runs the
        // same phases.
        const gcTick = (s: Storage, gcGraceMillis?: number) =>
          runBoundedMaintenance(
            {
              storage: s,
              currentJsonKey: CURRENT_JSON_KEY,
              prevSeq: Math.floor(observedTail / HARD_GC_INTERVAL) * HARD_GC_INTERVAL - 1,
              observedTail,
            },
            gcGraceMillis === undefined ? undefined : { gcGraceMillis },
          );
        const tick = async (
          op: string,
          run: (s: Storage) => Promise<unknown>,
          prepare?: (s: Storage) => Promise<unknown>,
        ) => {
          out[cellName(op, spec)] = await measure(base, true, run, prepare);
        };
        await tick("tick:gc", (s) => gcTick(s));
        if (tail > 0) {
          await tick("tick:fold", foldTick);
          // After a fold: GC marks the replaced snapshot and folded markers.
          await tick("tick:gc-mark", (s) => gcTick(s), foldTick);
          // Same, with the grace period elapsed, so the slice also sweeps.
          await tick("tick:gc-sweep", (s) => gcTick(s, 0), foldTick);
        }
      }
    }
  }
  // Whole requests on Workers Free with storage reached through `fetch`.
  for (const indexes of INDEX_COUNTS) {
    for (const cell of await freeFetchCells(indexes)) {
      out[cell.name] = cell.counts;
    }
  }
  return out;
};
