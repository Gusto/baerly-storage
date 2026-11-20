/**
 * Crash-injection fuzzer.
 *
 * Property-based fault-injection that drives `Writer`,
 * `compact()`, and `runGc()` against a `Storage` proxy that aborts the
 * K-th underlying operation. Asserts the durability contracts:
 *
 *   1. A crashed writer leaves no readable phantom row (the would-be
 *      insert is either fully landed or fully absent).
 *   2. A crashed compactor leaves no readable corrupt snapshot (the
 *      reader's row set is identical pre- and post-crash).
 *   3. A crashed GC sweep never deletes a still-referenced key (the
 *      reader's row set is identical pre- and post-crash).
 *   4. A long-running mixed loop of writes / compaction / GC with
 *      random aborts converges to a reader view matching the exact
 *      set of successfully-committed `_id`s.
 *   5. (write-tick fold) For every K, aborting the K-th op across a
 *      fold (snapshot PUT → `current.json` CAS) then running `runGc`
 *      preserves the reader view.
 *   6. (lost-fold contention) A fold whose CAS loses to a concurrent
 *      write leaves an orphan snapshot; after `runGc` drains past the
 *      grace window no orphan snapshot is left unreferenced.
 *   7. (grace bound) A GC pass whose clock crosses
 *      `GC_PASS_GRACE_FRACTION` of the default grace — at the fresh
 *      manifest read, inside a DELETE batch, or between batches — issues
 *      no further DELETE, and the unissued candidates stay pending.
 *   8. (retirement) An abort anywhere inside `retireLogRange` — at the
 *      advisory gate, at the floor CAS, or between the CAS and the
 *      DELETE loop — leaves the reader's row set unchanged. Objects
 *      leaked below an already-published floor are the documented
 *      fail-safe, never corruption.
 *
 * Each crash arm injects one of two faults at its K-th op, drawn per case:
 * an abort before the op reaches storage, or a post-apply fault (the op
 * lands, then a retryable `NetworkError` replaces its response — a lost
 * ack on a log create, a snapshot PUT, a `current.json`, `gc/pending.json`
 * or retirement-floor CAS, or a DELETE). A post-apply case must leave the
 * same reader view, and a following clean maintenance round must complete
 * and converge on it.
 *
 * Every faulted step is also judged by the physical oracle
 * (`tests/fixtures/physical-oracle.ts`): the bucket's key set and
 * per-object SHA-256 may differ from the pre-fault image only as the step's
 * rules allow, the residue is limited to orphan snapshots, log leaked below
 * `log_delete_floor` and the seeded pre-0.7 objects, and any surfaced
 * error's `code` is on the step's allow-list.
 *
 * Runs under default `FC_NUM_RUNS=100` on `pnpm test`. The cranked
 * variant `pnpm test:fuzz-maintenance` (`FC_NUM_RUNS=10000`) is the
 * intended thorough sweep; `.github/workflows/crash-fuzzer.yml` runs it in
 * CI one test per job (see docs/contributing/development.md, "Crash fuzzer
 * in CI"). Tests must stay selectable on their own with `-t`.
 *
 * Test-only. The control-flow-level kill points complement
 * `tests/integration/randomized.test.ts`'s transport-level
 * Toxiproxy-driven cascade.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fc, test as propTest } from "@fast-check/vitest";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BaerlyError,
  type Collection,
  createCurrentJson,
  type DocumentData,
  encodeJsonBytes,
  GC_GRACE_PERIOD_MILLIS,
  GC_PASS_GRACE_FRACTION,
  GC_SWEEP_DELETE_BATCH_KEYS,
  MemoryStorage,
  readCurrentJson,
  readGcPending,
  sha256Hex,
  type Storage,
  versionFromContent,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Db } from "@baerly/server";
import { compact, runGc } from "@baerly/server/_internal/maintenance";
import {
  compactInternal,
  type InternalCompactOptions,
  type InternalRunGcOptions,
  retireLogRange,
  Writer,
} from "@baerly/server/_internal/testing";
import { type AbortingStorageHandle, abortingStorage } from "../fixtures/aborting-storage.ts";
import { logStateCurrentJson } from "../fixtures/log-state.ts";
import { UntickedWriter } from "../fixtures/unticked-writer.ts";
import { type ObservedStep, observeStep, type OracleStep } from "../fixtures/physical-oracle.ts";
import { makeValidDocIdArb } from "../fixtures/scalar-doc-id-arbitraries.ts";

// Every suite in this file injects storage faults (`abortingStorage`).
// The maintenance runner's intentional operator-facing stack dump
// (`console.error(error)` in maintenance.ts) then fires once per
// injected abort — ~150 lines of *expected*-error noise on a green run.
// Suppress it file-wide: correctness here is asserted through the
// `expect(...)` invariants, never through console output, and no test
// inspects `console.error`. A genuinely unexpected error still surfaces
// as an assertion failure. Per-test spy + restore keeps other suites
// (and a failing run's real diagnostics) untouched.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/**
 * Per-property timeout, in ms. At `FC_NUM_RUNS=100` (default
 * `pnpm test`) each property finishes in <1s; at `FC_NUM_RUNS=10000`
 * (`pnpm test:fuzz-maintenance`) each property runs multiple minutes.
 * Pick a value that comfortably accommodates 10k iterations on a
 * modern laptop.
 */
const PROP_TIMEOUT_MS = 600_000;

/**
 * fast-check's own deadline for a whole property, set inside
 * {@link PROP_TIMEOUT_MS} so fast-check stops first and reports the seed. A
 * vitest timeout reports no seed, and the abandoned iterations keep running.
 */
const PROP_INTERRUPT_MS = PROP_TIMEOUT_MS - 30_000;

/**
 * Per-case deadline. A case takes milliseconds; one still pending after
 * this is a hang, reported as a failing case with its seed and path.
 */
const CASE_TIMEOUT_MS = 60_000;

/**
 * `FC_SEED` (and optionally `FC_PATH`, copied from a failure report) replay
 * a failing run: `FC_SEED=<seed> FC_PATH=<path> pnpm test:agent
 * tests/integration/maintenance-crash-fuzz.test.ts -t '<pattern>'`, where
 * `<pattern>` is a regex selecting one test. Both unset keeps fast-check's
 * per-run random seed.
 */
