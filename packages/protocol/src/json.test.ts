import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { type DocumentValue, merge } from "./json.ts";

const documentValueArb = fc.letrec((tie) => ({
  doc: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.string({ minLength: 0, maxLength: 8 }),
    fc.record({ a: tie("doc") }, { requiredKeys: [] }),
    fc.record({ a: tie("doc"), b: tie("doc") }, { requiredKeys: [] }),
    fc.array(tie("doc"), { minLength: 0, maxLength: 4 }),
  ),
})).doc as fc.Arbitrary<DocumentValue>;

// Mirrors the original `rndStructuredDoc`: objects whose keys are
// type-partitioned — `scalar-N` always holds a primitive, `subdoc-N`
// always holds another object. `merge` is not associative when a key
// in one operand holds a scalar but the same key in another operand
// holds an object (the merge of patch into a scalar target replaces
// the target wholesale, losing structure). The original test avoided
// that case by construction; preserve that intent here.
const jsonStructuredDoc = fc.letrec((tie) => ({
  doc: fc.record(
    {
      "scalar-0": tie("scalar"),
      "scalar-1": tie("scalar"),
      "subdoc-0": tie("doc"),
      "subdoc-1": tie("doc"),
    },
    { requiredKeys: [] },
  ),
  scalar: fc.oneof(
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.string({ minLength: 0, maxLength: 8 }),
  ),
})).doc as fc.Arbitrary<DocumentValue>;

describe("JSON Merge Patch (RFC 7396)", () => {
  test.prop({ a: documentValueArb })("identity: merge(a, undefined) === a", ({ a }) => {
    expect(merge(a, undefined)).toEqual(a);
  });

  test("case: merge(0, {}) === {}", () => {
    expect(merge<DocumentValue>(0, {})).toEqual({});
  });

  test('case: merge({a: ""}, {}) === {a: ""}', () => {
    expect(merge({ a: "" }, {})).toEqual({ a: "" });
  });

  test.prop({ a: documentValueArb })("deletion: merge(a, null) === undefined", ({ a }) => {
    expect(merge(a, null)).toBeUndefined();
  });

  test("case: merge(true, {a: {}}) === {a: {}}", () => {
    expect(merge<DocumentValue>(true, { a: {} })).toEqual({ a: {} });
  });

  test("case: merge({}, {a: {}}) === {a: {}}", () => {
    expect(merge({}, { a: {} })).toEqual({ a: {} });
  });

  test("case: merge({a: false}, true) === true", () => {
    expect(merge<DocumentValue>({ a: false }, true)).toEqual(true);
  });

  test.prop({
    a: jsonStructuredDoc,
    b: jsonStructuredDoc,
    c: jsonStructuredDoc,
  })(
    "associative: merge(a, merge(b, c)) === merge(merge(a, b), c) for structured docs",
    ({ a, b, c }) => {
      expect(merge(a, merge(b, c))).toEqual(merge(merge(a, b), c));
    },
  );

  test.prop({ a: documentValueArb })("idempotent: merge(a, a) === a", ({ a }) => {
    expect(merge(a, a)).toEqual(a);
  });

  test("rejects __proto__ / constructor / prototype keys (prototype pollution)", () => {
    // Object literal `{ __proto__: ... }` is a prototype-setter, not an
    // own key — use JSON.parse so the key becomes an actual own property
    // of the patch, mirroring how a malicious HTTP PATCH body would arrive.
    const target = { safe: 1 } as DocumentValue;
    const polluted = merge(target, JSON.parse('{"__proto__":{"polluted":true}}'));
    expect((polluted as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);

    const ctor = merge(target, { constructor: "x" } as unknown as Partial<DocumentValue>);
    expect((ctor as Record<string, unknown>).constructor).toBe(Object);

    const proto = merge(target, { prototype: "x" } as unknown as Partial<DocumentValue>);
    expect((proto as Record<string, unknown>)["prototype"]).toBeUndefined();
  });

  describe("array values (RFC 7396 §1: opaque replacement)", () => {
    test("nested array is replaced wholesale, not element-merged", () => {
      // The pre-fix bug: merge spread the array as an object and emitted
      // `{tags: {"0":"c","1":"b"}}` for this exact input.
      const out = merge({ tags: ["a", "b"] }, { tags: ["c"] });
      expect(out).toEqual({ tags: ["c"] });
    });

    test("shrinking patch fully replaces longer target array", () => {
      const out = merge({ tags: ["a", "b", "c"] }, { tags: ["x"] });
      expect(out).toEqual({ tags: ["x"] });
    });

    test("growing patch fully replaces shorter target array", () => {
      const out = merge({ tags: ["a"] }, { tags: ["x", "y", "z"] });
      expect(out).toEqual({ tags: ["x", "y", "z"] });
    });

    test("empty array patch clears the field to []", () => {
      const out = merge({ tags: ["a", "b"] }, { tags: [] });
      expect(out).toEqual({ tags: [] });
    });

    test("array patch replaces an object target wholesale", () => {
      const out = merge<DocumentValue>({ a: 1 }, [1, 2, 3] as unknown as Partial<DocumentValue>);
      expect(out).toEqual([1, 2, 3]);
    });

    test("object patch replaces an array target wholesale", () => {
      const out = merge<DocumentValue>(
        [1, 2, 3] as DocumentValue,
        { a: 1 } as unknown as Partial<DocumentValue>,
      );
      expect(out).toEqual({ a: 1 });
    });

    test("array of objects: elements are not deep-merged", () => {
      const out = merge<DocumentValue>(
        { items: [{ id: 1, name: "old" }] },
        { items: [{ id: 1 }] } as Partial<DocumentValue>,
      );
      // RFC 7396: the array is replaced — `name: "old"` is gone.
      expect(out).toEqual({ items: [{ id: 1 }] });
    });

    test("array sibling: other keys deep-merge as normal", () => {
      const out = merge<DocumentValue>(
        { tags: ["a"], meta: { version: 1, author: "alice" } },
        { tags: ["b"], meta: { version: 2 } } as Partial<DocumentValue>,
      );
      expect(out).toEqual({
        tags: ["b"],
        meta: { version: 2, author: "alice" },
      });
    });

    test("null inside array is preserved (array is opaque)", () => {
      const out = merge<DocumentValue>(
        { tags: ["a"] },
        { tags: [null, "b"] } as unknown as Partial<DocumentValue>,
      );
      expect(out).toEqual({ tags: [null, "b"] });
    });
  });
});
