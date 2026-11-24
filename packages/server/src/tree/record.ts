/**
 * Fold records: what one publication attempt supersedes, written before
 * any node it creates.
 *
 * Every publication attempt writes one create-only, content-addressed
 * record at `<P>/_v99/r/<floor16>/<attempt>/<sha256>` (`./key.ts`)
 * before its first node. It names the head the attempt captured (its
 * floor, root, installer and generation), the result (the fold end and
 * the new root), every node the attempt creates, and every node of the
 * captured tree the new tree no longer reaches. Artifact GC reads it to
 * nominate deletions once a later fold has moved the floor past the
 * captured one; the record only nominates, and every deletion is proven
 * again against the root GC reads, so a record that names too much is
 * caught there and one that names too little leaks.
 *
 * The body is the `encodeJsonBytes` of exactly this object, in this
 * field order:
 *
 * ```text
 * {"format":"baerly-tree-fold-record-proto","schema_version":1,
 *  "attempt":"<32 hex>",
 *  "base":{"floor":f,"root":"<attempt>/<sha256>"|null,"attempt":"<32 hex>"|null,"generation":"<string>"|null},
 *  "result":{"floor":F,"root":"<sha256>"|null},
 *  "fresh":["<sha256>",...],
 *  "superseded":["<attempt>/<sha256>",...]}
 * ```
 *
 * `fresh` and `superseded` are sorted and unique. Their entries are
 * ASCII, so code-unit order is `utf8-scalar-v1` order. `result.root` is
 * keyed `n/<attempt>/<that>`, and every `fresh` entry likewise, so a
 * record can name only its own attempt's fresh nodes; no `superseded`
 * entry carries the record's attempt.
 */
import {
  BaerlyError,
  encodeJsonBytes,
  sha256Hex,
  unsupportedSchemaVersionMessage,
} from "@baerly/protocol";
import {
  TREE_FOLD_RECORD_FORMAT,
  TREE_FOLD_RECORD_SCHEMA_VERSION,
  TREE_GC_RECORD_MAX_BODY_BYTES,
  TREE_GC_RECORD_MAX_KEYS,
} from "./constants.ts";
import type { TreeHead } from "./head.ts";
import {
  isTreeAttempt,
  isTreeSha256,
  parseTreeNodeKey,
  parseTreeRecordKey,
  treeRecordKey,
} from "./key.ts";
import type { DecodedTreeNode, TreeChildEntry } from "./node-codec.ts";

/** The head a fold record's attempt captured, and will CAS against. */
export interface FoldRecordBase {
  /** The captured `log_seq_start`. */
  readonly floor: number;
  /** The captured root as `<attempt>/<sha256>`, or `null` for an empty tree. */
  readonly root: string | null;
  /** The captured `proto_tree.attempt`, or `null` on a fresh head. */
  readonly attempt: string | null;
  /** The captured `generation`, or `null` when the head has none. */
  readonly generation: string | null;
}

/** The content of one fold record. */
export interface FoldRecord {
  /** The publication attempt's identity. */
  readonly attempt: string;
  readonly base: FoldRecordBase;
  readonly result: {
    /** The fold end `F`. */
    readonly floor: number;
    /** The new root's sha256, keyed `n/<attempt>/<that>`, or `null` for an empty tree. */
    readonly root: string | null;
  };
  /** The sha256 of every node the attempt creates, root included; sorted, unique. */
  readonly fresh: readonly string[];
  /** Every captured node the new tree does not reach, as `<attempt>/<sha256>`; sorted, unique. */
  readonly superseded: readonly string[];
}

/** An encoded fold record and its key. */
export interface SealedFoldRecord {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const REF_PATTERN = /^[0-9a-f]{32}\/[0-9a-f]{64}$/;

// TypeScript narrows after a `never` call only through an explicitly
// typed binding.
const internal: (detail: string) => never = (detail) => {
  throw new BaerlyError("Internal", `tree fold record: ${detail}`);
};

/** The `<attempt>/<sha256>` identity of a node ref. */
const refOf = (ref: { readonly attempt: string; readonly sha256: string }): string =>
  `${ref.attempt}/${ref.sha256}`;

/** `values` sorted by code unit (`utf8-scalar-v1` for ASCII) without duplicates. */
export const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].toSorted();

/**
 * The base of a record for an attempt that captured `head`: its floor,
 * its root as `<attempt>/<sha256>`, its installer and its generation.
 */
export const foldRecordBase = (head: TreeHead): FoldRecordBase => {
  const root = head.root === null ? null : parseTreeNodeKey(head.prefix, head.root);
  return {
    floor: head.json.log_seq_start,
    root: root === null ? null : refOf(root),
    attempt: head.attempt,
    generation: head.json.generation ?? null,
  };
};

