/**
 * A bucket for tree GC tests: one collection in memory behind the
 * adapter retry, with folds published through the real planner and
 * publisher, GC ticks through `runTreeGcTick`, and two clocks the test
 * moves by hand.
 *
 * - **Clocks.** `local` is what the GC tick reads as its local clock;
 *   `server` is what every PUT reports as `serverDate` (the server-clock
 *   wrapper). They move independently, so a test can skew one against
 *   the other, and `serverTime = false` makes PUTs report none.
 * - **Interleaving.** A fold can be started and left paused before its
 *   head CAS ({@link GcBucket.startFold}), the way an attempt still in
 *   flight looks to GC. `onList` runs once before the next LIST of a
 *   prefix, and `getOverride` can replace what a GET returns, so a test
 *   can land a fold inside a tick or simulate a misread.
 * - **Judging.** {@link GcBucket.violations} runs the physical oracle
 *   over the current tree and the rows its folds published; a node the
 *   root reaches that GC deleted shows up there. {@link MarginWatch}
 *   records when each node became unreachable and flags a deletion that
 *   came sooner than the reader margin after it.
 *
 * Storage stack, outermost first: adapter retry → hooks → fault
 * injection (`aborting-storage.ts`) → server clock → memory.
 */
import {
  RequestLedger,
  type DocumentData,
  MemoryStorage,
  retryStorageCall,
  type Storage,
  type CurrentJson,
  createCurrentJson,
  casUpdateCurrentJson,
} from "@baerly/protocol";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import { RequestScopedMetricsRecorder } from "../../packages/server/src/observability/recorder.ts";
import { TREE_GC_SUPERSEDED_DELAY_MINUTES } from "../../packages/server/src/tree/constants.ts";
import { runTreeGcTick, type TreeGcTickResult } from "../../packages/server/src/tree/gc.ts";
import { decodeTreeGcState, type TreeGcState } from "../../packages/server/src/tree/gc-state.ts";
import {
  importTreeChunkKey,
  readTreeHead,
  readTreeRoot,
  type TreeHead,
  treeHeadKey,
} from "../../packages/server/src/tree/head.ts";
import {
  treeGcStateKey,
  treeNodeKeyPrefix,
  treeRecordKeyPrefix,
} from "../../packages/server/src/tree/key.ts";
import { createTreeConfig, type TreeConfig } from "../../packages/server/src/tree/layout.ts";
import {
  canonicalDocument,
  type DecodedTreeNode,
} from "../../packages/server/src/tree/node-codec.ts";
import { planFold, type TreeFoldPlan } from "../../packages/server/src/tree/plan.ts";
import { publishTree, type TreePublishOutcome } from "../../packages/server/src/tree/publish.ts";
import { abortingStorage } from "./aborting-storage.ts";
import { ledgeredStorage } from "./ledgered-storage.ts";
import { TREE_TEST_CHUNK_SALT, testChunkKey } from "./tree-chunk-salt.ts";
import { FOLD_PREFIX, SMALL_LAYOUT } from "./tree-fold-harness.ts";
import type { TreeMutant } from "./tree-mutants.ts";
import { captureTreeImage, checkTreeImage } from "./tree-oracle-physical.ts";

export const GC_PREFIX = FOLD_PREFIX;
export const GC_HEAD = treeHeadKey(GC_PREFIX);
export const GC_NODES = treeNodeKeyPrefix(GC_PREFIX);
export const GC_RECORDS = treeRecordKeyPrefix(GC_PREFIX);
export const GC_STATE = treeGcStateKey(GC_PREFIX);

/** Both clocks start here. */
export const GC_T0 = Date.parse("2026-01-05T00:00:00.000Z");
const MINUTE = 60_000;

const chunkKey = await testChunkKey();

/** A distinct, deterministic attempt identity. */
export const gcAttemptOf = (n: number): string => n.toString(16).padStart(32, "0");

/** The small-scope layout with the steps of every mutant given. */
export const gcConfig = (...mutants: readonly (TreeMutant | undefined)[]): TreeConfig =>
  createTreeConfig({
    layout: SMALL_LAYOUT,
    steps: Object.assign({}, ...mutants.map((mutant) => mutant?.options.steps ?? {})),
  });

/** A row change: the row's new value, or `null` to delete it. */
export type GcChange = readonly [id: string, value: number | null];

/** A captured, planned fold that has not published. */
export interface GcPreparedFold {
  readonly head: TreeHead;
  readonly root: DecodedTreeNode | null;
  readonly plan: TreeFoldPlan;
  readonly floor: number;
  readonly changes: readonly GcChange[];
}

