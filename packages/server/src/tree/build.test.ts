import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { type DocumentData, encodeJsonBytes, sha256Hex } from "@baerly/protocol";
import {
  BRANCH_WITHOUT_FANOUT_MAX,
  BUILD_MUTANTS,
  CHUNK_LEVEL_BYTE_STUCK,
  ISOLATION_EXCLUSIVE,
  type TreeMutant,
  UTF16_ID_ORDER,
} from "../../../../tests/fixtures/tree-mutants.ts";
import {
  TREE_SECOND_TEST_CHUNK_SALT,
  TREE_TEST_CHUNK_SALT,
  testChunkKey,
} from "../../../../tests/fixtures/tree-chunk-salt.ts";
import { buildCanonicalShape } from "../../../../tests/fixtures/tree-oracle-physical.ts";
import { compareDocIds } from "../snapshot-doc-id.ts";
import {
  buildTree,
  cutBranch,
  type PlannedChild,
  type PlannedNode,
  type PlannedTree,
  sealTree,
  singleLeafApplies,
} from "./build.ts";
import { type ChunkKey, chunkHash, importChunkKey } from "./chunk.ts";
import { TREE_MAX_LEVEL } from "./constants.ts";
import { createTreeConfig, TREE_LAYOUT, type TreeConfig, type TreeLayout } from "./layout.ts";
import { treeNodeKey } from "./key.ts";
import { canonicalDocument, type CanonicalDocument, decodeNode } from "./node-codec.ts";

const SMALL_LAYOUT: TreeLayout = {
  leafTargetBytes: 32,
  leafMinBytes: 16,
  leafMaxBytes: 48,
  leafIsolationDocumentBytes: 48,
  branchFanoutMin: 2,
  branchFanoutTarget: 2,
  branchFanoutMax: 3,
  singleLeafMaxBytes: 0,
  singleLeafMaxRows: 0,
};
const NO_DEPTH_ZERO: TreeLayout = { ...TREE_LAYOUT, singleLeafMaxBytes: 0, singleLeafMaxRows: 0 };
const SMALL = createTreeConfig({ layout: SMALL_LAYOUT });

/** The chunk keys the shape vectors are computed under. */
const KEYS: Readonly<Record<"test" | "second", ChunkKey>> = {
  test: await testChunkKey(),
  second: await importChunkKey(Uint8Array.fromHex(TREE_SECOND_TEST_CHUNK_SALT)),
};

const doc = (value: Record<string, unknown>): CanonicalDocument =>
  canonicalDocument(value, "test row");

/** `{"_id":id,"p":"x…x"}` padded to exactly `bytes` document bytes. */
const pad = (id: string, bytes: number): CanonicalDocument => {
  const base = encodeJsonBytes({ _id: id, p: "" }).byteLength;
  const padded = doc({ _id: id, p: "x".repeat(bytes - base) });
  expect(padded.bytes).toBe(bytes);
  return padded;
};

const idRows = (prefix: string, n: number): CanonicalDocument[] =>
  Array.from({ length: n }, (_, i) => doc({ _id: `${prefix}${i}` }));

const childNode = (child: PlannedChild): PlannedNode => {
  if (child.kind !== "fresh") {
    throw new Error("a built tree holds no reused child");
  }
  return child.node;
};

/** The identity-free shape S of a built tree. */
const shapeOf = (node: PlannedNode): unknown =>
  node.kind === "leaf"
    ? { level: 0, docs: node.docs.map((d) => d.doc) }
    : {
        level: node.level,
        children: node.children.map((child) => {
          const { lo, hi, rows, bytes } = childNode(child).summary;
          return { lo, hi, rows, bytes, node: shapeOf(childNode(child)) };
        }),
      };

const shapeDigest = (tree: PlannedTree | null): Promise<string> =>
  sha256Hex(encodeJsonBytes(tree === null ? null : shapeOf(tree.root)));

/** An `_id` as the spec's listings spell it: non-ASCII code points as `U+XXXX`. */
const spell = (id: string): string =>
  [...id]
    .map((c) =>
      c.codePointAt(0)! < 0x80 ? c : `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`,
    )
    .join("");