const replayParams = (): { seed?: number; path?: string } => {
  const seed = process.env["FC_SEED"];
  const path = process.env["FC_PATH"];
  if (seed === undefined || seed === "") {
    if (path !== undefined && path !== "") {
      throw new Error("FC_PATH needs the FC_SEED it was reported with");
    }
    return {};
  }
  const parsed = Number(seed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`FC_SEED must be an integer, got ${JSON.stringify(seed)}`);
  }
  return path === undefined || path === "" ? { seed: parsed } : { seed: parsed, path };
};

/**
 * Run parameters shared by every property in this file. A deadline hit is
 * a failure (`markInterruptAsFailure`), never a quiet partial pass.
 */
const FC_PARAMS: Pick<
  fc.Parameters,
  "interruptAfterTimeLimit" | "markInterruptAsFailure" | "timeout" | "seed" | "path"
> = {
  interruptAfterTimeLimit: PROP_INTERRUPT_MS,
  markInterruptAsFailure: true,
  timeout: CASE_TIMEOUT_MS,
  ...replayParams(),
};

const TABLE_PREFIX = "app/a/tenant/t/manifests/c";
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;
const COLLECTION = "c";

/**
 * Inert pre-0.7 objects seeded into every bucket: a declared-index marker
 * and a legacy `content/` side object. Nothing in 0.7 may read, rewrite or
 * delete them, which the physical oracle checks on every step.
 */
const LEGACY_KEYS = [
  `${TABLE_PREFIX}/content/0123456789abcdef0123456789abcdef.json`,
  `${TABLE_PREFIX}/index/by_n/00000000/legacy-doc.json`,
] as const;

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(
    storage,
    CURRENT_JSON_KEY,
    logStateCurrentJson({ writer_fence: { epoch: 0, owner: "maintenance-fuzz", claimed_at: "" } }),
  );
  await storage.put(LEGACY_KEYS[0], encodeJsonBytes({ _id: "legacy-doc" }));
  await storage.put(LEGACY_KEYS[1], new Uint8Array(0));
};

/**
 * Short `_id`s the write path admits. A refused id never reaches storage,
 * so generating one would make a crash case vacuous (and the oracle
 * rejects its `InvalidConfig` as outside the write allow-list).
 */
const shortWritableDocIdArb = (maxCodePoints: number): fc.Arbitrary<string> =>
  makeValidDocIdArb({ maxCodePoints, longBand: false }).map((id) => id.normalize("NFC"));

/**
 * The fault a crash arm injects at its K-th op: `abort` throws before the
 * op reaches storage; `post-apply` applies it, then throws a retryable
 * `NetworkError` in place of the response.
 */
type FaultKind = "abort" | "post-apply";

const faultKindArb: fc.Arbitrary<FaultKind> = fc.constantFrom("abort", "post-apply");

const postApplyHandles = new WeakSet<AbortingStorageHandle>();

/** Arm `handle` with `fault` at the `nth` op from now. */
const armFault = (handle: AbortingStorageHandle, fault: FaultKind, nth: number): void => {
  if (fault === "abort") {
    handle.armAt(nth);
  } else {
    postApplyHandles.add(handle);
    handle.armPostApplyAt(nth);
  }
};

/**
 * Each arm that selected a post-apply case must actually fire one. An
 * excluded arm or an all-abort replay has no post-apply coverage to judge.
 */
const postApplyAttempted = new Set<string>();
const postApplyFired = new Map<string, number>();

const notePostApply = (arm: string, handle: AbortingStorageHandle): void => {
  if (postApplyHandles.has(handle)) {
    postApplyAttempted.add(arm);
  }
  if (handle.postApplied().length > 0) {
    postApplyFired.set(arm, (postApplyFired.get(arm) ?? 0) + 1);
  }
};

const expectPostApplyFired = (arm: string): void => {
  afterAll(() => {
    if (postApplyAttempted.has(arm)) {
      expect(postApplyFired.get(arm) ?? 0, `${arm}: no post-apply fault fired`).toBeGreaterThan(0);
    }
  });
};

/**
 * Run one step on `inner` (through any armed proxy) and judge it
 * physically. Under a post-apply fault the step may also surface the
 * injected lost response, `NetworkError`.
 */
const observe = (
  inner: Storage,
  step: OracleStep,
  run: () => Promise<unknown>,
  fault: FaultKind = "abort",
): Promise<ObservedStep> =>
  observeStep({
    storage: inner,
    collectionPrefix: TABLE_PREFIX,
    step,
    run,
    alsoAllow: fault === "post-apply" ? ["NetworkError"] : [],
  });

/**
 * The physical half of every crash contract: no rule violation, no torn
 * snapshot (these arms abort, they never tear), and the legacy objects
 * still present byte for byte.
 */
const expectPhysicallyClean = (observed: ObservedStep): void => {
  expect(observed.violations).toEqual([]);
  expect(observed.residue.tornSnapshots).toEqual([]);
  expect(observed.residue.legacy).toEqual([...LEGACY_KEYS]);
};

interface Row extends DocumentData {
  _id: string;
}

/**
 * Read every row in the collection through the locked collection API,
 * sorted by `_id` for stable equality. The reader walks
 * `(snapshot, log_tail)` exactly the same way production does, so the
 * post-crash invariants are checked against the customer-visible
 * surface.
 */
const readAllRowIds = async (storage: Storage): Promise<string[]> => {
  const db = Db.create({ storage, app: "a", tenant: "t" });
  const rows = await (db.collection(COLLECTION) as Collection<Row>).where({}).all();
  return [...rows]
    .map((r) => r._id)
    .toSorted((a, b) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    });
};

/**
 * A clean maintenance round after a faulted step: a fold, GC passes and a
 * retirement pass each complete and pass the physical oracle, and the
 * reader still sees `expected`.
 */
const expectMaintenanceConverges = async (inner: Storage, expected: string[]): Promise<void> => {
  const steps: [OracleStep, () => Promise<unknown>][] = [
    [
      "compact",
      () =>
        compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
          minEntriesToCompact: 1,
          maxEntriesPerRun: 1000,
        } as InternalCompactOptions),
    ],
    ...Array.from({ length: 3 }, (): [OracleStep, () => Promise<unknown>] => [
      "gc",
      () =>
        runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
          graceMillis: 0,
          maxSweepsPerRun: 1000,
        } as InternalRunGcOptions),
    ]),
    ["retire", () => retireLogRange(inner, CURRENT_JSON_KEY, { window: 0, maxDeletes: 1000 })],
  ];
  for (const [step, run] of steps) {
    const observed = await observe(inner, step, run);
    expect(observed.error).toBeUndefined();
    expectPhysicallyClean(observed);
  }
  await expect(readAllRowIds(inner)).resolves.toEqual(expected);
};

