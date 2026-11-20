/**
 * Physical and structural oracle for the prolly-tree node format.
 *
 * Given a bucket image (key → bytes plus a recorded SHA-256 per object) and a
 * collection prefix `P`, {@link checkTreeImage} reads `<P>/current.json`,
 * walks the tree its `proto_tree.root` names, and reports every way the image
 * departs from the format:
 *
 * - **Keys and bytes.** Every node key is `<P>/_v99/n/<attempt>/<sha256>`
 *   (32 and 64 lowercase hex characters, nothing else), every referenced child
 *   exists, and `sha256` is the hash of the exact stored body. The image's own
 *   recorded digest must match the bytes too.
 * - **Bodies.** Each body is strict UTF-8 JSON with exactly the field list of
 *   one node kind, in order, the right types and ranges, valid documents, and
 *   byte-equal to its canonical re-encoding (no alternate number spellings,
 *   escapes, whitespace or duplicate members).
 * - **Structure.** Levels decrease by exactly one from parent to child;
 *   documents in a leaf, entries in a branch and leaves across the tree are
 *   strictly ordered by `utf8-scalar-v1` (UTF-8 bytes, a proper prefix
 *   first); each parent entry's `lo`, `hi`, `rows` and `bytes` equal what the
 *   child's body yields; the root's totals equal its sums and the head's; a
 *   root branch's `level_nodes` equal the node count reachable at each level
 *   and exceed `Fmax` below the root's children.
 * - **Boundaries.** Every leaf and branch cut sits exactly where the
 *   content-defined chunking rule puts it under the head's
 *   `proto_tree.chunk_salt`, including the forced cuts and the cuts around an
 *   isolated large document, and no cut sits anywhere else. Messages name the
 *   salt field, never its value.
 * - **Whole-level rules.** The depth-0 rule (one root leaf while the row count
 *   and the document bytes are both at or under their limits, inclusive) and
 *   the root rule (a level whose entries fit one branch is the root) hold.
 * - **Canonical root.** The identity-free shape of the stored tree equals the
 *   shape {@link buildCanonicalShape} derives from the row set alone.
 *
 * The oracle shares no code with the tree implementation: the key grammar,
 * node parser, canonical document encoding, salted chunk hash (HMAC-SHA-256)
 * and chunking predicates are restated here from the format rules, and every numeric constant below
 * is a restatement, not an import. Its UTF-8 order is a hand-written encoder
 * and byte comparison; `tests/unit/tree-oracle-physical.test.ts` checks it
 * against `compareDocIds` and the logical oracle's comparator, since a shared
 * order bug would hide in both.
 *
 * {@link buildCanonicalShape} and {@link materializeTree} also make the
 * oracle a reference encoder, so tests can hand-build bad images: build the
 * canonical shape, perturb it (or the bytes), materialize, and require a
 * violation. {@link buildShapeWithOrder} is the one mutant seam, an ordering
 * function swapped in for `utf8-scalar-v1`.
 *
 * For fold tests, {@link checkSplitEquivalence} requires that every published
 * root for one row set, whatever fold split produced it, is the canonical
 * root, and {@link foldThroughSplits} folds a log through a list of split
 * points with the logical oracle.
 */

import { createHash, createHmac } from "node:crypto";
import type { DocumentData, Storage } from "@baerly/protocol";
import { foldLogical, type LogicalFoldInput, type LogicalView } from "./tree-oracle-logical.ts";

// ---------------------------------------------------------------------------
// Constants, restated independently of the tree implementation.

/** Namespace segment under the collection prefix. */
export const TREE_NS = "_v99";
/** Node `format` tag. */
export const NODE_FORMAT = "baerly-tree-node-proto";
/** Node `schema_version`. */
export const NODE_SCHEMA_VERSION = 1;
/** Head `schema_version` (`current.json` schema 3). */
const HEAD_SCHEMA_VERSION = 3;
/** ASCII domain prefix of the chunk hash message. */
export const CHUNK_DOMAIN = "baerly-tree-chunk-v2";
/**
 * The published chunk salt for pinned vectors and tests. Production mints a
 * random salt per collection; this one is never valid outside tests.
 */
export const TEST_CHUNK_SALT = "000102030405060708090a0b0c0d0e0f";
/** A chunk salt: 16 bytes as 32 lowercase hex characters. */
const CHUNK_SALT = /^[0-9a-f]{32}$/;
/** Largest valid node `level`. */
export const MAX_LEVEL = 16;
/** Ceiling on a branch body, in bytes. */
export const BRANCH_MAX_BODY_BYTES = 524_288;
/** Ceiling on any node body, checked before the kind is known. */
export const LEAF_MAX_BODY_BYTES = 2_097_152;
/** Largest stored document, in canonical bytes. */
export const MAX_DOCUMENT_BYTES = 1_048_576;
/** Container nesting limit, counting the document itself as 1. */
export const MAX_DOCUMENT_DEPTH = 100;
/** Largest document ID, in UTF-8 bytes. */
export const MAX_ID_BYTES = 256;
/** The smallest document, `{"_id":"x"}`. */
export const MIN_DOCUMENT_BYTES = 11;
/** Largest entry count of one branch. */
export const MAX_BRANCH_ENTRIES = 256;
/** 2^32, the chunk hash range. */
const HASH_RANGE = 4_294_967_296;

/** The chunking layout. Field names follow the format's `TreeLayout`. */
export interface OracleLayout {
  readonly singleLeafMaxBytes: number;
  readonly singleLeafMaxRows: number;
  readonly leafTargetBytes: number;
  readonly leafMinBytes: number;
  readonly leafMaxBytes: number;
  readonly leafIsolationDocumentBytes: number;
  readonly branchFanoutMin: number;
  readonly branchFanoutTarget: number;
  readonly branchFanoutMax: number;
}

/** The production layout. */
export const PRODUCTION_LAYOUT: OracleLayout = Object.freeze({
  singleLeafMaxBytes: 524_288,
  singleLeafMaxRows: 2_048,
  leafTargetBytes: 16_384,
  leafMinBytes: 8_192,
  leafMaxBytes: 24_576,
  leafIsolationDocumentBytes: 24_576,
  branchFanoutMin: 4,
  branchFanoutTarget: 32,
  branchFanoutMax: 128,
});

/** A small test layout that makes 15 to 20 short rows a tree of depth 2 or 3. */
export const TEST_LAYOUT: OracleLayout = Object.freeze({
  singleLeafMaxBytes: 0,
  singleLeafMaxRows: 0,
  leafTargetBytes: 32,
  leafMinBytes: 16,
  leafMaxBytes: 48,
  leafIsolationDocumentBytes: 48,
  branchFanoutMin: 2,
  branchFanoutTarget: 2,
  branchFanoutMax: 3,
});

/**
 * Refuse a layout the format would reject. Oracle misuse throws a plain
 * `Error`: the rules are exactly the nine layout fields and no other own
 * property, all safe integers, the leaf maximum is `2 × target − min` and at
 * most 512 KiB, `1 ≤ min < target`, the isolation size lies in
 * `[2 × (min + 1), max]`, the branch target is a power of two in
 * `[2, 65536]`, `2 ≤ Fmin ≤ Fmax ≤ 256`, and the depth-0 limits lie in
 * `[0, 1 MiB]` and `[0, 65536]`.
 */
const LAYOUT_FIELDS = [
  "singleLeafMaxBytes",
  "singleLeafMaxRows",
  "leafTargetBytes",
  "leafMinBytes",
  "leafMaxBytes",
  "leafIsolationDocumentBytes",
  "branchFanoutMin",
  "branchFanoutTarget",
  "branchFanoutMax",
] as const;

export const assertOracleLayout = (layout: OracleLayout): void => {
  const names = Reflect.ownKeys(layout);
  const ok =
    names.length === LAYOUT_FIELDS.length &&
    LAYOUT_FIELDS.every((name) => Object.hasOwn(layout, name)) &&
    LAYOUT_FIELDS.every((name) => Number.isSafeInteger(layout[name])) &&
    layout.leafMinBytes >= 1 &&
    layout.leafMinBytes < layout.leafTargetBytes &&
    layout.leafMaxBytes === 2 * layout.leafTargetBytes - layout.leafMinBytes &&
    layout.leafMaxBytes <= 524_288 &&
    2 * (layout.leafMinBytes + 1) <= layout.leafIsolationDocumentBytes &&
    layout.leafIsolationDocumentBytes <= layout.leafMaxBytes &&
    layout.branchFanoutTarget >= 2 &&
    layout.branchFanoutTarget <= 65_536 &&
    (layout.branchFanoutTarget & (layout.branchFanoutTarget - 1)) === 0 &&
    layout.branchFanoutMin >= 2 &&
    layout.branchFanoutMin <= layout.branchFanoutMax &&
    layout.branchFanoutMax <= 256 &&
    layout.singleLeafMaxBytes >= 0 &&
    layout.singleLeafMaxBytes <= 1_048_576 &&
    layout.singleLeafMaxRows >= 0 &&
    layout.singleLeafMaxRows <= 65_536;
  if (!ok) {
    throw new Error(`tree oracle: invalid layout ${JSON.stringify(layout)}`);
  }
};

