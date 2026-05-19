/**
 * Causal-consistency cascade — backend-agnostic property test driver.
 *
 * Lifted from the legacy `tests/integration/randomized.test.ts` body
 * with three substitutions: writes go through `ServerWriter.commit()`
 * (one `LogEntry` per call), reads walk the log to the freshest entry
 * for `(collection, docId)`, and clock-skew entropy moves from a
 * legacy `clockOffset` config field to a per-instance offset added
 * when minting log entries. Cross-instance handshake is the shared backing store: each
 * variant returns N {@link Storage} handles that observe each other's
 * writes.
 *
 * Pure module — no Node imports, no `node:fs`, no `node:os`. The
 * Cloudflare Workers pool (`packages/adapter-cloudflare/src/randomized.test.ts`)
 * consumes this file directly inside Workerd; the Node-only variant
 * setup (temp dirs, Toxiproxy fetch) lives in the call site.
 *
 * @see tests/integration/randomized.test.ts (Node-side variants)
 * @see packages/adapter-cloudflare/src/randomized.test.ts (Workerd variant)
 */

import { expect } from "vitest";
import {
  type CurrentJson,
  CURRENT_JSON_SCHEMA_VERSION,
  type DocumentData,
  type LogEntry,
  BaerlyError,
  matches,
  type Predicate,
  type Storage,
  createCurrentJson,
  readCurrentJson,
  uuid,
} from "@baerly/protocol";
import {
  allIndexKeysFor,
  Db,
  type IndexDefinition,
  rebuildIndex,
  ServerWriter,
} from "@baerly/server";
import {
  CentralisedOfflineFirstCausalSystem,
  type Grounding,
  type Knowledge,
} from "./consistency.ts";

/**
 * Causal-consistency check without `eval()`. Workerd disallows code
 * generation from strings, so the fixture's `check()` (which builds
 * a JS expression and `eval`s it) cannot run under
 * `@cloudflare/vitest-pool-workers`. We re-implement the check
 * structurally here: every clause in {@link Knowledge} has the form
 * `<comment> <varA> < <varB>` joined by ` &&\n`, and every variable
 * appears in {@link Grounding}. Parse `varA` / `varB` directly,
 * compare grounded values, return true iff every clause holds.
 *
 * Leaving `tests/fixtures/consistency.ts` untouched (per ticket 07
 * scope: read only) — this helper lives in the cascade driver
 * because it's an environment-specific shim.
 */
const causallyConsistent = (grounding: Grounding, kb: Knowledge): boolean => {
  for (const clause of Object.keys(kb)) {
    // Clauses look like `/*P1*/ A3 < A4` or `/*P2*/ C1 < A2`. The
    // comment prefix is variable; we want the two variable tokens
    // around `<`. Split on `<` first to grab the rhs, then strip the
    // leading comment / whitespace off the lhs.
    const ltIdx = clause.indexOf("<");
    if (ltIdx < 0) {
      return false;
    }
    const rawLhs = clause.slice(0, ltIdx).trim();
    const rhs = clause.slice(ltIdx + 1).trim();
    // The lhs may be `/*P2*/ C1` — drop the `*/`-prefix if present.
    const lhs = rawLhs.replace(/^\/\*[^*]*\*\/\s*/, "");
    const lv = grounding[lhs];
    const rv = grounding[rhs];
    if (lv === undefined || rv === undefined) {
      return false;
    }
    if (!(lv < rv)) {
      return false;
    }
  }
  return true;
};

/**
 * One write target: a `Db` (for tenant-scoped key resolution + future
 * lint compliance), the `ServerWriter` bound to its collection, and
 * the bucket-relative `current.json` key shared across instances.
 */
interface Instance {
  readonly db: Db;
  readonly writer: ServerWriter;
  readonly storage: Storage;
  readonly currentJsonKey: string;
  readonly logPrefix: string;
}

const APP = "randomized";
const COLLECTION = "k"; // single-key cascade — `collection === docId`
const MAX_STEPS = 100;

/**
 * Shape of one client's broadcast — kept in sync with the legacy
 * `Message` type. Doubles as the `LogEntry.new` body.
 */
