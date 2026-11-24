/**
 * Publication of a planned fold (`./publish.ts`): write order, crash and
 * lost-reply behaviour at every storage call, create-conflict adoption,
 * the head CAS's fate, captured-live reuse and the fresh attempt
 * identity.
 *
 * Every published bucket is judged by the physical oracle
 * (`tests/fixtures/tree-oracle-physical.ts`) against the rows the
 * published folds committed: keys, hashes, strict bodies, every parent
 * entry against its child's body, chunk boundaries and the canonical
 * root. The `mutation` block requires each publication mutant in
 * `tests/fixtures/tree-mutants.ts` to turn its check red.
 *
 * The storage stack is publisher → call tap → adapter retry
 * (`retryStorageCall`, configured as the S3 and R2 adapters configure
 * it) → fault injection (`tests/fixtures/aborting-storage.ts`) → write
 * tap → memory, so a lost reply reaches create-conflict adoption the way
 * it would through a real adapter.
 */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  BaerlyError,
  casUpdateCurrentJson,
  createCurrentJson,
  type CurrentJson,
  type DocumentData,
  MemoryStorage,
  retryStorageCall,
  sha256Hex,
  type Storage,
} from "@baerly/protocol";
import { abortingStorage } from "../../../../tests/fixtures/aborting-storage.ts";
import {
  TREE_SECOND_TEST_CHUNK_SALT,
  TREE_TEST_CHUNK_SALT,
  testChunkKey,
} from "../../../../tests/fixtures/tree-chunk-salt.ts";
import { FOLD_PREFIX, SMALL_LAYOUT } from "../../../../tests/fixtures/tree-fold-harness.ts";
import {
  PUBLISH_ADOPTS_WITHOUT_COMPARE,
  PUBLISH_HEAD_BEFORE_NODES,
  PUBLISH_MUTANTS,
  PUBLISH_NODES_BEFORE_RECORD,
  PUBLISH_REUSES_UNPROVEN_REF,
  RECORD_FLOOR_NOT_CAPTURED,
  RECORD_NAMES_REUSED_NODE,
  RECORD_NO_DOWNWARD_CLOSURE,
  RECORD_OMITS_SUPERSEDED,
  type TreeMutant,
} from "../../../../tests/fixtures/tree-mutants.ts";
import {
  captureTreeImage,
  checkTreeImage,
} from "../../../../tests/fixtures/tree-oracle-physical.ts";
import {
  type PlannedChild,
  type PlannedNode,
  type PlannedTree,
  plannedBranch,
  sealTree,
} from "./build.ts";
import { type ChunkKey, importChunkKey } from "./chunk.ts";
import {
  importTreeChunkKey,
  readTreeHead,
  readTreeRoot,
  type TreeHead,
  type TreeHeadJson,
  treeHeadKey,
} from "./head.ts";
import {
  parseTreeNodeKey,
  parseTreeRecordKey,
  treeNodeKeyPrefix,
  treeRecordKeyPrefix,
} from "./key.ts";
import { createTreeConfig, type TreeConfig } from "./layout.ts";
import { canonicalDocument, type DecodedTreeNode, type TreeChildEntry } from "./node-codec.ts";
import { planFold, type TreeFoldPlan } from "./plan.ts";
import { capturedLiveRefs, publishTree, type TreePublishOutcome } from "./publish.ts";
import { type FoldRecordBase, foldRecordBase } from "./record.ts";

const PREFIX = FOLD_PREFIX;
const HEAD = treeHeadKey(PREFIX);
const NODES = treeNodeKeyPrefix(PREFIX);
const RECORDS = treeRecordKeyPrefix(PREFIX);
const chunkKey = await testChunkKey();
const secondChunkKey = await importChunkKey(Uint8Array.fromHex(TREE_SECOND_TEST_CHUNK_SALT));

/** A distinct, deterministic attempt identity. */
const attemptOf = (n: number): string => n.toString(16).padStart(32, "0");

/** The small-scope layout, with `mutant`'s steps and a pinned attempt identity when given. */
const configFor = (mutant?: TreeMutant, attempt?: string): TreeConfig =>
  createTreeConfig({
    layout: SMALL_LAYOUT,
    steps: {
      ...mutant?.options.steps,
      ...(attempt !== undefined && { mintAttempt: () => attempt }),
    },
  });

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

interface Call {
  readonly op: "get" | "put";
  readonly key: string;
  readonly ifNoneMatch?: string;
  readonly ifMatch?: string;
  readonly body?: Uint8Array;
}

/** Record every get and put `inner` is asked for. */
const tap = (inner: Storage, calls: Call[]): Storage => ({
  get: (key, opts) => {
    calls.push({ op: "get", key });
    return inner.get(key, opts);
  },
  put: (key, body, opts) => {
    calls.push({
      op: "put",
      key,
      body,
      ...(opts?.ifNoneMatch !== undefined && { ifNoneMatch: opts.ifNoneMatch }),
      ...(opts?.ifMatch !== undefined && { ifMatch: opts.ifMatch }),
    });
    return inner.put(key, body, opts);
  },
  delete: (key, opts) => inner.delete(key, opts),
  list: (prefix, opts) => inner.list(prefix, opts),
});

/** A tree head for a fresh collection: no `proto_tree` yet. */
const freshHead = (): CurrentJson => ({
  schema_version: 3,
  snapshot: null,
  tail_hint: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "", claimed_at: "" },
  snapshot_bytes: 0,
  snapshot_rows: 0,
});

/** A fold record body as stored. */
interface StoredRecord {
  readonly format: string;
  readonly schema_version: number;
  readonly attempt: string;
  readonly base: FoldRecordBase;
  readonly result: { readonly floor: number; readonly root: string | null };
  readonly fresh: readonly string[];
  readonly superseded: readonly string[];
}

/** A row change: the row's new document, or `null` to delete it. */
type Change = readonly [id: string, value: number | null];

/** A captured, planned fold that has not published. */
interface PreparedFold {
  readonly head: TreeHead;
  readonly root: DecodedTreeNode | null;
  readonly plan: TreeFoldPlan;
  readonly floor: number;
  readonly changes: readonly Change[];
}

/** One collection in memory, behind the full storage stack. */
class Bucket {
  readonly memory = new MemoryStorage();
  /** Writes that reached the bucket, in order. */
  readonly applied: Call[] = [];
  /** Calls the publisher issued, above the adapter retry. */
  readonly calls: Call[] = [];
  readonly faults = abortingStorage(tap(this.memory, this.applied));
  readonly storage = tap(adapterRetry(this.faults.storage), this.calls);
  /** The rows the head's tree must hold. */
  readonly rows = new Map<string, DocumentData>();
  #attempts = 0;