// ---------------------------------------------------------------------------
// IDs and order.

/**
 * UTF-8 bytes of a well-formed string, encoded by hand rather than with
 * `TextEncoder` so the order below is a second implementation. A lone
 * surrogate is encoded as U+FFFD, as every encoder does; IDs never hold one.
 */
export const utf8Bytes = (text: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
};

/**
 * `utf8-scalar-v1`: lexicographic order of UTF-8 bytes, a proper prefix
 * first. Returns `-1`, `0` or `1`. Not JS `<`, which compares UTF-16 code
 * units and disagrees whenever a U+E000–U+FFFF character meets an astral one.
 */
export const compareIds = (left: string, right: string): number => {
  const a = utf8Bytes(left);
  const b = utf8Bytes(right);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) {
      return a[i]! < b[i]! ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
};

/**
 * Why `id` is not a valid document ID, or `undefined` when it is. A valid ID
 * is a non-empty string with no `/`, not `.` or `..`, no U+0000–U+001F or
 * U+007F–U+009F, not starting with `_`, at most 256 UTF-8 bytes, and with no
 * unpaired surrogate. There is no normalization requirement.
 */
export const idViolation = (id: unknown): string | undefined => {
  if (typeof id !== "string") {
    return "not a string";
  }
  if (id.length === 0) {
    return "empty";
  }
  if (id === "." || id === "..") {
    return "dot segment";
  }
  if (id.startsWith("_")) {
    return "leading underscore";
  }
  for (let i = 0; i < id.length; i++) {
    const unit = id.charCodeAt(i);
    if (unit === 0x2f) {
      return "contains /";
    }
    if (unit <= 0x1f || (unit >= 0x7f && unit <= 0x9f)) {
      return "control character";
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < id.length ? id.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) {
        return "unpaired surrogate";
      }
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return "unpaired surrogate";
    }
  }
  if (utf8Bytes(id).length > MAX_ID_BYTES) {
    return "over 256 UTF-8 bytes";
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Canonical documents.

class DomainError extends Error {}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
const isArrayIndexName = (key: string): boolean =>
  ARRAY_INDEX.test(key) && Number(key) <= 4_294_967_294;

/**
 * The canonical form of a document value. Strings (any UTF-16, nothing
 * normalized), booleans, finite numbers, arrays and plain objects (prototype
 * `Object.prototype` or `null`, only own enumerable string-keyed data
 * properties) are in the domain; `null`, `undefined`, functions, symbols,
 * bigints, accessors, array holes, own array properties other than the
 * indices and `length`, and every other object are not. Object keys
 * are reordered: array-index names (`"0"`…`"4294967294"`, canonical decimal)
 * ascending by value, then every other key in UTF-16 code-unit order. A
 * container at depth over 100 (the document is depth 1) is refused before it
 * is entered, so the recursion is bounded.
 */
const canonValue = (value: unknown, depth: number): unknown => {
  switch (typeof value) {
    case "string":
    case "boolean": {
      return value;
    }
    case "number": {
      if (!Number.isFinite(value)) {
        throw new DomainError("non-finite number");
      }
      return value;
    }
    case "object": {
      if (value === null) {
        throw new DomainError("null value");
      }
      if (depth > MAX_DOCUMENT_DEPTH) {
        throw new DomainError(`nests deeper than ${MAX_DOCUMENT_DEPTH} levels`);
      }
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          throw new DomainError("exotic array");
        }
        const extra = Reflect.ownKeys(value).find(
          (key) =>
            key !== "length" &&
            !(typeof key === "string" && ARRAY_INDEX.test(key) && Number(key) < value.length),
        );
        if (extra !== undefined) {
          throw new DomainError(`extra own array property ${String(extra)}`);
        }
        const out: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (descriptor === undefined) {
            throw new DomainError("array hole");
          }
          if (!("value" in descriptor)) {
            throw new DomainError("accessor element");
          }
          out.push(canonValue(descriptor.value, depth + 1));
        }
        return out;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new DomainError("not a plain object");
      }
      const names: string[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") {
          throw new DomainError("symbol key");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable) {
          throw new DomainError(`non-enumerable key ${JSON.stringify(key)}`);
        }
        if (!("value" in descriptor)) {
          throw new DomainError(`accessor key ${JSON.stringify(key)}`);
        }
        names.push(key);
      }
      const indices = names.filter(isArrayIndexName).toSorted((a, b) => Number(a) - Number(b));
      const others = names.filter((name) => !isArrayIndexName(name)).toSorted();
      const out: Record<string, unknown> = {};
      for (const key of [...indices, ...others]) {
        const child = (value as Record<string, unknown>)[key];
        Object.defineProperty(out, key, {
          value: canonValue(child, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default: {
      throw new DomainError(`${typeof value} value`);
    }
  }
};

/**
 * The canonical JSON text of any value in the canonical domain (a document,
 * or any nested value). Outside the domain it throws a plain `Error`.
 */
export const canonicalJson = (value: unknown): string => {
  try {
    return JSON.stringify(canonValue(value, 1));
  } catch (error) {
    if (error instanceof DomainError) {
      throw new Error(`tree oracle: ${error.message}`, { cause: error });
    }
    throw error;
  }
};

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** A validated document: its canonical value, `_id` and canonical byte length. */
export interface CanonDocument {
  readonly doc: DocumentData;
  readonly id: string;
  readonly bytes: number;
}

/**
 * Validate a stored document and return its canonical form, or the reason it
 * is invalid. Valid means: a plain non-array object with an own `_id` that is
 * a valid ID, every value in the canonical domain, depth at most 100, and at
 * most {@link MAX_DOCUMENT_BYTES} canonical bytes.
 */
export const canonDocument = (value: unknown): CanonDocument | { readonly invalid: string } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { invalid: "not a plain object" };
  }
  if (!Object.hasOwn(value, "_id")) {
    return { invalid: "no own _id" };
  }
  let doc: DocumentData;
  try {
    doc = canonValue(value, 1) as DocumentData;
  } catch (error) {
    if (error instanceof DomainError) {
      return { invalid: error.message };
    }
    throw error;
  }
  const id = (doc as Record<string, unknown>)["_id"];
  const bad = idViolation(id);
  if (bad !== undefined) {
    return { invalid: `_id ${JSON.stringify(id)}: ${bad}` };
  }
  const bytes = encodeJson(doc).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) {
    return { invalid: `${bytes} bytes exceeds ${MAX_DOCUMENT_BYTES}` };
  }
  return { doc, id: id as string, bytes };
};

const mustCanon = (value: unknown): CanonDocument => {
  const got = canonDocument(value);
  if ("invalid" in got) {
    throw new Error(`tree oracle: invalid document ${JSON.stringify(value)}: ${got.invalid}`);
  }
  return got;
};

// ---------------------------------------------------------------------------
// Hashing and the chunking predicates.

/** Lowercase hex SHA-256. */
export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The chunk hash message: domain, a zero octet, the level octet, the ID's UTF-8. */
export const chunkPreimage = (level: number, id: string): Uint8Array => {
  const domain = [...CHUNK_DOMAIN].map((c) => c.charCodeAt(0));
  return Uint8Array.from([...domain, 0x00, level, ...utf8Bytes(id)]);
};

/** The full HMAC-SHA-256 of {@link chunkPreimage}, keyed by the 16 raw salt bytes. */
export const chunkMac = (salt: string, level: number, id: string): Uint8Array => {
  if (!CHUNK_SALT.test(salt)) {
    throw new Error("tree oracle: a chunk salt is 32 lowercase hex characters");
  }
  return createHmac("sha256", Buffer.from(salt, "hex")).update(chunkPreimage(level, id)).digest();
};

/**
 * `h(ℓ, id)` under the collection's salt: the first four bytes of
 * {@link chunkMac}, big-endian. Level 0 drives leaf cuts, level ℓ ≥ 1
 * branch cuts.
 */
export const chunkHash = (salt: string, level: number, id: string): number =>
  Buffer.from(chunkMac(salt, level, id)).readUInt32BE(0);

/**
 * The leaf content-cut predicate after appending an entry: `p` and `s` are
 * the leaf's document bytes before and after it, `x` its level-0 hash. A cut
 * is forced once `s ≥ Lmax`, never made while `s ≤ Lmin`, and otherwise made
 * when `x × (Lmax − a) < 2^32 × (s − a)` with `a = max(p, Lmin)`. Every
 * product stays below 2^52, so double arithmetic is exact.
 */
export const cutLeaf = (layout: OracleLayout, p: number, s: number, x: number): boolean => {
  if (s >= layout.leafMaxBytes) {
    return true;
  }
  if (s <= layout.leafMinBytes) {
    return false;
  }
  const a = Math.max(p, layout.leafMinBytes);
  return x * (layout.leafMaxBytes - a) < HASH_RANGE * (s - a);
};

