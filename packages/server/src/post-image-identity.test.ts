import { fc, test as fcTest } from "@fast-check/vitest";
import { BaerlyError, type DocumentData } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  docIdNearPairArb,
  invalidDocIdArb,
  validDocIdArb,
} from "../../../tests/fixtures/scalar-doc-id-arbitraries.ts";
import { foldChunkedSnapshotReference } from "./chunked-snapshot-reference.ts";
import { assertPostImageIdentity } from "./post-image-identity.ts";
import type { CodecCode, CodecFail } from "./snapshot-codec.ts";

const polarities = ["InvalidConfig", "InvalidResponse"] as const satisfies readonly CodecCode[];

const outcome = (run: () => void): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    return (error as BaerlyError).code;
  }
};

const withAccessor = (): object =>
  Object.defineProperty({}, "_id", { get: () => "a", enumerable: true });
const withHiddenId = (): object =>
  Object.defineProperty({}, "_id", { value: "a", enumerable: false });
class Row {
  readonly _id = "a";
}

describe("assertPostImageIdentity", () => {
  test.each([
    ["a minimal post-image", "a", { _id: "a" }],
    ["extra fields", "a", { value: 1, nested: { _id: "b" }, _id: "a" }],
    ["a null-prototype object", "a", Object.assign(Object.create(null), { _id: "a" })],
    ["a frozen object", "é", Object.freeze({ _id: "é" })],
    ["an astral ID", "\u{1f600}", { _id: "\u{1f600}" }],
  ])("accepts %s", (_name, docId, after) => {
    for (const code of polarities) {
      expect(outcome(() => assertPostImageIdentity(docId, after, code))).toBeUndefined();
    }
  });

  test.each([
    ["_id missing", "a", { value: 1 }],
    ["_id a number", "1", { _id: 1 }],
    ["_id null", "a", { _id: null }],
    ["_id an accessor", "a", withAccessor()],
    ["_id non-enumerable", "a", withHiddenId()],
    ["_id inherited from a non-plain prototype", "a", Object.create({ _id: "a" })],
    ["_id the NFD spelling of an NFC doc_id", "é", { _id: "e\u0301" }],
    ["_id the NFC spelling of an NFD doc_id", "e\u0301", { _id: "é" }],
    ["_id differing by case", "a", { _id: "A" }],
    ["_id a proper prefix of doc_id", "ab", { _id: "a" }],
    ["doc_id a proper prefix of _id", "a", { _id: "ab" }],
    ["after an array", "a", Object.assign([], { _id: "a" })],
    [
      "after a null-prototype array",
      "a",
      Object.setPrototypeOf(Object.assign([], { _id: "a" }), null),
    ],
    ["after null", "a", null],
    ["after a string", "a", "a"],
    ["after undefined", "a", undefined],
    ["after a class instance", "a", new Row()],
    ["after a Map", "a", new Map([["_id", "a"]])],
    ["after a Date", "a", Object.assign(new Date(0), { _id: "a" })],
  ])("rejects %s under both polarities", (_name, docId, after) => {
    for (const code of polarities) {
      expect(outcome(() => assertPostImageIdentity(docId, after, code))).toBe(code);
    }
  });

  test("rejects an _id inherited from Object.prototype", () => {
    // eslint-disable-next-line no-extend-native -- the only way to give a plain object an inherited _id; removed in finally
    Object.defineProperty(Object.prototype, "_id", { value: "a", configurable: true });
    try {
      expect("_id" in {}).toBe(true);
      for (const code of polarities) {
        expect(outcome(() => assertPostImageIdentity("a", {}, code))).toBe(code);
      }
    } finally {
      delete (Object.prototype as { _id?: unknown })._id;
    }
    expect("_id" in {}).toBe(false);
  });

  test("reports through fail when given", () => {
    const calls: CodecCode[] = [];
    const fail: CodecFail = (code, message) => {
      calls.push(code);
      throw new BaerlyError(code, `custom: ${message}`);
    };
    expect(outcome(() => assertPostImageIdentity("a", { _id: "b" }, "InvalidResponse", fail))).toBe(
      "InvalidResponse",
    );
    expect(calls).toEqual(["InvalidResponse"]);
    assertPostImageIdentity("a", { _id: "a" }, "InvalidConfig", fail);
    expect(calls).toEqual(["InvalidResponse"]);
  });

  // The identity-only contract: `docId` is not checked against the domain.
  test.each(["_reserved", "a/b", "", ".", "\ud800", "x".repeat(300), "nul\u0000"])(
    "does not reject the invalid-domain doc_id %j when _id matches",
    (docId) => {
      for (const code of polarities) {
        expect(outcome(() => assertPostImageIdentity(docId, { _id: docId }, code))).toBeUndefined();
      }
    },
  );

  const valueArb: fc.Arbitrary<DocumentData[string]> = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.array(fc.integer(), { maxLength: 3 }),
    fc.dictionary(fc.stringMatching(/^[a-z]{1,4}$/), fc.integer(), { maxKeys: 3 }),
  );
  const bodyArb = fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), valueArb, { maxKeys: 4 });
  // `_id` candidates relative to `docId`: equal, a near-colliding valid ID,
  // an unrelated valid ID, an out-of-domain string, a non-string, or absent.
  const caseArb = fc.oneof(
    fc.tuple(validDocIdArb, bodyArb).map(([docId, body]) => ({ docId, body, id: docId })),
    fc
      .tuple(docIdNearPairArb, fc.boolean(), bodyArb)
      .map(([{ left, right }, swap, body]) =>
        swap ? { docId: right, body, id: left } : { docId: left, body, id: right },
      ),
    fc
      .tuple(validDocIdArb, validDocIdArb, bodyArb)
      .map(([docId, id, body]) => ({ docId, body, id })),
    fc
      .tuple(validDocIdArb, invalidDocIdArb, bodyArb)
      .map(([docId, { id }, body]) => ({ docId, body, id })),
    fc
      .tuple(validDocIdArb, fc.oneof(fc.integer(), fc.boolean()), bodyArb)
      .map(([docId, id, body]) => ({ docId, body, id })),
    fc.tuple(validDocIdArb, bodyArb).map(([docId, body]) => ({ docId, body, id: undefined })),
  );

  fcTest.prop({ input: caseArb })(
    "agrees with the reference fold's own post-image identity check",
    ({ input: { docId, body, id } }) => {
      const after = (id === undefined ? { ...body } : { ...body, _id: id }) as DocumentData;
      const primitive = outcome(() => assertPostImageIdentity(docId, after, "InvalidResponse"));
      const reference = outcome(() =>
        foldChunkedSnapshotReference([], [{ op: "I", doc_id: docId, after }]),
      );
      expect(primitive).toBe(reference);
      expect(primitive === undefined).toBe(id === docId);
    },
  );
});