interface CascadeMessage extends DocumentData {
  sender: number;
  send_time: number;
}

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
});

/**
 * Tolerant `createCurrentJson` — multiple test instances share the
 * same backing store, so exactly one wins the bootstrap CAS and the
 * others see `Conflict` (which the protocol translates from
 * `PreconditionFailed`). The losers adopt the existing record.
 */
const ensureCurrent = async (storage: Storage, key: string): Promise<void> => {
  try {
    await createCurrentJson(storage, key, seedCurrent());
  } catch (error) {
    if (error instanceof BaerlyError && error.code === "Conflict") {
      const got = await readCurrentJson(storage, key);
      if (got !== null) {
        return;
      }
    }
    throw error;
  }
};

/**
 * Resolve the latest committed value for `(collection, docId)` by
 * reading `current.json`, then walking from `next_seq - 1` backwards
 * until we hit an entry whose `doc_id` matches. Returns `undefined`
 * when no entry has landed yet. Tolerates transient read failures
 * (Toxiproxy flips, R2 propagation jitter) by re-throwing — callers
 * swallow.
 */
const readLatest = async (inst: Instance): Promise<CascadeMessage | undefined> => {
  const read = await readCurrentJson(inst.storage, inst.currentJsonKey);
  if (read === null) {
    return undefined;
  }
  const nextSeq = read.json.next_seq;
  for (let s = nextSeq - 1; s >= 0; s--) {
    const got = await inst.storage.get(`${inst.logPrefix}/log/${s}.json`);
    if (got === null) {
      continue;
    }
    let entry: LogEntry;
    try {
      entry = JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
    } catch {
      continue;
    }
    if (entry.doc_id === COLLECTION && entry.op === "U" && entry.new !== undefined) {
      return entry.new as CascadeMessage;
    }
  }
  return undefined;
};

/**
 * T4 invariant — when the filtered index is declared, the live key
 * set under its prefix MUST equal `allIndexKeysFor(FILTERED_INDEX,
 * liveBody)` after a {@link rebuildIndex} reconciliation pass.
 *
 * Multi-writer cascade contention can leave orphan index entries in
 * the bucket — CAS retries throw the prior attempt's PUT/DELETE
 * work away from `current.json` but the storage-level keys persist
 * until the next writer's diff path cleans them up or a rebuild
 * runs. The chapter's correctness invariant lives at the rebuild
 * boundary: after rebuild, the on-storage key set MUST equal the
 * filter-aware projection of the live doc set.
 *
 * The cascade is single-key (`COLLECTION === docId`) so the live
 * set is at most one row; the expectation collapses to "zero keys
 * iff the live doc doesn't satisfy the filter, else one key for
 * that doc".
 */
const assertFilteredIndexConsistent = async (inst: Instance): Promise<void> => {
  // Quiesce the cascade with a rebuild pass before asserting. The
  // rebuild reconciles the live doc set against the on-storage
  // index keys (CONTRACTS §4 — `rebuildIndex` consumes
  // `allIndexKeysFor` and is filter-aware via T4's projector
  // change).
  await rebuildIndex(inst.storage, inst.currentJsonKey, FILTERED_INDEX);
  const live = await readLatest(inst);
  const expected = new Set(allIndexKeysFor(inst.logPrefix, [FILTERED_INDEX], live, COLLECTION));
  const actual = new Set<string>();
  for await (const entry of inst.storage.list(`${inst.logPrefix}/index/${FILTERED_INDEX.name}/`)) {
    actual.add(entry.key);
  }
  expect(actual, "filtered-index live key set != allIndexKeysFor(liveBody)").toEqual(expected);
};

/**
 * Build N writer instances over a set of shared `Storage` handles —
 * each handle's underlying backing is identical so writes through any
 * one are visible through any other. Each instance lives under a
 * distinct `tenant` so tenant-scoping is exercised on the read side,
 * but the cascade's CAS target — `current.json` — is a single
 * bucket-relative key shared across all N writers (the test
 * deliberately routes contention to one CAS pointer to make the
 * concurrent-writer property actually concurrent).
 */