/**
 * The branch cut predicate after appending the `count`-th entry since the
 * last cut, where `x` is `h(level, hi)` of that entry's last ID: forced at
 * `Fmax`, otherwise a hash cut once `Fmin` is met when `x < 2^32 / Ft`.
 * Reads only the key and the position, never `rows`, `bytes` or refs.
 */
export const cutBranch = (layout: OracleLayout, count: number, x: number): boolean =>
  count === layout.branchFanoutMax ||
  (count >= layout.branchFanoutMin && x < HASH_RANGE / layout.branchFanoutTarget);

// ---------------------------------------------------------------------------
// Canonical shape.

/** An identity-free leaf: its level and canonical documents. */
export interface ShapeLeaf {
  readonly level: number;
  readonly docs: readonly DocumentData[];
}

/** An identity-free branch child entry. */
export interface ShapeChild {
  readonly lo: string;
  readonly hi: string;
  readonly rows: number;
  readonly bytes: number;
  readonly node: ShapeNode;
}

/** An identity-free branch. */
export interface ShapeBranch {
  readonly level: number;
  readonly children: readonly ShapeChild[];
}

/**
 * The identity-free shape of a tree: `{"level":0,"docs":[…]}` for a leaf and
 * `{"level":ℓ,"children":[{"lo","hi","rows","bytes","node"}…]}` for a
 * branch, with no attempt, hash, collection or root fields. Two trees are the
 * same canonical tree exactly when their shapes encode to the same bytes.
 */
export type ShapeNode = ShapeLeaf | ShapeBranch;

const isBranch = (node: ShapeNode): node is ShapeBranch => "children" in node;

/** `sha256Hex` of the JSON encoding of a shape, or of `null`. */
export const shapeDigest = (shape: ShapeNode | null): string => sha256(encodeJson(shape));

const firstId = (node: ShapeNode): string =>
  isBranch(node) ? node.children[0]!.lo : (node.docs[0]!["_id"] as string);
const lastId = (node: ShapeNode): string =>
  isBranch(node) ? node.children.at(-1)!.hi : (node.docs.at(-1)!["_id"] as string);
const rowsOf = (node: ShapeNode): number =>
  isBranch(node) ? node.children.reduce((n, c) => n + c.rows, 0) : node.docs.length;
const bytesOf = (node: ShapeNode): number =>
  isBranch(node)
    ? node.children.reduce((n, c) => n + c.bytes, 0)
    : node.docs.reduce((n, d) => n + encodeJson(d).byteLength, 0);

/** A leaf over `docs` as given: canonicalized, not sorted. Mutant builder. */
export const shapeLeaf = (docs: readonly DocumentData[]): ShapeLeaf => ({
  level: 0,
  docs: docs.map((d) => mustCanon(d).doc),
});

/** A branch over `nodes` as given, with entries derived from each child. Mutant builder. */
export const shapeBranch = (level: number, nodes: readonly ShapeNode[]): ShapeBranch => ({
  level,
  children: nodes.map((node) => ({
    lo: firstId(node),
    hi: lastId(node),
    rows: rowsOf(node),
    bytes: bytesOf(node),
    node,
  })),
});

/** The leaf-mode chunking of sorted, canonical documents under `salt`, with large-document isolation. */
export const leafChunks = (
  docs: readonly CanonDocument[],
  layout: OracleLayout,
  salt: string,
): CanonDocument[][] => {
  const out: CanonDocument[][] = [];
  let current: CanonDocument[] = [];
  let s = 0;
  for (const d of docs) {
    if (d.bytes >= layout.leafIsolationDocumentBytes) {
      if (current.length > 0) {
        out.push(current);
        current = [];
        s = 0;
      }
      out.push([d]);
      continue;
    }
    const p = s;
    s += d.bytes;
    current.push(d);
    if (cutLeaf(layout, p, s, chunkHash(salt, 0, d.id))) {
      out.push(current);
      current = [];
      s = 0;
    }
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
};

/** Whether the depth-0 rule puts these totals in one root leaf. Inclusive on both axes. */
export const depthZeroApplies = (layout: OracleLayout, rows: number, bytes: number): boolean =>
  rows <= layout.singleLeafMaxRows && bytes <= layout.singleLeafMaxBytes;

/**
 * Stack nodes of one level into parents until one node remains: a level of at
 * most `Fmax` entries becomes a single node (the root rule), a larger one is
 * branch-chunked at its level. Used by the canonical build and by mutant
 * builders that perturb a lower level and want everything above canonical.
 */
export const assembleAbove = (
  nodes: readonly ShapeNode[],
  layout: OracleLayout,
  salt: string,
): ShapeNode => {
  if (nodes.length === 0) {
    throw new Error("tree oracle: assembleAbove needs at least one node");
  }
  let level = nodes[0]!.level;
  let current = [...nodes];
  while (current.length > 1) {
    level += 1;
    if (current.length <= layout.branchFanoutMax) {
      current = [shapeBranch(level, current)];
      break;
    }
    const groups: ShapeNode[][] = [];
    let group: ShapeNode[] = [];
    for (const node of current) {
      group.push(node);
      if (cutBranch(layout, group.length, chunkHash(salt, level, lastId(node)))) {
        groups.push(group);
        group = [];
      }
    }
    if (group.length > 0) {
      groups.push(group);
    }
    current = groups.map((g) => shapeBranch(level, g));
  }
  if (current[0]!.level > MAX_LEVEL) {
    throw new Error(`tree oracle: canonical tree exceeds level ${MAX_LEVEL}`);
  }
  return current[0]!;
};

/**
 * {@link buildCanonicalShape} with an injected ID order. Test-only mutant
 * seam: passing anything but {@link compareIds} builds a non-canonical tree.
 */
export const buildShapeWithOrder = (
  rows: Iterable<DocumentData>,
  layout: OracleLayout,
  salt: string,
  order: (a: string, b: string) => number,
): ShapeNode | null => {
  assertOracleLayout(layout);
  const docs = [...rows].map(mustCanon).toSorted((a, b) => order(a.id, b.id));
  for (let i = 1; i < docs.length; i++) {
    if (compareIds(docs[i - 1]!.id, docs[i]!.id) === 0) {
      throw new Error(`tree oracle: duplicate _id ${JSON.stringify(docs[i]!.id)}`);
    }
  }
  if (docs.length === 0) {
    return null;
  }
  const total = docs.reduce((n, d) => n + d.bytes, 0);
  const chunks = depthZeroApplies(layout, docs.length, total)
    ? [docs]
    : leafChunks(docs, layout, salt);
  return assembleAbove(
    chunks.map((chunk) => ({ level: 0, docs: chunk.map((d) => d.doc) })),
    layout,
    salt,
  );
};

/**
 * The canonical tree's shape for a row set: rows sorted by `utf8-scalar-v1`,
 * one root leaf under the depth-0 rule, otherwise leaf chunks, then branch
 * levels up to a single root. A pure function of the rows, the layout and the
 * collection's chunk salt. `null` for no rows.
 */
export const buildCanonicalShape = (
  rows: Iterable<DocumentData>,
  layout: OracleLayout,
  salt: string,
): ShapeNode | null => buildShapeWithOrder(rows, layout, salt, compareIds);

/** The nodes of a shape, level by level from the leaves up, each level left to right. */
export const shapeLevels = (root: ShapeNode | null): ShapeNode[][] => {
  if (root === null) {
    return [];
  }
  const levels: ShapeNode[][] = [];
  let current: ShapeNode[] = [root];
  while (current.length > 0) {
    levels.unshift(current);
    current = current.flatMap((n) => (isBranch(n) ? n.children.map((c) => c.node) : []));
  }
  return levels;
};

/**
 * The first difference between two shapes, or `undefined` when they are
 * equal. The scan runs from the leaf level up, each level left to right, so
 * the lowest differing level points at the cause. A leaf is compared by its
 * shape, a branch by its level and its entries' `lo`, `hi`, `rows` and
 * `bytes` (not the subtrees, which their own level compares). Reported as
 * the level, the node index within it, and each side's range and node count
 * at that level; a `null` shape has no nodes at any level.
 */
export const firstShapeDifference = (
  stored: ShapeNode | null,
  canonical: ShapeNode | null,
): { level: number; index: number; detail: string } | undefined => {
  if (shapeDigest(stored) === shapeDigest(canonical)) {
    return undefined;
  }
  const a = shapeLevels(stored);
  const b = shapeLevels(canonical);
  const summary = (node: ShapeNode): string =>
    JSON.stringify(
      isBranch(node)
        ? {
            level: node.level,
            children: node.children.map(({ lo, hi, rows, bytes }) => ({ lo, hi, rows, bytes })),
          }
        : node,
    );
  for (let level = 0; level < Math.max(a.length, b.length); level++) {
    const left = a[level] ?? [];
    const right = b[level] ?? [];
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const l = left[index];
      const r = right[index];
      if (l === undefined || r === undefined || summary(l) !== summary(r)) {
        const range = (n: ShapeNode | undefined) =>
          n === undefined ? "none" : `${firstId(n)}..${lastId(n)}`;
        return {
          level,
          index,
          detail: `stored ${range(l)} (${left.length} nodes), canonical ${range(r)} (${right.length} nodes)`,
        };
      }
    }
  }
  return { level: a.length, index: 0, detail: "depth differs" };
};

