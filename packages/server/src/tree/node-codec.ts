/**
 * Canonical encoding and strict decoding of prototype tree nodes.
 *
 * A node body is the UTF-8 of `JSON.stringify` of exactly one of four
 * objects, with the fields in this order and no others:
 *
 * | Kind        | Fields                                                                    |
 * | ----------- | ------------------------------------------------------------------------- |
 * | leaf        | `format, schema_version, collection, attempt, level, docs`                |
 * | root leaf   | `format, schema_version, collection, attempt, level, floor, rows, bytes, docs` |
 * | branch      | `format, schema_version, collection, attempt, level, children`            |
 * | root branch | `format, schema_version, collection, attempt, level, floor, rows, bytes, level_nodes, children` |
 *
 * A leaf (level 0) holds canonical documents in strictly increasing
 * `utf8-scalar-v1` `_id` order. A branch (level 1..16) holds 1..256
 * child entries `{lo, hi, rows, bytes, attempt, sha256}`, ordered and
 * disjoint by `[lo, hi]`; `attempt` and `sha256` name the child's key.
 * Only the root (the node the head points at) carries `floor` (the
 * head's folded seq), `rows` and `bytes` (the collection totals). A
 * root branch also carries `level_nodes`, the node count of each level
 * below it, so the fold can apply the root rule without reading a level.
 *
 * Every node body has exactly one valid spelling. {@link decodeNode}
 * therefore re-encodes what it parsed and requires byte equality, which
 * rejects whitespace, alternate escapes and number spellings, duplicate
 * members and anything a lenient JSON parser would let through. Every
 * malformed stored input surfaces as `BaerlyError` code
 * `InvalidResponse`, never as a raw `TypeError`, `SyntaxError` or
 * `RangeError` (`tests/unit/tree-node-decoder-fuzz.test.ts`).
 */
import {
  BaerlyError,
  type BaerlyErrorCode,
  encodeJsonBytes,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH,
  sha256Hex,
  unsupportedSchemaVersionMessage,
} from "@baerly/protocol";
import { assertPathSegment } from "../path-segment.ts";
import { assertSnapshotDocId, compareDocIds } from "../snapshot-doc-id.ts";
import {
  BRANCH_MAX_BODY_BYTES,
  BRANCH_MAX_ENTRIES,
  LEAF_MAX_BODY_BYTES,
  MIN_DOCUMENT_BYTES,
  TREE_FORMAT,
  TREE_MAX_LEVEL,
  TREE_MESSAGE_DETAIL_CHARS,
  TREE_MESSAGE_KEY_CHARS,
  TREE_MESSAGE_VALUE_CHARS,
  TREE_NODE_SCHEMA_VERSION,
} from "./constants.ts";
import {
  collectionOfPrefix,
  isTreeAttempt,
  isTreeSha256,
  parseTreeNodeKey,
  treeNodeKey,
} from "./key.ts";
import { DEFAULT_TREE_CONFIG, type TreeConfig } from "./layout.ts";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/** A value inside a canonical document. */
export type TreeValue =
  | null
  | string
  | number
  | boolean
  | readonly TreeValue[]
  | { readonly [key: string]: TreeValue };

/** A canonical stored document. */
export type TreeDocument = { readonly _id: string } & { readonly [key: string]: TreeValue };

/** The totals only a root node carries. */
export interface TreeRootTotals {
  /** The head's folded seq (`log_seq_start`) this root was built for. */
  readonly floor: number;
  /** Documents in the whole tree. */
  readonly rows: number;
  /** Canonical document bytes in the whole tree. */
  readonly bytes: number;
}

/** The fields a root branch carries beyond the totals. */
export interface TreeBranchRoot extends TreeRootTotals {
  /**
   * `levelNodes[ℓ]` is the number of nodes at level ℓ, for ℓ = 0 up to
   * the root's level − 1, each a positive safe integer. Stored as
   * `level_nodes`. The last count is the root's child count; each count
   * is between the next one and 256 times it; the first is at most
   * `rows`.
   */
  readonly levelNodes: readonly number[];
}

/** One branch entry: a child's ID range, totals and key. */
export interface TreeChildEntry {
  /** The child subtree's first `_id`. */
  readonly lo: string;
  /** The child subtree's last `_id`. */
  readonly hi: string;
  /** Documents in the child subtree (at least 1). */
  readonly rows: number;
  /** Canonical document bytes in the child subtree. */
  readonly bytes: number;
  /** The child's attempt identity. */
  readonly attempt: string;
  /** SHA-256 of the child's body. */
  readonly sha256: string;
}

