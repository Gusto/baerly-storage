/**
 * Publication of a planned fold: fresh nodes, then the head CAS.
 *
 * One call is one publication attempt over one captured head and root.
 * It mints a fresh 128-bit attempt identity, seals the plan under it and
 * writes in this order:
 *
 * 1. every fresh leaf, create-only (`If-None-Match: "*"`);
 * 2. each level of fresh branches only after every fresh child it
 *    references has completed, level by level up to the root; the
 *    creates of one level run concurrently;
 * 3. the head, `If-Match` the captured ETag.
 *
 * Nothing is written after the head CAS, so a head never names a node
 * that is not yet stored. The head transition is validated before the
 * first write, so a transition bug leaves no node behind.
 *
 * **Plan identity.** The plan must name the captured root as its base
 * and carry the chunk key of the salt the head will store; a plan built
 * on another root or under another salt is `Internal`, even when every
 * ref it reuses still exists.
 *
 * **Reuse.** A reused ref must be a child entry of the captured root,
 * or of a node the plan read and that is itself reachable from the
 * captured root through such entries, and it must fill a slot at the
 * level of the node it names. A ref never comes from a key
 * that merely exists, a listing, an older root or a cache: once a key is
 * unreachable from the current root it can never be published again,
 * which is what lets GC delete it.
 *
 * **Create conflicts.** The publisher never re-sends a write; the
 * adapter's `retryStorageCall` retries a create inside the call, so a
 * create whose first attempt landed but lost its reply comes back as a
 * `WriteConflict`. That conflict is resolved by reading the key: a body
 * byte-identical to the one created is adopted; a different body is
 * `InvalidResponse`; no body means the attempt lost, `WriteConflict`:
 * GC deletes an attempt's nodes only after a later fold has moved the
 * floor past the floor it captured, so its head CAS can no longer land.
 * Any other create failure fails the attempt with its own code, and the
 * nodes already written are unreachable leaks.
 *
 * **Head-CAS fate.** The head CAS gets no adapter retry. When it throws
 * `WriteConflict` or `NetworkError`, one strict re-read of the head
 * decides: a non-null new root won iff the head now names it and this
 * attempt as its installer (its key
 * carries this attempt's fresh identity, so the match is unambiguous);
 * an empty new root won iff the head has no root, this attempt's
 * identity as `proto_tree.attempt`, the new floor, this attempt's salt
 * and zero totals. The identity is fresh, so two attempts publishing the
 * same empty tree never both report `published`. Anything else is a
 * `cas-lost` outcome, returned rather than thrown, including a win
 * superseded before the re-read.
 * Any other failure of the CAS (an abort, an `InvalidResponse` that is
 * not a transport fault) is rethrown without the re-read, so that
 * attempt's fate is unknown; either fate is safe, because publication
 * deletes nothing.
 *
 * **A loss decides nothing about reachability.** A `cas-lost` attempt's
 * nodes may still be reachable: its CAS may have landed with the reply
 * lost, and another writer may have captured that head and reused the
 * nodes before the re-read. So nothing may delete by a lost attempt's
 * identity; whether a node is reachable is decided only from the
 * current root.
 *
 * Storage calls, in order: the node creates level by level (each
 * followed by one GET when it conflicts), the head CAS, then at most one
 * head GET. A crash between any two of them leaves the head on the
 * captured tree or on the new one.
 */
import {
  BaerlyError,
  CURRENT_JSON_CONTENT_TYPE,
  assertCurrentJsonTransition,
  encodeJsonBytes,
  isWriteConflict,
  type Storage,
} from "@baerly/protocol";
import { type PlannedTree, type SealedTree, sealTree } from "./build.ts";
import { chunkKeyIsOf } from "./chunk.ts";
import {
  assertRootMatchesHead,
  isTreeChunkSalt,
  type ProtoTreeField,
  readTreeHead,
  readTreeRoot,
  type TreeHead,
  type TreeHeadJson,
  treeHeadKey,
} from "./head.ts";
import { isTreeAttempt, mintTreeAttempt, parseTreeNodeKey } from "./key.ts";
import { bytesEqual, DEFAULT_TREE_CONFIG, type TreeConfig, type TreeSteps } from "./layout.ts";
import type { DecodedTreeNode, SealedTreeNode, TreeChildEntry } from "./node-codec.ts";
import type { TreeFoldPlan } from "./plan.ts";

