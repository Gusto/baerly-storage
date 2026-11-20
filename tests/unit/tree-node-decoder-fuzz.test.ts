/**
 * Mutation fuzzing of the prototype tree's strict node decoder
 * (`decodeNode` in `packages/server/src/tree/node-codec.ts`).
 *
 * Seed corpus: the canonical node bodies the codec tests pin byte for
 * byte, plus generated leaves and branches (root and non-root) whose IDs
 * mix code points where UTF-8 and UTF-16 order disagree. Each case
 * mutates a seed and decodes it under a key carrying the mutated body's
 * own hash, so the input gets past the hash check and reaches the
 * parser and the structural checks.
 *
 * Contract: every input either decodes, or is refused as `BaerlyError`
 * code `InvalidResponse`; nothing surfaces as a `TypeError`,
 * `SyntaxError` or `RangeError`. An accepted input must be the canonical
 * encoding of what it decoded to, both by `encodeNode` and by a
 * re-derivation from the raw `JSON.parse` output that shares no code
 * with the codec (no `null`, finite numbers, at most 100 levels,
 * canonical key order), and the decoded node must satisfy the node rules
 * as checked here independently (byte-order comparison with
 * `TextEncoder`, not `compareDocIds`). Boundary values (depth 99 to
 * 6,000, sizes at every ceiling, 256 and 257 entries, unpaired-surrogate
 * keys, `level_nodes` at and past each bound) are also put at every path
 * of every fixed seed. The `mutation`
 * block shows the suite goes red on a decoder that skips the canonical
 * re-encode check.
 */
import { BaerlyError, MAX_DOCUMENT_BYTES, sha256Hex } from "@baerly/protocol";
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { compareDocIds } from "../../packages/server/src/snapshot-doc-id.ts";
import {
  BRANCH_MAX_BODY_BYTES,
  LEAF_MAX_BODY_BYTES,
} from "../../packages/server/src/tree/constants.ts";
import { treeNodeKey } from "../../packages/server/src/tree/key.ts";
import { createTreeConfig, type TreeConfig } from "../../packages/server/src/tree/layout.ts";
import {
  canonicalDocument,
  type DecodedTreeNode,
  decodeNode,
  encodeNode,
  sealNode,
  type TreeChildEntry,
  type TreeDocument,
  type TreeNode,
  type TreeNodeExpectation,
} from "../../packages/server/src/tree/node-codec.ts";
import { DECODER_SKIPS_REENCODE } from "../fixtures/tree-mutants.ts";

const P = "app/fuzz/tenant/t/manifests/tickets";
const COLLECTION = "tickets";
const A1 = "00112233445566778899aabbccddeeff";
const A2 = "ffeeddccbbaa99887766554433221100";
const SHA = "fbf6a6386499e42c43fec71fb62476ba684391288cc343204b8552dcc394ff61";
const PRODUCTION = createTreeConfig();
const SKIPS_REENCODE = createTreeConfig(DECODER_SKIPS_REENCODE.options);
const utf8 = new TextEncoder();

// ---------------------------------------------------------------------
// Seed corpus
// ---------------------------------------------------------------------

interface Seed {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly attempt: string;
  readonly expected: TreeNodeExpectation;
}

const seedOf = async (label: string, node: TreeNode): Promise<Seed> => {
  const sealed = await sealNode(P, node);
  const expected: TreeNodeExpectation =
    node.root === null
      ? { prefix: P, root: false, level: node.level, entry: sealed.summary }
      : { prefix: P, root: true, floor: node.root.floor };
  return { label, bytes: sealed.bytes, attempt: node.attempt, expected };
};

const VECTOR_NODES: ReadonlyArray<readonly [string, TreeNode]> = [
  [
    "leaf",
    {
      kind: "leaf",
      collection: COLLECTION,
      attempt: A1,
      level: 0,
      root: null,
      docs: [
        { _id: "a", n: 1 },
        { _id: "b", n: 2 },
      ],
    },
  ],
  [
    "root leaf",
    {
      kind: "leaf",
      collection: COLLECTION,
      attempt: A1,
      level: 0,
      root: { floor: 7, rows: 3, bytes: 103 },
      docs: [
        { _id: "a", n: 2.5, s: "\ud800", o: { "10": [true], "2": "é" } },
        { _id: "�", n: -1 },
        { _id: "\u{1f600}", t: false },
      ],
    },
  ],
  [
    "branch",
    {
      kind: "branch",
      collection: COLLECTION,
      attempt: A2,
      level: 1,
      root: null,
      children: [
        { lo: "a", hi: "a", rows: 1, bytes: 17, attempt: A1, sha256: SHA },
        { lo: "b", hi: "\u{1f600}", rows: 2, bytes: 40, attempt: A2, sha256: SHA },
      ],
    },
  ],
  [
    "root branch",
    {
      kind: "branch",
      collection: COLLECTION,
      attempt: A1,
      level: 2,
      root: { floor: 9, rows: 6, bytes: 120, levelNodes: [5, 3] },
      children: [
        { lo: "a", hi: "b", rows: 2, bytes: 34, attempt: A2, sha256: SHA },
        { lo: "c", hi: "�", rows: 3, bytes: 60, attempt: A1, sha256: SHA },
        { lo: "\u{10000}", hi: "\u{10000}", rows: 1, bytes: 26, attempt: A2, sha256: SHA },
      ],
    },
  ],
  [
    // Enough rows that level_nodes can reach the 256-times bound.
    "root branch with many rows",
    {
      kind: "branch",
      collection: COLLECTION,
      attempt: A2,
      level: 3,
      root: { floor: 4, rows: 200_000, bytes: 2_200_000, levelNodes: [700, 3, 2] },
      children: [
        { lo: "a", hi: "m", rows: 100_000, bytes: 1_100_000, attempt: A1, sha256: SHA },
        { lo: "n", hi: "z", rows: 100_000, bytes: 1_100_000, attempt: A2, sha256: SHA },
      ],
    },
  ],
];

