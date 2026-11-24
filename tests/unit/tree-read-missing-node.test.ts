/**
 * Acceptance for a node missing mid-read in the prototype tree reader
 * (`packages/server/src/tree/read.ts`, "Missing node"): a fold moved the
 * root after the read captured the head, and GC deleted a node the old
 * root reached before the read's GET of it landed.
 *
 * - The reader GETs a missing node once more; a miss that heals there is
 *   served with no head re-read.
 * - Still missing, it re-reads the head. A moved root restarts the read
 *   once from the new head, and the answer equals the logical oracle
 *   (`tree-oracle-logical.ts`) over the bucket the restart read.
 * - A root that moves again after the restart, or a request ledger with
 *   no room for the restart, refuses with a retriable
 *   `MaintenancePending` carrying `retryAfter`.
 * - A root that has not moved makes the missing node corruption,
 *   `InvalidResponse` from the decoder's `present` check.
 * - The re-GET and the head re-read are admitted against the ledger at
 *   every attempt; without room the read refuses with the retriable
 *   `MaintenancePending`, never the ledger's `CapacityExceeded`.
 *
 * Every case runs for a point read, a range, a count and a complete
 * scan, with the node missing below the root or the root itself missing.
 * The `mutation` block shows each check goes red under its mutant from
 * `tests/fixtures/tree-mutants.ts`.
 */
import { describe, expect, test } from "vitest";
import {
  BaerlyError,
  MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
  RequestLedger,
  retryStorageCall,
  type Storage,
} from "@baerly/protocol";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import { TREE_RETRIED_CALL_CHARGE } from "../../packages/server/src/tree/constants.ts";
import { treeHeadKey } from "../../packages/server/src/tree/head.ts";
import type { TreeConfig } from "../../packages/server/src/tree/layout.ts";
import {
  countTree,
  readTreePoint,
  openTreeView,
  readTreeRange,
  readTreeScan,
  type TreeReadTarget,
  treeScanBaseCalls,
} from "../../packages/server/src/tree/read.ts";
import { ledgeredStorage } from "../fixtures/ledgered-storage.ts";
import { TreeBucket } from "../fixtures/tree-bucket.ts";
import { configOf, SMALL_LAYOUT } from "../fixtures/tree-fold-harness.ts";
import {
  MISSING_NODE_IS_CORRUPT,
  MISSING_NODE_NOT_REFETCHED,
  READ_RESTARTS_WITHOUT_BOUND,
  MISSING_NODE_SKIPS_LEDGER,
  RESTART_SKIPS_LEDGER,
  type TreeMutant,
} from "../fixtures/tree-mutants.ts";
import {
  type LogicalView,
  readPoint,
  readRange,
  readScan,
} from "../fixtures/tree-oracle-logical.ts";

const SMALL = configOf(SMALL_LAYOUT);

const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------
// Buckets and races
// ---------------------------------------------------------------------