export interface TreeLeafNode {
  readonly kind: "leaf";
  readonly collection: string;
  readonly attempt: string;
  readonly level: 0;
  /** Set exactly when this node is a root. */
  readonly root: TreeRootTotals | null;
  readonly docs: readonly TreeDocument[];
}

export interface TreeBranchNode {
  readonly kind: "branch";
  readonly collection: string;
  readonly attempt: string;
  /** 1..16; the tree depth when this node is the root. */
  readonly level: number;
  /** Set exactly when this node is a root. */
  readonly root: TreeBranchRoot | null;
  readonly children: readonly TreeChildEntry[];
}

export type TreeNode = TreeLeafNode | TreeBranchNode;

/**
 * What a node covers, derived from its body: what a parent entry for it
 * records. For a leaf, the first and last `_id`, the document count and
 * Σ canonical document bytes; for a branch, the first entry's `lo`, the
 * last entry's `hi` and the sums of `rows` and `bytes`.
 */
export interface TreeNodeSummary {
  readonly lo: string;
  readonly hi: string;
  readonly rows: number;
  readonly bytes: number;
}

/** A canonical document and its canonical byte length. */
export interface CanonicalDocument {
  readonly doc: TreeDocument;
  readonly id: string;
  /** `encodeJsonBytes(doc).byteLength`: the document bytes every count uses. */
  readonly bytes: number;
}

type Fail = (detail: string) => never;

/** `text`, cut to `max` UTF-16 code units with a trailing `…`. */
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * A stored value for an error message: a string JSON-quoted and cut to
 * {@link TREE_MESSAGE_VALUE_CHARS}, a number or boolean as is, anything
 * else by its kind. It never recurses, so no value can make it throw.
 */
const preview = (value: unknown): string => {
  switch (typeof value) {
    case "string": {
      return JSON.stringify(clip(value, TREE_MESSAGE_VALUE_CHARS));
    }
    case "number":
    case "boolean": {
      return String(value);
    }
    case "object": {
      if (value === null) {
        return "null";
      }
      return Array.isArray(value) ? "an array" : "an object";
    }
    default: {
      return `a ${typeof value}`;
    }
  }
};

// ---------------------------------------------------------------------
// Canonical documents
// ---------------------------------------------------------------------

/**
 * `canon(value)` at nesting `depth` (the document itself is level 1, and
 * each object or array is one level). Depth is an explicit counter, so a
 * deep input is refused before it can exhaust the stack.
 */
const canonValue = (value: unknown, depth: number, fail: Fail): TreeValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(`document value ${String(value)} is not a finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail(`document value of type ${typeof value} is not allowed`);
  }
  if (depth > MAX_DOCUMENT_DEPTH) {
    fail(`document nests deeper than ${MAX_DOCUMENT_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("document array has a non-standard prototype");
    }
    const out: TreeValue[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (descriptor === undefined || !("value" in descriptor)) {
        fail(`document array has a hole or accessor at index ${i}`);
      }
      out.push(canonValue(descriptor.value, depth + 1, fail));
    }
    // Every index is present, so any key past `length + 1` is an extra
    // own property, which JSON.stringify would silently drop.
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      fail("document array has an own property other than its indices and length");
    }
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail("document value is not a plain object");
  }
  // Keys keep their own-property order (`Reflect.ownKeys`): array-index
  // names ascending, as every JS object forces, then every other key in
  // insertion order. That is the order `JSON.stringify` of the post-image
  // writes, so a document reads back exactly as it was written whether or
  // not a fold has moved it into the tree.
  const keys: string[] = [];
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail("document object has a symbol key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable) {
      fail(`document key ${preview(key)} is not enumerable`);
    }
    if (!("value" in descriptor)) {
      fail(`document key ${preview(key)} is an accessor`);
    }
    values.set(key, descriptor.value);
    keys.push(key);
  }
  const out: Record<string, TreeValue> = {};
  for (const key of keys) {
    // defineProperty, not assignment, so an own "__proto__" stays a key.
    Object.defineProperty(out, key, {
      value: canonValue(values.get(key), depth + 1, fail),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
};

/**
 * Validate and canonicalize one stored document. Valid means: a plain
 * non-array object with an own string `_id` in the document-ID domain,
 * every value `null`, a string, finite number, boolean, array or plain
 * object, nesting at most `MAX_DOCUMENT_DEPTH`, and at most
 * `MAX_DOCUMENT_BYTES` canonical bytes. The `_id` is checked before it
 * is compared or hashed anywhere.
 */
const canonDocument = (value: unknown, fail: Fail): CanonicalDocument => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("document is not a plain object");
  }
  const idDescriptor = Object.getOwnPropertyDescriptor(value, "_id");
  if (
    idDescriptor === undefined ||
    !("value" in idDescriptor) ||
    typeof idDescriptor.value !== "string"
  ) {
    fail("document has no own string _id");
  }
  const id: string = idDescriptor.value;
  try {
    assertSnapshotDocId(id);
  } catch (error) {
    fail(
      `document _id ${preview(id)} is outside the document-ID domain: ${(error as Error).message}`,
    );
  }
  const doc = canonValue(value, 1, fail) as TreeDocument;
  const bytes = encodeJsonBytes(doc).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) {
    fail(
      `document ${preview(id)} is ${bytes} bytes, over the ${MAX_DOCUMENT_BYTES}-byte document limit`,
    );
  }
  return { doc, id, bytes };
};

