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

describe("JSON Merge Patch (RFC 7386)", () => {
  test.prop({ a: documentValueArb })("identity: merge(a, undefined) === a", ({ a }) => {
    expect(merge(a, undefined)).toEqual(a);
  });

  // Concrete identity cases: kills L48 BlockStatement (fallthrough returns undefined, not target)
  // and L48 ConditionalExpression→false (never returns target).
  test("identity: merge({a:1}, undefined) === {a:1} — kills L48 block/cond mutants", () => {
    expect(merge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test("identity: merge(42, undefined) === 42 — kills L48 block/cond mutants for primitives", () => {
    expect(merge<DocumentValue>(42, undefined)).toBe(42);
  });

  test("case: merge(0, {}) === {}", () => {
    expect(merge<DocumentValue>(0, {})).toEqual({});
  });

  test('case: merge({a: ""}, {}) === {a: ""}', () => {
    expect(merge({ a: "" }, {})).toEqual({ a: "" });
  });

  // Concrete null deletion: kills L51 BlockStatement (fallthrough returns null, not undefined)
  // and L51 ConditionalExpression→false (never executes return undefined).
  test("deletion: merge({a:1}, null) === undefined — kills L51 block/cond mutants", () => {
    expect(merge<DocumentValue>({ a: 1 }, null)).toBeUndefined();
  });

  test("deletion: merge(42, null) === undefined — kills L51 block/cond mutants for primitives", () => {
    expect(merge<DocumentValue>(42, null)).toBeUndefined();
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

  // Null-value in patch deletes the key: kills L73 NoCoverage BlockStatement
  // (delete skipped → key survives with undefined) and L73 ConditionalExpression→false.
  // Use toStrictEqual (not toEqual) — toEqual ignores {a:undefined} vs {b:2}, which would
  // let the mutation survive (merge(1,null)→undefined stored as combined[a]=undefined).
  test("null patch value deletes key from result — kills L73 NoCov BlockStatement", () => {
    const target = { a: 1, b: 2 } as DocumentValue;
    const out = merge(target, { a: null } as unknown as Partial<DocumentValue>);
    expect(Object.prototype.hasOwnProperty.call(out, "a")).toBe(false);
    expect(out).toStrictEqual({ b: 2 });
  });

  test("null patch value on nested key deletes it, siblings survive", () => {
    const target = { x: { p: 1, q: 2 } } as DocumentValue;
    const out = merge(target, { x: { p: null } } as unknown as Partial<DocumentValue>);
    expect(out).toStrictEqual({ x: { q: 2 } });
    expect(
      Object.prototype.hasOwnProperty.call(
        (out as Record<string, Record<string, unknown>>)["x"],
        "p",
      ),
    ).toBe(false);
  });

  // isPlainObject must return false for non-objects: kills L32 ConditionalExpression→true.
  // When the patch is a number, isPlainObject(patch) must be false so we replace wholesale.
  // If isPlainObject were always true, the number patch would be iterated as an object (no own
  // keys), producing a copy of target {} instead of the scalar 99.
  test("scalar patch replaces object target — isPlainObject(number)===false (kills L32 cond→true)", () => {
    const target = { a: 1 } as DocumentValue;
    expect(merge(target, 99 as unknown as Partial<DocumentValue>)).toBe(99);
  });

  test("isPlainObject(array)===false: array patch replaces object target — kills L32 cond→true", () => {
    // An array should not be treated as a plain object; it replaces wholesale.
    const target = { a: 1 } as DocumentValue;
    const out = merge(target, [1, 2] as unknown as Partial<DocumentValue>);
    expect(out).toEqual([1, 2]);
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

  describe("array values (RFC 7386 §1: opaque replacement)", () => {
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
      const out = merge<DocumentValue>({ items: [{ id: 1, name: "old" }] }, {
        items: [{ id: 1 }],
      } as Partial<DocumentValue>);
      // RFC 7386: the array is replaced — `name: "old"` is gone.
      expect(out).toEqual({ items: [{ id: 1 }] });
    });

    test("array sibling: other keys deep-merge as normal", () => {
      const out = merge<DocumentValue>({ tags: ["a"], meta: { version: 1, author: "alice" } }, {
        tags: ["b"],
        meta: { version: 2 },
      } as Partial<DocumentValue>);
      expect(out).toEqual({
        tags: ["b"],
        meta: { version: 2, author: "alice" },
      });
    });

    test("null inside array is preserved (array is opaque)", () => {
      const out = merge<DocumentValue>({ tags: ["a"] }, {
        tags: [null, "b"],
      } as unknown as Partial<DocumentValue>);
      expect(out).toEqual({ tags: [null, "b"] });
    });
  });
});