// ---------------------------------------------------------------------------
// Bucket images and materialization.

/** One stored object: its bytes and the SHA-256 recorded when it was captured. */
export interface ImageObject {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/** A bucket image: key → object. */
export type TreeImage = ReadonlyMap<string, ImageObject>;

/** An image object for `bytes`, digest computed. */
export const imageObject = (bytes: Uint8Array): ImageObject => ({ bytes, sha256: sha256(bytes) });

/** Capture every object under `prefix` (bytes and SHA-256). */
export const captureTreeImage = async (storage: Storage, prefix: string): Promise<TreeImage> => {
  const image = new Map<string, ImageObject>();
  for await (const entry of storage.list(prefix)) {
    const got = await storage.get(entry.key);
    if (got !== null) {
      image.set(entry.key, imageObject(got.body));
    }
  }
  return image;
};

/** The node key namespace for collection prefix `P`. */
export const nodeKeyPrefix = (prefix: string): string => `${prefix}/${TREE_NS}/n/`;

/** The head key for collection prefix `P`. */
export const headKey = (prefix: string): string => `${prefix}/current.json`;

const NODE_KEY_TAIL = /^([0-9a-f]{32})\/([0-9a-f]{64})$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Parse a node key. It must start with exactly `P + "/_v99/n/"`, and the rest
 * must be 32 lowercase hex characters, `/`, 64 lowercase hex characters, with
 * nothing after. No other width, case, extension or segment parses.
 */
export const parseNodeKey = (
  prefix: string,
  key: string,
): { attempt: string; sha256: string } | undefined => {
  const ns = nodeKeyPrefix(prefix);
  if (!key.startsWith(ns)) {
    return undefined;
  }
  const match = NODE_KEY_TAIL.exec(key.slice(ns.length));
  return match === null ? undefined : { attempt: match[1]!, sha256: match[2]! };
};

/** Options for {@link materializeTree}. */
export interface MaterializeOptions {
  /** Collection prefix `P` (`app/<a>/tenant/<t>/manifests/<c>`). */
  readonly prefix: string;
  /** The folded seq stored as the root's `floor` and the head's `log_seq_start`. */
  readonly floor: number;
  /** Attempt identity of every node, or one per node path (child indices from the root). */
  readonly attempt: string | ((path: readonly number[]) => string);
  /** Head GC fence epoch. Default 0. */
  readonly gcFenceEpoch?: number;
  /** Head chunk salt. Default {@link TEST_CHUNK_SALT}; it must be the salt the shape was built under. */
  readonly chunkSalt?: string;
  /** A root branch's `level_nodes` to store instead of the shape's own counts. */
  readonly levelNodes?: readonly number[];
  /** Write no head (for adding a second tree to an image). */
  readonly omitHead?: boolean;
}

/** A materialized tree: the image, the root key (or `null`), and the head key. */
export interface MaterializedTree {
  readonly image: Map<string, ImageObject>;
  readonly rootKey: string | null;
  readonly headKey: string;
}

const lastSegment = (prefix: string): string => prefix.slice(prefix.lastIndexOf("/") + 1);

/**
 * The collection name of prefix `P`: its last `/` segment, which must be a
 * valid path segment (non-empty, not `.` or `..`, no control character, at
 * most 256 UTF-8 bytes). Anything else is oracle misuse.
 */
const collectionOf = (prefix: string): string => {
  const name = lastSegment(prefix);
  const bad =
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    [...name].some((c) => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f) ||
    utf8Bytes(name).length > MAX_ID_BYTES;
  if (bad) {
    throw new Error(
      `tree oracle: prefix ${JSON.stringify(prefix)} has no valid collection segment`,
    );
  }
  return name;
};

/**
 * Encode a shape as node bodies and a head, children before parents. Field
 * order follows the node grammar: `format, schema_version, collection,
 * attempt, level`, then `floor, rows, bytes` on the root only, then
 * `level_nodes` on a root branch only (the shape's node count per level),
 * then `docs` or `children`; each child entry is `lo, hi, rows, bytes,
 * attempt, sha256`. The shape is encoded as given, so a perturbed shape
 * yields a bad image.
 */
export const materializeTree = (
  shape: ShapeNode | null,
  options: MaterializeOptions,
): MaterializedTree => {
  const image = new Map<string, ImageObject>();
  const collection = lastSegment(options.prefix);
  const attemptAt = (path: readonly number[]): string =>
    typeof options.attempt === "string" ? options.attempt : options.attempt(path);
  const put = (node: ShapeNode, path: readonly number[]): { key: string; attempt: string } => {
    const attempt = attemptAt(path);
    const root = path.length === 0;
    const body: Record<string, unknown> = {
      format: NODE_FORMAT,
      schema_version: NODE_SCHEMA_VERSION,
      collection,
      attempt,
      level: node.level,
    };
    if (root) {
      body["floor"] = options.floor;
      body["rows"] = rowsOf(node);
      body["bytes"] = bytesOf(node);
      if (isBranch(node)) {
        body["level_nodes"] =
          options.levelNodes ??
          shapeLevels(node)
            .slice(0, -1)
            .map((level) => level.length);
      }
    }
    if (isBranch(node)) {
      body["children"] = node.children.map((child, i) => {
        const ref = put(child.node, [...path, i]);
        const sha = ref.key.slice(ref.key.lastIndexOf("/") + 1);
        return {
          lo: child.lo,
          hi: child.hi,
          rows: child.rows,
          bytes: child.bytes,
          attempt: ref.attempt,
          sha256: sha,
        };
      });
    } else {
      body["docs"] = node.docs;
    }
    const bytes = encodeJson(body);
    const object = imageObject(bytes);
    const key = `${nodeKeyPrefix(options.prefix)}${attempt}/${object.sha256}`;
    image.set(key, object);
    return { key, attempt };
  };
  const rootKey = shape === null ? null : put(shape, []).key;
  const head = headKey(options.prefix);
  if (options.omitHead !== true) {
    image.set(
      head,
      imageObject(
        encodeJson(
          treeHead({
            root: rootKey,
            floor: options.floor,
            rows: shape === null ? 0 : rowsOf(shape),
            bytes: shape === null ? 0 : bytesOf(shape),
            gcFenceEpoch: options.gcFenceEpoch ?? 0,
            chunkSalt: options.chunkSalt ?? TEST_CHUNK_SALT,
          }),
        ),
      ),
    );
  }
  return { image, rootKey, headKey: head };
};

/** A schema-3 tree head: `snapshot: null` plus `proto_tree`. */
export const treeHead = (fields: {
  root: string | null;
  floor: number;
  rows: number;
  bytes: number;
  gcFenceEpoch: number;
  chunkSalt: string;
}): Record<string, unknown> => ({
  schema_version: HEAD_SCHEMA_VERSION,
  snapshot: null,
  tail_hint: fields.floor,
  log_seq_start: fields.floor,
  writer_fence: { epoch: 0, owner: "tree-oracle", claimed_at: "1970-01-01T00:00:00.000Z" },
  snapshot_bytes: fields.bytes,
  snapshot_rows: fields.rows,
  proto_tree: {
    root: fields.root,
    gc_fence_epoch: fields.gcFenceEpoch,
    chunk_salt: fields.chunkSalt,
  },
});

// ---------------------------------------------------------------------------
// The checker.

/** Every kind of violation the oracle reports. */
export const TREE_VIOLATION_KINDS = [
  /** The image's recorded SHA-256 does not match the object's bytes. */
  "image-digest",
  /** No head, or a head that is not a valid tree head. */
  "head-malformed",
  /** The head disagrees with its root's `floor`, `rows` or `bytes`, or a null root has totals. */
  "head-mismatch",
  /** The root's floor is not the expected fold end. */
  "floor-mismatch",
  /** A root or child reference that does not parse under the node key grammar. */
  "key-grammar",
  /** A referenced node is absent. */
  "missing-node",
  /** A node is referenced from two places. */
  "shared-node",
  /** A body's SHA-256 is not the `sha256` in its key. */
  "hash-mismatch",
  /** A body over its byte ceiling. */
  "body-ceiling",
  /** A body that is not strict UTF-8. */
  "body-utf8",
  /** A body that is not JSON. */
  "body-json",
  /** A body whose fields, types or ranges do not fit the node grammar. */
  "body-structure",
  /** A body that differs from its canonical re-encoding. */
  "body-non-canonical",
  /** A stored document outside the document domain. */
  "document-invalid",
  /** IDs or entries not strictly increasing in `utf8-scalar-v1`, or overlapping. */
  "entry-order",
  /** A node's `level` is not one below its parent's. */
  "level",
  /** A parent entry's `lo`, `hi`, `rows` or `bytes` differs from its child's. */
  "entry-mismatch",
  /** A root's `rows` or `bytes` differs from its sums. */
  "root-totals",
  /** A cut where the chunking rule makes none. */
  "unexpected-cut",
  /** No cut where the hash rule makes one. */
  "missing-hash-cut",
  /** No cut where a leaf reaches `Lmax` or a branch reaches `Fmax` entries. */
  "missing-forced-cut",
  /** A document of at least the isolation size shares its leaf. */
  "missing-isolation-cut",
  /** The depth-0 rule is broken in either direction. */
  "depth-0-rule",
  /** A level that fits one node is split, or a non-root level holds one node. */
  "root-rule",
  /** The stored shape is not the canonical shape for the row set. */
  "non-canonical-root",
  /** A root branch's `level_nodes[ℓ]` differs from the level-ℓ nodes reachable from it. */
  "level-nodes-mismatch",
  /** A stored `level_nodes[ℓ]` at most `Fmax` below the root's children, which the root rule forbids. */
  "level-nodes-root-rule",
] as const;

export type TreeViolationKind = (typeof TREE_VIOLATION_KINDS)[number];

/**
 * The strict-decode steps, in the order they run. A node-body violation
 * names the step that failed in `check`, and its message carries the
 * format's `<check> check failed` tag.
 */
export const DECODE_CHECKS = [
  "key",
  "present",
  "leaf-ceiling",
  "hash",
  "utf-8",
  "json",
  "structure",
  "canonical-bytes",
  "context",
] as const;

export type DecodeCheck = (typeof DECODE_CHECKS)[number];

/** One finding. `key` names the node (or head) at fault when there is one. */
export interface TreeViolation {
  readonly kind: TreeViolationKind;
  /** The strict-decode step that failed, for a violation found decoding a node body. */
  readonly check?: DecodeCheck;
  readonly key?: string;
  readonly level?: number;
  readonly index?: number;
  readonly message: string;
}

/** Input to {@link checkTreeImage}. */
export interface TreeCheckInput {
  readonly image: TreeImage;
  /** Collection prefix `P`; the head is `<P>/current.json`. */
  readonly prefix: string;
  /** Default {@link PRODUCTION_LAYOUT}. */
  readonly layout?: OracleLayout;
  /** When given, the root must be the canonical root of exactly these rows. */
  readonly expectedRows?: Iterable<DocumentData>;
  /** When given, the root's `floor` (and the head's `log_seq_start`) must equal it. */
  readonly expectedFloor?: number;
}

/** What {@link checkTreeImage} found. */
export interface TreeCheckReport {
  readonly violations: readonly TreeViolation[];
  readonly rootKey: string | null;
  /** Root level, or `null` with no root. */
  readonly depth: number | null;
  /** Node count per level, leaves first, as walked. */
  readonly nodesPerLevel: readonly number[];
  /** Rows as stored, in walk order. Complete only when no node failed to decode. */
  readonly rows: readonly DocumentData[];
  /** The stored tree's shape, or `null` when there is no root or the walk was incomplete. */
  readonly shape: ShapeNode | null;
  /** Every node key the walk reached, sorted. */
  readonly reachableKeys: readonly string[];
  /** Parseable node keys in the image that the walk did not reach, sorted. */
  readonly unreachableNodeKeys: readonly string[];
  /** Keys under the node namespace that do not parse, sorted. */
  readonly foreignNodeKeys: readonly string[];
}

interface DecodedEntry {
  readonly lo: string;
  readonly hi: string;
  readonly rows: number;
  readonly bytes: number;
  readonly attempt: string;
  readonly sha256: string;
}

interface DecodedNode {
  readonly key: string;
  readonly level: number;
  readonly docs?: readonly CanonDocument[];
  readonly entries?: readonly DecodedEntry[];
  readonly floor?: number;
  /** A root branch's stored node count per level, leaves first. */
  readonly levelNodes?: readonly number[];
  readonly rows: number;
  readonly bytes: number;
  readonly lo: string;
  readonly hi: string;
}

const FIELDS = {
  leaf: ["format", "schema_version", "collection", "attempt", "level", "docs"],
  rootLeaf: [
    "format",
    "schema_version",
    "collection",
    "attempt",
    "level",
    "floor",
    "rows",
    "bytes",
    "docs",
  ],
  branch: ["format", "schema_version", "collection", "attempt", "level", "children"],
  rootBranch: [
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
  ],
  entry: ["lo", "hi", "rows", "bytes", "attempt", "sha256"],
} as const;

const sameFields = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((k, i) => k === expected[i]);

const isNonNegativeSafe = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Expectations a node is decoded against, from its parent or the head. */
export interface NodeExpectation {
  /** `true` when routed from the head, `false` when routed from a parent. */
  readonly root: boolean;
  readonly level?: number;
  readonly entry?: { lo: string; hi: string; rows: number; bytes: number };
  readonly floor?: number;
}

/**
 * Strictly decode one node body in a fixed order: key grammar, presence,
 * the body ceiling, the key's hash, strict UTF-8 (a BOM is kept, so the JSON
 * step rejects it), JSON, structure (field list for the routed kind, types,
 * ranges, documents, order, sums, branch ceiling), canonical bytes, then the
 * routing context (level, parent entry, floor). Stops at the first failing
 * step, except that routing-context failures are all reported, and returns the
 * decoded node only when the body itself is sound. The body's `collection`
 * must be the last segment of `prefix`; a prefix without a valid collection
 * segment is oracle misuse and throws a plain `Error`.
 */
export const decodeNodeBody = (
  prefix: string,
  key: string,
  bytes: Uint8Array | undefined,
  expected: NodeExpectation,
): { node?: DecodedNode; violations: TreeViolation[] } => {
  const collection = collectionOf(prefix);
  const violations: TreeViolation[] = [];
  const tagged = (check: DecodeCheck, message: string) =>
    `${key}: ${check} check failed: ${message}`;
  const fail = (kind: TreeViolationKind, check: DecodeCheck, message: string) => {
    violations.push({ kind, check, key, message: tagged(check, message) });
    return { violations };
  };
  const parsedKey = parseNodeKey(prefix, key);
  if (parsedKey === undefined) {
    return fail("key-grammar", "key", "not a node key for this collection");
  }
  if (bytes === undefined) {
    return fail("missing-node", "present", "referenced node is absent");
  }
  if (bytes.byteLength > LEAF_MAX_BODY_BYTES) {
    return fail(
      "body-ceiling",
      "leaf-ceiling",
      `${bytes.byteLength} bytes exceeds ${LEAF_MAX_BODY_BYTES}`,
    );
  }
  const actualSha = sha256(bytes);
  if (actualSha !== parsedKey.sha256) {
    return fail("hash-mismatch", "hash", `body hashes to ${actualSha}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("body-utf8", "utf-8", "not strict UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("body-json", "json", "not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("body-structure", "structure", "not an object");
  }
  const body = value as Record<string, unknown>;
  const names = Object.keys(body);
  const lists = expected.root ? [FIELDS.rootLeaf, FIELDS.rootBranch] : [FIELDS.leaf, FIELDS.branch];
  const list = lists.find((l) => sameFields(names, l));
  if (list === undefined) {
    return fail(
      "body-structure",
      "structure",
      `field list ${JSON.stringify(names)} fits no node kind`,
    );
  }
  const leaf = list.at(-1) === "docs";
  if (!leaf && bytes.byteLength > BRANCH_MAX_BODY_BYTES) {
    return fail(
      "body-ceiling",
      "structure",
      `branch of ${bytes.byteLength} bytes exceeds ${BRANCH_MAX_BODY_BYTES}`,
    );
  }
  if (body["format"] !== NODE_FORMAT) {
    return fail("body-structure", "structure", `format ${JSON.stringify(body["format"])}`);
  }
  if (body["schema_version"] !== NODE_SCHEMA_VERSION) {
    return fail(
      "body-structure",
      "structure",
      `schema_version ${JSON.stringify(body["schema_version"])}`,
    );
  }
  if (body["collection"] !== collection) {
    return fail("body-structure", "structure", `collection ${JSON.stringify(body["collection"])}`);
  }
  if (typeof body["attempt"] !== "string" || !ATTEMPT.test(body["attempt"])) {
    return fail("body-structure", "structure", "attempt is not 32 lowercase hex characters");
  }
  if (body["attempt"] !== parsedKey.attempt) {
    return fail("body-structure", "structure", "attempt differs from the key's");
  }
  const level = body["level"];
  if (!isNonNegativeSafe(level) || level > MAX_LEVEL) {
    return fail("body-structure", "structure", `level ${JSON.stringify(level)} out of range`);
  }
  if (leaf ? level !== 0 : level < 1) {
    return fail("body-structure", "structure", `level ${level} for a ${leaf ? "leaf" : "branch"}`);
  }
  if (expected.root) {
    for (const field of ["floor", "rows", "bytes"]) {
      if (!isNonNegativeSafe(body[field])) {
        return fail("body-structure", "structure", `${field} is not a non-negative safe integer`);
      }
    }
  }

  let rows = 0;
  let total = 0;
  let lo: string;
  let hi: string;
  let docs: CanonDocument[] | undefined;
  let entries: DecodedEntry[] | undefined;
  let rebuiltTail: unknown;
  if (leaf) {
    const raw = body["docs"];
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail("body-structure", "structure", "docs is not a non-empty array");
    }
    docs = [];
    for (const [i, item] of raw.entries()) {
      const got = canonDocument(item);
      if ("invalid" in got) {
        return fail("document-invalid", "structure", `docs[${i}]: ${got.invalid}`);
      }
      if (docs.length > 0 && compareIds(docs.at(-1)!.id, got.id) >= 0) {
        return fail(
          "entry-order",
          "structure",
          `docs[${i}] _id ${JSON.stringify(got.id)} does not increase`,
        );
      }
      docs.push(got);
      total += got.bytes;
      if (!Number.isSafeInteger(total)) {
        return fail("body-structure", "structure", "document byte sum overflows");
      }
    }
    rows = docs.length;
    lo = docs[0]!.id;
    hi = docs.at(-1)!.id;
    rebuiltTail = docs.map((d) => d.doc);
  } else {
    const raw = body["children"];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BRANCH_ENTRIES) {
      return fail(
        "body-structure",
        "structure",
        `children is not an array of 1..${MAX_BRANCH_ENTRIES}`,
      );
    }
    entries = [];
    for (const [i, item] of raw.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return fail("body-structure", "structure", `children[${i}] is not an object`);
      }
      const e = item as Record<string, unknown>;
      if (!sameFields(Object.keys(e), FIELDS.entry)) {
        return fail(
          "body-structure",
          "structure",
          `children[${i}] fields ${JSON.stringify(Object.keys(e))}`,
        );
      }
      const loBad = idViolation(e["lo"]);
      const hiBad = idViolation(e["hi"]);
      if (loBad !== undefined || hiBad !== undefined) {
        return fail("body-structure", "structure", `children[${i}] lo/hi: ${loBad ?? hiBad}`);
      }
      const eRows = e["rows"];
      const eBytes = e["bytes"];
      if (!isNonNegativeSafe(eRows) || eRows < 1) {
        return fail("body-structure", "structure", `children[${i}] rows ${JSON.stringify(eRows)}`);
      }
      if (!isNonNegativeSafe(eBytes) || eBytes < MIN_DOCUMENT_BYTES * eRows) {
        return fail(
          "body-structure",
          "structure",
          `children[${i}] bytes ${JSON.stringify(eBytes)}`,
        );
      }
      if (typeof e["attempt"] !== "string" || !ATTEMPT.test(e["attempt"])) {
        return fail("body-structure", "structure", `children[${i}] attempt`);
      }
      if (typeof e["sha256"] !== "string" || !SHA256.test(e["sha256"])) {
        return fail("body-structure", "structure", `children[${i}] sha256`);
      }
      const entry: DecodedEntry = {
        lo: e["lo"] as string,
        hi: e["hi"] as string,
        rows: eRows,
        bytes: eBytes,
        attempt: e["attempt"],
        sha256: e["sha256"],
      };
      if (compareIds(entry.lo, entry.hi) > 0) {
        return fail("entry-order", "structure", `children[${i}] lo > hi`);
      }
      if (entries.length > 0 && compareIds(entries.at(-1)!.hi, entry.lo) >= 0) {
        return fail(
          "entry-order",
          "structure",
          `children[${i}] overlaps or precedes children[${i - 1}]`,
        );
      }
      entries.push(entry);
      rows += eRows;
      total += eBytes;
      if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(total)) {
        return fail("body-structure", "structure", "entry sums overflow");
      }
    }
    lo = entries[0]!.lo;
    hi = entries.at(-1)!.hi;
    rebuiltTail = entries.map(({ lo: l, hi: h, rows: r, bytes: b, attempt, sha256: s }) => ({
      lo: l,
      hi: h,
      rows: r,
      bytes: b,
      attempt,
      sha256: s,
    }));
  }
  if (expected.root && (body["rows"] !== rows || body["bytes"] !== total)) {
    return fail(
      "root-totals",
      "structure",
      `root rows/bytes ${String(body["rows"])}/${String(body["bytes"])}, sums ${rows}/${total}`,
    );
  }
  let levelNodes: number[] | undefined;
  if (list === FIELDS.rootBranch) {
    const raw = body["level_nodes"];
    if (!Array.isArray(raw) || raw.length !== level) {
      return fail("body-structure", "structure", `level_nodes is not an array of ${level} counts`);
    }
    if (!raw.every((n) => isNonNegativeSafe(n) && n >= 1)) {
      return fail(
        "body-structure",
        "structure",
        "level_nodes holds a count that is not a positive safe integer",
      );
    }
    levelNodes = raw as number[];
    if (levelNodes[level - 1] !== entries!.length) {
      return fail(
        "body-structure",
        "structure",
        `level_nodes[${level - 1}] is ${levelNodes[level - 1]}, but the root has ${entries!.length} children`,
      );
    }
    for (let l = 0; l < level - 1; l++) {
      const here = levelNodes[l]!;
      const above = levelNodes[l + 1]!;
      if (here < above) {
        return fail(
          "body-structure",
          "structure",
          `level_nodes[${l}] is below level_nodes[${l + 1}]`,
        );
      }
      if (here > MAX_BRANCH_ENTRIES * above) {
        return fail(
          "body-structure",
          "structure",
          `level_nodes[${l}] exceeds ${MAX_BRANCH_ENTRIES} × level_nodes[${l + 1}]`,
        );
      }
    }
    if (levelNodes[0]! > rows) {
      return fail("body-structure", "structure", `level_nodes[0] exceeds the root's ${rows} rows`);
    }
  }

  const rebuilt: Record<string, unknown> = {};
  for (const field of list) {
    rebuilt[field] = field === "docs" || field === "children" ? rebuiltTail : body[field];
  }
  const canonical = encodeJson(rebuilt);
  if (canonical.byteLength !== bytes.byteLength || canonical.some((b, i) => b !== bytes[i])) {
    return fail(
      "body-non-canonical",
      "canonical-bytes",
      "bytes differ from the canonical re-encoding",
    );
  }

  if (expected.level !== undefined && level !== expected.level) {
    violations.push({
      kind: "level",
      check: "context",
      key,
      level,
      message: `${key}: context check failed: level ${level}, parent expects ${expected.level}`,
    });
  }
  if (expected.entry !== undefined) {
    const derived = { lo, hi, rows, bytes: total };
    for (const field of ["lo", "hi", "rows", "bytes"] as const) {
      if (expected.entry[field] !== derived[field]) {
        violations.push({
          kind: "entry-mismatch",
          check: "context",
          key,
          message: `${key}: context check failed: parent entry ${field} ${JSON.stringify(expected.entry[field])}, body yields ${JSON.stringify(derived[field])}`,
        });
      }
    }
  }
  if (expected.floor !== undefined && body["floor"] !== expected.floor) {
    violations.push({
      kind: "head-mismatch",
      check: "context",
      key,
      message: `${key}: context check failed: root floor ${String(body["floor"])}, head log_seq_start ${expected.floor}`,
    });
  }
  const node: DecodedNode = {
    key,
    level,
    rows,
    bytes: total,
    lo,
    hi,
    ...(docs !== undefined ? { docs } : {}),
    ...(entries !== undefined ? { entries } : {}),
    ...(expected.root ? { floor: body["floor"] as number } : {}),
    ...(levelNodes !== undefined ? { levelNodes } : {}),
  };
  return { node, violations };
};

interface HeadView {
  readonly root: string | null;
  /** The collection's chunk salt; absent only on a fresh head without `proto_tree`. */
  readonly salt?: string;
  readonly floor: number;
  readonly rows: number;
  readonly bytes: number;
}

const readHead = (image: TreeImage, prefix: string, out: TreeViolation[]): HeadView | undefined => {
  const key = headKey(prefix);
  const bad = (message: string) => {
    out.push({ kind: "head-malformed", key, message: `${key}: ${message}` });
    return undefined;
  };
  const object = image.get(key);
  if (object === undefined) {
    return bad("no head");
  }
  let head: unknown;
  try {
    head = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes));
  } catch {
    return bad("not UTF-8 JSON");
  }
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    return bad("not an object");
  }
  const h = head as Record<string, unknown>;
  if (h["schema_version"] !== HEAD_SCHEMA_VERSION) {
    return bad(`schema_version ${JSON.stringify(h["schema_version"])}`);
  }
  if (h["snapshot"] !== null) {
    return bad("snapshot is not null");
  }
  const floor = h["log_seq_start"];
  const rows = h["snapshot_rows"];
  const bytes = h["snapshot_bytes"];
  if (!isNonNegativeSafe(floor) || !isNonNegativeSafe(rows) || !isNonNegativeSafe(bytes)) {
    return bad("log_seq_start, snapshot_rows or snapshot_bytes is not a non-negative safe integer");
  }
  const tree = h["proto_tree"];
  if (tree === undefined) {
    if (floor !== 0 || rows !== 0 || bytes !== 0) {
      return bad("no proto_tree on a non-fresh head");
    }
    return { root: null, floor, rows, bytes };
  }
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) {
    return bad("proto_tree is not an object");
  }
  const t = tree as Record<string, unknown>;
  const names = Object.keys(t).toSorted();
  if (
    names.length !== 3 ||
    names[0] !== "chunk_salt" ||
    names[1] !== "gc_fence_epoch" ||
    names[2] !== "root"
  ) {
    return bad(`proto_tree keys ${JSON.stringify(Object.keys(t))}`);
  }
  // Name the field, never the value: the salt is secret.
  const salt = t["chunk_salt"];
  if (typeof salt !== "string" || !CHUNK_SALT.test(salt)) {
    return bad("proto_tree.chunk_salt is not 32 lowercase hex characters");
  }
  if (!isNonNegativeSafe(t["gc_fence_epoch"])) {
    return bad("gc_fence_epoch is not a non-negative safe integer");
  }
  const root = t["root"];
  if (root !== null && typeof root !== "string") {
    return bad("proto_tree.root is neither null nor a string");
  }
  if (root === null && (rows !== 0 || bytes !== 0)) {
    out.push({ kind: "head-mismatch", key, message: `${key}: null root with nonzero totals` });
  }
  return { root, salt, floor, rows, bytes };
};