const NODE_CONTENT_TYPE = "application/json";

/** One write of a publication: a level of fresh nodes, or the head CAS. */
export type TreePublicationWrite =
  | { readonly kind: "nodes"; readonly level: number }
  | { readonly kind: "head" };

/** Input to {@link publishTree}. */
export interface PublishTreeInput {
  /** Storage behind the adapter retry (`retryStorageCall`). */
  readonly storage: Storage;
  /** The collection prefix `P`. */
  readonly prefix: string;
  /** The captured head, read with `readTreeHead`. */
  readonly head: TreeHead;
  /**
   * The captured root: the node the head names, strictly decoded as a
   * root with the head's floor, or `null` when the head has no root.
   */
  readonly root: DecodedTreeNode | null;
  /** The fold's plan, built on `root` under the chunk key of `chunkSalt`. */
  readonly plan: TreeFoldPlan;
  /** The fold end `F`: the new `log_seq_start`, above the captured one. */
  readonly floor: number;
  /**
   * The chunk salt the plan was built under: the head's, or the salt
   * this attempt minted when the head has no `proto_tree` yet.
   */
  readonly chunkSalt: string;
  /** A new `mean_entry_bytes` to stamp; the captured value is kept when omitted. */
  readonly meanEntryBytes?: number;
  /** The tree configuration; tests pass a mutant here. */
  readonly config?: TreeConfig;
  readonly signal?: AbortSignal;
}

/** What one publication attempt did. */
export type TreePublishOutcome = {
  /** This attempt's identity, carried by every node it created. */
  readonly attempt: string;
  /** The new root key, or `null` for an empty collection. */
  readonly root: string | null;
  /** Fresh nodes this attempt wrote, the root and adopted creates included. */
  readonly written: number;
  /** Fresh nodes adopted after a create conflict. */
  readonly adopted: number;
} & (
  | {
      readonly kind: "published";
      /** The head after publication, as written or as re-read. */
      readonly head: TreeHeadJson;
      readonly etag: string;
    }
  | { readonly kind: "cas-lost" }
);

// TypeScript narrows after a `never` call only through an explicitly
// typed binding.
const internal: (detail: string) => never = (detail) => {
  throw new BaerlyError("Internal", `tree publish: ${detail}`);
};

/** The chunk salt `head` stores, or `null` on a fresh head. */
const storedSalt = (head: TreeHead): string | null => head.json.proto_tree?.chunk_salt ?? null;

/** The `<attempt>/<sha256>` identity of a node ref. */
const refOf = (ref: { readonly attempt: string; readonly sha256: string }): string =>
  `${ref.attempt}/${ref.sha256}`;

/** A ref proven live under the captured root: its entry and the level of the node it names. */
export interface LiveTreeRef {
  readonly entry: TreeChildEntry;
  readonly level: number;
}

/**
 * A reused ref is live when it names a proven-live node at `level`, the
 * level of the slot it fills, and copies its entry exactly.
 */
export const reuseIsLive = (
  entry: TreeChildEntry,
  level: number,
  live: ReadonlyMap<string, LiveTreeRef>,
): boolean => {
  const ref = live.get(refOf(entry));
  const proven = ref?.entry;
  return (
    proven !== undefined &&
    ref!.level === level &&
    proven.lo === entry.lo &&
    proven.hi === entry.hi &&
    proven.rows === entry.rows &&
    proven.bytes === entry.bytes
  );
};

/** The required order: the node levels from the leaves up, then the head. */
export const requiredPublicationOrder = (
  writes: readonly TreePublicationWrite[],
): readonly TreePublicationWrite[] => writes;

interface PublishSteps {
  readonly mintAttempt: () => string;
  readonly publicationOrder: NonNullable<TreeSteps["publicationOrder"]>;
  readonly reuseIsLive: NonNullable<TreeSteps["reuseIsLive"]>;
  readonly adoptionBytesMatch: NonNullable<TreeSteps["adoptionBytesMatch"]>;
}

