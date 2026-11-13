/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the fixtures seed doc bodies with it. */

/**
 * Regression fixtures for staged read admission (main-2): a host refuses a
 * read whose actual staged work falls outside its resource envelope, refuses
 * it whole with the capacity code, and serves every in-envelope read with
 * the same answer on every host (P1).
 *
 * Each target runs over a {@link Scenario}: build it, assert its
 * precondition, read under an envelope that tightens exactly one bound,
 * assert the refusal. Every scenario also has a precondition test of its
 * own, so a fixture that stops tripping its bound goes red on its own
 * line. Envelope values are test scaffolding, not shipped limits.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaerlyError,
  casUpdateCurrentJson,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
  readCurrentJson,
  RequestLedger,
  retryStorageCall,
  type Storage,
  type StorageListEntry,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Db } from "@baerly/server";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { afterEach, describe, expect, test, vi } from "vitest";
import { compact } from "../../packages/server/src/compactor.ts";
import { encodeIndexValue } from "../../packages/server/src/indexes.ts";
import { type CountingStorage, wrapCountingStorage } from "../fixtures/counting-storage.ts";
import { logStateCurrentJson } from "../fixtures/log-state.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const APP = "app";
const TENANT = "tenant";
const COLL = "items";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const HEAD_KEY = `${PREFIX}/current.json`;
const INDEXES = [{ name: "by_tag", on: "tag" }] as const;

/** Seeded rows carry `_id`, a numeric `n`, and optionally `tag` / `pad`. */
type Item = DocumentData;

// ── Test envelope ───────────────────────────────────────────────────────

/**
 * A host's read envelope, one field per bound main-2 Task 3 names. Local to
 * this file: these numbers only size the fixtures around them.
 * `maxStorageCalls` becomes the request ledger's limit; the rest become the
 * kernel's `ReadEnvelope`.
 */
interface TestEnvelope {
  readonly maxSnapshotBytes: number;
  readonly maxSnapshotRows: number;
  /** Live log entries past `log_seq_start` the read must load. */
  readonly maxTailEntries: number;
  readonly maxTailBytes: number;
  /** Rows decoded into memory (snapshot rows + tail entries) before predicate, sort and limit. */
  readonly maxMaterializedRows: number;
  /** Rows in the answer. */
  readonly maxOutputRows: number;
  /** Storage requests actually issued, retries included. */
  readonly maxStorageCalls: number;
}

type Bound = keyof TestEnvelope;

const SMALL_ENVELOPE: TestEnvelope = {
  maxSnapshotBytes: 64 * 1024,
  maxSnapshotRows: 64,
  maxTailEntries: 16,
  maxTailBytes: 32 * 1024,
  maxMaterializedRows: 64,
  maxOutputRows: 32,
  maxStorageCalls: 40,
};

const LARGE_ENVELOPE: TestEnvelope = {
  maxSnapshotBytes: Number.MAX_SAFE_INTEGER,
  maxSnapshotRows: Number.MAX_SAFE_INTEGER,
  maxTailEntries: Number.MAX_SAFE_INTEGER,
  maxTailBytes: Number.MAX_SAFE_INTEGER,
  maxMaterializedRows: Number.MAX_SAFE_INTEGER,
  maxOutputRows: Number.MAX_SAFE_INTEGER,
  maxStorageCalls: Number.MAX_SAFE_INTEGER,
};

const BOUNDS: readonly Bound[] = [
  "maxSnapshotBytes",
  "maxSnapshotRows",
  "maxTailEntries",
  "maxTailBytes",
  "maxMaterializedRows",
  "maxOutputRows",
  "maxStorageCalls",
];

/** The large host with one bound tightened, so a refusal can come from that bound alone. */
const tighten = (bound: Bound, limit: number = SMALL_ENVELOPE[bound]): TestEnvelope => ({
  ...LARGE_ENVELOPE,
  [bound]: limit,
});

type Usage = Record<Bound, number>;

const exceededBounds = (envelope: TestEnvelope, usage: Usage): Bound[] =>
  BOUNDS.filter((bound) => usage[bound] > envelope[bound]);

type ReadOutcome<T> =
  | { readonly kind: "served"; readonly value: T }
  | { readonly kind: "refused"; readonly error: unknown };

/**
 * Run `read` as a host with `envelope`, the way an adapter runs a request:
 * inside an observability context carrying the host's request ledger
 * (`maxStorageCalls`, charged per issued attempt by `retryStorageCall`)
 * and read envelope (every other bound).
 */