/** Each level's node ranges, from the leaves up. */
const levelRanges = (tree: PlannedTree | null): string[][] => {
  const levels: string[][] = [];
  let current = tree === null ? [] : [tree.root];
  while (current.length > 0) {
    levels.unshift(current.map((n) => `${spell(n.summary.lo)}..${spell(n.summary.hi)}`));
    current = current.flatMap((n) => (n.kind === "branch" ? n.children.map(childNode) : []));
  }
  return levels;
};

const leafSizes = (tree: PlannedTree): number[] => {
  const sizes: number[] = [];
  const walk = (n: PlannedNode): void => {
    if (n.kind === "leaf") {
      sizes.push(n.summary.bytes);
    } else {
      n.children.map(childNode).forEach(walk);
    }
  };
  walk(tree.root);
  return sizes;
};

// ---------------------------------------------------------------------
// Canonical-shape vectors, as data: swap the table to re-pin.
// ---------------------------------------------------------------------

interface ShapeVector {
  readonly name: string;
  readonly layout: TreeLayout;
  readonly salt?: keyof typeof KEYS;
  readonly rows: () => CanonicalDocument[];
  readonly digest: string;
  readonly levels?: readonly (readonly string[])[];
  readonly levelNodes?: readonly number[];
  readonly totals?: { readonly rows: number; readonly bytes: number };
  readonly leafSizes?: readonly number[];
  /** Mutants whose builder gives a documented wrong digest for these rows. */
  readonly counter?: readonly { readonly mutant: TreeMutant; readonly digest: string }[];
}

const dIds = (n: number) => `d${String(n).padStart(2, "0")}`;
const rIds = (n: number) =>
  Array.from({ length: n }, (_, i) => doc({ _id: `r${String(i).padStart(4, "0")}` }));