const publishSteps = (config: TreeConfig): PublishSteps => ({
  mintAttempt: config.steps.mintAttempt ?? mintTreeAttempt,
  publicationOrder: config.steps.publicationOrder ?? requiredPublicationOrder,
  reuseIsLive: config.steps.reuseIsLive ?? reuseIsLive,
  adoptionBytesMatch: config.steps.adoptionBytesMatch ?? bytesEqual,
});

/**
 * Every ref proven live under the captured root, keyed
 * `<attempt>/<sha256>`: the root's child entries, then the child entries
 * of each read node that is itself one of them, each at its parent's
 * level − 1. The planner reads a node only after the node that routed
 * to it, so one pass in read order suffices; a read node not reachable
 * from the root contributes nothing.
 */
export const capturedLiveRefs = (
  root: DecodedTreeNode | null,
  read: readonly DecodedTreeNode[],
): Map<string, LiveTreeRef> => {
  const live = new Map<string, LiveTreeRef>();
  const addChildren = (node: DecodedTreeNode): void => {
    if (node.node.kind === "branch") {
      for (const entry of node.node.children) {
        live.set(refOf(entry), { entry, level: node.node.level - 1 });
      }
    }
  };
  if (root === null) {
    return live;
  }
  addChildren(root);
  for (const node of read) {
    if (live.has(refOf(node))) {
      addChildren(node);
    }
  }
  return live;
};

/** Every reused entry of `tree` with the level of the slot it fills: its parent's level − 1. */
const reusedSlots = (tree: PlannedTree | null): { entry: TreeChildEntry; level: number }[] => {
  const slots: { entry: TreeChildEntry; level: number }[] = [];
  const walk = (node: PlannedTree["root"]): void => {
    if (node.kind === "leaf") {
      return;
    }
    for (const child of node.children) {
      if (child.kind === "reused") {
        slots.push({ entry: child.entry, level: node.level - 1 });
      } else {
        walk(child.node);
      }
    }
  };
  if (tree !== null) {
    walk(tree.root);
  }
  return slots;
};

const refuseWrite = async (): Promise<never> => internal("the read-back view is read-only");

/**
 * A read-only storage view holding exactly `objects`, so the reader's own
 * code can open a head and root before they are written.
 */
const readOnlyView = (objects: ReadonlyMap<string, Uint8Array>): Storage => {
  return {
    get: async (key) => {
      const body = objects.get(key);
      return body === undefined ? null : { body, etag: '"read-back"' };
    },
    put: refuseWrite,
    delete: refuseWrite,
    list: () => ({
      [Symbol.asyncIterator]: () => ({ next: refuseWrite }),
    }),
  };
};

/** The JSON of a head's fields that a fold transition must leave unchanged. */
const preserved = (head: TreeHeadJson): string =>
  JSON.stringify([
    head.schema_version,
    head.writer_fence,
    head.generation ?? null,
    head.log_delete_floor ?? null,
    head.last_warned_seq ?? null,
  ]);

/**
 * Check the fold transition `before` → `after` for the sealed tree, and
 * return the head body to CAS. The body is first read back the way a
 * reader opens a tree: `readTreeHead` over the encoded bytes, then
 * `readTreeRoot` strictly decoding the new root as a root of this
 * collection with the new floor, the head's totals and level counts
 * that fit it. A head a reader would refuse is never written. The root
 * level and level counts are sealed from the plan, so they need no
 * separate check against it.
 *
 * @throws BaerlyError code="Internal" — any rule fails, including the
 *   read-back.
 */