const readUnder = async <T>(
  envelope: TestEnvelope,
  read: () => Promise<T>,
): Promise<ReadOutcome<T>> => {
  const { maxStorageCalls, ...readEnvelope } = envelope;
  const ctx = createObservabilityContext({
    ledger: new RequestLedger({ internal: maxStorageCalls, external: maxStorageCalls }),
    // The adapter stack charges retryStorageCall's default pool.
    readEnvelope: { ...readEnvelope, requestPool: "external" },
  });
  try {
    return { kind: "served", value: await runWithContext(ctx, read) };
  } catch (error) {
    return { kind: "refused", error };
  }
};

/** The capacity code (main-7). */
const isCapacityRefusal = (err: unknown): boolean =>
  (err as { code?: unknown }).code === "CapacityExceeded";

/**
 * The mechanism that refused: an admission check's `cause.bound`
 * (`ReadRefusalBound`), or `"ledger"` for the request ledger refusing a
 * call at issue (`cause.refused`).
 */
type RefusedBy =
  | "snapshotBytes"
  | "snapshotRows"
  | "tailEntries"
  | "tailBytes"
  | "materializedRows"
  | "outputRows"
  | "headStorageCalls"
  | "probeStorageCalls"
  | "ledger";

const refusedBy = (err: unknown): string => {
  const cause = (err as { cause?: { bound?: unknown; refused?: unknown } }).cause;
  if (typeof cause?.bound === "string") {
    return cause.bound;
  }
  return cause?.refused === true ? "ledger" : "unknown";
};

/**
 * The target outcome of every out-of-envelope read: no rows at all (a
 * truncated answer is a served outcome, so it fails here), the capacity
 * code (which rules out the backpressure code: a read cannot advance
 * maintenance), not retriable, and refused by the expected mechanism.
 */
const expectWholeCapacityRefusal = (outcome: ReadOutcome<unknown>, by: RefusedBy): void => {
  expect(outcome.kind, "an out-of-envelope read must refuse whole, never serve").toBe("refused");
  if (outcome.kind !== "refused") {
    return;
  }
  expect(isCapacityRefusal(outcome.error), `refused with ${String(outcome.error)}`).toBe(true);
  expect((outcome.error as { retriable?: unknown }).retriable).toBe(false);
  expect(refusedBy(outcome.error), `refused with ${String(outcome.error)}`).toBe(by);
};

// ── Measured staged work ────────────────────────────────────────────────

/** What a full-scan read of the current layout has to load. */
interface StagedWork {
  readonly snapshotBytes: number;
  readonly snapshotRows: number;
  readonly tailEntries: number;
  readonly tailBytes: number;
}

/** Read the bucket directly (not through a read path) to size the work. */
const measureStagedWork = async (storage: Storage): Promise<StagedWork> => {
  const head = await readCurrentJson(storage, HEAD_KEY);
  expect(head, "fixture must provision the collection").not.toBeNull();
  const start = head!.json.log_seq_start;
  let tailEntries = 0;
  let tailBytes = 0;
  for await (const entry of storage.list(`${PREFIX}/log/`)) {
    const seq = Number(/\/log\/(\d+)\.json$/.exec(entry.key)?.[1] ?? Number.NaN);
    if (Number.isInteger(seq) && seq >= start) {
      const got = await storage.get(entry.key);
      tailEntries += 1;
      tailBytes += got?.body.byteLength ?? 0;
    }
  }
  return {
    snapshotBytes: head!.json.snapshot_bytes,
    snapshotRows: head!.json.snapshot_rows,
    tailEntries,
    tailBytes,
  };
};

const isSnapshotKey = (key: string): boolean => key.includes("/snapshot/");

// ── Storage stacks ──────────────────────────────────────────────────────

/**
 * What one read runs through. `kernel` counts the calls the kernel makes;
 * `issued` counts the requests that reach the bucket (equal unless an
 * adapter retries or pages underneath); `getKeys` lists every bucket GET.
 */
interface ReadStack {
  readonly storage: Storage;
  readonly kernel: CountingStorage;
  readonly issued: CountingStorage;
  readonly getKeys: readonly string[];
}

interface Recorded {
  readonly storage: Storage;
  readonly keys: string[];
}

