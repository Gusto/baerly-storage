/**
 * Qualifies the physical tree oracle (`tests/fixtures/tree-oracle-physical.ts`).
 *
 * Four layers: the oracle's order, ID domain and UTF-8 encoder agree with
 * the kernel's (`compareDocIds`, `assertSnapshotDocId`) and with the logical
 * oracle's comparator; the format's published vectors (order, salted chunk
 * hashes, the leaf and branch predicates, canonical encoding, node bodies,
 * canonical shape digests, root `level_nodes` and the counter-digests of
 * mutant builders) reproduce; every canonical tree the oracle builds and encodes
 * checks clean, and prefix-split folds agree; and a `mutation` block hands it
 * deliberately broken images and requires each one reported.
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import type { DocumentData, LogEntry } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { assertSnapshotDocId, compareDocIds } from "../../packages/server/src/snapshot-doc-id.ts";
import {
  docIdNearPairArb,
  invalidDocIdArb,
  validDocIdArb,
} from "../fixtures/scalar-doc-id-arbitraries.ts";
import { compareUtf8 } from "../fixtures/tree-oracle-logical.ts";
import {
  assembleAbove,
  assertOracleLayout,
  buildCanonicalShape,
  buildShapeWithOrder,
  canonDocument,
  canonicalJson,
  chunkHash,
  chunkMac,
  chunkPreimage,
  checkSplitEquivalence,
  checkTreeImage,
  compareIds,
  cutBranch,
  cutLeaf,
  decodeNodeBody,
  foldThroughSplits,
  idViolation,
  imageObject,
  type ImageObject,
  LEAF_MAX_BODY_BYTES,
  leafChunks,
  materializeTree,
  type OracleLayout,
  PRODUCTION_LAYOUT,
  type ShapeBranch,
  shapeBranch,
  shapeDigest,
  shapeLeaf,
  shapeLevels,
  type ShapeNode,
  sha256,
  TEST_CHUNK_SALT,
  TEST_LAYOUT,
  treeHead,
  type TreeImage,
  type TreeViolationKind,
  utf8Bytes,
} from "../fixtures/tree-oracle-physical.ts";

const P = "app/helpdesk/tenant/acme/manifests/tickets";
const A1 = "00112233445566778899aabbccddeeff";
const A2 = "ffeeddccbbaa99887766554433221100";
const A3 = "0123456789abcdef0123456789abcdef";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf16Order = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const codeOf = (action: () => void): string | undefined => {
  try {
    action();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? "not-a-BaerlyError";
  }
};

const SALT = TEST_CHUNK_SALT;
/** The second published salt, used only to show that the salt is a build input. */
const SALT2 = "0f0e0d0c0b0a09080706050403020100";

const canonical = (
  rows: Iterable<DocumentData>,
  layout: OracleLayout = PRODUCTION_LAYOUT,
  salt: string = SALT,
): ShapeNode | null => buildCanonicalShape(rows, layout, salt);

const NO_DEPTH_ZERO: OracleLayout = {
  ...PRODUCTION_LAYOUT,
  singleLeafMaxBytes: 0,
  singleLeafMaxRows: 0,
};

/** `{"_id":id,"p":"x…x"}` padded to exactly `n` document bytes. */
const pad = (id: string, n: number): DocumentData => {
  const base = utf8(JSON.stringify({ _id: id, p: "" })).byteLength;
  return { _id: id, p: "x".repeat(n - base) };
};

const leafDocs = (node: ShapeNode | undefined): readonly DocumentData[] => {
  if (node === undefined || !("docs" in node)) {
    throw new Error("expected a leaf");
  }
  return node.docs;
};

const bytesOf = (doc: DocumentData): number => utf8(JSON.stringify(doc)).byteLength;

const range = (node: ShapeNode): string => {
  const levels = shapeLevels(node);
  const leaves = levels[0]!;
  const first = leafDocs(leaves[0])[0]!["_id"];
  const last = leafDocs(leaves.at(-1)).at(-1)!["_id"];
  return `${String(first)}..${String(last)}`;
};

const hiOf = (node: ShapeNode): string =>
  "docs" in node ? (node.docs.at(-1)!["_id"] as string) : node.children.at(-1)!.hi;

const kindsOf = (input: Parameters<typeof checkTreeImage>[0]): TreeViolationKind[] =>
  [...new Set(checkTreeImage(input).violations.map((v) => v.kind))].toSorted();

const smallRows = (): DocumentData[] => Array.from({ length: 20 }, (_, i) => ({ _id: `k${i}` }));

// ── Order, ID domain and encoding agree with the kernel ────────────────────

describe("order and ID domain", () => {
  fcTest.prop({ a: validDocIdArb, b: validDocIdArb })(
    "compareIds agrees with compareDocIds and the logical oracle on valid IDs",
    ({ a, b }) => {
      expect(compareIds(a, b)).toBe(compareDocIds(a, b));
      expect(compareIds(a, b)).toBe(compareUtf8(a, b));
    },
  );

  fcTest.prop({ pair: docIdNearPairArb })(
    "compareIds agrees with compareDocIds on near pairs, including high BMP against astral",
    ({ pair }) => {
      expect(compareIds(pair.left, pair.right)).toBe(compareDocIds(pair.left, pair.right));
      expect(compareIds(pair.right, pair.left)).toBe(compareDocIds(pair.right, pair.left));
    },
  );

  test("utf8-scalar-v1 and UTF-16 order disagree on high BMP against astral", () => {
    expect(compareIds("\uFFFD", "\u{10000}")).toBe(-1);
    expect(utf16Order("\uFFFD", "\u{10000}")).toBe(1);
  });

  fcTest.prop({ text: fc.string({ unit: "binary", maxLength: 40 }) })(
    "the hand-written UTF-8 encoder matches TextEncoder on well-formed strings",
    ({ text }) => {
      expect(hex(utf8Bytes(text))).toBe(hex(utf8(text)));
    },
  );

  fcTest.prop({ id: validDocIdArb })(
    "idViolation accepts what assertSnapshotDocId accepts",
    ({ id }) => {
      expect(codeOf(() => assertSnapshotDocId(id))).toBeUndefined();
      expect(idViolation(id)).toBeUndefined();
    },
  );

  fcTest.prop({ bad: invalidDocIdArb })(
    "idViolation refuses what assertSnapshotDocId refuses",
    ({ bad }) => {
      expect(codeOf(() => assertSnapshotDocId(bad.id))).toBe("InvalidConfig");
      expect(idViolation(bad.id)).toBeDefined();
    },
  );
});

// ── Order and chunk hash vectors ──────────────────────────────────────────────

describe("order and chunk hash vectors", () => {
  // Every row, in utf8-scalar-v1 order, with h(0), h(1) and h(2) under the test salt.
  const ORDERED: readonly [string, string, number, number, number][] = [
    ["A", "41", 2_186_594_711, 612_995_553, 4_006_487_808],
    ["a", "61", 998_623_582, 2_432_698_559, 2_303_573_675],
    ["aa", "6161", 2_504_164_148, 1_367_151_728, 2_556_938_342],
    ["e\u0301", "65cc81", 1_610_538_917, 1_206_855_749, 2_384_825_335],
    ["k114", "6b313134", 3_856_501_626, 717_490_590, 834_240_657],
    ["k28", "6b3238", 3_921_834_230, 2_934_518_490, 3_347_102_748],
    ["k64", "6b3634", 1_916_860_981, 1_349_846_763, 9_027_239],
    ["k86", "6b3836", 1_502_870_839, 56_268_758, 2_783_355_651],
    ["\u00e9", "c3a9", 1_695_343_356, 330_672_603, 1_016_554_246],
    ["\uFFFD", "efbfbd", 3_806_434_237, 1_677_774_835, 122_783_941],
    ["\u{10000}", "f0908080", 1_540_892_862, 1_649_052_381, 2_131_086_830],
    ["\u{1F600}", "f09f9880", 2_257_443_205, 2_220_118_664, 1_414_563_498],
  ];

  test.each(ORDERED)("%j: UTF-8 %s, h(0) %i, h(1) %i, h(2) %i", (id, utf8Hex, h0, h1, h2) => {
    expect(hex(utf8Bytes(id))).toBe(utf8Hex);
    expect(chunkHash(SALT, 0, id)).toBe(h0);
    expect(chunkHash(SALT, 1, id)).toBe(h1);
    expect(chunkHash(SALT, 2, id)).toBe(h2);
  });

  test("only k86 passes 2^27 at level 1, and only k64 and U+FFFD at level 2", () => {
    const pass = (level: number) =>
      ORDERED.filter(([id]) => chunkHash(SALT, level, id) < 2 ** 27).map(([id]) => id);
    expect(pass(1)).toEqual(["k86"]);
    expect(pass(2)).toEqual(["k64", "\uFFFD"]);
  });

  test("all twelve hash rows are listed in utf8-scalar-v1 order", () => {
    const ids = ORDERED.map(([id]) => id);
    expect(ids).toHaveLength(12);
    expect(ids.toSorted(compareIds)).toEqual(ids);
    expect(ids.toSorted(utf16Order)).not.toEqual(ids);
  });

  test("h(1, a) has the published HMAC message and MAC under the test salt", () => {
    expect(hex(chunkPreimage(1, "a"))).toBe("626165726c792d747265652d6368756e6b2d7632000161");
    const mac = hex(chunkMac(SALT, 1, "a"));
    expect(mac).toBe("910008bfa7c49e01573b50be5257b4596077b80cf688ffb3857ab633bc792ef5");
    expect(chunkHash(SALT, 1, "a")).toBe(Number.parseInt(mac.slice(0, 8), 16));
  });

  test("the salt is a hash input", () => {
    expect(chunkHash(SALT2, 1, "a")).not.toBe(chunkHash(SALT, 1, "a"));
    expect(() => chunkHash("00", 1, "a")).toThrow(/chunk salt/);
  });

  test("an isolated high surrogate is not an ID", () => {
    expect(idViolation("\uD800")).toBe("unpaired surrogate");
  });
});

// ── Leaf predicate vectors ─────────────────────────────────────────────────

describe("leaf predicate vectors at the production layout", () => {
  test.each([
    [16_000, 16_500, 194_486_616, true],
    [16_000, 16_500, 3_384_161_199, false],
    // a = max(p, Lmin), not a = Lmin, when p > Lmin: with a = Lmin this row cuts.
    [16_000, 16_500, 869_113_755, false],
    [8_100, 8_400, 194_486_616, false],
    [24_000, 24_576, 4_294_967_295, true],
    [7_000, 8_192, 0, false],
    [8_192, 8_193, 262_143, true],
    [8_192, 8_193, 262_144, false],
    // a = max(p, Lmin), not a = p: with a = p this row cuts.
    [0, 9_000, 869_113_755, false],
  ])("cutLeaf(p %i, s %i, x %i) is %s", (p, s, x, cut) => {
    expect(cutLeaf(PRODUCTION_LAYOUT, p, s, x)).toBe(cut);
  });
});