/**
 * Filtered-index injected by `runCausalConsistencyCascade` when
 * `opts.injectFilteredIndex === true` (T4). Filters on `sender === 0`
 * so ~1/N of writes match the predicate; the assertion at the end
 * of the cascade walks the storage and checks the live key set
 * equals `allIndexKeysFor(FILTERED_INDEX)(liveBody)`.
 */
const FILTERED_INDEX: IndexDefinition = {
  name: "cascade_filter",
  on: "send_time",
  predicate: { sender: 0 },
};

const buildInstances = async (
  storages: Storage[],
  indexes: ReadonlyArray<IndexDefinition>,
): Promise<Instance[]> => {
  // Pick a deterministic tenant for the CAS-shared current.json so all
  // N writers contend on the same key. (`Db.create` enforces a "/"-free
  // tenant; tests use a fresh suffix per cascade.)
  const sharedTenant = `cascade-${uuid().slice(0, 8)}`;
  const sharedCurrentKey = `app/${APP}/tenant/${sharedTenant}/manifests/${COLLECTION}/current.json`;
  const sharedLogPrefix = `app/${APP}/tenant/${sharedTenant}/manifests/${COLLECTION}`;

  // One bootstrap CAS — losers adopt the winner.
  await ensureCurrent(storages[0]!, sharedCurrentKey);

  return storages.map((storage, i) => {
    const db = Db.create({
      storage,
      app: APP,
      // Use the same tenant for the CAS target while still constructing
      // a Db per client so the lint rule's no-tenantless-ctor check is
      // exercised and the Db._raw surface is available to callers.
      tenant: sharedTenant,
    });
    void i;
    const writer = new ServerWriter({
      storage,
      currentJsonKey: sharedCurrentKey,
      // Smaller initial backoff to keep N-way races snappy under
      // memory; the legacy POLL_TICK_MS budget assumes sub-second
      // commit latency.
      options: indexes.length > 0 ? { initialBackoffMs: 5, indexes } : { initialBackoffMs: 5 },
    });
    return {
      db,
      writer,
      storage,
      currentJsonKey: sharedCurrentKey,
      logPrefix: sharedLogPrefix,
    };
  });
};

/**
 * Run the all-to-all single-key cascade. Returns when `MAX_STEPS`
 * observations have been recorded by the {@link CentralisedOfflineFirstCausalSystem}
 * (success) or rejects on assertion failure / unexpected error.
 *
 * Control flow ports the legacy harness's `causal consistency
 * all-to-all, single key` test body verbatim — same `handle()`
 * dispatcher, same `system.observe()` calls, same `JSON.stringify(val)`
 * change-detection in the poll loop.
 *
 * @param opts.storages   N {@link Storage} handles sharing a backing
 *                        store; `N === storages.length`.
 * @param opts.pollTickMs Per-client poll cadence in ms; tuned per
 *                        backend (memory 5, local-fs 10, R2 25,
 *                        Minio 50).
 * @param opts.clockOffsetsMs Per-client clock skew. Defaults to random
 *                        offsets in `[-1000, +1000]` ms — matches the
 *                        legacy harness's per-client `clockOffset`
 *                        entropy.
 */