/** A fold paused before its head CAS. */
export interface GcFoldInFlight {
  readonly fold: GcPreparedFold;
  /** Let the head CAS go, and resolve with the outcome. */
  release(): Promise<TreePublishOutcome>;
}

/** What a tick did, and what it counted and warned. */
export interface GcTickRun {
  readonly result: TreeGcTickResult;
  readonly counters: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
}

/** A fresh tree head with no `proto_tree`. */
export const freshGcHead = (generation?: string): CurrentJson => ({
  schema_version: 3,
  snapshot: null,
  tail_hint: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "", claimed_at: "" },
  snapshot_bytes: 0,
  snapshot_rows: 0,
  ...(generation !== undefined && { generation }),
});

/** The rows `k00`..`k19`, a depth-3 tree at the small-scope layout. */
export const GC_SEED: readonly GcChange[] = Array.from({ length: 20 }, (_, i) => [
  `k${String(i).padStart(2, "0")}`,
  i,
]);

export class GcBucket {
  readonly memory = new MemoryStorage();
  /** Local clock, ms. */
  local = GC_T0;
  /** Server clock, ms. */
  server = GC_T0;
  /** Whether PUTs report `serverDate`. */
  serverTime = true;
  /** Runs once before the next LIST of the prefix it is keyed by. */
  readonly onList = new Map<string, () => Promise<void>>();
  /**
   * Fold-record attempts a LIST does not show yet, as a lagging LIST
   * hides a create it has not caught up with. GETs still see them.
   */
  readonly listLag = new Set<string>();
  /** Replaces a GET's body: return `undefined` to read the bucket. */
  getOverride: ((key: string) => Uint8Array | null | undefined) | undefined;
  /** The rows the head's tree must hold. */
  readonly rows = new Map<string, DocumentData>();
  readonly faults;
  readonly storage: Storage;
  #attempts = 0;

  constructor() {
    const clocked: Storage = {
      get: (key, opts) => this.memory.get(key, opts),
      put: async (key, body, opts) => {
        const { etag } = await this.memory.put(key, body, opts);
        return this.serverTime ? { etag, serverDate: new Date(this.server) } : { etag };
      },
      delete: (key, opts) => this.memory.delete(key, opts),
      list: (prefix, opts) => this.memory.list(prefix, opts),
    };
    this.faults = abortingStorage(clocked);
    const inner = this.faults.storage;
    const hooked: Storage = {
      get: async (key, opts) => {
        const override = this.getOverride?.(key);
        if (override === null) {
          return null;
        }
        if (override !== undefined) {
          return { body: override, etag: '"override"' };
        }
        return inner.get(key, opts);
      },
      put: (key, body, opts) => inner.put(key, body, opts),
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => {
        const hook = this.onList.get(prefix);
        this.onList.delete(prefix);
        const lag = this.listLag;
        return (async function* () {
          await hook?.();
          for await (const entry of inner.list(prefix, opts)) {
            const tail = entry.key.slice(GC_RECORDS.length);
            if (!(entry.key.startsWith(GC_RECORDS) && lag.has(tail.slice(17, 49)))) {
              yield entry;
            }
          }
        })();
      },
    };
    const sleep = async (): Promise<void> => {};
    this.storage = {
      get: (key, opts) => retryStorageCall(() => hooked.get(key, opts), { sleep }),
      put: (key, body, opts) =>
        retryStorageCall(() => hooked.put(key, body, opts), {
          sleep,
          conditionalCreate: opts?.ifNoneMatch === "*",
          compareAndSwap: opts?.ifMatch !== undefined,
        }),
      delete: (key, opts) => retryStorageCall(() => hooked.delete(key, opts), { sleep }),
      list: (prefix, opts) => hooked.list(prefix, opts),
    };
  }

  static async open(generation?: string): Promise<GcBucket> {
    const bucket = new GcBucket();
    await createCurrentJson(bucket.memory, GC_HEAD, freshGcHead(generation));
    return bucket;
  }

  /** A bucket holding the depth-3 tree of {@link GC_SEED}. */
  static async seeded(generation?: string): Promise<GcBucket> {
    const bucket = await GcBucket.open(generation);
    const outcome = await bucket.fold(GC_SEED);
    if (outcome.kind !== "published") {
      throw new Error("seeding did not publish");
    }
    return bucket;
  }

  /** Move both clocks on by `minutes`, or the server clock by `server` minutes instead. */
  advance(minutes: number, server = minutes): void {
    this.local += minutes * MINUTE;
    this.server += server * MINUTE;
  }

