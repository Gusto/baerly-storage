/**
 * Acceptance for the write-tick tree fold (`./fold.ts`), run over memory
 * storage behind the adapter retry, with commits through the real
 * `Writer` (`tests/fixtures/tree-writer.ts`).
 *
 * Every published bucket is judged by the physical oracle
 * (`tests/fixtures/tree-oracle-physical.ts`) against the rows the logical
 * oracle folds from the log up to the published floor, and the logical
 * oracle's rows must equal the read path's own fold (`foldLogEntriesOnto`)
 * over the same entries.
 *
 * - A prefix split (one tick of 10 entries, or ticks of 3 + 3 + 4) lands
 *   on the same canonical root.
 * - The fold end never passes a missing log slot: past the tail hint the
 *   first missing slot is the tail; below it, a missing slot is `Internal`.
 * - A depth-0 limit publishes only a root leaf within its ceilings, and on
 *   the byte axis folds the longest prefix whose end state fits.
 * - An invalid survivor is folded past only once a later entry supersedes
 *   it within the budget; otherwise the valid prefix before it publishes.
 *   No tick charges more storage calls than its budget.
 * - A fold whose head changed under it reports `cas-lost`, deletes
 *   nothing, and a re-run folds correctly.
 * - An entry no fresh tick can fold is refused with a counted warning.
 */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  casUpdateCurrentJson,
  type DocumentData,
  decodeJsonBytes,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  MemoryStorage,
  retryStorageCall,
  type Storage,
} from "@baerly/protocol";
import { TREE_TEST_CHUNK_SALT } from "../../../../tests/fixtures/tree-chunk-salt.ts";
import { SMALL_LAYOUT } from "../../../../tests/fixtures/tree-fold-harness.ts";
import { foldLogical } from "../../../../tests/fixtures/tree-oracle-logical.ts";
import {
  captureTreeImage,
  checkTreeImage,
  shapeDigest,
} from "../../../../tests/fixtures/tree-oracle-physical.ts";
import { TreeWriter, type TreeWrite } from "../../../../tests/fixtures/tree-writer.ts";
import { foldLogEntriesOnto } from "../log-walk.ts";
import { createObservabilityContext, runWithContext } from "../observability/context.ts";
import { RequestScopedMetricsRecorder } from "../observability/recorder.ts";
import { foldTree, prepareTreeFold, type TreeFoldInput, type TreeFoldOutcome } from "./fold.ts";
import { readTreeHead, treeHeadKey } from "./head.ts";
import { createTreeConfig, TREE_LAYOUT, type TreeConfig, type TreeLayout } from "./layout.ts";

const PREFIX = "app/helpdesk/tenant/acme/manifests/tickets";
const COLLECTION = "tickets";
const LOG_PREFIX = logObjectKey(PREFIX, 0).slice(0, -"0.json".length);
const SMALL = createTreeConfig({ layout: SMALL_LAYOUT });
const PRODUCTION = createTreeConfig();