/**
 * Check that `base` describes `head`, the head whose ETag the
 * attempt's head CAS sends. A record whose base is another head would
 * nominate the wrong attempts once GC closes its floor.
 *
 * @throws BaerlyError code="Internal" — any field differs.
 */
export const assertRecordBaseIsHead = (base: FoldRecordBase, head: TreeHead): void => {
  const rootKey = head.json.proto_tree?.root ?? null;
  const root = rootKey === null ? null : parseTreeNodeKey(head.prefix, rootKey);
  const expected: FoldRecordBase = {
    floor: head.json.log_seq_start,
    root: root === null ? null : refOf(root),
    attempt: head.json.proto_tree?.attempt ?? null,
    generation: head.json.generation ?? null,
  };
  for (const field of ["floor", "root", "attempt", "generation"] as const) {
    if (base[field] !== expected[field]) {
      internal(
        `the record's base ${field} is not the ${field} of the head the CAS is sent against`,
      );
    }
  }
};

/**
 * Every node of the captured tree the new tree no longer reaches, as
 * `<attempt>/<sha256>`, from what the plan read:
 *
 * - the base-live nodes are the captured root, plus each read node
 *   that is a child entry of a base-live node;
 * - the new-live refs are the new tree's reused refs, closed downward
 *   through the base-live nodes they name;
 * - the result is every base-live node whose ref is not new-live.
 *
 * A base node the plan did not read lies inside a reused subtree, so it
 * stays live. The root is never reused as a child, so a non-null
 * captured root is always in the result.
 */
export const foldRecordSuperseded = (
  root: DecodedTreeNode | null,
  read: readonly DecodedTreeNode[],
  reused: readonly TreeChildEntry[],
): string[] => {
  if (root === null) {
    return [];
  }
  const baseLive = new Map<string, DecodedTreeNode>([[refOf(root), root]]);
  const childRefs = (node: DecodedTreeNode): string[] =>
    node.node.kind === "branch" ? node.node.children.map(refOf) : [];
  const reachable = new Set(childRefs(root));
  // The planner reads a node only after the node that routed to it, but
  // repeat until nothing changes so read order does not matter.
  for (let grew = true; grew;) {
    grew = false;
    for (const node of read) {
      const ref = refOf(node);
      if (reachable.has(ref) && !baseLive.has(ref)) {
        baseLive.set(ref, node);
        for (const child of childRefs(node)) {
          reachable.add(child);
        }
        grew = true;
      }
    }
  }
  const newLive = new Set<string>();
  const pending = reused.map(refOf);
  for (let ref = pending.pop(); ref !== undefined; ref = pending.pop()) {
    if (newLive.has(ref)) {
      continue;
    }
    newLive.add(ref);
    const node = baseLive.get(ref);
    if (node !== undefined) {
      pending.push(...childRefs(node));
    }
  }
  return [...baseLive.keys()].filter((ref) => !newLive.has(ref));
};

const isSortedUnique = (values: readonly string[]): boolean =>
  values.every((value, i) => i === 0 || values[i - 1]! < value);

/**
 * Encode `record` and derive its key under `prefix`. A record a GC
 * decoder would refuse is never encoded.
 *
 * @throws BaerlyError code="Internal" — the record breaks a record rule
 *   (a caller bug): a malformed identity, floor or entry; lists that are
 *   not sorted and unique; a superseded entry of the record's own
 *   attempt; a fold end not above the base floor; more than
 *   `TREE_GC_RECORD_MAX_KEYS` entries, or a body over its ceiling.
 * @throws BaerlyError code="InvalidConfig" — the key exceeds the storage
 *   key ceiling.
 */
