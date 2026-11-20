/**
 * The tree head: the collection's `current.json` read as a tree head,
 * and the root it names. Every tree reader, the fold and the GC tick
 * open a tree through here, so each applies the same head rules.
 *
 * A tree head is a schema-3 `current.json` (validated by
 * `readCurrentJson`) with these extra properties:
 *
 * - `snapshot` is `null`. Tree code never reads, converts or repairs a
 *   monolithic snapshot.
 * - `proto_tree` is an object with exactly the keys `root` (a node key
 *   under the collection prefix, or `null`), `gc_fence_epoch` (a safe
 *   integer ≥ 0) and `chunk_salt` (32 lowercase hex characters). Key
 *   order does not matter: the head is parse-only.
 * - `root: null` requires `snapshot_rows` and `snapshot_bytes` to be 0.
 * - Without `proto_tree` the head is valid only as a fresh collection
 *   (`log_seq_start` 0 and both totals 0); it then reads as an empty
 *   tree with epoch 0 and no salt yet, and the first tree writer mints
 *   one.
 * - The root, once decoded, is a root with `floor = log_seq_start` and
 *   the head's totals ({@link readTreeRoot}, {@link assertRootMatchesHead}).
 *
 * Every violation is `InvalidResponse`. The chunk salt is confidential:
 * messages name the field, never its value, even a malformed one, and
 * the same holds for every other field. The parsed head carries no copy
 * of the salt; it stays in `json.proto_tree`, where head writers copy it
 * byte for byte. Code that chunks gets an imported key handle from
 * {@link importTreeChunkKey}, never the bytes.
 */
