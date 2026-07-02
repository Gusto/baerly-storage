/**
 * Causal-consistency cascade — backend-agnostic property test driver.
 *
 * Lifted from the legacy `tests/integration/randomized.test.ts` body
 * with three substitutions: writes go through `Writer.commit()`
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
  type Collection,
  type CurrentJson,
  type DocumentData,
  type IndexDefinition,
  type LogEntry,
  BaerlyError,
  matchesWire,
  normalizePredicateArg,
  type PredicateArg,
  type Storage,
  createCurrentJson,
  readCurrentJson,
  uuid,
} from "@baerly/protocol";
import { allIndexKeysFor, Db, probeTailFrom } from "@baerly/server";
import { rebuildIndex } from "@baerly/server/maintenance";
import { Writer } from "@baerly/server/_internal/testing";
import {
  CentralisedOfflineFirstCausalSystem,
  type Grounding,
  type Knowledge,
} from "./consistency.ts";
import { logStateCurrentJson } from "./log-state.ts";

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
 * lint compliance), the `Writer` bound to its collection, and
 * the bucket-relative `current.json` key shared across instances.
 */
interface Instance {
  readonly db: Db;
  readonly writer: Writer;
  readonly storage: Storage;
  readonly currentJsonKey: string;
  readonly logPrefix: string;
}

const APP = "randomized";
const COLLECTION = "k"; // single-key cascade — `collection === docId`
const MAX_STEPS = 100;

/**
 * Small seeded LCG (same constants as the range-walk parity cascade's
 * inline RNG) so the causal cascade's injected entropy is reproducible
 * across runs — and, critically, across languages. `Math.random()` cannot
 * be regenerated outside JS; a logged integer seed can.
 *
 * NOTE: this seeds only the INJECTED entropy (per-client clock offsets).
 * Real `setTimeout` timers still make the observed interleaving
 * wall-clock dependent, so replaying a seed reproduces the offsets, not a
 * byte-identical schedule. Full deterministic replay (virtual clock +
 * scripted storage) is deferred — see the determinism track of the
 * cross-language conformance program.
 */
export const makeLcg = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state * 1664525 + 1013904223) | 0;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
};

/**
 * Shape of one client's broadcast — kept in sync with the legacy
 * `Message` type. Doubles as the `LogEntry.after` body.
 */
interface CascadeMessage extends DocumentData {
  sender: number;
  send_time: number;
}

const seedCurrent = (): CurrentJson => logStateCurrentJson();

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
 * reading `current.json`, discovering the TRUE tail via forward-probe
 * (under single-write commit `tail_hint` is only a lower bound — the
 * writer never advances it), then walking backwards until we hit an
 * entry whose `doc_id` matches. Returns `undefined` when no entry has
 * landed yet. Tolerates transient read failures (Toxiproxy flips, R2
 * propagation jitter) by re-throwing — callers swallow.
 *
 * `docId` defaults to {@link COLLECTION} so the single-key cascade
 * (where `collection === docId`) keeps its exact behavior; the
 * multi-doc cascade passes a distinct id per doc.
 */