export const runCausalConsistencyCascade = (opts: {
  storages: Storage[];
  pollTickMs: number;
  clockOffsetsMs?: readonly number[];
  /**
   * T4: when `true`, the cascade declares a sparse filtered index
   * over the single shared doc and, after the cascade completes,
   * asserts the on-storage key set under the index's prefix equals
   * `allIndexKeysFor(FILTERED_INDEX, liveDoc)`. The filter matches
   * roughly 1/N of broadcasts (`sender === 0`), exercising both the
   * miss→match and match→miss U-quadrants under live contention.
   */
  injectFilteredIndex?: boolean;
}): Promise<void> =>
  new Promise<void>((done, reject) => {
    void (async () => {
      try {
        const N = opts.storages.length;
        const clockOffsets =
          opts.clockOffsetsMs ?? Array.from({ length: N }, () => Math.random() * 2000 - 1000);
        const declaredIndexes: ReadonlyArray<IndexDefinition> = opts.injectFilteredIndex
          ? [FILTERED_INDEX]
          : [];
        const instances = await buildInstances(opts.storages, declaredIndexes);
        const system = new CentralisedOfflineFirstCausalSystem();

        let testFailed = false;
        let finished = false;

        // Per-client commit serializer. `ServerWriter.commit()` is
        // stateless and concurrent — two `commit()` calls on the same
        // instance race each other, and the loser of a CAS race can
        // ultimately land at a HIGHER `seq` than the winner even
        // though it carried a SMALLER `send_time`. That breaks the
        // per-sender monotonic `send_time` invariant that the
        // causal-consistency model relies on at read time.
        //
        // The legacy harness sidestepped this because the old
        // browser-side `put` had an internal per-client write queue;
        // the new test re-creates that queue explicitly. Effect:
        // per-client broadcast order == per-client log-seq order, same
        // as the legacy harness.
        const commitQueues: Promise<void>[] = Array.from({ length: N }, () => Promise.resolve());

        // Drives the cascade: observe a value, check invariants,
        // broadcast a fresh `LogEntry`. Reads come from the per-client
        // polling loop below.
        const handle = (client_id: number, val: CascadeMessage | undefined): void => {
          const label = system.client_labels[client_id];
          if (val !== undefined) {
            console.log(
              `${system.global_time}: ${label}@${system.client_clocks[
                client_id
              ]!} rcvd ${system.client_labels[val.sender]}@${val.send_time}`,
            );
            system.observe({ ...val, receiver: client_id });
          }

          if (system.global_time < MAX_STEPS && !testFailed) {
            testFailed = !causallyConsistent(system.grounding, system.knowledge_base);
            if (testFailed) {
              console.error(system.grounding);
              console.error(system.knowledge_base);
            }
            expect(testFailed).toBe(false);

            system.observe({
              receiver: client_id,
              sender: client_id,
              send_time: system.client_clocks[client_id]! - 1,
            });
            testFailed = !causallyConsistent(system.grounding, system.knowledge_base);
            expect(testFailed).toBe(false);

            const send_time = system.client_clocks[client_id]! - 1;
            console.log(`${system.global_time}: ${label}@${send_time} broadcast`);

            // Drive the new write loop directly. ServerWriter mints the
            // LogEntry; clock skew is per-instance and unused by the
            // new core's lsn shape (the seq is what's load-bearing) —
            // we keep it as fault-injection entropy: the
            // `commit_ts`-equivalent travels through `Date.now()` on
            // the cascading peer's machine and a ±1s skew exercises
            // the protocol's tolerance to it. The offset is
            // approximated via a brief sleep-or-not before the commit
            // so the inter-broadcast spacing remains skewed by the
            // configured offset's positive component. (Negative
            // offsets are a no-op — we can't time-travel into the
            // past.)
            const offset = clockOffsets[client_id]!;
            const delayMs = offset > 0 ? Math.min(offset, 5) : 0;
            const message: CascadeMessage = { sender: client_id, send_time };
            // Chain onto the per-client queue so commits on this
            // instance land in broadcast order.
            commitQueues[client_id] = commitQueues[client_id]!.then(async () => {
              if (finished) {
                return;
              }
              if (delayMs > 0) {
                await new Promise<void>((r) => setTimeout(r, delayMs));
              }
              try {
                await instances[client_id]!.writer.commit({
                  op: "U",
                  collection: COLLECTION,
                  docId: COLLECTION,
                  body: message,
                });
              } catch (error) {
                // Transient Conflict under contention is fine — the
                // peer will re-broadcast on its next observe. Other
                // errors propagate.
                if (error instanceof BaerlyError && error.code === "Conflict") {
                  return;
                }
                finished = true;
                reject(error);
              }
            });
          } else if (system.global_time >= MAX_STEPS && !finished) {
            finished = true;
            // Drain any in-flight commits before running the
            // filtered-index invariant — otherwise the on-storage
            // key set is racing the last broadcast.
            void (async () => {
              try {
                await Promise.allSettled(commitQueues);
                if (opts.injectFilteredIndex) {
                  await assertFilteredIndexConsistent(instances[0]!);
                }
                done();
              } catch (error) {
                reject(error);
              }
            })();
          }
        };

        // Kick the cascade — each client observes the undefined seed
        // once before the polling loop catches up to remote writes.
        instances.forEach((_, client_id) => handle(client_id, undefined));

        instances.forEach((inst, client_id) => {
          void (async () => {
            let prev: string | undefined = undefined;
            while (!finished) {
              await new Promise<void>((r) => setTimeout(r, opts.pollTickMs));
              if (finished) {
                return;
              }
              try {
                const val = await readLatest(inst);
                const serialized = JSON.stringify(val);
                if (serialized !== prev) {
                  prev = serialized;
                  try {
                    handle(client_id, val);
                  } catch (error) {
                    finished = true;
                    reject(error);
                    return;
                  }
                }
              } catch (error) {
                // Swallow transient read failures — under Toxiproxy the
                // network flips every 100ms during the Minio variant,
                // and under R2 propagation jitter we may briefly see
                // stale state. The next tick retries.
                void error;
              }
            }
          })();
        });
      } catch (error) {
        reject(error);
      }
    })();
  });