  static async open(head: CurrentJson = freshHead()): Promise<Bucket> {
    const bucket = new Bucket();
    await createCurrentJson(bucket.memory, HEAD, head);
    return bucket;
  }

  /** A fresh bucket holding a depth-3 tree of `k00`..`k19` at the small-scope layout. */
  static async seeded(): Promise<Bucket> {
    const bucket = await Bucket.open();
    const changes: Change[] = Array.from({ length: 20 }, (_, i) => [
      `k${String(i).padStart(2, "0")}`,
      i,
    ]);
    const outcome = await bucket.publish(await bucket.prepare(changes));
    expect(outcome.kind).toBe("published");
    return bucket;
  }

  async head(): Promise<TreeHead> {
    const head = await readTreeHead(this.memory, PREFIX);
    if (head === null) {
      throw new Error("no head");
    }
    return head;
  }

  /** Capture the head and its root, and plan `changes` onto them. */
  async prepare(
    changes: readonly Change[],
    options: { readonly config?: TreeConfig; readonly chunkKey?: ChunkKey } = {},
  ): Promise<PreparedFold> {
    const config = options.config ?? configFor();
    const head = await readTreeHead(this.storage, PREFIX);
    if (head === null) {
      throw new Error("no head");
    }
    const root = await readTreeRoot(this.storage, head, config);
    const survivors = new Map<string, Change>(changes.map((change) => [change[0], change]));
    const plan = await planFold({
      prefix: PREFIX,
      root,
      chunkKey: options.chunkKey ?? (await importTreeChunkKey(head)) ?? chunkKey,
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
   * Publish `fold` under `mutant` with the next attempt identity, and
   * commit its rows to {@link rows} when it publishes.
   */
  async publish(
    fold: PreparedFold,
    options: {
      readonly mutant?: TreeMutant;
      readonly attempt?: string;
      readonly storage?: Storage;
      readonly chunkSalt?: string;
      readonly meanEntryBytes?: number;
    } = {},
  ): Promise<TreePublishOutcome> {
    this.#attempts += 1;
    const outcome = await publishTree({
      storage: options.storage ?? this.storage,
      prefix: PREFIX,
      head: fold.head,
      root: fold.root,
      plan: fold.plan,
      floor: fold.floor,
      chunkSalt: options.chunkSalt ?? TREE_TEST_CHUNK_SALT,
      ...(options.meanEntryBytes !== undefined && { meanEntryBytes: options.meanEntryBytes }),
      config: configFor(options.mutant, options.attempt ?? attemptOf(this.#attempts)),
    });
    if (outcome.kind === "published") {
      this.commit(fold);
    }
    return outcome;
  }

  /** Apply `fold`'s changes to the expected rows. */
  commit(fold: PreparedFold): void {
    for (const [id, value] of fold.changes) {
      if (value === null) {
        this.rows.delete(id);
      } else {
        this.rows.set(id, { _id: id, v: value });
      }
    }
  }

  /** The physical oracle's findings over the bucket against {@link rows}, plus tree-head checks. */
  async violations(): Promise<string[]> {
    const image = await captureTreeImage(this.memory, PREFIX);
    const head = await this.head();
    const report = checkTreeImage({
      image,
      prefix: PREFIX,
      layout: SMALL_LAYOUT,
      expectedRows: this.rows.values(),
      expectedFloor: head.json.log_seq_start,
    });
    const found = report.violations.map((v) => `[${v.kind}] ${v.message}`);
    if (head.json.snapshot !== null) {
      found.push("head snapshot is not null");
    }
    if ([...image.keys()].some((key) => key.startsWith(`${PREFIX}/snapshot/`))) {
      found.push("a snapshot object exists");
    }
    return found;
  }

  /** Node keys the oracle finds reachable from the head's root. */
  async reachable(): Promise<ReadonlySet<string>> {
    return new Set(
      checkTreeImage({
        image: await captureTreeImage(this.memory, PREFIX),
        prefix: PREFIX,
        layout: SMALL_LAYOUT,
      }).reachableKeys,
    );
  }

  /** The fold record stored at `key`, parsed. */
  async record(key: string): Promise<StoredRecord> {
    const got = await this.memory.get(key);
    if (got === null) {
      throw new Error(`no record at ${key}`);
    }
    return JSON.parse(new TextDecoder().decode(got.body)) as StoredRecord;
  }

  /** Node keys the oracle finds unreachable from the head's root. */
  async unreachable(): Promise<readonly string[]> {
    return checkTreeImage({
      image: await captureTreeImage(this.memory, PREFIX),
      prefix: PREFIX,
      layout: SMALL_LAYOUT,
    }).unreachableNodeKeys;
  }
}

/** Changes that rewrite a few paths of the seeded tree: an update, an insert and a delete. */
const MIXED: readonly Change[] = [
  ["k03", 103],
  ["k10a", 7],
  ["k16", null],
];

/**
 * `tree` with its first child that `pick` selects, given the child and
 * its slot's level, replaced by `replace` of it. Every branch is rebuilt
 * with `plannedBranch`, so the summaries above the change stay
 * consistent and only the reuse proof can refuse it.
 */
const replaceChild = (
  tree: PlannedTree,
  pick: (child: PlannedChild, level: number) => boolean,
  replace: (child: PlannedChild) => PlannedChild,
): PlannedTree => {
  let done = false;
  const walk = (node: PlannedNode): PlannedNode => {
    if (node.kind === "leaf") {
      return node;
    }
    const children = node.children.map((child) => {
      if (done) {
        return child;
      }
      if (pick(child, node.level - 1)) {
        done = true;
        return replace(child);
      }
      return child.kind === "fresh" ? { kind: "fresh" as const, node: walk(child.node) } : child;
    });
    return plannedBranch(node.level, children);
  };
  const root = walk(tree.root);
  if (!done) {
    throw new Error("no child matched");
  }
  return { ...tree, root };
};

/**
 * Publish `fold` with `plan` in place of its own, and return how it was
 * refused: `undefined` when it was refused `Internal` with a message
 * containing `reason` and wrote nothing, else what happened instead.
 */
const refusal = async (
  bucket: Bucket,
  fold: PreparedFold,
  reason: string,
  options: Parameters<Bucket["publish"]>[1] = {},
): Promise<string | undefined> => {
  const start = bucket.applied.length;
  try {
    const outcome = await bucket.publish(fold, options);
    return `expected a refusal, got ${outcome.kind}`;
  } catch (error) {
    if (!(error instanceof BaerlyError) || error.code !== "Internal") {
      return `expected Internal, got ${String(error)}`;
    }
    if (!error.message.includes(reason)) {
      return `refused for another reason: ${error.message}`;
    }
  }
  return bucket.applied.length === start ? undefined : "the refused publication wrote";
};

/** The fresh node keys `fold` publishes under `attempt`. */
const freshKeys = async (fold: PreparedFold, attempt: string): Promise<string[]> => {
  const sealed = await sealTree(fold.plan.tree, { prefix: PREFIX, attempt, floor: fold.floor });
  return sealed.levels.flat().map((node) => node.key);
};

// ---------------------------------------------------------------------
// Checks shared with the mutation block. Each returns the first failure,
// or `undefined`.
// ---------------------------------------------------------------------

/**
 * The fold record first, children before parents, the head CAS last:
 * the record and every fresh node are creates, each branch comes after
 * every fresh child it names, then one head CAS `If-Match` the captured
 * ETag.
 */
const writeOrderFailure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const bucket = await Bucket.seeded();
  const fold = await bucket.prepare(MIXED);
  const start = bucket.applied.length;
  try {
    await bucket.publish(fold, { mutant });
  } catch (error) {
    return `the publication failed: ${String(error)}`;
  }
  const writes = bucket.applied.slice(start);
  const [first] = writes;
  if (first === undefined || !first.key.startsWith(RECORDS) || first.ifNoneMatch !== "*") {
    return `the first write is ${first?.key ?? "nothing"}, not a fold-record create`;
  }
  const done = new Set<string>();
  for (const [i, write] of writes.slice(1).entries()) {
    if (write.key === HEAD) {
      if (i !== writes.length - 2) {
        return `the head CAS is write ${i + 2} of ${writes.length}`;
      }
      if (write.ifMatch !== fold.head.etag) {
        return "the head CAS is not If-Match the captured ETag";
      }
      continue;
    }
    if (!write.key.startsWith(NODES) || write.ifNoneMatch !== "*") {
      return `write ${write.key} is not a node create`;
    }
    const body = JSON.parse(new TextDecoder().decode(write.body)) as {
      children?: { attempt: string; sha256: string }[];
    };
    for (const child of body.children ?? []) {
      const key = `${NODES}${child.attempt}/${child.sha256}`;
      if (child.attempt === parseTreeNodeKey(PREFIX, write.key)!.attempt && !done.has(key)) {
        return `${write.key} was created before its fresh child ${key}`;
      }
    }
    done.add(write.key);
  }
  return writes.at(-1)?.key === HEAD ? undefined : "the publication wrote no head";
};

/**
 * The record of the seeded tree's mixed fold, against the physical
 * oracle: `fresh` is exactly the nodes the new root reaches and the
 * captured one does not, `superseded` exactly the reverse, and `base`
 * and `result` name the captured head and the published root.
 */
const recordExactnessFailure = (mutant?: TreeMutant): Promise<string | undefined> =>
  exactnessOfFold(MIXED, mutant);

/**
 * As {@link recordExactnessFailure}, for a fold that updates one row and
 * deletes an absent one: the plan reads below a branch it then reuses
 * whole, so only the downward closure from that reused ref keeps the
 * read nodes under it out of `superseded`.
 */
const downwardClosureFailure = (mutant?: TreeMutant): Promise<string | undefined> =>
  exactnessOfFold(
    [
      ["k01", 99],
      ["k15x", null],
    ],
    mutant,
  );

/** The exactness of the record of `changes` published onto the seeded tree under `mutant`. */
const exactnessOfFold = async (
  changes: readonly Change[],
  mutant?: TreeMutant,
): Promise<string | undefined> => {
  const bucket = await Bucket.seeded();
  const fold = await bucket.prepare(changes);
  const before = await bucket.reachable();
  let outcome: TreePublishOutcome;
  try {
    outcome = await bucket.publish(fold, { mutant });
  } catch (error) {
    return `the publication failed: ${String(error)}`;
  }
  if (outcome.kind !== "published") {
    return `the publication was ${outcome.kind}`;
  }
  return exactnessFailure(bucket, fold, outcome, before);
};

/**
 * How the record of `outcome`, a published fold of `fold`, departs from
 * the oracle's reachable sets before (`before`) and after publication.
 */
const exactnessFailure = async (
  bucket: Bucket,
  fold: PreparedFold,
  outcome: TreePublishOutcome,
  before: ReadonlySet<string>,
): Promise<string | undefined> => {
  const after = await bucket.reachable();
  const record = await bucket.record(outcome.record);
  const fresh = record.fresh.map((sha) => `${NODES}${outcome.attempt}/${sha}`);
  const superseded = record.superseded.map((ref) => `${NODES}${ref}`);
  const expectedFresh = [...after].filter((key) => !before.has(key)).toSorted();
  const expectedSuperseded = [...before].filter((key) => !after.has(key)).toSorted();
  const capturedRoot = fold.head.root === null ? null : parseTreeNodeKey(PREFIX, fold.head.root);
  const expectedBase: FoldRecordBase = {
    floor: fold.head.json.log_seq_start,
    root: capturedRoot === null ? null : `${capturedRoot.attempt}/${capturedRoot.sha256}`,
    attempt: fold.head.attempt,
    generation: fold.head.json.generation ?? null,
  };
  const found: string[] = [];
  if (JSON.stringify(fresh) !== JSON.stringify(expectedFresh)) {
    found.push(`fresh ${JSON.stringify(fresh)}, oracle ${JSON.stringify(expectedFresh)}`);
  }
  if (JSON.stringify(superseded) !== JSON.stringify(expectedSuperseded)) {
    found.push(
      `superseded ${JSON.stringify(superseded)}, oracle ${JSON.stringify(expectedSuperseded)}`,
    );
  }
  if (JSON.stringify(record.base) !== JSON.stringify(expectedBase)) {
    found.push(`base ${JSON.stringify(record.base)}, captured ${JSON.stringify(expectedBase)}`);
  }
  const rootSha = outcome.root === null ? null : parseTreeNodeKey(PREFIX, outcome.root)!.sha256;
  if (record.result.floor !== fold.floor || record.result.root !== rootSha) {
    found.push(`result ${JSON.stringify(record.result)}`);
  }
  const key = parseTreeRecordKey(PREFIX, outcome.record);
  if (key?.floor !== expectedBase.floor || key.attempt !== outcome.attempt) {
    found.push(`record key ${outcome.record}`);
  }
  return found.length === 0 ? undefined : found.join("; ");
};

/**
 * A publication of the mixed fold either publishes or is refused;
 * returns how it was refused. Unmutated it must publish: the record's
 * base is the captured head, so the record tripwire stays quiet.
 */
const recordTripwireFailure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const bucket = await Bucket.seeded();
  const fold = await bucket.prepare(MIXED);
  try {
    await bucket.publish(fold, { mutant });
    return undefined;
  } catch (error) {
    return `refused: ${String(error)}`;
  }
};

/**
 * A crash before the K-th storage call of a publication, for every K:
 * the publication either completed or left the head on the captured
 * tree, and the physical oracle accepts the bucket either way.
 */
const crashSweepFailure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  for (let k = 1; ; k++) {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    bucket.faults.armAt(k);
    let outcome: TreePublishOutcome | undefined;
    try {
      outcome = await bucket.publish(fold, { mutant });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        return `crash at call ${k}: unexpected ${String(error)}`;
      }
    }
    const head = await bucket.head();
    if (head.json.log_seq_start === fold.floor && outcome === undefined) {
      bucket.commit(fold);
    }
    const found = await bucket.violations();
    if (found.length > 0) {
      return `crash at call ${k}: ${found.join("; ")}`;
    }
    if (bucket.faults.faultsFired() === 0) {
      return outcome?.kind === "published" ? undefined : `no crash at call ${k}, yet not published`;
    }
  }
};

/**
 * A plan that claims the newer root as its base but was built on an
 * older one, reusing a child of the older root that the newer root no
 * longer reaches: the reuse proof must refuse it before any write.
 */
const staleReuseFailure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const bucket = await Bucket.seeded();
  // Rewrites the right side of the root; reuses its left child.
  const stale = await bucket.prepare([["k19", 119]]);
  // Rewrites the left child.
  await bucket.publish(await bucket.prepare([["k00", 100]]));
  const now = await bucket.prepare([]);
  return refusal(
    bucket,
    { ...stale, head: now.head, root: now.root, floor: now.floor + 1, plan: rebased(stale, now) },
    "is not live under the captured root",
    { mutant },
  );
};