const SHAPE_VECTORS: readonly ShapeVector[] = [
  {
    name: "small scope, 20 rows k0..k19",
    layout: SMALL_LAYOUT,
    rows: () => idRows("k", 20),
    digest: "f43b12760f0d2a16ae046a80b1e649017c3af19be31bf7e9afc98da9db86dd7f",
    levels: [
      ["k0..k10", "k11..k13", "k14..k15", "k16..k19", "k2..k5", "k6..k8", "k9..k9"],
      ["k0..k15", "k16..k5", "k6..k9"],
      ["k0..k9"],
    ],
    levelNodes: [7, 3],
    totals: { rows: 20, bytes: 250 },
  },
  {
    name: "small scope, 20 rows less k13",
    layout: SMALL_LAYOUT,
    rows: () => idRows("k", 20).filter((d) => d.id !== "k13"),
    digest: "e39943f931ac7bc9360b9ae82de723dc27d1b97ca48d60969f46a759e6cb57e1",
    levels: [
      ["k0..k10", "k11..k14", "k15..k17", "k18..k19", "k2..k5", "k6..k8", "k9..k9"],
      ["k0..k14", "k15..k19", "k2..k8", "k9..k9"],
      ["k0..k19", "k2..k9"],
      ["k0..k9"],
    ],
    levelNodes: [7, 4, 2],
    totals: { rows: 19, bytes: 237 },
  },
  {
    name: "small scope, 20 rows under the depth-0 rule",
    layout: { ...SMALL_LAYOUT, singleLeafMaxBytes: 1000, singleLeafMaxRows: 20 },
    rows: () => idRows("k", 20),
    digest: "79f9181ff0a73719cac6ec777ff6e77e1e678b8aebf46247f744c9cadb965bc7",
    levels: [["k0..k9"]],
    levelNodes: [],
  },
  {
    name: "small scope, 20 rows under the second salt",
    layout: SMALL_LAYOUT,
    salt: "second",
    rows: () => idRows("k", 20),
    digest: "8b80dc94666ef3e29b9270d12e85d9c9141d0d30e6bef8cda671cdb70ecaa545",
    levels: [
      ["k0..k10", "k11..k12", "k13..k16", "k17..k2", "k3..k6", "k7..k9"],
      ["k0..k16", "k17..k6", "k7..k9"],
      ["k0..k9"],
    ],
    levelNodes: [6, 3],
    totals: { rows: 20, bytes: 250 },
  },
  {
    name: "small scope, 15 rows z0..z14",
    layout: SMALL_LAYOUT,
    rows: () => idRows("z", 15),
    digest: "27560c2fef0949810e03c5fac4d4b02b392fabb2edaadb4af38333eb403858e2",
    levels: [
      ["z0..z1", "z10..z11", "z12..z14", "z2..z3", "z4..z6", "z7..z8", "z9..z9"],
      ["z0..z11", "z12..z3", "z4..z8", "z9..z9"],
      ["z0..z8", "z9..z9"],
      ["z0..z9"],
    ],
    levelNodes: [7, 4, 2],
    totals: { rows: 15, bytes: 185 },
    counter: [
      {
        mutant: BRANCH_WITHOUT_FANOUT_MAX,
        digest: "686297a71b3ff13345b97ea549b08d37c26b1ec00818d34c869bfb576fd4c071",
      },
      {
        mutant: CHUNK_LEVEL_BYTE_STUCK,
        digest: "56ea333f727c2291dcaf80eb4188a6fec58eea3587110a6eda5235bdefd5086e",
      },
    ],
  },
  {
    name: "small scope, 10 rows in utf8-scalar-v1 order",
    layout: SMALL_LAYOUT,
    rows: () =>
      ["a", "b", "", "a", "�", "�a", "\u{10000}", "\u{10000}a", "\u{1F600}", "\u{1F600}a"].map(
        (id) => doc({ _id: id }),
      ),
    digest: "13b46715a21e6c47264c97c4732fbd78f2a2f9631826b1bfd00b0c28e8eb663f",
    levels: [
      ["a..U+E000a", "U+FFFD..U+FFFDa", "U+10000..U+1F600", "U+1F600a..U+1F600a"],
      ["a..U+FFFDa", "U+10000..U+1F600a"],
      ["a..U+1F600a"],
    ],
    levelNodes: [4, 2],
    totals: { rows: 10, bytes: 134 },
    counter: [
      {
        mutant: UTF16_ID_ORDER,
        digest: "a990648ccde0557b1f89cfc7d7e01f9836f80f3a5e571fa5a4892be0e6eba984",
      },
    ],
  },
  {
    name: "bytes = T",
    layout: TREE_LAYOUT,
    rows: () => Array.from({ length: 64 }, (_, i) => pad(dIds(i), 8192)),
    digest: "a2360f34a55ce14b53918d1caef5af46e433cb832bb53b5e027c88b2aabcc02a",
    levelNodes: [],
    totals: { rows: 64, bytes: 524_288 },
  },
  {
    name: "bytes = T + 1",
    layout: TREE_LAYOUT,
    rows: () => Array.from({ length: 64 }, (_, i) => pad(dIds(i), i === 63 ? 8193 : 8192)),
    digest: "f6ea461c74daa1bf7fd33312019c8dac908cbaa82fcd1a168dab5acafb44fb74",
    levelNodes: [26],
    totals: { rows: 64, bytes: 524_289 },
  },
  {
    name: "rows = T",
    layout: TREE_LAYOUT,
    rows: () => rIds(2048),
    digest: "a97d285bd259b7df3ab4776f87a8d844dfe1988037d143ae036aa35619a8b23f",
    levelNodes: [],
    totals: { rows: 2048, bytes: 30_720 },
  },
  {
    name: "rows = T + 1",
    layout: TREE_LAYOUT,
    rows: () => rIds(2049),
    digest: "37ee35d14e4268d8fcaaf50575b8a5a912d8948c51263d72145b4f8bcd4abd63",
    levelNodes: [3],
    leafSizes: [17_130, 13_335, 270],
  },
  {
    name: "one document over the byte limit is one root leaf",
    layout: TREE_LAYOUT,
    rows: () => [pad("big", 614_400)],
    digest: "5d445b0f733a758d029c0f00ec7a8d4e762dfdcd2367eee6106ff60f996e067a",
    levelNodes: [],
  },
  {
    name: "no isolation under the depth-0 rule",
    layout: TREE_LAYOUT,
    rows: () => [pad("a", 1000), pad("b", 30_000), pad("c", 1000)],
    digest: "fff6975f5b2dcb4b0c51f1dd61f99b0b4484b2c9028062c2a67cc48fa5a62185",
    levelNodes: [],
    totals: { rows: 3, bytes: 32_000 },
  },
  {
    name: "large-document isolation and the forced cut after the entry reaching leafMaxBytes",
    layout: NO_DEPTH_ZERO,
    rows: () => [
      pad("a", 1000),
      pad("b", 24_576),
      pad("c", 1000),
      pad("d", 24_575),
      pad("e", 1000),
    ],
    digest: "93e8518bed95d7dc427a168de984042380c4c49562ed9efe43897760ed95179c",
    levels: [["a..a", "b..b", "c..d", "e..e"], ["a..e"]],
    levelNodes: [4],
    leafSizes: [1000, 24_576, 25_575, 1000],
  },
  {
    name: "isolation threshold below leafMaxBytes",
    layout: { ...SMALL_LAYOUT, leafIsolationDocumentBytes: 34 },
    rows: () => [
      doc({ _id: "a" }),
      pad("b", 34),
      doc({ _id: "c" }),
      pad("d", 33),
      doc({ _id: "e" }),
      doc({ _id: "f" }),
    ],
    digest: "cf335919cf04f632fe1f1001c861613313ce6792d9e41319e437d7d483684414",
    levels: [["a..a", "b..b", "c..d", "e..f"], ["a..b", "c..f"], ["a..f"]],
    levelNodes: [4, 2],
    totals: { rows: 6, bytes: 111 },
    counter: [
      {
        mutant: ISOLATION_EXCLUSIVE,
        digest: "4171075934b5cad07fb89638ec2780e20a7b40d0a6dc465cb0537cb980542667",
      },
    ],
  },
];