const recordReads = (inner: Storage): Recorded => {
  const keys: string[] = [];
  return {
    keys,
    storage: {
      get: (key, opts) => {
        keys.push(key);
        return inner.get(key, opts);
      },
      put: (key, body, opts) => inner.put(key, body, opts),
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    },
  };
};

const plainStack = (base: Storage): ReadStack => {
  const recorded = recordReads(base);
  const counting = wrapCountingStorage(recorded.storage);
  return {
    storage: counting.storage,
    kernel: counting,
    issued: counting,
    getKeys: recorded.keys,
  };
};

/**
 * Adapter-shaped stack, standing in for an S3/R2 adapter: every request
 * runs under the shared `retryStorageCall` policy, and LIST is paged
 * `pageKeys` at a time with one request per page. `failAttempts(key)`
 * failed attempts precede the first successful GET of a matching key,
 * fresh per stack, so two stacks with the same options issue the same
 * requests for the same read.
 *
 * The `retryStorageCall` attempt below is the charge point: the request
 * ledger charges every issued call where it is issued (each retry attempt,
 * each LIST page), not at the kernel's `Storage` call.
 */
const adapterStack = (
  base: Storage,
  opts: { readonly pageKeys: number; readonly failAttempts: (key: string) => number },
): ReadStack => {
  const recorded = recordReads(base);
  const issued = wrapCountingStorage(recorded.storage);
  const failuresLeft = new Map<string, number>();
  const retry = <T>(fn: () => Promise<T>): Promise<T> =>
    retryStorageCall(fn, { sleep: async () => {}, random: () => 0 });
  const shaped: Storage = {
    get: (key, getOpts) =>
      retry(async () => {
        const left = failuresLeft.get(key) ?? opts.failAttempts(key);
        failuresLeft.set(key, Math.max(0, left - 1));
        // A failed attempt still reaches the bucket, so it is issued.
        const got = await issued.storage.get(key, getOpts);
        if (left > 0) {
          throw new BaerlyError("NetworkError", "injected transient GET failure");
        }
        return got;
      }),
    put: (key, body, putOpts) => retry(() => issued.storage.put(key, body, putOpts)),
    delete: (key, delOpts) => retry(() => issued.storage.delete(key, delOpts)),
    list: async function* (prefix, listOpts) {
      let startAfter = listOpts?.startAfter;
      for (;;) {
        const after = startAfter;
        const page = await retry(async () => {
          const out: StorageListEntry[] = [];
          const pageOpts = {
            maxKeys: opts.pageKeys,
            ...(after === undefined ? {} : { startAfter: after }),
          };
          for await (const entry of issued.storage.list(prefix, pageOpts)) {
            out.push(entry);
          }
          return out;
        });
        yield* page;
        if (page.length < opts.pageKeys) {
          return;
        }
        startAfter = page.at(-1)!.key;
      }
    },
  };
  const kernel = wrapCountingStorage(shaped);
  return {
    storage: kernel.storage,
    kernel,
    issued,
    getKeys: recorded.keys,
  };
};

const callsOf = (counting: CountingStorage): number => counting.gets + counting.lists;

// ── Seeding ─────────────────────────────────────────────────────────────

interface Variant {
  readonly label: "memory" | "local-fs";
  readonly make: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

const VARIANTS: readonly Variant[] = [
  { label: "memory", make: async () => ({ storage: new MemoryStorage() }) },
  {
    label: "local-fs",
    make: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-read-admission-"));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
];

const dbFor = (storage: Storage, indexed = false): Db =>
  Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    ...(indexed ? { config: { collections: { [COLL]: { indexes: [...INDEXES] } } } } : {}),
  });

const items = (db: Db) => db.collection(COLL);

/** Fold the whole live tail into a snapshot, as maintenance would. */
const foldAll = async (storage: Storage): Promise<void> => {
  const res = await compact({ storage, currentJsonKey: HEAD_KEY }, { minEntriesToCompact: 1 });
  expect(res.written, "fixture fold must land a snapshot").toBe(true);
};

const insertMany = async (db: Db, count: number, make: (i: number) => Item): Promise<Item[]> => {
  const docs: Item[] = [];
  for (let i = 0; i < count; i++) {
    const doc = make(i);
    await items(db).insert(doc);
    docs.push(doc);
  }
  return docs;
};

const idOf = (row: Item): string => String(row["_id"]);
const byId = (a: Item, b: Item): number => idOf(a).localeCompare(idOf(b));
const sortedById = (rows: readonly Item[]): Item[] => rows.toSorted(byId);
const pad2 = (i: number): string => String(i).padStart(2, "0");