const FIXED_SEEDS: readonly Seed[] = await Promise.all(
  VECTOR_NODES.map(([label, node]) => seedOf(label, node)),
);

/** IDs from code points where UTF-8 and UTF-16 order disagree, plus escapes. */
const docId = fc
  .array(fc.constantFrom("a", "b", "z", "0", '"', "\\", "é", "�", "￿", "😀", "\u{10000}"), {
    minLength: 1,
    maxLength: 3,
  })
  .map((parts) => parts.join(""));

const docValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.string({ maxLength: 4 }),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(
      fc.constantFrom("0", "9", "10", "_id", "__proto__", "a", "é", "😀"),
      tie("value"),
      {
        maxKeys: 3,
      },
    ),
  ),
})).value;

const hex = (length: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(..."0123456789abcdef"), { minLength: length, maxLength: length })
    .map((chars) => chars.join(""));

const sortIds = (ids: readonly string[]): string[] => ids.toSorted(compareDocIds);

/** A generated leaf; root totals use the codec's canonical document bytes. */
const generatedLeaf: fc.Arbitrary<TreeNode> = fc
  .record({
    docs: fc.uniqueArray(fc.record({ _id: docId, v: docValue }), {
      selector: (d) => d._id,
      minLength: 1,
      maxLength: 5,
    }),
    attempt: hex(32),
    floor: fc.option(fc.nat(), { nil: null }),
  })
  .map(({ docs, attempt, floor }) => {
    const canonical = docs
      .map((d) => canonicalDocument(d, "seed"))
      .toSorted((x, y) => compareDocIds(x.id, y.id));
    const bytes = canonical.reduce((sum, d) => sum + d.bytes, 0);
    return {
      kind: "leaf" as const,
      collection: COLLECTION,
      attempt,
      level: 0 as const,
      root: floor === null ? null : { floor, rows: canonical.length, bytes },
      docs: canonical.map((d) => d.doc),
    };
  });

const generatedBranch: fc.Arbitrary<TreeNode> = fc
  .record({
    ids: fc.uniqueArray(docId, { minLength: 2, maxLength: 8 }),
    rows: fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 4, maxLength: 4 }),
    slack: fc.array(fc.nat({ max: 50 }), { minLength: 4, maxLength: 4 }),
    attempts: fc.array(hex(32), { minLength: 4, maxLength: 4 }),
    shas: fc.array(hex(64), { minLength: 4, maxLength: 4 }),
    attempt: hex(32),
    level: fc.integer({ min: 1, max: 16 }),
    floor: fc.option(fc.nat(), { nil: null }),
    picks: fc.array(fc.nat(), { minLength: 16, maxLength: 16 }),
  })
  .map(({ ids, rows, slack, attempts, shas, attempt, level, floor, picks }) => {
    const sorted = sortIds(ids);
    const children: TreeChildEntry[] = [];
    for (let i = 0; i + 1 < sorted.length && children.length < 4; i += 2) {
      const n = children.length;
      children.push({
        lo: sorted[i]!,
        hi: sorted[i + 1]!,
        rows: rows[n]!,
        bytes: 11 * rows[n]! + slack[n]!,
        attempt: attempts[n]!,
        sha256: shas[n]!,
      });
    }
    const totals = {
      rows: children.reduce((s, c) => s + c.rows, 0),
      bytes: children.reduce((s, c) => s + c.bytes, 0),
    };
    // From the top level down: each count between the one above and 256
    // times it, never more than the rows.
    const levelNodes: number[] = [children.length];
    for (let l = level - 2; l >= 0; l--) {
      const above = levelNodes[0]!;
      const most = Math.min(256 * above, totals.rows);
      levelNodes.unshift(above + (picks[l]! % (most - above + 1)));
    }
    return {
      kind: "branch" as const,
      collection: COLLECTION,
      attempt,
      level,
      root: floor === null ? null : { floor, ...totals, levelNodes },
      children,
    };
  });

const seed: fc.Arbitrary<Promise<Seed>> = fc.oneof(
  fc.constantFrom(...FIXED_SEEDS).map(async (s) => s),
  fc.oneof(generatedLeaf, generatedBranch).map(async (node) => seedOf("generated", node)),
);

// ---------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------

const ascii = (s: string): number[] => [...utf8.encode(s)];

/** Bytes that steer a mutation toward JSON-significant or decoder-hostile input. */
const HOSTILE_TOKENS: readonly (readonly number[])[] = [
  ...['"', "\\", "{", "}", "[", "]", ",", ":", " ", "\n", "\t", "0", "-", "."].map(ascii),
  ...["null", "true", "1e999", "-0", "2.50", "1e0", "\\u0061", "\\ud800", "\\/", '"__proto__"'].map(
    ascii,
  ),
  ...['"level":1', '"rows":0', '"bytes":-1', '"floor":0', '{"_id":"a"}', `"${A2}"`].map(ascii),
  [0xff],
  [0xc0, 0x80],
  [0xed, 0xa0, 0x80],
  [0xef, 0xbb, 0xbf],
  [0x00],
];

