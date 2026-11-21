import { describe, expect, test } from "vitest";
import {
  testChunkKey,
  TREE_SECOND_TEST_CHUNK_SALT,
  TREE_TEST_CHUNK_SALT,
} from "../../../../tests/fixtures/tree-chunk-salt.ts";
import { compareDocIds } from "../snapshot-doc-id.ts";
import {
  branchHashCuts,
  chunkHash,
  chunkKeyIsOf,
  type ChunkKey,
  chunkPreimage,
  cutLeaf,
  importChunkKey,
} from "./chunk.ts";
import { TREE_LAYOUT } from "./layout.ts";

const KEY = await testChunkKey();

/**
 * IDs in `utf8-scalar-v1` order, with their chunk hashes at levels 0, 1
 * and 2 under the test salt.
 */
const ORDER_VECTORS: ReadonlyArray<{
  readonly id: string;
  readonly utf8: string;
  readonly h0: number;
  readonly h1: number;
  readonly h2: number;
}> = [
  { id: "A", utf8: "41", h0: 2_186_594_711, h1: 612_995_553, h2: 4_006_487_808 },
  { id: "a", utf8: "61", h0: 998_623_582, h1: 2_432_698_559, h2: 2_303_573_675 },
  { id: "aa", utf8: "6161", h0: 2_504_164_148, h1: 1_367_151_728, h2: 2_556_938_342 },
  { id: "e\u0301", utf8: "65cc81", h0: 1_610_538_917, h1: 1_206_855_749, h2: 2_384_825_335 },
  { id: "k114", utf8: "6b313134", h0: 3_856_501_626, h1: 717_490_590, h2: 834_240_657 },
  { id: "k28", utf8: "6b3238", h0: 3_921_834_230, h1: 2_934_518_490, h2: 3_347_102_748 },
  { id: "k64", utf8: "6b3634", h0: 1_916_860_981, h1: 1_349_846_763, h2: 9_027_239 },
  { id: "k86", utf8: "6b3836", h0: 1_502_870_839, h1: 56_268_758, h2: 2_783_355_651 },
  { id: "\u00e9", utf8: "c3a9", h0: 1_695_343_356, h1: 330_672_603, h2: 1_016_554_246 },
  { id: "\ufffd", utf8: "efbfbd", h0: 3_806_434_237, h1: 1_677_774_835, h2: 122_783_941 },
  { id: "\u{10000}", utf8: "f0908080", h0: 1_540_892_862, h1: 1_649_052_381, h2: 2_131_086_830 },
  { id: "\u{1f600}", utf8: "f09f9880", h0: 2_257_443_205, h1: 2_220_118_664, h2: 1_414_563_498 },
];

/** The IDs whose level-1 or level-2 hash passes the production threshold 2^27. */
const PASSES: Readonly<Record<string, readonly [boolean, boolean]>> = {
  k86: [true, false],
  k64: [false, true],
  "\ufffd": [false, true],
};

const hex = (bytes: Uint8Array): string => bytes.toHex();

