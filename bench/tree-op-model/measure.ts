/**
 * Counting-storage measurements of the prototype tree's fold tick and
 * reads (`packages/server/src/tree/{fold,read}.ts`), for the cross-check
 * of the static model in `./model.ts`
 * (`tests/unit/tree-op-model-crosscheck.test.ts`).
 *
 * Every tree is real: the canonical builder at the production layout
 * (16 KiB leaf target) builds it, `sealTree` encodes it, and the nodes
 * and the tree head go into `MemoryStorage`. Each measurement runs on a
 * fresh copy of that bucket, with its own unfolded log tail.
 *
 * **Storage stack.** `logical counter → adapter retry → attempt counter
 * → fault layer → MemoryStorage`. The logical counter sees each `Storage`
 * call once; the attempt counter sees every attempt the adapter retry
 * makes, which is what a host's request ledger charges. The retry is
 * `retryStorageCall` as the S3 and R2 adapters configure it (no backoff
 * sleep). In `"all-attempts"` mode every call the adapter
 * retries takes all `STORAGE_RETRY_MAX_ATTEMPTS` attempts:
 *
 * - a GET or DELETE fails twice with a transient `NetworkError`, then
 *   succeeds;
 * - a create (`If-None-Match: "*"`) fails once unapplied, lands on its
 *   second attempt with the reply lost, and meets its own body as a 412
 *   on the third, so the publisher's adoption GET (itself three attempts)
 *   follows;
 * - an `If-Match` PUT is not faulted: the adapter sends it once.
 *
 * **What is measured and what is composed.** The fold step
 * (`prepareTreeFold` + `publish`) and the reads are measured. The fold is
 * not wired into the maintenance tick yet, so the parts of a write tick
 * outside it come from main's measured counts (`request-counts.json`) and
 * the `Writer` structure the model replays, and are added by
 * {@link composeTick} / {@link composedWriteRoute}:
 *
 * - the maintenance runner's own `current.json` GET;
 * - the closing `tail_hint` refresh after a lost head CAS
 *   (one retried GET + an unretried CAS PUT);
 * - the write the tick shares an invocation with: its state read (the
 *   measured tree point read) plus the `Writer`'s `current.json` GET and
 *   `findLogTail` probe, then the commit hold.
 *
 * A Cloudflare write tick runs one phase (`phasesPerTick: "single"`), so
 * a fold tick carries no GC slice; the tree GC is not built.
 */
import {
  BaerlyError,
  casUpdateCurrentJson,
  encodeJsonBytes,
  type DocumentData,
  type LogEntry,
  logObjectKey,
  MAINTENANCE_FOLD_BASE_REQUESTS,
  MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  MemoryStorage,
  RequestLedger,
  readCurrentJson,
  retryStorageCall,
  STORAGE_RETRY_MAX_ATTEMPTS,
  type Storage,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
} from "@baerly/protocol";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import { buildTree, sealTree } from "../../packages/server/src/tree/build.ts";
import { prepareTreeFold, type TreeDepthZeroLimit } from "../../packages/server/src/tree/fold.ts";
import { treeHeadKey } from "../../packages/server/src/tree/head.ts";
import { treeNodeKeyPrefix } from "../../packages/server/src/tree/key.ts";
import { DEFAULT_TREE_CONFIG } from "../../packages/server/src/tree/layout.ts";
import { canonicalDocument } from "../../packages/server/src/tree/node-codec.ts";
import { openTreeView, treeScanBaseCalls } from "../../packages/server/src/tree/read.ts";
import { loadRequestCountSnapshot, parseCell } from "../../scripts/request-counts.ts";
import {
  type CountingStorage,
  wrapCountingStorage,
} from "../../tests/fixtures/counting-storage.ts";
import { logStateCurrentJson } from "../../tests/fixtures/log-state.ts";
import { TREE_TEST_CHUNK_SALT, testChunkKey } from "../../tests/fixtures/tree-chunk-salt.ts";
import {
  type Calls,
  commitHoldRequests,
  findLogTailGets,
  type KindCounts,
  type RetryPolicy,
  sumCalls,
} from "./model.ts";

/** The collection every measured bucket holds. */
export const MEASURE_PREFIX = "app/helpdesk/tenant/acme/manifests/tickets";

