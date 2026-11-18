import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  applyMergePatch,
  coalesceMergePatches,
  type DocumentValue,
  type JSONValue,
  jsonValueEqual,
} from "./json.ts";

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
  fcTest.prop({ a: documentValueArb })("identity: applyMergePatch(a, undefined) === a", ({ a }) => {
    expect(applyMergePatch(a, undefined)).toEqual(a);
  });

  // Concrete identity cases: kills L48 BlockStatement (fallthrough returns undefined, not target)
  // and L48 ConditionalExpression→false (never returns target).
  test("identity: applyMergePatch({a:1}, undefined) === {a:1} — kills L48 block/cond mutants", () => {
    expect(applyMergePatch({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  test("identity: applyMergePatch(42, undefined) === 42 — kills L48 block/cond mutants for primitives", () => {
    expect(applyMergePatch<DocumentValue>(42, undefined)).toBe(42);
  });

  test("case: applyMergePatch(0, {}) === {}", () => {
    expect(applyMergePatch<DocumentValue>(0, {})).toEqual({});
  });

  test('case: applyMergePatch({a: ""}, {}) === {a: ""}', () => {
    expect(applyMergePatch({ a: "" }, {})).toEqual({ a: "" });
  });

  // Concrete null deletion: kills L51 BlockStatement (fallthrough returns null, not undefined)
  // and L51 ConditionalExpression→false (never executes return undefined).
  test("deletion: applyMergePatch({a:1}, null) === undefined — kills L51 block/cond mutants", () => {
    expect(applyMergePatch<DocumentValue>({ a: 1 }, null)).toBeUndefined();
  });

  test("deletion: applyMergePatch(42, null) === undefined — kills L51 block/cond mutants for primitives", () => {
    expect(applyMergePatch<DocumentValue>(42, null)).toBeUndefined();
  });

  fcTest.prop({ a: documentValueArb })(
    "deletion: applyMergePatch(a, null) === undefined",
    ({ a }) => {
      expect(applyMergePatch(a, null)).toBeUndefined();
    },
  );

  test("case: applyMergePatch(true, {a: {}}) === {a: {}}", () => {
    expect(applyMergePatch<DocumentValue>(true, { a: {} })).toEqual({ a: {} });
  });

  test("case: applyMergePatch({}, {a: {}}) === {a: {}}", () => {
    expect(applyMergePatch({}, { a: {} })).toEqual({ a: {} });
  });

  test("case: applyMergePatch({a: false}, true) === true", () => {
    expect(applyMergePatch<DocumentValue>({ a: false }, true)).toEqual(true);
  });

  fcTest.prop({
    a: jsonStructuredDoc,
    b: jsonStructuredDoc,
    c: jsonStructuredDoc,
  })(
    "coalescing: apply(a, coalesce(b, c)) === apply(apply(a, b), c) for structured docs",
    ({ a, b, c }) => {
      expect(applyMergePatch(a, coalesceMergePatches(b, c))).toEqual(
        applyMergePatch(applyMergePatch(a, b), c),
      );
    },
  );

  fcTest.prop({ a: documentValueArb })("idempotent: applyMergePatch(a, a) === a", ({ a }) => {
    expect(applyMergePatch(a, a)).toEqual(a);
  });

  // Null-value in patch deletes the key: kills L73 NoCoverage BlockStatement
  // (delete skipped → key survives with undefined) and L73 ConditionalExpression→false.
  // Use toStrictEqual (not toEqual) — toEqual ignores {a:undefined} vs {b:2}, which would
  // let the mutation survive (applyMergePatch(1,null)→undefined stored as combined[a]=undefined).
  test("null patch value deletes key from result — kills L73 NoCov BlockStatement", () => {
    const target = { a: 1, b: 2 } as DocumentValue;
    const out = applyMergePatch(target, { a: null } as unknown as Partial<DocumentValue>);
    expect(Object.prototype.hasOwnProperty.call(out, "a")).toBe(false);
    expect(out).toStrictEqual({ b: 2 });
  });

  test("null patch value on nested key deletes it, siblings survive", () => {
    const target = { x: { p: 1, q: 2 } } as DocumentValue;
    const out = applyMergePatch(target, { x: { p: null } } as unknown as Partial<DocumentValue>);
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
    expect(applyMergePatch(target, 99 as unknown as Partial<DocumentValue>)).toBe(99);
  });

  test("isPlainObject(array)===false: array patch replaces object target — kills L32 cond→true", () => {
    // An array should not be treated as a plain object; it replaces wholesale.
    const target = { a: 1 } as DocumentValue;
    const out = applyMergePatch(target, [1, 2] as unknown as Partial<DocumentValue>);
    expect(out).toEqual([1, 2]);
  });

  test("rejects __proto__ / constructor / prototype keys (prototype pollution)", () => {
    // Object literal `{ __proto__: ... }` is a prototype-setter, not an
    // own key — use JSON.parse so the key becomes an actual own property
    // of the patch, mirroring how a malicious HTTP PATCH body would arrive.
    const target = { safe: 1 } as DocumentValue;
    const polluted = applyMergePatch(target, JSON.parse('{"__proto__":{"polluted":true}}'));
    expect((polluted as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);

    const ctor = applyMergePatch(target, { constructor: "x" } as unknown as Partial<DocumentValue>);
    expect((ctor as Record<string, unknown>).constructor).toBe(Object);

    const proto = applyMergePatch(target, { prototype: "x" } as unknown as Partial<DocumentValue>);
    expect((proto as Record<string, unknown>)["prototype"]).toBeUndefined();
  });

  describe("array values (RFC 7386 §1: opaque replacement)", () => {
    test("nested array is replaced wholesale, not element-merged", () => {
      // The pre-fix bug: merge spread the array as an object and emitted
      // `{tags: {"0":"c","1":"b"}}` for this exact input.
      const out = applyMergePatch({ tags: ["a", "b"] }, { tags: ["c"] });
      expect(out).toEqual({ tags: ["c"] });
    });

    test("shrinking patch fully replaces longer target array", () => {
      const out = applyMergePatch({ tags: ["a", "b", "c"] }, { tags: ["x"] });
      expect(out).toEqual({ tags: ["x"] });
    });

    test("growing patch fully replaces shorter target array", () => {
      const out = applyMergePatch({ tags: ["a"] }, { tags: ["x", "y", "z"] });
      expect(out).toEqual({ tags: ["x", "y", "z"] });
    });

    test("empty array patch clears the field to []", () => {
      const out = applyMergePatch({ tags: ["a", "b"] }, { tags: [] });
      expect(out).toEqual({ tags: [] });
    });

    test("array patch replaces an object target wholesale", () => {
      const out = applyMergePatch<DocumentValue>({ a: 1 }, [
        1, 2, 3,
      ] as unknown as Partial<DocumentValue>);
      expect(out).toEqual([1, 2, 3]);
    });

    test("object patch replaces an array target wholesale", () => {
      const out = applyMergePatch<DocumentValue>(
        [1, 2, 3] as DocumentValue,
        { a: 1 } as unknown as Partial<DocumentValue>,
      );
      expect(out).toEqual({ a: 1 });
    });

    test("array of objects: elements are not deep-merged", () => {
      const out = applyMergePatch<DocumentValue>({ items: [{ id: 1, name: "old" }] }, {
        items: [{ id: 1 }],
      } as Partial<DocumentValue>);
      // RFC 7386: the array is replaced — `name: "old"` is gone.
      expect(out).toEqual({ items: [{ id: 1 }] });
    });

    test("array sibling: other keys deep-merge as normal", () => {
      const out = applyMergePatch<DocumentValue>(
        { tags: ["a"], meta: { version: 1, author: "alice" } },
        {
          tags: ["b"],
          meta: { version: 2 },
        } as Partial<DocumentValue>,
      );
      expect(out).toEqual({
        tags: ["b"],
        meta: { version: 2, author: "alice" },
      });
    });

    test("null inside array is preserved (array is opaque)", () => {
      const out = applyMergePatch<DocumentValue>({ tags: ["a"] }, {
        tags: [null, "b"],
      } as unknown as Partial<DocumentValue>);
      expect(out).toEqual({ tags: [null, "b"] });
    });
  });

  // RFC 7396 Appendix A, row by row: the input->output table a port must
  // reproduce. `target`, `patch` and `expected` may carry `null` (a stored
  // null from an earlier release, a delete, or a value inside an array).
  describe("RFC 7396 Appendix A vectors", () => {
    const rows: Array<[number, unknown, unknown, unknown]> = [
      [1, { a: "b" }, { a: "c" }, { a: "c" }],
      [2, { a: "b" }, { b: "c" }, { a: "b", b: "c" }],
      [3, { a: "b" }, { a: null }, {}],
      [4, { a: "b", b: "c" }, { a: null }, { b: "c" }],
      [5, { a: ["b"] }, { a: "c" }, { a: "c" }],
      [6, { a: "c" }, { a: ["b"] }, { a: ["b"] }],
      [7, { a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
      [8, { a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
      [9, ["a", "b"], ["c", "d"], ["c", "d"]],
      [10, { a: "b" }, ["c"], ["c"]],
      // Row 11 (`null` patch → `null`): a document cannot be `null`, so a
      // root `null` patch returns `undefined`. Asserted separately below.
      [12, { a: "foo" }, "bar", "bar"],
      // A null stored by an earlier release is left alone.
      [13, { e: null }, { a: 1 }, { e: null, a: 1 }],
      [14, [1, 2], { a: "b", c: null }, { a: "b" }],
      [15, {}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
    ];
    for (const [row, target, patch, expected] of rows) {
      test(`row ${row}: ${JSON.stringify(target)} + ${JSON.stringify(patch)}`, () => {
        expect(
          applyMergePatch(target as DocumentValue, patch as Partial<DocumentValue>),
        ).toStrictEqual(expected);
      });
    }

    test("row 11: a root null patch returns undefined", () => {
      expect(applyMergePatch<DocumentValue>({ a: "foo" }, null)).toBeUndefined();
    });

    test("a patch object under an absent field stores no null member", () => {
      expect(
        applyMergePatch<DocumentValue>({ _id: "x" }, {
          meta: { a: 1, b: null },
        } as unknown as Partial<DocumentValue>),
      ).toStrictEqual({ _id: "x", meta: { a: 1 } });
    });

    test("an undefined patch member is absent", () => {
      const out = applyMergePatch<DocumentValue>({ a: 1 }, {
        a: undefined,
        b: undefined,
      } as unknown as Partial<DocumentValue>);
      expect(out).toStrictEqual({ a: 1 });
    });

    test("does not mutate the target", () => {
      const target = { a: { b: 1 } };
      applyMergePatch<DocumentValue>(target, {
        a: { b: null, c: 2 },
      } as unknown as Partial<DocumentValue>);
      expect(target).toStrictEqual({ a: { b: 1 } });
    });
  });

  // Coalescing (patch onto patch) keeps deletion intent where application
  // drops it: an object patch over an absent or non-object accumulator is
  // taken as written. See docs/spec/json-merge-patch.md, "Log can be
  // coalesced".
  describe("coalesceMergePatches", () => {
    const rows: Array<[string, DocumentValue | undefined, unknown, unknown]> = [
      ["the undefined accumulator keeps a delete", undefined, { x: null }, { x: null }],
      [
        "a nested delete under an absent key is kept",
        {},
        { a: { bb: { ccc: null } } },
        { a: { bb: { ccc: null } } },
      ],
      [
        "an object patch over an array is taken as written",
        [1, 2],
        { a: "b", c: null },
        { a: "b", c: null },
      ],
      ["scalars replace", { a: 1 }, { a: 2 }, { a: 2 }],
    ];
    for (const [id, earlier, later, expected] of rows) {
      test(id, () => {
        expect(coalesceMergePatches(earlier, later as Partial<DocumentValue>)).toStrictEqual(
          expected,
        );
      });
    }

    fcTest.prop({
      patches: fc.array(jsonStructuredDoc, { maxLength: 4 }),
      base: jsonStructuredDoc,
    })(
      "a delete-free structured window folds to one patch with the same effect",
      ({ patches, base }) => {
        const summary = patches.reduce<DocumentValue | undefined>(
          (acc, patch) => coalesceMergePatches(acc, patch),
          undefined,
        );
        const sequential = patches.reduce<DocumentValue | undefined>(
          (state, patch) => applyMergePatch(state, patch),
          base,
        );
        expect(applyMergePatch(base, summary)).toEqual(sequential);
      },
    );
  });

  describe("RFC 7396 reference equivalence", () => {
    // RFC 7396 §2's MergePatch pseudocode, transcribed literally.
    const rfc7396 = (target: unknown, patch: unknown): unknown => {
      if (patch !== null && typeof patch === "object" && !Array.isArray(patch)) {
        const result: Record<string, unknown> =
          target !== null && typeof target === "object" && !Array.isArray(target)
            ? { ...(target as Record<string, unknown>) }
            : {};
        for (const [name, value] of Object.entries(patch)) {
          if (value === null) {
            delete result[name];
          } else {
            result[name] = rfc7396(result[name], value);
          }
        }
        return result;
      }
      return patch;
    };

    // Keys from a small pool, so patches overlap the target; `null` at any
    // depth in both (a target null is one an earlier release stored).
    const jsonWithNulls = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constant(null),
        fc.integer(),
        fc.boolean(),
        fc.string({ maxLength: 4 }),
        fc.array(tie("value"), { maxLength: 3 }),
        fc.dictionary(fc.constantFrom("a", "b", "c", "_id"), tie("value"), { maxKeys: 4 }),
      ),
    })).value;

    fcTest.prop({ target: jsonWithNulls, patch: jsonWithNulls })(
      "applyMergePatch equals the RFC 7396 algorithm",
      ({ target, patch }) => {
        const expected = patch === null ? undefined : rfc7396(target, patch);
        expect(
          applyMergePatch(target as DocumentValue, patch as Partial<DocumentValue>),
        ).toStrictEqual(expected);
      },
    );
  });
});

describe("jsonValueEqual", () => {
  test.each(["object", "array"])(
    "compares deeply nested %s values without stack overflow",
    (kind) => {
      // Built by a loop, not a JSON round-trip: V8's `JSON.stringify` recurses
      // and overflows at depths a recursive comparator would survive.
      const build = (leaf: number): JSONValue => {
        let value: JSONValue = { leaf };
        for (let i = 0; i < 100_000; i++) {
          value = kind === "object" ? { nested: value } : [value];
        }
        return value;
      };
      expect(jsonValueEqual(build(1), build(1))).toBe(true);
      expect(jsonValueEqual(build(1), build(2))).toBe(false);
    },
  );

  const eq: Array<[string, JSONValue, JSONValue]> = [
    ["permuted keys", { a: 1, b: 2 }, { b: 2, a: 1 }],
    [
      "nested permuted keys",
      { a: { x: 1, y: [{ p: 1, q: 2 }] }, b: null },
      { b: null, a: { y: [{ q: 2, p: 1 }], x: 1 } },
    ],
    ["identical arrays", [1, "a", null, true], [1, "a", null, true]],
    ["null", null, null],
    ["empty object and array", { a: {}, b: [] }, { b: [], a: {} }],
  ];
  for (const [id, a, b] of eq) {
    test(`equal: ${id}`, () => {
      expect(jsonValueEqual(a, b)).toBe(true);
      expect(jsonValueEqual(b, a)).toBe(true);
    });
  }

  const ne: Array<[string, JSONValue, JSONValue]> = [
    ["array vs index-keyed object", [1], { "0": 1 }],
    ["array order", [1, 2], [2, 1]],
    ["array length", [1], [1, 1]],
    ["extra key", { a: 1 }, { a: 1, b: 2 }],
    ["same size, different key", { a: 1 }, { b: 1 }],
    ["null vs {}", null, {}],
    ["null vs []", null, []],
    ["string vs number", "1", 1],
    ["nested value differs", { a: { b: 1 } }, { a: { b: 2 } }],
    ["own __proto__ key vs other key", JSON.parse('{"__proto__":{}}') as JSONValue, { x: 1 }],
  ];
  for (const [id, a, b] of ne) {
    test(`unequal: ${id}`, () => {
      expect(jsonValueEqual(a, b)).toBe(false);
      expect(jsonValueEqual(b, a)).toBe(false);
    });
  }
});

describe("jsonValueEqual — properties", () => {
  // JSON round-trip normalizes -0 to 0 and drops undefined.
  const jsonArb = fc.jsonValue().map((v) => JSON.parse(JSON.stringify(v)) as JSONValue);

  const shuffleKeys = (v: JSONValue): JSONValue => {
    if (Array.isArray(v)) {
      return v.map(shuffleKeys);
    }
    if (v !== null && typeof v === "object") {
      // fromEntries defines own properties, so an own `__proto__` key survives.
      return Object.fromEntries(
        Object.entries(v)
          .toReversed()
          .map(([k, x]) => [k, shuffleKeys(x)]),
      );
    }
    return v;
  };

  const canonicalStringify = (v: JSONValue): string => {
    if (Array.isArray(v)) {
      return `[${v.map(canonicalStringify).join(",")}]`;
    }
    if (v !== null && typeof v === "object") {
      const body = Object.keys(v)
        .toSorted()
        .map((k) => `${JSON.stringify(k)}:${canonicalStringify(v[k]!)}`);
      return `{${body.join(",")}}`;
    }
    return JSON.stringify(v);
  };

  fcTest.prop([jsonArb])("equals a key-shuffled structural clone", (x) => {
    expect(jsonValueEqual(x, shuffleKeys(structuredClone(x)))).toBe(true);
  });

  fcTest.prop([jsonArb, jsonArb])("agrees with canonical stringification", (x, y) => {
    expect(jsonValueEqual(x, y)).toBe(canonicalStringify(x) === canonicalStringify(y));
  });
});