/**
 * Drops index-marker DELETEs, as a crash between a commit and its
 * stale-marker cleanup would. Seeding through it leaves stale markers.
 */
const keepStaleMarkers = (inner: Storage): Storage => ({
  get: (key, opts) => inner.get(key, opts),
  put: (key, body, opts) => inner.put(key, body, opts),
  delete: async (key, opts) => {
    if (!key.includes("/index/")) {
      await inner.delete(key, opts);
    }
  },
  list: (prefix, opts) => inner.list(prefix, opts),
});

// ── Scenarios ───────────────────────────────────────────────────────────

type Fresh = () => Promise<Storage>;

/**
 * 36 docs inserted with `tag: "x"`, 34 then moved to `tag: "y"` while
 * marker DELETEs are dropped: the `x` prefix lists 36 markers, 2 live.
 */
const seedStaleMarkers = async (
  fresh: Fresh,
): Promise<{ storage: Storage; liveX: Item[]; xMarkers: number }> => {
  const storage = await fresh();
  const seeding = dbFor(keepStaleMarkers(storage), true);
  const docs = await insertMany(seeding, 36, (i) => ({ _id: `s-${pad2(i)}`, n: i, tag: "x" }));
  for (const doc of docs.slice(2)) {
    await items(seeding).update(idOf(doc), { tag: "y" });
  }
  await foldAll(storage);
  let xMarkers = 0;
  for await (const _entry of storage.list(`${PREFIX}/index/by_tag/${encodeIndexValue("x")}/`)) {
    xMarkers += 1;
  }
  return { storage, liveX: sortedById(docs.slice(0, 2)), xMarkers };
};

const readTagX = async (storage: Storage): Promise<Item[]> =>
  sortedById(await items(dbFor(storage, true)).where({ tag: "x" }).all());

interface Prepared {
  readonly base: Storage;
  /** A fresh stack per read, so injected faults and counters never leak between reads. */
  readonly stack: () => ReadStack;
  /** The read under test; returns a comparable value (rows sorted unless the query orders them). */
  readonly read: (storage: Storage) => Promise<unknown>;
  readonly expected: unknown;
}

interface Measured {
  readonly usage: Usage;
  readonly value: unknown;
  readonly stack: ReadStack;
}

/** Run the read once on a fresh stack and size every bound it touches. */
const measure = async (p: Prepared): Promise<Measured> => {
  const work = await measureStagedWork(p.base);
  const stack = p.stack();
  const value = await p.read(stack.storage);
  let outputRows = value === undefined ? 0 : 1;
  if (Array.isArray(value)) {
    outputRows = value.length;
  }
  return {
    value,
    stack,
    usage: {
      maxSnapshotBytes: work.snapshotBytes,
      maxSnapshotRows: work.snapshotRows,
      maxTailEntries: work.tailEntries,
      maxTailBytes: work.tailBytes,
      maxMaterializedRows: work.snapshotRows + work.tailEntries,
      maxOutputRows: outputRows,
      maxStorageCalls: callsOf(stack.issued),
    },
  };
};

interface Scenario {
  /** The one bound this fixture trips. */
  readonly bound: Bound;
  /** The mechanism that must refuse it. */
  readonly refusedBy: RefusedBy;
  readonly envelope: TestEnvelope;
  /** The neighbouring bound the fixture stays inside on SMALL_ENVELOPE (tiny vs oversized). */
  readonly contrast?: Bound;
  /** The head alone carries enough to refuse (main-2 Task 2): no snapshot GET allowed. */
  readonly headOnly?: boolean;
  readonly extraPrecondition?: (m: Measured, envelope: TestEnvelope) => void;
  readonly build: (fresh: Fresh) => Promise<Prepared>;
}

const fullScan = async (storage: Storage): Promise<Item[]> =>
  sortedById(await items(dbFor(storage)).all());

const plain = (base: Storage, read: Prepared["read"], expected: unknown): Prepared => ({
  base,
  stack: () => plainStack(base),
  read,
  expected,
});