  async head(): Promise<TreeHead> {
    const head = await readTreeHead(this.memory, GC_PREFIX);
    if (head === null) {
      throw new Error("no head");
    }
    return head;
  }

  /** Capture the head and its root and plan `changes` onto them. */
  async prepare(changes: readonly GcChange[], config = gcConfig()): Promise<GcPreparedFold> {
    const head = await readTreeHead(this.storage, GC_PREFIX);
    if (head === null) {
      throw new Error("no head");
    }
    const root = await readTreeRoot(this.storage, head, config);
    const survivors = new Map<string, GcChange>(changes.map((change) => [change[0], change]));
    const plan = await planFold({
      prefix: GC_PREFIX,
      root,
      chunkKey: (await importTreeChunkKey(head)) ?? chunkKey,
      mutations: [...survivors.values()].map(([id, value]) => ({
        id,
        doc: value === null ? null : canonicalDocument({ _id: id, v: value }, id),
      })),
      get: async (key) => {
        const got = await this.storage.get(key);
        return got?.body ?? null;
      },
      config,
    });
    return { head, root, plan, floor: head.json.log_seq_start + changes.length, changes };
  }

  /**
   * Publish `fold` with the next attempt identity (or `attempt`), and
   * commit its rows when it publishes.
   */
  async publish(
    fold: GcPreparedFold,
    options: {
      readonly attempt?: string;
      readonly config?: TreeConfig;
      readonly storage?: Storage;
    } = {},
  ): Promise<TreePublishOutcome> {
    this.#attempts += 1;
    const config =
      options.config ??
      createTreeConfig({
        layout: SMALL_LAYOUT,
        steps: { mintAttempt: () => options.attempt ?? gcAttemptOf(this.#attempts) },
      });
    const outcome = await publishTree({
      storage: options.storage ?? this.storage,
      prefix: GC_PREFIX,
      head: fold.head,
      root: fold.root,
      plan: fold.plan,
      floor: fold.floor,
      chunkSalt: TREE_TEST_CHUNK_SALT,
      config,
    });
    if (outcome.kind === "published") {
      for (const [id, value] of fold.changes) {
        if (value === null) {
          this.rows.delete(id);
        } else {
          this.rows.set(id, { _id: id, v: value });
        }
      }
    }
    return outcome;
  }

  /** Prepare and publish `changes`. */
  async fold(
    changes: readonly GcChange[],
    options: Parameters<GcBucket["publish"]>[1] = {},
  ): Promise<TreePublishOutcome> {
    return this.publish(await this.prepare(changes), options);
  }

  /**
   * Prepare `changes` and publish them until the head CAS, then pause:
   * the record and every fresh node are written, the CAS is not sent.
   */
  async startFold(
    changes: readonly GcChange[],
    options: { readonly attempt?: string; readonly config?: TreeConfig } = {},
  ): Promise<GcFoldInFlight> {
    const fold = await this.prepare(changes);
    let paused!: () => void;
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    let go!: () => void;
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    const storage: Storage = {
      ...this.storage,
      put: async (key, body, opts) => {
        if (key === GC_HEAD) {
          paused();
          await gate;
        }
        return this.storage.put(key, body, opts);
      },
    };
    const done = this.publish(fold, { ...options, storage });
    await Promise.race([reached, done]);
    return {
      fold,
      release: () => {
        go();
        return done;
      },
    };
  }

  /** Rewrite the head the way a tail-hint refresh does: `proto_tree` spread through. */
  async refreshTailHint(): Promise<void> {
    await casUpdateCurrentJson(this.memory, GC_HEAD, (head) => ({
      ...head,
      tail_hint: head.tail_hint + 1,
    }));
  }

  /** One GC tick under `config`, with its counters and warnings. */
  async tick(config: TreeConfig = gcConfig(), retireWindow?: number): Promise<GcTickRun> {
    const recorder = new RequestScopedMetricsRecorder();
    const warnings: string[] = [];
    const ctx = createObservabilityContext({
      recorder,
      maintenance: { warn: (event) => warnings.push(event) },
    });
    const result = await runWithContext(ctx, () =>
      runTreeGcTick({
        storage: this.storage,
        prefix: GC_PREFIX,
        config,
        now: () => new Date(this.local),
        ...(retireWindow !== undefined && { retireWindow }),
      }),
    );
    const counters = new Map<string, number>();
    for (const c of recorder.snapshot().counters) {
      counters.set(c.name, (counters.get(c.name) ?? 0) + c.value);
    }
    return { result, counters, warnings };
  }

  /**
   * One GC tick charged to a request ledger of `limit` calls, as a host
   * with a per-invocation cap runs it. Returns the tick and the calls
   * the ledger was charged.
   */
  async tickWithLedger(
    limit: number,
    config: TreeConfig = gcConfig(),
  ): Promise<{ readonly result: TreeGcTickResult; readonly charged: number }> {
    const ledger = new RequestLedger({ internal: limit, external: limit });
    const storage = ledgeredStorage(this.storage, "internal");
    const result = await runWithContext(createObservabilityContext({ ledger }), () =>
      runTreeGcTick({ storage, prefix: GC_PREFIX, config, now: () => new Date(this.local) }),
    );
    return { result, charged: limit - ledger.storageRemaining() };
  }

  /** Tick once a minute for `minutes` minutes, both clocks moving together. */
  async tickFor(minutes: number, config = gcConfig(), watch?: MarginWatch): Promise<string[]> {
    const deleted: string[] = [];
    for (let i = 0; i < minutes; i++) {
      this.advance(1);
      const { result } = await this.tick(config);
      deleted.push(...result.deleted);
      await watch?.afterTick(result.deleted);
    }
    return deleted;
  }

  /** The decoded GC state, or `null`. */
  async state(): Promise<TreeGcState | null> {
    const got = await this.memory.get(GC_STATE);
    if (got === null) {
      return null;
    }
    const decoded = decodeTreeGcState(GC_STATE, got.body);
    return decoded.kind === "state" ? decoded.state : null;
  }

  /** Every key under `prefix`, sorted. */
  async keys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const entry of this.memory.list(prefix)) {
      keys.push(entry.key);
    }
    return keys.toSorted();
  }