const failWith =
  (code: BaerlyErrorCode, where: string): Fail =>
  (detail: string): never => {
    throw new BaerlyError(code, `${where}: ${clip(detail, TREE_MESSAGE_DETAIL_CHARS)}`);
  };

/**
 * Validate and canonicalize a stored document (a log post-image, say).
 * The canonical form keeps the value's own-property order: array-index
 * names (`"0"`, `"1"`, … up to 4,294,967,294) in numeric order, then
 * every other key in insertion order, exactly as `JSON.stringify` writes
 * it. Nothing is normalized or reordered: strings other than `_id` may
 * hold any UTF-16, including unpaired surrogates, and two documents that
 * differ only in key order are different canonical documents.
 *
 * @param where  names the stored object for the message (for example
 *   `log seq 12`).
 * @throws BaerlyError code="InvalidResponse" — the document is not valid
 *   stored data.
 */
export const canonicalDocument = (value: unknown, where: string): CanonicalDocument =>
  canonDocument(value, failWith("InvalidResponse", where));

// ---------------------------------------------------------------------
// Shared node validation
// ---------------------------------------------------------------------

/** A node's fields before validation, from a parsed body or a caller's node. */
interface RawNode {
  readonly kind: "leaf" | "branch";
  readonly isRoot: boolean;
  readonly collection: unknown;
  readonly attempt: unknown;
  readonly level: unknown;
  readonly floor: unknown;
  readonly rows: unknown;
  readonly bytes: unknown;
  /** A root branch's `level_nodes`; unread for any other node. */
  readonly levelNodes: unknown;
  /** `docs` for a leaf, `children` for a branch. */
  readonly items: unknown;
}

interface ValidatedNode {
  readonly node: TreeNode;
  readonly summary: TreeNodeSummary;
}

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const checkId = (value: unknown, field: string, fail: Fail): string => {
  if (typeof value !== "string") {
    fail(`${field} is not a string`);
  }
  try {
    assertSnapshotDocId(value);
  } catch (error) {
    fail(
      `${field} ${preview(value)} is outside the document-ID domain: ${(error as Error).message}`,
    );
  }
  return value;
};

const checkEntry = (value: unknown, index: number, fail: Fail): TreeChildEntry => {
  const at = `children[${index}]`;
  if (!isPlainRecord(value)) {
    fail(`${at} is not an object`);
  }
  const lo = checkId(value["lo"], `${at}.lo`, fail);
  const hi = checkId(value["hi"], `${at}.hi`, fail);
  if (compareDocIds(lo, hi) > 0) {
    fail(`${at} has lo after hi`);
  }
  const rows = value["rows"];
  if (!Number.isSafeInteger(rows) || (rows as number) < 1) {
    fail(`${at}.rows is not a safe integer ≥ 1`);
  }
  const bytes = value["bytes"];
  if (!isNonNegativeSafeInteger(bytes)) {
    fail(`${at}.bytes is not a non-negative safe integer`);
  }
  // BigInt keeps the product exact for any safe-integer row count.
  if (BigInt(bytes) < BigInt(MIN_DOCUMENT_BYTES) * BigInt(rows as number)) {
    fail(`${at}.bytes is below ${MIN_DOCUMENT_BYTES} × rows`);
  }
  const attempt = value["attempt"];
  if (!isTreeAttempt(attempt)) {
    fail(`${at}.attempt is not 32 lowercase hex characters`);
  }
  const sha256 = value["sha256"];
  if (!isTreeSha256(sha256)) {
    fail(`${at}.sha256 is not 64 lowercase hex characters`);
  }
  return { lo, hi, rows: rows as number, bytes, attempt, sha256 };
};

