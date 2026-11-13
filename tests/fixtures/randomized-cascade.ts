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
import { Db, probeTailFrom } from "@baerly/server";
import { Writer } from "@baerly/server/_internal/testing";
import {
  CentralisedOfflineFirstCausalSystem,
  type Grounding,
  type Knowledge,
} from "./consistency.ts";
import { logStateCurrentJson } from "./log-state.ts";
import {
  isMonotonicRead,
  isReadYourWrite,
  isTransientReadError,
  isUnacknowledgedCommitError,
  missingAckedSlots,
} from "./session-guarantees.ts";

/**
 * Causal-consistency check without `eval()`. Workerd disallows code
 * generation from strings, so the fixture's `check()` (which builds
 * a JS expression and `eval`s it) cannot run under
 * `@cloudflare/vitest-plugin`. We re-implement the check
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
  readonly tenant: string;
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
 * others see `WriteConflict` (which the protocol translates from
 * `PreconditionFailed`). The losers adopt the existing record.
 */
const ensureCurrent = (storage: Storage, key: string): Promise<void> =>
  // Idempotent: a create that landed before its `NetworkError` re-runs as
  // a `WriteConflict` and resolves by readback.
  withNetworkRetry(async () => {
    try {
      await createCurrentJson(storage, key, seedCurrent());
    } catch (error) {
      if (error instanceof BaerlyError && error.code === "WriteConflict") {
        const got = await readCurrentJson(storage, key);
        if (got !== null) {
          return;
        }
      }
      throw error;
    }
  });

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
): Promise<{ value: CascadeMessage; seq: number } | undefined> => {
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
      return { value: entry.after as CascadeMessage, seq: s };
    }
  }
  return undefined;
};

/**
 * Declared-index invariant — when the filtered index is declared, a
 * read through a `Db` that declares it returns exactly what the log
 * says is live: the doc iff its latest value satisfies the index's
 * filter. Reads take membership from the fold, and a declaration
 * changes no read.
 *
 * The cascade is single-key (`COLLECTION === docId`) so the live
 * set is at most one row.
 */
const assertFilteredIndexReadMatchesLive = async (inst: Instance): Promise<void> => {
  const latest = await readLatest(inst, COLLECTION);
  const live = latest?.value;
  const db = Db.create({
    storage: inst.storage,
    app: APP,
    tenant: inst.tenant,
    config: { collections: { [COLLECTION]: { indexes: [FILTERED_INDEX] } } },
  });
  const rows = await db.collection(COLLECTION).where({ sender: 0 }).all();
  expect(
    rows.map((r) => r["_id"]),
    "indexed read != live doc set under the index filter",
  ).toEqual(live?.sender === 0 ? [COLLECTION] : []);
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
 * of the cascade checks an indexed read against the live doc.
 */
const FILTERED_INDEX: IndexDefinition = {
  name: "cascade_filter",
  on: "send_time",
  predicate: { clauses: [{ op: "eq", field: "sender", value: 0 }] },
};

const buildInstances = async (storages: Storage[]): Promise<Instance[]> => {
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
    const writer = new Writer({ storage, currentJsonKey: sharedCurrentKey });
    return {
      db,
      writer,
      storage,
      tenant: sharedTenant,
      currentJsonKey: sharedCurrentKey,
      logPrefix: sharedLogPrefix,
    };
  });
};