// ---------------------------------------------------------------------
// Range-walk parity cascade (T3)
// ---------------------------------------------------------------------

/**
 * Doc shape consumed by the range-walk parity cascade. `priority`
 * is a string-typed field intentionally — `encodeIndexValue` is
 * value-order-preserving across every supported type, so numeric
 * ranges would also route through the index, but pinning priorities
 * to short string tokens keeps the cascade's surface stable across
 * tickets and makes the in-memory full-scan baseline easy to read.
 */
interface ParityDoc extends DocumentData {
  readonly _id: string;
  readonly priority: string;
}

/**
 * Seed N random docs into the collection via a single ServerWriter
 * with the `by_priority` index declared. Returns the seeded docs
 * so the caller can compute the expected (full-scan) result in
 * memory.
 */
const seedParityDocs = async (
  storage: Storage,
  app: string,
  tenant: string,
  collection: string,
  indexes: ReadonlyArray<IndexDefinition>,
  count: number,
  priorityAlphabet: ReadonlyArray<string>,
): Promise<ParityDoc[]> => {
  const currentJsonKey = `app/${app}/tenant/${tenant}/manifests/${collection}/current.json`;
  await ensureCurrent(storage, currentJsonKey);
  const writer = new ServerWriter({
    storage,
    currentJsonKey,
    options: { indexes },
  });
  const docs: ParityDoc[] = [];
  for (let i = 0; i < count; i++) {
    const priority = priorityAlphabet[i % priorityAlphabet.length]!;
    const doc: ParityDoc = { _id: `d-${i}`, priority };
    docs.push(doc);
    await writer.commit({
      op: "I",
      collection,
      docId: doc._id,
      body: doc,
    });
  }
  return docs;
};

/**
 * Range-walk parity cascade: for a set of random string-typed range
 * predicates over a seeded doc set, assert that the
 * `db.table().where(p).all()` result (routed through the planner
 * when the predicate matches the declared index) matches the
 * in-memory full-scan result `docs.filter(d => matches(p, d))`.
 *
 * Deliberately scoped to STRING-typed bounds: the planner's
 * NUMERIC-RANGE GUARD refuses numeric ranges, so the property
 * trivially holds for them (both paths route through full-scan).
 * Composite + $in parity is folded in the same loop so the cascade
 * exercises all three T3 walk shapes.
 *
 * @param opts.storages         One Storage handle (the cascade
 *                              doesn't need cross-instance writes).
 * @param opts.app              app name; tenant is randomised per
 *                              call so test runs don't collide.
 * @param opts.iterations       Number of random predicates to
 *                              evaluate. Each iteration runs the
 *                              routed read + the in-memory full-
 *                              scan + the equality check.
 */