const buildVector = (vector: ShapeVector, mutant?: TreeMutant): Promise<PlannedTree | null> =>
  buildTree(
    vector.rows(),
    KEYS[vector.salt ?? "test"],
    createTreeConfig({ layout: vector.layout, ...mutant?.options }),
  );

/** The vectors whose digest a builder under `mutant` does not reproduce. */
const failingVectors = async (mutant?: TreeMutant): Promise<string[]> => {
  const failing: string[] = [];
  for (const vector of SHAPE_VECTORS) {
    if ((await shapeDigest(await buildVector(vector, mutant))) !== vector.digest) {
      failing.push(vector.name);
    }
  }
  return failing;
};

describe("canonical-shape vectors", () => {
  test.each(SHAPE_VECTORS.map((v) => [v.name, v] as const))("%s", async (_name, vector) => {
    const tree = await buildVector(vector);
    if (vector.levels !== undefined) {
      expect(levelRanges(tree)).toEqual(vector.levels);
    }
    if (vector.levelNodes !== undefined) {
      expect(tree!.levelNodes).toEqual(vector.levelNodes);
      expect(tree!.root.level).toBe(vector.levelNodes.length);
    }
    if (vector.totals !== undefined) {
      expect(tree!.root.summary).toMatchObject(vector.totals);
    }
    if (vector.leafSizes !== undefined) {
      expect(leafSizes(tree!)).toEqual(vector.leafSizes);
    }
    await expect(shapeDigest(tree)).resolves.toBe(vector.digest);
  });

  test("the fanout-max cut alone closes the level-2 node z0..z8", async () => {
    // Entries ending z11, z3, z8: the first is below branchFanoutMin, and
    // the other two fail the level-2 hash test (≥ 2^31).
    await expect(chunkHash(KEYS.test, 2, "z3")).resolves.toBe(2_467_041_452);
    await expect(chunkHash(KEYS.test, 2, "z8")).resolves.toBe(3_185_800_401);
    // At level 1, z3 passes: a builder hashing level 2 as level 1 cuts there.
    await expect(chunkHash(KEYS.test, 1, "z3")).resolves.toBe(2_008_126_492);
  });

  describe("mutation", () => {
    const counters = SHAPE_VECTORS.flatMap((vector) =>
      (vector.counter ?? []).map(
        ({ mutant, digest }) =>
          [`${mutant.name} on ${vector.name}`, vector, mutant, digest] as const,
      ),
    );
    test.each(counters)(
      "%s gives the documented wrong digest",
      async (_n, vector, mutant, digest) => {
        await expect(shapeDigest(await buildVector(vector, mutant))).resolves.toBe(digest);
      },
    );

    test.each(BUILD_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
      "%s fails at least one vector",
      async (_name, mutant) => {
        const failing = await failingVectors(mutant);
        expect(failing.length).toBeGreaterThan(0);
      },
    );
  });
});