const SCENARIOS = {
  /** 100 tiny folded rows: snapshot rows trip, snapshot bytes stay small. */
  tinySnapshot: {
    bound: "maxSnapshotRows",
    refusedBy: "snapshotRows",
    envelope: tighten("maxSnapshotRows"),
    contrast: "maxSnapshotBytes",
    headOnly: true,
    build: async (fresh) => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage), 100, (i) => ({ _id: `t-${i}`, n: i }));
      await foldAll(storage);
      return plain(storage, fullScan, sortedById(docs));
    },
  },
  /** 40 tiny live-tail entries: tail entries trip, tail bytes stay small. */
  tinyTail: {
    bound: "maxTailEntries",
    refusedBy: "tailEntries",
    envelope: tighten("maxTailEntries"),
    contrast: "maxTailBytes",
    build: async (fresh) => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage), 40, (i) => ({ _id: `t-${i}`, n: i }));
      return plain(storage, fullScan, sortedById(docs));
    },
  },
  /** 3 folded ~30 KiB rows: snapshot bytes trip, snapshot rows stay few. */
  oversizedSnapshot: {
    bound: "maxSnapshotBytes",
    refusedBy: "snapshotBytes",
    envelope: tighten("maxSnapshotBytes"),
    contrast: "maxSnapshotRows",
    headOnly: true,
    build: async (fresh) => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage), 3, (i) => ({
        _id: `big-${i}`,
        n: i,
        pad: "x".repeat(30 * 1024),
      }));
      await foldAll(storage);
      return plain(storage, fullScan, sortedById(docs));
    },
  },
  /** 2 live-tail ~24 KiB entries: tail bytes trip, tail entries stay few. */
  oversizedTail: {
    bound: "maxTailBytes",
    refusedBy: "tailBytes",
    envelope: tighten("maxTailBytes"),
    contrast: "maxTailEntries",
    build: async (fresh) => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage), 2, (i) => ({
        _id: `big-${i}`,
        n: i,
        pad: "x".repeat(24 * 1024),
      }));
      return plain(storage, fullScan, sortedById(docs));
    },
  },
  /** 48 folded rows read whole: the answer trips the output bound. */
  wideOutput: {
    bound: "maxOutputRows",
    refusedBy: "outputRows",
    envelope: tighten("maxOutputRows"),
    contrast: "maxMaterializedRows",
    build: async (fresh) => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage), 48, (i) => ({ _id: `w-${pad2(i)}`, n: i }));
      await foldAll(storage);
      return plain(storage, fullScan, sortedById(docs));
    },
  },
  /**
   * 60 folded + 12 tail rows read as a sorted `limit(5)`: the current layout
   * materializes all 72 to sort, so materialization trips while output is 5.
   */
  sortedLimit: {
    bound: "maxMaterializedRows",
    refusedBy: "materializedRows",
    envelope: tighten("maxMaterializedRows"),
    contrast: "maxOutputRows",
    build: async (fresh) => {
      const storage = await fresh();
      const db = dbFor(storage);
      const docs = await insertMany(db, 60, (i) => ({ _id: `m-${pad2(i)}`, n: i }));
      await foldAll(storage);
      docs.push(...(await insertMany(db, 12, (i) => ({ _id: `m-${60 + i}`, n: 60 + i }))));
      const expected = docs.toSorted((a, b) => Number(b["n"]) - Number(a["n"])).slice(0, 5);
      return plain(
        storage,
        (s) => items(dbFor(s)).where({}).order({ n: "desc" }).limit(5).all(),
        expected,
      );
    },
  },
  /**
   * 14 live-tail entries read through an adapter that fails every log GET
   * twice: the kernel makes few calls, the bucket sees three per log GET.
   */
  retriedGets: {
    bound: "maxStorageCalls",
    refusedBy: "ledger",
    envelope: tighten("maxStorageCalls"),
    extraPrecondition: (m, envelope) => {
      expect(callsOf(m.stack.kernel)).toBeLessThanOrEqual(envelope.maxStorageCalls);
    },
    build: async (fresh) => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage), 14, (i) => ({ _id: `r-${i}`, n: i }));
      return {
        base: storage,
        stack: () =>
          adapterStack(storage, {
            pageKeys: 1000,
            failAttempts: (key) => (key.includes("/log/") ? 2 : 0),
          }),
        read: fullScan,
        expected: sortedById(docs),
      };
    },
  },
  /**
   * 5 folded rows plus 40 live-tail entries with `tail_hint` stamped at the
   * tail, read through storage the ledger does not charge: the strict range
   * alone needs more calls than the ledger allows, so only the head check
   * can refuse it.
   */
  headStorageCalls: {
    bound: "maxStorageCalls",
    refusedBy: "headStorageCalls",
    envelope: tighten("maxStorageCalls", 20),
    headOnly: true,
    build: async (fresh) => {
      const storage = await fresh();
      const db = dbFor(storage);
      const docs = await insertMany(db, 5, (i) => ({ _id: `h-${pad2(i)}`, n: i }));
      await foldAll(storage);
      docs.push(...(await insertMany(db, 40, (i) => ({ _id: `h-${pad2(5 + i)}`, n: 5 + i }))));
      await casUpdateCurrentJson(storage, HEAD_KEY, (head) => ({
        ...head,
        tail_hint: head.log_seq_start + 40,
      }));
      return plain(storage, fullScan, sortedById(docs));
    },
  },
  /**
   * 30 live-tail entries with a stale `tail_hint`, read through storage the
   * ledger does not charge: the head fits, and only the forward-probe cap
   * sized from the ledger's remainder can refuse it.
   */
  probeStorageCalls: {
    bound: "maxStorageCalls",
    refusedBy: "probeStorageCalls",
    envelope: tighten("maxStorageCalls", 20),
    build: async (fresh) => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage), 30, (i) => ({ _id: `q-${pad2(i)}`, n: i }));
      return plain(storage, fullScan, sortedById(docs));
    },
  },
} satisfies Record<string, Scenario>;