describe("chunk hash", () => {
  test("the vector IDs are listed in utf8-scalar-v1 order, which is UTF-8 byte order", () => {
    const ids = ORDER_VECTORS.map((v) => v.id);
    expect(ids.toReversed().toSorted(compareDocIds)).toEqual(ids);
    for (const { id, utf8 } of ORDER_VECTORS) {
      expect(hex(new TextEncoder().encode(id))).toBe(utf8);
    }
    // UTF-16 order disagrees: an astral code point sorts before U+FFFD.
    expect(ids.toSorted()).not.toEqual(ids);
  });

  test.each(ORDER_VECTORS)("h(0..2, $utf8) under the test salt match the vectors", async (v) => {
    await expect(chunkHash(KEY, 0, v.id)).resolves.toBe(v.h0);
    await expect(chunkHash(KEY, 1, v.id)).resolves.toBe(v.h1);
    await expect(chunkHash(KEY, 2, v.id)).resolves.toBe(v.h2);
    const [one, two] = PASSES[v.id] ?? [false, false];
    expect(branchHashCuts(v.h1, TREE_LAYOUT)).toBe(one);
    expect(branchHashCuts(v.h2, TREE_LAYOUT)).toBe(two);
  });

  test("the HMAC message of h(1, a) and its full HMAC under the test salt", async () => {
    const message = chunkPreimage(1, "a");
    expect(hex(message)).toBe("626165726c792d747265652d6368756e6b2d7632000161");
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.fromHex(TREE_TEST_CHUNK_SALT),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
    expect(mac).toBe("910008bfa7c49e01573b50be5257b4596077b80cf688ffb3857ab633bc792ef5");
    expect(Number.parseInt(mac.slice(0, 8), 16)).toBe(await chunkHash(KEY, 1, "a"));
  });

  test("the salt is an input: another salt gives other hashes", async () => {
    const other = await importChunkKey(Uint8Array.fromHex(TREE_SECOND_TEST_CHUNK_SALT));
    const ids = ORDER_VECTORS.map((v) => v.id);
    const under = async (key: ChunkKey) => Promise.all(ids.map((id) => chunkHash(key, 1, id)));
    const [a, b] = await Promise.all([under(KEY), under(other)]);
    expect(a.filter((h, i) => h === b[i])).toEqual([]);
  });

  test("the key copies the salt, so a later change to the caller's bytes has no effect", async () => {
    const bytes = Uint8Array.fromHex(TREE_TEST_CHUNK_SALT);
    const key = await importChunkKey(bytes);
    bytes.fill(0xff);
    await expect(chunkHash(key, 1, "a")).resolves.toBe(2_432_698_559);
  });

  test.each<[string, unknown]>([
    ["15 bytes", Uint8Array.fromHex(TREE_TEST_CHUNK_SALT).subarray(1)],
    ["17 bytes", Uint8Array.fromHex(`${TREE_TEST_CHUNK_SALT}aa`)],
    ["the hex spelling", TREE_TEST_CHUNK_SALT],
    ["an ArrayBuffer", Uint8Array.fromHex(TREE_TEST_CHUNK_SALT).buffer],
    ["a number array", [...Uint8Array.fromHex(TREE_TEST_CHUNK_SALT)]],
    ["undefined", undefined],
  ])("a salt given as %s is refused as Internal without echoing it", async (_label, salt) => {
    const error = await importChunkKey(salt as Uint8Array).catch((error_: unknown) => error_);
    expect(error).toMatchObject({ code: "Internal" });
    const message = (error as Error).message;
    expect(message).toContain("chunk salt");
    for (const spelling of [TREE_TEST_CHUNK_SALT, "0,1,2,3", "0001020304"]) {
      expect(message).not.toContain(spelling);
    }
  });

  test("the key handle holds no salt bytes", () => {
    expect(JSON.stringify(KEY)).toBe('{"kind":"tree-chunk-key"}');
    expect(Object.getOwnPropertySymbols(KEY)).toEqual([]);
  });

  test("a key is of the salt it was imported from, and of no other", async () => {
    const salt = Uint8Array.fromHex(TREE_TEST_CHUNK_SALT);
    await expect(chunkKeyIsOf(KEY, salt)).resolves.toBe(true);
    const imported = await importChunkKey(salt);
    salt.fill(0);
    await expect(chunkKeyIsOf(imported, Uint8Array.fromHex(TREE_TEST_CHUNK_SALT))).resolves.toBe(
      true,
    );
    await expect(chunkKeyIsOf(KEY, Uint8Array.fromHex(TREE_SECOND_TEST_CHUNK_SALT))).resolves.toBe(
      false,
    );
    await expect(
      chunkKeyIsOf({ kind: "tree-chunk-key" }, Uint8Array.fromHex(TREE_TEST_CHUNK_SALT)),
    ).resolves.toBe(false);
  });

  test("a key not made by importChunkKey is refused", async () => {
    const forged = { kind: "tree-chunk-key" } as const;
    await expect(chunkHash(forged, 0, "a")).rejects.toMatchObject({ code: "Internal" });
  });

  test("an unpaired surrogate and other out-of-domain IDs are refused before hashing", async () => {
    for (const id of ["\ud800", "", "a/b", "_x", "..", "\u0000"]) {
      await expect(chunkHash(KEY, 0, id)).rejects.toMatchObject({ code: "Internal" });
    }
  });

  test("a level outside 0..16 is refused", async () => {
    for (const level of [-1, 17, 1.5, Number.NaN]) {
      await expect(chunkHash(KEY, level, "a")).rejects.toMatchObject({ code: "Internal" });
    }
    await expect(chunkHash(KEY, 16, "a")).resolves.toBeTypeOf("number");
  });
});