export const runRangeWalkParityCascade = async (opts: {
  storage: Storage;
  app?: string;
  tenant?: string;
  collection?: string;
  iterations?: number;
}): Promise<void> => {
  const app = opts.app ?? "rwparity";
  const tenant = opts.tenant ?? `t-${uuid().slice(0, 8)}`;
  const collection = opts.collection ?? "items";
  const iterations = opts.iterations ?? 16;
  const indexes: ReadonlyArray<IndexDefinition> = [{ name: "by_priority", on: "priority" }];
  // 9 string-typed buckets — wide enough to make range slicing
  // meaningful, narrow enough that the cascade stays under a
  // second on memory.
  const priorityAlphabet = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];
  const seeded = await seedParityDocs(
    opts.storage,
    app,
    tenant,
    collection,
    indexes,
    72,
    priorityAlphabet,
  );

  const db = Db.create({
    storage: opts.storage,
    app,
    tenant,
    indexes: new Map([[collection, indexes]]),
  });
  const table = db.table<ParityDoc>(collection);

  // Deterministic pseudo-random for reproducibility (LCG seeded
  // off tenant). Spec doesn't require cryptographic randomness;
  // we just want decent coverage of bound combinations.
  let rngState = 0;
  for (let i = 0; i < tenant.length; i++) {
    rngState = (rngState * 31 + tenant.charCodeAt(i)) | 0;
  }
  const rand = (): number => {
    rngState = (rngState * 1664525 + 1013904223) | 0;
    return ((rngState >>> 0) % 1_000_000) / 1_000_000;
  };
  const pick = <U>(arr: ReadonlyArray<U>): U => arr[Math.floor(rand() * arr.length)]!;

  for (let iter = 0; iter < iterations; iter++) {
    // Random predicate shape — mix of one-sided / two-sided range
    // and small $in. All bounds are string-typed.
    const shape = Math.floor(rand() * 5);
    let predicate: Predicate<ParityDoc>;
    if (shape === 0) {
      // One-sided $gte
      predicate = { priority: { $gte: pick(priorityAlphabet) } } as unknown as Predicate<ParityDoc>;
    } else if (shape === 1) {
      // One-sided $lt
      predicate = { priority: { $lt: pick(priorityAlphabet) } } as unknown as Predicate<ParityDoc>;
    } else if (shape === 2) {
      // Two-sided, varying inclusivity. Pick distinct values so
      // the interval is never empty (lo < hi strictly); T1
      // validation throws UnsatisfiablePredicate on lo == hi with
      // strict comparison or lo > hi.
      const a = Math.floor(rand() * priorityAlphabet.length);
      let b = Math.floor(rand() * priorityAlphabet.length);
      if (a === b) {
        b = (b + 1) % priorityAlphabet.length;
      }
      const aVal = priorityAlphabet[a]!;
      const bVal = priorityAlphabet[b]!;
      const lo = aVal < bVal ? aVal : bVal;
      const hi = aVal < bVal ? bVal : aVal;
      const loInclusive = rand() > 0.5;
      const hiInclusive = rand() > 0.5;
      const op: Record<string, string> = {};
      op[loInclusive ? "$gte" : "$gt"] = lo;
      op[hiInclusive ? "$lte" : "$lt"] = hi;
      predicate = { priority: op } as unknown as Predicate<ParityDoc>;
    } else if (shape === 3) {
      // $in with 1-3 values
      const size = 1 + Math.floor(rand() * 3);
      const values: string[] = [];
      for (let v = 0; v < size; v++) {
        values.push(pick(priorityAlphabet));
      }
      predicate = {
        priority: { $in: values },
      } as unknown as Predicate<ParityDoc>;
    } else {
      // Plain equality (still exercises the planner's routing).
      predicate = { priority: pick(priorityAlphabet) } as unknown as Predicate<ParityDoc>;
    }

    const expected = seeded.filter((d) => matches(predicate, d));
    const actual = await table.where(predicate).all();
    expect(
      actual.map((r) => r._id).toSorted(),
      `range-walk parity mismatch for predicate ${JSON.stringify(predicate)}`,
    ).toEqual(expected.map((d) => d._id).toSorted());
  }
};