type ByteMutation =
  | { readonly kind: "flip"; readonly at: number; readonly bit: number }
  | { readonly kind: "set"; readonly at: number; readonly byte: number }
  | { readonly kind: "insert"; readonly at: number; readonly bytes: readonly number[] }
  | { readonly kind: "delete"; readonly at: number; readonly len: number }
  | { readonly kind: "truncate"; readonly at: number }
  | { readonly kind: "duplicate"; readonly at: number; readonly len: number }
  | { readonly kind: "swap"; readonly at: number; readonly other: number };

const byteMutation: fc.Arbitrary<ByteMutation> = fc.oneof(
  fc.record({
    kind: fc.constant("flip" as const),
    at: fc.nat(),
    bit: fc.integer({ min: 0, max: 7 }),
  }),
  fc.record({
    kind: fc.constant("set" as const),
    at: fc.nat(),
    byte: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({
    kind: fc.constant("insert" as const),
    at: fc.nat(),
    bytes: fc.oneof(
      fc.constantFrom(...HOSTILE_TOKENS),
      fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 4 }),
    ),
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    at: fc.nat(),
    len: fc.integer({ min: 1, max: 24 }),
  }),
  fc.record({ kind: fc.constant("truncate" as const), at: fc.nat() }),
  fc.record({
    kind: fc.constant("duplicate" as const),
    at: fc.nat(),
    len: fc.integer({ min: 1, max: 24 }),
  }),
  fc.record({ kind: fc.constant("swap" as const), at: fc.nat(), other: fc.nat() }),
);

const applyByteMutation = (input: readonly number[], m: ByteMutation): number[] => {
  const out = [...input];
  const at = m.at % (out.length + 1);
  switch (m.kind) {
    case "flip": {
      if (at < out.length) {
        out[at] = out[at]! ^ (1 << m.bit);
      }
      return out;
    }
    case "set": {
      if (at < out.length) {
        out[at] = m.byte;
      }
      return out;
    }
    case "insert": {
      out.splice(at, 0, ...m.bytes);
      return out;
    }
    case "delete": {
      out.splice(at, m.len);
      return out;
    }
    case "truncate": {
      return out.slice(0, at);
    }
    case "duplicate": {
      out.splice(at, 0, ...out.slice(at, at + m.len));
      return out;
    }
    case "swap": {
      const other = m.other % Math.max(out.length, 1);
      if (at < out.length && other < out.length) {
        [out[at], out[other]] = [out[other]!, out[at]!];
      }
      return out;
    }
  }
};

/**
 * Deep values are carried through the edits as a marker string and
 * spliced into the body text by {@link bodyText}, so building and
 * serializing them never recurses (`JSON.stringify` overflows the stack
 * on some hosts near 5,000 levels).
 */
const DEEP_MARKER = "\u0000deep:";
const deep = (kind: "array" | "object", levels: number): string =>
  `${DEEP_MARKER}${kind}:${levels}`;
const DEEP_PATTERN = /"\\u0000deep:(array|object):([0-9]+)"/g;

/** `JSON.stringify(value)`, with every {@link deep} marker expanded to its nested value. */
const bodyText = (value: unknown): string =>
  (JSON.stringify(value) ?? "null").replace(DEEP_PATTERN, (_match, kind: string, n: string) => {
    const levels = Number(n);
    return kind === "array"
      ? `${"[".repeat(levels)}${"]".repeat(levels)}`
      : `${'{"a":'.repeat(levels - 1)}{}${"}".repeat(levels - 1)}`;
  });

/** A string of `n` characters. */
const longString = (n: number): string => "x".repeat(n);

/** `length` consecutive, ordered, individually valid branch entries. */
const orderedEntries = (length: number): unknown[] =>
  Array.from({ length }, (_, i) => {
    const id = `k${String(i).padStart(4, "0")}`;
    return { lo: id, hi: id, rows: 1, bytes: 11, attempt: A2, sha256: SHA };
  });

/** A document of exactly `n` canonical bytes. */
const documentOf = (n: number): unknown => ({
  _id: "a",
  p: "y".repeat(n - '{"_id":"a","p":""}'.length),
});

/**
 * Values at and past the depth limit and every size ceiling. Random
 * edits reach a given field with one of these too rarely, so the
 * exhaustive test below also puts each one at every path of every fixed
 * seed.
 */