/** `n` IDs `<prefix><i>`, zero-padded to one width so byte order is index order. */
const names = (prefix: string, n: number): string[] => {
  const width = String(n - 1).length;
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(width, "0")}`);
};

/** A folded tree of depth 3 or more under the small layout, with a short unfolded tail. */
const deepBucket = async (): Promise<TreeBucket> => {
  const bucket = await TreeBucket.open(SMALL);
  await bucket.commit(names("n", 40).map((id) => ({ id, value: { _id: id } })));
  await bucket.fold();
  await bucket.commit([
    { id: "n05", value: { _id: "n05", v: 1 } },
    { id: "n31", value: null },
  ]);
  return bucket;
};

/** Every node key of the tree `bucket`'s head names. */
const liveNodeKeys = (bucket: TreeBucket): Set<string> =>
  new Set(bucket.tree?.levels.flat().map((node) => node.key) ?? []);

/**
 * A fold that moves the root, then GC of every node it superseded: commit
 * one insert and one update, fold the whole log under a fresh attempt
 * (so no node is reused), and delete each node of the old tree.
 */
const foldAndCollect = async (bucket: TreeBucket, n: number): Promise<void> => {
  const superseded = liveNodeKeys(bucket);
  await bucket.commit([
    { id: `r${n}`, value: { _id: `r${n}` } },
    { id: "n15", value: { _id: "n15", v: n } },
  ]);
  await bucket.fold();
  const live = liveNodeKeys(bucket);
  for (const key of superseded) {
    if (!live.has(key)) {
      await bucket.storage.delete(key);
    }
  }
};

/**
 * Where a race fires: the first GET of a node of the current tree below
 * its root, or of its root.
 */
type Where = "below-root" | "root";

const WHERES: readonly Where[] = ["below-root", "root"];

/** Whether the GET of `key` is the race's trigger on `bucket` as it is now. */
const triggers = (bucket: TreeBucket, where: Where, key: string): boolean => {
  const root = bucket.tree?.root?.key;
  return where === "root" ? key === root : key !== root && liveNodeKeys(bucket).has(key);
};

/**
 * The reader's storage over `bucket`: it records every GET key and every
 * write, and runs `beforeGet` before each GET, which may answer
 * not-found in its place.
 */
const readerStorage = (
  bucket: TreeBucket,
  beforeGet: (key: string) => Promise<"miss" | undefined> = () => Promise.resolve(undefined),
) => {
  const gets: string[] = [];
  let writes = 0;
  const storage: Storage = {
    get: async (key, opts) => {
      gets.push(key);
      if ((await beforeGet(key)) === "miss") {
        return null;
      }
      return bucket.storage.get(key, opts);
    },
    put: (key, body, opts) => {
      writes += 1;
      return bucket.storage.put(key, body, opts);
    },
    delete: (key, opts) => {
      writes += 1;
      return bucket.storage.delete(key, opts);
    },
    list: (prefix, opts) => bucket.storage.list(prefix, opts),
  };
  const head = treeHeadKey(bucket.prefix);
  return {
    storage,
    gets,
    writes: () => writes,
    headGets: () => gets.filter((key) => key === head).length,
    /** How many times `key` was GET. */
    getsOf: (key: string) => gets.filter((got) => got === key).length,
  };
};

/**
 * Reader storage over `bucket` that runs {@link foldAndCollect} at the
 * first GET matching `where`, up to `times` times, before serving it.
 * Each race moves the root, so the next one fires on the new tree.
 */
const racingStorage = (bucket: TreeBucket, where: Where, times: number) => {
  let raced = 0;
  let running: Promise<void> | null = null;
  const missed: string[] = [];
  const reader = readerStorage(bucket, async (key) => {
    // A GET issued while a race runs waits for it, so a batch's sibling
    // GETs see the GC too and never start a second race on the old tree.
    // Both the check and the start are synchronous, before any await.
    if (running !== null) {
      await running;
      return undefined;
    }
    if (raced < times && triggers(bucket, where, key)) {
      raced += 1;
      missed.push(key);
      running = foldAndCollect(bucket, raced);
      await running;
      running = null;
    }
    return undefined;
  });
  return { ...reader, raced: () => raced, missed };
};

// ---------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------

const POINT_ID = "n20";
const RANGE = { gte: "n10", lt: "n30" } as const;

interface Shape {
  readonly name: "point" | "range" | "count" | "scan";
  readonly read: (target: TreeReadTarget) => Promise<unknown>;
  readonly oracle: (view: LogicalView) => unknown;
  /** Base GETs below the root the read may issue, from the root's bytes and depth. */
  readonly baseCalls: (bytes: number, depth: number) => number;
}

const scanBase = (bytes: number, depth: number): number =>
  treeScanBaseCalls(bytes, depth, SMALL_LAYOUT);

const SHAPES: readonly Shape[] = [
  {
    name: "point",
    read: (t) => readTreePoint(t, POINT_ID),
    oracle: (v) => readPoint(v, POINT_ID),
    baseCalls: (_bytes, depth) => depth,
  },
  {
    name: "range",
    read: (t) => readTreeRange(t, RANGE),
    oracle: (v) => readRange(v, RANGE),
    baseCalls: scanBase,
  },
  { name: "count", read: (t) => countTree(t), oracle: (v) => v.rows.size, baseCalls: scanBase },
  { name: "scan", read: (t) => readTreeScan(t), oracle: (v) => readScan(v), baseCalls: scanBase },
];

const targetOf = (bucket: TreeBucket, storage: Storage, config: TreeConfig): TreeReadTarget => ({
  storage,
  prefix: bucket.prefix,
  config,
});

/** What `read` resolved to or threw. */
const settle = async (
  read: () => Promise<unknown>,
): Promise<{ value?: unknown; error?: unknown }> => {
  try {
    return { value: await read() };
  } catch (error) {
    return { error };
  }
};

const describeError = (error: unknown): string =>
  error instanceof BaerlyError ? `${error.code}: ${error.message}` : String(error);

/** Whether `error` is the retriable read-again refusal for `bound`; a description when not. */
const notReadAgainRefusal = (error: unknown, bound: string): string | undefined => {
  if (!(error instanceof BaerlyError) || error.code !== "MaintenancePending") {
    return `expected MaintenancePending (${bound}), got ${describeError(error)}`;
  }
  const cause = error.cause as { bound?: string } | undefined;
  if (cause?.bound !== bound) {
    return `expected cause.bound ${bound}, got ${json(cause)}`;
  }
  if (!error.retriable || error.retryAfter !== MAINTENANCE_PENDING_RETRY_AFTER_SECONDS) {
    return `not retriable with retryAfter ${MAINTENANCE_PENDING_RETRY_AFTER_SECONDS}: ${json({
      retriable: error.retriable,
      retryAfter: error.retryAfter,
    })}`;
  }
  return undefined;
};

/** Run `fn` with a request ledger of `limit` storage calls in each pool, reads charged internally. */
const underLedger = async <T>(limit: number, fn: () => Promise<T>): Promise<T> =>
  runWithContext(
    createObservabilityContext({
      ledger: new RequestLedger({ internal: limit, external: limit }),
      readEnvelope: { requestPool: "internal" },
    }),
    fn,
  );

// ---------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------

/**
 * A fold moves the root and GC deletes the old tree between the head
 * GET and a node GET: the read re-GETs the node, re-reads the head,
 * restarts once and answers as the oracle over the bucket it restarted
 * on, writing nothing.
 */
const restartServes = async (mutant?: TreeMutant): Promise<string | undefined> => {
  for (const where of WHERES) {
    for (const shape of SHAPES) {
      const bucket = await deepBucket();
      const reader = racingStorage(bucket, where, 1);
      const got = await settle(() =>
        shape.read(targetOf(bucket, reader.storage, configOf(SMALL_LAYOUT, mutant))),
      );
      const at = `${shape.name}, ${where}`;
      if (reader.raced() !== 1) {
        return `${at}: the race fired ${reader.raced()} times`;
      }
      if ("error" in got) {
        return `${at}: ${describeError(got.error)}`;
      }
      if (json(got.value) !== json(shape.oracle(bucket.view()))) {
        return `${at}: ${json(got.value)}, oracle ${json(shape.oracle(bucket.view()))}`;
      }
      if (reader.getsOf(reader.missed[0]!) !== 2) {
        return `${at}: the missing node was GET ${reader.getsOf(reader.missed[0]!)} times, not 2`;
      }
      if (reader.headGets() !== 2) {
        return `${at}: ${reader.headGets()} head GETs, not 2`;
      }
      if (reader.writes() !== 0) {
        return `${at}: the read issued ${reader.writes()} writes`;
      }
    }
  }
  return undefined;
};

/** The root moves again after the restart: a retriable refusal, with the head read three times. */
const secondMoveRefuses = async (mutant?: TreeMutant): Promise<string | undefined> => {
  for (const where of WHERES) {
    for (const shape of SHAPES) {
      const bucket = await deepBucket();
      const reader = racingStorage(bucket, where, 2);
      const got = await settle(() =>
        shape.read(targetOf(bucket, reader.storage, configOf(SMALL_LAYOUT, mutant))),
      );
      const at = `${shape.name}, ${where}`;
      if (reader.raced() !== 2) {
        return `${at}: the race fired ${reader.raced()} times`;
      }
      if (!("error" in got)) {
        return `${at}: served ${json(got.value)} after the root moved twice`;
      }
      const wrong = notReadAgainRefusal(got.error, "rootMovedAgain");
      if (wrong !== undefined) {
        return `${at}: ${wrong}`;
      }
      if (reader.headGets() !== 3) {
        return `${at}: ${reader.headGets()} head GETs, not 3`;
      }
    }
  }
  return undefined;
};

/**
 * Storage calls the read issues through the second head GET, and what
 * its restart charges: the root GET and the new head's log calls, then
 * with the new root (one call later) those log calls and the base, every
 * attempt counted. The bucket's fold leaves `tail_hint` at the tail, so
 * the new head's log calls are the probe's closing slot alone.
 */
const restartBoundary = async (shape: Shape): Promise<number> => {
  const bucket = await deepBucket();
  const reader = racingStorage(bucket, "below-root", 1);
  await underLedger(1_000_000, () =>
    shape.read(targetOf(bucket, ledgeredStorage(reader.storage, "internal"), SMALL)),
  );
  const head = treeHeadKey(bucket.prefix);
  const reread = reader.gets.findIndex(
    (key, index) => key === head && reader.gets.indexOf(head) < index,
  );
  const spent = reread + 1;
  const root = bucket.tree!.root!;
  const logCalls = (1 + (bucket.tail - bucket.floor)) * TREE_RETRIED_CALL_CHARGE;
  const beforeRoot = TREE_RETRIED_CALL_CHARGE + logCalls;
  const withRoot =
    1 +
    logCalls +
    shape.baseCalls(root.summary.bytes, bucket.tree!.levels.length - 1) * TREE_RETRIED_CALL_CHARGE;
  return spent + Math.max(beforeRoot, withRoot);
};

/**
 * At the smallest ledger the restart fits, the read is served; one call
 * fewer refuses with the retriable `MaintenancePending`, never running
 * the restart into the ledger.
 */
const restartLedgerBoundary = async (mutant?: TreeMutant): Promise<string | undefined> => {
  for (const shape of SHAPES) {
    const limit = await restartBoundary(shape);
    for (const [ledger, served] of [
      [limit, true],
      [limit - 1, false],
    ] as const) {
      const bucket = await deepBucket();
      const reader = racingStorage(bucket, "below-root", 1);
      const got = await settle(() =>
        underLedger(ledger, () =>
          shape.read(
            targetOf(
              bucket,
              ledgeredStorage(reader.storage, "internal"),
              configOf(SMALL_LAYOUT, mutant),
            ),
          ),
        ),
      );
      const at = `${shape.name} at a ledger of ${ledger} (boundary ${limit})`;
      if (served) {
        if ("error" in got) {
          return `${at}: ${describeError(got.error)}`;
        }
        if (json(got.value) !== json(shape.oracle(bucket.view()))) {
          return `${at}: ${json(got.value)}, oracle ${json(shape.oracle(bucket.view()))}`;
        }
        continue;
      }
      if (!("error" in got)) {
        return `${at}: served ${json(got.value)} with no room for the restart`;
      }
      const wrong = notReadAgainRefusal(got.error, "restartStorageCalls");
      if (wrong !== undefined) {
        return `${at}: ${wrong}`;
      }
    }
  }
  return undefined;
};

/** The key of the leaf holding `id` in `bucket`'s tree. */
const leafOf = (bucket: TreeBucket, id: string): string =>
  bucket.tree!.levels[0]!.find((leaf) => leaf.summary.lo <= id && id <= leaf.summary.hi)!.key;

/** Which node a check makes missing: the leaf holding {@link POINT_ID}, or the root. */
const missingKey = (bucket: TreeBucket, where: Where): string =>
  where === "root" ? bucket.tree!.root!.key : leafOf(bucket, POINT_ID);

/**
 * A node's first GET finds nothing and its re-GET finds it: the read is
 * served with no head re-read and no restart.
 */
const transientMissHeals = async (mutant?: TreeMutant): Promise<string | undefined> => {
  for (const where of WHERES) {
    for (const shape of SHAPES) {
      const bucket = await deepBucket();
      const key = missingKey(bucket, where);
      let missed = false;
      const reader = readerStorage(bucket, (got) => {
        if (!missed && got === key) {
          missed = true;
          return Promise.resolve("miss");
        }
        return Promise.resolve(undefined);
      });
      const result = await settle(() =>
        shape.read(targetOf(bucket, reader.storage, configOf(SMALL_LAYOUT, mutant))),
      );
      const at = `${shape.name}, ${where}`;
      if (!missed) {
        return `${at}: the read never GET the node`;
      }
      if ("error" in result) {
        return `${at}: ${describeError(result.error)}`;
      }
      if (json(result.value) !== json(shape.oracle(bucket.view()))) {
        return `${at}: ${json(result.value)}, oracle ${json(shape.oracle(bucket.view()))}`;
      }
      if (reader.getsOf(key) !== 2 || reader.headGets() !== 1) {
        return `${at}: the node GET ${reader.getsOf(key)} times and the head ${reader.headGets()}, not 2 and 1`;
      }
    }
  }
  return undefined;
};

/** Calls issued before the `nth` (1-based) GET of `key`, in GET order. */
const callsBefore = (gets: readonly string[], key: string, nth: number): number => {
  let seen = 0;
  const index = gets.findIndex((got) => got === key && ++seen === nth);
  if (index < 0) {
    throw new Error(`GET ${nth} of ${key} never happened`);
  }
  return index;
};

/**
 * The re-GET of a missing node is admitted at every attempt: a point
 * read whose leaf's first GET misses and whose re-GET heals it is served
 * with exactly that charge left, and refused with a retriable
 * `MaintenancePending` one call below it, before the re-GET is issued.
 */
const regetLedgerBoundary = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const point = SHAPES.find((shape) => shape.name === "point")!;
  const run = async (ledger: number) => {
    const bucket = await deepBucket();
    const key = leafOf(bucket, POINT_ID);
    let missed = false;
    const reader = readerStorage(bucket, (got) => {
      if (!missed && got === key) {
        missed = true;
        return Promise.resolve("miss");
      }
      return Promise.resolve(undefined);
    });
    const got = await settle(() =>
      underLedger(ledger, () =>
        point.read(
          targetOf(
            bucket,
            ledgeredStorage(reader.storage, "internal"),
            configOf(SMALL_LAYOUT, mutant),
          ),
        ),
      ),
    );
    return { got, reader, key, bucket };
  };
  const probe = await run(1_000_000);
  const limit = callsBefore(probe.reader.gets, probe.key, 2) + TREE_RETRIED_CALL_CHARGE;
  const served = await run(limit);
  if ("error" in served.got) {
    return `at the boundary ${limit}: ${describeError(served.got.error)}`;
  }
  if (json(served.got.value) !== json(point.oracle(served.bucket.view()))) {
    return `at the boundary ${limit}: ${json(served.got.value)}`;
  }
  const refused = await run(limit - 1);
  if (!("error" in refused.got)) {
    return `one call below the boundary ${limit}: served ${json(refused.got.value)}`;
  }
  const wrong = notReadAgainRefusal(refused.got.error, "missingNodeStorageCalls");
  if (wrong !== undefined) {
    return `one call below the boundary ${limit}: ${wrong}`;
  }
  if (refused.reader.getsOf(refused.key) !== 1) {
    return `one call below the boundary: the node was GET ${refused.reader.getsOf(refused.key)} times, not 1`;
  }
  return undefined;
};

/**
 * The head re-read after a miss is admitted at every attempt: with a
 * node deleted and the head unchanged, the read is `InvalidResponse` with
 * exactly that charge left, and a retriable `MaintenancePending` one call
 * below it, before the head re-read is issued.
 *
 * A range, count or scan missing a node below the root has no such
 * boundary: its scan admission reserved every base GET at every attempt,
 * so one call below this limit refuses at admission instead. It runs
 * here for a missing root, which the open reads before any admission.
 */
const headRereadLedgerBoundary = async (mutant?: TreeMutant): Promise<string | undefined> => {
  for (const where of WHERES) {
    for (const shape of SHAPES) {
      if (where === "below-root" && shape.name !== "point") {
        continue;
      }
      const run = async (ledger: number) => {
        const bucket = await deepBucket();
        await bucket.storage.delete(missingKey(bucket, where));
        const reader = readerStorage(bucket);
        const got = await settle(() =>
          underLedger(ledger, () =>
            shape.read(
              targetOf(
                bucket,
                ledgeredStorage(reader.storage, "internal"),
                configOf(SMALL_LAYOUT, mutant),
              ),
            ),
          ),
        );
        return { got, reader, head: treeHeadKey(bucket.prefix) };
      };
      const probe = await run(1_000_000);
      const limit = callsBefore(probe.reader.gets, probe.head, 2) + TREE_RETRIED_CALL_CHARGE;
      const at = `${shape.name}, ${where}, boundary ${limit}`;
      const corrupt = await run(limit);
      if ((corrupt.got.error as BaerlyError | undefined)?.code !== "InvalidResponse") {
        return `${at}: expected InvalidResponse, got ${"error" in corrupt.got ? describeError(corrupt.got.error) : json(corrupt.got.value)}`;
      }
      const refused = await run(limit - 1);
      if (!("error" in refused.got)) {
        return `${at}, one call below: served ${json(refused.got.value)}`;
      }
      const wrong = notReadAgainRefusal(refused.got.error, "missingNodeStorageCalls");
      if (wrong !== undefined) {
        return `${at}, one call below: ${wrong}`;
      }
      if (refused.reader.headGets() !== 1) {
        return `${at}, one call below: ${refused.reader.headGets()} head GETs, not 1`;
      }
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("a node missing mid-read", () => {
  test.each(SHAPES)("a root restart admits the subsequent $name traversal", async (shape) => {
    const bucket = await deepBucket();
    const reader = racingStorage(bucket, "root", 1);
    await expect(
      underLedger(10, () =>
        shape.read(targetOf(bucket, ledgeredStorage(reader.storage, "internal"), SMALL)),
      ),
    ).rejects.toMatchObject({
      code: "MaintenancePending",
      retryAfter: MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
      cause: { bound: "restartStorageCalls" },
    });
  });

  test.each([true, false])(
    "a restart charges retries for the tail (hint current: %s)",
    async (hintCurrent) => {
      const bucket = await TreeBucket.open(SMALL);
      await bucket.commit([{ id: "a", value: { _id: "a" } }]);
      await bucket.fold();
      const oldRoot = bucket.tree!.root!.key;
      let raced = false;
      const reader = readerStorage(bucket, async (key) => {
        if (key === oldRoot && !raced) {
          raced = true;
          await foldAndCollect(bucket, 1);
          await bucket.commit([{ id: "c", value: { _id: "c" } }]);
          if (hintCurrent) {
            await bucket.setTailHint(bucket.tail);
          }
        }
        return undefined;
      });
      const storage: Storage = {
        ...reader.storage,
        get: (key, opts) => {
          const retries = raced && key !== oldRoot && key !== treeHeadKey(bucket.prefix);
          let attempt = 0;
          return retryStorageCall(
            async () => {
              if (retries && attempt++ < TREE_RETRIED_CALL_CHARGE - 1) {
                throw new BaerlyError("NetworkError", "transient read failure");
              }
              return reader.storage.get(key, opts);
            },
            { pool: "internal", sleep: async () => {} },
          );
        },
      };
      await expect(
        underLedger(9, () => openTreeView(targetOf(bucket, storage, SMALL))),
      ).rejects.toMatchObject({
        code: "MaintenancePending",
        cause: { bound: "restartStorageCalls" },
      });
      expect(reader.getsOf(bucket.tree!.root!.key)).toBe(0);
    },
  );

  test("a restart whose forward probe exhausts the ledger remains retriable", async () => {
    const bucket = await deepBucket();
    const oldRoot = bucket.tree!.root!.key;
    let raced = false;
    const reader = readerStorage(bucket, async (key) => {
      if (key === oldRoot && !raced) {
        raced = true;
        await foldAndCollect(bucket, 1);
        await bucket.commit(names("pending", 10).map((id) => ({ id, value: { _id: id } })));
      }
      return undefined;
    });
    await expect(
      underLedger(10, () =>
        readTreePoint(
          targetOf(bucket, ledgeredStorage(reader.storage, "internal"), SMALL),
          POINT_ID,
        ),
      ),
    ).rejects.toMatchObject({
      code: "MaintenancePending",
      cause: { bound: "restartStorageCalls" },
    });
  });

  test("a restart preserves the tail entry envelope refusal", async () => {
    const bucket = await deepBucket();
    const oldRoot = bucket.tree!.root!.key;
    let raced = false;
    const reader = readerStorage(bucket, async (key) => {
      if (key === oldRoot && !raced) {
        raced = true;
        await foldAndCollect(bucket, 1);
        await bucket.commit([{ id: "pending", value: { _id: "pending" } }]);
      }
      return undefined;
    });
    await expect(
      runWithContext(createObservabilityContext({ readEnvelope: { maxTailEntries: 0 } }), () =>
        readTreePoint(targetOf(bucket, reader.storage, SMALL), POINT_ID),
      ),
    ).rejects.toMatchObject({ code: "CapacityExceeded", cause: { bound: "tailEntries" } });
  });

  test("a fold and GC under the read: it re-GETs the node, re-reads the head, restarts once and matches the oracle", async () => {
    await expect(restartServes()).resolves.toBeUndefined();
  });

  test("the root moving again after the restart refuses with a retriable MaintenancePending", async () => {
    await expect(secondMoveRefuses()).resolves.toBeUndefined();
  });

  test("a restart the ledger has no room for refuses with a retriable MaintenancePending; one call more is served", async () => {
    await expect(restartLedgerBoundary()).resolves.toBeUndefined();
  });

  test("a missing node's re-GET is admitted at every attempt: served at the limit, MaintenancePending one call below", async () => {
    await expect(regetLedgerBoundary()).resolves.toBeUndefined();
  });

  test("the head re-read after a miss is admitted at every attempt: InvalidResponse at the limit, MaintenancePending one call below", async () => {
    await expect(headRereadLedgerBoundary()).resolves.toBeUndefined();
  });

  test("a miss the re-GET heals is served with no head re-read", async () => {
    await expect(transientMissHeals()).resolves.toBeUndefined();
  });

  test.each(WHERES.flatMap((where) => SHAPES.map((shape) => [shape.name, where, shape] as const)))(
    "%s with the %s missing and the head unchanged is InvalidResponse from the present check",
    async (_name, where, shape) => {
      const bucket = await deepBucket();
      const key = missingKey(bucket, where);
      await bucket.storage.delete(key);
      const reader = readerStorage(bucket);
      const got = await settle(() => shape.read(targetOf(bucket, reader.storage, SMALL)));
      expect(got.error).toMatchObject({ code: "InvalidResponse" });
      expect((got.error as BaerlyError).message).toContain("present check failed");
      expect(reader.getsOf(key)).toBe(2);
      expect(reader.headGets()).toBe(2);
      expect(reader.writes()).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------

describe("mutation", () => {
  const checks: readonly (readonly [
    string,
    (mutant?: TreeMutant) => Promise<string | undefined>,
    TreeMutant,
  ])[] = [
    ["the restart", restartServes, MISSING_NODE_IS_CORRUPT],
    ["the second move", secondMoveRefuses, READ_RESTARTS_WITHOUT_BOUND],
    ["the restart ledger boundary", restartLedgerBoundary, RESTART_SKIPS_LEDGER],
    ["the healed miss", transientMissHeals, MISSING_NODE_NOT_REFETCHED],
    ["the re-GET ledger boundary", regetLedgerBoundary, MISSING_NODE_SKIPS_LEDGER],
    ["the head re-read ledger boundary", headRereadLedgerBoundary, MISSING_NODE_SKIPS_LEDGER],
  ];

  test.each(checks.map(([name, check, mutant]) => [mutant.name, name, check, mutant] as const))(
    "%s turns %s red",
    async (_mutant, _check, check, mutant) => {
      await expect(check(mutant)).resolves.toBeDefined();
    },
  );
});