/**
 * As {@link staleReuseFailure}, but the stale ref is a child of a node
 * the plan read from the older root: that node is not reachable from the
 * newer root, so it proves nothing live.
 */
const unreachableReadFailure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const bucket = await Bucket.seeded();
  // Reads the left level-2 branch and reuses its other children.
  const stale = await bucket.prepare([["k13", 113]]);
  // Rewrites another child of that branch, and the branch itself.
  await bucket.publish(await bucket.prepare([["k06", 106]]));
  const now = await bucket.prepare([]);
  return refusal(
    bucket,
    { ...stale, head: now.head, root: now.root, floor: now.floor + 1, plan: rebased(stale, now) },
    "is not live under the captured root",
    { mutant },
  );
};

/** `stale`'s plan, relabelled as if it had been built on `now`'s root. */
const rebased = (stale: PreparedFold, now: PreparedFold): TreeFoldPlan => ({
  ...stale.plan,
  base: now.root?.key ?? null,
});

/**
 * A create that conflicts with a different body at its key: the
 * publication fails `InvalidResponse` and leaves the head alone.
 */
const foreignBodyFailure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const bucket = await Bucket.seeded();
  const fold = await bucket.prepare(MIXED);
  const attempt = attemptOf(0xf00d);
  const [first] = await freshKeys(fold, attempt);
  await bucket.memory.put(first!, new TextEncoder().encode("{}"), { ifNoneMatch: "*" });
  try {
    await bucket.publish(fold, { mutant, attempt });
  } catch (error) {
    if ((error as BaerlyError).code !== "InvalidResponse") {
      return `expected InvalidResponse, got ${String(error)}`;
    }
    const head = await bucket.head();
    return head.etag === fold.head.etag ? undefined : "the head moved";
  }
  return "a conflicting create holding different bytes was adopted";
};