const BOUNDARY_VALUES: readonly unknown[] = [
  null,
  { "\ud800": 1 },
  { "\udc00": [1] },
  // The document itself is level 1, so a 99-level value nested in a
  // document field reaches the 100-level limit exactly.
  deep("object", 99),
  deep("object", 100),
  deep("array", 99),
  deep("array", 100),
  deep("array", 101),
  deep("array", 6000),
  deep("object", 6000),
  longString(MAX_DOCUMENT_BYTES - 20),
  longString(MAX_DOCUMENT_BYTES),
  longString(BRANCH_MAX_BODY_BYTES - 300),
  longString(BRANCH_MAX_BODY_BYTES),
  longString(LEAF_MAX_BODY_BYTES - 300),
  longString(LEAF_MAX_BODY_BYTES),
  documentOf(MAX_DOCUMENT_BYTES),
  documentOf(MAX_DOCUMENT_BYTES + 1),
  orderedEntries(256),
  orderedEntries(257),
  // level_nodes at and past each bound, for the fixed root branches.
  [3],
  [2],
  [3, 3],
  [2, 3],
  [6, 3],
  [7, 3],
  [0, 3],
  [3, 3, 3],
  [700, 3, 2],
  [512, 2, 2],
  [513, 2, 2],
  [768, 3, 2],
  [769, 3, 2],
  [700, 3, 3],
  [700, 1, 2],
];

/**
 * A value replacing a field: out-of-range numbers, wrong types, hostile
 * IDs and object keys, and the boundary values.
 */
const hostileJson: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(
    null,
    true,
    false,
    0,
    -1,
    1,
    1.5,
    11,
    2 ** 53,
    Number.MAX_SAFE_INTEGER,
    1e308,
    "",
    "a",
    "_a",
    "a/b",
    "..",
    "\ud800",
    "\u0085",
    "é".repeat(129),
    A1,
    A2,
    A1.toUpperCase(),
    SHA,
    [],
    {},
    [1],
    { _id: "a" },
    "baerly-tree-node-proto",
    COLLECTION,
  ),
  fc.constantFrom<unknown>(...BOUNDARY_VALUES),
  fc.integer({ min: -2, max: 300 }),
  docId,
);

type JsonPath = readonly (string | number)[];

type StructuralEdit =
  | { readonly kind: "replace"; readonly pick: number; readonly value: unknown }
  | { readonly kind: "delete"; readonly pick: number }
  | { readonly kind: "add"; readonly pick: number; readonly key: string; readonly value: unknown }
  | { readonly kind: "duplicate"; readonly pick: number }
  | { readonly kind: "swap-next"; readonly pick: number };

const structuralEdit: fc.Arbitrary<StructuralEdit> = fc.oneof(
  fc.record({ kind: fc.constant("replace" as const), pick: fc.nat(), value: hostileJson }),
  fc.record({ kind: fc.constant("delete" as const), pick: fc.nat() }),
  fc.record({
    kind: fc.constant("add" as const),
    pick: fc.nat(),
    key: fc.constantFrom(
      "extra",
      "floor",
      "rows",
      "bytes",
      "lo",
      "_id",
      "__proto__",
      "0",
      "\ud800",
      "\udfff",
      longString(300),
    ),
    value: hostileJson,
  }),
  fc.record({ kind: fc.constant("duplicate" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("swap-next" as const), pick: fc.nat() }),
);

const pathsOf = (value: unknown, path: JsonPath = [], out: JsonPath[] = []): JsonPath[] => {
  out.push(path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => pathsOf(item, [...path, i], out));
  } else if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      pathsOf((value as Record<string, unknown>)[key], [...path, key], out);
    }
  }
  return out;
};

const setOwn = (target: object, key: string | number, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

const containerAt = (root: unknown, path: JsonPath): unknown =>
  path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], root);

/** Apply `edit` to a parsed body; the empty path (the whole body) is replaced or left alone. */
const applyStructuralEdit = (body: unknown, edit: StructuralEdit): unknown => {
  const root = { body };
  const paths = pathsOf(body);
  const path: JsonPath = ["body", ...paths[edit.pick % paths.length]!];
  const parent = containerAt(root, path.slice(0, -1)) as Record<string | number, unknown>;
  const key = path.at(-1)!;
  switch (edit.kind) {
    case "replace": {
      setOwn(parent, key, edit.value);
      break;
    }
    case "delete": {
      if (Array.isArray(parent)) {
        parent.splice(key as number, 1);
      } else {
        delete parent[key];
      }
      break;
    }
    case "add": {
      const target = parent[key];
      if (typeof target === "object" && target !== null && !Array.isArray(target)) {
        setOwn(target, edit.key, edit.value);
      }
      break;
    }
    case "duplicate": {
      if (Array.isArray(parent)) {
        parent.splice(key as number, 0, structuredClone(parent[key as number]));
      }
      break;
    }
    case "swap-next": {
      if (Array.isArray(parent) && (key as number) + 1 < parent.length) {
        const i = key as number;
        [parent[i], parent[i + 1]] = [parent[i + 1], parent[i]];
      }
      break;
    }
  }
  return root.body;
};

// ---------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------

/** UTF-8 byte order, computed independently of `compareDocIds`. */
const byteOrder = (a: string, b: string): number => {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      return x[i]! - y[i]!;
    }
  }
  return x.length - y.length;
};

const validId = (id: unknown): boolean =>
  typeof id === "string" &&
  id.length > 0 &&
  id.isWellFormed() &&
  !id.includes("/") &&
  id !== "." &&
  id !== ".." &&
  !id.startsWith("_") &&
  // eslint-disable-next-line no-control-regex -- the ID domain excludes C0 and C1 controls
  !/[\u0000-\u001f\u007f-\u009f]/.test(id) &&
  utf8.encode(id).length <= 256;

const docBytes = (doc: TreeDocument): number => utf8.encode(JSON.stringify(doc)).length;