const addSafe = (total: number, add: number, what: string, fail: Fail): number => {
  const sum = total + add;
  if (!Number.isSafeInteger(sum)) {
    fail(`running ${what} total leaves the safe-integer range`);
  }
  return sum;
};

/**
 * A root branch's `level_nodes`: `level` positive safe integers whose
 * last is the root's child count, each between the next and
 * `BRANCH_MAX_ENTRIES` times the next, the first at most `rows`. The
 * exact counts need the whole tree, so they are not checked here.
 */
const checkLevelNodes = (
  value: unknown,
  level: number,
  childCount: number,
  rows: number,
  fail: Fail,
): number[] => {
  if (!Array.isArray(value) || value.length !== level) {
    fail(`level_nodes is not an array of ${level} counts, one per level below the root`);
  }
  const counts: number[] = [];
  for (const [index, count] of value.entries()) {
    if (!Number.isSafeInteger(count) || (count as number) < 1) {
      fail(`level_nodes[${index}] is not a positive safe integer`);
    }
    counts.push(count as number);
  }
  if (counts[level - 1] !== childCount) {
    fail(`level_nodes[${level - 1}] ${counts[level - 1]} is not the root's ${childCount} children`);
  }
  for (let l = 0; l < level - 1; l++) {
    const below = counts[l]!;
    const above = counts[l + 1]!;
    // Multiplying by a power of two is exact in a double.
    if (below < above || below > BRANCH_MAX_ENTRIES * above) {
      fail(
        `level_nodes[${l}] ${below} is not between level_nodes[${l + 1}] ${above} and ${BRANCH_MAX_ENTRIES} times it`,
      );
    }
  }
  if (counts[0]! > rows) {
    fail(`level_nodes[0] ${counts[0]} is more than the ${rows} rows`);
  }
  return counts;
};

/**
 * Every value rule a node obeys, independent of where it came from. The
 * result holds canonical documents and entries rebuilt with exactly
 * their six fields, so serializing it is the canonical encoding.
 */