describe("branch cut predicate at the production layout", () => {
  const cases = [
    { count: 3, x: 134_217_727, cut: false },
    { count: 4, x: 134_217_727, cut: true },
    { count: 4, x: 134_217_728, cut: false },
    { count: 4, x: 4_294_967_295, cut: false },
    { count: 127, x: 4_294_967_295, cut: false },
    { count: 128, x: 4_294_967_295, cut: true },
  ];
  test.each(cases)("entry $count with hash $x cuts: $cut", ({ count, x, cut }) => {
    expect(cutBranch(count, x, TREE_LAYOUT)).toBe(cut);
  });

  test("under the test salt at level 1, entry 4 with hi k86 cuts and with hi a does not", async () => {
    expect(cutBranch(4, await chunkHash(KEYS.test, 1, "k86"), TREE_LAYOUT)).toBe(true);
    expect(cutBranch(4, await chunkHash(KEYS.test, 1, "a"), TREE_LAYOUT)).toBe(false);
  });
});

describe("depth-0 rule", () => {
  test("inclusive on both axes, and disabled by a 0 limit", () => {
    expect(singleLeafApplies(2048, 524_288, TREE_LAYOUT)).toBe(true);
    expect(singleLeafApplies(2049, 100, TREE_LAYOUT)).toBe(false);
    expect(singleLeafApplies(1, 524_289, TREE_LAYOUT)).toBe(false);
    expect(singleLeafApplies(1, 11, { ...TREE_LAYOUT, singleLeafMaxRows: 0 })).toBe(false);
    expect(singleLeafApplies(1, 11, { ...TREE_LAYOUT, singleLeafMaxBytes: 0 })).toBe(false);
  });
});

describe("build input", () => {
  test("no rows is no tree", async () => {
    await expect(buildTree([], KEYS.test, SMALL)).resolves.toBeNull();
    await expect(
      sealTree(null, {
        prefix: "app/a/tenant/t/manifests/c",
        attempt: "0".repeat(32),
        floor: 0,
      }),
    ).resolves.toEqual({ root: null, levels: [], reused: [] });
  });

  test("a duplicate _id is an Internal error", async () => {
    await expect(
      buildTree([doc({ _id: "a" }), doc({ _id: "a", n: 1 })], KEYS.test, SMALL),
    ).rejects.toMatchObject({ code: "Internal" });
  });

  test(`a tree of level ${TREE_MAX_LEVEL} builds, and one level more is an Internal error`, async () => {
    // One document per leaf and two entries per branch, so 2^16 leaves
    // reach exactly the top level and one leaf more needs another.
    const binary = createTreeConfig({
      layout: { ...SMALL_LAYOUT, branchFanoutMax: 2 },
      steps: { leafCut: () => true, chunkHash: () => Promise.resolve(0) },
    });
    const rows = Array.from({ length: 2 ** TREE_MAX_LEVEL + 1 }, (_, i) =>
      doc({ _id: `r${String(i).padStart(6, "0")}` }),
    );
    const top = await buildTree(rows.slice(0, -1), KEYS.test, binary);
    expect(top!.root.level).toBe(TREE_MAX_LEVEL);
    await expect(buildTree(rows, KEYS.test, binary)).rejects.toMatchObject({
      code: "Internal",
      message: expect.stringContaining(`exceed level ${TREE_MAX_LEVEL}`),
    });
  }, 30_000);
});