export const sealFoldRecord = async (
  prefix: string,
  record: FoldRecord,
): Promise<SealedFoldRecord> => {
  const { attempt, base, result, fresh, superseded } = record;
  if (!isTreeAttempt(attempt)) {
    internal("the attempt is not 32 lowercase hex characters");
  }
  if (base.attempt !== null && !isTreeAttempt(base.attempt)) {
    internal("the base installer is not 32 lowercase hex characters");
  }
  if (base.root !== null && !REF_PATTERN.test(base.root)) {
    internal("the base root is not an <attempt>/<sha256> ref");
  }
  if (base.generation !== null && typeof base.generation !== "string") {
    internal("the base generation is not a string");
  }
  if (!Number.isSafeInteger(base.floor) || base.floor < 0) {
    internal("the base floor is not a non-negative safe integer");
  }
  if (!Number.isSafeInteger(result.floor) || !(result.floor > base.floor)) {
    internal("the fold end must be a safe integer above the base floor");
  }
  if (result.root !== null && !fresh.includes(result.root)) {
    internal("the new root is not one of the record's fresh nodes");
  }
  if (!fresh.every(isTreeSha256) || !isSortedUnique(fresh)) {
    internal("fresh is not a sorted, unique list of sha256 values");
  }
  if (!superseded.every((ref) => REF_PATTERN.test(ref)) || !isSortedUnique(superseded)) {
    internal("superseded is not a sorted, unique list of <attempt>/<sha256> refs");
  }
  if (superseded.some((ref) => ref.startsWith(`${attempt}/`))) {
    internal("superseded names a node of the record's own attempt");
  }
  if (fresh.length + superseded.length > TREE_GC_RECORD_MAX_KEYS) {
    internal(
      `the record lists ${fresh.length + superseded.length} keys, over ${TREE_GC_RECORD_MAX_KEYS}`,
    );
  }
  const bytes = encodeJsonBytes({
    format: TREE_FOLD_RECORD_FORMAT,
    schema_version: TREE_FOLD_RECORD_SCHEMA_VERSION,
    attempt,
    base: {
      floor: base.floor,
      root: base.root,
      attempt: base.attempt,
      generation: base.generation,
    },
    result: { floor: result.floor, root: result.root },
    fresh,
    superseded,
  });
  if (bytes.byteLength > TREE_GC_RECORD_MAX_BODY_BYTES) {
    internal(`the record body is ${bytes.byteLength} bytes, over its ceiling`);
  }
  const sha256 = await sha256Hex(bytes);
  return { key: treeRecordKey(prefix, base.floor, attempt, sha256), bytes, sha256 };
};

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * Strictly decode the fold record `bytes` read from `key`, a record key
 * under `prefix`: the body ceiling, the key's hash against the exact
 * bytes, fatal UTF-8, JSON, every field and rule `sealFoldRecord`
 * enforces, and byte equality with the canonical re-encoding. So a
 * decoded record is exactly what some publication sealed at that key.
 *
 * @throws BaerlyError code="InvalidResponse" — any check fails; the
 *   message names the key and the failed check.
 */
export const decodeFoldRecord = async (
  prefix: string,
  key: string,
  bytes: Uint8Array,
): Promise<FoldRecord> => {
  const fail: (detail: string) => never = (detail) => {
    throw new BaerlyError("InvalidResponse", `tree fold record ${JSON.stringify(key)}: ${detail}`);
  };
  const parts = parseTreeRecordKey(prefix, key);
  if (parts === null) {
    fail("the key is not a fold-record key of this collection");
  }
  if (bytes.byteLength > TREE_GC_RECORD_MAX_BODY_BYTES) {
    fail(`the body is ${bytes.byteLength} bytes, over its ceiling`);
  }
  if ((await sha256Hex(bytes)) !== parts.sha256) {
    fail("the body does not hash to the key");
  }
  let value: unknown;
  try {
    value = JSON.parse(fatalUtf8.decode(bytes));
  } catch {
    fail("the body is not UTF-8 JSON");
  }
  if (!isPlainObject(value)) {
    fail("the body is not an object");
  }
  if (value["format"] !== TREE_FOLD_RECORD_FORMAT) {
    fail("the format tag is not a fold record's");
  }
  if (value["schema_version"] !== TREE_FOLD_RECORD_SCHEMA_VERSION) {
    fail(
      unsupportedSchemaVersionMessage(
        "fold record",
        typeof value["schema_version"] === "number" ? value["schema_version"] : "a non-number",
        TREE_FOLD_RECORD_SCHEMA_VERSION,
      ),
    );
  }
  const base = value["base"];
  const result = value["result"];
  const fresh = value["fresh"];
  const superseded = value["superseded"];
  if (
    typeof value["attempt"] !== "string" ||
    !isPlainObject(base) ||
    typeof base["floor"] !== "number" ||
    !isStringOrNull(base["root"]) ||
    !isStringOrNull(base["attempt"]) ||
    !isStringOrNull(base["generation"]) ||
    !isPlainObject(result) ||
    typeof result["floor"] !== "number" ||
    !isStringOrNull(result["root"]) ||
    !Array.isArray(fresh) ||
    !fresh.every((entry) => typeof entry === "string") ||
    !Array.isArray(superseded) ||
    !superseded.every((entry) => typeof entry === "string")
  ) {
    fail("the body does not have the fields of a fold record");
  }
  const record: FoldRecord = {
    attempt: value["attempt"],
    base: {
      floor: base["floor"],
      root: base["root"],
      attempt: base["attempt"],
      generation: base["generation"],
    },
    result: { floor: result["floor"], root: result["root"] },
    fresh: fresh as string[],
    superseded: superseded as string[],
  };
  let sealed: SealedFoldRecord;
  try {
    sealed = await sealFoldRecord(prefix, record);
  } catch (error) {
    return fail(`the record breaks a record rule: ${(error as Error).message}`);
  }
  if (sealed.key !== key) {
    fail("the body's attempt or base floor is not the key's");
  }
  if (
    sealed.bytes.byteLength !== bytes.byteLength ||
    !sealed.bytes.every((b, i) => b === bytes[i])
  ) {
    fail("the body is not the canonical encoding of its value");
  }
  return record;
};