const validateNode = (raw: RawNode, fail: Fail): ValidatedNode => {
  const { collection, attempt, level } = raw;
  if (typeof collection !== "string") {
    fail("collection is not a string");
  }
  try {
    // A decoder takes the collection from its prefix, which only yields
    // valid segments, so no reader accepts a body naming anything else.
    assertPathSegment(collection, "collection");
  } catch (error) {
    fail(
      `collection ${preview(collection)} is not a valid collection name: ${(error as Error).message}`,
    );
  }
  if (!isTreeAttempt(attempt)) {
    fail("attempt is not 32 lowercase hex characters");
  }
  let root: TreeRootTotals | null = null;
  if (raw.isRoot) {
    const { floor, rows, bytes } = raw;
    if (!isNonNegativeSafeInteger(floor)) {
      fail("floor is not a non-negative safe integer");
    }
    if (!isNonNegativeSafeInteger(rows)) {
      fail("rows is not a non-negative safe integer");
    }
    if (!isNonNegativeSafeInteger(bytes)) {
      fail("bytes is not a non-negative safe integer");
    }
    root = { floor, rows, bytes };
  }
  let validated: ValidatedNode;
  if (raw.kind === "leaf") {
    if (level !== 0) {
      fail("leaf level is not 0");
    }
    const items = raw.items;
    if (!Array.isArray(items) || items.length === 0) {
      fail("docs is not a non-empty array");
    }
    const docs: TreeDocument[] = [];
    let total = 0;
    let previous: string | null = null;
    for (const item of items) {
      const canonical = canonDocument(item, fail);
      if (previous !== null && compareDocIds(previous, canonical.id) >= 0) {
        fail(`docs _id ${preview(canonical.id)} does not strictly follow ${preview(previous)}`);
      }
      previous = canonical.id;
      total = addSafe(total, canonical.bytes, "bytes", fail);
      docs.push(canonical.doc);
    }
    validated = {
      node: { kind: "leaf", collection, attempt, level: 0, root, docs },
      summary: { lo: docs[0]!._id, hi: previous!, rows: docs.length, bytes: total },
    };
  } else {
    if (
      !Number.isSafeInteger(level) ||
      (level as number) < 1 ||
      (level as number) > TREE_MAX_LEVEL
    ) {
      fail(`branch level is not an integer in 1..${TREE_MAX_LEVEL}`);
    }
    const items = raw.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > BRANCH_MAX_ENTRIES) {
      fail(`children is not an array of 1..${BRANCH_MAX_ENTRIES} entries`);
    }
    const children: TreeChildEntry[] = [];
    let rowTotal = 0;
    let byteTotal = 0;
    for (const [index, item] of items.entries()) {
      const entry = checkEntry(item, index, fail);
      const previous = children.at(-1);
      if (previous !== undefined && compareDocIds(previous.hi, entry.lo) >= 0) {
        fail(`children[${index}] does not start after children[${index - 1}].hi`);
      }
      rowTotal = addSafe(rowTotal, entry.rows, "rows", fail);
      byteTotal = addSafe(byteTotal, entry.bytes, "bytes", fail);
      children.push(entry);
    }
    const branchRoot: TreeBranchRoot | null =
      root === null
        ? null
        : {
            ...root,
            levelNodes: checkLevelNodes(
              raw.levelNodes,
              level as number,
              children.length,
              root.rows,
              fail,
            ),
          };
    validated = {
      node: {
        kind: "branch",
        collection,
        attempt,
        level: level as number,
        root: branchRoot,
        children,
      },
      summary: { lo: children[0]!.lo, hi: children.at(-1)!.hi, rows: rowTotal, bytes: byteTotal },
    };
  }
  if (root !== null) {
    if (root.rows !== validated.summary.rows) {
      fail(`root rows ${root.rows} do not equal the node's ${validated.summary.rows}`);
    }
    if (root.bytes !== validated.summary.bytes) {
      fail(`root bytes ${root.bytes} do not equal the node's ${validated.summary.bytes}`);
    }
  }
  return validated;
};

// ---------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------

/**
 * Serialize a validated node in field order. Every field name is a
 * non-index string, so insertion order is the emitted order.
 */
const serializeNode = (node: TreeNode): Uint8Array => {
  const head = {
    format: TREE_FORMAT,
    schema_version: TREE_NODE_SCHEMA_VERSION,
    collection: node.collection,
    attempt: node.attempt,
    level: node.level,
  };
  const totals =
    node.root === null
      ? {}
      : { floor: node.root.floor, rows: node.root.rows, bytes: node.root.bytes };
  const body =
    node.kind === "leaf"
      ? { ...head, ...totals, docs: node.docs }
      : {
          ...head,
          ...totals,
          ...(node.root === null ? {} : { level_nodes: [...node.root.levelNodes] }),
          children: node.children.map((e) => ({
            lo: e.lo,
            hi: e.hi,
            rows: e.rows,
            bytes: e.bytes,
            attempt: e.attempt,
            sha256: e.sha256,
          })),
        };
  return encodeJsonBytes(body);
};

const rawFromNode = (node: TreeNode): RawNode => ({
  kind: node.kind,
  isRoot: node.root !== null,
  collection: node.collection,
  attempt: node.attempt,
  level: node.level,
  floor: node.root?.floor,
  rows: node.root?.rows,
  bytes: node.root?.bytes,
  levelNodes: node.kind === "branch" ? node.root?.levelNodes : undefined,
  items: node.kind === "leaf" ? node.docs : node.children,
});

const encodeValidated = (node: TreeNode, fail: Fail): ValidatedNode & { bytes: Uint8Array } => {
  const validated = validateNode(rawFromNode(node), fail);
  const bytes = serializeNode(validated.node);
  const ceiling = node.kind === "leaf" ? LEAF_MAX_BODY_BYTES : BRANCH_MAX_BODY_BYTES;
  if (bytes.byteLength > ceiling) {
    fail(
      `${node.kind} body is ${bytes.byteLength} bytes, over the ${ceiling}-byte decoder ceiling`,
    );
  }
  return { ...validated, bytes };
};