/**
 * Run a storage-touching op that executes WHILE faults are injected
 * under bounded retry on transient `NetworkError`. The node-minio variant
 * flips its Toxiproxy proxy every 100 ms with probability 0.5, so a dead
 * window lasts a geometric number of ticks — often several hundred ms —
 * while the adapter's own `STORAGE_RETRY_MAX_ATTEMPTS` attempts span only
 * ~100 ms of jittered backoff. An op landing in such a window rejects with
 * a {@link BaerlyError} whose `code` is `"NetworkError"`; the retry rides
 * out the window. The linear backoff below spans ~6 s, so the op gets 16
 * tries across many independent windows. Sized from measurement: over ~2.9k
 * calls under the twiddler, about one in 30 needed a retry, the tail
 * roughly halved per extra retry, and the longest needed 9. A budget of 10
 * would leave a few-percent chance per file run of exhausting one; 15
 * makes that negligible at no cost on the common path. Only short ops (one
 * commit, one point read) belong here; post-workload verification instead
 * runs after `healNetwork`, since a long multi-request read cannot reliably
 * fit any whole-op budget under unbounded windows. Non-matching failures (and
 * genuine assertion failures) propagate immediately. The whole `op` re-runs
 * per attempt, so it must be idempotent.
 *
 * @param opts.retryOn Which errors to retry. Defaults to `NetworkError`;
 *                     a caller re-issuing an idempotent commit passes
 *                     {@link isUnacknowledgedCommitError}.
 * @param opts.sleep   Backoff sleep. Test seam; defaults to `setTimeout`.
 */
export const MAX_NETWORK_RETRIES = 15;
export const NETWORK_RETRY_BASE_MS = 50;
const isNetworkError = (error: unknown): boolean =>
  error instanceof BaerlyError && error.code === "NetworkError";
