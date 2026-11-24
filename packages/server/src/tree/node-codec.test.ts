import { BaerlyError, MAX_DOCUMENT_BYTES, sha256Hex } from "@baerly/protocol";
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { compareDocIds } from "../snapshot-doc-id.ts";
import {
  BRANCH_MAX_BODY_BYTES,
  LEAF_MAX_BODY_BYTES,
  TREE_MESSAGE_DETAIL_CHARS,
  TREE_MESSAGE_KEY_CHARS,
} from "./constants.ts";
import { treeNodeKey } from "./key.ts";
import { createTreeConfig } from "./layout.ts";
import {
  canonicalDocument,
  decodeNode,
  encodeNode,
  sealNode,
  type TreeBranchNode,
  type TreeDecodeCheck,
  type TreeDocument,
  type TreeLeafNode,
  type TreeNodeExpectation,
} from "./node-codec.ts";

const P = "app/helpdesk/tenant/acme/manifests/tickets";
const A1 = "00112233445566778899aabbccddeeff";
const A2 = "ffeeddccbbaa99887766554433221100";
const utf8 = new TextEncoder();
const text = new TextDecoder();

const encodeText = (body: string): Uint8Array => utf8.encode(body);

/** The key a body would have under attempt `attempt`. */
const keyOf = async (bytes: Uint8Array, attempt = A1): Promise<string> =>
  treeNodeKey(P, attempt, await sha256Hex(bytes));

const leaf = (docs: TreeDocument[], attempt = A1): TreeLeafNode => ({
  kind: "leaf",
  collection: "tickets",
  attempt,
  level: 0,
  root: null,
  docs,
});

/** Decode `body` under its own hash, so the hash check passes. */
const decodeBody = async (
  body: Uint8Array | string,
  expected: Partial<TreeNodeExpectation> = {},
  attempt = A1,
) => {
  const bytes = typeof body === "string" ? encodeText(body) : body;
  return decodeNode(await keyOf(bytes, attempt), bytes, { prefix: P, root: "either", ...expected });
};