/**
 * The canonical body of `node`. Documents are canonicalized, entries
 * keep exactly their six fields, and the result is what
 * {@link decodeNode} accepts for this node.
 *
 * @throws BaerlyError code="Internal" — `node` breaks a node rule, or
 *   its body would exceed the decoder ceiling for its kind. Tree code
 *   builds every node it encodes, so either is a bug.
 */
export const encodeNode = (node: TreeNode): Uint8Array =>
  encodeValidated(node, failWith("Internal", "tree node encode")).bytes;

/** A node ready to publish: its key, canonical body, content hash and summary. */
export interface SealedTreeNode {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly summary: TreeNodeSummary;
}

/**
 * Encode `node` and derive its key under `prefix`.
 *
 * @throws BaerlyError code="Internal" — as for {@link encodeNode}, or
 *   `node.collection` is not the collection of `prefix`.
 * @throws BaerlyError code="InvalidConfig" — the key exceeds the storage
 *   key ceiling, or `prefix` has no valid collection segment.
 */
export const sealNode = async (prefix: string, node: TreeNode): Promise<SealedTreeNode> => {
  const fail = failWith("Internal", "tree node encode");
  if (node.collection !== collectionOfPrefix(prefix)) {
    fail(`collection ${preview(node.collection)} is not the collection of the prefix`);
  }
  const { bytes, summary } = encodeValidated(node, fail);
  const sha256 = await sha256Hex(bytes);
  return { key: treeNodeKey(prefix, node.attempt, sha256), bytes, sha256, summary };
};

// ---------------------------------------------------------------------
// Strict decode
// ---------------------------------------------------------------------

const LEAF_FIELDS = ["format", "schema_version", "collection", "attempt", "level", "docs"];
const ROOT_LEAF_FIELDS = [
  "format",
  "schema_version",
  "collection",
  "attempt",
  "level",
  "floor",
  "rows",
  "bytes",
  "docs",
];
const BRANCH_FIELDS = ["format", "schema_version", "collection", "attempt", "level", "children"];
const ROOT_BRANCH_FIELDS = [
  "format",
  "schema_version",
  "collection",
  "attempt",
  "level",
  "floor",
  "rows",
  "bytes",
  "level_nodes",
  "children",
];
const ENTRY_FIELDS = ["lo", "hi", "rows", "bytes", "attempt", "sha256"];

interface NodeShape {
  readonly fields: readonly string[];
  readonly kind: "leaf" | "branch";
  readonly isRoot: boolean;
}

const NON_ROOT_SHAPES: readonly NodeShape[] = [
  { fields: LEAF_FIELDS, kind: "leaf", isRoot: false },
  { fields: BRANCH_FIELDS, kind: "branch", isRoot: false },
];
const ROOT_SHAPES: readonly NodeShape[] = [
  { fields: ROOT_LEAF_FIELDS, kind: "leaf", isRoot: true },
  { fields: ROOT_BRANCH_FIELDS, kind: "branch", isRoot: true },
];

/** The node shapes each `expected.root` value allows. */
const SHAPES_BY_ROOT: Readonly<Record<"true" | "false" | "either", readonly NodeShape[]>> = {
  true: ROOT_SHAPES,
  false: NON_ROOT_SHAPES,
  either: [...NON_ROOT_SHAPES, ...ROOT_SHAPES],
};

const sameSequence = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The checks of {@link decodeNode}, in the order they run. The names are
 * part of the format: `BaerlyError` has no field for the failing check,
 * so every failure message names the key and carries the tag
 * `<check> check failed`, and tests and tools identify the check by that
 * tag.
 */
export type TreeDecodeCheck =
  | "key"
  | "present"
  | "leaf-ceiling"
  | "hash"
  | "utf-8"
  | "json"
  | "structure"
  | "canonical-bytes"
  | "context";