/** Collect every key under `prefix` into a sorted array. */
const listKeys = async (storage: Storage, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  for await (const entry of storage.list(prefix)) {
    keys.push(entry.key);
  }
  return keys.toSorted();
};

/**
 * The 1-based op a crash arm faults: `pick` reduced modulo the number of
 * ops `step` issues on a fault-free copy of `inner`, so the sweep reaches
 * every op of the step (the commit's log create, the fold's snapshot PUT
 * and `current.json` CAS, GC's `gc/pending.json` CAS and DELETEs, the
 * retirement floor CAS) whatever the seeded log length.
 */
const pickOp = async (
  inner: Storage,
  step: (storage: Storage) => Promise<unknown>,
  pick: number,
): Promise<number> => {
  const copy = new MemoryStorage();
  for (const key of await listKeys(inner, `${TABLE_PREFIX}/`)) {
    await copy.put(key, (await inner.get(key))!.body);
  }
  const counter = abortingStorage(copy);
  await step(counter.storage);
  return 1 + (pick % counter.opCount());
};

/** Arbitrary for {@link pickOp}'s `pick`; shrinks toward the first op. */
const opPickArb = fc.nat({ max: 1_000_000 });

describe("prefix-targeted and torn-object faults", () => {
  test("a log-create abort fails the commit while current.json traffic stays healthy", async () => {
    const inner = new MemoryStorage();
    await provision(inner);
    const handle = abortingStorage(inner);
    const writer = new Writer({ storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY });
    handle.armAt(1, { prefix: `${TABLE_PREFIX}/log/`, ops: ["put"] });
    await expect(
      writer.commit({ op: "I", collection: COLLECTION, docId: "x", body: { _id: "x" } }),
    ).rejects.toMatchObject({ code: "AmbiguousCommit" });
    expect(handle.faultsFired()).toBe(1);
    await expect(listKeys(inner, `${TABLE_PREFIX}/log/`)).resolves.toEqual([]);
    await expect(readAllRowIds(inner)).resolves.toEqual([]);
  });

  test("a torn snapshot PUT is never published, and the retried fold replaces it", async () => {
    const inner = new MemoryStorage();
    await provision(inner);
    const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
    for (let i = 0; i < 12; i++) {
      await writer.commit({
        op: "I",
        collection: COLLECTION,
        docId: `d-${i}`,
        body: { _id: `d-${i}` },
      });
    }
    const before = await readAllRowIds(inner);

    const handle = abortingStorage(inner);
    handle.tearAt(1, { prefix: `${TABLE_PREFIX}/snapshot/` });
    await expect(
      compact({ storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 5,
        maxEntriesPerRun: 50,
      } as InternalCompactOptions),
    ).rejects.toMatchObject({ name: "AbortError" });
    const [tornKey] = handle.tornKeys();
    expect(tornKey).toBeDefined();
    await expect(listKeys(inner, `${TABLE_PREFIX}/snapshot/`)).resolves.toEqual([tornKey]);
    expect((await readCurrentJson(inner, CURRENT_JSON_KEY))!.json.snapshot).toBeNull();
    await expect(readAllRowIds(inner)).resolves.toEqual(before);

    // A retried fold over the same tail targets the same content-addressed
    // key, so it must replace the torn bytes rather than adopt them.
    const retry = await compactInternal({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
      minEntriesToCompact: 5,
      maxEntriesPerRun: 50,
    } as InternalCompactOptions);
    expect(retry.written).toBe(true);
    expect(retry.newSnapshotKey).toBe(tornKey);
    const healed = await inner.get(tornKey!);
    expect(tornKey!.endsWith(`-${await sha256Hex(healed!.body)}.json`)).toBe(true);
    await expect(readAllRowIds(inner)).resolves.toEqual(before);
  });
});

describe("Writer empty-tail abort at the committing log PUT", () => {
  test("op 3 abort reports ambiguous commit fate and leaves no readable row", async () => {
    const inner = new MemoryStorage();
    await provision(inner);
    const handle = abortingStorage(inner);
    const writer = new Writer({ storage: handle.storage, currentJsonKey: CURRENT_JSON_KEY });

    // Op 1 is the provisioned current.json GET; op 2 is the empty
    // log/0.json tail probe; op 3 is the committing log PUT.
    handle.armAt(3);
    const observed = await observe(inner, "write", () =>
      writer.commit({
        op: "I",
        collection: COLLECTION,
        docId: "empty-tail",
        body: { _id: "empty-tail" },
      }),
    );
    expectPhysicallyClean(observed);
    const caught = observed.error;

    // The harness traps before dispatch, but Writer cannot distinguish
    // that from an adapter aborting after an earlier durable send.
    expect(caught).toMatchObject({ code: "AmbiguousCommit", retriable: false });
    expect((caught as BaerlyError).cause).toBeInstanceOf(AggregateError);
    expect(((caught as BaerlyError).cause as AggregateError).errors[0]).toMatchObject({
      name: "AbortError",
    });
    await expect(readAllRowIds(inner)).resolves.toEqual([]);
  });
});