const expectDecodeFailure = async (
  promise: Promise<unknown>,
  check: TreeDecodeCheck,
): Promise<void> => {
  const error = await promise.then(
    () => null,
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(BaerlyError);
  expect((error as BaerlyError).code).toBe("InvalidResponse");
  expect((error as BaerlyError).message).toContain(`: ${check} check failed:`);
};

const ENVELOPE = `{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"${A1}","level":0`;
const leafBody = (docs: string, extra = ""): string => `${ENVELOPE}${extra},"docs":[${docs}]}`;
const BASELINE = leafBody(`{"_id":"a","n":1}`);

// ---------------------------------------------------------------------
// Canonical documents
// ---------------------------------------------------------------------

/** `[1, <hole>, 3]`. */
const holey: unknown[] = [1];
holey[2] = 3;

describe("canonical document encoding", () => {
  test("mixed keys: array-index names numerically, then insertion order; numbers re-spelled", async () => {
    const parsed: unknown = JSON.parse(
      '{"b":1,"_id":"x","A":[true,{"z":"é","y":2.50}],"10":0,"2":"n"}',
    );
    const { doc, id, bytes } = canonicalDocument(parsed, "test");
    const encoded = JSON.stringify(doc);
    expect(encoded).toBe('{"2":"n","10":0,"b":1,"_id":"x","A":[true,{"z":"é","y":2.5}]}');
    expect(bytes).toBe(62);
    expect(utf8.encode(encoded).byteLength).toBe(62);
    await expect(sha256Hex(utf8.encode(encoded))).resolves.toBe(
      "e4b799c033a27ea3134bbe00fad2d5d398cc28c631d8e10156b543c75ab651fc",
    );
    expect(id).toBe("x");
  });

  test("key-order edge: index range ends at 4294967294; other keys keep insertion order", async () => {
    // The U+FFFF key is a single code unit and `é` is U+00E9; the last
    // three are in neither UTF-16 nor UTF-8 order.
    const insertion = [
      "b",
      "4294967295",
      "4294967294",
      "01",
      "10",
      "9",
      "-1",
      "__proto__",
      "\uFFFF",
      "😀",
      "\u00e9",
    ];
    const value: Record<string, number> = {};
    for (const key of insertion) {
      Object.defineProperty(value, key, {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    // canon applies to nested values too; the vector is the value alone.
    const { doc } = canonicalDocument({ _id: "x", v: value }, "test");
    const encoded = utf8.encode(JSON.stringify(doc["v"]));
    expect(text.decode(encoded)).toBe(
      '{"9":1,"10":1,"4294967294":1,"b":1,"4294967295":1,"01":1,"-1":1,"__proto__":1,"\uFFFF":1,"😀":1,"\u00e9":1}',
    );
    // JSON.stringify writes U+FFFF raw, as the bytes EF BF BF.
    expect([...encoded.subarray(-23, -20)]).toEqual([0xef, 0xbf, 0xbf]);
    expect(encoded.byteLength).toBe(102);
    await expect(sha256Hex(encoded)).resolves.toBe(
      "dfae1ae1d4a8faa24de23b27130d5123f5642e1a086b8167bab3ece62403ed50",
    );
  });

  test("an own __proto__ key survives canonicalization as a key", () => {
    const { doc } = canonicalDocument(JSON.parse('{"_id":"x","__proto__":{"y":1}}'), "test");
    expect(Object.hasOwn(doc, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    expect(JSON.stringify(doc)).toBe('{"_id":"x","__proto__":{"y":1}}');
  });

  test("strings other than _id are not normalized, and an unpaired surrogate is spelled \\udxxx", () => {
    const { doc } = canonicalDocument({ _id: "x", nfd: "e\u0301", lone: "\ud800" }, "test");
    expect(JSON.stringify(doc)).toBe('{"_id":"x","nfd":"e\u0301","lone":"\\ud800"}');
  });

  test("NFC and NFD _id are distinct IDs, ordered by UTF-8 bytes", () => {
    const nfd = canonicalDocument({ _id: "e\u0301" }, "test");
    const nfc = canonicalDocument({ _id: "\u00e9" }, "test");
    expect(nfd.id).not.toBe(nfc.id);
    expect(compareDocIds(nfd.id, nfc.id)).toBe(-1);
  });

  test("the smallest document is 11 bytes", () => {
    expect(canonicalDocument({ _id: "x" }, "test").bytes).toBe(11);
  });

  test("null is a value: kept at the top level, in arrays and in nested objects", async () => {
    const { doc, bytes } = canonicalDocument(
      JSON.parse('{"_id":"x","n":null,"a":[null,{"z":null}]}'),
      "test",
    );
    const encoded = JSON.stringify(doc);
    expect(encoded).toBe('{"_id":"x","n":null,"a":[null,{"z":null}]}');
    expect(bytes).toBe(42);
    await expect(sha256Hex(utf8.encode(encoded))).resolves.toBe(
      "a5329eea8932321291f63e59cfd1e9915de316218c8f19bc18085a54b095cd07",
    );
  });

  test.each([
    ["undefined value", { _id: "x", v: undefined }],
    ["NaN", { _id: "x", v: Number.NaN }],
    ["Infinity", { _id: "x", v: Number.POSITIVE_INFINITY }],
    ["bigint", { _id: "x", v: 1n }],
    ["function", { _id: "x", v: () => 1 }],
    ["symbol value", { _id: "x", v: Symbol("s") }],
    ["Date", { _id: "x", v: new Date(0) }],
    ["Map", { _id: "x", v: new Map() }],
    [
      "class instance",
      {
        _id: "x",
        v: new (class Box {
          readonly x = 1;
        })(),
      },
    ],
    ["array hole", { _id: "x", v: holey }],
    ["array document", [{ _id: "x" }]],
    ["null document", null],
    ["string document", "x"],
    ["missing _id", { id: "x" }],
    ["numeric _id", { _id: 1 }],
    ["empty _id", { _id: "" }],
    ["_id with /", { _id: "a/b" }],
    ["_id ..", { _id: ".." }],
    ["_id with a control character", { _id: "a\u0085" }],
    ["_id with a leading underscore", { _id: "_a" }],
    ["_id with an unpaired surrogate", { _id: "\ud800" }],
    ["_id over 256 UTF-8 bytes", { _id: "é".repeat(129) }],
  ])("%s is refused as InvalidResponse", (_label, value) => {
    expect(() => canonicalDocument(value, "test")).toThrow(
      expect.objectContaining({ code: "InvalidResponse" }),
    );
  });

  test("a symbol key, a non-enumerable key and an accessor are refused", () => {
    const withSymbol = { _id: "x", [Symbol("k")]: 1 };
    const nonEnumerable = Object.defineProperty({ _id: "x" }, "hidden", { value: 1 });
    const accessor = Object.defineProperty({ _id: "x" }, "v", { get: () => 1, enumerable: true });
    for (const value of [withSymbol, nonEnumerable, accessor]) {
      expect(() => canonicalDocument(value, "test")).toThrow(
        expect.objectContaining({ code: "InvalidResponse" }),
      );
    }
  });

  test("an array accessor and an array without Array.prototype are refused", () => {
    const accessor = Object.defineProperty([1, 2], 1, { get: () => 2, enumerable: true });
    class Tuple extends Array<number> {}
    const subclass = Tuple.from([1]);
    const nullProto = Object.setPrototypeOf([1], null) as unknown[];
    for (const v of [accessor, subclass, nullProto]) {
      expect(() => canonicalDocument({ _id: "x", v }, "test")).toThrow(
        expect.objectContaining({ code: "InvalidResponse" }),
      );
    }
  });

  test("an array with an own property other than its indices and length is refused", () => {
    const named = Object.assign([1], { extra: 1 });
    const hidden = Object.defineProperty([1], "extra", { value: 1 });
    const symbol = Object.assign([1], { [Symbol("k")]: 1 });
    for (const v of [named, hidden, symbol]) {
      expect(() => canonicalDocument({ _id: "x", v }, "test")).toThrow(
        expect.objectContaining({ code: "InvalidResponse" }),
      );
      expect(() => encodeNode(leaf([{ _id: "a", v } as unknown as TreeDocument]))).toThrow(
        expect.objectContaining({ code: "Internal" }),
      );
    }
    expect(canonicalDocument({ _id: "x", v: [1, [2]] }, "test").bytes).toBe(23);
  });

  test("a null-prototype object is a plain object", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { _id: "x" });
    expect(canonicalDocument(value, "test").bytes).toBe(11);
  });

  test("depth 100 is accepted and depth 101 refused, counting the document as level 1", () => {
    const nest = (levels: number): Record<string, unknown> => {
      let value: Record<string, unknown> = {};
      for (let i = 2; i < levels; i++) {
        value = { a: value };
      }
      return { _id: "x", a: value };
    };
    expect(() => canonicalDocument(nest(100), "test")).not.toThrow();
    expect(() => canonicalDocument(nest(101), "test")).toThrow(
      expect.objectContaining({ code: "InvalidResponse" }),
    );
    // Arrays count as levels too; a scalar adds none.
    expect(() => canonicalDocument({ _id: "x", a: [[1]] }, "test")).not.toThrow();
  });

  test("a document of exactly MAX_DOCUMENT_BYTES is accepted, one byte more refused", () => {
    const pad = (n: number) => ({ _id: "x", p: "y".repeat(n - '{"_id":"x","p":""}'.length) });
    expect(canonicalDocument(pad(MAX_DOCUMENT_BYTES), "test").bytes).toBe(MAX_DOCUMENT_BYTES);
    expect(() => canonicalDocument(pad(MAX_DOCUMENT_BYTES + 1), "test")).toThrow(
      expect.objectContaining({ code: "InvalidResponse" }),
    );
  });
});

// ---------------------------------------------------------------------
// Node body vectors
// ---------------------------------------------------------------------

const LEAF_A1: TreeLeafNode = leaf([
  { _id: "a", n: 1 },
  { _id: "b", n: 2 },
]);
const ROOT_LEAF_A1: TreeLeafNode = { ...LEAF_A1, root: { floor: 7, rows: 2, bytes: 34 } };
const LEAF_A2: TreeLeafNode = leaf([{ _id: "c", n: 3 }], A2);
const LEAF_A1_SHA = "fbf6a6386499e42c43fec71fb62476ba684391288cc343204b8552dcc394ff61";
const LEAF_A2_SHA = "0d37618565dca7d59d0777cace6c3c84e5e21d417e67afd90aa78ecc85c6fe8b";
const ROOT_BRANCH_A1: TreeBranchNode = {
  kind: "branch",
  collection: "tickets",
  attempt: A1,
  level: 1,
  root: { floor: 7, rows: 3, bytes: 51, levelNodes: [2] },
  children: [
    { lo: "a", hi: "b", rows: 2, bytes: 34, attempt: A1, sha256: LEAF_A1_SHA },
    { lo: "c", hi: "c", rows: 1, bytes: 17, attempt: A2, sha256: LEAF_A2_SHA },
  ],
};

describe("node body vectors", () => {
  test("leaf A1 with docs a, b", async () => {
    const bytes = encodeNode(LEAF_A1);
    expect(text.decode(bytes)).toBe(
      '{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"00112233445566778899aabbccddeeff","level":0,"docs":[{"_id":"a","n":1},{"_id":"b","n":2}]}',
    );
    expect(bytes.byteLength).toBe(177);
    await expect(sha256Hex(bytes)).resolves.toBe(LEAF_A1_SHA);
  });

  test("root leaf, floor 7, rows 2, bytes 34", async () => {
    const bytes = encodeNode(ROOT_LEAF_A1);
    expect(text.decode(bytes)).toBe(
      '{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"00112233445566778899aabbccddeeff","level":0,"floor":7,"rows":2,"bytes":34,"docs":[{"_id":"a","n":1},{"_id":"b","n":2}]}',
    );
    expect(bytes.byteLength).toBe(207);
    await expect(sha256Hex(bytes)).resolves.toBe(
      "32bf9f0fc5b580449b1a4b82b5b9ac81ccdbc64b463074cc0242fa91b5266e28",
    );
  });

  test("a leaf holding nulls encodes and decodes them unchanged", async () => {
    const doc = { _id: "x", n: null, a: [null, { z: null }] } as unknown as TreeDocument;
    const bytes = encodeNode(leaf([doc]));
    expect(text.decode(bytes)).toBe(
      '{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"00112233445566778899aabbccddeeff","level":0,"docs":[{"_id":"x","n":null,"a":[null,{"z":null}]}]}',
    );
    expect(bytes.byteLength).toBe(184);
    await expect(sha256Hex(bytes)).resolves.toBe(
      "7b8e0082efcbeadef0692b316bda2cdc79f03f3e47b4bc44fe3023afa350b5c1",
    );
    const decoded = await decodeBody(bytes, { root: false });
    expect((decoded.node as TreeLeafNode).docs).toStrictEqual([doc]);
  });

  test("leaf A2 with doc c", async () => {
    await expect(sha256Hex(encodeNode(LEAF_A2))).resolves.toBe(LEAF_A2_SHA);
  });

  test("root branch over both leaves", async () => {
    const bytes = encodeNode(ROOT_BRANCH_A1);
    expect(bytes.byteLength).toBe(515);
    expect(text.decode(bytes)).toContain('"bytes":51,"level_nodes":[2],"children":[');
    await expect(sha256Hex(bytes)).resolves.toBe(
      "fdcb2c51461ba581b2e669e79124d743eb33115e053574ecf805b9c1d1c96b72",
    );
  });

  test("the first leaf's key", async () => {
    const sealed = await sealNode(P, LEAF_A1);
    expect(sealed.key).toBe(
      "app/helpdesk/tenant/acme/manifests/tickets/_v99/n/00112233445566778899aabbccddeeff/fbf6a6386499e42c43fec71fb62476ba684391288cc343204b8552dcc394ff61",
    );
    expect(sealed.summary).toEqual({ lo: "a", hi: "b", rows: 2, bytes: 34 });
  });

  test("each vector decodes back to the same node, routed from its parent or the head", async () => {
    const leafA1 = await sealNode(P, LEAF_A1);
    const fromParent = await decodeNode(leafA1.key, leafA1.bytes, {
      prefix: P,
      root: false,
      level: 0,
      entry: ROOT_BRANCH_A1.children[0]!,
    });
    expect(fromParent.node).toEqual(LEAF_A1);
    expect(fromParent.summary).toEqual({ lo: "a", hi: "b", rows: 2, bytes: 34 });

    const rootLeaf = await sealNode(P, ROOT_LEAF_A1);
    const fromHead = await decodeNode(rootLeaf.key, rootLeaf.bytes, {
      prefix: P,
      root: true,
      floor: 7,
    });
    expect(fromHead.node).toEqual(ROOT_LEAF_A1);

    const rootBranch = await sealNode(P, ROOT_BRANCH_A1);
    const branch = await decodeNode(rootBranch.key, rootBranch.bytes, {
      prefix: P,
      root: true,
      floor: 7,
    });
    expect(branch.node).toEqual(ROOT_BRANCH_A1);
    expect(branch.summary).toEqual({ lo: "a", hi: "c", rows: 3, bytes: 51 });
  });

  test("a GC candidate ('either') decodes as whichever kind it is", async () => {
    for (const node of [LEAF_A1, ROOT_LEAF_A1, LEAF_A2, ROOT_BRANCH_A1]) {
      const sealed = await sealNode(P, node);
      const decoded = await decodeNode(sealed.key, sealed.bytes, { prefix: P, root: "either" });
      expect(decoded.node).toEqual(node);
    }
  });
});

describe("negative body vectors", () => {
  test("the valid baseline is 159 bytes and decodes", async () => {
    const bytes = encodeText(BASELINE);
    expect(bytes.byteLength).toBe(159);
    await expect(sha256Hex(bytes)).resolves.toBe(
      "017f46506c2ad7987bbc810a2389ad66632a4581d38e50fa5a01fcd49b2abe26",
    );
    await expect(decodeBody(bytes, { root: false })).resolves.toBeDefined();
  });

  test.each<[string, Uint8Array, string, TreeDecodeCheck]>([
    [
      "2.50",
      encodeText(leafBody('{"_id":"a","n":2.50}')),
      "75ea8f0db136f1aba9a5352033418a5413928a79026728198dbaecb1cf1ece61",
      "canonical-bytes",
    ],
    [
      "-0",
      encodeText(leafBody('{"_id":"a","n":-0}')),
      "95e94e1134476ba64b7698251a9ea102e22eeb6de14ee7c15bc0cd340b186f28",
      "canonical-bytes",
    ],
    [
      "duplicate member",
      encodeText(leafBody('{"_id":"a","n":1,"n":1}')),
      "76c652da601c61fe945a2dae1215e01fe16543b39ac373cd8db6164109b67e76",
      "canonical-bytes",
    ],
    [
      "swapped field order",
      encodeText(
        BASELINE.replace(
          '"format":"baerly-tree-node-proto","schema_version":1',
          '"schema_version":1,"format":"baerly-tree-node-proto"',
        ),
      ),
      "7ef050349ac036ceac55e94cf601eb9a64925157058fbc65ab7d17b7547ecb59",
      "structure",
    ],
    [
      "BOM",
      new Uint8Array([0xef, 0xbb, 0xbf, ...encodeText(BASELINE)]),
      "afad24228321edc6647842f776270518a04bbd621305a7b064778cc98d8e7d36",
      "json",
    ],
  ])("%s fails its check", async (_label, bytes, sha256, check) => {
    await expect(sha256Hex(bytes)).resolves.toBe(sha256);
    await expectDecodeFailure(decodeBody(bytes, { root: false }), check);
  });

  test("a level_nodes count other than the root's child count fails structure", async () => {
    const valid = text.decode(encodeNode(ROOT_BRANCH_A1));
    const bytes = encodeText(valid.replace('"level_nodes":[2]', '"level_nodes":[3]'));
    expect(bytes.byteLength).toBe(515);
    await expect(sha256Hex(bytes)).resolves.toBe(
      "8295b5a20965b4a2615170afffe20b0d1030570fec8f22a4eb029c5166888ac1",
    );
    await expectDecodeFailure(decodeBody(bytes, { root: true }), "structure");
  });
});

// ---------------------------------------------------------------------
// Strict decode, check by check
// ---------------------------------------------------------------------

describe("strict decode", () => {
  test("key: a key that does not parse under the prefix", async () => {
    const bytes = encodeText(BASELINE);
    const sha = await sha256Hex(bytes);
    for (const key of [
      `${P}/_v99/n/${A1}/${sha}.json`,
      `${P}/_v99/n/${A1.toUpperCase()}/${sha}`,
      `app/other/tenant/acme/manifests/tickets/_v99/n/${A1}/${sha}`,
      `${P}/_v99/gc-pending.json`,
    ]) {
      await expectDecodeFailure(decodeNode(key, bytes, { prefix: P, root: false }), "key");
    }
  });

  test("present: a missing referenced node", async () => {
    const key = treeNodeKey(P, A1, LEAF_A1_SHA);
    await expectDecodeFailure(decodeNode(key, null, { prefix: P, root: false }), "present");
  });

  test("leaf-ceiling: any body over LEAF_MAX_BODY_BYTES, before hashing or parsing", async () => {
    const big = new Uint8Array(LEAF_MAX_BODY_BYTES + 1).fill(0x20);
    // The key's hash is wrong on purpose: the ceiling is checked first.
    const key = treeNodeKey(P, A1, LEAF_A1_SHA);
    await expectDecodeFailure(decodeNode(key, big, { prefix: P, root: "either" }), "leaf-ceiling");
    // At exactly the ceiling the body gets past the check (and fails later).
    const atCeiling = new Uint8Array(LEAF_MAX_BODY_BYTES).fill(0x20);
    await expectDecodeFailure(decodeBody(atCeiling), "json");
  });

  test("hash: a body under another body's key", async () => {
    const sealed = await sealNode(P, LEAF_A1);
    await expectDecodeFailure(
      decodeNode(sealed.key, encodeText(BASELINE), { prefix: P, root: false }),
      "hash",
    );
  });

  test("utf-8: malformed UTF-8, including an encoded surrogate", async () => {
    for (const bad of [[0xff], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
      const bytes = encodeText(leafBody('{"_id":"a","n":"#"}'));
      const at = bytes.indexOf(0x23);
      const spliced = new Uint8Array([...bytes.subarray(0, at), ...bad, ...bytes.subarray(at + 1)]);
      await expectDecodeFailure(decodeBody(spliced), "utf-8");
    }
  });

  test("json: truncated or trailing input", async () => {
    await expectDecodeFailure(decodeBody(BASELINE.slice(0, -1)), "json");
    await expectDecodeFailure(decodeBody(`${BASELINE}}`), "json");
    await expectDecodeFailure(decodeBody(""), "json");
  });

  test.each<[string, string]>([
    ["an array body", "[]"],
    ["a string body", '"x"'],
    ["null", "null"],
    ["an extra field", leafBody('{"_id":"a","n":1}', ',"extra":1')],
    ["a missing field", BASELINE.replace(',"level":0', "")],
    ["format", BASELINE.replace("baerly-tree-node-proto", "baerly-tree-node-other")],
    ["schema_version 2", BASELINE.replace('"schema_version":1', '"schema_version":2')],
    ['schema_version "1"', BASELINE.replace('"schema_version":1', '"schema_version":"1"')],
    ["another collection", BASELINE.replace('"tickets"', '"ticketz"')],
    ["an attempt other than the key's", BASELINE.replace(A1, A2)],
    ["a leaf at level 1", BASELINE.replace('"level":0', '"level":1')],
    ["level as a string", BASELINE.replace('"level":0', '"level":"0"')],
    ["empty docs", leafBody("")],
    ["docs not an array", `${ENVELOPE},"docs":{}}`],
    ["unsorted IDs", leafBody('{"_id":"b"},{"_id":"a"}')],
    ["duplicate IDs", leafBody('{"_id":"a"},{"_id":"a"}')],
    ["UTF-16 order instead of UTF-8 order", leafBody('{"_id":"😀"},{"_id":"\uffff"}')],
    ["a non-finite number", leafBody('{"_id":"a","n":1e999}')],
    ["an unpaired-surrogate _id", leafBody('{"_id":"\\ud800"}')],
    ["a reserved _id", leafBody('{"_id":"_a"}')],
    ["a numeric _id", leafBody('{"_id":1}')],
    ["a document without _id", leafBody('{"n":1}')],
    ["an array document", leafBody('[{"_id":"a"}]')],
    [
      "a schema_version nested 5,000 arrays deep",
      BASELINE.replace(
        '"schema_version":1',
        `"schema_version":${"[".repeat(5000)}${"]".repeat(5000)}`,
      ),
    ],
    [
      "a format nested 5,000 arrays deep",
      BASELINE.replace('"baerly-tree-node-proto"', `${"[".repeat(5000)}${"]".repeat(5000)}`),
    ],
  ])("structure: %s", async (_label, body) => {
    await expectDecodeFailure(decodeBody(body), "structure");
  });

  test("structure: a document over MAX_DOCUMENT_BYTES in a body under the ceiling", async () => {
    const filler = "y".repeat(MAX_DOCUMENT_BYTES + 1 - '{"_id":"a","p":""}'.length);
    await expectDecodeFailure(decodeBody(leafBody(`{"_id":"a","p":"${filler}"}`)), "structure");
  });

  test("structure: a document nested deeper than 100 levels", async () => {
    const deep = `${'{"a":'.repeat(100)}1${"}".repeat(100)}`;
    await expectDecodeFailure(decodeBody(leafBody(`{"_id":"a","d":${deep}}`)), "structure");
    const ok = `${'{"a":'.repeat(98)}1${"}".repeat(98)}`;
    await expect(decodeBody(leafBody(`{"_id":"a","d":${ok}}`))).resolves.toBeDefined();
  });

  test("structure: root fields on a node routed from a parent, and their absence on a root", async () => {
    const rootLeaf = await sealNode(P, ROOT_LEAF_A1);
    await expectDecodeFailure(
      decodeNode(rootLeaf.key, rootLeaf.bytes, { prefix: P, root: false }),
      "structure",
    );
    const plainLeaf = await sealNode(P, LEAF_A1);
    await expectDecodeFailure(
      decodeNode(plainLeaf.key, plainLeaf.bytes, { prefix: P, root: true }),
      "structure",
    );
  });

  test.each<[string, string]>([
    ["rows off by one", ',"floor":7,"rows":3,"bytes":34'],
    ["bytes off by one", ',"floor":7,"rows":2,"bytes":35'],
    ["negative floor", ',"floor":-1,"rows":2,"bytes":34'],
    ["fractional floor", ',"floor":7.5,"rows":2,"bytes":34'],
    ["unsafe floor", ',"floor":9007199254740992,"rows":2,"bytes":34'],
  ])("structure: a root leaf with %s", async (_label, totals) => {
    const body = leafBody('{"_id":"a","n":1},{"_id":"b","n":2}', totals);
    await expectDecodeFailure(decodeBody(body, { root: true }), "structure");
  });

  const branchBody = (entries: string, level = 1): string =>
    `{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"${A1}","level":${level},"children":[${entries}]}`;
  const entry = (
    lo: string,
    hi: string,
    rows = 1,
    bytes = 17,
    sha = LEAF_A1_SHA,
    attempt = A2,
  ): string =>
    `{"lo":"${lo}","hi":"${hi}","rows":${rows},"bytes":${bytes},"attempt":"${attempt}","sha256":"${sha}"}`;

  test("lo ≤ hi holds in code-point order even where UTF-16 order disagrees", async () => {
    await expect(decodeBody(branchBody(entry("\uFFFF", "😀")))).resolves.toMatchObject({
      summary: { lo: "\uFFFF", hi: "😀" },
    });
  });

  test("a valid non-root branch decodes", async () => {
    await expect(
      decodeBody(branchBody(`${entry("a", "b", 2, 34)},${entry("c", "c")}`)),
    ).resolves.toMatchObject({
      summary: { lo: "a", hi: "c", rows: 3, bytes: 51 },
    });
  });

  test.each<[string, string]>([
    ["no children", branchBody("")],
    ["level 0", branchBody(entry("a", "a"), 0)],
    ["level 17", branchBody(entry("a", "a"), 17)],
    ["lo after hi", branchBody(entry("b", "a"))],
    ["overlapping entries", branchBody(`${entry("a", "c")},${entry("c", "d")}`)],
    ["unsorted entries", branchBody(`${entry("c", "d")},${entry("a", "b")}`)],
    ["UTF-16 entry order", branchBody(`${entry("😀", "😀")},${entry("\uffff", "\uffff")}`)],
    ["rows 0", branchBody(entry("a", "a", 0, 0))],
    ["fractional rows", branchBody(entry("a", "a", 1.5, 17))],
    ["bytes below 11 per row", branchBody(entry("a", "b", 2, 21))],
    ["negative bytes", branchBody(entry("a", "a", 1, -1))],
    ["unsafe rows", branchBody(entry("a", "a", 2 ** 53, 2 ** 60))],
    ["an uppercase sha256", branchBody(entry("a", "a", 1, 17, LEAF_A1_SHA.toUpperCase()))],
    ["a short attempt", branchBody(entry("a", "a", 1, 17, LEAF_A1_SHA, A2.slice(1)))],
    ["a reserved lo", branchBody(entry("_a", "b"))],
    ["a reserved hi", branchBody(entry("A", "_b"))],
    ["an unpaired-surrogate hi", branchBody(entry("a", "\\ud800"))],
    // lo ≤ hi is code-point order: U+1F600 sorts after U+FFFF.
    ["lo after hi in code-point order only", branchBody(entry("😀", "\uFFFF"))],
    ["an extra entry field", branchBody(entry("a", "a").replace("}", ',"x":1}'))],
    [
      "entry fields out of order",
      branchBody(
        `{"hi":"a","lo":"a","rows":1,"bytes":17,"attempt":"${A2}","sha256":"${LEAF_A1_SHA}"}`,
      ),
    ],
    ["an entry that is not an object", branchBody('"a"')],
    [
      // Each entry is valid alone; only their sum leaves the safe range.
      "running bytes past the safe-integer range",
      branchBody(
        `${entry("a", "a", 1, Number.MAX_SAFE_INTEGER)},${entry("b", "b", 1, Number.MAX_SAFE_INTEGER)}`,
      ),
    ],
  ])("structure: a branch with %s", async (_label, body) => {
    await expectDecodeFailure(decodeBody(body), "structure");
  });

  /** A level-2 root over three children of `rows` rows each, with `levelNodes` as given. */
  const rootBranchBody = (levelNodes: string, rows: number, level = 2): string => {
    const children = ["a", "b", "c"].map((id) => entry(id, id, rows, 11 * rows)).join(",");
    return `{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"${A1}","level":${level},"floor":0,"rows":${3 * rows},"bytes":${33 * rows},"level_nodes":${levelNodes},"children":[${children}]}`;
  };

  test.each<[string, string, number]>([
    ["equal counts", "[3,3]", 300],
    ["a level 256 times the next", "[768,3]", 300],
    ["a first count equal to rows", "[3,3]", 1],
    ["one level", "[3]", 1],
  ])("level_nodes: %s decodes", async (_label, levelNodes, rows) => {
    const level = JSON.parse(levelNodes).length as number;
    await expect(
      decodeBody(rootBranchBody(levelNodes, rows, level), { root: true }),
    ).resolves.toMatchObject({ node: { root: { levelNodes: JSON.parse(levelNodes) } } });
  });

  test.each<[string, string, number, number?]>([
    ["a level more than 256 times the next", "[769,3]", 300],
    ["a level below the next", "[2,3]", 300],
    ["a last count other than the child count", "[4,4]", 300],
    ["a first count above rows", "[4,3]", 1],
    ["fewer counts than levels", "[3]", 1],
    ["more counts than levels", "[3,3,3]", 1],
    ["a zero count", "[0,3]", 1],
    ["a fractional count", "[3.5,3]", 300],
    ["a string count", '["3",3]', 1],
    ["an unsafe count", `[${2 ** 53},3]`, 1],
    ["not an array", "3", 1],
    ["null", "null", 1],
  ])("structure: level_nodes with %s", async (_label, levelNodes, rows, level = 2) => {
    await expectDecodeFailure(
      decodeBody(rootBranchBody(levelNodes, rows, level), { root: true }),
      "structure",
    );
  });

  test("structure: level_nodes on a root leaf, or missing from a root branch", async () => {
    const rootLeaf = text.decode(encodeNode(ROOT_LEAF_A1));
    await expectDecodeFailure(
      decodeBody(rootLeaf.replace(',"docs":', ',"level_nodes":[1],"docs":'), { root: true }),
      "structure",
    );
    const rootBranch = text.decode(encodeNode(ROOT_BRANCH_A1));
    await expectDecodeFailure(
      decodeBody(rootBranch.replace('"level_nodes":[2],', ""), { root: true }),
      "structure",
    );
    await expectDecodeFailure(
      decodeBody(
        rootBranch.replace('"bytes":51,"level_nodes":[2]', '"level_nodes":[2],"bytes":51'),
        {
          root: true,
        },
      ),
      "structure",
    );
  });

  test("structure: a branch with more than 256 entries", async () => {
    const ids = Array.from({ length: 257 }, (_, i) => `k${String(i).padStart(3, "0")}`);
    await expectDecodeFailure(
      decodeBody(branchBody(ids.map((id) => entry(id, id)).join(","))),
      "structure",
    );
    await expect(
      decodeBody(
        branchBody(
          ids
            .slice(0, 256)
            .map((id) => entry(id, id))
            .join(","),
        ),
      ),
    ).resolves.toBeDefined();
  });

  test("structure: a branch body over BRANCH_MAX_BODY_BYTES, before its entries are read", async () => {
    const ids = Array.from(
      { length: 1700 },
      (_, i) => `${"k".repeat(200)}${String(i).padStart(4, "0")}`,
    );
    const body = encodeText(branchBody(ids.map((id) => entry(id, id)).join(",")));
    expect(body.byteLength).toBeGreaterThan(BRANCH_MAX_BODY_BYTES);
    const error = await decodeBody(body).catch((error_: unknown) => error_);
    expect((error as BaerlyError).message).toContain("branch ceiling");
  });

  test.each<[string, string]>([
    ["insignificant whitespace", BASELINE.replace('"level":0', '"level": 0')],
    ["a trailing newline", `${BASELINE}\n`],
    ["an escaped letter", BASELINE.replace('"_id":"a"', '"_id":"\\u0061"')],
    ["an escaped slash", leafBody('{"_id":"a","s":"\\/"}')],
    ["uppercase escape hex", leafBody('{"_id":"a","s":"\\uD800"}')],
    ["an exponent spelling", BASELINE.replace('"n":1', '"n":1e0')],
    ["index keys out of numeric order", leafBody('{"10":1,"9":1,"_id":"a"}')],
    ["an index key after a non-index key", leafBody('{"_id":"a","9":1}')],
    ["a nested index key after a non-index key", leafBody('{"_id":"a","o":{"b":1,"0":1}}')],
    ["a duplicate envelope member", BASELINE.replace('"level":0', '"level":0,"level":0')],
  ])("canonical-bytes: %s", async (_label, body) => {
    await expectDecodeFailure(decodeBody(body), "canonical-bytes");
  });

  test.each<[string, string]>([
    ["_id after another key", '{"n":1,"_id":"a"}'],
    ["non-index keys in reverse sorted order", '{"_id":"a","z":1,"b":{"y":1,"x":2}}'],
    ["an own __proto__ between keys", '{"_id":"a","__proto__":1,"A":2}'],
    ["a non-index numeric name after a letter", '{"_id":"a","b":1,"01":2,"4294967295":3}'],
  ])("canonical-bytes: keys in writer order decode as written (%s)", async (_label, doc) => {
    // Any order of non-index keys is canonical, so reordering them after
    // encoding gives another canonical body (of a different document),
    // which only the content hash in the key ties to one document.
    const decoded = await decodeBody(leafBody(doc));
    expect(decoded.node.kind).toBe("leaf");
    expect(JSON.stringify((decoded.node as TreeLeafNode).docs[0])).toBe(doc);
  });

  test("context: a level other than the parent's level − 1", async () => {
    const sealed = await sealNode(P, LEAF_A1);
    await expectDecodeFailure(
      decodeNode(sealed.key, sealed.bytes, { prefix: P, root: false, level: 1 }),
      "context",
    );
  });

  test.each([
    ["lo", { lo: "0", hi: "b", rows: 2, bytes: 34 }],
    ["hi", { lo: "a", hi: "c", rows: 2, bytes: 34 }],
    ["rows", { lo: "a", hi: "b", rows: 3, bytes: 34 }],
    ["bytes", { lo: "a", hi: "b", rows: 2, bytes: 33 }],
  ])("context: a parent entry whose %s disagrees with the body", async (_label, parentEntry) => {
    const sealed = await sealNode(P, LEAF_A1);
    await expectDecodeFailure(
      decodeNode(sealed.key, sealed.bytes, {
        prefix: P,
        root: false,
        level: 0,
        entry: parentEntry,
      }),
      "context",
    );
  });

  test("context: a root floor other than the head's", async () => {
    const sealed = await sealNode(P, ROOT_LEAF_A1);
    await expectDecodeFailure(
      decodeNode(sealed.key, sealed.bytes, { prefix: P, root: true, floor: 8 }),
      "context",
    );
  });

  test("an unpaired-surrogate object key decodes only in its canonical lowercase escape", async () => {
    const decoded = await decodeBody(leafBody('{"_id":"a","\\ud800":1}'));
    expect(decoded.node.kind === "leaf" && Object.keys(decoded.node.docs[0]!)).toEqual([
      "_id",
      "\ud800",
    ]);
    await expectDecodeFailure(decodeBody(leafBody('{"_id":"a","\\uD800":1}')), "canonical-bytes");
  });

  test("anything other than a BaerlyError thrown in a check surfaces as InvalidResponse for that check", async () => {
    const throwing = createTreeConfig({
      steps: {
        canonicalBytesMatch: () => {
          throw new RangeError("Maximum call stack size exceeded");
        },
      },
    });
    const bytes = encodeText(BASELINE);
    await expectDecodeFailure(
      decodeNode(await keyOf(bytes), bytes, { prefix: P, root: false }, throwing),
      "canonical-bytes",
    );
  });

  test.each<[string, string]>([
    ["format", BASELINE.replace('"baerly-tree-node-proto"', `"${"f".repeat(1_500_000)}"`)],
    [
      "schema_version",
      BASELINE.replace('"schema_version":1', `"schema_version":"${"9".repeat(1_500_000)}"`),
    ],
    ["collection", BASELINE.replace('"tickets"', `"${"t".repeat(1_500_000)}"`)],
    ["attempt", BASELINE.replace(`"${A1}"`, `"${"a".repeat(1_500_000)}"`)],
    ["an extra field name", leafBody('{"_id":"a","n":1}', `,"${"x".repeat(1_500_000)}":1`)],
    ["an _id", leafBody(`{"_id":"a/${"b".repeat(1_500_000)}"}`)],
    [
      "a branch hi",
      `{"format":"baerly-tree-node-proto","schema_version":1,"collection":"tickets","attempt":"${A1}","level":1,"children":[{"lo":"a","hi":"/${"h".repeat(400_000)}","rows":1,"bytes":17,"attempt":"${A2}","sha256":"${LEAF_A1_SHA}"}]}`,
    ],
  ])("an oversize stored %s is cut, not copied, into the message", async (_label, body) => {
    const error = await decodeBody(body).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(BaerlyError);
    expect((error as BaerlyError).code).toBe("InvalidResponse");
    expect((error as BaerlyError).message.length).toBeLessThan(
      TREE_MESSAGE_KEY_CHARS + TREE_MESSAGE_DETAIL_CHARS + 100,
    );
  });

  test("a key up to the storage key ceiling is echoed whole, a longer one cut", async () => {
    const bytes = encodeText(BASELINE);
    for (const [length, whole] of [
      [TREE_MESSAGE_KEY_CHARS, true],
      [TREE_MESSAGE_KEY_CHARS + 1, false],
    ] as const) {
      const key = `${P}/`.padEnd(length, "k");
      const error = (await decodeNode(key, bytes, { prefix: P, root: false }).catch(
        (error_: unknown) => error_,
      )) as BaerlyError;
      expect(error.message.includes(JSON.stringify(key))).toBe(whole);
    }
  });

  test("a prefix with no valid collection segment is a caller bug: InvalidConfig", async () => {
    const bytes = encodeText(BASELINE);
    const key = await keyOf(bytes);
    for (const prefix of ["", "app/helpdesk/", "app/helpdesk/_tickets", "app/helpdesk/.."]) {
      await expect(decodeNode(key, bytes, { prefix, root: false })).rejects.toMatchObject({
        code: "InvalidConfig",
      });
    }
  });

  test("a schema_version from a newer release says so", async () => {
    const error = await decodeBody(
      BASELINE.replace('"schema_version":1', '"schema_version":2'),
    ).catch((error_: unknown) => error_);
    expect((error as BaerlyError).message).toContain("newer baerly-storage release");
  });
});

describe("check tags", () => {
  /** One failing decode per check, keyed by the tag it must carry. */
  const FAILURES: Record<TreeDecodeCheck, () => Promise<unknown>> = {
    key: async () =>
      decodeNode(`${P}/_v99/gc-pending.json`, encodeText(BASELINE), { prefix: P, root: false }),
    present: async () =>
      decodeNode(treeNodeKey(P, A1, LEAF_A1_SHA), null, { prefix: P, root: false }),
    "leaf-ceiling": async () =>
      decodeNode(treeNodeKey(P, A1, LEAF_A1_SHA), new Uint8Array(LEAF_MAX_BODY_BYTES + 1), {
        prefix: P,
        root: false,
      }),
    hash: async () =>
      decodeNode(treeNodeKey(P, A1, LEAF_A1_SHA), encodeText(BASELINE), { prefix: P, root: false }),
    "utf-8": async () => decodeBody(new Uint8Array([0xff])),
    json: async () => decodeBody(BASELINE.slice(0, -1)),
    structure: async () => decodeBody(BASELINE.replace(A1, A2)),
    "canonical-bytes": async () => decodeBody(leafBody('{"_id":"a","n":2.50}')),
    context: async () => {
      const sealed = await sealNode(P, LEAF_A1);
      return decodeNode(sealed.key, sealed.bytes, { prefix: P, root: false, level: 1 });
    },
  };

  test("the tags are exactly the nine check names, in the order the checks run", () => {
    expect(Object.keys(FAILURES)).toEqual([
      "key",
      "present",
      "leaf-ceiling",
      "hash",
      "utf-8",
      "json",
      "structure",
      "canonical-bytes",
      "context",
    ]);
  });

  test.each(Object.keys(FAILURES) as TreeDecodeCheck[])(
    "a %s failure names the key and carries the tag",
    async (check) => {
      const error = await FAILURES[check]().then(
        () => null,
        (error_: unknown) => error_,
      );
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidResponse");
      expect((error as BaerlyError).message).toMatch(
        new RegExp(`^tree node "${P}/_v99/[^"]+": ${check} check failed: `),
      );
    },
  );
});

// ---------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------

describe("encodeNode", () => {
  test("canonicalizes documents and keeps exactly the six entry fields", () => {
    const bytes = encodeNode(leaf([JSON.parse('{"n":2.50,"_id":"a"}') as TreeDocument]));
    expect(text.decode(bytes)).toContain('"docs":[{"n":2.5,"_id":"a"}]');
    const withExtra = {
      ...ROOT_BRANCH_A1,
      children: ROOT_BRANCH_A1.children.map((e) => ({ ...e, node: "ignored" })),
    };
    expect(encodeNode(withExtra)).toEqual(encodeNode(ROOT_BRANCH_A1));
  });

  test.each<[string, TreeLeafNode | TreeBranchNode]>([
    ["empty docs", leaf([])],
    ["unsorted docs", leaf([{ _id: "b" }, { _id: "a" }])],
    ["a bad attempt", leaf([{ _id: "a" }], "xyz")],
    ["root totals that disagree", { ...LEAF_A1, root: { floor: 0, rows: 1, bytes: 34 } }],
    ["a branch at level 0", { ...ROOT_BRANCH_A1, level: 0 }],
    [
      "a level_nodes count other than the child count",
      { ...ROOT_BRANCH_A1, root: { ...ROOT_BRANCH_A1.root!, levelNodes: [3] } },
    ],
    [
      "level_nodes of the wrong length",
      { ...ROOT_BRANCH_A1, root: { ...ROOT_BRANCH_A1.root!, levelNodes: [2, 2] } },
    ],
    [
      "a level more than 256 times the next",
      {
        ...ROOT_BRANCH_A1,
        level: 2,
        root: { ...ROOT_BRANCH_A1.root!, levelNodes: [513, 2] },
      },
    ],
    [
      "a first level_nodes count above rows",
      { ...ROOT_BRANCH_A1, level: 2, root: { ...ROOT_BRANCH_A1.root!, levelNodes: [4, 2] } },
    ],
    [
      "a root branch without level_nodes",
      {
        ...ROOT_BRANCH_A1,
        root: { floor: 7, rows: 3, bytes: 51 } as TreeBranchNode["root"],
      },
    ],
    ["an empty collection name", { ...LEAF_A1, collection: "" }],
    ["a collection name with a /", { ...LEAF_A1, collection: "a/b" }],
    ["a reserved collection name", { ...LEAF_A1, collection: "_tickets" }],
    ["a collection name over 256 bytes", { ...LEAF_A1, collection: "c".repeat(257) }],
    [
      "a symbol-keyed document property",
      leaf([{ _id: "a", [Symbol("k")]: 1 } as unknown as TreeDocument]),
    ],
    [
      "an accessor document property",
      leaf([Object.defineProperty({ _id: "a" }, "v", { get: () => 1, enumerable: true })]),
    ],
    ["a document array hole", leaf([{ _id: "a", v: holey } as unknown as TreeDocument])],
  ])("refuses %s as Internal", (_label, node) => {
    expect(() => encodeNode(node)).toThrow(expect.objectContaining({ code: "Internal" }));
  });

  test("refuses a leaf whose body would exceed the decoder ceiling", () => {
    // Two maximal documents are 2 MiB of document bytes, plus the envelope.
    const docs = ["a", "b"].map((id) => ({
      _id: id,
      p: "y".repeat(MAX_DOCUMENT_BYTES - '{"_id":"a","p":""}'.length),
    }));
    expect(() => encodeNode(leaf(docs))).toThrow(expect.objectContaining({ code: "Internal" }));
    expect(() => encodeNode(leaf(docs.slice(0, 1)))).not.toThrow();
  });

  test("sealNode refuses a node for another collection", async () => {
    await expect(sealNode("app/a/tenant/t/manifests/other", LEAF_A1)).rejects.toMatchObject({
      code: "Internal",
    });
  });

  test("an isolated maximal document fits one leaf with the largest envelope", async () => {
    const collection = '"'.repeat(256);
    const prefix = `app/a/tenant/t/manifests/${collection}`;
    const doc = { _id: "a", p: "y".repeat(MAX_DOCUMENT_BYTES - '{"_id":"a","p":""}'.length) };
    const node: TreeLeafNode = {
      kind: "leaf",
      collection,
      attempt: A1,
      level: 0,
      root: {
        floor: Number.MAX_SAFE_INTEGER,
        rows: 1,
        bytes: MAX_DOCUMENT_BYTES,
      },
      docs: [doc],
    };
    const sealed = await sealNode(prefix, node);
    expect(sealed.bytes.byteLength).toBeLessThanOrEqual(LEAF_MAX_BODY_BYTES);
    const decoded = await decodeNode(sealed.key, sealed.bytes, { prefix, root: true });
    expect(decoded.summary.bytes).toBe(MAX_DOCUMENT_BYTES);
  });
});

// ---------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------

/** IDs drawn from code points where UTF-8 and UTF-16 orders disagree. */
const docId = fc
  .array(fc.constantFrom("a", "b", "é", "\uffff", "\ufffd", "😀", "\u{10000}", "z", "0"), {
    minLength: 1,
    maxLength: 4,
  })
  .map((parts) => parts.join(""));

const docValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.string(),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer(),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(fc.string({ maxLength: 4 }), tie("value"), { maxKeys: 3 }),
  ),
})).value;

const leafNode = fc
  .uniqueArray(fc.record({ _id: docId, v: docValue }), {
    selector: (d) => d._id,
    minLength: 1,
    maxLength: 6,
  })
  .map((docs) => leaf(docs.toSorted((x, y) => compareDocIds(x._id, y._id)) as TreeDocument[]));

describe("round trip", () => {
  fcTest.prop({ node: leafNode })(
    "decode(encode(node)) re-encodes to the same bytes",
    async ({ node }) => {
      const sealed = await sealNode(P, node);
      const decoded = await decodeNode(sealed.key, sealed.bytes, {
        prefix: P,
        root: false,
        level: 0,
        entry: sealed.summary,
      });
      expect(encodeNode(decoded.node)).toEqual(sealed.bytes);
      expect(decoded.summary).toEqual(sealed.summary);
    },
  );
});