export const withNetworkRetry = async <T>(
  op: () => Promise<T>,
  opts: {
    retryOn?: (error: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> => {
  const retryOn = opts.retryOn ?? isNetworkError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (retryOn(error) && attempt < MAX_NETWORK_RETRIES) {
        await sleep(NETWORK_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
};

/**
 * Collect the set of committed `log/<seq>.json` slot numbers under a
 * collection's log prefix. Matches ONLY `<logPrefix>/log/<digits>.json`
 * slot keys — ignoring `current.json`, index subdirs, etc. Verification
 * only: callers run it after `healNetwork`.
 */
const collectCommittedSlots = async (inst: Instance): Promise<Set<number>> => {
  const slotKeyPattern = new RegExp(`^${escapeRegExp(`${inst.logPrefix}/log/`)}(\\d+)\\.json$`);
  const slots = new Set<number>();
  for await (const listed of inst.storage.list(`${inst.logPrefix}/log/`)) {
    const m = slotKeyPattern.exec(listed.key);
    if (m !== null) {
      slots.add(Number.parseInt(m[1]!, 10));
    }
  }
  return slots;
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
   * When `true`, the cascade declares a sparse filtered index over
   * the single shared doc and, after the cascade completes, asserts
   * that a read through a `Db` declaring it returns the live doc iff
   * the doc satisfies the filter. The filter matches
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
  /**
   * When `true`, additionally assert read-your-writes (SG-2) and
   * monotonic-reads (SG-3). Enable only on strongly-consistent backends
   * (memory / local-fs / miniflare-R2); leave off for node-minio, whose
   * Toxiproxy fault injection deliberately induces stale reads.
   */
  strongConsistency?: boolean;
  /**
   * Heals injected network faults (node-minio's Toxiproxy twiddler). Called
   * once the workload has drained and before final verification, so the
   * verification reads see durable storage without racing dead windows.
   * Omit for variants without fault injection.
   */
  healNetwork?: () => Promise<void>;
}): Promise<void> =>
  new Promise<void>((done, reject) => {
    void (async () => {
      try {
        const N = opts.storages.length;
        const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
        const rand = makeLcg(seed);
        // Progress trace of the causal-consistency broadcast simulation.
        // Off by default — on a green run it emits ~200 lines of pure
        // debug noise per suite. Set CASCADE_TRACE=1 to replay a failing
        // interleaving. The failure-only CAUSAL VIOLATION dump below is
        // always printed. (The seed also lands in that dump for replay.)
        const traceCascade = !!process.env["CASCADE_TRACE"];
        if (traceCascade) {
          console.log(`[cascade] seed=${seed} N=${N} pollTickMs=${opts.pollTickMs}`);
        }
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
        // Monotonic-reads (SG-3): per client, the resolved read slot never
        // goes backward on a strongly-consistent backend (the log is
        // append-only and entries are immutable, so the freshest matching
        // slot only grows).
        const lastObservedSeq: number[] = Array.from({ length: N }, () => -1);
        const instances = await buildInstances(opts.storages);
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
            if (traceCascade) {
              console.log(
                `${system.global_time}: ${label}@${
                  system.client_clocks[client_id]!
                } rcvd ${system.client_labels[val.sender]}@${val.send_time}`,
              );
            }
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
            if (traceCascade) {
              console.log(`${system.global_time}: ${label}@${send_time} broadcast`);
            }

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
                let result: Awaited<ReturnType<Writer["commit"]>>;
                try {
                  result = await instances[client_id]!.writer.commit({
                    op: "U",
                    collection: COLLECTION,
                    docId: COLLECTION,
                    body: { ...message, _id: COLLECTION },
                  });
                } catch (error) {
                  // An unacknowledged commit is a legal outcome: it is not
                  // added to `ackedSeqs`, and if it landed the poll loop
                  // observes it like any peer write.
                  if (isUnacknowledgedCommitError(error)) {
                    // A lost race means a peer's write landed, which every
                    // client observes and answers. A fault (a Toxiproxy dead
                    // window outlasting the adapter's retries) can instead
                    // swallow every client's broadcast at once, leaving no
                    // change to observe, so the client broadcasts afresh
                    // (new `send_time`; the per-client queue keeps it after
                    // this one) rather than stall the cascade.
                    if ((error as BaerlyError).code !== "WriteConflict" && !finished) {
                      handle(client_id, undefined);
                    }
                    return;
                  }
                  throw error;
                }
                ackedSeqs.add(result.entry.seq);
                // Read-your-writes (SG-2): a self-read right after a
                // successful commit must resolve a slot >= the one we won
                // (LWW: we never read state older than our own write).
                if (opts.strongConsistency === true) {
                  const own = await readLatest(instances[client_id]!, COLLECTION);
                  expect(
                    isReadYourWrite(own?.seq, result.entry.seq),
                    `read-your-writes: client ${client_id} committed log/${result.entry.seq} but a self-read resolved ${own?.seq ?? "nothing"}`,
                  ).toBe(true);
                }
              } catch (error) {
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
                // Heal before verifying: every commit has settled, and the
                // checks below read durable storage.
                await opts.healNetwork?.();
                // No-lost-writes (SG-1): every acked commit's slot is durable.
                const committed = await collectCommittedSlots(instances[0]!);
                const missing = missingAckedSlots(ackedSeqs, committed);
                expect(
                  missing,
                  `no-lost-writes: acked commits missing from the durable log-slot set ${JSON.stringify(
                    [...committed].toSorted((a, b) => a - b),
                  )}`,
                ).toEqual([]);
                if (opts.injectFilteredIndex) {
                  await assertFilteredIndexReadMatchesLive(instances[0]!);
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
                const latest = await readLatest(inst);
                if (opts.strongConsistency === true && latest !== undefined) {
                  expect(
                    isMonotonicRead(latest.seq, lastObservedSeq[client_id]!),
                    `monotonic-reads: client ${client_id} observed log/${latest.seq} after log/${lastObservedSeq[client_id]}`,
                  ).toBe(true);
                  lastObservedSeq[client_id] = latest.seq;
                }
                const val = latest?.value;
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
                // stale state. The next tick retries. Anything else (e.g.
                // a failed SG-3 monotonic-reads assertion) is fatal and
                // must surface as a rejection rather than time out — see
                // `isTransientReadError`.
                if (!isTransientReadError(error)) {
                  finished = true;
                  reject(error);
                  return;
                }
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
  /**
   * Heals injected network faults (node-minio's Toxiproxy twiddler). Called
   * once the workload has drained and before final verification, so the
   * verification reads see durable storage without racing dead windows.
   * Omit for variants without fault injection.
   */
  healNetwork?: () => Promise<void>;
}): Promise<MultiDocCascadeResult> => {
  void opts.pollTickMs;
  const docIds = opts.docIds ?? [COLLECTION];
  const commitsPerDoc = opts.commitsPerDoc ?? 8;
  const N = opts.storages.length;
  const instances = await buildInstances(opts.storages);

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
          body: { ...message, token, _id: docId },
        });
      } catch (error) {
        // An unacknowledged commit (lost race, `NetworkError`, or
        // `AmbiguousCommit` from a Toxiproxy dead window outlasting the
        // adapter's retries) is a legal outcome. The assertions never
        // assume its fate: `observedPerDoc` and `committedSeqs` come from
        // the durable log, so a write that landed anyway is counted and one
        // that didn't is absent — both keep the subsequence and
        // total-order properties checkable. Other errors propagate.
        if (isUnacknowledgedCommitError(error)) {
          return;
        }
        throw error;
      }
    });
  }

  await Promise.all(Object.values(docQueues));
  // Heal before verifying: every commit has settled, and the projection
  // below reads the durable log.
  await opts.healNetwork?.();

  // Derive `committedSeqs` from the ACTUAL occupied log-slot KEYS, not
  // from an array index — otherwise the "contiguous / gap-free / no-dup"
  // assertions on it are tautological (a forward probe is dense by
  // construction, so synthesizing `start + i` can NEVER witness a gap or
  // duplicate the storage might actually hold). `collectCommittedSlots`
  // enumerates the live `log/<N>.json` slots, so the resulting set is the
  // real committed range the collection-total-order property exists to
  // witness.
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
 * is a string-typed field intentionally: pinning priorities to short
 * string tokens keeps the cascade's surface stable and makes the
 * in-memory full-scan baseline easy to read.
 */
interface ParityDoc extends DocumentData {
  readonly _id: string;
  readonly priority: string;
}

/**
 * Seed N random docs into the collection via a single Writer.
 * Returns the seeded docs
 * so the caller can compute the expected (full-scan) result in
 * memory.
 */
const seedParityDocs = async (
  storage: Storage,
  app: string,
  tenant: string,
  collection: string,
  count: number,
  priorityAlphabet: ReadonlyArray<string>,
): Promise<ParityDoc[]> => {
  const currentJsonKey = `app/${app}/tenant/${tenant}/manifests/${collection}/current.json`;
  await ensureCurrent(storage, currentJsonKey);
  const writer = new Writer({ storage, currentJsonKey });
  const docs: ParityDoc[] = [];
  for (let i = 0; i < count; i++) {
    const priority = priorityAlphabet[i % priorityAlphabet.length]!;
    const doc: ParityDoc = { _id: `d-${i}`, priority };
    docs.push(doc);
    // The parity baseline assumes every seeded doc is durable, so an
    // unacknowledged commit (a Toxiproxy dead window outlasting the
    // adapter's retries on node-minio) is re-issued until one is acked.
    // Re-issuing is safe even when the earlier attempt landed: the body is
    // identical, so a second `I` entry folds to the same row. The parity check itself then proves all `count` docs
    // are visible.
    await withNetworkRetry(
      () => writer.commit({ op: "I", collection, docId: doc._id, body: doc }),
      { retryOn: isUnacknowledgedCommitError },
    );
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
  /**
   * Heals injected network faults (node-minio's Toxiproxy twiddler). Called
   * once the workload has drained and before final verification, so the
   * verification reads see durable storage without racing dead windows.
   * Omit for variants without fault injection.
   */
  healNetwork?: () => Promise<void>;
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
  const seeded = await seedParityDocs(opts.storage, app, tenant, collection, 72, priorityAlphabet);
  // Seeding runs under faults; the planner-vs-full-scan reads run healed.
  // Every seed was acked, and the reads below prove all of them durable.
  await opts.healNetwork?.();

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

    const actual = await table.where(predicate).all();
    expect(
      actual.map((r) => r._id).toSorted(),
      `range-walk parity mismatch for wire ${JSON.stringify(wire)}`,
    ).toEqual(expected.map((d) => d._id).toSorted());
  }
};

/**
 * Rejection codes a same-`_id` insert may surface when the backend injects
 * faults: the loser's `AlreadyExists`, a retriable failure that committed
 * nothing, or `AmbiguousCommit` (the create's fate is unknown).
 */
const FAULT_INSERT_CODES: ReadonlySet<string> = new Set([
  "AlreadyExists",
  "NetworkError",
  "WriteConflict",
  "AmbiguousCommit",
]);

/**
 * Concurrent same-`_id` inserts, oracled against the log: the first `I`
 * for an `_id` wins.
 *
 * Every round, all N `Db`s insert one `_id` at once with distinct bodies
 * (`{ round, writer }`), then the row is deleted so the next round starts
 * a new incarnation. After all rounds the doc's committed log entries are
 * read back (log objects outlive folds; nothing here retires them) and
 * checked:
 *
 * - no `I` follows a live `I` / `U` without a `D` between;
 * - per round, at most one insert fulfils, and a fulfilled insert's body is
 *   that incarnation's first `I` `after`;
 * - every rejection is `AlreadyExists`, or under `faultInjection` a
 *   retriable code or `AmbiguousCommit`; a definitively rejected body never
 *   reaches the log, and an ambiguous one is either the first `I` or absent;
 * - without `faultInjection`, exactly one insert fulfils per round, and
 *   across the run at least one loser is refused by the writer's insert
 *   guard rather than the check read, so the race really contended.
 */
export const runSameIdInsertRaceCascade = async (opts: {
  storages: Storage[];
  faultInjection: boolean;
  rounds?: number;
  /**
   * Heals injected network faults (node-minio's Toxiproxy twiddler). Called
   * after the last round and before the log is read back, so the oracle
   * reads durable storage without racing dead windows. Omit for variants
   * without fault injection.
   */
  healNetwork?: () => Promise<void>;
}): Promise<void> => {
  const rounds = opts.rounds ?? 6;
  const tenant = `insrace-${uuid().slice(0, 8)}`;
  const collection = "ins";
  const id = "contested";
  const logPrefix = `app/${APP}/tenant/${tenant}/manifests/${collection}`;
  // Contention signal. An insert GETs `current.json` once for its
  // pre-commit check read and once more only if it reaches
  // `Writer.commit()`, and the writer is the only other source of
  // `AlreadyExists`. So a loser that GOT `current.json` twice was refused
  // by the writer's insert guard, not the check read.
  const currentJsonKey = `${logPrefix}/current.json`;
  const currentJsonGets = opts.storages.map(() => 0);
  const counted = opts.storages.map((inner, writer): Storage => ({
    get: (key, getOpts) => {
      if (key === currentJsonKey) {
        currentJsonGets[writer]!++;
      }
      return inner.get(key, getOpts);
    },
    put: (key, body, putOpts) => inner.put(key, body, putOpts),
    delete: (key, deleteOpts) => inner.delete(key, deleteOpts),
    list: (prefix, listOpts) => inner.list(prefix, listOpts),
  }));
  const dbs = counted.map((storage) => Db.create({ storage, app: APP, tenant }));
  const reader = dbs[0]!.collection(collection);

  type Outcome =
    | { readonly writer: number; readonly ok: true }
    | {
        readonly writer: number;
        readonly ok: false;
        readonly code: string;
        /** The insert reached `Writer.commit()` (see `currentJsonGets`). */
        readonly reachedWriter: boolean;
      };
  const outcomes: Outcome[][] = [];

  for (let round = 0; round < rounds; round++) {
    currentJsonGets.fill(0);
    const settled = await Promise.allSettled(
      dbs.map((db, writer) => db.collection(collection).insert({ _id: id, round, writer })),
    );
    outcomes.push(
      settled.map((r, writer): Outcome => {
        if (r.status === "fulfilled") {
          return { writer, ok: true };
        }
        const reason: unknown = r.reason;
        if (!(reason instanceof BaerlyError)) {
          throw reason;
        }
        return {
          writer,
          ok: false,
          code: reason.code,
          reachedWriter: currentJsonGets[writer]! > 1,
        };
      }),
    );
    // End the incarnation. A delete may itself fail or be ambiguous under
    // faults, so re-read until the row is gone.
    for (let attempt = 0; ; attempt++) {
      const row = await withNetworkRetry(() => reader.get(id));
      if (row === undefined) {
        break;
      }
      expect(attempt, `round ${round}: could not delete the row`).toBeLessThan(20);
      await reader.delete(id).catch((error: unknown) => {
        if (!(error instanceof BaerlyError)) {
          throw error;
        }
      });
    }
  }

  // Every round has settled; read the oracle on a healed network.
  await opts.healNetwork?.();
  const found: LogEntry[] = [];
  for await (const listed of opts.storages[0]!.list(`${logPrefix}/log/`)) {
    const got = await opts.storages[0]!.get(listed.key);
    if (got === null) {
      continue;
    }
    const entry = JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
    if (entry.doc_id === id) {
      found.push(entry);
    }
  }
  const entries = found.toSorted((x, y) => x.seq - y.seq);

  let live = false;
  for (const entry of entries) {
    if (entry.op === "I") {
      expect(live, `seq ${entry.seq}: an I follows a live row with no D between`).toBe(false);
    }
    live = entry.op !== "D";
  }

  const bodyKey = (round: number, writer: number): string => `${round}/${writer}`;
  const inserted = entries
    .filter((e) => e.op === "I")
    .map((e) => bodyKey(Number(e.after?.["round"]), Number(e.after?.["writer"])));
  for (let round = 0; round < rounds; round++) {
    const results = outcomes[round]!;
    const firstI = inserted.find((k) => k.startsWith(`${round}/`));
    const winners = results.filter((o) => o.ok);
    expect(winners.length, `round ${round}: more than one insert fulfilled`).toBeLessThanOrEqual(1);
    if (!opts.faultInjection) {
      expect(winners.length, `round ${round}: no insert fulfilled`).toBe(1);
    }
    for (const w of winners) {
      expect(firstI, `round ${round}: the fulfilled insert is not the first I`).toBe(
        bodyKey(round, w.writer),
      );
    }
    for (const o of results) {
      if (o.ok) {
        continue;
      }
      const key = bodyKey(round, o.writer);
      if (opts.faultInjection) {
        expect(FAULT_INSERT_CODES.has(o.code), `round ${round}: unexpected ${o.code}`).toBe(true);
      } else {
        expect(o.code, `round ${round}: writer ${o.writer}`).toBe("AlreadyExists");
      }
      if (o.code === "AmbiguousCommit") {
        expect(
          !inserted.includes(key) || firstI === key,
          `round ${round}: an ambiguous insert landed behind the first I`,
        ).toBe(true);
      } else {
        expect(inserted, `round ${round}: a rejected insert reached the log`).not.toContain(key);
      }
    }
  }

  // Without contention the oracle is vacuous: if scheduling serialized the
  // inserts, the check read caught every loser and the writer's guard
  // never ran. Require that at least one loser was refused by the guard.
  if (!opts.faultInjection) {
    const guarded = outcomes
      .flat()
      .filter((o) => !o.ok && o.code === "AlreadyExists" && o.reachedWriter).length;
    expect(
      guarded,
      "no insert was refused by the writer's insert guard: the inserts never contended",
    ).toBeGreaterThan(0);
  }
};