/** The node rules, checked on a decoded node without the codec's own helpers. */
const expectNodeRules = (decoded: DecodedTreeNode, seedCase: Seed): void => {
  const { node, summary } = decoded;
  expect(node.collection).toBe(COLLECTION);
  expect(node.attempt).toBe(decoded.attempt);
  let rows: number;
  let bytes: number;
  let lo: string;
  let hi: string;
  if (node.kind === "leaf") {
    expect(node.level).toBe(0);
    expect(node.docs.length).toBeGreaterThan(0);
    for (const doc of node.docs) {
      expect(validId(doc._id)).toBe(true);
      expect(docBytes(doc)).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    }
    for (let i = 1; i < node.docs.length; i++) {
      expect(byteOrder(node.docs[i - 1]!._id, node.docs[i]!._id)).toBeLessThan(0);
    }
    rows = node.docs.length;
    bytes = node.docs.reduce((s, d) => s + docBytes(d), 0);
    lo = node.docs[0]!._id;
    hi = node.docs.at(-1)!._id;
  } else {
    expect(node.level).toBeGreaterThanOrEqual(1);
    expect(node.level).toBeLessThanOrEqual(16);
    expect(node.children.length).toBeGreaterThan(0);
    expect(node.children.length).toBeLessThanOrEqual(256);
    for (const [i, c] of node.children.entries()) {
      expect(validId(c.lo) && validId(c.hi)).toBe(true);
      expect(byteOrder(c.lo, c.hi)).toBeLessThanOrEqual(0);
      expect(Number.isSafeInteger(c.rows) && c.rows >= 1).toBe(true);
      expect(Number.isSafeInteger(c.bytes) && c.bytes >= 11 * c.rows).toBe(true);
      expect(c.attempt).toMatch(/^[0-9a-f]{32}$/);
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
      if (i > 0) {
        expect(byteOrder(node.children[i - 1]!.hi, c.lo)).toBeLessThan(0);
      }
    }
    rows = node.children.reduce((s, c) => s + c.rows, 0);
    bytes = node.children.reduce((s, c) => s + c.bytes, 0);
    lo = node.children[0]!.lo;
    hi = node.children.at(-1)!.hi;
  }
  expect(summary).toEqual({ lo, hi, rows, bytes });
  if (node.kind === "branch" && node.root !== null) {
    const counts = node.root.levelNodes;
    expect(counts.length).toBe(node.level);
    expect(counts.every((n) => Number.isSafeInteger(n) && n >= 1)).toBe(true);
    expect(counts.at(-1)).toBe(node.children.length);
    for (let l = 0; l + 1 < counts.length; l++) {
      expect(counts[l]!).toBeGreaterThanOrEqual(counts[l + 1]!);
      expect(counts[l]!).toBeLessThanOrEqual(256 * counts[l + 1]!);
    }
    expect(counts[0]!).toBeLessThanOrEqual(rows);
  }
  if (node.root !== null) {
    expect(node.root).toMatchObject({ rows, bytes });
    expect(seedCase.expected.root).not.toBe(false);
  } else {
    expect(seedCase.expected.root).not.toBe(true);
  }
  const { expected } = seedCase;
  if (expected.level !== undefined) {
    expect(node.level).toBe(expected.level);
  }
  if (expected.entry !== undefined) {
    expect(summary).toEqual({ ...expected.entry });
  }
  if (expected.floor !== undefined) {
    expect(node.root?.floor).toBe(expected.floor);
  }
};

/**
 * Byte equality without a structural diff: a failing `toEqual` on a
 * megabyte body prints the whole array and can exhaust the worker's heap.
 */
const expectSameBytes = (actual: Uint8Array, expected: Uint8Array, what: string): void => {
  const length = Math.min(actual.length, expected.length);
  let at = 0;
  while (at < length && actual[at] === expected[at]) {
    at++;
  }
  if (at < length || actual.length !== expected.length) {
    const context = (b: Uint8Array) =>
      JSON.stringify(new TextDecoder().decode(b.subarray(Math.max(0, at - 40), at + 40)));
    throw new Error(
      `${what} differs from the accepted body at byte ${at} (lengths ${actual.length}, ${expected.length}): ${context(actual)} vs ${context(expected)}`,
    );
  }
};

const NODE_FIELD_LISTS: readonly (readonly string[])[] = [
  ["format", "schema_version", "collection", "attempt", "level", "docs"],
  ["format", "schema_version", "collection", "attempt", "level", "floor", "rows", "bytes", "docs"],
  ["format", "schema_version", "collection", "attempt", "level", "children"],
  [
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
];
const ENTRY_FIELD_LIST = ["lo", "hi", "rows", "bytes", "attempt", "sha256"];

const isIndexKey = (key: string): boolean =>
  /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) <= 4_294_967_294;

/** Array-index names in numeric order, then the rest in UTF-16 order. */
const canonicalKeyOrder = (keys: readonly string[]): string[] => [
  ...keys.filter(isIndexKey).toSorted((a, b) => Number(a) - Number(b)),
  ...keys.filter((k) => !isIndexKey(k)).toSorted(),
];

class OracleRefusal extends Error {}
const refuse = (detail: string): never => {
  throw new OracleRefusal(detail);
};

/**
 * The canonical text of a document value, written without the codec:
 * no `null`, finite numbers only, at most 100 levels (the document is
 * level 1), object keys in canonical order.
 */