/** Where a node was routed from, which fixes what it must look like. */
export interface TreeNodeExpectation {
  /**
   * The collection prefix `P` (the `current.json` key without
   * `/current.json`). The key must lie under it, and the body's
   * `collection` must be its last segment: the collection always comes
   * from `P`, never from the body.
   */
  readonly prefix: string;
  /**
   * `true` when routed from the head, `false` when routed from a parent
   * entry, `"either"` for a GC candidate.
   */
  readonly root: boolean | "either";
  /** When routed from a parent: the parent's level − 1. */
  readonly level?: number;
  /** When routed from a parent: the entry that named this node. */
  readonly entry?: Pick<TreeChildEntry, "lo" | "hi" | "rows" | "bytes">;
  /** When routed from the head: the head's `log_seq_start`. */
  readonly floor?: number;
}

/** A strictly decoded node. */
export interface DecodedTreeNode {
  readonly key: string;
  readonly attempt: string;
  readonly sha256: string;
  readonly node: TreeNode;
  readonly summary: TreeNodeSummary;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Strictly decode the stored node `bytes` read from `key`. The checks
 * run in this order, and the first failure throws:
 *
 * 1. `key`: the key parses as a node key under `expected.prefix`.
 * 2. `present`: the body is non-null (a missing referenced node fails here).
 * 3. `leaf-ceiling`: the body is at most `LEAF_MAX_BODY_BYTES`, for every
 *    node, before its kind is known.
 * 4. `hash`: `sha256Hex(bytes)` equals the key's hash.
 * 5. `utf-8`: the body is valid UTF-8. A BOM is kept, so step 6 rejects it.
 * 6. `json`: the text parses as JSON.
 * 7. `structure`: the value is an object whose keys, in order, are one
 *    node field list `expected.root` allows; a branch body is at most
 *    `BRANCH_MAX_BODY_BYTES`; `format` and `schema_version` match;
 *    `collection` is the prefix's collection and `attempt` the key's;
 *    every field has its type and range; documents are valid with
 *    strictly increasing `_id`s; entries have exactly their six fields
 *    and are ordered and disjoint; running totals stay safe integers and
 *    a root's totals equal its sums; a root branch's `level_nodes` has
 *    one positive count per level, the last equal to its child count,
 *    each between the next and 256 times it, the first at most `rows`.
 * 8. `canonical-bytes`: the canonical re-encoding of the parsed node
 *    equals `bytes` byte for byte.
 * 9. `context`: `expected.level`, `expected.entry` (`lo`, `hi`, `rows`,
 *    `bytes` against the body's summary) and `expected.floor` match.
 *
 * @param config  the tree configuration; tests pass a mutant here.
 * @throws BaerlyError code="InvalidResponse" — any check fails.
 * @throws BaerlyError code="InvalidConfig" — `expected.prefix` has no
 *   valid collection segment (a caller bug, not stored data).
 */
export const decodeNode = async (
  key: string,
  bytes: Uint8Array | null,
  expected: TreeNodeExpectation,
  config: TreeConfig = DEFAULT_TREE_CONFIG,
): Promise<DecodedTreeNode> => {
  const collection = collectionOfPrefix(expected.prefix);
  const where = `tree node ${JSON.stringify(clip(key, TREE_MESSAGE_KEY_CHARS))}`;
  const failAt =
    (check: TreeDecodeCheck): Fail =>
    (detail: string): never => {
      throw new BaerlyError(
        "InvalidResponse",
        `${where}: ${check} check failed: ${clip(detail, TREE_MESSAGE_DETAIL_CHARS)}`,
      );
    };

  // TypeScript narrows after a `never` call only through an explicitly
  // typed binding, so each check gets one.
  const failKey: Fail = failAt("key");
  const failPresent: Fail = failAt("present");
  const failLeafCeiling: Fail = failAt("leaf-ceiling");
  const failHash: Fail = failAt("hash");
  const failUtf8: Fail = failAt("utf-8");
  const failJson: Fail = failAt("json");
  const structure: Fail = failAt("structure");
  const context: Fail = failAt("context");

  // 1. Key.
  const parts = parseTreeNodeKey(expected.prefix, key);
  if (parts === null) {
    failKey(`not a node key under ${preview(expected.prefix)}`);
  }
  // 2. Present.
  if (bytes === null) {
    failPresent("the referenced node is missing");
  }
  // 3. Leaf ceiling.
  if (bytes.byteLength > LEAF_MAX_BODY_BYTES) {
    failLeafCeiling(
      `body is ${bytes.byteLength} bytes, over the ${LEAF_MAX_BODY_BYTES}-byte node ceiling`,
    );
  }
  // 4. Hash.
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== parts.sha256) {
    failHash(`body hashes to ${sha256}`);
  }
  // 5. UTF-8.
  let text: string;
  try {
    text = fatalUtf8.decode(bytes);
  } catch {
    failUtf8("body is not valid UTF-8");
  }
  // 6. JSON.
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    failJson(error instanceof Error ? error.message : "body is not JSON");
  }
  // Steps 7 to 9 read the parsed value, which can be anything JSON
  // allows. Whatever else throws in them surfaces as InvalidResponse
  // tagged with the check that was running, never as a raw error.
  let current: TreeDecodeCheck = "structure";
  try {
    // 7. Structure.
    if (!isPlainRecord(value)) {
      structure("body is not a JSON object");
    }
    const keys = Object.keys(value);
    const shapes = SHAPES_BY_ROOT[String(expected.root) as "true" | "false" | "either"];
    const shape = shapes.find((s) => sameSequence(s.fields, keys));
    if (shape === undefined) {
      structure(`field list [${keys.map(preview).join(", ")}] is not one this node may have`);
    }
    if (shape.kind === "branch" && bytes.byteLength > BRANCH_MAX_BODY_BYTES) {
      structure(
        `branch body is ${bytes.byteLength} bytes, over the ${BRANCH_MAX_BODY_BYTES}-byte branch ceiling`,
      );
    }
    if (value["format"] !== TREE_FORMAT) {
      structure(`format is ${preview(value["format"])}, not ${JSON.stringify(TREE_FORMAT)}`);
    }
    if (value["schema_version"] !== TREE_NODE_SCHEMA_VERSION) {
      structure(
        unsupportedSchemaVersionMessage(
          "node",
          // Only a number is passed through: the shared message stringifies
          // what it gets, which a deep or oversize value would break.
          typeof value["schema_version"] === "number"
            ? value["schema_version"]
            : preview(value["schema_version"]),
          TREE_NODE_SCHEMA_VERSION,
        ),
      );
    }
    if (value["collection"] !== collection) {
      structure(
        `collection ${preview(value["collection"])} is not the prefix's ${JSON.stringify(collection)}`,
      );
    }
    if (value["attempt"] !== parts.attempt) {
      structure(`attempt ${preview(value["attempt"])} is not the key's ${parts.attempt}`);
    }
    const items = value[shape.kind === "leaf" ? "docs" : "children"];
    if (shape.kind === "branch" && Array.isArray(items)) {
      for (const [index, entry] of items.entries()) {
        if (!isPlainRecord(entry) || !sameSequence(ENTRY_FIELDS, Object.keys(entry))) {
          structure(
            `children[${index}] does not have exactly the fields ${ENTRY_FIELDS.join(", ")}`,
          );
        }
      }
    }
    const { node, summary } = validateNode(
      {
        kind: shape.kind,
        isRoot: shape.isRoot,
        collection: value["collection"],
        attempt: value["attempt"],
        level: value["level"],
        floor: value["floor"],
        rows: value["rows"],
        bytes: value["bytes"],
        levelNodes: value["level_nodes"],
        items,
      },
      structure,
    );
    // 8. Canonical bytes.
    current = "canonical-bytes";
    if (!config.steps.canonicalBytesMatch(bytes, serializeNode(node))) {
      failAt("canonical-bytes")("body is not the canonical encoding of its value");
    }
    // 9. Context.
    current = "context";
    if (expected.level !== undefined && node.level !== expected.level) {
      context(`level ${node.level} is not the expected ${expected.level}`);
    }
    if (expected.entry !== undefined) {
      for (const field of ["lo", "hi", "rows", "bytes"] as const) {
        if (summary[field] !== expected.entry[field]) {
          context(
            `${field} ${preview(summary[field])} does not match the parent entry's ${preview(expected.entry[field])}`,
          );
        }
      }
    }
    if (expected.floor !== undefined && node.root?.floor !== expected.floor) {
      context(`floor ${String(node.root?.floor)} is not the head's ${expected.floor}`);
    }
    return { key, attempt: parts.attempt, sha256, node, summary };
  } catch (error) {
    if (error instanceof BaerlyError) {
      throw error;
    }
    return failAt(current)(
      `unexpected ${error instanceof Error ? error.name : typeof error}: ${error instanceof Error ? error.message : "non-error value thrown"}`,
    );
  }
};