/** Adapter retry as the S3 and R2 adapters configure it, with no backoff sleep. */
const adapterRetry = (inner: Storage): Storage => {
  const sleep = async (): Promise<void> => {};
  return {
    get: (key, opts) => retryStorageCall(() => inner.get(key, opts), { sleep }),
    put: (key, body, opts) =>
      retryStorageCall(() => inner.put(key, body, opts), {
        sleep,
        conditionalCreate: opts?.ifNoneMatch === "*",
        compareAndSwap: opts?.ifMatch !== undefined,
      }),
    delete: (key, opts) => retryStorageCall(() => inner.delete(key, opts), { sleep }),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
};

/** Counts every call that reaches the bucket, by op. */
interface Counted extends Storage {
  readonly calls: { get: number; put: number; delete: number };
}

const counted = (inner: Storage): Counted => {
  const calls = { get: 0, put: 0, delete: 0 };
  return {
    calls,
    get: (key, opts) => {
      calls.get += 1;
      return inner.get(key, opts);
    },
    put: (key, body, opts) => {
      calls.put += 1;
      return inner.put(key, body, opts);
    },
    delete: (key, opts) => {
      calls.delete += 1;
      return inner.delete(key, opts);
    },
    list: (prefix, opts) => inner.list(prefix, opts),
  };
};

/** One collection: the bucket, the calls reaching it, and the `Writer` over it. */
interface Bucket {
  readonly bucket: MemoryStorage;
  readonly counted: Counted;
  readonly storage: Storage;
  readonly writer: TreeWriter;
}

const openBucket = (): Bucket => {
  const bucket = new MemoryStorage();
  const c = counted(bucket);
  const storage = adapterRetry(c);
  return { bucket, counted: c, storage, writer: new TreeWriter(storage, PREFIX) };
};

const fold = (
  b: Bucket,
  config: TreeConfig,
  extra: Partial<TreeFoldInput> = {},
): Promise<TreeFoldOutcome> =>
  foldTree({
    storage: b.storage,
    prefix: PREFIX,
    config,
    mintChunkSalt: () => TREE_TEST_CHUNK_SALT,
    ...extra,
  });

/** Every stored log entry, in seq order. */
const logEntries = async (storage: Storage): Promise<LogEntry[]> => {
  const entries: LogEntry[] = [];
  for await (const { key } of storage.list(LOG_PREFIX)) {
    const got = await storage.get(key);
    entries.push(decodeJsonBytes<LogEntry>(got!.body));
  }
  return entries.toSorted((a, b) => a.seq - b.seq);
};

const sortedRows = (rows: Iterable<DocumentData>): string[] =>
  [...rows].map((row) => JSON.stringify(row)).toSorted();

/**
 * Judge the bucket: the head's floor is `floor`, the tree is the
 * canonical tree of the logical oracle's rows through it, and those rows
 * are the read path's fold of the same entries. Returns the tree shape.
 */
const judge = async (storage: Storage, layout: TreeLayout, floor: number): Promise<unknown> => {
  const entries = await logEntries(storage);
  const view = foldLogical({
    collection: COLLECTION,
    base: new Map(),
    baseSeq: 0,
    entries,
    targetSeq: floor,
  });
  const readPath = new Map<string, DocumentData>();
  foldLogEntriesOnto(
    readPath,
    entries.filter((entry) => entry.seq < floor),
    { collection: COLLECTION },
  );
  expect(sortedRows(view.rows.values())).toEqual(sortedRows(readPath.values()));
  if ((await storage.get(treeHeadKey(PREFIX))) === null) {
    // Nothing was ever committed.
    expect(floor).toBe(0);
    return null;
  }
  const report = checkTreeImage({
    image: await captureTreeImage(storage, PREFIX),
    prefix: PREFIX,
    layout,
    expectedRows: view.rows.values(),
    expectedFloor: floor,
  });
  expect(report.violations).toEqual([]);
  expect(sortedRows(report.rows)).toEqual(sortedRows(view.rows.values()));
  return report.shape;
};

const row = (id: string, n: number, pad = ""): TreeWrite => ({
  id,
  value: { _id: id, n, ...(pad !== "" && { pad }) },
});

/** `count` changes over ids `k00..`, mixing inserts, updates and deletes. */
const changes = (count: number): TreeWrite[] =>
  Array.from({ length: count }, (_, i) => {
    if (i % 5 === 4) {
      return { id: `k${String(i - 2).padStart(2, "0")}`, value: null };
    }
    if (i % 5 === 3) {
      return row(`k${String(i - 3).padStart(2, "0")}`, i);
    }
    return row(`k${String(i).padStart(2, "0")}`, i);
  });

const expectPublished = (outcome: TreeFoldOutcome, foldEnd: number): void => {
  expect(outcome).toMatchObject({ kind: "published", foldEnd });
};

describe("prefix split", () => {
  for (const [name, config] of [
    ["small layout, depth 2", SMALL],
    ["production layout, depth 0", PRODUCTION],
  ] as const) {
    test(`${name}: one tick of 10 entries and ticks of 3 + 3 + 4 land on one root`, async () => {
      const log = changes(10);
      const whole = openBucket();
      await whole.writer.commit(log);
      expectPublished(await fold(whole, config), 10);
      const one = await judge(whole.storage, config.layout, 10);

      const split = openBucket();
      let at = 0;
      for (const size of [3, 3, 4]) {
        await split.writer.commit(log.slice(at, at + size));
        at += size;
        expectPublished(await fold(split, config), at);
        await judge(split.storage, config.layout, at);
      }
      const three = await judge(split.storage, config.layout, 10);
      expect(shapeDigest(three as never)).toBe(shapeDigest(one as never));
    });
  }

  test("a tick stopped by its budget, then resumed, lands on the same root", async () => {
    const log = changes(20);
    const whole = openBucket();
    await whole.writer.commit(log);
    expectPublished(await fold(whole, SMALL), 20);
    const one = await judge(whole.storage, SMALL_LAYOUT, 20);

    const split = openBucket();
    await split.writer.commit(log);
    let floor = 0;
    for (let tick = 0; floor < 20; tick++) {
      expect(tick).toBeLessThan(40);
      const outcome = await fold(split, SMALL, { budget: 120 });
      expect(outcome.kind).toBe("published");
      if (outcome.kind === "published") {
        expect(outcome.foldEnd).toBeGreaterThan(floor);
        floor = outcome.foldEnd;
        await judge(split.storage, SMALL_LAYOUT, floor);
      }
    }
    expect(shapeDigest((await judge(split.storage, SMALL_LAYOUT, 20)) as never)).toBe(
      shapeDigest(one as never),
    );
  });
});

describe("contiguous prefix", () => {
  test("past the tail hint, the first missing slot is the tail: the fold stops there", async () => {
    const b = openBucket();
    await b.writer.commit(changes(10));
    await b.bucket.delete(logObjectKey(PREFIX, 5));
    expectPublished(await fold(b, SMALL), 5);
    await judge(b.storage, SMALL_LAYOUT, 5);
    // Nothing past the gap is reachable until the slot is filled.
    await expect(fold(b, SMALL)).resolves.toEqual({ kind: "nothing-to-fold", floor: 5 });
  });

  test("below the tail hint, a missing slot is Internal and nothing is written", async () => {
    const b = openBucket();
    await b.writer.commit(changes(10));
    await b.bucket.delete(logObjectKey(PREFIX, 5));
    const before = b.counted.calls.put;
    await expect(fold(b, SMALL, { knownTail: 10 })).rejects.toMatchObject({ code: "Internal" });
    expect(b.counted.calls.put).toBe(before);
  });

  fcTest.prop(
    {
      count: fc.integer({ min: 1, max: 14 }),
      hole: fc.integer({ min: 0, max: 13 }),
      budget: fc.integer({ min: 30, max: 400 }),
    },
    { numRuns: 15 },
  )("the fold end never passes a missing slot", async ({ count, hole, budget }) => {
    const b = openBucket();
    await b.writer.commit(changes(count));
    const gap = Math.min(hole, count - 1);
    await b.bucket.delete(logObjectKey(PREFIX, gap));
    const outcome = await fold(b, SMALL, { budget });
    if (outcome.kind === "published") {
      expect(outcome.foldEnd).toBeLessThanOrEqual(gap);
      await judge(b.storage, SMALL_LAYOUT, outcome.foldEnd);
    } else {
      expect(["nothing-to-fold", "refused"]).toContain(outcome.kind);
    }
  });
});

describe("depth-0 limit", () => {
  const FREE = { maxBytes: TREE_LAYOUT.singleLeafMaxBytes, maxRows: TREE_LAYOUT.singleLeafMaxRows };

  test("a fold that would publish a root above level 0 is refused", async () => {
    // The small layout has no depth-0 rule: 20 rows are a depth-2 tree.
    const b = openBucket();
    await b.writer.commit(changes(20));
    const outcome = await fold(b, SMALL, { depthZero: FREE });
    expect(outcome).toMatchObject({
      kind: "refused",
      floor: 0,
      stop: { reason: "deferred", gate: "rebuild", seq: 0 },
    });
    await expect(readTreeHead(b.storage, PREFIX)).resolves.toMatchObject({ root: null });
  });

  test("the row ceiling ends the fold before the row past it", async () => {
    const b = openBucket();
    await b.writer.commit(Array.from({ length: 6 }, (_, i) => row(`r${i}`, i)));
    const outcome = await fold(b, PRODUCTION, { depthZero: { ...FREE, maxRows: 4 } });
    expect(outcome).toMatchObject({
      kind: "published",
      foldEnd: 4,
      stop: { reason: "deferred", gate: "rebuild", dimension: "rows", seq: 4, rows: 5 },
    });
    await judge(b.storage, TREE_LAYOUT, 4);
    // The insert at the floor keeps it there, as the compactor's row ceiling does.
    await expect(
      fold(b, PRODUCTION, { depthZero: { ...FREE, maxRows: 4 } }),
    ).resolves.toMatchObject({
      kind: "refused",
      floor: 4,
      stop: { reason: "deferred", gate: "rebuild", dimension: "rows", seq: 4 },
    });
  });

  test("updates and deletes still fold at the row ceiling", async () => {
    const b = openBucket();
    await b.writer.commit(Array.from({ length: 4 }, (_, i) => row(`r${i}`, i)));
    expectPublished(await fold(b, PRODUCTION, { depthZero: { ...FREE, maxRows: 4 } }), 4);
    await b.writer.commit([row("r1", 9), { id: "r0", value: null }, row("r5", 5)]);
    const outcome = await fold(b, PRODUCTION, { depthZero: { ...FREE, maxRows: 4 } });
    expect(outcome).toMatchObject({ kind: "published", foldEnd: 7 });
    expect(outcome.kind === "published" && outcome.stop).toBeFalsy();
    await judge(b.storage, TREE_LAYOUT, 7);
  });

  test("the byte ceiling counts document bytes", async () => {
    const b = openBucket();
    await b.writer.commit([row("a", 1, "x".repeat(100)), row("b", 2, "x".repeat(100))]);
    const outcome = await fold(b, PRODUCTION, { depthZero: { ...FREE, maxBytes: 150 } });
    expect(outcome).toMatchObject({
      kind: "published",
      foldEnd: 1,
      stop: { reason: "deferred", dimension: "bytes", seq: 1 },
    });
  });

  test("the byte ceiling folds the longest prefix whose end state fits", async () => {
    const limit = { depthZero: { ...FREE, maxBytes: 150 } };
    const b = openBucket();
    await b.writer.commit([
      row("a", 1, "x".repeat(100)),
      row("b", 2, "x".repeat(100)),
      { id: "a", value: null },
    ]);
    const outcome = await fold(b, PRODUCTION, limit);
    expect(outcome).toMatchObject({ kind: "published", foldEnd: 3 });
    expect(outcome.kind === "published" && outcome.stop).toBeFalsy();
    await judge(b.storage, TREE_LAYOUT, 3);
  });

  test("an entry past the byte ceiling holds the floor until a later delete brings it back", async () => {
    const limit = { depthZero: { ...FREE, maxBytes: 150 } };
    const b = openBucket();
    await b.writer.commit([row("a", 1, "x".repeat(100)), row("b", 2, "x".repeat(100))]);
    await expect(fold(b, PRODUCTION, limit)).resolves.toMatchObject({
      kind: "published",
      foldEnd: 1,
    });
    await expect(fold(b, PRODUCTION, limit)).resolves.toMatchObject({
      kind: "refused",
      floor: 1,
      stop: { reason: "deferred", gate: "rebuild", dimension: "bytes", seq: 1 },
    });
    await b.writer.commit([{ id: "a", value: null }, row("c", 3)]);
    expectPublished(await fold(b, PRODUCTION, limit), 4);
    await judge(b.storage, TREE_LAYOUT, 4);
  });

  test("the byte ceiling counts the captured leaf's bytes", async () => {
    const limit = { depthZero: { ...FREE, maxBytes: 150 } };
    const b = openBucket();
    await b.writer.commit([row("a", 1, "x".repeat(100))]);
    expectPublished(await fold(b, PRODUCTION, limit), 1);
    await b.writer.commit([row("b", 2, "x".repeat(100))]);
    await expect(fold(b, PRODUCTION, limit)).resolves.toMatchObject({
      kind: "refused",
      floor: 1,
      stop: { reason: "deferred", gate: "rebuild", dimension: "bytes", seq: 1 },
    });
  });

  fcTest.prop(
    {
      maxBytes: fc.integer({ min: 40, max: 600 }),
      maxRows: fc.integer({ min: 1, max: 6 }),
      ticks: fc.array(
        fc.array(
          fc.record({
            id: fc.constantFrom("a", "b", "c", "d", "e", "f"),
            del: fc.boolean(),
            pad: fc.integer({ min: 0, max: 150 }),
          }),
          { maxLength: 6 },
        ),
        { minLength: 1, maxLength: 5 },
      ),
    },
    { numRuns: 60 },
  )(
    "the fold end is the compactor's: rows stop at the ceiling, bytes take the longest fitting prefix",
    async ({ maxBytes, maxRows, ticks }) => {
      const limit = { depthZero: { maxBytes, maxRows } };
      const b = openBucket();
      let n = 0;
      let floor = 0;
      for (const writes of ticks) {
        await b.writer.commit(
          writes.map(({ id, del, pad }) =>
            del ? { id, value: null } : row(id, n++, "x".repeat(pad)),
          ),
        );
        const entries = await logEntries(b.storage);
        // Replay the folded prefix, then walk the window as the compactor does.
        const rows = new Map<string, number>();
        const apply = (entry: LogEntry): void => {
          if (entry.op === "D") {
            rows.delete(entry.doc_id);
          } else {
            rows.set(entry.doc_id, encodeJsonBytes(entry.after).byteLength);
          }
        };
        entries.slice(0, floor).forEach(apply);
        let expected = floor;
        for (const [i, entry] of entries.slice(floor).entries()) {
          if (entry.op !== "D" && !rows.has(entry.doc_id) && rows.size >= maxRows) {
            break;
          }
          apply(entry);
          if ([...rows.values()].reduce((sum, bytes) => sum + bytes, 0) <= maxBytes) {
            expected = floor + i + 1;
          }
        }
        const outcome = await fold(b, PRODUCTION, limit);
        if (expected === floor) {
          expect(outcome.kind).not.toBe("published");
        } else {
          expect(outcome).toMatchObject({ kind: "published", foldEnd: expected });
          floor = expected;
        }
        await judge(b.storage, TREE_LAYOUT, floor);
      }
    },
  );

  test("a captured tree past the limit folds nothing", async () => {
    const b = openBucket();
    await b.writer.commit(Array.from({ length: 6 }, (_, i) => row(`r${i}`, i)));
    expectPublished(await fold(b, PRODUCTION), 6);
    await b.writer.commit([row("r7", 7)]);
    const outcome = await fold(b, PRODUCTION, { depthZero: { ...FREE, maxRows: 4 } });
    expect(outcome).toMatchObject({
      kind: "refused",
      floor: 6,
      stop: { reason: "deferred", gate: "pre-fold", dimension: "rows", rows: 6 },
    });
  });
});

describe("invalid survivors and the look-ahead fallback", () => {
  /**
   * `a`, `b`, then an invalid post-image for `c` at seq 2, `d`, `e`, then
   * a valid `c` at seq 5 that supersedes it, then `f`.
   */
  const superseded = async (b: Bucket): Promise<void> => {
    await b.writer.commit([row("a", 1), row("b", 2)]);
    await b.writer.appendRaw({ op: "I", doc_id: "c", after: { _id: "x", n: 3 } });
    await b.writer.commit([row("d", 4), row("e", 5), row("c", 6), row("f", 7)]);
  };

  test("an invalid entry superseded within the tick is folded past", async () => {
    const b = openBucket();
    await superseded(b);
    const outcome = await fold(b, SMALL);
    expect(outcome).toMatchObject({ kind: "published", foldEnd: 7 });
    expect(outcome.kind === "published" && outcome.stop).toBeFalsy();
    await judge(b.storage, SMALL_LAYOUT, 7);
  });

  test("an invalid entry never superseded: the valid prefix publishes, then InvalidResponse", async () => {
    const b = openBucket();
    await b.writer.commit([row("a", 1), row("b", 2)]);
    await b.writer.appendRaw({
      op: "U",
      doc_id: "c",
      after: { _id: "c", n: null } as unknown as DocumentData,
    });
    await b.writer.commit([row("d", 4)]);
    const outcome = await fold(b, SMALL);
    expect(outcome).toMatchObject({
      kind: "published",
      foldEnd: 2,
      stop: { reason: "invalid-entry", seq: 2, error: { code: "InvalidResponse" } },
    });
    await judge(b.storage, SMALL_LAYOUT, 2);
    // At the floor, it refuses and keeps the floor.
    await expect(fold(b, SMALL)).resolves.toMatchObject({
      kind: "refused",
      floor: 2,
      stop: { reason: "invalid-entry", seq: 2, error: { code: "InvalidResponse" } },
    });
  });

  test("every budget publishes the prefix before the invalid entry or folds past its repair, within the budget", async () => {
    const seen = new Set<string>();
    for (let budget = 10; budget <= 220; budget += 3) {
      const b = openBucket();
      await superseded(b);
      const callsBefore = b.counted.calls.get + b.counted.calls.put + b.counted.calls.delete;
      const outcome = await fold(b, SMALL, { budget });
      const calls =
        b.counted.calls.get + b.counted.calls.put + b.counted.calls.delete - callsBefore;
      expect(calls, `budget ${budget}`).toBeLessThanOrEqual(budget);
      if (outcome.kind === "published") {
        const end = outcome.foldEnd;
        expect(end <= 2 || end >= 6, `budget ${budget} folded to ${end}`).toBe(true);
        if (outcome.stop?.reason === "invalid-entry") {
          // The fallback: the budget ran out before the repair at seq 5.
          expect(outcome).toMatchObject({ foldEnd: 2, stop: { seq: 2 } });
          seen.add("fallback");
        } else if (end >= 6) {
          seen.add("past");
        }
        await judge(b.storage, SMALL_LAYOUT, end);
      }
    }
    expect([...seen].toSorted()).toEqual(["fallback", "past"]);
  });

  test.each([
    [
      "an _id that breaks the key-segment rule",
      { op: "I", doc_id: "_bad", after: { _id: "_bad" } },
    ],
    ["an unpaired surrogate", { op: "I", doc_id: "a\ud800", after: { _id: "a\ud800" } }],
    ["a post-image with another _id", { op: "U", doc_id: "c", after: { _id: "d" } }],
    [
      "a post-image that is not stored data",
      { op: "U", doc_id: "c", after: { _id: "c", v: null } },
    ],
  ])("%s at the floor is refused with InvalidResponse naming the seq", async (_, fields) => {
    const b = openBucket();
    await b.writer.appendRaw(fields as Partial<LogEntry>);
    const outcome = await fold(b, SMALL);
    expect(outcome).toMatchObject({
      kind: "refused",
      floor: 0,
      stop: { reason: "invalid-entry", seq: 0, error: { code: "InvalidResponse" } },
    });
    if (outcome.kind === "refused" && outcome.stop.reason === "invalid-entry") {
      expect(outcome.stop.error.message).toContain("seq 0");
      expect(outcome.stop.error.message).toContain(JSON.stringify(fields.doc_id));
    }
  });

  /** The bucket's tree holds exactly `rows`, at `floor`. */
  const expectRows = async (b: Bucket, rows: DocumentData[], floor: number): Promise<void> => {
    const report = checkTreeImage({
      image: await captureTreeImage(b.storage, PREFIX),
      prefix: PREFIX,
      layout: SMALL_LAYOUT,
      expectedRows: rows,
      expectedFloor: floor,
    });
    expect(report.violations).toEqual([]);
  };

  test("a non-string doc_id is its own row: the string of it does not supersede it", async () => {
    const b = openBucket();
    await b.writer.commit([row("a", 1)]);
    await b.writer.appendRaw({ op: "I", doc_id: 5 as unknown as string, after: { _id: 5 } });
    await b.writer.commit([row("5", 2)]);
    await expect(fold(b, SMALL)).resolves.toMatchObject({
      kind: "published",
      foldEnd: 1,
      stop: { reason: "invalid-entry", seq: 1 },
    });
  });

  test("a delete of a non-string doc_id supersedes its invalid insert and deletes no string row", async () => {
    const b = openBucket();
    await b.writer.commit([row("5", 1)]);
    await b.writer.appendRaw({ op: "I", doc_id: 5 as unknown as string, after: { _id: 5 } });
    await b.writer.appendRaw({ op: "D", doc_id: 5 as unknown as string });
    await b.writer.commit([row("a", 2)]);
    const outcome = await fold(b, SMALL);
    expect(outcome).toMatchObject({ kind: "published", foldEnd: 4 });
    expect(outcome.kind === "published" && outcome.stop).toBeFalsy();
    await expectRows(
      b,
      [
        { _id: "5", n: 1 },
        { _id: "a", n: 2 },
      ],
      4,
    );
  });

  test("a delete supersedes an invalid insert under an _id outside the domain", async () => {
    const b = openBucket();
    await b.writer.appendRaw({ op: "I", doc_id: "a\ud800", after: { _id: "a\ud800" } });
    await b.writer.appendRaw({ op: "D", doc_id: "a\ud800" });
    await b.writer.commit([row("z", 1)]);
    expectPublished(await fold(b, SMALL), 3);
    await judge(b.storage, SMALL_LAYOUT, 3);
  });

  test("entries the read path skips are folded past as no-ops", async () => {
    const b = openBucket();
    await b.writer.commit([row("a", 1)]);
    await b.writer.appendRaw({ op: "I", collection: "other", doc_id: "q", after: { _id: "q" } });
    await b.writer.commit([row("b", 2)]);
    expectPublished(await fold(b, SMALL), 3);
    await judge(b.storage, SMALL_LAYOUT, 3);
  });

  test("an I or U without a post-image is skipped, as the read path skips it", async () => {
    // The logical oracle refuses such an entry, so this judges against the read path alone.
    const b = openBucket();
    await b.writer.commit([row("a", 1)]);
    await b.writer.appendRaw({ op: "U", doc_id: "a" });
    await b.writer.commit([row("b", 2)]);
    expectPublished(await fold(b, SMALL), 3);
    const readPath = new Map<string, DocumentData>();
    foldLogEntriesOnto(readPath, await logEntries(b.storage), { collection: COLLECTION });
    const report = checkTreeImage({
      image: await captureTreeImage(b.storage, PREFIX),
      prefix: PREFIX,
      layout: SMALL_LAYOUT,
      expectedRows: readPath.values(),
      expectedFloor: 3,
    });
    expect(report.violations).toEqual([]);
  });
});

describe("head changed under the fold", () => {
  test("reports cas-lost, deletes nothing, and a re-run folds correctly", async () => {
    const b = openBucket();
    await b.writer.commit(changes(8));
    expectPublished(await fold(b, SMALL), 8);
    await b.writer.commit(changes(13).slice(8));
    const prepared = await prepareTreeFold({
      storage: b.storage,
      prefix: PREFIX,
      config: SMALL,
    });
    expect(prepared.kind).toBe("prepared");
    // A tail-hint refresh lands between the capture and the CAS.
    await casUpdateCurrentJson(b.storage, treeHeadKey(PREFIX), (head) => ({
      ...head,
      tail_hint: 13,
    }));
    const deletes = b.counted.calls.delete;
    const lost = prepared.kind === "prepared" ? await prepared.publish() : undefined;
    expect(lost).toMatchObject({ kind: "cas-lost", floor: 8, foldEnd: 13 });
    expect(b.counted.calls.delete).toBe(deletes);
    await judge(b.storage, SMALL_LAYOUT, 8);

    expectPublished(await fold(b, SMALL), 13);
    expect(b.counted.calls.delete).toBe(deletes);
    await judge(b.storage, SMALL_LAYOUT, 13);
  });
});

describe("stuck entry", () => {
  test("an entry no fresh tick can fold is refused, keeps the floor and warns once, counted", async () => {
    const b = openBucket();
    await b.writer.commit(changes(20));
    expectPublished(await fold(b, SMALL), 20);
    await b.writer.commit([row("k05", 99)]);
    const warnings: { event: string; properties: Readonly<Record<string, unknown>> }[] = [];
    const recorder = new RequestScopedMetricsRecorder();
    const ctx = createObservabilityContext({
      recorder,
      maintenance: { warn: (event, properties) => warnings.push({ event, properties }) },
    });
    // The head, root and log GETs fit, the leaf path does not.
    const outcome = await runWithContext(ctx, () => fold(b, SMALL, { budget: 15 }));
    expect(outcome).toMatchObject({
      kind: "refused",
      floor: 20,
      stop: { reason: "stuck-entry", seq: 20 },
    });
    expect(warnings).toMatchObject([{ event: "fold_stuck_entry", properties: { seq: 20 } }]);
    const total = recorder
      .snapshot()
      .counters.filter((c) => c.name === "db.compact.stuck_entry_total")
      .reduce((sum, c) => sum + c.value, 0);
    expect(total).toBe(1);
    await judge(b.storage, SMALL_LAYOUT, 20);
  });

  test("a budget that cannot read the first entry folds nothing and does not warn", async () => {
    const b = openBucket();
    await b.writer.commit(changes(3));
    await expect(fold(b, SMALL, { budget: 4 })).resolves.toMatchObject({
      kind: "refused",
      stop: { reason: "budget", seq: 0 },
    });
  });
});

describe("fresh head", () => {
  test("the first fold mints the chunk salt and publishes it", async () => {
    const b = openBucket();
    await b.writer.commit(changes(5));
    const outcome = await foldTree({ storage: b.storage, prefix: PREFIX, config: SMALL });
    expectPublished(outcome, 5);
    const head = await readTreeHead(b.storage, PREFIX);
    expect(head?.json.proto_tree?.chunk_salt).toMatch(/^[0-9a-f]{32}$/);
    await judge(b.storage, SMALL_LAYOUT, 5);
  });

  test("no head is nothing to fold", async () => {
    await expect(fold(openBucket(), SMALL)).resolves.toEqual({ kind: "nothing-to-fold", floor: 0 });
  });
});

fcTest.prop(
  {
    ticks: fc.array(
      fc.record({
        writes: fc.array(
          fc.record({ id: fc.constantFrom("a", "b", "c", "d", "e", "f", "g"), del: fc.boolean() }),
          { minLength: 0, maxLength: 6 },
        ),
        budget: fc.option(fc.integer({ min: 20, max: 300 }), { nil: undefined }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  },
  { numRuns: 25 },
)("any sequence of commits and budgeted ticks leaves a canonical tree", async ({ ticks }) => {
  const b = openBucket();
  let n = 0;
  let floor = 0;
  for (const { writes, budget } of ticks) {
    await b.writer.commit(writes.map(({ id, del }) => (del ? { id, value: null } : row(id, n++))));
    const outcome = await fold(b, SMALL, budget === undefined ? {} : { budget });
    if (outcome.kind === "published") {
      expect(outcome.foldEnd).toBeGreaterThan(floor);
      floor = outcome.foldEnd;
    } else {
      expect(outcome.kind).not.toBe("cas-lost");
    }
    await judge(b.storage, SMALL_LAYOUT, floor);
  }
});