// ---------------------------------------------------------------------
// Write order and faults
// ---------------------------------------------------------------------

describe("write order", () => {
  test("the seeded tree is depth 3, and the mixed fold reuses nodes", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    expect(fold.root?.node.level).toBe(3);
    const sealed = await sealTree(fold.plan.tree, {
      prefix: PREFIX,
      attempt: attemptOf(9),
      floor: fold.floor,
    });
    expect(sealed.reused.length).toBeGreaterThan(0);
    expect(sealed.levels.flat().length).toBeGreaterThan(2);
  });

  test("children are created before parents, and the head CAS is the last write", async () => {
    await expect(writeOrderFailure()).resolves.toBeUndefined();
  });

  test("a level's creates are sent only after every create below it has completed", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const attempt = attemptOf(0xc0de);
    const sealed = await sealTree(fold.plan.tree, {
      prefix: PREFIX,
      attempt,
      floor: fold.floor,
    });
    expect(sealed.levels.filter((level) => level.length > 0).length).toBeGreaterThan(2);
    const levelOf = new Map(
      sealed.levels.flatMap((nodes, level) => nodes.map((node) => [node.key, level] as const)),
    );
    const pending = new Set(levelOf.keys());
    const early: string[] = [];
    const storage: Storage = {
      ...bucket.storage,
      put: async (key, body, opts) => {
        const level = key.startsWith(RECORDS)
          ? Number.NEGATIVE_INFINITY
          : (levelOf.get(key) ?? Number.POSITIVE_INFINITY);
        for (const other of pending) {
          if (levelOf.get(other)! < level) {
            early.push(`${key} sent before ${other} completed`);
          }
        }
        // Let every other create in flight start before this one lands.
        await new Promise((resolve) => setTimeout(resolve, 1));
        const result = await bucket.storage.put(key, body, opts);
        pending.delete(key);
        return result;
      },
    };
    await expect(bucket.publish(fold, { storage, attempt })).resolves.toMatchObject({
      kind: "published",
    });
    expect(early).toEqual([]);
  });

  test("a crash before any storage call leaves the captured tree or the new one", async () => {
    await expect(crashSweepFailure()).resolves.toBeUndefined();
  });

  test("a lost reply on any storage call still publishes, adopting a landed create", async () => {
    for (let k = 1; ; k++) {
      const bucket = await Bucket.seeded();
      const fold = await bucket.prepare(MIXED);
      const fresh = await freshKeys(fold, attemptOf(2));
      bucket.faults.armPostApplyAt(k);
      const outcome = await bucket.publish(fold);
      expect(outcome).toMatchObject({ kind: "published", written: fresh.length });
      await expect(bucket.violations()).resolves.toEqual([]);
      const [fault] = bucket.faults.postApplied();
      if (fault === undefined) {
        break;
      }
      const lostCreate = fault.op === "put" && fault.key.startsWith(NODES);
      expect(outcome.adopted, `lost reply on ${fault.op} ${fault.key}`).toBe(lostCreate ? 1 : 0);
    }
  });

  test("the publisher never re-sends a write: one record create, one create per node and one head CAS", async () => {
    for (const prefix of [NODES, RECORDS]) {
      const bucket = await Bucket.seeded();
      const fold = await bucket.prepare(MIXED);
      const fresh = await freshKeys(fold, attemptOf(2));
      bucket.faults.armPostApplyAt(1, { prefix, ops: ["put"] });
      const start = bucket.calls.length;
      const outcome = await bucket.publish(fold);
      expect(outcome).toMatchObject({ kind: "published", adopted: prefix === NODES ? 1 : 0 });
      expect(bucket.faults.postApplied().map((fault) => fault.key.startsWith(prefix))).toEqual([
        true,
      ]);
      const puts = bucket.calls.slice(start).filter((call) => call.op === "put");
      expect(puts.map((call) => call.key).toSorted()).toEqual(
        [...fresh, HEAD, outcome.record].toSorted(),
      );
    }
  });
});