/**
 * Check an image's tree for the head at `<P>/current.json`. Collects every
 * violation it can find rather than stopping at the first; a node that fails
 * to decode is not descended into, and then the boundary, whole-level and
 * canonical-root checks are skipped because the row set is incomplete.
 */
export const checkTreeImage = (input: TreeCheckInput): TreeCheckReport => {
  const layout = input.layout ?? PRODUCTION_LAYOUT;
  assertOracleLayout(layout);
  const { image, prefix } = input;
  collectionOf(prefix);
  const violations: TreeViolation[] = [];

  for (const [key, object] of image) {
    if (sha256(object.bytes) !== object.sha256) {
      violations.push({ kind: "image-digest", key, message: `${key}: recorded digest is stale` });
    }
  }
  const ns = nodeKeyPrefix(prefix);
  const nodeKeys = [...image.keys()].filter((k) => k.startsWith(ns));
  const foreignNodeKeys = nodeKeys.filter((k) => parseNodeKey(prefix, k) === undefined).toSorted();

  const head = readHead(image, prefix, violations);
  const empty = (): TreeCheckReport => ({
    violations,
    rootKey: head?.root ?? null,
    depth: null,
    nodesPerLevel: [],
    rows: [],
    shape: null,
    reachableKeys: [],
    unreachableNodeKeys: nodeKeys.filter((k) => parseNodeKey(prefix, k) !== undefined).toSorted(),
    foreignNodeKeys,
  });
  if (head === undefined) {
    return empty();
  }
  if (input.expectedFloor !== undefined && head.floor !== input.expectedFloor) {
    violations.push({
      kind: "floor-mismatch",
      key: headKey(prefix),
      message: `head log_seq_start ${head.floor}, expected fold end ${input.expectedFloor}`,
    });
  }
  const expectedRows = input.expectedRows === undefined ? undefined : [...input.expectedRows];
  if (head.root === null) {
    if (expectedRows !== undefined && expectedRows.length > 0) {
      // A fresh head has no salt yet, so there is no canonical shape to list.
      const detail =
        head.salt === undefined
          ? `stored none (0 nodes), canonical ${expectedRows.length} rows`
          : firstShapeDifference(null, buildCanonicalShape(expectedRows, layout, head.salt))!
              .detail;
      violations.push({
        kind: "non-canonical-root",
        key: headKey(prefix),
        level: 0,
        index: 0,
        message: `first difference at level 0, node 0 (${headKey(prefix)}): ${detail}`,
      });
    }
    return empty();
  }
  // A head with a root always has a validated salt.
  const salt = head.salt!;
  const expectedShape =
    expectedRows === undefined ? undefined : buildCanonicalShape(expectedRows, layout, salt);

  // Walk top-down, level by level, left to right.
  const reached = new Set<string>();
  const byLevel = new Map<number, DecodedNode[]>();
  const shapes = new Map<string, ShapeNode>();
  let complete = true;
  let rootNode: DecodedNode | undefined;
  type Pending = { key: string; expected: NodeExpectation };
  let frontier: Pending[] = [{ key: head.root, expected: { root: true, floor: head.floor } }];
  const decodedByKey = new Map<string, DecodedNode>();
  while (frontier.length > 0) {
    const next: Pending[] = [];
    for (const { key, expected } of frontier) {
      if (reached.has(key)) {
        violations.push({ kind: "shared-node", key, message: `${key}: referenced twice` });
        complete = false;
        continue;
      }
      reached.add(key);
      const got = decodeNodeBody(prefix, key, image.get(key)?.bytes, expected);
      violations.push(...got.violations);
      if (got.node === undefined) {
        complete = false;
        continue;
      }
      const node = got.node;
      decodedByKey.set(key, node);
      if (expected.root) {
        rootNode = node;
      }
      const list = byLevel.get(node.level) ?? [];
      list.push(node);
      byLevel.set(node.level, list);
      // A node at the wrong level (a leaf where a branch belongs, or the
      // reverse) makes every level-based check below meaningless.
      if (got.violations.some((v) => v.kind === "level")) {
        complete = false;
        continue;
      }
      if (node.level === 0 || node.entries === undefined) {
        continue;
      }
      for (const entry of node.entries) {
        next.push({
          key: `${ns}${entry.attempt}/${entry.sha256}`,
          expected: {
            root: false,
            level: node.level - 1,
            entry: { lo: entry.lo, hi: entry.hi, rows: entry.rows, bytes: entry.bytes },
          },
        });
      }
    }
    frontier = next;
  }

  const reachableKeys = [...reached].toSorted();
  const unreachableNodeKeys = nodeKeys
    .filter((k) => parseNodeKey(prefix, k) !== undefined && !reached.has(k))
    .toSorted();
  if (rootNode !== undefined && (rootNode.rows !== head.rows || rootNode.bytes !== head.bytes)) {
    violations.push({
      kind: "head-mismatch",
      key: headKey(prefix),
      message: `head totals ${head.rows}/${head.bytes}, root ${rootNode.rows}/${rootNode.bytes}`,
    });
  }
  const depth = rootNode?.level ?? null;
  const nodesPerLevel =
    depth === null ? [] : Array.from({ length: depth + 1 }, (_, l) => byLevel.get(l)?.length ?? 0);
  const leaves = byLevel.get(0) ?? [];
  const rows = leaves.flatMap((leaf) => leaf.docs!.map((d) => d.doc));

  const incomplete = (): TreeCheckReport => ({
    violations,
    rootKey: head.root,
    depth,
    nodesPerLevel,
    rows,
    shape: null,
    reachableKeys,
    unreachableNodeKeys,
    foreignNodeKeys,
  });
  if (!complete || rootNode === undefined) {
    return incomplete();
  }

  // A root branch's level_nodes against what is reachable, and the root rule
  // on the stored counts: a level below the root's children with at most
  // Fmax nodes would itself have been the root's level.
  if (rootNode.levelNodes !== undefined) {
    for (const [level, count] of rootNode.levelNodes.entries()) {
      const reachable = byLevel.get(level)?.length ?? 0;
      if (count !== reachable) {
        violations.push({
          kind: "level-nodes-mismatch",
          key: rootNode.key,
          level,
          message: `${rootNode.key}: level_nodes[${level}] is ${count}, ${reachable} nodes are reachable`,
        });
      }
      if (level < rootNode.level - 1 && count <= layout.branchFanoutMax) {
        violations.push({
          kind: "level-nodes-root-rule",
          key: rootNode.key,
          level,
          message: `${rootNode.key}: level_nodes[${level}] is ${count}, at most Fmax ${layout.branchFanoutMax}, below the root's children`,
        });
      }
    }
  }

  // Cross-node order over the whole leaf sequence. Out of order (or a
  // duplicate ID across leaves), the rows are not a row set, so the
  // boundary, whole-level and canonical-root checks are skipped.
  const allDocs = leaves.flatMap((leaf) => leaf.docs!.map((d) => ({ d, key: leaf.key })));
  for (let i = 1; i < allDocs.length; i++) {
    if (compareIds(allDocs[i - 1]!.d.id, allDocs[i]!.d.id) >= 0) {
      violations.push({
        kind: "entry-order",
        key: allDocs[i]!.key,
        message: `${allDocs[i]!.key}: _id ${JSON.stringify(allDocs[i]!.d.id)} does not follow ${JSON.stringify(allDocs[i - 1]!.d.id)} across leaves`,
      });
      return incomplete();
    }
  }

  // Whole-level rules and boundaries.
  const totalBytes = rootNode.bytes;
  const zero = depthZeroApplies(layout, rootNode.rows, totalBytes);
  if (zero && leaves.length > 1) {
    violations.push({
      kind: "depth-0-rule",
      key: rootNode.key,
      message: `${rootNode.rows} rows / ${totalBytes} bytes fit one root leaf, stored as ${leaves.length} leaves`,
    });
  }
  if (!zero) {
    if (leaves.length === 1 && leafChunks(leaves[0]!.docs!, layout, salt).length > 1) {
      violations.push({
        kind: "depth-0-rule",
        key: rootNode.key,
        message: `${rootNode.rows} rows / ${totalBytes} bytes exceed the single-leaf limits, stored as one root leaf`,
      });
    }
    checkLeafBoundaries(leaves, layout, salt, violations);
  }
  for (let level = 1; level <= rootNode.level; level++) {
    const below = byLevel.get(level - 1) ?? [];
    const nodes = byLevel.get(level) ?? [];
    if (below.length <= 1) {
      violations.push({
        kind: "root-rule",
        key: below[0]?.key,
        level: level - 1,
        message: `level ${level - 1} holds one node but is not the root`,
      });
    }
    if (below.length <= layout.branchFanoutMax) {
      if (nodes.length > 1) {
        violations.push({
          kind: "root-rule",
          key: nodes[1]!.key,
          level,
          message: `level ${level} has ${below.length} entries, which fit one node, in ${nodes.length} nodes`,
        });
      }
      continue;
    }
    checkBranchBoundaries(level, nodes, layout, salt, violations);
  }

  // Canonical shape.
  const shapeOf = (node: DecodedNode): ShapeNode => {
    const cached = shapes.get(node.key);
    if (cached !== undefined) {
      return cached;
    }
    const shape: ShapeNode =
      node.docs !== undefined
        ? { level: node.level, docs: node.docs.map((d) => d.doc) }
        : {
            level: node.level,
            children: node.entries!.map((e) => ({
              lo: e.lo,
              hi: e.hi,
              rows: e.rows,
              bytes: e.bytes,
              node: shapeOf(decodedByKey.get(`${ns}${e.attempt}/${e.sha256}`)!),
            })),
          };
    shapes.set(node.key, shape);
    return shape;
  };
  const shape = shapeOf(rootNode);
  const canonical =
    expectedShape !== undefined ? expectedShape : buildCanonicalShape(rows, layout, salt);
  const diff = firstShapeDifference(shape, canonical);
  if (diff !== undefined) {
    const atLevel = byLevel.get(diff.level);
    const key = atLevel?.[diff.index]?.key ?? rootNode.key;
    violations.push({
      kind: "non-canonical-root",
      key,
      level: diff.level,
      index: diff.index,
      message: `first difference at level ${diff.level}, node ${diff.index} (${key}): ${diff.detail}`,
    });
  }
  return {
    violations,
    rootKey: head.root,
    depth,
    nodesPerLevel,
    rows,
    shape,
    reachableKeys,
    unreachableNodeKeys,
    foreignNodeKeys,
  };
};