describe("branch predicate at the production layout (Fmin 4, Ft 32, Fmax 128)", () => {
  test.each([
    [3, 134_217_727, false, "a hash cut below Fmin"],
    [4, 134_217_727, true, "Fmin met and the hash passes"],
    [4, 134_217_728, false, "the threshold is strict"],
    [4, 4_294_967_295, false, "Fmin met, the hash fails"],
    [127, 4_294_967_295, false, "one short of Fmax, the hash fails"],
    [128, 4_294_967_295, true, "forced at Fmax whatever the hash"],
  ] as const)("cutBranch(count %i, x %i) is %s: %s", (count, x, cut, _why) => {
    expect(cutBranch(PRODUCTION_LAYOUT, count, x)).toBe(cut);
  });

  test("at level 1 under the test salt, count 4 cuts after k86 and not after a", () => {
    expect(cutBranch(PRODUCTION_LAYOUT, 4, chunkHash(SALT, 1, "k86"))).toBe(true);
    expect(cutBranch(PRODUCTION_LAYOUT, 4, chunkHash(SALT, 1, "a"))).toBe(false);
  });
});

// ── Canonical encoding and node body vectors ───────────────────────────────

describe("canonical encoding and node body vectors", () => {
  test("mixed keys canonicalize to array indices, then insertion order (62 bytes)", () => {
    const got = canonDocument(
      JSON.parse('{"b":1,"_id":"x","A":[true,{"z":"é","y":2.50}],"10":0,"2":"n"}'),
    );
    expect("invalid" in got).toBe(false);
    const doc = got as Exclude<typeof got, { invalid: string }>;
    expect(JSON.stringify(doc.doc)).toBe(
      '{"2":"n","10":0,"b":1,"_id":"x","A":[true,{"z":"é","y":2.5}]}',
    );
    expect(doc.bytes).toBe(62);
    expect(sha256(utf8(JSON.stringify(doc.doc)))).toBe(
      "e4b799c033a27ea3134bbe00fad2d5d398cc28c631d8e10156b543c75ab651fc",
    );
  });

  test("key-order edge: 4294967295 is not an array index, and other keys keep insertion order", () => {
    const value: Record<string, number> = {};
    const inserted = ["b", "4294967295", "4294967294", "01", "10", "9", "-1", "__proto__"];
    for (const key of [...inserted, "\uFFFF", "\u{1F600}", "\u00e9"]) {
      Object.defineProperty(value, key, {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const text = canonicalJson(value);
    expect(text).toBe(
      '{"9":1,"10":1,"4294967294":1,"b":1,"4294967295":1,"01":1,"-1":1,"__proto__":1,"\uFFFF":1,"\u{1F600}":1,"\u00e9":1}',
    );
    // JSON.stringify writes U+FFFF raw, as the bytes EF BF BF.
    const bytes = utf8(text);
    expect(hex(bytes.slice(-23, -20))).toBe("efbfbf");
    expect(bytes.byteLength).toBe(102);
    expect(sha256(bytes)).toBe("dfae1ae1d4a8faa24de23b27130d5123f5642e1a086b8167bab3ece62403ed50");
  });

  const withAccessor = (target: object, key: string): object =>
    Object.defineProperty(target, key, { get: () => 1, enumerable: true });
  const holey = (): unknown[] => {
    const a: unknown[] = [1, 2];
    delete a[0];
    return a;
  };
  class SubArray extends Array<unknown> {}

  test.each([
    ["a symbol-keyed property", () => ({ _id: "x", [Symbol("s")]: 1 }), "symbol key"],
    [
      "a non-enumerable property",
      () => Object.defineProperty({ _id: "x" }, "h", { value: 1, enumerable: false }),
      "non-enumerable",
    ],
    ["an accessor property", () => withAccessor({ _id: "x" }, "g"), "accessor key"],
    ["an array hole", () => ({ _id: "x", a: holey() }), "array hole"],
    [
      "an accessor array element",
      () => ({ _id: "x", a: withAccessor([1, 2], "1") }),
      "accessor element",
    ],
    [
      "an array with another prototype",
      () => ({ _id: "x", a: SubArray.from([1]) }),
      "exotic array",
    ],
    [
      "a named own array property",
      () => ({ _id: "x", a: Object.assign([1], { extra: 2 }) }),
      "extra own array property extra",
    ],
    [
      "a symbol-keyed own array property",
      () => ({ _id: "x", a: Object.assign([1], { [Symbol("s")]: 2 }) }),
      "extra own array property Symbol(s)",
    ],
    [
      "an own array property named 4294967295 (not an index)",
      () => ({ _id: "x", a: Object.assign([1], { "4294967295": 2 }) }),
      "extra own array property 4294967295",
    ],
    [
      "an own array property named 4294967296",
      () => ({ _id: "x", a: Object.assign([1], { "4294967296": 2 }) }),
      "extra own array property 4294967296",
    ],
  ] as const)("canon rejects, never drops, %s", (_, make, reason) => {
    const got = canonDocument(make());
    expect(got).toEqual({ invalid: expect.stringContaining(reason) });
  });

  const nested = (containers: number): DocumentData => {
    // The document is the first container; the rest are nested arrays.
    let value: unknown = 1;
    for (let i = 1; i < containers; i++) {
      value = [value];
    }
    return { _id: "x", a: value } as DocumentData;
  };

  test("a document of 100 nested containers is valid, 101 is refused", () => {
    expect("invalid" in canonDocument(nested(100))).toBe(false);
    expect(canonDocument(nested(101))).toEqual({
      invalid: expect.stringContaining("nests deeper than 100"),
    });
  });

  const leafAB: ShapeNode = shapeLeaf([
    { _id: "a", n: 1 },
    { _id: "b", n: 2 },
  ]);

  test("leaf body, its key, and the root leaf body", () => {
    const branchHolder = shapeBranch(1, [leafAB, shapeLeaf([{ _id: "c", n: 3 }])]);
    const { image } = materializeTree(branchHolder, {
      prefix: P,
      floor: 7,
      attempt: (path) => (path[0] === 1 ? A2 : A1),
    });
    const leafKey = `${P}/_v99/n/${A1}/fbf6a6386499e42c43fec71fb62476ba684391288cc343204b8552dcc394ff61`;
    const leaf = image.get(leafKey);
    expect(leaf).toBeDefined();
    expect(new TextDecoder().decode(leaf!.bytes)).toBe(
      '{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"00112233445566778899aabbccddeeff","level":0,"docs":[{"_id":"a","n":1},{"_id":"b","n":2}]}',
    );
    expect(leaf!.bytes.byteLength).toBe(177);
    expect(bytesOf({ _id: "a", n: 1 })).toBe(17);
    expect(
      image.has(
        `${P}/_v99/n/${A2}/0d37618565dca7d59d0777cace6c3c84e5e21d417e67afd90aa78ecc85c6fe8b`,
      ),
    ).toBe(true);

    const root = image.get(
      `${P}/_v99/n/${A1}/fdcb2c51461ba581b2e669e79124d743eb33115e053574ecf805b9c1d1c96b72`,
    );
    expect(root?.bytes.byteLength).toBe(515);
    expect(new TextDecoder().decode(root!.bytes)).toContain(
      '"floor":7,"rows":3,"bytes":51,"level_nodes":[2],"children":[',
    );

    const rootLeaf = materializeTree(leafAB, { prefix: P, floor: 7, attempt: A1 });
    expect(rootLeaf.rootKey).toBe(
      `${P}/_v99/n/${A1}/32bf9f0fc5b580449b1a4b82b5b9ac81ccdbc64b463074cc0242fa91b5266e28`,
    );
    expect(rootLeaf.image.get(rootLeaf.rootKey!)!.bytes.byteLength).toBe(207);
  });

  test("the positive bodies decode cleanly in their routed roles", () => {
    const tree = shapeBranch(1, [leafAB, shapeLeaf([{ _id: "c", n: 3 }])]);
    const { image, rootKey } = materializeTree(tree, {
      prefix: P,
      floor: 7,
      attempt: (path) => (path[0] === 1 ? A2 : A1),
    });
    expect(
      rootKey!.endsWith("fdcb2c51461ba581b2e669e79124d743eb33115e053574ecf805b9c1d1c96b72"),
    ).toBe(true);
    const report = checkTreeImage({ image, prefix: P, layout: NO_DEPTH_ZERO, expectedFloor: 7 });
    // The bodies are valid. The shape is a codec vector, not a canonical tree:
    // [a, b] holds 34 bytes, under Lmin, so the chunking rule never cuts it.
    expect([...new Set(report.violations.map((v) => v.kind))].toSorted()).toEqual([
      "non-canonical-root",
      "unexpected-cut",
    ]);
    expect(report.rows.map((r) => r["_id"])).toEqual(["a", "b", "c"]);
  });

  test("a root branch whose level_nodes disagree with its children fails the structure check", () => {
    const tree = shapeBranch(1, [leafAB, shapeLeaf([{ _id: "c", n: 3 }])]);
    const { image, rootKey } = materializeTree(tree, {
      prefix: P,
      floor: 7,
      attempt: (path) => (path[0] === 1 ? A2 : A1),
    });
    const text = new TextDecoder().decode(image.get(rootKey!)!.bytes);
    const bytes = utf8(text.replace('"level_nodes":[2]', '"level_nodes":[3]'));
    expect(bytes.byteLength).toBe(515);
    const digest = sha256(bytes);
    expect(digest).toBe("8295b5a20965b4a2615170afffe20b0d1030570fec8f22a4eb029c5166888ac1");
    const got = decodeNodeBody(P, `${P}/_v99/n/${A1}/${digest}`, bytes, { root: true });
    expect(got.violations.map((v) => [v.kind, v.check])).toEqual([["body-structure", "structure"]]);
    expect(got.violations[0]!.message).toContain("structure check failed");
  });

  const BASELINE =
    '{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"00112233445566778899aabbccddeeff","level":0,"docs":[{"_id":"a","n":1}]}';

  test("the negative-case baseline is a valid 159-byte leaf", () => {
    const bytes = utf8(BASELINE);
    expect(bytes.byteLength).toBe(159);
    expect(sha256(bytes)).toBe("017f46506c2ad7987bbc810a2389ad66632a4581d38e50fa5a01fcd49b2abe26");
    const got = decodeNodeBody(P, `${P}/_v99/n/${A1}/${sha256(bytes)}`, bytes, {
      root: false,
    });
    expect(got.violations).toEqual([]);
    expect(got.node).toBeDefined();
  });

  test.each([
    [
      "2.50",
      utf8(BASELINE.replace('"n":1}', '"n":2.50}')),
      "75ea8f0db136f1aba9a5352033418a5413928a79026728198dbaecb1cf1ece61",
      "body-non-canonical",
      "canonical-bytes",
    ],
    [
      "-0",
      utf8(BASELINE.replace('"n":1}', '"n":-0}')),
      "95e94e1134476ba64b7698251a9ea102e22eeb6de14ee7c15bc0cd340b186f28",
      "body-non-canonical",
      "canonical-bytes",
    ],
    [
      "duplicate member",
      utf8(BASELINE.replace('"n":1}', '"n":1,"n":1}')),
      "76c652da601c61fe945a2dae1215e01fe16543b39ac373cd8db6164109b67e76",
      "body-non-canonical",
      "canonical-bytes",
    ],
    [
      "swapped field order",
      utf8(
        BASELINE.replace(
          '"format":"baerly-tree-node-proto","schema_version":1',
          '"schema_version":1,"format":"baerly-tree-node-proto"',
        ),
      ),
      "7ef050349ac036ceac55e94cf601eb9a64925157058fbc65ab7d17b7547ecb59",
      "body-structure",
      "structure",
    ],
    [
      "BOM",
      Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(BASELINE)]),
      "afad24228321edc6647842f776270518a04bbd621305a7b064778cc98d8e7d36",
      "body-json",
      "json",
    ],
  ] as const)(
    "negative body %s has the published hash and fails at its step",
    (_, bytes, digest, kind, check) => {
      expect(sha256(bytes)).toBe(digest);
      const got = decodeNodeBody(P, `${P}/_v99/n/${A1}/${digest}`, bytes, {
        root: false,
      });
      expect(got.node).toBeUndefined();
      expect(got.violations.map((v) => [v.kind, v.check])).toEqual([[kind, check]]);
      expect(got.violations[0]!.message).toContain(`${check} check failed`);
    },
  );

  const baseline = utf8(BASELINE);
  const keyFor = (bytes: Uint8Array): string => `${P}/_v99/n/${A1}/${sha256(bytes)}`;
  const branchBody = (trailing: string): Uint8Array =>
    utf8(
      `{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"${A1}","level":1,"children":[{"lo":"a","hi":"a","rows":1,"bytes":17,"attempt":"${A1}","sha256":"${sha256(baseline)}"}]}${trailing}`,
    );
  const overLeafCeiling = new Uint8Array(LEAF_MAX_BODY_BYTES + 1).fill(0x20);
  const overBranchCeiling = branchBody(" ".repeat(524_288));
  const badUtf8 = Uint8Array.from([0xff]);
  test.each([
    ["key", "key-grammar", `${P}/_v99/n/${A1.toUpperCase()}/${sha256(baseline)}`, baseline, {}],
    ["present", "missing-node", keyFor(baseline), undefined, {}],
    ["leaf-ceiling", "body-ceiling", keyFor(overLeafCeiling), overLeafCeiling, {}],
    ["hash", "hash-mismatch", `${P}/_v99/n/${A1}/${"0".repeat(64)}`, baseline, {}],
    ["utf-8", "body-utf8", keyFor(badUtf8), badUtf8, {}],
    ["structure", "body-ceiling", keyFor(overBranchCeiling), overBranchCeiling, {}],
    ["context", "level", keyFor(baseline), baseline, { level: 1 }],
    [
      "context",
      "entry-mismatch",
      keyFor(baseline),
      baseline,
      { entry: { lo: "a", hi: "a", rows: 2, bytes: 17 } },
    ],
  ] as const)("the %s check tags its failure (%s)", (check, kind, key, bytes, extra) => {
    const got = decodeNodeBody(P, key, bytes, { root: false, ...extra });
    expect(got.violations.map((v) => [v.kind, v.check])).toEqual([[kind, check]]);
    expect(got.violations[0]!.message).toContain(`${check} check failed`);
  });

  test("a branch body under its ceiling decodes; the branch ceiling is part of the structure check", () => {
    const bytes = branchBody(" ".repeat(1000));
    // Under the ceiling, the trailing whitespace fails only the canonical-bytes check.
    expect(decodeNodeBody(P, keyFor(bytes), bytes, { root: false }).violations[0]!.check).toBe(
      "canonical-bytes",
    );
    const clean = branchBody("");
    expect(decodeNodeBody(P, keyFor(clean), clean, { root: false }).violations).toEqual([]);
  });

  test("a prefix without a valid collection segment is oracle misuse", () => {
    for (const prefix of [
      "app/helpdesk/tenant/acme/manifests/",
      "app/helpdesk/tenant/acme/manifests/..",
    ]) {
      expect(() => decodeNodeBody(prefix, keyFor(baseline), baseline, { root: false })).toThrow(
        /no valid collection segment/,
      );
    }
  });

  test("a layout with any field beyond the nine is refused", () => {
    expect(() => assertOracleLayout(PRODUCTION_LAYOUT)).not.toThrow();
    expect(() =>
      assertOracleLayout({ ...PRODUCTION_LAYOUT, leafMaxBodyBytes: 1 } as OracleLayout),
    ).toThrow(/invalid layout/);
    const { branchFanoutMax: _, ...missing } = PRODUCTION_LAYOUT;
    expect(() => assertOracleLayout(missing as OracleLayout)).toThrow(/invalid layout/);
  });
});

// ── Canonical shape vectors ────────────────────────────────────────────────

describe("canonical shape vectors", () => {
  /** An ID as the vectors spell it: ASCII as is, anything else as U+XXXX. */
  const label = (id: string): string =>
    [...id]
      .map((c) => {
        const cp = c.codePointAt(0)!;
        return cp < 0x80 ? c : `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      })
      .join("");
  const levelRanges = (root: ShapeNode | null): string[] =>
    shapeLevels(root).map((nodes) =>
      nodes
        .map((node) => {
          const [first, last] = range(node).split("..");
          return `${label(first!)}..${label(last!)}`;
        })
        .join("  "),
    );

  const expectClean = (
    shape: ShapeNode | null,
    layout: OracleLayout,
    rows: readonly DocumentData[],
    chunkSalt: string = SALT,
  ) => {
    const { image, rootKey } = materializeTree(shape, {
      prefix: P,
      floor: 3,
      attempt: A1,
      chunkSalt,
    });
    const report = checkTreeImage({
      image,
      prefix: P,
      layout,
      expectedRows: rows,
      expectedFloor: 3,
    });
    expect(report.violations).toEqual([]);
    const root = JSON.parse(new TextDecoder().decode(image.get(rootKey!)!.bytes));
    return { report, levelNodes: root.level_nodes as number[] | undefined };
  };

  /**
   * The canonical branch stacking with two seams for mutant builders: the
   * `Fmax` forced cut can be dropped (the root rule is kept), and the level
   * octet the branch hash reads can be replaced.
   */
  const assembleWith = (
    nodes: readonly ShapeNode[],
    layout: OracleLayout,
    seams: { readonly fmax: boolean; readonly hashLevel: (level: number) => number },
  ): ShapeNode => {
    let level = 0;
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
        const x = chunkHash(SALT, seams.hashLevel(level), hiOf(node));
        const forced = seams.fmax && group.length === layout.branchFanoutMax;
        if (
          forced ||
          (group.length >= layout.branchFanoutMin && x < 2 ** 32 / layout.branchFanoutTarget)
        ) {
          groups.push(group);
          group = [];
        }
      }
      if (group.length > 0) {
        groups.push(group);
      }
      current = groups.map((g) => shapeBranch(level, g));
    }
    return current[0]!;
  };
  const canonicalSeams = { fmax: true, hashLevel: (level: number) => level };

  const kRows = (n: number): DocumentData[] =>
    Array.from({ length: n }, (_, i) => ({ _id: `k${i}` }));
  const zRows = (): DocumentData[] => Array.from({ length: 15 }, (_, i) => ({ _id: `z${i}` }));

  test("test layout, 20 rows: depth 2 with the published ranges, digest and counts", () => {
    const rows = kRows(20);
    expect(rows.reduce((n, r) => n + bytesOf(r), 0)).toBe(250);
    const shape = canonical(rows, TEST_LAYOUT);
    expect(levelRanges(shape)).toEqual([
      "k0..k10  k11..k13  k14..k15  k16..k19  k2..k5  k6..k8  k9..k9",
      "k0..k15  k16..k5  k6..k9",
      "k0..k9",
    ]);
    expect(shapeDigest(shape)).toBe(
      "f43b12760f0d2a16ae046a80b1e649017c3af19be31bf7e9afc98da9db86dd7f",
    );
    const { report, levelNodes } = expectClean(shape, TEST_LAYOUT, rows);
    expect(report.depth).toBe(2);
    expect(levelNodes).toEqual([7, 3]);
    // The canonical seams reproduce the canonical build.
    expect(shapeDigest(assembleWith(shapeLevels(shape)[0]!, TEST_LAYOUT, canonicalSeams))).toBe(
      shapeDigest(shape),
    );
  });

  test("test layout, delete k13: the leaf cuts after k10 move and the tree gets one level deeper", () => {
    const rows = kRows(20).filter((r) => r["_id"] !== "k13");
    expect(rows.reduce((n, r) => n + bytesOf(r), 0)).toBe(237);
    const shape = canonical(rows, TEST_LAYOUT);
    expect(levelRanges(shape)).toEqual([
      "k0..k10  k11..k14  k15..k17  k18..k19  k2..k5  k6..k8  k9..k9",
      "k0..k14  k15..k19  k2..k8  k9..k9",
      "k0..k19  k2..k9",
      "k0..k9",
    ]);
    expect(shapeDigest(shape)).toBe(
      "e39943f931ac7bc9360b9ae82de723dc27d1b97ca48d60969f46a759e6cb57e1",
    );
    expect(expectClean(shape, TEST_LAYOUT, rows).levelNodes).toEqual([7, 4, 2]);
  });

  test("test layout with single-leaf limits 1000 bytes / 20 rows: one root leaf", () => {
    const layout = { ...TEST_LAYOUT, singleLeafMaxBytes: 1000, singleLeafMaxRows: 20 };
    for (const salt of [SALT, SALT2]) {
      const shape = canonical(kRows(20), layout, salt);
      expect(shape!.level).toBe(0);
      expect(shapeDigest(shape)).toBe(
        "79f9181ff0a73719cac6ec777ff6e77e1e678b8aebf46247f744c9cadb965bc7",
      );
      expect(expectClean(shape, layout, kRows(20), salt).levelNodes).toBeUndefined();
    }
  });

  test("the salt is an input: the same 20 rows under the second salt", () => {
    const shape = canonical(kRows(20), TEST_LAYOUT, SALT2);
    expect(levelRanges(shape)).toEqual([
      "k0..k10  k11..k12  k13..k16  k17..k2  k3..k6  k7..k9",
      "k0..k16  k17..k6  k7..k9",
      "k0..k9",
    ]);
    expect(shapeDigest(shape)).toBe(
      "8b80dc94666ef3e29b9270d12e85d9c9141d0d30e6bef8cda671cdb70ecaa545",
    );
    expect(expectClean(shape, TEST_LAYOUT, kRows(20), SALT2).levelNodes).toEqual([6, 3]);
  });

  test("test layout, 15 rows: a branch cut forced at Fmax, and level-2 cuts that read byte(2)", () => {
    const rows = zRows();
    expect(rows.reduce((n, r) => n + bytesOf(r), 0)).toBe(185);
    const shape = canonical(rows, TEST_LAYOUT);
    expect(levelRanges(shape)).toEqual([
      "z0..z1  z10..z11  z12..z14  z2..z3  z4..z6  z7..z8  z9..z9",
      "z0..z11  z12..z3  z4..z8  z9..z9",
      "z0..z8  z9..z9",
      "z0..z9",
    ]);
    expect(shapeDigest(shape)).toBe(
      "27560c2fef0949810e03c5fac4d4b02b392fabb2edaadb4af38333eb403858e2",
    );
    const { report, levelNodes } = expectClean(shape, TEST_LAYOUT, rows);
    expect(report.depth).toBe(3);
    expect(levelNodes).toEqual([7, 4, 2]);
    // z0..z8 closes on c = Fmax alone: z3 and z8 fail h(2) < 2^31.
    expect([chunkHash(SALT, 2, "z3"), chunkHash(SALT, 2, "z8")]).toEqual([
      2_467_041_452, 3_185_800_401,
    ]);
    expect(chunkHash(SALT, 1, "z3")).toBe(2_008_126_492);

    const leaves = shapeLevels(shape)[0]!;
    const noFmax = assembleWith(leaves, TEST_LAYOUT, { ...canonicalSeams, fmax: false });
    expect(noFmax.level).toBe(2);
    expect(shapeDigest(noFmax)).toBe(
      "686297a71b3ff13345b97ea549b08d37c26b1ec00818d34c869bfb576fd4c071",
    );
    const stuck = assembleWith(leaves, TEST_LAYOUT, { ...canonicalSeams, hashLevel: () => 1 });
    expect(levelRanges(stuck)[2]).toBe("z0..z3  z4..z9");
    expect(shapeDigest(stuck)).toBe(
      "56ea333f727c2291dcaf80eb4188a6fec58eea3587110a6eda5235bdefd5086e",
    );
    for (const bad of [noFmax, stuck]) {
      const { image } = materializeTree(bad, { prefix: P, floor: 3, attempt: A1 });
      expect(kindsOf({ image, prefix: P, layout: TEST_LAYOUT, expectedRows: rows })).toContain(
        "non-canonical-root",
      );
    }
  });

  const orderRows = (): DocumentData[] =>
    ["a", "b", "", "�", "\u{10000}", "\u{1F600}"]
      .flatMap((id) => (id.length === 1 && id < "c" ? [id] : [id, `${id}a`]))
      .map((id) => ({ _id: id }));

  test("test layout, 10 rows: utf8-scalar-v1 against UTF-16 order", () => {
    const rows = orderRows();
    expect(rows).toHaveLength(10);
    expect(rows.reduce((n, r) => n + bytesOf(r), 0)).toBe(134);
    const shape = canonical(rows, TEST_LAYOUT);
    expect(levelRanges(shape)).toEqual([
      "a..U+E000a  U+FFFD..U+FFFDa  U+10000..U+1F600  U+1F600a..U+1F600a",
      "a..U+FFFDa  U+10000..U+1F600a",
      "a..U+1F600a",
    ]);
    expect(shapeDigest(shape)).toBe(
      "13b46715a21e6c47264c97c4732fbd78f2a2f9631826b1bfd00b0c28e8eb663f",
    );
    expect(expectClean(shape, TEST_LAYOUT, rows).levelNodes).toEqual([4, 2]);

    const utf16 = buildShapeWithOrder(rows, TEST_LAYOUT, SALT, utf16Order);
    expect(levelRanges(utf16)[0]).toBe(
      "a..U+10000  U+10000a..U+1F600a  U+E000..U+E000a  U+FFFD..U+FFFDa",
    );
    expect(shapeDigest(utf16)).toBe(
      "a990648ccde0557b1f89cfc7d7e01f9836f80f3a5e571fa5a4892be0e6eba984",
    );
  });

  const bytesT = (): DocumentData[] =>
    Array.from({ length: 64 }, (_, i) => pad(`d${String(i).padStart(2, "0")}`, 8192));
  const bytesT1 = (): DocumentData[] => [...bytesT().slice(0, 63), pad("d63", 8193)];
  const rowsN = (n: number): DocumentData[] =>
    Array.from({ length: n }, (_, i) => ({ _id: `r${String(i).padStart(4, "0")}` }));
  const noIsolationRows = (): DocumentData[] => [pad("a", 1000), pad("b", 30_000), pad("c", 1000)];

  test.each([
    [
      "bytes = T",
      bytesT,
      64,
      524_288,
      0,
      "a2360f34a55ce14b53918d1caef5af46e433cb832bb53b5e027c88b2aabcc02a",
      undefined,
      true,
    ],
    [
      "bytes = T+1",
      bytesT1,
      64,
      524_289,
      1,
      "f6ea461c74daa1bf7fd33312019c8dac908cbaa82fcd1a168dab5acafb44fb74",
      [26],
      false,
    ],
    [
      "rows = T",
      () => rowsN(2048),
      2048,
      30_720,
      0,
      "a97d285bd259b7df3ab4776f87a8d844dfe1988037d143ae036aa35619a8b23f",
      undefined,
      true,
    ],
    [
      "rows = T+1",
      () => rowsN(2049),
      2049,
      30_735,
      1,
      "37ee35d14e4268d8fcaaf50575b8a5a912d8948c51263d72145b4f8bcd4abd63",
      [3],
      false,
    ],
    [
      "bytes > T, one isolated chunk",
      () => [pad("big", 614_400)],
      1,
      614_400,
      0,
      "5d445b0f733a758d029c0f00ec7a8d4e762dfdcd2367eee6106ff60f996e067a",
      undefined,
      true,
    ],
    [
      "no isolation under the rule",
      noIsolationRows,
      3,
      32_000,
      0,
      "fff6975f5b2dcb4b0c51f1dd61f99b0b4484b2c9028062c2a67cc48fa5a62185",
      undefined,
      true,
    ],
  ] as const)(
    "production depth-0 rule, %s",
    (_, make, count, total, depth, digest, levelNodes, saltFree) => {
      const rows = make();
      expect(rows.length).toBe(count);
      expect(rows.reduce((n, r) => n + bytesOf(r), 0)).toBe(total);
      const shape = canonical(rows);
      expect(shape!.level).toBe(depth);
      expect(shapeDigest(shape)).toBe(digest);
      expect(expectClean(shape, PRODUCTION_LAYOUT, rows).levelNodes).toEqual(levelNodes);
      if (saltFree) {
        expect(shapeDigest(canonical(rows, PRODUCTION_LAYOUT, SALT2))).toBe(digest);
      }
    },
  );

  test("bytes = T+1 makes 26 leaves; rows = T+1 makes leaves of 17,130 / 13,335 / 270 bytes", () => {
    expect(shapeLevels(canonical(bytesT1()))[0]).toHaveLength(26);
    const leaves = shapeLevels(canonical(rowsN(2049)))[0]!;
    expect(leaves.map((l) => leafDocs(l).reduce((n, d) => n + bytesOf(d), 0))).toEqual([
      17_130, 13_335, 270,
    ]);
  });

  test("a builder that isolates under the depth-0 rule gives [a] [b] [c] at depth 1", () => {
    const docs = noIsolationRows().map(
      (r) => canonDocument(r) as Exclude<ReturnType<typeof canonDocument>, { invalid: string }>,
    );
    const isolating = assembleAbove(
      leafChunks(docs, PRODUCTION_LAYOUT, SALT).map((chunk) => shapeLeaf(chunk.map((d) => d.doc))),
      PRODUCTION_LAYOUT,
      SALT,
    );
    expect(shapeLevels(isolating)[0]!.map((l) => leafDocs(l).map((d) => d["_id"]))).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
    expect(isolating.level).toBe(1);
    expect(shapeDigest(isolating)).toBe(
      "5a6369a2bc051d3af8c197527cb097225d8dbdfc23d2eb61db5c6ef5fea83e53",
    );
  });

  const isolationRows = (): DocumentData[] => [
    pad("a", 1000),
    pad("b", 24_576),
    pad("c", 1000),
    pad("d", 24_575),
    pad("e", 1000),
  ];

  test("large-document isolation: [a] [b] [c, d] [e] under a depth-1 root", () => {
    const rows = isolationRows();
    const shape = canonical(rows, NO_DEPTH_ZERO);
    const leaves = shapeLevels(shape)[0]!.map((l) => leafDocs(l).map((d) => d["_id"]));
    expect(leaves).toEqual([["a"], ["b"], ["c", "d"], ["e"]]);
    expect(shape!.level).toBe(1);
    expect(shapeDigest(shape)).toBe(
      "93e8518bed95d7dc427a168de984042380c4c49562ed9efe43897760ed95179c",
    );
    expect(shapeDigest(canonical(rows, NO_DEPTH_ZERO, SALT2))).toBe(shapeDigest(shape));
    expect(expectClean(shape, NO_DEPTH_ZERO, rows).levelNodes).toEqual([4]);
  });

  test("large-document isolation: cutting before the entry that crosses Lmax gives five leaves", () => {
    const rows = isolationRows();
    // d alone at 24,575 bytes cuts on its hash, so the early cut splits [c, d].
    expect(chunkHash(SALT, 0, "d")).toBe(3_245_623_074);
    expect(cutLeaf(PRODUCTION_LAYOUT, 0, 24_575, chunkHash(SALT, 0, "d"))).toBe(true);
    // The mutant chunker: close the leaf before an entry that would make it reach Lmax.
    const leaves: DocumentData[][] = [];
    let current: DocumentData[] = [];
    let s = 0;
    for (const doc of rows) {
      const b = bytesOf(doc);
      if (b >= NO_DEPTH_ZERO.leafIsolationDocumentBytes) {
        if (current.length > 0) {
          leaves.push(current);
        }
        leaves.push([doc]);
        current = [];
        s = 0;
        continue;
      }
      if (current.length > 0 && s + b >= NO_DEPTH_ZERO.leafMaxBytes) {
        leaves.push(current);
        current = [];
        s = 0;
      }
      const p = s;
      s += b;
      current.push(doc);
      if (cutLeaf(NO_DEPTH_ZERO, p, s, chunkHash(SALT, 0, doc["_id"] as string))) {
        leaves.push(current);
        current = [];
        s = 0;
      }
    }
    if (current.length > 0) {
      leaves.push(current);
    }
    expect(leaves.map((l) => l.map((d) => d["_id"]))).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    const five = assembleAbove(leaves.map(shapeLeaf), NO_DEPTH_ZERO, SALT);
    expect(shapeDigest(five)).toBe(
      "00d815a94584bb5f58afc88a0fa4df400c0488b259df6837b7dd9061c38cdf95",
    );
    const { image } = materializeTree(five, { prefix: P, floor: 3, attempt: A1 });
    const report = checkTreeImage({ image, prefix: P, layout: NO_DEPTH_ZERO, expectedRows: rows });
    expect([...new Set(report.violations.map((v) => v.kind))].toSorted()).toEqual([
      "non-canonical-root",
      "unexpected-cut",
    ]);
    const cut = report.violations.find((v) => v.kind === "unexpected-cut")!;
    expect([cut.level, cut.index]).toEqual([0, 2]);
  });

  test("isolation threshold below Lmax: Iso 34 isolates b at 34 bytes, not d at 33", () => {
    const layout: OracleLayout = { ...TEST_LAYOUT, leafIsolationDocumentBytes: 34 };
    const rows = [
      { _id: "a" },
      pad("b", 34),
      { _id: "c" },
      pad("d", 33),
      { _id: "e" },
      { _id: "f" },
    ];
    expect(rows.reduce((n, r) => n + bytesOf(r), 0)).toBe(111);
    const shape = canonical(rows, layout);
    expect(levelRanges(shape)).toEqual(["a..a  b..b  c..d  e..f", "a..b  c..f", "a..f"]);
    expect(shapeDigest(shape)).toBe(
      "cf335919cf04f632fe1f1001c861613313ce6792d9e41319e437d7d483684414",
    );
    expect(expectClean(shape, layout, rows).levelNodes).toEqual([4, 2]);
    // Isolating at Lmax (48), or testing b > Iso (the same as Iso 35 here), keeps b with a.
    for (const iso of [48, 35]) {
      const wrong = canonical(rows, { ...layout, leafIsolationDocumentBytes: iso });
      expect(levelRanges(wrong)).toEqual(["a..b  c..d  e..f", "a..f"]);
      expect(shapeDigest(wrong)).toBe(
        "4171075934b5cad07fb89638ec2780e20a7b40d0a6dc465cb0537cb980542667",
      );
    }
  });
});

// ── Self-consistency and prefix splits ─────────────────────────────────────

const rowArb = (maxPad: number) =>
  fc
    .uniqueArray(fc.record({ id: validDocIdArb, pad: fc.nat({ max: maxPad }) }), {
      selector: (r) => r.id,
      comparator: (a, b) => compareIds(a, b) === 0,
      maxLength: 60,
    })
    .map((rs) => rs.map(({ id, pad: n }) => ({ _id: id, p: "x".repeat(n) }) as DocumentData));

describe("every canonical tree checks clean", () => {
  fcTest.prop({ rows: rowArb(30) }, { numRuns: 50 })("test layout", ({ rows }) => {
    const shape = canonical(rows, TEST_LAYOUT);
    const { image } = materializeTree(shape, { prefix: P, floor: 1, attempt: A1 });
    expect(
      checkTreeImage({ image, prefix: P, layout: TEST_LAYOUT, expectedRows: rows }).violations,
    ).toEqual([]);
  });

  fcTest.prop({ rows: rowArb(30_000) }, { numRuns: 20 })(
    "production leaf parameters with the depth-0 rule off",
    ({ rows }) => {
      const shape = canonical(rows, NO_DEPTH_ZERO);
      const { image } = materializeTree(shape, { prefix: P, floor: 1, attempt: A1 });
      expect(
        checkTreeImage({ image, prefix: P, layout: NO_DEPTH_ZERO, expectedRows: rows }).violations,
      ).toEqual([]);
    },
  );

  fcTest.prop({ rows: rowArb(30), cut: fc.nat() }, { numRuns: 50 })(
    "leaf chunks before the first changed ID are unchanged by a later change",
    ({ rows, cut }) => {
      const docs = rows
        .map(
          (r) => canonDocument(r) as Exclude<ReturnType<typeof canonDocument>, { invalid: string }>,
        )
        .toSorted((a, b) => compareIds(a.id, b.id));
      if (docs.length === 0) {
        return;
      }
      const at = cut % docs.length;
      const changed = docs.filter((_, i) => i !== at);
      const before = leafChunks(docs, TEST_LAYOUT, SALT);
      const after = leafChunks(changed, TEST_LAYOUT, SALT);
      let consumed = 0;
      for (const [i, chunk] of before.entries()) {
        consumed += chunk.length;
        if (consumed >= at) {
          break;
        }
        expect(after[i]!.map((d) => d.id)).toEqual(chunk.map((d) => d.id));
      }
    },
  );

  test("an empty collection: null root, zero totals, no nodes", () => {
    const { image } = materializeTree(null, { prefix: P, floor: 4, attempt: A1 });
    const report = checkTreeImage({ image, prefix: P, expectedRows: [], expectedFloor: 4 });
    expect(report.violations).toEqual([]);
    expect(report.rootKey).toBeNull();
  });

  test("a fresh head without proto_tree against a non-empty row set is reported with the head key", () => {
    const head = treeHead({
      root: null,
      floor: 0,
      rows: 0,
      bytes: 0,
      gcFenceEpoch: 0,
      chunkSalt: SALT,
    });
    delete head["proto_tree"];
    const image = new Map([[`${P}/current.json`, imageObject(utf8(JSON.stringify(head)))]]);
    const v = checkTreeImage({
      image,
      prefix: P,
      layout: TEST_LAYOUT,
      expectedRows: smallRows(),
    }).violations;
    expect(v.map((x) => [x.kind, x.level, x.index, x.key])).toEqual([
      ["non-canonical-root", 0, 0, `${P}/current.json`],
    ]);
    expect(v[0]!.message).toContain("canonical 20 rows");
  });

  test("a fresh head without proto_tree reads as an empty tree", () => {
    const head = treeHead({
      root: null,
      floor: 0,
      rows: 0,
      bytes: 0,
      gcFenceEpoch: 0,
      chunkSalt: SALT,
    });
    delete head["proto_tree"];
    const image = new Map([[`${P}/current.json`, imageObject(utf8(JSON.stringify(head)))]]);
    expect(checkTreeImage({ image, prefix: P, expectedRows: [] }).violations).toEqual([]);
  });

  test("leaked nodes of other attempts are reported as unreachable, not as violations", () => {
    const rows = smallRows();
    const live = materializeTree(canonical(rows, TEST_LAYOUT), {
      prefix: P,
      floor: 2,
      attempt: A1,
    });
    const leak = materializeTree(canonical(rows.slice(0, 5), TEST_LAYOUT), {
      prefix: P,
      floor: 1,
      attempt: A2,
      omitHead: true,
    });
    const image = new Map([
      ...leak.image,
      ...live.image,
      [`${P}/_v99/n/not-a-node`, imageObject(utf8("x"))],
    ]);
    const report = checkTreeImage({
      image,
      prefix: P,
      layout: TEST_LAYOUT,
      expectedRows: rows,
    });
    expect(report.violations).toEqual([]);
    expect(report.unreachableNodeKeys).toEqual([...leak.image.keys()].toSorted());
    expect(report.foreignNodeKeys).toEqual([`${P}/_v99/n/not-a-node`]);
  });
});

const logEntry = (seq: number, op: "I" | "U" | "D", id: string, after?: DocumentData): LogEntry =>
  ({
    lsn: `lsn-${seq}`,
    commit_ts: "2026-01-01T00:00:00.000Z",
    op,
    collection: "tickets",
    doc_id: id,
    session: "ssn001",
    seq,
    ...(after !== undefined && { after }),
  }) as LogEntry;

describe("prefix splits", () => {
  const entries: LogEntry[] = [
    ...smallRows().map((r, i) => logEntry(i, "I", r["_id"] as string, r)),
    logEntry(20, "D", "k13"),
    logEntry(21, "U", "k4", { _id: "k4", v: "updated" }),
    logEntry(22, "I", "k20", { _id: "k20" }),
  ];
  const input = {
    collection: "tickets",
    base: new Map<string, DocumentData>(),
    baseSeq: 0,
    entries,
  };
  const splits = [[23], [5, 23], [20, 21, 22, 23], [1, 2, 3, 10, 23]];

  const publishCanonical = (rows: Iterable<DocumentData>, attempt: string) =>
    materializeTree(canonical(rows, TEST_LAYOUT), {
      prefix: P,
      floor: 23,
      attempt,
    }).image;

  test("every split reaches the same rows, and canonical publications agree", () => {
    const finals = splits.map((s) => foldThroughSplits(input, s).at(-1)!);
    for (const view of finals) {
      expect([...view.rows.keys()]).toEqual([...finals[0]!.rows.keys()]);
      expect(view.foldedSeq).toBe(23);
    }
    const attempts = [A1, A2, A3, "abcdefabcdefabcdefabcdefabcdefab"];
    const runs = finals.map((view, i) => ({
      label: `split ${JSON.stringify(splits[i])}`,
      image: publishCanonical(view.rows.values(), attempts[i]!),
    }));
    expect(
      checkSplitEquivalence(runs, {
        prefix: P,
        rows: finals[0]!.rows.values(),
        floor: 23,
        layout: TEST_LAYOUT,
      }),
    ).toEqual([]);
  });

  test("split points must increase, and an equivalence check needs a run", () => {
    expect(() => foldThroughSplits(input, [5, 5])).toThrow(/do not increase/);
    expect(() => foldThroughSplits(input, [10, 5])).toThrow(/do not increase/);
    expect(() => foldThroughSplits({ ...input, baseSeq: 3 }, [2])).toThrow(/do not increase/);
    expect(() => checkSplitEquivalence([], { prefix: P, rows: [], floor: 0 })).toThrow(
      /at least one run/,
    );
  });

  test("a run that appends to the old last leaf instead of re-chunking is caught", () => {
    const [first, last] = foldThroughSplits(input, [20, 23]);
    const old = canonical(first!.rows.values(), TEST_LAYOUT)!;
    // Naive incremental publish: keep the old leaves, drop k13, patch k4 in
    // place, and append k20 to the last leaf with no resync.
    const leaves = shapeLevels(old)[0]!.map((leaf) =>
      shapeLeaf(
        leafDocs(leaf)
          .filter((d) => d["_id"] !== "k13")
          .map((d) => (d["_id"] === "k4" ? { _id: "k4", v: "updated" } : d)),
      ),
    );
    const k20 = leaves.findIndex((l) => compareIds(l.docs.at(-1)!["_id"] as string, "k20") > 0);
    leaves[k20] = shapeLeaf(
      [...leaves[k20]!.docs, { _id: "k20" }].toSorted((a, b) =>
        compareIds(a["_id"] as string, b["_id"] as string),
      ),
    );
    const naive = materializeTree(assembleAbove(leaves, TEST_LAYOUT, SALT), {
      prefix: P,
      floor: 23,
      attempt: A2,
    }).image;
    const good = publishCanonical(last!.rows.values(), A1);
    const kinds = checkSplitEquivalence(
      [
        { label: "one fold", image: good },
        { label: "naive incremental", image: naive },
      ],
      { prefix: P, rows: last!.rows.values(), floor: 23, layout: TEST_LAYOUT },
    ).map((v) => v.kind);
    expect(kinds).toContain("non-canonical-root");
  });
});

// ── Mutation: hand-built bad images must be reported ───────────────────────

interface Case {
  readonly image: Map<string, ImageObject>;
  readonly layout: OracleLayout;
  readonly rows: readonly DocumentData[];
  /** When given, passed as the expected fold end. */
  readonly floor?: number;
  /** When given, an `unexpected-cut` must be reported at this level and index. */
  readonly cutAt?: readonly [number, number];
}

const caseOf = (
  shape: ShapeNode | null,
  layout: OracleLayout,
  rows: readonly DocumentData[],
  attempt = A1,
): Case => ({
  image: materializeTree(shape, { prefix: P, floor: 9, attempt }).image,
  layout,
  rows,
});

const leavesOf = (shape: ShapeNode | null): ShapeNode[] => shapeLevels(shape)[0]!;
const docsOf = (node: ShapeNode): DocumentData[] => [...leafDocs(node)];

const keyAtPath = (image: TreeImage, path: readonly number[]): string => {
  let key = JSON.parse(new TextDecoder().decode(image.get(`${P}/current.json`)!.bytes)).proto_tree
    .root as string;
  for (const i of path) {
    const body = JSON.parse(new TextDecoder().decode(image.get(key)!.bytes));
    const child = body.children[i];
    key = `${P}/_v99/n/${child.attempt}/${child.sha256}`;
  }
  return key;
};

const headOf = (
  image: TreeImage,
): Record<string, unknown> & { proto_tree: Record<string, unknown> } =>
  JSON.parse(new TextDecoder().decode(image.get(`${P}/current.json`)!.bytes));

const editHead = (
  image: Map<string, ImageObject>,
  edit: (head: ReturnType<typeof headOf>) => void,
) => {
  const head = headOf(image);
  edit(head);
  image.set(`${P}/current.json`, imageObject(utf8(JSON.stringify(head))));
};

/**
 * Edit the body of the node at `path` (child indices from the root), then
 * re-hash it and every ancestor and repoint the head, so only the edit itself
 * is wrong. The old bodies stay in the image, unreachable.
 */
const editNode = (
  image: Map<string, ImageObject>,
  path: readonly number[],
  edit: (body: Record<string, any>) => void,
) => {
  const keys = Array.from({ length: path.length + 1 }, (_, d) =>
    keyAtPath(image, path.slice(0, d)),
  );
  const decode = (key: string) => JSON.parse(new TextDecoder().decode(image.get(key)!.bytes));
  const store = (body: Record<string, any>): string => {
    const bytes = utf8(JSON.stringify(body));
    const object = imageObject(bytes);
    image.set(`${P}/_v99/n/${body["attempt"]}/${object.sha256}`, object);
    return object.sha256;
  };
  const body = decode(keys.at(-1)!);
  edit(body);
  let sha = store(body);
  for (let d = path.length - 1; d >= 0; d--) {
    const parent = decode(keys[d]!);
    parent.children[path[d]!].sha256 = sha;
    sha = store(parent);
  }
  const root = decode(keys[0]!);
  editHead(image, (head) => {
    head.proto_tree["root"] = `${P}/_v99/n/${String(root.attempt)}/${sha}`;
  });
};

/** Group nodes of one level with the branch rule, closing the last group at the end of input. */
const branchGroups = (nodes: readonly ShapeNode[], level: number): ShapeNode[] => {
  const groups: ShapeNode[][] = [];
  let group: ShapeNode[] = [];
  for (const node of nodes) {
    group.push(node);
    if (cutBranch(TEST_LAYOUT, group.length, chunkHash(SALT, level, hiOf(node)))) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length > 0) {
    groups.push(group);
  }
  return groups.map((g) => shapeBranch(level, g));
};

const paddedRows = (prefix: string, n: number): DocumentData[] =>
  Array.from({ length: n }, (_, i) => ({ _id: `${prefix}${String(i).padStart(4, "0")}` }));

const smallCase = (): Case => {
  const rows = smallRows();
  return caseOf(canonical(rows, TEST_LAYOUT), TEST_LAYOUT, rows);
};

const headCase = (edit: (head: ReturnType<typeof headOf>) => void): Case => {
  const c = smallCase();
  editHead(c.image, edit);
  return c;
};

const isolationRows = (): DocumentData[] => [
  pad("a", 1000),
  pad("b", 24_576),
  pad("c", 1000),
  pad("d", 24_575),
  pad("e", 1000),
];

const mergeLeaves = (shape: ShapeNode | null, at: number, layout: OracleLayout): ShapeNode => {
  const leaves = leavesOf(shape);
  const merged = shapeLeaf([...docsOf(leaves[at]!), ...docsOf(leaves[at + 1]!)]);
  return assembleAbove([...leaves.slice(0, at), merged, ...leaves.slice(at + 2)], layout, SALT);
};

const highBmpAndAstralRows = (n: number): DocumentData[] =>
  Array.from({ length: n }, (_, i) => ({
    _id: i % 2 === 0 ? String.fromCodePoint(0xff10 + i) : String.fromCodePoint(0x1f600 + i),
  }));

const bytesTRows = (): DocumentData[] =>
  Array.from({ length: 64 }, (_, i) => pad(`d${String(i).padStart(2, "0")}`, 8192));
const rowsTRows = (n: number): DocumentData[] =>
  Array.from({ length: n }, (_, i) => ({ _id: `r${String(i).padStart(4, "0")}` }));

const MUTANTS: readonly {
  name: string;
  expected: readonly TreeViolationKind[];
  build: () => Case;
}[] = [
  {
    name: "a child missing under its parent",
    expected: ["missing-node"],
    build: () => {
      const rows = smallRows();
      const c = caseOf(canonical(rows, TEST_LAYOUT), TEST_LAYOUT, rows);
      c.image.delete(keyAtPath(c.image, [0, 1]));
      return c;
    },
  },
  {
    name: "a leaf boundary where the chunking rule makes no cut",
    expected: ["unexpected-cut", "non-canonical-root"],
    build: () => {
      const rows = smallRows();
      const leaves = leavesOf(canonical(rows, TEST_LAYOUT));
      const first = docsOf(leaves[0]!);
      const moved = [
        shapeLeaf(first.slice(0, -1)),
        shapeLeaf([first.at(-1)!, ...docsOf(leaves[1]!)]),
        ...leaves.slice(2),
      ];
      return caseOf(assembleAbove(moved, TEST_LAYOUT, SALT), TEST_LAYOUT, rows);
    },
  },
  {
    name: "a branch boundary where the chunking rule makes no cut",
    expected: ["unexpected-cut", "missing-hash-cut", "non-canonical-root"],
    build: () => {
      const rows = smallRows();
      const levelOne = shapeLevels(canonical(rows, TEST_LAYOUT))[1]! as ShapeBranch[];
      const a = levelOne[0]!.children.map((c) => c.node);
      const b = levelOne[1]!.children.map((c) => c.node);
      const moved = [
        shapeBranch(1, a.slice(0, -1)),
        shapeBranch(1, [a.at(-1)!, ...b]),
        ...levelOne.slice(2),
      ];
      return caseOf(assembleAbove(moved, TEST_LAYOUT, SALT), TEST_LAYOUT, rows);
    },
  },
  {
    name: "leaf documents in UTF-16 order instead of utf8-scalar-v1 (one root leaf)",
    expected: ["entry-order"],
    build: () => {
      const rows = highBmpAndAstralRows(6);
      return caseOf(
        buildShapeWithOrder(rows, PRODUCTION_LAYOUT, SALT, utf16Order),
        PRODUCTION_LAYOUT,
        rows,
      );
    },
  },
  {
    name: "a whole tree in UTF-16 order instead of utf8-scalar-v1",
    expected: ["entry-order"],
    build: () => {
      const rows = highBmpAndAstralRows(20);
      return caseOf(buildShapeWithOrder(rows, TEST_LAYOUT, SALT, utf16Order), TEST_LAYOUT, rows);
    },
  },
  {
    name: "a root one level too high for its children",
    expected: ["level"],
    build: () => {
      const rows = smallRows();
      const shape = canonical(rows, TEST_LAYOUT) as ShapeBranch;
      // Counts that pass the root's structural checks, so the child's level is what fails.
      const image = materializeTree(
        { ...shape, level: shape.level + 1 },
        { prefix: P, floor: 9, attempt: A1, levelNodes: [7, 3, 3] },
      ).image;
      return { image, layout: TEST_LAYOUT, rows };
    },
  },
  {
    name: "a body that does not hash to its key",
    expected: ["hash-mismatch"],
    build: () => {
      const rows = smallRows();
      const c = caseOf(canonical(rows, TEST_LAYOUT), TEST_LAYOUT, rows);
      const key = keyAtPath(c.image, [0, 0]);
      const text = new TextDecoder().decode(c.image.get(key)!.bytes);
      c.image.set(key, imageObject(utf8(text.replace('{"_id":"k0"}', '{"_id":"k0","z":1}'))));
      return c;
    },
  },
  {
    name: "an image digest that does not match its bytes",
    expected: ["image-digest"],
    build: () => {
      const rows = smallRows();
      const c = caseOf(canonical(rows, TEST_LAYOUT), TEST_LAYOUT, rows);
      const key = keyAtPath(c.image, [0]);
      c.image.set(key, { bytes: c.image.get(key)!.bytes, sha256: "0".repeat(64) });
      return c;
    },
  },
  {
    name: "no cut after the entry that makes a leaf reach Lmax",
    expected: ["missing-forced-cut", "non-canonical-root"],
    build: () => {
      const rows = isolationRows();
      return caseOf(
        mergeLeaves(canonical(rows, NO_DEPTH_ZERO), 2, NO_DEPTH_ZERO),
        NO_DEPTH_ZERO,
        rows,
      );
    },
  },
  {
    name: "no cut after a branch reaches Fmax entries",
    expected: ["missing-forced-cut", "non-canonical-root"],
    build: () => {
      // Search a small deterministic family for a non-last level-1 node
      // that the Fmax rule (3 in the test layout) closed, then merge it with
      // its right neighbour.
      for (let n = 8; n < 200; n++) {
        const rows = Array.from({ length: n }, (_, i) => ({ _id: `b${i}` }));
        const levelOne = shapeLevels(canonical(rows, TEST_LAYOUT))[1] as ShapeBranch[] | undefined;
        const at =
          levelOne?.findIndex(
            (node, i) =>
              i < levelOne.length - 1 && node.children.length === TEST_LAYOUT.branchFanoutMax,
          ) ?? -1;
        if (levelOne === undefined || at === -1) {
          continue;
        }
        const merged = shapeBranch(
          1,
          [...levelOne[at]!.children, ...levelOne[at + 1]!.children].map((c) => c.node),
        );
        const level = [...levelOne.slice(0, at), merged, ...levelOne.slice(at + 2)];
        return caseOf(assembleAbove(level, TEST_LAYOUT, SALT), TEST_LAYOUT, rows);
      }
      throw new Error("no forced branch cut in the search family");
    },
  },
  {
    name: "no content cut where the hash rule makes one",
    expected: ["missing-hash-cut", "non-canonical-root"],
    build: () => {
      const rows = smallRows();
      return caseOf(mergeLeaves(canonical(rows, TEST_LAYOUT), 0, TEST_LAYOUT), TEST_LAYOUT, rows);
    },
  },
  {
    name: "no cut before a document of at least the isolation size",
    expected: ["missing-isolation-cut", "non-canonical-root"],
    build: () => {
      const rows = isolationRows();
      return caseOf(
        mergeLeaves(canonical(rows, NO_DEPTH_ZERO), 0, NO_DEPTH_ZERO),
        NO_DEPTH_ZERO,
        rows,
      );
    },
  },
  {
    name: "no cut after a document of at least the isolation size",
    expected: ["missing-isolation-cut", "non-canonical-root"],
    build: () => {
      const rows = isolationRows();
      return caseOf(
        mergeLeaves(canonical(rows, NO_DEPTH_ZERO), 1, NO_DEPTH_ZERO),
        NO_DEPTH_ZERO,
        rows,
      );
    },
  },
  {
    name: "depth-0 rule: bytes = T chunked instead of one root leaf",
    expected: ["depth-0-rule", "non-canonical-root"],
    build: () => {
      const rows = bytesTRows();
      return caseOf(canonical(rows, NO_DEPTH_ZERO), PRODUCTION_LAYOUT, rows);
    },
  },
  {
    name: "depth-0 rule: bytes = T+1 kept as one root leaf",
    expected: ["depth-0-rule", "missing-hash-cut", "non-canonical-root"],
    build: () => {
      const rows = [...bytesTRows().slice(0, 63), pad("d63", 8193)];
      return caseOf(
        canonical(rows, { ...PRODUCTION_LAYOUT, singleLeafMaxBytes: 524_289 }),
        PRODUCTION_LAYOUT,
        rows,
      );
    },
  },
  {
    name: "depth-0 rule: rows = T chunked instead of one root leaf",
    expected: ["depth-0-rule", "non-canonical-root"],
    build: () => {
      const rows = rowsTRows(2048);
      return caseOf(canonical(rows, NO_DEPTH_ZERO), PRODUCTION_LAYOUT, rows);
    },
  },
  {
    name: "depth-0 rule: rows = T+1 kept as one root leaf",
    expected: ["depth-0-rule", "missing-hash-cut", "non-canonical-root"],
    build: () => {
      const rows = rowsTRows(2049);
      return caseOf(
        canonical(rows, { ...PRODUCTION_LAYOUT, singleLeafMaxRows: 2049 }),
        PRODUCTION_LAYOUT,
        rows,
      );
    },
  },
  {
    name: "a level that fits one branch split in two",
    expected: ["level-nodes-root-rule", "root-rule", "non-canonical-root"],
    build: () => {
      const rows = [...bytesTRows().slice(0, 63), pad("d63", 8193)];
      const leaves = leavesOf(canonical(rows));
      const split = shapeBranch(2, [
        shapeBranch(1, leaves.slice(0, 13)),
        shapeBranch(1, leaves.slice(13)),
      ]);
      return caseOf(split, PRODUCTION_LAYOUT, rows);
    },
  },
  {
    name: "a parent entry whose rows disagree with its child",
    expected: ["entry-mismatch", "non-canonical-root"],
    build: () => {
      const rows = smallRows();
      const shape = canonical(rows, TEST_LAYOUT) as ShapeBranch;
      const [first, ...rest] = shape.children;
      return caseOf(
        { ...shape, children: [{ ...first!, rows: first!.rows + 1 }, ...rest] },
        TEST_LAYOUT,
        rows,
      );
    },
  },
  {
    name: "a head whose totals disagree with its root",
    expected: ["head-mismatch"],
    build: () => {
      const rows = smallRows();
      const c = caseOf(canonical(rows, TEST_LAYOUT), TEST_LAYOUT, rows);
      const key = `${P}/current.json`;
      const head = JSON.parse(new TextDecoder().decode(c.image.get(key)!.bytes));
      head.snapshot_rows += 1;
      c.image.set(key, imageObject(utf8(JSON.stringify(head))));
      return c;
    },
  },
  {
    name: "a head with schema_version 2",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h["schema_version"] = 2;
      }),
  },
  {
    name: "a head with a non-null snapshot",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h["snapshot"] = {};
      }),
  },
  {
    name: "a head with no snapshot field",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        delete h["snapshot"];
      }),
  },
  {
    name: "a proto_tree with an extra key",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h.proto_tree["extra"] = 0;
      }),
  },
  {
    name: "a gc_fence_epoch of -1",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h.proto_tree["gc_fence_epoch"] = -1;
      }),
  },
  {
    name: "a root that is not a string",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h.proto_tree["root"] = 5;
      }),
  },
  {
    name: "a non-fresh head without proto_tree",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        delete (h as Record<string, unknown>)["proto_tree"];
      }),
  },
  {
    name: "a proto_tree without chunk_salt",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        delete h.proto_tree["chunk_salt"];
      }),
  },
  {
    name: "a chunk_salt in upper case",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h.proto_tree["chunk_salt"] = "AABBCCDDEEFF00112233445566778899";
      }),
  },
  {
    name: "a chunk_salt of 31 hex characters",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h.proto_tree["chunk_salt"] = "aabbccddeeff0011223344556677889";
      }),
  },
  {
    name: "a chunk_salt that is not a string",
    expected: ["head-malformed"],
    build: () =>
      headCase((h) => {
        h.proto_tree["chunk_salt"] = 7;
      }),
  },
  {
    name: "a head whose chunk_salt is not the salt the tree was built under",
    expected: ["missing-hash-cut", "non-canonical-root", "unexpected-cut"],
    build: () =>
      headCase((h) => {
        h.proto_tree["chunk_salt"] = SALT2;
      }),
  },
  {
    name: "a root whose level_nodes disagree with the reachable nodes",
    expected: ["level-nodes-mismatch"],
    build: () => {
      const c = smallCase();
      editNode(c.image, [], (body) => {
        body["level_nodes"] = [8, 3];
      });
      return c;
    },
  },
  {
    name: "a root whose level_nodes put at most Fmax nodes below its children",
    expected: ["level-nodes-mismatch", "level-nodes-root-rule"],
    build: () => {
      const c = smallCase();
      editNode(c.image, [], (body) => {
        body["level_nodes"] = [3, 3];
      });
      return c;
    },
  },
  {
    name: "a root key with bad grammar",
    expected: ["key-grammar"],
    build: () =>
      headCase((h) => {
        h.proto_tree["root"] = String(h.proto_tree["root"]).toUpperCase();
      }),
  },
  {
    name: "a root key under another collection's prefix",
    expected: ["key-grammar"],
    build: () => {
      const c = smallCase();
      const root = keyAtPath(c.image, []);
      const foreign = root.replace("/manifests/tickets/", "/manifests/other/");
      c.image.set(foreign, c.image.get(root)!);
      editHead(c.image, (h) => {
        h.proto_tree["root"] = foreign;
      });
      return c;
    },
  },
  {
    name: "a root floor that differs from the head's log_seq_start",
    expected: ["head-mismatch"],
    build: () =>
      headCase((h) => {
        h["log_seq_start"] = 8;
      }),
  },
  {
    name: "a null root with nonzero totals",
    expected: ["head-mismatch"],
    build: () => {
      const c = caseOf(null, TEST_LAYOUT, []);
      editHead(c.image, (h) => {
        h["snapshot_rows"] = 1;
      });
      return c;
    },
  },
  {
    name: "a head floor that is not the expected fold end",
    expected: ["floor-mismatch"],
    build: () => ({ ...smallCase(), floor: 10 }),
  },
  {
    name: "a leaf referenced from two parents",
    expected: ["shared-node"],
    build: () => {
      const c = smallCase();
      const shared = keyAtPath(c.image, [0, 0]).split("/").slice(-2);
      editNode(c.image, [1], (body) => {
        body["children"][0].attempt = shared[0];
        body["children"][0].sha256 = shared[1];
      });
      return c;
    },
  },
  {
    name: "a stored document holding null",
    expected: ["document-invalid"],
    build: () => {
      const c = smallCase();
      editNode(c.image, [0, 0], (body) => {
        body["docs"][0].z = null;
      });
      return c;
    },
  },
  {
    name: "a root whose rows differ from its sums",
    expected: ["root-totals"],
    build: () => {
      const c = smallCase();
      editNode(c.image, [], (body) => {
        body["rows"] += 1;
      });
      return c;
    },
  },
  {
    name: "a leaf where a branch belongs",
    expected: ["level"],
    build: () => {
      const leaves = leavesOf(canonical(smallRows(), TEST_LAYOUT));
      const shape = shapeBranch(2, [shapeBranch(1, leaves.slice(0, 2)), leaves[2]!]);
      return caseOf(shape, TEST_LAYOUT, leaves.slice(0, 3).flatMap(docsOf));
    },
  },
  {
    name: "a duplicate ID across leaves",
    expected: ["entry-mismatch", "entry-order"],
    build: () => {
      const c = smallCase();
      // The second leaf (k11..k13) also holds k10, the first leaf's last ID.
      editNode(c.image, [0, 1], (body) => {
        body["docs"].unshift({ _id: "k10" });
      });
      return c;
    },
  },
  {
    name: "fresh leaves appended after the old last leaf, with no re-chunking",
    expected: ["non-canonical-root", "unexpected-cut"],
    build: () => {
      const added = paddedRows("c", 6);
      for (let n = 10; n < 100; n++) {
        const old = paddedRows("b", n);
        const rows = [...old, ...added];
        const oldLeaves = leavesOf(canonical(old, TEST_LAYOUT));
        const leaves = [...oldLeaves, ...leavesOf(canonical(added, TEST_LAYOUT))];
        const shape = assembleAbove(leaves, TEST_LAYOUT, SALT);
        if (shapeDigest(shape) !== shapeDigest(canonical(rows, TEST_LAYOUT))) {
          return { ...caseOf(shape, TEST_LAYOUT, rows), cutAt: [0, oldLeaves.length - 1] };
        }
      }
      throw new Error("no non-canonical leaf append in the search family");
    },
  },
  {
    name: "fresh branches appended after the old last branch, with no re-chunking",
    expected: ["non-canonical-root", "unexpected-cut"],
    build: () => {
      const added = paddedRows("c", 12);
      for (let n = 22; n < 200; n++) {
        const old = paddedRows("b", n);
        const rows = [...old, ...added];
        // The leaf level is canonical; only level 1 is appended.
        const leaves = leavesOf(canonical(rows, TEST_LAYOUT));
        const m = leavesOf(canonical(old, TEST_LAYOUT)).length;
        const head = branchGroups(leaves.slice(0, m), 1);
        const shape = assembleAbove(
          [...head, ...branchGroups(leaves.slice(m), 1)],
          TEST_LAYOUT,
          SALT,
        );
        if (shapeDigest(shape) !== shapeDigest(canonical(rows, TEST_LAYOUT))) {
          return { ...caseOf(shape, TEST_LAYOUT, rows), cutAt: [1, head.length - 1] };
        }
      }
      throw new Error("no non-canonical branch append in the search family");
    },
  },
  {
    name: "isolation applied under the depth-0 rule",
    expected: ["depth-0-rule", "non-canonical-root"],
    build: () => {
      const rows = [pad("a", 1000), pad("b", 24_576), pad("c", 1000)];
      return caseOf(canonical(rows, NO_DEPTH_ZERO), PRODUCTION_LAYOUT, rows);
    },
  },
  {
    name: "a head pointing at a valid but non-canonical (older) root",
    expected: ["non-canonical-root"],
    build: () => {
      const rows = smallRows();
      const older = rows.slice(0, 12);
      const newer = materializeTree(canonical(rows, TEST_LAYOUT), {
        prefix: P,
        floor: 9,
        attempt: A2,
        omitHead: true,
      });
      const c = caseOf(canonical(older, TEST_LAYOUT), TEST_LAYOUT, rows);
      for (const [k, v] of newer.image) {
        c.image.set(k, v);
      }
      return c;
    },
  },
];

describe("mutation", () => {
  test.each(MUTANTS)("$name is reported", ({ expected, build }) => {
    const c = build();
    const input = {
      image: c.image,
      prefix: P,
      layout: c.layout,
      expectedRows: c.rows,
      ...(c.floor !== undefined && { expectedFloor: c.floor }),
    };
    expect(kindsOf(input)).toEqual([...expected].toSorted());
    if (c.cutAt !== undefined) {
      const cuts = checkTreeImage(input).violations.filter((v) => v.kind === "unexpected-cut");
      expect(cuts.map((v) => [v.level, v.index])).toEqual([c.cutAt]);
    }
  });

  /** Decode the root of `c` with its stored `level_nodes` replaced. */
  const decodeRootWith = (c: Case, levelNodes: unknown) => {
    const body = JSON.parse(new TextDecoder().decode(c.image.get(keyAtPath(c.image, []))!.bytes));
    body.level_nodes = levelNodes;
    const bytes = utf8(JSON.stringify(body));
    return decodeNodeBody(P, `${P}/_v99/n/${String(body.attempt)}/${sha256(bytes)}`, bytes, {
      root: true,
    });
  };

  /** A non-canonical depth-2 root over 800 rows with 2 children, so a count can exceed 256 × 2 and stay ≤ rows. */
  const wideCase = (): Case => {
    const rows = paddedRows("r", 800);
    const leaves = [rows.slice(0, 300), rows.slice(300, 600), rows.slice(600)].map(shapeLeaf);
    const shape = shapeBranch(2, [
      shapeBranch(1, leaves.slice(0, 2)),
      shapeBranch(1, leaves.slice(2)),
    ]);
    return caseOf(shape, TEST_LAYOUT, rows);
  };

  test.each([
    ["a length other than level", smallCase, [7, 3], [7], "not an array of 2 counts"],
    ["a count that is not a positive integer", smallCase, [7, 3], [7.5, 3], "not a positive"],
    ["a last count other than the children", smallCase, [7, 3], [7, 2], "the root has 3 children"],
    ["a count below the one above it", smallCase, [7, 3], [2, 3], "is below level_nodes[1]"],
    ["a first count above rows", smallCase, [7, 3], [21, 3], "exceeds the root's 20 rows"],
    ["a count above 256 times the one above it", wideCase, [3, 2], [513, 2], "exceeds 256 ×"],
  ] as const)(
    "a root branch's level_nodes with %s fails the structure check",
    (_, make, stored, counts, reason) => {
      const c = make();
      expect(decodeRootWith(c, stored).violations).toEqual([]);
      const got = decodeRootWith(c, counts);
      expect(got.violations.map((v) => [v.kind, v.check])).toEqual([
        ["body-structure", "structure"],
      ]);
      expect(got.violations[0]!.message).toContain(reason);
    },
  );

  test("violation messages name the chunk salt field, never its value", () => {
    const secret = "aabbccddeeff00112233445566778899";
    for (const value of [secret, secret.toUpperCase(), secret.slice(1), SALT2]) {
      const c = headCase((h) => {
        h.proto_tree["chunk_salt"] = value;
      });
      const messages = checkTreeImage({
        image: c.image,
        prefix: P,
        layout: c.layout,
        expectedRows: c.rows,
      }).violations.map((v) => v.message);
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message.toLowerCase()).not.toContain(value.toLowerCase());
      }
    }
  });

  test("a duplicate ID across leaves is reported, not thrown, without expected rows", () => {
    const c = MUTANTS.find((m) => m.name === "a duplicate ID across leaves")!.build();
    expect(kindsOf({ image: c.image, prefix: P, layout: c.layout })).toEqual([
      "entry-mismatch",
      "entry-order",
    ]);
  });

  test("the canonical baselines the mutants start from check clean", () => {
    const baselines: [ShapeNode | null, OracleLayout, DocumentData[]][] = [
      [canonical(smallRows(), TEST_LAYOUT), TEST_LAYOUT, smallRows()],
      [canonical(isolationRows(), NO_DEPTH_ZERO), NO_DEPTH_ZERO, isolationRows()],
      [canonical(highBmpAndAstralRows(6)), PRODUCTION_LAYOUT, highBmpAndAstralRows(6)],
      [canonical(highBmpAndAstralRows(20), TEST_LAYOUT), TEST_LAYOUT, highBmpAndAstralRows(20)],
      [canonical(bytesTRows()), PRODUCTION_LAYOUT, bytesTRows()],
      [canonical(rowsTRows(2049)), PRODUCTION_LAYOUT, rowsTRows(2049)],
    ];
    for (const [shape, layout, rows] of baselines) {
      const c = caseOf(shape, layout, rows);
      expect(kindsOf({ image: c.image, prefix: P, layout, expectedRows: rows })).toEqual([]);
    }
  });

  test("the UTF-16 mutant rows really differ between the two orders", () => {
    const ids = highBmpAndAstralRows(6).map((r) => r["_id"] as string);
    expect(ids.toSorted(compareIds)).not.toEqual(ids.toSorted(utf16Order));
  });

  test("an older root passes without expected rows, so only the canonical-root check catches it", () => {
    const c = MUTANTS.find((m) => m.name.startsWith("a head pointing"))!.build();
    expect(kindsOf({ image: c.image, prefix: P, layout: c.layout })).toEqual([]);
  });

  test("the first canonical-root difference names its level, node index and key", () => {
    const c = MUTANTS.find(
      (m) => m.name === "a leaf boundary where the chunking rule makes no cut",
    )!.build();
    const v = checkTreeImage({
      image: c.image,
      prefix: P,
      layout: c.layout,
      expectedRows: c.rows,
    }).violations.find((x) => x.kind === "non-canonical-root")!;
    expect(v.level).toBe(0);
    expect(v.index).toBe(0);
    expect(v.key).toMatch(/\/_v99\/n\/[0-9a-f]{32}\/[0-9a-f]{64}$/);
    // The level-1 entries differ too; the scan reports the lowest level.
    expect(v.message).toContain("first difference at level 0, node 0");
  });

  test("a null published root against a non-empty row set is reported with the head key", () => {
    const { image } = materializeTree(null, { prefix: P, floor: 9, attempt: A1 });
    const v = checkTreeImage({
      image,
      prefix: P,
      layout: TEST_LAYOUT,
      expectedRows: smallRows(),
    }).violations;
    expect(v.map((x) => [x.kind, x.level, x.index, x.key])).toEqual([
      ["non-canonical-root", 0, 0, `${P}/current.json`],
    ]);
    expect(v[0]!.message).toContain("stored none (0 nodes), canonical k0..k10 (7 nodes)");
  });

  test("a published tree against an empty row set is reported at its first leaf", () => {
    const rows = smallRows();
    const c = caseOf(canonical(rows, TEST_LAYOUT), TEST_LAYOUT, rows);
    const v = checkTreeImage({
      image: c.image,
      prefix: P,
      layout: c.layout,
      expectedRows: [],
    }).violations;
    expect(v.map((x) => [x.kind, x.level, x.index, x.key])).toEqual([
      ["non-canonical-root", 0, 0, keyAtPath(c.image, [0, 0])],
    ]);
    expect(v[0]!.message).toContain("stored k0..k10 (7 nodes), canonical none (0 nodes)");
  });
});