describe("create-conflict adoption", () => {
  test("a conflicting create holding different bytes is InvalidResponse", async () => {
    await expect(foreignBodyFailure()).resolves.toBeUndefined();
  });

  test("a conflicting create whose key reads back empty is WriteConflict", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const storage: Storage = {
      ...bucket.storage,
      put: (key, body, opts) =>
        key.startsWith(NODES)
          ? Promise.reject(new BaerlyError("WriteConflict", "injected: precondition failed"))
          : bucket.storage.put(key, body, opts),
    };
    await expect(bucket.publish(fold, { storage })).rejects.toMatchObject({
      code: "WriteConflict",
    });
    await expect(bucket.head()).resolves.toMatchObject({ etag: fold.head.etag });
  });

  test("a create that fails otherwise fails the attempt with its code, and no head CAS is sent", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const sent: string[] = [];
    const storage: Storage = {
      ...bucket.storage,
      put: (key, body, opts) => {
        sent.push(key);
        return key.startsWith(NODES)
          ? Promise.reject(new BaerlyError("AccessDenied", "injected: denied"))
          : bucket.storage.put(key, body, opts);
      },
    };
    await expect(bucket.publish(fold, { storage })).rejects.toMatchObject({ code: "AccessDenied" });
    expect(sent).not.toContain(HEAD);
    await expect(bucket.head()).resolves.toMatchObject({ etag: fold.head.etag });
  });
});

// ---------------------------------------------------------------------
// Head CAS fate
// ---------------------------------------------------------------------

describe("head CAS fate", () => {
  test("a head write between capture and CAS makes the attempt cas-lost, leaving only unreachable nodes", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    await casUpdateCurrentJson(bucket.memory, HEAD, (head) => ({
      ...head,
      tail_hint: head.tail_hint + 5,
    }));
    const outcome = await bucket.publish(fold);
    expect(outcome.kind).toBe("cas-lost");
    await expect(bucket.head()).resolves.toMatchObject({ root: fold.head.root });
    await expect(bucket.violations()).resolves.toEqual([]);
    const fresh = await freshKeys(fold, outcome.attempt);
    await expect(bucket.unreachable()).resolves.toEqual(expect.arrayContaining(fresh));
  });

  test("a won CAS superseded before the re-read is cas-lost", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const captured = fold.head.root;
    const storage: Storage = {
      ...bucket.storage,
      put: async (key, body, opts) => {
        const result = await bucket.storage.put(key, body, opts);
        if (key !== HEAD) {
          return result;
        }
        // Another fold lands on top of this one, then the reply is lost.
        await casUpdateCurrentJson(bucket.memory, HEAD, (head) => ({
          ...head,
          proto_tree: { ...(head as TreeHeadJson).proto_tree!, root: captured },
        }));
        throw new BaerlyError("NetworkError", "injected: reply lost");
      },
    };
    await expect(bucket.publish(fold, { storage })).resolves.toMatchObject({ kind: "cas-lost" });
  });

  test("a lost reply on a CAS publishing an empty tree is resolved as a win", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare([...bucket.rows.keys()].map((id) => [id, null] as const));
    expect(fold.plan.tree).toBeNull();
    bucket.faults.armPostApplyAt(1, { prefix: HEAD, ops: ["put"] });
    await expect(bucket.publish(fold)).resolves.toMatchObject({ kind: "published", root: null });
    expect(bucket.faults.postApplied()).toHaveLength(1);
    await expect(bucket.violations()).resolves.toEqual([]);
    await expect(bucket.head()).resolves.toMatchObject({
      json: { log_seq_start: fold.floor, snapshot_rows: 0, snapshot_bytes: 0 },
    });
  });

  test("an empty new root loses to an empty head at another floor", async () => {
    const bucket = await Bucket.open();
    const empty: Change[] = [
      ["a", 1],
      ["a", null],
    ];
    await expect(bucket.publish(await bucket.prepare(empty))).resolves.toMatchObject({
      kind: "published",
      root: null,
    });
    const fold = await bucket.prepare(empty);
    // A tail-hint refresh lands first: same salt, installer and empty root, the old floor.
    await casUpdateCurrentJson(bucket.memory, HEAD, (head) => ({
      ...head,
      tail_hint: head.tail_hint + 5,
    }));
    await expect(bucket.publish(fold)).resolves.toMatchObject({ kind: "cas-lost" });
    await expect(bucket.head()).resolves.toMatchObject({
      json: { log_seq_start: fold.head.json.log_seq_start },
    });
  });

  test("an empty new root loses to an empty head with another installer or salt at the same floor", async () => {
    for (const competitor of [
      { attempt: attemptOf(0xbad), chunk_salt: TREE_TEST_CHUNK_SALT },
      { attempt: attemptOf(1), chunk_salt: TREE_SECOND_TEST_CHUNK_SALT },
    ]) {
      // A fresh collection: both first folds mint their own salt.
      const bucket = await Bucket.open();
      const fold = await bucket.prepare([
        ["a", 1],
        ["a", null],
      ]);
      expect(fold.plan.tree).toBeNull();
      await casUpdateCurrentJson(bucket.memory, HEAD, (head) => ({
        ...head,
        log_seq_start: fold.floor,
        tail_hint: fold.floor,
        proto_tree: { root: null, ...competitor },
      }));
      await expect(bucket.publish(fold)).resolves.toMatchObject({ kind: "cas-lost" });
    }
  });

  test("two attempts publishing the same empty tree at the same floor never both report published", async () => {
    const bucket = await Bucket.seeded();
    const empty = [...bucket.rows.keys()].map((id) => [id, null] as const);
    const first = await bucket.prepare(empty);
    const second = await bucket.prepare(empty);
    // The first lands; the second's CAS conflicts and its re-read sees an equal empty head.
    await expect(bucket.publish(first)).resolves.toMatchObject({ kind: "published", root: null });
    await expect(bucket.publish(second)).resolves.toMatchObject({ kind: "cas-lost" });
  });
});

// ---------------------------------------------------------------------
// Fold record
// ---------------------------------------------------------------------