describe("leaf cut predicate at the production layout", () => {
  // The predicate takes the hash value, so these rows hold for every salt.
  test.each([
    { p: 16_000, s: 16_500, x: 194_486_616, cut: true },
    { p: 16_000, s: 16_500, x: 3_384_161_199, cut: false },
    // a = max(p, leafMinBytes), not a = leafMinBytes: with a = leafMinBytes this row cuts.
    { p: 16_000, s: 16_500, x: 869_113_755, cut: false },
    { p: 8100, s: 8400, x: 194_486_616, cut: false },
    { p: 24_000, s: 24_576, x: 4_294_967_295, cut: true },
    { p: 7000, s: 8192, x: 0, cut: false },
    { p: 8192, s: 8193, x: 262_143, cut: true },
    { p: 8192, s: 8193, x: 262_144, cut: false },
    // a = max(p, leafMinBytes), not a = p: with a = p this row cuts.
    { p: 0, s: 9000, x: 869_113_755, cut: false },
  ])("cutLeaf($p, $s, $x) is $cut", ({ p, s, x, cut }) => {
    expect(cutLeaf(p, s, x, TREE_LAYOUT)).toBe(cut);
  });
});

describe("branch cut condition at the production layout", () => {
  /**
   * The cut after appending an entry with hash `x` as the `count`-th
   * entry of the node being built: the forced cut at `branchFanoutMax`,
   * or the hash test once the node has `branchFanoutMin` entries. The
   * counting is the builder's; this pins the hash test and the layout
   * values it meets.
   */
  const cutsAfter = (count: number, x: number): boolean =>
    count === TREE_LAYOUT.branchFanoutMax ||
    (count >= TREE_LAYOUT.branchFanoutMin && branchHashCuts(x, TREE_LAYOUT));

  test("the production fanout is min 4, target 32, max 128", () => {
    expect(TREE_LAYOUT.branchFanoutMin).toBe(4);
    expect(TREE_LAYOUT.branchFanoutTarget).toBe(32);
    expect(TREE_LAYOUT.branchFanoutMax).toBe(128);
  });

  test.each([
    { c: 3, x: 134_217_727, cut: false },
    { c: 4, x: 134_217_727, cut: true },
    { c: 4, x: 134_217_728, cut: false },
    { c: 4, x: 4_294_967_295, cut: false },
    { c: 127, x: 4_294_967_295, cut: false },
    { c: 128, x: 4_294_967_295, cut: true },
  ])("entry $c with hash $x cuts: $cut", ({ c, x, cut }) => {
    expect(cutsAfter(c, x)).toBe(cut);
  });

  test("under the test salt at level 1, entry 4 with hi k86 cuts and with hi a does not", async () => {
    expect(cutsAfter(4, await chunkHash(KEY, 1, "k86"))).toBe(true);
    expect(cutsAfter(4, await chunkHash(KEY, 1, "a"))).toBe(false);
  });
});