const writeCanonical = (value: unknown, depth: number): string => {
  if (value === null) {
    return refuse("null in a document");
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : refuse("non-finite number");
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (depth > 100) {
    return refuse("document deeper than 100 levels");
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => writeCanonical(item, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!sameList(keys, canonicalKeyOrder(keys))) {
    refuse("object keys out of canonical order");
  }
  return `{${keys.map((k) => `${JSON.stringify(k)}:${writeCanonical(record[k], depth + 1)}`).join(",")}}`;
};

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const writeScalar = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? refuse("an envelope or entry field is not a scalar")
    : JSON.stringify(value);

/**
 * Re-derive the canonical body from the raw `JSON.parse` output, sharing
 * nothing with the codec, and require it to be `bytes` exactly.
 */
const expectIndependentlyCanonical = (bytes: Uint8Array): void => {
  const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const fields = Object.keys(body);
  if (!NODE_FIELD_LISTS.some((list) => sameList(list, fields))) {
    refuse("not a node field list");
  }
  const parts = fields.map((field) => {
    const value = body[field];
    if (field === "docs") {
      return `"docs":[${(value as unknown[]).map((doc) => writeCanonical(doc, 1)).join(",")}]`;
    }
    if (field === "children") {
      const written = (value as Record<string, unknown>[]).map((entry) => {
        if (!sameList(Object.keys(entry), ENTRY_FIELD_LIST)) {
          refuse("not the entry field list");
        }
        return `{${ENTRY_FIELD_LIST.map((f) => `${JSON.stringify(f)}:${writeScalar(entry[f])}`).join(",")}}`;
      });
      return `"children":[${written.join(",")}]`;
    }
    if (field === "level_nodes") {
      if (!Array.isArray(value)) {
        return refuse("level_nodes is not an array");
      }
      return `"level_nodes":[${value.map(writeScalar).join(",")}]`;
    }
    return `${JSON.stringify(field)}:${writeScalar(value)}`;
  });
  expectSameBytes(utf8.encode(`{${parts.join(",")}}`), bytes, "independent re-derivation");
};

const settle = async <T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * Decode `bytes` as `seedCase` would be routed, under a key carrying the
 * bytes' own hash, and check the contract. Throws (an expect failure) on
 * any breach, so it also works inside `fc.check`.
 */
const decodeAndJudge = async (
  bytes: Uint8Array,
  seedCase: Seed,
  config: TreeConfig,
): Promise<void> => {
  const key = treeNodeKey(P, seedCase.attempt, await sha256Hex(bytes));
  const outcome = await settle(decodeNode(key, bytes, seedCase.expected, config));
  if (!outcome.ok) {
    expect(outcome.error).toBeInstanceOf(BaerlyError);
    expect((outcome.error as BaerlyError).code).toBe("InvalidResponse");
    return;
  }
  // Accepted ⇒ canonical: the body is the encoding of what it decoded to,
  // both by the codec's encoder and by a re-derivation that shares no
  // code with it.
  expectSameBytes(encodeNode(outcome.value.node), bytes, "encodeNode");
  expectIndependentlyCanonical(bytes);
  expectNodeRules(outcome.value, seedCase);
};

const asRoutedEither = (s: Seed): Seed => ({ ...s, expected: { prefix: P, root: "either" } });

/** A seed, possibly re-routed as a GC candidate. */
const routedSeed: fc.Arbitrary<Promise<Seed>> = fc
  .record({ s: seed, either: fc.boolean() })
  .map(async ({ s, either }) => (either ? asRoutedEither(await s) : s));

// ---------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------

/** Byte mutations: any decoder outcome other than "canonical and valid" or InvalidResponse is a bug. */
const byteFuzz = (config: TreeConfig) =>
  fc.asyncProperty(
    routedSeed,
    fc.array(byteMutation, { minLength: 1, maxLength: 6 }),
    async (seedPromise, mutations) => {
      const s = await seedPromise;
      const bytes = Uint8Array.from(mutations.reduce(applyByteMutation, [...s.bytes]));
      await decodeAndJudge(bytes, s, config);
    },
  );

/** Where a canonical body can be respelled without changing its value, by respelling kind. */
interface RespellSites {
  /** Just after a structural `,` or `:`. */
  readonly whitespace: number[];
  /** A plain (unescaped) character inside a string. */
  readonly escape: number[];
  /** Just after an integer token. */
  readonly number: number[];
}

const respellSites = (text: string): RespellSites => {
  const sites: RespellSites = { whitespace: [], escape: [], number: [] };
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") {
        // Skip the escape: `\uXXXX` is six characters, the rest two.
        i += text[i + 1] === "u" ? 5 : 1;
      } else if (c === '"') {
        inString = false;
      } else {
        sites.escape.push(i);
      }
    } else if (c === '"') {
      inString = true;
    } else if (c === "," || c === ":") {
      sites.whitespace.push(i + 1);
    } else if (/[-0-9]/.test(c)) {
      const token = /^-?[0-9.eE+-]+/.exec(text.slice(i))![0];
      if (/^-?(?:0|[1-9][0-9]*)$/.test(token)) {
        sites.number.push(i + token.length);
      }
      i += token.length - 1;
    }
  }
  return sites;
};

type Respelling =
  | { readonly kind: "whitespace"; readonly pick: number; readonly space: string }
  | { readonly kind: "escape"; readonly pick: number; readonly upper: boolean }
  | { readonly kind: "number"; readonly pick: number; readonly suffix: string };