describe("independent oracle", () => {
  /** The physical oracle's canonical shape of `rows` under the test salt. */
  const oracleShape = (rows: readonly CanonicalDocument[], layout: TreeLayout) =>
    buildCanonicalShape(
      // The oracle takes plain rows; a canonical document is one, read-only.
      rows.map((row) => row.doc as DocumentData),
      layout,
      TREE_TEST_CHUNK_SALT,
    );

  const builtShape = async (rows: readonly CanonicalDocument[], config: TreeConfig) => {
    const plan = await buildTree(rows, KEYS.test, config);
    return plan === null ? null : shapeOf(plan.root);
  };

  fcTest.prop({ rows: smallRows })(
    "the built shape equals the physical oracle's at the small-scope layout",
    async ({ rows }) => {
      await expect(builtShape(rows, SMALL)).resolves.toEqual(oracleShape(rows, SMALL_LAYOUT));
    },
  );

  /** Rows at the production layout: sizes around the leaf bounds and past the isolation size. */
  const productionRows = fc
    .uniqueArray(
      fc.record({
        id: fc.stringMatching(/^[a-z0-9]{1,4}$/),
        bytes: fc.oneof(
          fc.integer({ min: 11, max: 2000 }),
          fc.integer({ min: 8000, max: 9000 }),
          fc.integer({ min: 24_000, max: 26_000 }),
        ),
      }),
      { selector: (r) => r.id, maxLength: 80 },
    )
    .map((rows) =>
      rows.map(({ id, bytes }) => {
        const base = encodeJsonBytes({ _id: id, p: "" }).byteLength;
        return doc(bytes <= base ? { _id: id } : { _id: id, p: "x".repeat(bytes - base) });
      }),
    );

  fcTest.prop({ rows: productionRows }, { numRuns: 30 })(
    "the built shape equals the physical oracle's at the production layout, with and without the depth-0 rule",
    async ({ rows }) => {
      for (const layout of [TREE_LAYOUT, NO_DEPTH_ZERO]) {
        await expect(builtShape(rows, createTreeConfig({ layout }))).resolves.toEqual(
          oracleShape(rows, layout),
        );
      }
    },
  );
});

// ---------------------------------------------------------------------
// Properties: canonical, identity-free, and every entry agrees with its child.
// ---------------------------------------------------------------------

const PREFIX = "app/helpdesk/tenant/acme/manifests/tickets";
const ATTEMPT_A = "00112233445566778899aabbccddeeff";
const ATTEMPT_B = "ffeeddccbbaa99887766554433221100";

/** Rows at the small-scope layout: short IDs, sizes from 11 bytes past the isolation size. */
const smallRows = fc
  .uniqueArray(
    fc.record({
      id: fc.stringMatching(/^[a-z0-9]{1,3}$/),
      pad: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60 })),
    }),
    { selector: (r) => r.id, maxLength: 40 },
  )
  .map((rows) =>
    rows.map(({ id, pad: n }) => doc(n === 0 ? { _id: id } : { _id: id, p: "x".repeat(n) })),
  );

/**
 * Publish `plan` into a key → bytes map and strictly decode every node
 * back from the root, routing each child by its parent entry. Returns the
 * number of nodes decoded at each level.
 */
const sealAndWalk = async (plan: PlannedTree | null, config: TreeConfig, attempt: string) => {
  const sealed = await sealTree(plan, { prefix: PREFIX, attempt, floor: 7 });
  const store = new Map<string, Uint8Array>();
  for (const level of sealed.levels) {
    for (const node of level) {
      expect(store.has(node.key)).toBe(false);
      store.set(node.key, node.bytes);
    }
  }
  const perLevel: number[] = [];
  const walk = async (key: string, expected: Parameters<typeof decodeNode>[2]): Promise<void> => {
    const node = await decodeNode(key, store.get(key) ?? null, expected, config);
    perLevel[node.node.level] = (perLevel[node.node.level] ?? 0) + 1;
    if (node.node.kind === "branch") {
      for (const entry of node.node.children) {
        // The context check proves the entry equals what the child's body yields.
        await walk(treeNodeKey(PREFIX, entry.attempt, entry.sha256), {
          prefix: PREFIX,
          root: false,
          level: node.node.level - 1,
          entry,
        });
      }
    }
  };
  if (sealed.root !== null) {
    await walk(sealed.root.key, { prefix: PREFIX, root: true, floor: 7 });
  }
  return { sealed, store, perLevel };
};