describe("fold record", () => {
  test("the mixed fold's record names exactly what it creates and what it supersedes", async () => {
    await expect(recordExactnessFailure()).resolves.toBeUndefined();
  });

  test("a read node under a reused branch is not superseded", async () => {
    await expect(downwardClosureFailure()).resolves.toBeUndefined();
  });

  test("the record is canonical JSON of its fields, in order, keyed by the hash of its body", async () => {
    const bucket = await Bucket.seeded();
    const outcome = await bucket.publish(await bucket.prepare(MIXED));
    const body = (await bucket.memory.get(outcome.record))!.body;
    const record = await bucket.record(outcome.record);
    expect(Object.keys(record)).toEqual([
      "format",
      "schema_version",
      "attempt",
      "base",
      "result",
      "fresh",
      "superseded",
    ]);
    expect(Object.keys(record.base)).toEqual(["floor", "root", "attempt", "generation"]);
    expect(Object.keys(record.result)).toEqual(["floor", "root"]);
    expect(record).toMatchObject({
      format: "baerly-tree-fold-record-proto",
      schema_version: 1,
      attempt: outcome.attempt,
    });
    expect(new TextDecoder().decode(body)).toBe(JSON.stringify(record));
    expect(parseTreeRecordKey(PREFIX, outcome.record)?.sha256).toBe(await sha256Hex(body));
    expect(record.fresh).toEqual(record.fresh.toSorted());
    expect(record.superseded).toEqual(record.superseded.toSorted());
  });

  test("the first fold of a fresh collection supersedes nothing; its base has no root or installer", async () => {
    const bucket = await Bucket.open({ ...freshHead(), generation: "0a1b" });
    const fold = await bucket.prepare([["a", 1]]);
    const outcome = await bucket.publish(fold);
    const record = await bucket.record(outcome.record);
    expect(record.base).toEqual({ floor: 0, root: null, attempt: null, generation: "0a1b" });
    expect(record.superseded).toEqual([]);
    expect(record.fresh).toEqual([parseTreeNodeKey(PREFIX, outcome.root!)!.sha256]);
    expect(outcome.record.startsWith(`${RECORDS}0000000000000000/`)).toBe(true);
  });

  test("a fold that empties the collection still writes a record, superseding the whole captured tree", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare([...bucket.rows.keys()].map((id) => [id, null] as const));
    const before = await bucket.reachable();
    const outcome = await bucket.publish(fold);
    expect(outcome).toMatchObject({ kind: "published", root: null });
    const record = await bucket.record(outcome.record);
    expect(record.result).toEqual({ floor: fold.floor, root: null });
    expect(record.fresh).toEqual([]);
    expect(record.superseded.map((ref) => `${NODES}${ref}`)).toEqual([...before].toSorted());
    expect(record.base.attempt).toBe(fold.head.attempt);
  });

  test("every record of a sequence of folds names the installer it captured", async () => {
    const bucket = await Bucket.seeded();
    const first = await bucket.publish(await bucket.prepare([["k01", 1]]));
    const second = await bucket.publish(await bucket.prepare([["k02", 2]]));
    await expect(bucket.record(second.record)).resolves.toMatchObject({
      base: { attempt: first.attempt },
    });
  });

  test("a record whose base is not the head the CAS is sent against is Internal before any write", async () => {
    const tamper: Record<keyof FoldRecordBase, (base: FoldRecordBase) => FoldRecordBase> = {
      floor: (base) => ({ ...base, floor: base.floor + 1 }),
      root: (base) => ({ ...base, root: `${attemptOf(0xbad)}/${"0".repeat(64)}` }),
      attempt: (base) => ({ ...base, attempt: attemptOf(0xbad) }),
      generation: (base) => ({ ...base, generation: "another" }),
    };
    const found: Record<string, string | undefined> = {};
    for (const [field, change] of Object.entries(tamper)) {
      const bucket = await Bucket.seeded();
      const fold = await bucket.prepare(MIXED);
      const mutant: TreeMutant = {
        name: `record-base-${field}`,
        defect: `the record's base ${field} is wrong`,
        options: { steps: { recordBase: (head) => change(foldRecordBase(head)) } },
      };
      found[field] = await refusal(bucket, fold, `the record's base ${field}`, { mutant });
    }
    expect(found).toEqual({
      floor: undefined,
      root: undefined,
      attempt: undefined,
      generation: undefined,
    });
  });

  test("record-floor-not-captured is refused by the tripwire, with no write", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    await expect(
      refusal(bucket, fold, "the record's base floor", { mutant: RECORD_FLOOR_NOT_CAPTURED }),
    ).resolves.toBeUndefined();
  });

  test("a write order that does not put the record first and the head last is Internal before any write", async () => {
    const found: Record<string, string | undefined> = {};
    for (const mutant of [PUBLISH_NODES_BEFORE_RECORD, PUBLISH_HEAD_BEFORE_NODES]) {
      const bucket = await Bucket.seeded();
      found[mutant.name] = await refusal(
        bucket,
        await bucket.prepare(MIXED),
        "a publication must write exactly one",
        { mutant },
      );
    }
    expect(found).toEqual({
      [PUBLISH_NODES_BEFORE_RECORD.name]: undefined,
      [PUBLISH_HEAD_BEFORE_NODES.name]: undefined,
    });
  });

  test("a record create that conflicts with different bytes is InvalidResponse; one that reads back empty is WriteConflict", async () => {
    for (const [plant, code] of [
      [true, "InvalidResponse"],
      [false, "WriteConflict"],
    ] as const) {
      const bucket = await Bucket.seeded();
      const fold = await bucket.prepare(MIXED);
      const start = bucket.applied.length;
      const storage: Storage = {
        ...bucket.storage,
        put: async (key, body, opts) => {
          if (!key.startsWith(RECORDS)) {
            return bucket.storage.put(key, body, opts);
          }
          if (plant) {
            await bucket.memory.put(key, new TextEncoder().encode("{}"));
          }
          throw new BaerlyError("WriteConflict", "injected: precondition failed");
        },
      };
      await expect(bucket.publish(fold, { storage })).rejects.toMatchObject({ code });
      expect(bucket.applied.slice(start).filter((write) => !write.key.startsWith(RECORDS))).toEqual(
        [],
      );
    }
  });

  test("a crash after the record and before the head leaves the record, and the captured head", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    // The record create is the first storage call; crash on the second.
    bucket.faults.armAt(2);
    await expect(bucket.publish(fold)).rejects.toMatchObject({ name: "AbortError" });
    const image = await captureTreeImage(bucket.memory, PREFIX);
    // The seeding fold's record, and this attempt's.
    expect([...image.keys()].filter((key) => key.startsWith(RECORDS))).toHaveLength(2);
    await expect(bucket.head()).resolves.toMatchObject({ etag: fold.head.etag });
  });
});

// ---------------------------------------------------------------------
// Reuse and attempt identity
// ---------------------------------------------------------------------