type ScenarioName = keyof typeof SCENARIOS;
const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

/**
 * Holds today and after admission lands: the fixture trips exactly its one
 * bound, stays inside its contrast bound, and the large host serves the
 * expected answer, identically on a second read (P1).
 */
const expectPrecondition = async (s: Scenario, p: Prepared): Promise<void> => {
  const m = await measure(p);
  expect(m.value).toEqual(p.expected);
  expect(exceededBounds(s.envelope, m.usage), "fixture must trip exactly its one bound").toEqual([
    s.bound,
  ]);
  if (s.contrast !== undefined) {
    expect(m.usage[s.contrast]).toBeLessThanOrEqual(SMALL_ENVELOPE[s.contrast]);
  }
  if (s.headOnly === true) {
    expect(m.stack.getKeys.some(isSnapshotKey), "a served read GETs the snapshot").toBe(true);
  }
  s.extraPrecondition?.(m, s.envelope);
  const again = p.stack();
  await expect(readUnder(LARGE_ENVELOPE, () => p.read(again.storage))).resolves.toEqual({
    kind: "served",
    value: p.expected,
  });
};

/** Precondition, then the target: refused whole, pure, and head-only where the head suffices. */
const expectRefusal = async (s: Scenario, fresh: Fresh): Promise<void> => {
  const p = await s.build(fresh);
  await expectPrecondition(s, p);
  const stack = p.stack();
  expectWholeCapacityRefusal(await readUnder(s.envelope, () => p.read(stack.storage)), s.refusedBy);
  expect({ puts: stack.issued.puts, deletes: stack.issued.deletes }).toEqual({
    puts: 0,
    deletes: 0,
  });
  if (s.headOnly === true) {
    expect(stack.getKeys.filter(isSnapshotKey), "head-only rejection GETs no snapshot").toEqual([]);
  }
};

// ── Suites ──────────────────────────────────────────────────────────────