/**
 * Check every leaf cut locally. The chunker's state resets at each cut, so a
 * leaf is canonical when replaying the rule from its first document cuts
 * nowhere inside it and cuts at its last document, unless it is the last
 * leaf or the next leaf starts with an isolated document. A document of at
 * least the isolation size must be alone in its leaf.
 */
const checkLeafBoundaries = (
  leaves: readonly DecodedNode[],
  layout: OracleLayout,
  salt: string,
  out: TreeViolation[],
): void => {
  for (const [index, leaf] of leaves.entries()) {
    const docs = leaf.docs!;
    const isolated = docs.findIndex((d) => d.bytes >= layout.leafIsolationDocumentBytes);
    if (isolated !== -1) {
      if (docs.length > 1) {
        out.push({
          kind: "missing-isolation-cut",
          key: leaf.key,
          level: 0,
          index,
          message: `${leaf.key}: ${docs[isolated]!.bytes}-byte ${JSON.stringify(docs[isolated]!.id)} shares a leaf of ${docs.length} documents`,
        });
      }
      continue;
    }
    const nextFirst = leaves[index + 1]?.docs![0];
    const last = index === leaves.length - 1;
    let s = 0;
    for (const [i, d] of docs.entries()) {
      const p = s;
      s += d.bytes;
      const cut = cutLeaf(layout, p, s, chunkHash(salt, 0, d.id));
      if (i < docs.length - 1 && cut) {
        out.push({
          kind: s >= layout.leafMaxBytes ? "missing-forced-cut" : "missing-hash-cut",
          key: leaf.key,
          level: 0,
          index,
          message: `${leaf.key}: the rule cuts after ${JSON.stringify(d.id)} at ${s} bytes`,
        });
        break;
      }
      const cutBeforeIsolated =
        nextFirst !== undefined && nextFirst.bytes >= layout.leafIsolationDocumentBytes;
      if (i === docs.length - 1 && !cut && !last && !cutBeforeIsolated) {
        out.push({
          kind: "unexpected-cut",
          key: leaf.key,
          level: 0,
          index,
          message: `${leaf.key}: cut after ${JSON.stringify(d.id)} at ${s} bytes, where the rule makes none`,
        });
      }
    }
  }
};