describe("captured-live reuse", () => {
  test("a reused child of an older root is refused before any write", async () => {
    await expect(staleReuseFailure()).resolves.toBeUndefined();
  });

  test("a read node the captured root does not reach proves none of its children live", async () => {
    await expect(unreachableReadFailure()).resolves.toBeUndefined();
  });

  test("a plan built on another root is Internal, even when every ref it reuses survives", async () => {
    // A depth-1 tree: leaves k00..k02 and k03..k04 under one root.
    const bucket = await Bucket.open();
    await bucket.publish(
      await bucket.prepare(Array.from({ length: 5 }, (_, i) => [`k0${i}`, i] as const)),
    );
    const stale = await bucket.prepare([["k00", 100]]);
    await bucket.publish(await bucket.prepare([["k01", 101]]));
    const now = await bucket.prepare([]);
    const live = capturedLiveRefs(now.root, []);
    const sealed = await sealTree(stale.plan.tree, {
      prefix: PREFIX,
      attempt: attemptOf(9),
      floor: now.floor + 1,
    });
    expect(sealed.reused.length).toBeGreaterThan(0);
    for (const entry of sealed.reused) {
      expect(live.has(`${entry.attempt}/${entry.sha256}`)).toBe(true);
    }
    await expect(
      refusal(
        bucket,
        { ...stale, head: now.head, root: now.root, floor: now.floor + 1 },
        "built on a root other than the captured one",
      ),
    ).resolves.toBeUndefined();
  });

  test("a reused ref whose entry differs from the proven one in any summary field is Internal", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const changes: Record<string, (entry: TreeChildEntry) => Partial<TreeChildEntry>> = {
      lo: (entry) => ({ lo: entry.hi }),
      hi: (entry) => ({ hi: entry.lo }),
      rows: (entry) => ({ rows: entry.rows + 1 }),
      bytes: (entry) => ({ bytes: entry.bytes + 1 }),
    };
    const found: Record<string, string | undefined> = {};
    for (const [field, change] of Object.entries(changes)) {
      const tree = replaceChild(
        fold.plan.tree!,
        (child) => child.kind === "reused" && child.entry.lo !== child.entry.hi,
        (child) => {
          const entry = (child as Extract<PlannedChild, { kind: "reused" }>).entry;
          return { kind: "reused", entry: { ...entry, ...change(entry) } };
        },
      );
      found[field] = await refusal(
        bucket,
        { ...fold, plan: { ...fold.plan, tree } },
        "is not live",
      );
    }
    expect(found).toEqual({ lo: undefined, hi: undefined, rows: undefined, bytes: undefined });
  });

  test("a live leaf reused in a level-1 slot is Internal", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const leaf = [...capturedLiveRefs(fold.root, fold.plan.read).values()].find(
      (ref) => ref.level === 0,
    );
    expect(leaf).toBeDefined();
    const tree = replaceChild(
      fold.plan.tree!,
      (child, level) => child.kind === "fresh" && level === 1,
      () => ({ kind: "reused", entry: leaf!.entry }),
    );
    await expect(
      refusal(bucket, { ...fold, plan: { ...fold.plan, tree } }, "at level 1"),
    ).resolves.toBeUndefined();
  });

  test("every reused ref of a published fold is reachable from the captured root", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const outcome = await bucket.publish(fold);
    expect(outcome.kind).toBe("published");
    const sealed = await sealTree(fold.plan.tree, {
      prefix: PREFIX,
      attempt: outcome.attempt,
      floor: fold.floor,
    });
    const before = checkTreeImage({
      image: await captureTreeImage(bucket.memory, PREFIX),
      prefix: PREFIX,
      layout: SMALL_LAYOUT,
    }).reachableKeys;
    for (const entry of sealed.reused) {
      expect(before).toContain(`${NODES}${entry.attempt}/${entry.sha256}`);
    }
  });
});

describe("attempt identity", () => {
  test("each publication mints a fresh 128-bit identity that every fresh node carries", async () => {
    const bucket = await Bucket.seeded();
    const attempts: string[] = [];
    for (const changes of [[["k01", 1]], [["k02", 2]]] as const) {
      const fold = await bucket.prepare(changes);
      const start = bucket.applied.length;
      const outcome = await publishTree({
        storage: bucket.storage,
        prefix: PREFIX,
        head: fold.head,
        root: fold.root,
        plan: fold.plan,
        floor: fold.floor,
        chunkSalt: TREE_TEST_CHUNK_SALT,
        config: configFor(),
      });
      expect(outcome.attempt).toMatch(/^[0-9a-f]{32}$/);
      for (const write of bucket.applied.slice(start)) {
        if (write.key !== HEAD) {
          const parsed =
            parseTreeNodeKey(PREFIX, write.key) ?? parseTreeRecordKey(PREFIX, write.key);
          expect(parsed?.attempt).toBe(outcome.attempt);
        }
      }
      attempts.push(outcome.attempt);
    }
    expect(new Set(attempts).size).toBe(2);
  });

  test("a fresh identity equal to any identity of a mixed-identity captured tree is Internal", async () => {
    // The root and its right side carry the second identity; the left side keeps the first.
    const bucket = await Bucket.seeded();
    await bucket.publish(await bucket.prepare([["k19", 119]]));
    const fold = await bucket.prepare([["k00", 100]]);
    const identities = new Set([
      ...[...capturedLiveRefs(fold.root, fold.plan.read).values()].map((ref) => ref.entry.attempt),
      ...fold.plan.read.map((node) => node.attempt),
    ]);
    identities.delete(fold.root!.attempt);
    expect(identities.size).toBeGreaterThan(0);
    for (const attempt of identities) {
      await expect(
        refusal(bucket, fold, "equals one read from the captured tree", { attempt }),
      ).resolves.toBeUndefined();
    }
  });

  test("a fresh identity equal to one read from the captured tree is Internal", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const start = bucket.applied.length;
    await expect(bucket.publish(fold, { attempt: fold.root!.attempt })).rejects.toMatchObject({
      code: "Internal",
    });
    expect(bucket.applied.length).toBe(start);
  });
});

// ---------------------------------------------------------------------
// Inputs and the head transition
// ---------------------------------------------------------------------