  /** The physical oracle over the current tree and the published rows. */
  async violations(): Promise<string[]> {
    const head = await this.head();
    const report = checkTreeImage({
      image: await captureTreeImage(this.memory, GC_PREFIX),
      prefix: GC_PREFIX,
      layout: SMALL_LAYOUT,
      expectedRows: this.rows.values(),
      expectedFloor: head.json.log_seq_start,
    });
    return report.violations.map((v) => `[${v.kind}] ${v.message}`);
  }

  /** Node keys the head's root reaches. */
  async reachable(): Promise<Set<string>> {
    const report = checkTreeImage({
      image: await captureTreeImage(this.memory, GC_PREFIX),
      prefix: GC_PREFIX,
      layout: SMALL_LAYOUT,
    });
    return new Set(report.reachableKeys);
  }

  /** Node keys present that the head's root does not reach. */
  async unreachable(): Promise<string[]> {
    const reachable = await this.reachable();
    const keys = await this.keys(GC_NODES);
    return keys.filter((key) => !reachable.has(key));
  }
}

/**
 * Tracks, on the server clock, when each node that was ever reachable
 * stopped being reachable, and checks every deletion against it: no
 * deletion of a node the root reaches, and none sooner than the
 * superseded delay after the node became unreachable.
 */
export class MarginWatch {
  readonly #bucket: GcBucket;
  readonly #since = new Map<string, number>();
  readonly #everReachable = new Set<string>();
  readonly problems: string[] = [];

  constructor(bucket: GcBucket) {
    this.#bucket = bucket;
  }

  /** Record reachability now; call after every fold. */
  async observe(): Promise<void> {
    const reachable = await this.#bucket.reachable();
    for (const key of reachable) {
      this.#everReachable.add(key);
      this.#since.delete(key);
    }
    for (const key of this.#everReachable) {
      if (!reachable.has(key) && !this.#since.has(key)) {
        this.#since.set(key, this.#bucket.server);
      }
    }
  }

  /** Check a tick's deletions, then observe. */
  async afterTick(deleted: readonly string[]): Promise<void> {
    for (const key of deleted.filter((k) => k.startsWith(GC_NODES))) {
      if (!this.#everReachable.has(key)) {
        continue;
      }
      const since = this.#since.get(key);
      if (since === undefined) {
        this.problems.push(`deleted ${key} while the root reached it`);
      } else if (this.#bucket.server - since < TREE_GC_SUPERSEDED_DELAY_MINUTES * MINUTE) {
        this.problems.push(
          `deleted ${key} ${(this.#bucket.server - since) / MINUTE} min after it became unreachable`,
        );
      }
    }
    const missing = await this.#bucket.violations();
    this.problems.push(...missing);
    await this.observe();
  }
}