/** Check every branch cut at `level` locally, as for leaves. */
const checkBranchBoundaries = (
  level: number,
  nodes: readonly DecodedNode[],
  layout: OracleLayout,
  salt: string,
  out: TreeViolation[],
): void => {
  for (const [index, node] of nodes.entries()) {
    const entries = node.entries!;
    const last = index === nodes.length - 1;
    for (const [j, entry] of entries.entries()) {
      const count = j + 1;
      const cut = cutBranch(layout, count, chunkHash(salt, level, entry.hi));
      if (j < entries.length - 1 && cut) {
        out.push({
          kind: count === layout.branchFanoutMax ? "missing-forced-cut" : "missing-hash-cut",
          key: node.key,
          level,
          index,
          message: `${node.key}: the rule cuts after entry ${count} (hi ${JSON.stringify(entry.hi)})`,
        });
        break;
      }
      if (j === entries.length - 1 && !cut && !last) {
        out.push({
          kind: "unexpected-cut",
          key: node.key,
          level,
          index,
          message: `${node.key}: cut after entry ${count} (hi ${JSON.stringify(entry.hi)}), where the rule makes none`,
        });
      }
    }
  }
};

/** {@link checkTreeImage}, throwing an `Error` that lists every violation. */
export const assertTreeImage = (input: TreeCheckInput): TreeCheckReport => {
  const report = checkTreeImage(input);
  if (report.violations.length > 0) {
    throw new Error(
      `tree image has ${report.violations.length} violation(s):\n${report.violations
        .map((v) => `  [${v.kind}] ${v.message}`)
        .join("\n")}`,
    );
  }
  return report;
};