describe("inputs", () => {
  test("a fold end that does not advance, another salt, another root or another collection's head is Internal, with no write", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const start = bucket.applied.length;
    for (const [bad, chunkSalt] of [
      [{ ...fold, floor: fold.head.json.log_seq_start }, undefined],
      [fold, TREE_SECOND_TEST_CHUNK_SALT],
      [{ ...fold, root: null }, undefined],
      [{ ...fold, head: { ...fold.head, prefix: `${PREFIX}x` } }, undefined],
    ] as const) {
      await expect(bucket.publish(bad, { chunkSalt })).rejects.toMatchObject({ code: "Internal" });
    }
    expect(bucket.applied.length).toBe(start);
  });

  test("a plan built under another salt's chunk key is Internal, with no write", async () => {
    const seeded = await Bucket.seeded();
    await expect(
      refusal(
        seeded,
        await seeded.prepare(MIXED, { chunkKey: secondChunkKey }),
        "built under a chunk key other than the chunk salt's",
      ),
    ).resolves.toBeUndefined();
    // A fresh head: the plan's key must be the key of the salt this attempt declares.
    const fresh = await Bucket.open();
    await expect(
      refusal(fresh, await fresh.prepare([["a", 1]]), "built under a chunk key", {
        chunkSalt: TREE_SECOND_TEST_CHUNK_SALT,
      }),
    ).resolves.toBeUndefined();
  });

  test("a captured root whose totals disagree with the head is InvalidResponse", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const head = { ...fold.head, json: { ...fold.head.json, snapshot_rows: 1 } };
    await expect(bucket.publish({ ...fold, head })).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

describe("head transition", () => {
  test("a head a reader would refuse is Internal before any write", async () => {
    const bucket = await Bucket.seeded();
    const fold = await bucket.prepare(MIXED);
    const found: (string | undefined)[] = [];
    for (const meanEntryBytes of [-1, 1.5]) {
      found.push(
        await refusal(bucket, fold, "a reader would refuse the new head", { meanEntryBytes }),
      );
    }
    expect(found).toEqual([undefined, undefined]);
  });

  test("the first fold creates proto_tree with the attempt's salt; later folds keep every other field", async () => {
    const bucket = await Bucket.open({
      ...freshHead(),
      tail_hint: 40,
      writer_fence: { epoch: 3, owner: "w", claimed_at: "" },
      generation: "abc123",
      last_warned_seq: 0,
      log_delete_floor: 0,
      mean_entry_bytes: 12,
    });
    const first = await bucket.prepare([["a", 1]], { chunkKey: secondChunkKey });
    await expect(
      bucket.publish(first, { chunkSalt: TREE_SECOND_TEST_CHUNK_SALT }),
    ).resolves.toMatchObject({ kind: "published" });
    await expect(bucket.violations()).resolves.toEqual([]);
    const { json: created } = await bucket.head();
    expect(created.proto_tree).toEqual({
      root: expect.stringMatching(/^app\//),
      attempt: parseTreeNodeKey(PREFIX, created.proto_tree!.root!)!.attempt,
      chunk_salt: TREE_SECOND_TEST_CHUNK_SALT,
    });
    expect(created).toMatchObject({ log_seq_start: 1, tail_hint: 40, mean_entry_bytes: 12 });

    // A tail-hint refresh between folds keeps proto_tree as it is.
    await casUpdateCurrentJson(bucket.memory, HEAD, (head) => ({
      ...head,
      tail_hint: head.tail_hint + 1,
    }));
    const changes: Change[] = Array.from({ length: 45 }, (_, i) => [`b${i}`, i]);
    const second = await bucket.prepare(changes);
    const outcome = await publishTree({
      storage: bucket.storage,
      prefix: PREFIX,
      head: second.head,
      root: second.root,
      plan: second.plan,
      floor: second.floor,
      chunkSalt: TREE_SECOND_TEST_CHUNK_SALT,
      meanEntryBytes: 30,
      config: configFor(),
    });
    expect(outcome.kind).toBe("published");
    bucket.commit(second);
    await expect(bucket.violations()).resolves.toEqual([]);
    const { json: after } = await bucket.head();
    expect(after).toEqual({
      ...second.head.json,
      log_seq_start: 46,
      tail_hint: 46,
      snapshot_rows: 46,
      snapshot_bytes: expect.any(Number),
      mean_entry_bytes: 30,
      proto_tree: {
        root: outcome.root,
        attempt: outcome.attempt,
        chunk_salt: TREE_SECOND_TEST_CHUNK_SALT,
      },
    });
  });
});

// ---------------------------------------------------------------------
// Published trees under the physical oracle
// ---------------------------------------------------------------------

describe("published trees", () => {
  // Short ids land around the seeded rows; the seeded ids update or delete them.
  const seededIds = Array.from({ length: 20 }, (_, i) => `k${String(i).padStart(2, "0")}`);
  const ids = fc.oneof(fc.stringMatching(/^[a-z0-9]{1,2}$/), fc.constantFrom(...seededIds));
  const tickArbitrary = fc.array(
    fc.array(fc.tuple(ids, fc.option(fc.integer({ min: 0, max: 9999 }), { freq: 4 })), {
      minLength: 1,
      maxLength: 12,
    }),
    { minLength: 1, maxLength: 5 },
  );

  fcTest.prop({ seeded: fc.boolean(), ticks: tickArbitrary }, { numRuns: 40 })(
    "every published tree passes the physical oracle, each entry matching its child's body, and its record is exact",
    async ({ seeded, ticks }) => {
      // The seeded tree is depth 3, so a fold can read below a branch it reuses.
      const bucket = seeded ? await Bucket.seeded() : await Bucket.open();
      for (const tick of ticks) {
        const fold = await bucket.prepare(tick);
        const before = await bucket.reachable();
        const outcome = await bucket.publish(fold);
        expect(outcome.kind).toBe("published");
        await expect(bucket.violations()).resolves.toEqual([]);
        await expect(exactnessFailure(bucket, fold, outcome, before)).resolves.toBeUndefined();
      }
    },
  );
});

// ---------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------

describe("mutation", () => {
  const checks = new Map<TreeMutant, readonly ((m?: TreeMutant) => Promise<string | undefined>)[]>([
    [PUBLISH_HEAD_BEFORE_NODES, [writeOrderFailure, crashSweepFailure]],
    [PUBLISH_REUSES_UNPROVEN_REF, [staleReuseFailure, unreachableReadFailure]],
    [PUBLISH_ADOPTS_WITHOUT_COMPARE, [foreignBodyFailure]],
    [PUBLISH_NODES_BEFORE_RECORD, [writeOrderFailure, crashSweepFailure]],
    [RECORD_NAMES_REUSED_NODE, [recordExactnessFailure]],
    [RECORD_OMITS_SUPERSEDED, [recordExactnessFailure]],
    [RECORD_NO_DOWNWARD_CLOSURE, [downwardClosureFailure]],
    [RECORD_FLOOR_NOT_CAPTURED, [recordTripwireFailure]],
  ]);

  test("every publication mutant has checks", () => {
    expect([...checks.keys()]).toEqual(PUBLISH_MUTANTS);
  });

  test.each(PUBLISH_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
    "%s turns its checks red",
    async (_name, mutant) => {
      for (const check of checks.get(mutant)!) {
        await expect(check(mutant)).resolves.toBeDefined();
      }
    },
  );
});