import {
  BaerlyError,
  type CurrentJson,
  type CurrentJsonRead,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { type ChunkKey, importChunkKey } from "./chunk.ts";
import { parseTreeNodeKey } from "./key.ts";
import { DEFAULT_TREE_CONFIG, type TreeConfig } from "./layout.ts";
import { type DecodedTreeNode, decodeNode } from "./node-codec.ts";

const CHUNK_SALT_PATTERN = /^[0-9a-f]{32}$/;
const PROTO_TREE_FIELDS = ["chunk_salt", "gc_fence_epoch", "root"] as const;

/** The `proto_tree` field of a tree head, as stored. */
export interface ProtoTreeField {
  readonly root: string | null;
  readonly gc_fence_epoch: number;
  readonly chunk_salt: string;
}

/** A `current.json` that may carry `proto_tree`. */
export type TreeHeadJson = CurrentJson & { proto_tree?: ProtoTreeField };

/** A validated tree head. */
export interface TreeHead {
  /** The collection prefix `P`. */
  readonly prefix: string;
  /** `<P>/current.json`. */
  readonly key: string;
  /**
   * The head as read, `proto_tree` included. `proto_tree` is absent only
   * on a fresh head, which has no root, epoch 0 and no chunk salt yet.
   */
  readonly json: TreeHeadJson;
  /** The ETag of the read, for a conditional head write. */
  readonly etag: string;
  /** The root node key, or `null` for an empty tree. */
  readonly root: string | null;
  readonly gcFenceEpoch: number;
}

/** The `current.json` key of collection prefix `prefix`. */
export const treeHeadKey = (prefix: string): string => `${prefix}/current.json`;

/** Whether `value` is a well-formed chunk salt: 32 lowercase hex characters. */
export const isTreeChunkSalt = (value: unknown): value is string =>
  typeof value === "string" && CHUNK_SALT_PATTERN.test(value);

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const headError = (key: string, detail: string): BaerlyError =>
  new BaerlyError("InvalidResponse", `tree head ${JSON.stringify(key)}: ${detail}`);

/**
 * Validate `read`, the `current.json` of collection prefix `prefix`
 * already parsed by `readCurrentJson`, as a tree head.
 *
 * @throws BaerlyError code="InvalidResponse" — `snapshot` is not null; a
 *   head without `proto_tree` is not fresh; `proto_tree` is not an
 *   object of exactly its three fields; `chunk_salt` is not 32 lowercase
 *   hex characters; `gc_fence_epoch` is not a non-negative safe integer;
 *   `root` is neither null nor a node key under `prefix`; or a null root
 *   has non-zero totals. The message names the field, never its value.
 */
export const parseTreeHead = (prefix: string, read: CurrentJsonRead): TreeHead => {
  const key = treeHeadKey(prefix);
  // TypeScript narrows after a `never` call only through an explicitly
  // typed binding.
  const fail: (detail: string) => never = (detail) => {
    throw headError(key, detail);
  };
  const json = read.json;
  const fields = json as unknown as Record<string, unknown>;
  if (json.snapshot !== null) {
    fail("snapshot is not null; a tree head never names a monolithic snapshot");
  }
  const tree = fields["proto_tree"];
  if (tree === undefined) {
    if (json.log_seq_start !== 0 || json.snapshot_rows !== 0 || json.snapshot_bytes !== 0) {
      fail(
        "proto_tree is missing, but log_seq_start, snapshot_rows or snapshot_bytes is not 0; only a fresh head may omit it",
      );
    }
    return { prefix, key, json, etag: read.etag, root: null, gcFenceEpoch: 0 };
  }
  if (!isPlainObject(tree)) {
    fail("proto_tree is not an object");
  }
  const names = Object.keys(tree).toSorted();
  if (
    names.length !== PROTO_TREE_FIELDS.length ||
    !PROTO_TREE_FIELDS.every((field, i) => names[i] === field)
  ) {
    fail(`proto_tree does not have exactly the fields ${PROTO_TREE_FIELDS.join(", ")}`);
  }
  if (!isTreeChunkSalt(tree["chunk_salt"])) {
    fail("proto_tree.chunk_salt is not 32 lowercase hex characters");
  }
  const epoch = tree["gc_fence_epoch"];
  if (!isNonNegativeSafeInteger(epoch)) {
    fail("proto_tree.gc_fence_epoch is not a non-negative safe integer");
  }
  const root = tree["root"];
  if (root !== null && (typeof root !== "string" || parseTreeNodeKey(prefix, root) === null)) {
    fail("proto_tree.root is neither null nor a node key under the collection prefix");
  }
  if (root === null && (json.snapshot_rows !== 0 || json.snapshot_bytes !== 0)) {
    fail("proto_tree.root is null, but snapshot_rows or snapshot_bytes is not 0");
  }
  return { prefix, key, json, etag: read.etag, root, gcFenceEpoch: epoch };
};

/**
 * Read and validate the tree head of collection prefix `prefix`, or
 * return `null` when the collection has no `current.json` yet.
 *
 * @throws BaerlyError code="InvalidResponse" — `current.json` is not a
 *   valid schema-3 head, or not a valid tree head.
 */
export const readTreeHead = async (
  storage: Storage,
  prefix: string,
  opts?: { readonly signal?: AbortSignal },
): Promise<TreeHead | null> => {
  const read = await readCurrentJson(storage, treeHeadKey(prefix), opts);
  return read === null ? null : parseTreeHead(prefix, read);
};

/**
 * Check a decoded root against the head that names it: its key is the
 * head's root, it was decoded as a root, its `floor` is the head's
 * `log_seq_start` and its totals are the head's `snapshot_rows` and
 * `snapshot_bytes`. A `null` root needs a head with no root.
 *
 * @throws BaerlyError code="Internal" — `root` is not the node the head
 *   names, or was not decoded as a root (a caller bug).
 * @throws BaerlyError code="InvalidResponse" — the stored root's floor
 *   or totals disagree with the stored head.
 */
export const assertRootMatchesHead = (head: TreeHead, root: DecodedTreeNode | null): void => {
  if ((root?.key ?? null) !== head.root) {
    throw new BaerlyError(
      "Internal",
      `tree head ${JSON.stringify(head.key)}: the captured root is not the node the head names`,
    );
  }
  if (root === null) {
    return;
  }
  const totals = root.node.root;
  if (totals === null) {
    throw new BaerlyError(
      "Internal",
      `tree head ${JSON.stringify(head.key)}: the captured root was not decoded as a root`,
    );
  }
  if (totals.floor !== head.json.log_seq_start) {
    throw headError(head.key, "log_seq_start does not match the root's floor");
  }
  for (const [field, stored, rooted] of [
    ["snapshot_rows", head.json.snapshot_rows, totals.rows],
    ["snapshot_bytes", head.json.snapshot_bytes, totals.bytes],
  ] as const) {
    if (stored !== rooted) {
      throw headError(head.key, `${field} does not match the root's total`);
    }
  }
};

/**
 * Fetch and strictly decode the root `head` names, or return `null` for
 * an empty tree. The root is decoded as a root with `floor` equal to
 * the head's `log_seq_start`, and its totals must equal the head's
 * `snapshot_rows` and `snapshot_bytes`, so once this returns, the root's
 * metadata is authoritative for routing and totals.
 *
 * @param config  the tree configuration; tests pass a mutant here.
 * @throws BaerlyError code="InvalidResponse" — the root is missing,
 *   fails strict decode, or disagrees with the head.
 */
export const readTreeRoot = async (
  storage: Storage,
  head: TreeHead,
  config: TreeConfig = DEFAULT_TREE_CONFIG,
  opts?: { readonly signal?: AbortSignal },
): Promise<DecodedTreeNode | null> => {
  if (head.root === null) {
    return null;
  }
  const got = await storage.get(head.root, opts);
  const decoded = await decodeNode(
    head.root,
    got?.body ?? null,
    { prefix: head.prefix, root: true, floor: head.json.log_seq_start },
    config,
  );
  assertRootMatchesHead(head, decoded);
  return decoded;
};

/**
 * Import the chunk salt of `head` as a chunk-hash key, or return `null`
 * on a fresh head that has no salt yet (the first tree writer mints
 * one). The salt bytes never leave this call; the handle holds none.
 */
export const importTreeChunkKey = async (head: TreeHead): Promise<ChunkKey | null> => {
  const tree = head.json.proto_tree;
  return tree === undefined ? null : importChunkKey(Uint8Array.fromHex(tree.chunk_salt));
};