describe("sealed trees", () => {
  fcTest.prop({ rows: smallRows })(
    "every sealed entry equals its child's body, and the root's level counts are exact",
    async ({ rows }) => {
      const plan = await buildTree(rows, KEYS.test, SMALL);
      const { sealed, store, perLevel } = await sealAndWalk(plan, SMALL, ATTEMPT_A);
      // Every published node is reachable from the root, and nothing else is published.
      expect(perLevel.reduce((n, c) => n + c, 0)).toBe(store.size);
      expect(sealed.reused).toEqual([]);
      if (plan !== null) {
        expect(plan.levelNodes).toEqual(perLevel.slice(0, -1));
        // The root rule: every level below the root's children exceeds branchFanoutMax.
        for (const count of plan.levelNodes.slice(0, -1)) {
          expect(count).toBeGreaterThan(SMALL_LAYOUT.branchFanoutMax);
        }
        expect(plan.root.summary.rows).toBe(rows.length);
        expect(plan.root.summary.bytes).toBe(rows.reduce((n, d) => n + d.bytes, 0));
        // Parents come after their children: levels are listed from the leaves up.
        expect(sealed.levels.at(-1)!.at(-1)!.key).toBe(sealed.root!.key);
      }
    },
  );

  fcTest.prop({ rows: smallRows, order: fc.array(fc.nat()) })(
    "the shape depends only on the row set and the salt: not on input order or attempt identity",
    async ({ rows, order }) => {
      const shuffled = rows.toSorted(
        (a, b) =>
          (order[rows.indexOf(a)] ?? 0) - (order[rows.indexOf(b)] ?? 0) ||
          compareDocIds(a.id, b.id),
      );
      const plan = await buildTree(rows, KEYS.test, SMALL);
      const other = await buildTree(shuffled, KEYS.test, SMALL);
      const digest = await shapeDigest(plan);
      await expect(shapeDigest(other)).resolves.toBe(digest);
      const a = await sealTree(plan, { prefix: PREFIX, attempt: ATTEMPT_A, floor: 7 });
      const b = await sealTree(other, { prefix: PREFIX, attempt: ATTEMPT_B, floor: 7 });
      // Child refs hash bodies that carry the attempt, so mask them too.
      const text = (bytes: Uint8Array) =>
        new TextDecoder().decode(bytes).replaceAll(/"sha256":"[0-9a-f]{64}"/g, '"sha256":""');
      expect(a.levels.map((l) => l.length)).toEqual(b.levels.map((l) => l.length));
      // Bodies differ only in the attempt identity and the refs it changes.
      for (const [i, level] of a.levels.entries()) {
        for (const [j, node] of level.entries()) {
          expect(text(b.levels[i]![j]!.bytes)).toBe(
            text(node.bytes).replaceAll(ATTEMPT_A, ATTEMPT_B),
          );
        }
      }
    },
  );
});

describe("document key order", () => {
  test("a writer's key order survives build, encode and decode byte for byte", async () => {
    // Each body's key order differs from sorted order, with an own
    // __proto__ and a non-index numeric name. Only array-index names
    // move, because every JS object lists them first; `c` shows that.
    const written: [body: string, readBack: string][] = [
      ['{"z":1,"_id":"a","b":{"y":2,"x":[{"q":0,"p":1}]}}', ""],
      ['{"_id":"b","__proto__":{"m":1},"A":true,"01":"s"}', ""],
      ['{"n":"v","_id":"c","2":0,"10":1}', '{"2":0,"10":1,"n":"v","_id":"c"}'],
      ['{"_id":"d","é":1,"e":2}', ""],
    ];
    const rows = written.map(([body]) => doc(JSON.parse(body) as Record<string, unknown>));
    const expected = new Map(rows.map((row, i) => [row.id, written[i]![1] || written[i]![0]]));
    const plan = await buildTree(rows, KEYS.test, SMALL);
    expect(plan!.root.level).toBeGreaterThan(0);
    const { store } = await sealAndWalk(plan, SMALL, ATTEMPT_A);
    const decoded = new Map<string, string>();
    for (const [key, bytes] of store) {
      const node = await decodeNode(key, bytes, { prefix: PREFIX, root: "either" }, SMALL);
      if (node.node.kind === "leaf") {
        const body = new TextDecoder().decode(bytes);
        for (const d of node.node.docs) {
          const text = JSON.stringify(d);
          // The stored body holds the document's bytes verbatim.
          expect(body).toContain(text);
          decoded.set(d._id, text);
        }
      }
    }
    expect(decoded).toEqual(expected);
  });
});