const readLatest = async (
  inst: Instance,
  docId: string = COLLECTION,
): Promise<CascadeMessage | undefined> => {
  const read = await readCurrentJson(inst.storage, inst.currentJsonKey);
  if (read === null) {
    return undefined;
  }
  const floor = Math.max(read.json.log_seq_start, read.json.tail_hint);
  const probe = await probeTailFrom(inst.storage, inst.logPrefix, floor);
  const nextSeq = probe.tail;
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
    if (entry.doc_id === docId && entry.op === "U" && entry.after !== undefined) {
      return entry.after as CascadeMessage;
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
  const live = await readLatest(inst, COLLECTION);
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
  predicate: { clauses: [{ op: "eq", field: "sender", value: 0 }] },
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
      // exercised.
      tenant: sharedTenant,
    });
    void i;
    const writer = new Writer({
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
 * Run a storage-touching read under bounded retry on transient
 * `NetworkError`. The node-minio variant flips its Toxiproxy proxy every
 * 100 ms, so a read landing in a dead window rejects with a
 * {@link BaerlyError} whose `code` is `"NetworkError"`; Minio / S3 are
 * strongly consistent, so once a window opens the value is complete and
 * the retry only rides out the dead window. Non-`NetworkError` failures
 * (and genuine assertion failures) propagate immediately. The whole `op`
 * re-runs per attempt, so consumers that accumulate (e.g. draining an
 * async list into a set) must build their result fresh inside `op`.
 */
export const MAX_NETWORK_RETRIES = 5;
export const withNetworkRetry = async <T>(op: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (
        error instanceof BaerlyError &&
        error.code === "NetworkError" &&
        attempt < MAX_NETWORK_RETRIES
      ) {
        await new Promise<void>((r) => setTimeout(r, 10 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
};

/**
 * Collect the set of committed `log/<seq>.json` slot numbers under a
 * collection's log prefix. Matches ONLY `<logPrefix>/log/<digits>.json`
 * slot keys — ignoring `current.json`, index subdirs, etc. — and rides
 * out transient network windows via {@link withNetworkRetry}.
 */
const collectCommittedSlots = async (inst: Instance): Promise<Set<number>> => {
  const slotKeyPattern = new RegExp(`^${escapeRegExp(`${inst.logPrefix}/log/`)}(\\d+)\\.json$`);
  return withNetworkRetry(async () => {
    const slots = new Set<number>();
    for await (const listed of inst.storage.list(`${inst.logPrefix}/log/`)) {
      const m = slotKeyPattern.exec(listed.key);
      if (m !== null) {
        slots.add(Number.parseInt(m[1]!, 10));
      }
    }
    return slots;
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
  /**
   * Seed for the per-client clock-offset entropy. When omitted a seed is
   * derived from `Math.random()` and logged at start, so a flake can be
   * replayed by passing the logged value back as `{ seed }`.
   */
  seed?: number;
}): Promise<void> =>
  new Promise<void>((done, reject) => {
    void (async () => {
      try {
        const N = opts.storages.length;
        const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
        const rand = makeLcg(seed);
        console.log(`[cascade] seed=${seed} N=${N} pollTickMs=${opts.pollTickMs}`);
        const clockOffsets =
          opts.clockOffsetsMs ?? Array.from({ length: N }, () => rand() * 2000 - 1000);
        // Portable failing-schedule artifact: every observation is
        // appended here and dumped (with the seed) if a causal-consistency
        // clause fails, so the interleaving can be inspected / replayed.
        const schedule: Array<{
          tick: number;
          receiver: number;
          sender: number;
          send_time: number;
        }> = [];
        // No-lost-writes ledger: every commit that RETURNS success records
        // its won slot here; at drain, each MUST be present in the durable
        // log-slot set. `entry.seq` is the `log/<seq>` slot (writer mints
        // `logObjectKey(logPrefix, seq)` at that seq).
        const ackedSeqs = new Set<number>();
        const declaredIndexes: ReadonlyArray<IndexDefinition> = opts.injectFilteredIndex
          ? [FILTERED_INDEX]
          : [];
        const instances = await buildInstances(opts.storages, declaredIndexes);
        const system = new CentralisedOfflineFirstCausalSystem();

        let testFailed = false;
        let finished = false;

        // Per-client commit serializer. `Writer.commit()` is
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
            schedule.push({
              tick: system.global_time,
              receiver: client_id,
              sender: val.sender,
              send_time: val.send_time,
            });
          }

          // KNOWN FLAKE (node-minio only): a 9h/102-iteration overnight fuzz
          // tripped this assertion once, exclusively on the node-minio variant
          // during a Toxiproxy socket-close storm. A 30/30 re-run with the
          // twiddler disabled (NO faults) was clean, so it is fault-injection-
          // coupled, NOT a kernel causal-consistency bug. The exact mechanism
          // (why a *successful* read appears causally backwards under
          // connection churn, given Minio is strongly consistent) is not yet
          // root-caused — tracked as a follow-up; do NOT add tolerance here
          // until it is, or we risk masking a real violation. If this EVER
          // fires on a fault-free variant (memory / local-fs / cloudflare-r2),
          // treat it as a real bug.
          if (system.global_time < MAX_STEPS && !testFailed) {
            testFailed = !causallyConsistent(system.grounding, system.knowledge_base);
            if (testFailed) {
              console.error(`[cascade] CAUSAL VIOLATION seed=${seed}`);
              console.error(system.grounding);
              console.error(system.knowledge_base);
              console.error(`[cascade] schedule=${JSON.stringify(schedule)}`);
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

            // Drive the new write loop directly. Writer mints the
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
                const result = await instances[client_id]!.writer.commit({
                  op: "U",
                  collection: COLLECTION,
                  docId: COLLECTION,
                  body: message,
                });
                ackedSeqs.add(result.entry.seq);
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
                // No-lost-writes (SG-1): every acked commit's slot is durable.
                const committed = await collectCommittedSlots(instances[0]!);
                const missing = [...ackedSeqs].filter((s) => !committed.has(s));
                expect(
                  missing,
                  `no-lost-writes: acked commits missing from the durable log-slot set ${JSON.stringify(
                    [...committed].toSorted((a, b) => a - b),
                  )}`,
                ).toEqual([]);
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
// Multi-doc-per-collection cascade (Finding 3c)
// ---------------------------------------------------------------------

/** Escape a literal string for safe interpolation into a `RegExp`. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Result of {@link runMultiDocCascade}, consumed by the assertions in
 * `tests/integration/randomized.test.ts`.
 */
export interface MultiDocCascadeResult {
  /** The doc ids driven through the one collection. */
  readonly docIds: readonly string[];
  /**
   * Per doc id, the ordered list of values WRITTEN to that doc across
   * all writers, keyed by canonical token (`<writer>:<n>`). Order is the
   * commit-enqueue order on each doc's serializer, which equals the
   * order those commits take in the shared log (the log linearizes the
   * collection and the per-doc serializer keeps a doc's own commits in
   * enqueue order).
   */
  readonly writtenPerDoc: Readonly<Record<string, string[]>>;
  /**
   * Per doc id, the ordered list of values OBSERVED committed for that
   * doc — the projection of the committed `log/<seq>` range onto that
   * doc, in seq order.
   */
  readonly observedPerDoc: Readonly<Record<string, string[]>>;
  /**
   * The set of committed `log/<seq>` slot numbers across ALL docs,
   * parsed from the ACTUAL occupied storage keys under the collection's
   * `log/` prefix (NOT synthesized from an array index). The collection's
   * linearization point is the `log/<seq>` create, so this MUST be a
   * contiguous, gap-free, duplicate-free range — and since this set comes
   * from real keys, a hypothetical gap or duplicate slot WOULD fail the
   * caller's assertion.
   */
  readonly committedSeqs: readonly number[];
}

/**
 * Drive M distinct doc ids through ONE collection's log with N writers,
 * then walk the committed log to surface (a) each doc's observed
 * committed-value sequence and (b) the collection's `log/<seq>` slot
 * set, so the caller can assert per-doc consistency and collection-level
 * total order.
 *
 * Where the single-key cascade pins `collection === docId === "k"` and
 * hammers one row, this routes a round-robin of writes across M docs
 * that all share the SAME collection log — exercising the invariant the
 * single-key cascade can't witness: independent documents serialized
 * through one log, where the log linearizes the *collection* (every
 * commit, regardless of doc, takes the next free `log/<seq>` slot) while
 * each doc's own committed history stays internally consistent.
 *
 * Each value is a canonical token `<writer>:<n>` so written-vs-observed
 * comparison is decidable by string equality. Per-doc commits are
 * serialized (one in-flight commit per doc) so a doc's enqueue order is
 * its log order; cross-doc interleaving is unconstrained, which is the
 * point — the log still totally orders them.
 *
 * @param opts.storages   N {@link Storage} handles sharing a backing
 *                        store; `N === storages.length`.
 * @param opts.pollTickMs Unused by the writer loop here but accepted for
 *                        signature parity with the other cascades and to
 *                        document the backend's commit-latency class.
 * @param opts.docIds     The distinct doc ids to route through the one
 *                        collection. Defaults to `[COLLECTION]` so a
 *                        zero-arg-doc caller degenerates to the
 *                        single-key shape.
 * @param opts.commitsPerDoc How many U-commits to attempt per doc
 *                        (default 8). Total attempted commits is
 *                        `docIds.length * commitsPerDoc`.
 */
export const runMultiDocCascade = async (opts: {
  storages: Storage[];
  pollTickMs: number;
  docIds?: readonly string[];
  commitsPerDoc?: number;
}): Promise<MultiDocCascadeResult> => {
  void opts.pollTickMs;
  const docIds = opts.docIds ?? [COLLECTION];
  const commitsPerDoc = opts.commitsPerDoc ?? 8;
  const N = opts.storages.length;
  const instances = await buildInstances(opts.storages, []);

  const writtenPerDoc: Record<string, string[]> = {};
  for (const docId of docIds) {
    writtenPerDoc[docId] = [];
  }

  // Per-doc commit serializer: keep one in-flight commit per doc so a
  // doc's enqueue order is its committed-log order. Cross-doc
  // interleaving is left unconstrained — that's the contention the log's
  // total order must absorb.
  const docQueues: Record<string, Promise<void>> = {};
  for (const docId of docIds) {
    docQueues[docId] = Promise.resolve();
  }
  // Per-doc monotonic counter so each written value is unique within a doc.
  const docCounter: Record<string, number> = {};
  for (const docId of docIds) {
    docCounter[docId] = 0;
  }

  // Round-robin: step k routes to doc `k % M` and writer `k % N`.
  const total = docIds.length * commitsPerDoc;
  for (let k = 0; k < total; k++) {
    const docId = docIds[k % docIds.length]!;
    const writerIdx = k % N;
    const n = docCounter[docId]!++;
    const token = `${writerIdx}:${n}`;
    const message: CascadeMessage = { sender: writerIdx, send_time: n };
    // Record the WRITE in this doc's enqueue order before chaining the
    // commit so `writtenPerDoc` reflects intended order even if a
    // commit later loses a CAS race and gets dropped.
    writtenPerDoc[docId]!.push(token);
    docQueues[docId] = docQueues[docId]!.then(async () => {
      try {
        await instances[writerIdx]!.writer.commit({
          op: "U",
          collection: COLLECTION,
          docId,
          body: { ...message, token },
        });
      } catch (error) {
        // Transient Conflict under contention is expected — the value is
        // simply not committed (and won't appear in `observedPerDoc`),
        // which keeps the subsequence property intact. Other errors
        // propagate.
        if (error instanceof BaerlyError && error.code === "Conflict") {
          return;
        }
        throw error;
      }
    });
  }

  await Promise.all(Object.values(docQueues));

  // Derive `committedSeqs` from the ACTUAL occupied log-slot KEYS, not
  // from an array index — otherwise the "contiguous / gap-free / no-dup"
  // assertions on it are tautological (a forward probe is dense by
  // construction, so synthesizing `start + i` can NEVER witness a gap or
  // duplicate the storage might actually hold). `collectCommittedSlots`
  // enumerates the live `log/<N>.json` slots — and rides out the
  // node-minio Toxiproxy flips this cascade also runs under — so the
  // resulting set is the real committed range the collection-total-order
  // property exists to witness.
  const inst = instances[0]!;
  const read = await readCurrentJson(inst.storage, inst.currentJsonKey);
  const start = read === null ? 0 : read.json.log_seq_start;

  const committedSeqs = [...(await collectCommittedSlots(inst))];

  // Walk the committed entries in ascending seq order for the per-doc
  // projection — `observedPerDoc[docId]` is that doc's committed-value
  // sequence. The probe returns entries in ascending slot order, so the
  // projection onto each doc preserves commit order.
  const probe = await probeTailFrom(inst.storage, inst.logPrefix, start);
  const observedPerDoc: Record<string, string[]> = {};
  for (const docId of docIds) {
    observedPerDoc[docId] = [];
  }
  for (const entry of probe.entries) {
    if (entry.op === "U" && entry.after !== undefined) {
      const after = entry.after as CascadeMessage & { token?: string };
      if (after.token !== undefined && observedPerDoc[entry.doc_id] !== undefined) {
        observedPerDoc[entry.doc_id]!.push(after.token);
      }
    }
  }

  return { docIds, writtenPerDoc, observedPerDoc, committedSeqs };
};

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
 * Seed N random docs into the collection via a single Writer
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
  const writer = new Writer({
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
 * `db.collection().where(p).all()` result (routed through the planner
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
    config: { collections: { [collection]: { indexes: [...indexes] } } },
  });
  const table = db.collection(collection) as Collection<ParityDoc>;

  // Deterministic pseudo-random for reproducibility (the shared
  // `makeLcg` seeded off a cheap hash of the tenant). Spec doesn't
  // require cryptographic randomness; we just want decent coverage of
  // bound combinations.
  let seed = 0;
  for (let i = 0; i < tenant.length; i++) {
    seed = (seed * 31 + tenant.charCodeAt(i)) | 0;
  }
  const rand = makeLcg(seed);
  const pick = <U>(arr: ReadonlyArray<U>): U => arr[Math.floor(rand() * arr.length)]!;

  for (let iter = 0; iter < iterations; iter++) {
    // Random predicate shape — mix of one-sided / two-sided range
    // and small `in`. All bounds are string-typed. We build the
    // callback-form PredicateArg so the cascade exercises the
    // normaliser → validator → planner seam end-to-end (a direct
    // wire literal would bypass the normaliser and lose coverage
    // of that boundary).
    const shape = Math.floor(rand() * 5);
    let predicate: PredicateArg<ParityDoc>;
    if (shape === 0) {
      // One-sided gte
      const v = pick(priorityAlphabet);
      predicate = (q) => q.gte("priority", v);
    } else if (shape === 1) {
      // One-sided lt
      const v = pick(priorityAlphabet);
      predicate = (q) => q.lt("priority", v);
    } else if (shape === 2) {
      // Two-sided, varying inclusivity. Pick distinct values so
      // the interval is never empty (lo < hi strictly); the wire
      // validator throws UnsatisfiablePredicate on lo == hi with
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
      predicate = (q) => {
        const withLo = loInclusive ? q.gte("priority", lo) : q.gt("priority", lo);
        return hiInclusive ? withLo.lte("priority", hi) : withLo.lt("priority", hi);
      };
    } else if (shape === 3) {
      // in with 1-3 values
      const size = 1 + Math.floor(rand() * 3);
      const values: string[] = [];
      for (let v = 0; v < size; v++) {
        values.push(pick(priorityAlphabet));
      }
      predicate = (q) => q.in("priority", values);
    } else {
      // Plain equality (still exercises the planner's routing).
      const v = pick(priorityAlphabet);
      predicate = (q) => q.eq("priority", v);
    }

    // Materialise the wire for the in-memory parity baseline; the
    // routed read consumes the same callback via `.where(...)`.
    const wire = normalizePredicateArg<ParityDoc>(predicate);
    const expected = seeded.filter((d) => matchesWire(wire, d));

    // Bounded retry on transient I/O — under Toxiproxy the network flips
    // every 100ms during the node-minio variant, and a `.all()` that lands
    // in a dead window rejects with a NetworkError. The parity assertion
    // is unaffected: it only runs after a successful read, and genuine
    // parity mismatches (a plain assertion failure) propagate immediately.
    const actual = await withNetworkRetry(() => table.where(predicate).all());
    expect(
      actual.map((r) => r._id).toSorted(),
      `range-walk parity mismatch for wire ${JSON.stringify(wire)}`,
    ).toEqual(expected.map((d) => d._id).toSorted());
  }
};
