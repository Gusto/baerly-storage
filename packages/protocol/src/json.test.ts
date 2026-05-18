import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { type JSONArrayless, merge } from "./json.ts";

const jsonArrayless = fc.letrec((tie) => ({
  doc: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.string({ minLength: 0, maxLength: 8 }),
    fc.record({ a: tie("doc") }, { requiredKeys: [] }),
    fc.record({ a: tie("doc"), b: tie("doc") }, { requiredKeys: [] }),
  ),
})).doc as fc.Arbitrary<JSONArrayless>;

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
})).doc as fc.Arbitrary<JSONArrayless>;

describe("JSON Merge Patch (RFC 7386)", () => {
  test.prop({ a: jsonArrayless })("identity: merge(a, undefined) === a", ({ a }) => {
    expect(merge(a, undefined)).toEqual(a);
  });

  test("case: merge(0, {}) === {}", () => {
    expect(merge<JSONArrayless>(0, {})).toEqual({});
  });

  test('case: merge({a: ""}, {}) === {a: ""}', () => {
    expect(merge({ a: "" }, {})).toEqual({ a: "" });
  });

  test.prop({ a: jsonArrayless })("deletion: merge(a, null) === undefined", ({ a }) => {
    expect(merge(a, null)).toBeUndefined();
  });

  test("case: merge(true, {a: {}}) === {a: {}}", () => {
    expect(merge<JSONArrayless>(true, { a: {} })).toEqual({ a: {} });
  });

  test("case: merge({}, {a: {}}) === {a: {}}", () => {
    expect(merge({}, { a: {} })).toEqual({ a: {} });
  });

  test("case: merge({a: false}, true) === true", () => {
    expect(merge<JSONArrayless>({ a: false }, true)).toEqual(true);
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

  test.prop({ a: jsonArrayless })("idempotent: merge(a, a) === a", ({ a }) => {
    expect(merge(a, a)).toEqual(a);
  });

  test("rejects __proto__ / constructor / prototype keys (prototype pollution)", () => {
    // Object literal `{ __proto__: ... }` is a prototype-setter, not an
    // own key — use JSON.parse so the key becomes an actual own property
    // of the patch, mirroring how a malicious HTTP PATCH body would arrive.
    const target = { safe: 1 } as JSONArrayless;
    const polluted = merge(target, JSON.parse('{"__proto__":{"polluted":true}}'));
    expect((polluted as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);

    const ctor = merge(target, { constructor: "x" } as unknown as Partial<JSONArrayless>);
    expect((ctor as Record<string, unknown>).constructor).toBe(Object);

    const proto = merge(target, { prototype: "x" } as unknown as Partial<JSONArrayless>);
    expect((proto as Record<string, unknown>).prototype).toBeUndefined();
  });

});