const assertFoldTransition = async (
  input: PublishTreeInput,
  config: TreeConfig,
  sealed: SealedTree,
  attempt: string,
  after: TreeHeadJson,
): Promise<Uint8Array> => {
  const { head, prefix, floor } = input;
  const before = head.json;
  assertCurrentJsonTransition(before, after, head.key);
  if (after.log_seq_start !== floor || !(floor > before.log_seq_start)) {
    internal("the head must move log_seq_start to the fold end, above the captured one");
  }
  if (preserved(after) !== preserved(before)) {
    internal(
      "schema_version, writer_fence, generation, log_delete_floor and last_warned_seq must be unchanged",
    );
  }
  const tree = after.proto_tree;
  if (tree === undefined || tree.attempt !== attempt) {
    internal("proto_tree.attempt must be this attempt's identity");
  }
  if (tree.chunk_salt !== (storedSalt(head) ?? input.chunkSalt)) {
    internal("proto_tree.chunk_salt must be the captured salt, or the one this attempt minted");
  }
  const root = sealed.root;
  if ((root?.key ?? null) !== tree.root) {
    internal("the head must name the new root");
  }
  if (root !== null && parseTreeNodeKey(prefix, root.key)?.attempt !== attempt) {
    internal("the new root's key must carry this attempt's identity");
  }

  const bytes = encodeJsonBytes(after);
  const objects = new Map([[treeHeadKey(prefix), bytes]]);
  if (root !== null) {
    objects.set(root.key, root.bytes);
  }
  try {
    const view = readOnlyView(objects);
    const reread = await readTreeHead(view, prefix);
    if (reread !== null) {
      await readTreeRoot(view, reread, config);
    }
  } catch (error) {
    throw new BaerlyError(
      "Internal",
      `tree publish: a reader would refuse the new head: ${(error as Error).message}`,
      { cause: error },
    );
  }
  return bytes;
};

/**
 * Publish `input.plan` as the collection's new tree: create its fresh
 * nodes children first, then CAS the head from the captured head to one
 * naming the new root at fold end `input.floor`. See the module comment
 * for the write order, the reuse rule, create-conflict adoption and how
 * the head CAS's fate is resolved.
 *
 * @returns `published`, or `cas-lost` when another head write won.
 * @throws BaerlyError code="Internal" — the inputs disagree (the head is
 *   not this prefix's, the root is not the head's, the plan was built on
 *   another root or under another salt's chunk key, the fold end does
 *   not advance, the salt is not the head's), a reused ref is not live
 *   under the captured root at its slot's level, the fresh identity
 *   equals one of the captured tree, or the head transition breaks a
 *   rule or yields a head a reader would refuse.
 * @throws BaerlyError code="InvalidResponse" — the captured root's floor
 *   or totals disagree with the head, a conflicting create holds
 *   different bytes, or the fate re-read finds a malformed head.
 * @throws BaerlyError code="WriteConflict" — a conflicting create's key
 *   reads back empty.
 * @throws BaerlyError — a node create or a head read that fails for any
 *   other reason, with that failure's code.
 */