// ---------------------------------------------------------------------------
// Canonical-root and prefix-split assertions for fold tests.

/**
 * Fold `input` through each split point in turn with the logical oracle,
 * each fold starting from the previous one's rows and folded seq. Returns one
 * view per split. The last view is what any sequence of folds ending at the
 * last split must publish. Split points must increase, from the base seq on.
 */
export const foldThroughSplits = (
  input: Omit<LogicalFoldInput, "targetSeq">,
  splits: readonly number[],
): LogicalView[] => {
  const views: LogicalView[] = [];
  let base = input.base;
  let baseSeq = input.baseSeq;
  for (const [i, targetSeq] of splits.entries()) {
    if (i === 0 ? targetSeq < baseSeq : targetSeq <= splits[i - 1]!) {
      throw new Error(`tree oracle: split points ${JSON.stringify(splits)} do not increase`);
    }
    const view = foldLogical({ ...input, base, baseSeq, targetSeq });
    views.push(view);
    base = view.rows;
    baseSeq = view.foldedSeq;
  }
  return views;
};

/** One published result to compare: a label (e.g. the split used) and its image. */
export interface SplitRun {
  readonly label: string;
  readonly image: TreeImage;
}

/**
 * Require that every run published the canonical root for `rows` with
 * `floor` as its fold end, and that all runs agree on the shape. The same row
 * set folded through different splits must give one canonical shape: the
 * tree is a function of the rows and the layout, never of fold history or
 * attempt identity. Returns violations, each message prefixed with its run's
 * label. Throws when there is no run to check.
 */
export const checkSplitEquivalence = (
  runs: readonly SplitRun[],
  options: {
    readonly prefix: string;
    readonly rows: Iterable<DocumentData>;
    readonly floor: number;
    readonly layout?: OracleLayout;
  },
): TreeViolation[] => {
  if (runs.length === 0) {
    throw new Error("tree oracle: checkSplitEquivalence needs at least one run");
  }
  const rows = [...options.rows];
  const out: TreeViolation[] = [];
  let reference: { label: string; digest: string } | undefined;
  for (const run of runs) {
    const report = checkTreeImage({
      image: run.image,
      prefix: options.prefix,
      layout: options.layout,
      expectedRows: rows,
      expectedFloor: options.floor,
    });
    out.push(...report.violations.map((v) => ({ ...v, message: `${run.label}: ${v.message}` })));
    const digest = shapeDigest(report.shape);
    if (reference === undefined) {
      reference = { label: run.label, digest };
    } else if (digest !== reference.digest) {
      out.push({
        kind: "non-canonical-root",
        key: report.rootKey ?? undefined,
        message: `${run.label}: shape ${digest} differs from ${reference.label}'s ${reference.digest}`,
      });
    }
  }
  return out;
};