describe("Writer crash never leaves readable phantom row", () => {
  expectPostApplyFired("writer");
  propTest.prop(
    {
      opPick: opPickArb,
      fault: faultKindArb,
      numInsertsBefore: fc.integer({ min: 0, max: 30 }),
      docId: shortWritableDocIdArb(8),
    },
    FC_PARAMS,
  )(
    "Db.commit() with a mid-op fault: insert is fully absent OR fully landed",
    async ({ opPick, fault, numInsertsBefore, docId }) => {
      const inner = new MemoryStorage();
      await provision(inner);

      // Seed with `numInsertsBefore` good writes so the log isn't
      // empty when the crash fires.
      const goodWriter = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      const seededIds = new Set<string>();
      for (let i = 0; i < numInsertsBefore; i++) {
        const id = `seed-${i}`;
        await goodWriter.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, kind: "seed" },
        });
        seededIds.add(id);
      }
      // The probe `_id` must not collide with a seed — drop it if it does.
      const probeIsSeed = seededIds.has(docId);

      // Wrap + arm. The trap fires at the K-th underlying I/O on
      // `inner`. Counter starts at 0; the very next op is op 1.
      const step = (storage: Storage): Promise<unknown> =>
        new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY }).commit({
          op: "I",
          collection: COLLECTION,
          docId,
          body: { _id: docId, kind: "post-crash" },
        });
      const handle = abortingStorage(inner);
      armFault(handle, fault, await pickOp(inner, step, opPick));

      // An injected fault or a CAS `WriteConflict` is expected; the
      // post-state invariants and the physical oracle are the gate.
      const observed = await observe(inner, "write", () => step(handle.storage), fault);
      notePostApply("writer", handle);
      expectPhysicallyClean(observed);
      const postCrashCommitted = observed.completed;

      // INVARIANT: a fresh reader sees a consistent view.
      const ids = await readAllRowIds(inner);
      // Every seed must still be reachable.
      for (const seed of seededIds) {
        expect(ids).toContain(seed);
      }
      // The post-crash probe is EITHER absent (most cases — the abort
      // fired before the CAS-advance) OR present (rare: the API
      // surfaced an abort *after* the CAS-advance landed, which is
      // fine — that's "the commit landed even though the API threw").
      const probePresent = ids.includes(docId);
      if (postCrashCommitted) {
        // If the writer didn't throw, the row MUST be reachable.
        expect(probePresent).toBe(true);
      } else if (probeIsSeed) {
        // It was already a seed — must be present regardless.
        expect(probePresent).toBe(true);
      }
      // UNCONDITIONAL phantom-row guard. The branches above can both be
      // skipped (the common case: a clean abort that didn't commit, with
      // a non-seed probe — and `numInsertsBefore` can be 0, so the seed
      // loop runs zero times). These assertions run on EVERY generated
      // case so no shrink passes vacuously: every readable id is one we
      // actually wrote (a seed or the probe), and no id appears twice.
      // The only forbidden state is a partial / corrupt / foreign row,
      // which the reader contract makes unrepresentable: rows come from
      // `LogEntry.after` whole, never split.
      for (const id of ids) {
        expect(seededIds.has(id) || id === docId).toBe(true);
      }
      expect(new Set(ids).size).toBe(ids.length);
      // A retriable error claims the write did not land: a caller that
      // retries it on that word must not double-commit.
      if ((observed.error as BaerlyError | undefined)?.retriable === true && !probeIsSeed) {
        expect(probePresent).toBe(false);
      }
      await expectMaintenanceConverges(inner, ids);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Compactor crash never leaves readable corrupt snapshot", () => {
  expectPostApplyFired("compact");
  propTest.prop(
    {
      opPick: opPickArb,
      fault: faultKindArb,
      numInserts: fc.integer({ min: 20, max: 60 }),
    },
    FC_PARAMS,
  )(
    "compact() with a mid-op fault: reader returns the same set pre- and post-crash",
    async ({ opPick, fault, numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }

      const before = await readAllRowIds(inner);

      // Run a compaction with a fault armed at op K.
      const step = (storage: Storage): Promise<unknown> =>
        compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
          minEntriesToCompact: 10,
          maxEntriesPerRun: numInserts,
        } as InternalCompactOptions);
      const handle = abortingStorage(inner);
      armFault(handle, fault, await pickOp(inner, step, opPick));
      // A fault or `WriteConflict` expected. Either way the bucket must still
      // surface the original row set and pass the physical oracle.
      const observed = await observe(inner, "compact", () => step(handle.storage), fault);
      notePostApply("compact", handle);
      expectPhysicallyClean(observed);

      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);
      await expectMaintenanceConverges(inner, before);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("GC crash never deletes a still-referenced key", () => {
  expectPostApplyFired("gc");
  propTest.prop(
    {
      opPick: opPickArb,
      fault: faultKindArb,
      numInserts: fc.integer({ min: 20, max: 60 }),
    },
    FC_PARAMS,
  )(
    "runGc() with a mid-op fault: reader still returns all live rows",
    async ({ opPick, fault, numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }
      // Fold the log so there's a snapshot + stale-log surface for GC
      // to mark as candidates.
      await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 10,
        maxEntriesPerRun: numInserts,
      } as InternalCompactOptions);
      const before = await readAllRowIds(inner);

      const step = (storage: Storage): Promise<unknown> =>
        runGc({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
          graceMillis: 0,
          maxSweepsPerRun: 200,
        } as InternalRunGcOptions);
      const handle = abortingStorage(inner);
      armFault(handle, fault, await pickOp(inner, step, opPick));
      // A fault or `WriteConflict` expected; the reader contract and the
      // physical oracle are the gate.
      const observed = await observe(inner, "gc", () => step(handle.storage), fault);
      notePostApply("gc", handle);
      expectPhysicallyClean(observed);

      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);
      await expectMaintenanceConverges(inner, before);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("GC pass bounded by its grace", () => {
  const B = GC_SWEEP_DELETE_BATCH_KEYS;
  propTest.prop(
    {
      numOrphans: fc.integer({ min: 1, max: 2 * B + 20 }),
      // 0 = when the fresh `current.json` read resolves; k = when the k-th
      // DELETE resolves. Multiples of B land exactly between batches.
      crossAt: fc.oneof(fc.integer({ min: 0, max: 2 * B + 20 }), fc.constantFrom(B, 2 * B)),
    },
    FC_PARAMS,
  )(
    "no DELETE is issued once the pass outlives GC_PASS_GRACE_FRACTION of the grace",
    async ({ numOrphans, crossAt: rawCrossAt }) => {
      const crossAt = Math.min(rawCrossAt, numOrphans);
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < 5; i++) {
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: `d-${i}`,
          body: { _id: `d-${i}` },
        });
      }
      await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 1,
      } as InternalCompactOptions);
      // Sealed orphan snapshots wholly below the floor (5): every one is
      // sweepable once due, so only the bound can hold one back.
      const orphans: string[] = [];
      for (let i = 0; i < numOrphans; i++) {
        const bytes = encodeJsonBytes({ orphan: i });
        const key = `${TABLE_PREFIX}/snapshot/L9/000000000000-000000000001-${await sha256Hex(bytes)}.json`;
        await inner.put(key, bytes);
        orphans.push(key);
      }
      const committed = (await readCurrentJson(inner, CURRENT_JSON_KEY))!.json.snapshot;
      const before = await readAllRowIds(inner);

      let wall = Date.parse("2026-01-01T00:00:00.000Z");
      const gcOpts = { now: () => new Date(wall) } as InternalRunGcOptions;
      await runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, gcOpts); // marks only
      wall += GC_GRACE_PERIOD_MILLIS + 1;
      const crossTo = wall + GC_GRACE_PERIOD_MILLIS * GC_PASS_GRACE_FRACTION + 1;

      let crossed = false;
      let manifestGets = 0;
      const issued: string[] = [];
      let issuedAfterCross = 0;
      const probed: Storage = {
        async get(k, o) {
          const got = await inner.get(k, o);
          if (k === CURRENT_JSON_KEY && ++manifestGets === 2 && crossAt === 0) {
            crossed = true;
            wall = crossTo;
          }
          return got;
        },
        put: (k, b, o) => inner.put(k, b, o),
        list: (p, o) => inner.list(p, o),
        async delete(k, o) {
          issuedAfterCross += crossed ? 1 : 0;
          issued.push(k);
          const n = issued.length;
          await inner.delete(k, o);
          if (n === crossAt) {
            crossed = true;
            wall = crossTo;
          }
        },
      };
      const observed = await observe(inner, "gc", () =>
        runGc({ storage: probed, currentJsonKey: CURRENT_JSON_KEY }, gcOpts),
      );
      expectPhysicallyClean(observed);
      await expect(readAllRowIds(inner)).resolves.toEqual(before);

      // The bound: nothing after the crossing, the crossing batch whole.
      expect(issuedAfterCross).toBe(0);
      expect(issued.length).toBe(Math.min(numOrphans, Math.ceil(crossAt / B) * B));
      const abandoned = orphans.filter((k) => !issued.includes(k)).toSorted();
      const pending = await readGcPending(inner, `${TABLE_PREFIX}/gc/pending.json`);
      expect(pending!.json.candidates.map((c) => c.key).toSorted()).toEqual(abandoned);

      // A later pass re-reads the manifest and reclaims the abandoned work.
      await runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, gcOpts);
      await expect(listKeys(inner, `${TABLE_PREFIX}/snapshot/`)).resolves.toEqual([committed]);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Retirement crash never deletes a live log", () => {
  expectPostApplyFired("retire");
  propTest.prop(
    {
      opPick: opPickArb,
      fault: faultKindArb,
      numInserts: fc.integer({ min: 20, max: 60 }),
    },
    FC_PARAMS,
  )(
    "retireLogRange() with a mid-op fault: reader still returns all live rows",
    async ({ opPick, fault, numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }
      // Fold the whole tail so `log_seq_start = numInserts` and the
      // entire `log/[0, numInserts)` prefix is retirable. `window: 0`
      // erases the default safety margin so the pass has real work to
      // do at this scale; `maxDeletes` covers the whole prefix so the
      // armed abort can land anywhere from the advisory gate through
      // the last DELETE.
      await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 10,
        maxEntriesPerRun: numInserts,
      } as InternalCompactOptions);
      const before = await readAllRowIds(inner);

      const step = (storage: Storage): Promise<unknown> =>
        retireLogRange(storage, CURRENT_JSON_KEY, { window: 0, maxDeletes: numInserts });
      const handle = abortingStorage(inner);
      armFault(handle, fault, await pickOp(inner, step, opPick));
      // The injected fault (or the CAS `WriteConflict` it can surface as)
      // is expected; the reader contract and the physical oracle are the
      // gate. A log entry left below the published floor is residue.
      const observed = await observe(inner, "retire", () => step(handle.storage), fault);
      notePostApply("retire", handle);
      expectPhysicallyClean(observed);

      // INVARIANT: the reader view is unchanged. Every slot retirement
      // may delete sits below `log_seq_start` — already folded into the
      // snapshot — so no abort point can cost a live row. A slot leaked
      // below an already-published floor (abort between the floor CAS
      // and the DELETE loop) is the documented fail-safe direction,
      // pinned by the crash-leak unit test in `log-retention.test.ts`;
      // this arm is its randomized generalization.
      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);
      await expectMaintenanceConverges(inner, before);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Write-tick fold crash preserves the reader view after GC", () => {
  expectPostApplyFired("fold-then-gc");
  propTest.prop(
    {
      opPick: opPickArb,
      fault: faultKindArb,
      numInserts: fc.integer({ min: 20, max: 60 }),
    },
    FC_PARAMS,
  )(
    "fault the K-th op across the fold, then runGc: live rows survive",
    async ({ opPick, fault, numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const writer = new Writer({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }
      const before = await readAllRowIds(inner);

      // Run a fold (snapshot PUT → current.json CAS) with an abort
      // armed at the K-th underlying op. The fold may land fully,
      // abort mid-snapshot-PUT, or abort before the CAS — every
      // outcome is acceptable input to the GC step below.
      const fold = (storage: Storage): Promise<unknown> =>
        compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
          minEntriesToCompact: 10,
          maxEntriesPerRun: numInserts,
        } as InternalCompactOptions);
      const foldHandle = abortingStorage(inner);
      armFault(foldHandle, fault, await pickOp(inner, fold, opPick));
      // Injected fault or CAS WriteConflict expected; the post-state is the
      // gate.
      expectPhysicallyClean(await observe(inner, "compact", () => fold(foldHandle.storage), fault));
      notePostApply("fold-then-gc", foldHandle);

      // Drain GC with the grace bypassed so any due candidate is swept
      // in-pass. Several passes under a tight per-pass mark cap;
      // under-marking is conservative-safe: it can never wrongly sweep a
      // live object, so the invariant below still holds regardless of how far
      // the log cursor advances.
      for (let pass = 0; pass < 5; pass++) {
        const observed = await observe(inner, "gc", () =>
          runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
            graceMillis: 0,
            maxMarksPerRun: 8,
            maxSweepsPerRun: 200,
          } as InternalRunGcOptions),
        );
        expect(observed.completed).toBe(true);
        expectPhysicallyClean(observed);
      }

      // The reader view is unchanged — no live row lost.
      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Lost-fold orphan snapshot reclaimed under contention", () => {
  propTest.prop(
    {
      numInserts: fc.integer({ min: 20, max: 50 }),
    },
    FC_PARAMS,
  )(
    "a fold that loses its CAS to a concurrent write leaves an orphan snapshot that runGc reclaims past grace",
    async ({ numInserts }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      // Unticked, so the folds below are the only ones.
      const writer = new UntickedWriter({ storage: inner, currentJsonKey: CURRENT_JSON_KEY });
      for (let i = 0; i < numInserts; i++) {
        const id = `d-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }
      // First clean fold so there's a committed snapshot to protect and
      // a prior pointer for the lost fold to be measured against.
      await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
        minEntriesToCompact: 5,
        maxEntriesPerRun: numInserts,
      } as InternalCompactOptions);
      // More writes so the next fold has a non-empty tail to fold.
      for (let i = 0; i < numInserts; i++) {
        const id = `e-${i}`;
        await writer.commit({
          op: "I",
          collection: COLLECTION,
          docId: id,
          body: { _id: id, n: i },
        });
      }

      // Force a fold CAS-loss: run a fold over a Storage whose `put` to
      // current.json is intercepted so that a concurrent CAS-advance
      // lands FIRST — invalidating the fold's captured ETag. The fold
      // then PUTs its snapshot (orphan) and loses the CAS-advance.
      //
      // Under single-write commit the writer no longer touches
      // current.json, so the racing CAS-advance is now a CONCURRENT FOLD
      // (the compactor is the sole current.json CAS-writer besides
      // bootstrap). The racing fold runs over the plain `inner` storage
      // (not `racingStorage`) so it doesn't re-enter the interceptor.
      let interleaved = false;
      const racingStorage: Storage = {
        get: (k, o) => inner.get(k, o),
        delete: (k, o) => inner.delete(k, o),
        list: (p, o) => inner.list(p, o),
        async put(k, b, o) {
          // The fold's CAS-advance is a guarded PUT to current.json
          // (`ifMatch` set). Just before it lands, slip a concurrent fold
          // in so the captured ETag is now stale.
          if (k === CURRENT_JSON_KEY && o?.ifMatch !== undefined && !interleaved) {
            interleaved = true;
            await compact({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
              minEntriesToCompact: 5,
              maxEntriesPerRun: numInserts,
            } as InternalCompactOptions);
          }
          return inner.put(k, b, o);
        },
      };
      const lostFold = await compactInternal(
        { storage: racingStorage, currentJsonKey: CURRENT_JSON_KEY },
        {
          minEntriesToCompact: 5,
          maxEntriesPerRun: numInserts,
        } as InternalCompactOptions,
      );
      // The fold must have lost the CAS and written an orphan snapshot.
      expect(lostFold.written).toBe(false);
      expect(lostFold.skippedReason).toBe("cas-lost");
      expect(lostFold.newSnapshotKey).toBeDefined();

      // Two distinct snapshot files exist now: the committed one and
      // the orphan the lost fold left behind.
      const snapshotsBefore = await listKeys(inner, `${TABLE_PREFIX}/snapshot/`);
      expect(snapshotsBefore.length).toBeGreaterThanOrEqual(2);

      const before = await readAllRowIds(inner);
      const committedSnapshotKey = (await readCurrentJson(inner, CURRENT_JSON_KEY))!.json.snapshot;

      // Drain GC PAST the grace window (now advanced well beyond every
      // candidate's due_at). Several passes to clear marks then sweeps.
      const future = (): Date => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      for (let pass = 0; pass < 6; pass++) {
        await runGc({ storage: inner, currentJsonKey: CURRENT_JSON_KEY }, {
          graceMillis: 0,
          now: future,
          maxMarksPerRun: 200,
          maxSweepsPerRun: 200,
        } as InternalRunGcOptions);
      }

      // INVARIANT A: reader view unchanged (the racer write also lands,
      // so recompute the expectation from `before`).
      const after = await readAllRowIds(inner);
      expect(after).toEqual(before);

      // INVARIANT B: no orphan snapshot left — the ONLY snapshot key
      // remaining is the committed one.
      const snapshotsAfter = await listKeys(inner, `${TABLE_PREFIX}/snapshot/`);
      expect(snapshotsAfter).toEqual([committedSnapshotKey]);
    },
    PROP_TIMEOUT_MS,
  );
});

describe("Long-running fuzzer (many tick + crash cycles)", () => {
  test(
    "converges to a consistent reader view after up to 200 ops with random faults",
    { timeout: PROP_TIMEOUT_MS },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              fc.record({
                kind: fc.constant("write" as const),
                id: shortWritableDocIdArb(6),
              }),
              fc.record({
                kind: fc.constant("compact" as const),
                abortAfter: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
                fault: faultKindArb,
              }),
              fc.record({
                kind: fc.constant("gc" as const),
                abortAfter: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
                fault: faultKindArb,
              }),
              fc.record({
                kind: fc.constant("retire" as const),
                abortAfter: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
                fault: faultKindArb,
              }),
            ),
            { minLength: 50, maxLength: 200 },
          ),
          async (ops) => {
            const inner = new MemoryStorage();
            await provision(inner);
            const writer = new Writer({
              storage: inner,
              currentJsonKey: CURRENT_JSON_KEY,
            });
            const expectedIds = new Set<string>();
            // Run `op` through a fresh fault proxy when it is armed.
            const via = (abortAfter: number | undefined, fault: FaultKind): Storage => {
              if (abortAfter === undefined) {
                return inner;
              }
              const handle = abortingStorage(inner);
              armFault(handle, fault, abortAfter);
              return handle.storage;
            };
            for (const op of ops) {
              if (op.kind === "write") {
                // Writes are never faulted here (a raw `Writer` insert of a
                // repeated id commits again), so every write completes.
                const observed = await observe(inner, "write", () =>
                  writer.commit({
                    op: "I",
                    collection: COLLECTION,
                    docId: op.id,
                    body: { _id: op.id, kind: "live" },
                  }),
                );
                expectPhysicallyClean(observed);
                expect(observed.completed).toBe(true);
                expectedIds.add(op.id);
                continue;
              }
              const storage = via(op.abortAfter, op.fault);
              const run = (): Promise<unknown> => {
                switch (op.kind) {
                  case "compact": {
                    return compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
                      minEntriesToCompact: 5,
                      maxEntriesPerRun: 200,
                    } as InternalCompactOptions);
                  }
                  case "gc": {
                    return runGc({ storage, currentJsonKey: CURRENT_JSON_KEY }, {
                      graceMillis: 0,
                      maxSweepsPerRun: 200,
                    } as InternalRunGcOptions);
                  }
                  case "retire": {
                    // Same seams as the dedicated retirement arm above:
                    // `window: 0` so the pass has real sub-floor work at
                    // this scale.
                    return retireLogRange(storage, CURRENT_JSON_KEY, {
                      window: 0,
                      maxDeletes: 20,
                    });
                  }
                }
              };
              // Faults and `WriteConflict`s are expected; each step must pass
              // the physical oracle, and the reader view is checked at the end.
              expectPhysicallyClean(await observe(inner, op.kind, run, op.fault));
            }
            // Post-loop INVARIANT: every successful write is
            // reachable; no phantom rows.
            const ids = new Set(await readAllRowIds(inner));
            expect(ids).toEqual(expectedIds);
            await expectMaintenanceConverges(inner, [...ids].toSorted());
          },
        ),
        { ...FC_PARAMS, numRuns: 200 },
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Bug reproductions (characterization tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Two storage variants for the characterization tests:
 * `memory` (zero infra) and `local-fs` (real I/O over a temp dir).
 * Mirrors the variant table in `maintenance-e2e.test.ts`; the
 * Minio / Cloudflare variants are intentionally excluded so these
 * stay in the default zero-infra `pnpm test` glob.
 */
interface BugVariant {
  readonly label: "memory" | "local-fs";
  readonly build: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

const BUG_VARIANTS: readonly BugVariant[] = [
  {
    label: "memory",
    build: async () => ({ storage: new MemoryStorage() }),
  },
  {
    label: "local-fs",
    build: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-characterization-"));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {
            // A stale tmp dir under a crashed worker shouldn't fail the
            // suite; the OS reaps `/tmp` eventually.
          });
        },
      };
    },
  },
];

/** Collect every log-entry seq durably present under `<prefix>/log/`. */
const durableLogSeqs = async (storage: Storage, tablePrefix: string): Promise<number[]> => {
  const seqs: number[] = [];
  for await (const entry of storage.list(`${tablePrefix}/log/`)) {
    const match = /\/log\/(\d+)\.json$/.exec(entry.key);
    if (match !== null) {
      seqs.push(Number(match[1]));
    }
  }
  return seqs.toSorted((a, b) => a - b);
};

describe("single-write commit — win-or-lose-cleanly", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      await c();
    }
  });

  for (const variant of BUG_VARIANTS) {
    expectPostApplyFired(`density-${variant.label}`);
  }

  for (const variant of BUG_VARIANTS) {
    /**
     * ── Arm 1: the orphan-at-tail is now a COMMITTED write. ─────────
     *
     * Under single-write commit, the numbered `log/<seq>` create IS the
     * commit. A writer that crashed right after its `log/<seq>` PUT
     * landed a DURABLE, committed entry — no `current.json` CAS follows
     * it. The next writer reads the same (stale) `tail_hint`, forward-
     * probes, finds `log/<seq>` occupied by a FOREIGN session, probes
     * `seq+1`, and commits there with NO throw. The formerly "orphaned"
     * row is now part of the durable history.
     */
    test(`[${variant.label}] orphan-at-tail is a committed write; next writer probes forward and commits`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }

      const tablePrefix = TABLE_PREFIX;
      const currentJsonKey = CURRENT_JSON_KEY;
      await provision(storage);

      // 1) One clean single-input commit lands at seq 0.
      const goodWriter = new Writer({ storage, currentJsonKey });
      await goodWriter.commit({
        op: "I",
        collection: COLLECTION,
        docId: "first",
        body: { _id: "first", kind: "good" },
      });

      // 2) A FOREIGN writer commits a durable entry at seq 1 but its
      //    `current.json` is never touched (single-write commit: the
      //    numbered create IS the commit). Model it directly: PUT a
      //    foreign-session log entry at seq 1 via `If-None-Match: "*"`.
      //    Under the OLD two-write protocol this was an "orphan that
      //    wedges every future writer"; under single-write commit it is a
      //    committed write that the next writer probes past.
      const orphanEntry = {
        lsn: "00000000000000_FOREIGN_zzzzzzzzzz",
        commit_ts: new Date().toISOString(),
        op: "I",
        collection: COLLECTION,
        doc_id: "orphan-doc",
        session: "FOREIGN0",
        seq: 1,
        after: { _id: "orphan-doc", kind: "orphan" },
      };
      const orphanBytes = encodeJsonBytes(orphanEntry.after);
      const orphanVersion = await versionFromContent(orphanBytes);
      await storage.put(`${tablePrefix}/content/${orphanVersion}.json`, orphanBytes, {
        ifNoneMatch: "*",
        contentType: "application/json",
      });
      await storage.put(`${tablePrefix}/log/1.json`, encodeJsonBytes(orphanEntry), {
        ifNoneMatch: "*",
        contentType: "application/json",
      });

      // The committed entry IS durable at seq 1.
      const seqsAfterCrash = await durableLogSeqs(storage, tablePrefix);
      expect(seqsAfterCrash).toContain(1);

      // 3) A fresh writer (new session) commits. It reads the same stale
      //    tail_hint, probes, finds log/1 occupied by a FOREIGN session,
      //    probes seq 2, and commits there with NO throw.
      const freshWriter = new Writer({
        storage,
        currentJsonKey,
      });
      await freshWriter.commit({
        op: "I",
        collection: COLLECTION,
        docId: "wedge-probe",
        body: { _id: "wedge-probe", kind: "probe" },
      });

      // The discovered tail advanced: log/2 now exists (no hole).
      const seqsAfterProbe = await durableLogSeqs(storage, tablePrefix);
      expect(seqsAfterProbe).toContain(2);
      expect(seqsAfterProbe).toEqual([0, 1, 2]);

      // A full read sees BOTH the orphan-since-committed row AND the probe.
      const ids = await readAllRowIds(storage);
      expect(ids).toContain("orphan-doc");
      expect(ids).toContain("wedge-probe");
      expect(ids).toContain("first");
    });

    /**
     * ── Arm 2: two writers race log/N; exactly one wins, loser probes. ─
     *
     * Plan-A exactly-one-winner: both writers see `tail_hint=N` and both
     * `If-None-Match:"*"` create `log/N`. One wins; the loser sees a
     * FOREIGN 412, probes `N+1`, and commits there. No hole, no wedge.
     */
    test(`[${variant.label}] two writers race log/N: one wins, loser probes N+1`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
      const currentJsonKey = CURRENT_JSON_KEY;
      const tablePrefix = TABLE_PREFIX;
      await provision(storage);

      const w1 = new Writer({ storage, currentJsonKey });
      const w2 = new Writer({ storage, currentJsonKey });

      // Both start from tail_hint=0 (fresh) and contend on log/0.
      const [r1, r2] = await Promise.allSettled([
        w1.commit({ op: "I", collection: COLLECTION, docId: "race-a", body: { _id: "race-a" } }),
        w2.commit({ op: "I", collection: COLLECTION, docId: "race-b", body: { _id: "race-b" } }),
      ]);
      // BOTH must succeed — the loser re-probes forward and commits.
      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("fulfilled");

      // Dense at 0,1 — no hole, no wedge.
      const seqs = await durableLogSeqs(storage, tablePrefix);
      expect(seqs).toEqual([0, 1]);
      const ids = await readAllRowIds(storage);
      expect(ids).toContain("race-a");
      expect(ids).toContain("race-b");
    });

    /**
     * ── Arm 3: reader sees a committed prefix above a stale hint. ──────
     *
     * Commit `log/N` while `tail_hint` stays below `N` (no compactor run,
     * so no durable hint refresh). A reader still sees `log/N` via the
     * forward-probe — the hint is a non-authoritative lower bound.
     */
    test(`[${variant.label}] reader sees committed prefix above a stale tail_hint`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
      const currentJsonKey = CURRENT_JSON_KEY;
      await provision(storage);

      // Commit three entries through the writer (single-write commit
      // advances NO durable tail_hint — only the compactor does). We do
      // NOT run the compactor, so the stored hint stays at 0.
      const w = new Writer({ storage, currentJsonKey });
      for (const id of ["r0", "r1", "r2"]) {
        await w.commit({ op: "I", collection: COLLECTION, docId: id, body: { _id: id } });
      }

      // The stored hint is still the stale lower bound (no compactor ran).
      const cur = await readCurrentJson(storage, currentJsonKey);
      expect(cur!.json.tail_hint).toBe(0);

      // A reader still sees the full committed prefix via the forward-probe.
      const ids = await readAllRowIds(storage);
      expect(ids).toEqual(["r0", "r1", "r2"]);
    });

    /**
     * ── Arm 4: lost-ack / false-412 (the sharpest trap). ──────────────
     *
     * The writer PUTs `log/N` and the create SUCCEEDS on the backend, but
     * the RESPONSE is DROPPED (a NetworkError thrown AFTER the durable
     * write lands). The writer retries WITHIN THE SAME `commit()` (same
     * session), gets a 412, reads back the occupant → OWN session, OWN
     * seq → ADOPTS → returns success. The logical write lands at EXACTLY
     * `N` and is NOT duplicated at `N+1`. Without adoption a dropped ack
     * double-commits.
     */
    test(`[${variant.label}] lost-ack: dropped response on log/N adopts, lands at exactly N`, async () => {
      const { storage, cleanup } = await variant.build();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
      const currentJsonKey = CURRENT_JSON_KEY;
      const tablePrefix = TABLE_PREFIX;
      await provision(storage);

      // Wrap storage so the FIRST PUT to a log/<seq> key writes through
      // to the backend (the create lands durably) but THEN throws a
      // NetworkError — the ack is lost. Subsequent ops pass through.
      let dropped = false;
      const lossy: Storage = {
        get: (k, o) => storage.get(k, o),
        delete: (k, o) => storage.delete(k, o),
        list: (p, o) => storage.list(p, o),
        async put(k, b, o) {
          if (!dropped && /\/log\/\d+\.json$/.test(k)) {
            dropped = true;
            // The write LANDS first, then the ack is dropped.
            await storage.put(k, b, o);
            throw new BaerlyError("NetworkError", "injected dropped ack on log PUT");
          }
          return storage.put(k, b, o);
        },
      };

      const w = new Writer({
        storage: lossy,
        currentJsonKey,
      });
      // The writer's occupant readback inside commit() must adopt the
      // lost-ack write and return success — NOT throw, NOT double-commit.
      const result = await w.commit({
        op: "I",
        collection: COLLECTION,
        docId: "lost-ack",
        body: { _id: "lost-ack" },
      });
      expect(result.entry.seq).toBe(0);

      // EXACTLY one log entry — landed at N (=0), NOT duplicated at N+1.
      const seqs = await durableLogSeqs(storage, tablePrefix);
      expect(seqs).toEqual([0]);
      const ids = await readAllRowIds(storage);
      expect(ids).toEqual(["lost-ack"]);
    });

    /**
     * ── Arm 5: density invariant — no interior holes. ─────────────────
     *
     * Across a crash-injected run of single-input commits, the log must
     * stay dense: `∀ seq: log/<seq+1> exists ⟹ log/<seq> exists`. Every
     * writer honors first-empty-slot via the forward-probe; the storage
     * layer can't enforce this, so assert it directly.
     */
    propTest.prop(
      {
        seeds: fc.integer({ min: 2, max: 12 }),
        abortAfter: fc.integer({ min: 1, max: 10 }),
        fault: faultKindArb,
      },
      FC_PARAMS,
    )(
      `[${variant.label}] density invariant: no interior log holes under crash injection`,
      async ({ seeds, abortAfter, fault }) => {
        const { storage, cleanup } = await variant.build();
        if (cleanup !== undefined) {
          cleanups.push(cleanup);
        }
        const currentJsonKey = CURRENT_JSON_KEY;
        const tablePrefix = TABLE_PREFIX;
        await provision(storage);

        const w = new Writer({
          storage,
          currentJsonKey,
        });
        for (let i = 0; i < seeds; i++) {
          const id = `d-${i}`;
          await w.commit({ op: "I", collection: COLLECTION, docId: id, body: { _id: id } });
        }

        // Inject a crash mid-commit, then a recovery commit. The recovery
        // writer must NOT fill a hole — it commits at the dense tail.
        const handle = abortingStorage(storage);
        const crash = (target: Storage = handle.storage): Promise<unknown> =>
          new Writer({ storage: target, currentJsonKey }).commit({
            op: "I",
            collection: COLLECTION,
            docId: "crash-doc",
            body: { _id: "crash-doc" },
          });
        armFault(handle, fault, await pickOp(storage, crash, abortAfter));
        // An abort is expected on most arming points. The physical oracle
        // runs on memory only: hashing the bucket twice per case pushes the
        // local-fs arm toward its timeout at `FC_NUM_RUNS=10000`.
        if (variant.label === "memory") {
          expectPhysicallyClean(await observe(storage, "write", crash, fault));
        } else {
          await crash().catch(() => {});
        }
        notePostApply(`density-${variant.label}`, handle);
        await w.commit({
          op: "I",
          collection: COLLECTION,
          docId: "recover-doc",
          body: { _id: "recover-doc" },
        });

        // DENSITY: the durable seqs form a contiguous prefix [0, max].
        const seqs = await durableLogSeqs(storage, tablePrefix);
        expect(seqs.length).toBeGreaterThan(0);
        for (let j = 0; j < seqs.length; j++) {
          expect(seqs[j]).toBe(j);
        }
      },
      PROP_TIMEOUT_MS,
    );
  }
});