/** The attempt identity of every node of a measured tree, and its head's installer. */
const MEASURE_ATTEMPT = `${"0".repeat(31)}1`;
const COLLECTION = "tickets";
const HEAD_KEY = treeHeadKey(MEASURE_PREFIX);
const LOG_KEY_PREFIX = logObjectKey(MEASURE_PREFIX, 0).slice(0, -"0.json".length);
const NODE_KEY_PREFIX = treeNodeKeyPrefix(MEASURE_PREFIX);

// ── Requests charged, by kind ────────────────────────────────────────────

/**
 * Requests the ledger charges for `c` under `policy`, by kind: a create's
 * adoption readbacks are GETs. The kinds sum to `chargedRequests`.
 */
export const chargedByKind = (c: Calls, policy: RetryPolicy): KindCounts => {
  const a = policy.attemptsPerCall;
  return {
    get: c.gets * a + c.creates * a * policy.adoptionReadbacksPerCreate + c.unretriedGets,
    put: c.creates * a + c.casPuts * policy.casAttempts,
    delete: c.deletes * a,
    listPage: c.listPages * a,
  };
};

export const totalOf = (k: KindCounts): number => k.get + k.put + k.delete + k.listPage;

const addKinds = (a: KindCounts, b: KindCounts): KindCounts => ({
  get: a.get + b.get,
  put: a.put + b.put,
  delete: a.delete + b.delete,
  listPage: a.listPage + b.listPage,
});

// ── Composed parts, from main ────────────────────────────────────────────

const recordedTotal = (cell: string): number => {
  const text = loadRequestCountSnapshot().cells[cell];
  if (text === undefined) {
    throw new Error(`request-counts.json has no cell "${cell}"`);
  }
  const k = parseCell(cell, text);
  return k.get + k.put + k.delete + k.listPage;
};

/**
 * Logical calls of the write tick outside the fold step: the runner's
 * `current.json` GET (main's `tick:fold` cell less the fold's own
 * `MAINTENANCE_FOLD_BASE_REQUESTS + e`) and, after a lost head CAS, the
 * closing `tail_hint` refresh (`MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS`:
 * one logical GET and one `If-Match` PUT). The helper has no CAS retry
 * loop, but its GET still uses the adapter's retry policy.
 */
export const composedTickCalls = (): Calls => {
  const e = WRITE_TICK_FOLD_ENTRIES_PER_PASS;
  const runnerGets =
    recordedTotal(`tick:fold tail=50 idx=0 snap=100`) - MAINTENANCE_FOLD_BASE_REQUESTS - e;
  if (MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS !== 2) {
    throw new Error(
      "the tail_hint refresh is no longer one GET + one CAS PUT; update composedTickCalls",
    );
  }
  return sumCalls({ gets: runnerGets + 1, casPuts: 1 });
};

/**
 * Logical calls of the `Writer` on the write route, besides its state
 * read: the `current.json` GET and `findLogTail` from a `tail_hint`
 * `lag` slots behind the tail. Main's `insert` cell less its `get` cell
 * is that GET, one `findLogTail` GET at lag 0, the `log/<seq>` create and
 * the delete-floor GET; the last two are in the commit hold.
 */
export const composedWriterCalls = (lag: number): Calls => {
  const atLagZero =
    recordedTotal("insert tail=50 idx=0 snap=100") -
    recordedTotal("get tail=50 idx=0 snap=100") -
    2;
  return sumCalls({ gets: atLagZero - findLogTailGets(0) + findLogTailGets(lag) });
};

// ── Documents ────────────────────────────────────────────────────────────