const respelling: fc.Arbitrary<Respelling> = fc.oneof(
  fc.record({
    kind: fc.constant("whitespace" as const),
    pick: fc.nat(),
    space: fc.constantFrom(" ", "\n", "\t", "\r"),
  }),
  fc.record({ kind: fc.constant("escape" as const), pick: fc.nat(), upper: fc.boolean() }),
  fc.record({
    kind: fc.constant("number" as const),
    pick: fc.nat(),
    suffix: fc.constantFrom(".0", "e0", "E+0", ".00"),
  }),
);

/**
 * Respell a canonical body without changing its JSON value: whitespace
 * after a separator, a `\\uXXXX` escape for a string character, or an
 * alternate number spelling. Returns `null` when the body has no site of
 * that kind.
 */
const respell = (text: string, r: Respelling): string | null => {
  const sites = respellSites(text);
  const list = sites[r.kind];
  if (list.length === 0) {
    return null;
  }
  const at = list[r.pick % list.length]!;
  if (r.kind === "whitespace") {
    return `${text.slice(0, at)}${r.space}${text.slice(at)}`;
  }
  if (r.kind === "number") {
    return `${text.slice(0, at)}${r.suffix}${text.slice(at)}`;
  }
  const unit = text.charCodeAt(at).toString(16).padStart(4, "0");
  return `${text.slice(0, at)}\\u${r.upper ? unit.toUpperCase() : unit}${text.slice(at + 1)}`;
};

/** A non-canonical respelling of a valid body: always refused. */
const respellFuzz = (config: TreeConfig) =>
  fc.asyncProperty(routedSeed, respelling, async (seedPromise, r) => {
    const s = await seedPromise;
    const text = respell(new TextDecoder().decode(s.bytes), r);
    if (text === null) {
      return;
    }
    const bytes = utf8.encode(text);
    // Same value, different bytes: the respelling parses to the seed's value.
    expect(JSON.parse(text)).toEqual(JSON.parse(new TextDecoder().decode(s.bytes)));
    const key = treeNodeKey(P, s.attempt, await sha256Hex(bytes));
    const outcome = await settle(decodeNode(key, bytes, s.expected, config));
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: BaerlyError }).error.code).toBe("InvalidResponse");
  });