export const publishTree = async (input: PublishTreeInput): Promise<TreePublishOutcome> => {
  const { storage, prefix, head, root, plan, floor, signal } = input;
  const config = input.config ?? DEFAULT_TREE_CONFIG;
  const steps = publishSteps(config);

  if (head.prefix !== prefix) {
    internal("the captured head is not the head of this collection");
  }
  assertRootMatchesHead(head, root);
  if (plan.base !== (root?.key ?? null)) {
    internal("the plan was built on a root other than the captured one");
  }
  if (!Number.isSafeInteger(floor) || floor <= head.json.log_seq_start) {
    internal("the fold end must be a safe integer above the captured log_seq_start");
  }
  const headSalt = storedSalt(head);
  if (headSalt !== null && input.chunkSalt !== headSalt) {
    internal("the chunk salt is not the head's");
  }
  if (!isTreeChunkSalt(input.chunkSalt)) {
    internal("the chunk salt must be 32 lowercase hex characters");
  }
  if (!(await chunkKeyIsOf(plan.chunkKey, Uint8Array.fromHex(input.chunkSalt)))) {
    internal("the plan was built under a chunk key other than the chunk salt's");
  }

  const live = capturedLiveRefs(root, plan.read);
  const attempt = steps.mintAttempt();
  if (!isTreeAttempt(attempt)) {
    internal("the minted attempt identity is not 32 lowercase hex characters");
  }
  const seen = new Set<string>([...live.values()].map((ref) => ref.entry.attempt));
  for (const node of [...(root === null ? [] : [root]), ...plan.read]) {
    seen.add(node.attempt);
  }
  if (seen.has(attempt)) {
    internal("the fresh attempt identity equals one read from the captured tree");
  }

  const sealed = await sealTree(plan.tree, { prefix, attempt, floor });
  for (const { entry, level } of reusedSlots(plan.tree)) {
    if (!steps.reuseIsLive(entry, level, live)) {
      internal(
        `reused ref ${JSON.stringify(refOf(entry))} is not live under the captured root at level ${level}`,
      );
    }
  }

  const rootKey = sealed.root?.key ?? null;
  const before = head.json;
  const tree: ProtoTreeField = {
    root: rootKey,
    attempt,
    chunk_salt: headSalt ?? input.chunkSalt,
  };
  const after: TreeHeadJson = {
    ...before,
    log_seq_start: floor,
    tail_hint: Math.max(before.tail_hint, floor),
    snapshot_rows: sealed.root?.summary.rows ?? 0,
    snapshot_bytes: sealed.root?.summary.bytes ?? 0,
    ...(input.meanEntryBytes !== undefined && { mean_entry_bytes: input.meanEntryBytes }),
    proto_tree: tree,
  };
  const headBytes = await assertFoldTransition(input, config, sealed, attempt, after);

  let written = 0;
  let adopted = 0;
  const create = async (node: SealedTreeNode): Promise<void> => {
    try {
      await storage.put(node.key, node.bytes, {
        ifNoneMatch: "*",
        contentType: NODE_CONTENT_TYPE,
        ...(signal !== undefined && { signal }),
      });
      written += 1;
      return;
    } catch (error) {
      if (!isWriteConflict(error)) {
        throw error;
      }
    }
    const stored = await storage.get(node.key, signal === undefined ? undefined : { signal });
    if (stored === null) {
      throw new BaerlyError(
        "WriteConflict",
        `tree publish: node ${node.key} conflicted on create and is gone, so this attempt lost`,
      );
    }
    if (!steps.adoptionBytesMatch(stored.body, node.bytes)) {
      throw new BaerlyError(
        "InvalidResponse",
        `tree publish: node ${node.key} holds a body other than the one this attempt created`,
      );
    }
    written += 1;
    adopted += 1;
  };
  const createLevel = async (nodes: readonly SealedTreeNode[]): Promise<void> => {
    const results = await Promise.allSettled(nodes.map(create));
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  };

  /** CAS the head; on a throw, resolve whether this attempt won from one re-read. */
  const casHead = async (): Promise<{ head: TreeHeadJson; etag: string } | null> => {
    try {
      const result = await storage.put(head.key, headBytes, {
        ifMatch: head.etag,
        contentType: CURRENT_JSON_CONTENT_TYPE,
        ...(signal !== undefined && { signal }),
      });
      return { head: after, etag: result.etag };
    } catch (error) {
      const unknownFate =
        isWriteConflict(error) || (error instanceof BaerlyError && error.code === "NetworkError");
      if (!unknownFate) {
        throw error;
      }
    }
    const now = await readTreeHead(storage, prefix, signal === undefined ? undefined : { signal });
    if (now === null) {
      return null;
    }
    const won =
      now.attempt === attempt &&
      (rootKey !== null
        ? now.root === rootKey
        : now.root === null &&
          now.json.log_seq_start === floor &&
          storedSalt(now) === tree.chunk_salt &&
          now.json.snapshot_rows === 0 &&
          now.json.snapshot_bytes === 0);
    return won ? { head: now.json, etag: now.etag } : null;
  };

  const writes: TreePublicationWrite[] = sealed.levels.map((_, level) => ({
    kind: "nodes",
    level,
  }));
  writes.push({ kind: "head" });
  let fate: { head: TreeHeadJson; etag: string } | null | undefined;
  for (const write of steps.publicationOrder(writes)) {
    if (write.kind === "nodes") {
      await createLevel(sealed.levels[write.level] ?? []);
    } else {
      fate = await casHead();
    }
  }
  if (fate === undefined) {
    return internal("the publication issued no head CAS");
  }
  const outcome = { attempt, root: rootKey, written, adopted };
  return fate === null
    ? { ...outcome, kind: "cas-lost" }
    : { ...outcome, kind: "published", head: fate.head, etag: fate.etag };
};