/** A small deterministic PRNG (mulberry32). */
export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  hex(chars: number): string {
    let out = "";
    while (out.length < chars) {
      out += Math.floor(this.next() * 0x1_0000_0000)
        .toString(16)
        .padStart(8, "0");
    }
    return out.slice(0, chars);
  }

  /** A random ID in the 8-4-4-4-12 UUID shape: random, not time-ordered, so inserts land uniformly. */
  id(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

/** Canonical bytes of `{"_id":<id>,"p":""}` for a 36-character `id`. */
const DOC_ENVELOPE_BYTES = 53;

/** A document of exactly `bytes` canonical bytes: `{"_id": id, "p": <hex>}`. */
export const documentOf = (id: string, bytes: number, rng: Rng): DocumentData => {
  const pad = bytes - DOC_ENVELOPE_BYTES;
  if (id.length !== 36 || pad < 0) {
    throw new RangeError(`documentOf: cannot build a ${bytes}-byte document for ${id}`);
  }
  return { _id: id, p: rng.hex(pad) };
};

// ── Base trees ───────────────────────────────────────────────────────────

/** A collection to build: rows of one document size. */
export interface CollectionSpec {
  readonly docBytes: number;
  readonly rows: number;
}

/** A built tree: its bucket objects and what it holds. */
export interface BaseTree {
  readonly spec: CollectionSpec;
  /** Every object of the bucket: the nodes and the tree head. */
  readonly objects: ReadonlyMap<string, Uint8Array>;
  /** Live `_id`s in `utf8-scalar-v1` order (ASCII here). */
  readonly ids: readonly string[];
  /** The root's level. */
  readonly depth: number;
  readonly rows: number;
  /** Canonical document bytes. */
  readonly bytes: number;
  /** Nodes per level, leaves first, root included. */
  readonly levelNodes: readonly number[];
}

/**
 * Build the canonical tree of `spec.rows` documents of `spec.docBytes`
 * bytes at the production layout under the test chunk salt, with the
 * head at floor 0 (the folded log is retired).
 */
export const buildBaseTree = async (spec: CollectionSpec, seed: number): Promise<BaseTree> => {
  const rng = new Rng(seed);
  const ids = new Set<string>();
  while (ids.size < spec.rows) {
    ids.add(rng.id());
  }
  const sorted = [...ids].toSorted();
  const docs = sorted.map((id) =>
    canonicalDocument(documentOf(id, spec.docBytes, rng), "base row"),
  );
  const plan = await buildTree(docs, await testChunkKey(), DEFAULT_TREE_CONFIG);
  const sealed = await sealTree(plan, {
    prefix: MEASURE_PREFIX,
    attempt: MEASURE_ATTEMPT,
    floor: 0,
  });
  const objects = new Map<string, Uint8Array>();
  for (const level of sealed.levels) {
    for (const node of level) {
      objects.set(node.key, node.bytes);
    }
  }
  const root = sealed.root!;
  const head = {
    ...logStateCurrentJson({
      log_seq_start: 0,
      tail_hint: 0,
      snapshot_rows: root.summary.rows,
      snapshot_bytes: root.summary.bytes,
    }),
    proto_tree: { root: root.key, attempt: MEASURE_ATTEMPT, chunk_salt: TREE_TEST_CHUNK_SALT },
  };
  objects.set(HEAD_KEY, encodeJsonBytes(head));
  return {
    spec,
    objects,
    ids: sorted,
    depth: sealed.levels.length - 1,
    rows: root.summary.rows,
    bytes: root.summary.bytes,
    levelNodes: sealed.levels.map((level) => level.length),
  };
};

// ── Workload ─────────────────────────────────────────────────────────────

/** One row change of a tail. */
export interface RowChange {
  readonly id: string;
  readonly doc: DocumentData | null;
}

/**
 * Scattered changes over a base tree's rows that keep its row count and
 * document bytes: the cycle delete, insert (a fresh random `_id`, the
 * deleted row's size), shrink one row by `delta`, grow another by the
 * same. Targets are picked by a golden-ratio sequence over the live rows
 * in key order, so consecutive changes land far apart and the paths
 * diverge. `avoid` is never touched (the point read's target).
 */
export class Workload {
  readonly #rng: Rng;
  readonly #live: string[];
  readonly #sizes = new Map<string, number>();
  readonly #delta: number;
  readonly #avoid: string | undefined;
  #j = 0;
  #step = 0;
  #lastDeleted: number;
  #shrunk = 0;

  constructor(base: BaseTree, seed: number, avoid?: string) {
    this.#rng = new Rng(seed);
    this.#live = [...base.ids];
    for (const id of base.ids) {
      this.#sizes.set(id, base.spec.docBytes);
    }
    this.#delta = Math.floor((base.spec.docBytes - DOC_ENVELOPE_BYTES) / 4);
    this.#avoid = avoid;
    this.#lastDeleted = base.spec.docBytes;
  }

  #pickIndex(): number {
    for (;;) {
      this.#j += 1;
      const frac = (this.#j * 0.618_033_988_749_895) % 1;
      const index = Math.floor(frac * this.#live.length);
      if (this.#live[index] !== this.#avoid) {
        return index;
      }
    }
  }

  next(): RowChange {
    const phase = this.#step % 4;
    this.#step += 1;
    const index = this.#pickIndex();
    const id = this.#live[index]!;
    if (phase === 0) {
      this.#live.splice(index, 1);
      this.#lastDeleted = this.#sizes.get(id)!;
      this.#sizes.delete(id);
      return { id, doc: null };
    }
    if (phase === 1) {
      let fresh = this.#rng.id();
      while (this.#sizes.has(fresh)) {
        fresh = this.#rng.id();
      }
      const at = this.#live.findIndex((other) => other > fresh);
      this.#live.splice(at === -1 ? this.#live.length : at, 0, fresh);
      this.#sizes.set(fresh, this.#lastDeleted);
      return { id: fresh, doc: documentOf(fresh, this.#lastDeleted, this.#rng) };
    }
    const size = this.#sizes.get(id)!;
    let next: number;
    if (phase === 2) {
      this.#shrunk = Math.min(this.#delta, size - DOC_ENVELOPE_BYTES);
      next = size - this.#shrunk;
    } else {
      next = size + this.#shrunk;
    }
    this.#sizes.set(id, next);
    return { id, doc: documentOf(id, next, this.#rng) };
  }
}

// ── Buckets ──────────────────────────────────────────────────────────────

/** A fresh bucket holding `base`, with `tail` appended unfolded after its floor. */
export const openBucket = async (
  base: BaseTree,
  tail: readonly RowChange[],
  tailHintLag: number,
): Promise<MemoryStorage> => {
  const bucket = new MemoryStorage();
  for (const [key, bytes] of base.objects) {
    await bucket.put(key, bytes);
  }
  const live = new Set(base.ids);
  for (const [seq, { id, doc }] of tail.entries()) {
    let op: LogEntry["op"] = "D";
    if (doc !== null) {
      op = live.has(id) ? "U" : "I";
      live.add(id);
    } else {
      live.delete(id);
    }
    const entry = {
      lsn: `lsn-${seq}`,
      commit_ts: "2026-01-01T00:00:00.000Z",
      op,
      collection: COLLECTION,
      doc_id: id,
      session: "ssn001",
      seq,
      ...(doc !== null && { after: doc }),
    };
    await bucket.put(logObjectKey(MEASURE_PREFIX, seq), encodeJsonBytes(entry), {
      ifNoneMatch: "*",
    });
  }
  await casUpdateCurrentJson(bucket, HEAD_KEY, (head) => ({
    ...head,
    tail_hint: Math.max(0, tail.length - tailHintLag),
  }));
  return bucket;
};

// ── Measuring storage ────────────────────────────────────────────────────

/** How the fault layer treats calls: answered first time, or every retried call at every attempt. */
export type FaultMode = "happy" | "all-attempts";

const transient = (): BaerlyError => new BaerlyError("NetworkError", "injected transient fault");

/** The fault layer of the module comment. */
const faulted = (inner: Storage, mode: FaultMode): Storage => {
  if (mode === "happy") {
    return inner;
  }
  const failures = new Map<string, number>();
  /** This attempt's number (1-based) of `op`, cycling every `STORAGE_RETRY_MAX_ATTEMPTS`. */
  const nth = (op: string): number => {
    const n = (failures.get(op) ?? 0) + 1;
    failures.set(op, n % STORAGE_RETRY_MAX_ATTEMPTS);
    return n;
  };
  return {
    get: async (key, opts) => {
      if (nth(`get ${key}`) < STORAGE_RETRY_MAX_ATTEMPTS) {
        throw transient();
      }
      return inner.get(key, opts);
    },
    put: async (key, body, opts) => {
      if (opts?.ifNoneMatch !== "*") {
        return inner.put(key, body, opts);
      }
      const n = nth(`put ${key}`);
      if (n === 1) {
        throw transient();
      }
      if (n === 2) {
        await inner.put(key, body, opts);
        throw transient();
      }
      return inner.put(key, body, opts);
    },
    delete: async (key, opts) => {
      if (nth(`delete ${key}`) < STORAGE_RETRY_MAX_ATTEMPTS) {
        throw transient();
      }
      return inner.delete(key, opts);
    },
    list: (prefix, opts) => inner.list(prefix, opts),
  };
};

const sleep = async (): Promise<void> => {};

/** `retryStorageCall` as the S3 and R2 adapters wrap each call, with no backoff sleep. */
const adapterRetry = (inner: Storage): Storage => {
  const pool = "internal" as const;
  return {
    get: (key, opts) => retryStorageCall(() => inner.get(key, opts), { sleep, pool }),
    put: (key, body, opts) =>
      retryStorageCall(() => inner.put(key, body, opts), {
        sleep,
        pool,
        conditionalCreate: opts?.ifNoneMatch === "*",
        compareAndSwap: opts?.ifMatch !== undefined,
      }),
    delete: (key, opts) => retryStorageCall(() => inner.delete(key, opts), { sleep, pool }),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
};

const classify = (key: string): string | undefined => {
  if (key === HEAD_KEY) {
    return "head";
  }
  if (key.startsWith(LOG_KEY_PREFIX)) {
    return "log";
  }
  if (key.startsWith(NODE_KEY_PREFIX)) {
    return "node";
  }
  return undefined;
};

/** The measuring stack over one bucket. */
interface Meter {
  readonly storage: Storage;
  readonly logical: CountingStorage;
  readonly attempts: CountingStorage;
  readonly ledger: RequestLedger;
}

const meter = (bucket: Storage, mode: FaultMode, ledgerLimit: number): Meter => {
  const attempts = wrapCountingStorage(faulted(bucket, mode), classify);
  const logical = wrapCountingStorage(adapterRetry(attempts.storage), classify);
  const ledger = new RequestLedger({ internal: ledgerLimit, external: ledgerLimit });
  return { storage: logical.storage, logical, attempts, ledger };
};

/** Storage calls one measured operation made. */
export interface Measured {
  /** Every attempt that reached the bucket, by kind: what the request ledger charged. */
  readonly attempts: KindCounts;
  /** Each `Storage` call once, by kind. */
  readonly logical: KindCounts;
  /** Logical GETs by key class. */
  readonly logicalGets: { readonly head: number; readonly log: number; readonly node: number };
  /** What the request ledger charged; equals the attempts' total. */
  readonly ledgerCharged: number;
}

const kindsOf = (c: CountingStorage): KindCounts => ({
  get: c.gets,
  put: c.puts,
  delete: c.deletes,
  listPage: c.lists,
});

const measuredOf = (m: Meter): Measured => {
  const attempts = kindsOf(m.attempts);
  const charged = m.ledger.charged.internal + m.ledger.charged.external;
  if (charged !== totalOf(attempts)) {
    throw new Error(
      `ledger charged ${charged}, but ${totalOf(attempts)} attempts reached the bucket`,
    );
  }
  return {
    attempts,
    logical: kindsOf(m.logical),
    logicalGets: {
      head: m.logical.classCounts("head").gets,
      log: m.logical.classCounts("log").gets,
      node: m.logical.classCounts("node").gets,
    },
    ledgerCharged: charged,
  };
};

const run = <T>(m: Meter, fn: () => Promise<T>): Promise<T> =>
  Promise.resolve(runWithContext(createObservabilityContext({ ledger: m.ledger }), fn));

/** The runner's head read and closing hint refresh through the adapter retry stack. */
export const measureTickOverhead = async (mode: FaultMode): Promise<Measured> => {
  const bucket = new MemoryStorage();
  await bucket.put(HEAD_KEY, encodeJsonBytes(logStateCurrentJson()));
  const m = meter(bucket, mode, Number.MAX_SAFE_INTEGER);
  await run(m, async () => {
    await readCurrentJson(m.storage, HEAD_KEY);
    await casUpdateCurrentJson(m.storage, HEAD_KEY, (head) => ({
      ...head,
      tail_hint: MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
    }));
  });
  return measuredOf(m);
};

// ── Reads ────────────────────────────────────────────────────────────────

/** A measured read. */
export interface MeasuredRead extends Measured {
  /** The `CapacityExceeded` that refused the read, if one did (before any base GET for a scan). */
  readonly refused?: BaerlyError;
  /** For a scan: the base GETs its admission check charged, at every attempt. */
  readonly admissionCharge?: number;
}

/** The key a cold point read of `base` looks up: a base row in the middle of the key order. */
export const pointTarget = (base: BaseTree): string => base.ids[Math.floor(base.ids.length / 2)]!;

/**
 * A cold point read of {@link pointTarget} (a fresh view: the head, the
 * root and every level on its path are fetched), on a bucket with `tail`
 * unfolded, under a request ledger of `ledgerLimit`.
 */
export const measurePointRead = async (
  bucket: Storage,
  base: BaseTree,
  mode: FaultMode,
  ledgerLimit: number,
): Promise<MeasuredRead> => {
  const m = meter(bucket, mode, ledgerLimit);
  const target = pointTarget(base);
  const row = await run(m, async () => {
    const view = await openTreeView({ storage: m.storage, prefix: MEASURE_PREFIX });
    return view.get(target);
  });
  if (row?.["_id"] !== target) {
    throw new Error(`point read of ${target} did not return its row`);
  }
  return measuredOf(m);
};

/** A complete scan on a bucket, under a request ledger of `ledgerLimit`; a refusal is recorded. */
export const measureScan = async (
  bucket: Storage,
  base: BaseTree,
  mode: FaultMode,
  ledgerLimit: number,
): Promise<MeasuredRead> => {
  const m = meter(bucket, mode, ledgerLimit);
  let refused: BaerlyError | undefined;
  await run(m, async () => {
    const view = await openTreeView({ storage: m.storage, prefix: MEASURE_PREFIX });
    try {
      const rows = await view.scan();
      if (rows.length !== base.rows) {
        throw new Error(`scan returned ${rows.length} rows, expected ${base.rows}`);
      }
    } catch (error) {
      if (error instanceof BaerlyError && error.code === "CapacityExceeded") {
        refused = error;
        return;
      }
      throw error;
    }
  });
  return {
    ...measuredOf(m),
    ...(refused !== undefined && { refused }),
    admissionCharge:
      treeScanBaseCalls(base.bytes, base.depth, DEFAULT_TREE_CONFIG.layout) *
      STORAGE_RETRY_MAX_ATTEMPTS,
  };
};

// ── Fold tick ────────────────────────────────────────────────────────────

/** A measured fold step. */
export interface MeasuredFold extends Measured {
  /** Entries the fold accepted: `foldEnd − floor`. */
  readonly folded: number;
  /** Why the fold ended before the tail, if it did. */
  readonly stop?: string;
  /** Rows and document bytes before and after. */
  readonly before: { readonly rows: number; readonly bytes: number; readonly depth: number };
  readonly after: { readonly rows: number; readonly bytes: number; readonly depth: number };
}

/**
 * One fold step on a bucket whose unfolded tail is `tailLength` entries,
 * with the writer's committed tail as `knownTail` (the write tick passes
 * it), against `budget`, at the host's fold width `parallelCalls`. A concurrent `tail_hint` refresh lands between
 * planning and publication, so the head CAS is lost and the fold pays
 * its fate re-read: the worst case the model's tick assumes. That
 * refresh goes to the bucket directly and is not counted.
 */
export const measureFold = async (
  bucket: MemoryStorage,
  base: BaseTree,
  tailLength: number,
  mode: FaultMode,
  budget: number,
  parallelCalls: number,
  depthZero?: TreeDepthZeroLimit,
): Promise<MeasuredFold> => {
  const m = meter(bucket, mode, Number.MAX_SAFE_INTEGER);
  const outcome = await run(m, async () => {
    const prepared = await prepareTreeFold({
      storage: m.storage,
      prefix: MEASURE_PREFIX,
      budget,
      knownTail: tailLength,
      config: DEFAULT_TREE_CONFIG,
      parallelCalls,
      // Counts must not depend on how fast this host plans, so the
      // tick budget never stops a measured fold.
      tickBudgetMs: Number.POSITIVE_INFINITY,
      ...(depthZero !== undefined && { depthZero }),
    });
    if (prepared.kind !== "prepared") {
      throw new Error(`fold did not prepare: ${JSON.stringify(prepared)}`);
    }
    await casUpdateCurrentJson(bucket, HEAD_KEY, (head) => ({ ...head, tail_hint: tailLength }));
    const published = await prepared.publish();
    if (published.kind !== "cas-lost") {
      throw new Error(`fold publication was not lost: ${published.kind}`);
    }
    return { prepared, published };
  });
  const tree = outcome.prepared.plan.tree;
  const stop = outcome.prepared.stop;
  return {
    ...measuredOf(m),
    folded: outcome.prepared.foldEnd - outcome.prepared.floor,
    ...(stop !== undefined && { stop: `${stop.reason} at seq ${stop.seq}` }),
    before: { rows: base.rows, bytes: base.bytes, depth: base.depth },
    after: {
      rows: tree?.root.summary.rows ?? 0,
      bytes: tree?.root.summary.bytes ?? 0,
      depth: tree?.root.level ?? 0,
    },
  };
};

/** `measured` plus the composed logical calls `composed`, charged under `policy`. */
export const withComposed = (
  measured: KindCounts,
  composed: Calls,
  policy: RetryPolicy,
): KindCounts => addKinds(measured, chargedByKind(composed, policy));

/** The commit hold every tick budget keeps: the log create at every attempt plus `COMMIT_RESOLUTION_RESERVE`. */
export const COMMIT_HOLD = commitHoldRequests();