for (const variant of VARIANTS) {
  describe(`read admission [${variant.label}]`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) {
        await cleanup();
      }
    });

    const fresh: Fresh = async () => {
      const { storage, cleanup } = await variant.make();
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
      return storage;
    };

    test.each(SCENARIO_NAMES)("precondition: %s trips exactly its bound", async (name) => {
      const s: Scenario = SCENARIOS[name];
      await expectPrecondition(s, await s.build(fresh));
    });

    test("tiny documents in the snapshot: refused on snapshot rows from the head", () =>
      expectRefusal(SCENARIOS.tinySnapshot, fresh));

    test("tiny documents in the tail: refused on tail entries", () =>
      expectRefusal(SCENARIOS.tinyTail, fresh));

    test("oversized objects in the snapshot: refused on snapshot bytes from the head", () =>
      expectRefusal(SCENARIOS.oversizedSnapshot, fresh));

    test("oversized objects in the tail: refused on tail bytes", () =>
      expectRefusal(SCENARIOS.oversizedTail, fresh));

    test("output bound: an over-wide answer is refused whole, not truncated", () =>
      expectRefusal(SCENARIOS.wideOutput, fresh));

    test("materialization bound: a sorted limit(5) is refused on materialized rows", () =>
      expectRefusal(SCENARIOS.sortedLimit, fresh));

    test("retries: retried storage requests count toward the call bound", () =>
      expectRefusal(SCENARIOS.retriedGets, fresh));

    test("declared indexes issue no LIST pages, even through a small-page adapter", async () => {
      const storage = await fresh();
      const docs = await insertMany(dbFor(storage, true), 30, (i) => ({
        _id: `p-${pad2(i)}`,
        n: i,
        tag: "x",
      }));
      await foldAll(storage);
      const stack = adapterStack(storage, { pageKeys: 3, failAttempts: () => 0 });
      expect(sortedById(await items(dbFor(stack.storage, true)).where({ tag: "x" }).all())).toEqual(
        sortedById(docs),
      );
      expect(stack.kernel.lists).toBe(0);
      expect(stack.issued.lists).toBe(0);
    });

    test("stale markers consume no read work and do not change output", async () => {
      const { storage, liveX, xMarkers } = await seedStaleMarkers(fresh);
      const measured = await measure(plain(storage, readTagX, liveX));
      expect(measured.value).toEqual(liveX);
      expect(measured.stack.issued.lists).toBe(0);
      // More stale markers than the small host's tail bound still fit it.
      expect(xMarkers).toBeGreaterThan(SMALL_ENVELOPE.maxTailEntries);
      await expect(readUnder(SMALL_ENVELOPE, () => readTagX(storage))).resolves.toEqual({
        kind: "served",
        value: liveX,
      });
    });

    test("head: a strict range the ledger cannot fit is refused before the snapshot GET", () =>
      expectRefusal(SCENARIOS.headStorageCalls, fresh));

    test("forward probe: a tail past the ledger's remainder is refused at the probe cap", () =>
      expectRefusal(SCENARIOS.probeStorageCalls, fresh));

    // ── Same head, different tail ─────────────────────────────────────

    /**
     * Two buckets with byte-identical heads (same pinned bootstrap, same
     * 4-row fold) whose live tails differ: `short` carries 2 small updates,
     * `long` 24 ~2 KiB inserts. Writes run outside a maintenance context,
     * so no write tick moves either head after the fold.
     */
    const seedSameHeadDifferentTail = async (): Promise<{ short: Prepared; long: Prepared }> => {
      const short = await fresh();
      const long = await fresh();
      const base = (i: number): Item => ({ _id: `base-${i}`, n: i });
      for (const storage of [short, long]) {
        await createCurrentJson(storage, HEAD_KEY, logStateCurrentJson());
        await insertMany(dbFor(storage), 4, base);
        await foldAll(storage);
      }
      const baseRows = Array.from({ length: 4 }, (_, i) => base(i));
      await items(dbFor(short)).update("base-0", { n: 100 });
      await items(dbFor(short)).update("base-1", { n: 101 });
      const longTail = await insertMany(dbFor(long), 24, (i) => ({
        _id: `tail-${pad2(i)}`,
        n: 1000 + i,
        pad: "x".repeat(2048),
      }));
      const shortRows = sortedById([
        { _id: "base-0", n: 100 },
        { _id: "base-1", n: 101 },
        ...baseRows.slice(2),
      ]);
      return {
        short: plain(short, fullScan, shortRows),
        long: plain(long, fullScan, sortedById([...baseRows, ...longTail])),
      };
    };

    const SAME_HEAD_ENVELOPE = tighten("maxTailEntries");

    test("same-head fixture: identical heads, and only the long tail trips its bound", async () => {
      const { short, long } = await seedSameHeadDifferentTail();
      const shortHead = await readCurrentJson(short.base, HEAD_KEY);
      await expect(readCurrentJson(long.base, HEAD_KEY)).resolves.toEqual({
        json: shortHead!.json,
        etag: expect.any(String),
      });
      const shortRun = await measure(short);
      const longRun = await measure(long);
      expect(shortRun.value).toEqual(short.expected);
      expect(longRun.value).toEqual(long.expected);
      expect(shortRun.usage.maxTailEntries).toBe(2);
      expect(longRun.usage.maxTailEntries).toBe(24);
      expect(exceededBounds(SAME_HEAD_ENVELOPE, shortRun.usage)).toEqual([]);
      expect(exceededBounds(SAME_HEAD_ENVELOPE, longRun.usage)).toEqual(["maxTailEntries"]);
    });

    test("same head, different tail: admission decides from staged work", async () => {
      const { short, long } = await seedSameHeadDifferentTail();
      const shortHead = await readCurrentJson(short.base, HEAD_KEY);
      await expect(readCurrentJson(long.base, HEAD_KEY)).resolves.toEqual({
        json: shortHead!.json,
        etag: expect.any(String),
      });
      // A head-only rule treats both alike; only staged work separates them.
      const served = await readUnder(SAME_HEAD_ENVELOPE, () => short.read(short.stack().storage));
      expect(served).toEqual({ kind: "served", value: short.expected });

      expectWholeCapacityRefusal(
        await readUnder(SAME_HEAD_ENVELOPE, () => long.read(long.stack().storage)),
        "tailEntries",
      );
    });

    // ── Stale index markers ───────────────────────────────────────────
    //
    // An index-covered read takes membership from the fold, not from a
    // marker LIST, so stale markers cost it nothing: there is no
    // index-specific work bound (I1 is the full-fold bounds).

    test("stale index markers: index reads neither return stale rows nor over-count", async () => {
      const { storage, liveX, xMarkers } = await seedStaleMarkers(fresh);
      expect(xMarkers, "34 stale + 2 live `x` markers").toBe(36);

      const indexed = items(dbFor(storage, true));
      const unindexed = items(dbFor(storage, false));
      expect(sortedById(await indexed.where({ tag: "x" }).all())).toEqual(liveX);
      await expect(indexed.where({ tag: "x" }).count()).resolves.toBe(liveX.length);
      expect(sortedById(await indexed.where({ tag: "x" }).all())).toEqual(
        sortedById(await unindexed.where({ tag: "x" }).all()),
      );
    });

    test("stale index markers: the output bound counts returned rows, not markers", async () => {
      const { storage, liveX, xMarkers } = await seedStaleMarkers(fresh);
      const envelope = tighten("maxOutputRows");
      expect(xMarkers).toBeGreaterThan(envelope.maxOutputRows);
      expect(liveX.length).toBeLessThanOrEqual(envelope.maxOutputRows);
      await expect(readUnder(envelope, () => readTagX(storage))).resolves.toEqual({
        kind: "served",
        value: liveX,
      });
    });

    // ── P1: same answers on every host ────────────────────────────────

    test("P1: in-envelope answers are identical on a small and a large host", async () => {
      const storage = await fresh();
      await insertMany(dbFor(storage), 20, (i) => ({ _id: `w-${pad2(i)}`, n: i }));
      await foldAll(storage);
      const reads: ReadonlyArray<() => Promise<unknown>> = [
        () => items(dbFor(storage)).get("w-07"),
        () => items(dbFor(storage)).where({ n: 3 }).all(),
        () => items(dbFor(storage)).all(),
        () => items(dbFor(storage)).where({}).order({ n: "desc" }).limit(4).all(),
        () => items(dbFor(storage)).where({}).order({ n: "asc" }).limit(1).first(),
      ];
      for (const read of reads) {
        const small = await readUnder(SMALL_ENVELOPE, read);
        const large = await readUnder(LARGE_ENVELOPE, read);
        expect(small.kind).toBe("served");
        expect(small).toEqual(large);
      }
    });

    // ── Reads stay pure ───────────────────────────────────────────────

    test("reads are pure: served and would-be-refused reads issue no PUT or DELETE", async () => {
      const { short, long } = await seedSameHeadDifferentTail();
      const { storage: stale } = await seedStaleMarkers(fresh);
      const prepared: Prepared[] = [short, long];
      for (const name of SCENARIO_NAMES) {
        prepared.push(await SCENARIOS[name].build(fresh));
      }
      prepared.push(
        plain(stale, (s) => items(dbFor(s, true)).where({ tag: "x" }).count(), undefined),
      );
      for (const p of prepared) {
        const before = await readCurrentJson(p.base, HEAD_KEY);
        for (const envelope of [SMALL_ENVELOPE, LARGE_ENVELOPE]) {
          const stack = p.stack();
          await readUnder(envelope, () => p.read(stack.storage));
          expect({ puts: stack.issued.puts, deletes: stack.issued.deletes }).toEqual({
            puts: 0,
            deletes: 0,
          });
          expect(stack.issued.gets, "the read must have walked storage").toBeGreaterThan(0);
        }
        await expect(readCurrentJson(p.base, HEAD_KEY)).resolves.toEqual(before);
      }
    });
  });
}