describe("tree node decoder fuzz", () => {
  test("the seed corpus decodes unmutated, as routed and as a GC candidate", async () => {
    for (const s of FIXED_SEEDS) {
      await expect(
        decodeNode(treeNodeKey(P, s.attempt, await sha256Hex(s.bytes)), s.bytes, s.expected),
      ).resolves.toBeDefined();
      await decodeAndJudge(s.bytes, asRoutedEither(s), PRODUCTION);
    }
  });

  fcTest.prop({ s: seed })("generated seeds decode unmutated", async ({ s }) => {
    const seedCase = await s;
    await decodeAndJudge(seedCase.bytes, seedCase, PRODUCTION);
  });

  test("byte mutations: InvalidResponse, or canonical and valid", async () => {
    await fc.assert(byteFuzz(PRODUCTION));
  });

  fcTest.prop({ s: routedSeed, edits: fc.array(structuralEdit, { minLength: 1, maxLength: 3 }) })(
    "structural edits re-serialized as JSON: InvalidResponse, or canonical and valid",
    async ({ s, edits }) => {
      const seedCase = await s;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(seedCase.bytes));
      const edited = edits.reduce(applyStructuralEdit, parsed);
      await decodeAndJudge(utf8.encode(bodyText(edited)), seedCase, PRODUCTION);
    },
  );

  test("every boundary value at every path of every fixed seed: InvalidResponse, or canonical and valid", async () => {
    // Routed as GC candidates, with no parent entry to pin the totals, so
    // an edit that stays valid is accepted and reaches the oracle.
    for (const s of FIXED_SEEDS.map(asRoutedEither)) {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(s.bytes));
      const paths = pathsOf(parsed).length;
      for (let pick = 0; pick < paths; pick++) {
        const edits: StructuralEdit[] = [
          ...BOUNDARY_VALUES.map((value) => ({ kind: "replace" as const, pick, value })),
          ...["\ud800", "\udfff"].map((key) => ({ kind: "add" as const, pick, key, value: 1 })),
        ];
        for (const edit of edits) {
          const edited = applyStructuralEdit(structuredClone(parsed), edit);
          await decodeAndJudge(utf8.encode(bodyText(edited)), s, PRODUCTION);
        }
      }
    }
    // An exhaustive sweep: about 2.5s alone, past the 5s unit default once
    // the parallel suite starves it.
  }, 30_000);

  test("a respelling with the same value (whitespace, escapes, number spellings) is always refused", async () => {
    await fc.assert(respellFuzz(PRODUCTION));
  });

  fcTest.prop({ s: routedSeed, swap: fc.nat(), dup: fc.boolean() })(
    "unsorted or duplicate document IDs and entries are refused",
    async ({ s, swap, dup }) => {
      const seedCase = await s;
      const value = JSON.parse(new TextDecoder().decode(seedCase.bytes)) as Record<
        string,
        unknown[]
      >;
      const items = value["docs"] ?? value["children"]!;
      if (items.length < 2 && !dup) {
        return;
      }
      if (dup) {
        const i = swap % items.length;
        items.splice(i, 0, structuredClone(items[i]));
      } else {
        const i = swap % (items.length - 1);
        [items[i], items[i + 1]] = [items[i + 1], items[i]];
      }
      const bytes = utf8.encode(JSON.stringify(value));
      const key = treeNodeKey(P, seedCase.attempt, await sha256Hex(bytes));
      await expect(decodeNode(key, bytes, seedCase.expected)).rejects.toMatchObject({
        code: "InvalidResponse",
      });
    },
  );

  fcTest.prop({ s: seed, delta: fc.integer({ min: 1, max: 17 }) })(
    "a level other than the routed one is refused",
    async ({ s, delta }) => {
      const seedCase = await s;
      const decoded = await decodeNode(
        treeNodeKey(P, seedCase.attempt, await sha256Hex(seedCase.bytes)),
        seedCase.bytes,
        { prefix: P, root: "either" },
      );
      const wrong = (decoded.node.level + delta) % 18;
      await expect(
        decodeNode(decoded.key, seedCase.bytes, { prefix: P, root: "either", level: wrong }),
      ).rejects.toMatchObject({ code: "InvalidResponse" });
    },
  );

  fcTest.prop({ a: seed, b: seed, otherAttempt: hex(32) })(
    "a body under another body's key, or another attempt, is refused",
    async ({ a, b, otherAttempt }) => {
      const [x, y] = [await a, await b];
      const xKey = treeNodeKey(P, x.attempt, await sha256Hex(x.bytes));
      if (!x.bytes.every((byte, i) => y.bytes[i] === byte) || x.bytes.length !== y.bytes.length) {
        await expect(
          decodeNode(xKey, y.bytes, { prefix: P, root: "either" }),
        ).rejects.toMatchObject({
          code: "InvalidResponse",
        });
      }
      if (otherAttempt !== x.attempt) {
        const moved = treeNodeKey(P, otherAttempt, await sha256Hex(x.bytes));
        await expect(
          decodeNode(moved, x.bytes, { prefix: P, root: "either" }),
        ).rejects.toMatchObject({
          code: "InvalidResponse",
        });
      }
    },
  );

  test("oversize bodies are refused: over the node ceiling, and a branch over its own", async () => {
    const huge = new Uint8Array(LEAF_MAX_BODY_BYTES + 1).fill(0x7b);
    await decodeAndJudge(huge, asRoutedEither(FIXED_SEEDS[0]!), PRODUCTION);

    const ids = Array.from(
      { length: 1700 },
      (_, i) => `${"k".repeat(200)}${String(i).padStart(4, "0")}`,
    );
    const entries = ids.map(
      (id) => `{"lo":"${id}","hi":"${id}","rows":1,"bytes":11,"attempt":"${A2}","sha256":"${SHA}"}`,
    );
    const branch = utf8.encode(
      `{"format":"baerly-tree-node-proto","schema_version":1,"collection":"${COLLECTION}","attempt":"${A1}","level":1,"children":[${entries.join(",")}]}`,
    );
    expect(branch.byteLength).toBeGreaterThan(BRANCH_MAX_BODY_BYTES);
    expect(branch.byteLength).toBeLessThanOrEqual(LEAF_MAX_BODY_BYTES);
    const key = treeNodeKey(P, A1, await sha256Hex(branch));
    await expect(decodeNode(key, branch, { prefix: P, root: "either" })).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

describe("mutation", () => {
  // Fixed seeds keep the red result deterministic.
  const RED = { seed: 0x7ee, numRuns: 2000 } as const;

  test(`${DECODER_SKIPS_REENCODE.name}: non-canonical spellings decode`, async () => {
    const baseline = `{"format":"baerly-tree-node-proto","schema_version":1,"collection":"${COLLECTION}","attempt":"${A1}","level":0,"docs":[{"_id":"a","n":1}]}`;
    for (const body of [
      baseline.replace('"n":1', '"n":2.50'),
      baseline.replace('"n":1', '"n":-0'),
      baseline.replace('"n":1', '"n":1,"n":1'),
      baseline.replace('"level":0', '"level": 0'),
    ]) {
      const bytes = utf8.encode(body);
      const key = treeNodeKey(P, A1, await sha256Hex(bytes));
      const expected = { prefix: P, root: false } as const;
      await expect(decodeNode(key, bytes, expected)).rejects.toMatchObject({
        code: "InvalidResponse",
      });
      await expect(decodeNode(key, bytes, expected, SKIPS_REENCODE)).resolves.toBeDefined();
    }
  });

  test(`${DECODER_SKIPS_REENCODE.name}: the respelling property goes red`, async () => {
    const result = await fc.check(respellFuzz(SKIPS_REENCODE), RED);
    expect(result.failed).toBe(true);
  });

  test(`${DECODER_SKIPS_REENCODE.name}: the byte-mutation property goes red`, async () => {
    const result = await fc.check(byteFuzz(SKIPS_REENCODE), RED);
    expect(result.failed).toBe(true);
  });

  test("the production decoder passes the same runs", async () => {
    const respelled = await fc.check(respellFuzz(PRODUCTION), RED);
    const bytes = await fc.check(byteFuzz(PRODUCTION), RED);
    expect(respelled.failed).toBe(false);
    expect(bytes.failed).toBe(false);
  });
});
