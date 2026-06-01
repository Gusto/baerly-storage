import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import { BaerlyError } from "../errors.ts";
import type { DocumentData, JSONObject } from "../json.ts";

import type { PredicateBuilder } from "./builder.ts";
import { matchesWire } from "./matches.ts";
import { normalizeObject, normalizePredicateArg } from "./normalize.ts";

const expectInvalidConfig = (fn: () => unknown, snippet: string): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    expect((error as BaerlyError).code).toBe("InvalidConfig");
    expect((error as BaerlyError).message).toContain(snippet);
    return;
  }
  throw new Error(`Expected BaerlyError{InvalidConfig}, none thrown`);
};

describe("normalizeObject", () => {
  test("top-level primitive → single eq clause", () => {
    expect(normalizeObject({ status: "open" }, [])).toEqual([
      { op: "eq", field: "status", value: "open" },
    ]);
  });

  test("multi-key object → one eq clause per key, in insertion order", () => {
    expect(normalizeObject({ status: "open", priority: "p1" }, [])).toEqual([
      { op: "eq", field: "status", value: "open" },
      { op: "eq", field: "priority", value: "p1" },
    ]);
  });

  test("nested object → flattened to dotted-path eq clauses", () => {
    expect(normalizeObject({ assignee: { team: "platform" } }, [])).toEqual([
      { op: "eq", field: "assignee.team", value: "platform" },
    ]);
  });

  test("deeply-nested object → fully flattened", () => {
    expect(normalizeObject({ a: { b: { c: 1 } } }, [])).toEqual([
      { op: "eq", field: "a.b.c", value: 1 },
    ]);
  });

  test("empty object emits zero clauses (match-all)", () => {
    expect(normalizeObject({}, [])).toEqual([]);
  });

  test("nested empty object emits zero clauses for that subtree", () => {
    // Mirrors the matcher's pre-redesign open-world acceptance of
    // `{ assignee: {} }` against any non-null `assignee`.
    expect(normalizeObject({ assignee: {} }, [])).toEqual([]);
  });

  test('rejects "$"-prefixed key with the documented wording', () => {
    expectInvalidConfig(() => normalizeObject({ $or: "x" }, []), '"$or"');
    expectInvalidConfig(() => normalizeObject({ $or: "x" }, []), "operator vocabulary");
  });

  test("rejects __proto__ / constructor / prototype as reserved keys", () => {
    expectInvalidConfig(() => normalizeObject(JSON.parse('{"__proto__":"x"}'), []), "__proto__");
    expectInvalidConfig(() => normalizeObject({ constructor: "x" }, []), "constructor");
    expectInvalidConfig(() => normalizeObject({ prototype: "x" }, []), "prototype");
  });

  test("rejects null / undefined values", () => {
    expectInvalidConfig(() => normalizeObject({ x: null as unknown as string }, []), "null");
    expectInvalidConfig(
      () => normalizeObject({ x: undefined as unknown as string }, []),
      "undefined",
    );
  });

  test("rejects array values", () => {
    expectInvalidConfig(
      () => normalizeObject({ tags: ["a", "b"] as unknown as string }, []),
      "array",
    );
  });

  test("rejects NaN / Infinity", () => {
    expectInvalidConfig(() => normalizeObject({ x: NaN }, []), "NaN");
    expectInvalidConfig(() => normalizeObject({ x: Infinity }, []), "Infinity");
  });
});

describe("normalizePredicateArg — object form", () => {
  test("object form dispatches through normalizeObject", () => {
    expect(normalizePredicateArg({ status: "open" })).toEqual({
      clauses: [{ op: "eq", field: "status", value: "open" }],
    });
  });

  test("object form $-key rejection surfaces", () => {
    expectInvalidConfig(() => normalizePredicateArg({ $or: "x" } as never), '"$or"');
  });
});

describe("normalizePredicateArg — callback form", () => {
  test("eq + gt + in chain produces the expected wire", () => {
    const wire = normalizePredicateArg((q) =>
      q.eq("status", "open").gt("priority", 5).in("tag", ["a", "b"]),
    );
    expect(wire).toEqual({
      clauses: [
        { op: "eq", field: "status", value: "open" },
        { op: "gt", field: "priority", value: 5 },
        { op: "in", field: "tag", value: ["a", "b"] },
      ],
    });
  });

  test("empty callback (returns the builder unchanged) produces an empty wire", () => {
    const wire = normalizePredicateArg((q) => q);
    expect(wire).toEqual({ clauses: [] });
  });

  test("builder does NOT expose unsupported operator methods at runtime", () => {
    // Vocabulary lock: methods absent from PredicateBuilder cannot be
    // invoked even via `as unknown as { … }`. Type-level absence is
    // covered in `collection-api.test-d.ts`; here we pin the runtime
    // implementation surface so it cannot drift.
    normalizePredicateArg((q) => {
      const probe = q as unknown as {
        regex?: unknown;
        ne?: unknown;
        or?: unknown;
        exists?: unknown;
      };
      expect(probe.regex).toBeUndefined();
      expect(probe.ne).toBeUndefined();
      expect(probe.or).toBeUndefined();
      expect(probe.exists).toBeUndefined();
      return q;
    });
  });

  test("the supported method set is exactly { eq, gt, gte, lt, lte, in }", () => {
    // Sanity check that no unexpected methods leaked onto the builder.
    normalizePredicateArg((q: PredicateBuilder) => {
      const names = Object.keys(q).toSorted();
      expect(names).toEqual(["eq", "gt", "gte", "in", "lt", "lte"]);
      return q;
    });
  });
});

// ---------------------------------------------------------------------
// Property laws — the object-form normaliser preserves matching
// semantics. The example tests above cover shapes shallowly; these
// fuzz nested objects and deep reject paths.
// ---------------------------------------------------------------------

// Non-empty nested objects with primitive leaves drawn from small pools
// (so equal values collide and the "matches" branch is exercised).
// minKeys:1 at every level guarantees no empty subtree — that keeps
// leaf-path presence semantics unambiguous (an empty `{}` would emit
// zero clauses, i.e. no constraint, which the example tests already pin
// at normalize.test.ts:46-54).
const leafArb = fc.oneof(
  fc.constantFrom("x", "y", "z"),
  fc.integer({ min: 0, max: 2 }),
  fc.boolean(),
);
const nestedObjArb = fc.letrec((tie) => ({
  node: fc.dictionary(
    fc.constantFrom("a", "b", "c"),
    fc.oneof({ depthSize: "small", maxDepth: 3 }, leafArb, tie("node")),
    { minKeys: 1, maxKeys: 3 },
  ),
})).node as fc.Arbitrary<DocumentData>;

/**
 * Independent reference for the matching semantics the normaliser is
 * supposed to deliver: every leaf path in `pred` must be present and
 * strictly equal in `doc` (open-world — `doc` may carry extra keys).
 * Well-defined because `nestedObjArb` never produces empty subtrees.
 */
const refMatch = (pred: DocumentData, doc: unknown): boolean => {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return false;
  }
  const d = doc as Record<string, unknown>;
  for (const key of Object.keys(pred)) {
    const pv = (pred as Record<string, unknown>)[key];
    const av = d[key];
    if (pv !== null && typeof pv === "object" && !Array.isArray(pv)) {
      if (!refMatch(pv as DocumentData, av)) {
        return false;
      }
    } else if (av !== pv) {
      return false;
    }
  }
  return true;
};

describe("normalizeObject — property laws", () => {
  fcTest.prop({ pred: nestedObjArb, doc: nestedObjArb })(
    "semantic preservation: matchesWire(normalize(pred), doc) === reference leaf-path match",
    ({ pred, doc }) => {
      const wire = normalizePredicateArg(pred);
      expect(matchesWire(wire, doc as JSONObject)).toBe(refMatch(pred, doc));
    },
  );

  fcTest.prop({ pred: nestedObjArb })(
    "self-match: a document equal to the predicate object satisfies it",
    ({ pred }) => {
      expect(matchesWire(normalizePredicateArg(pred), pred as JSONObject)).toBe(true);
    },
  );

  fcTest.prop({ pred: nestedObjArb })(
    "determinism: normalizeObject is referentially stable",
    ({ pred }) => {
      expect(normalizeObject(pred, [])).toEqual(normalizeObject(pred, []));
    },
  );

  // Inject a forbidden VALUE at the bottom of a 1–3 deep key path.
  const pathArb = fc.array(fc.constantFrom("a", "b", "c"), { minLength: 1, maxLength: 3 });
  const nestValue = (path: ReadonlyArray<string>, leaf: unknown): Record<string, unknown> => {
    let cur: unknown = leaf;
    for (let i = path.length - 1; i >= 0; i--) {
      cur = { [path[i]!]: cur };
    }
    return cur as Record<string, unknown>;
  };

  fcTest.prop({
    path: pathArb,
    kind: fc.constantFrom<"array" | "null" | "nan" | "infinity">(
      "array",
      "null",
      "nan",
      "infinity",
    ),
  })("rejects a forbidden value at any nested depth", ({ path, kind }) => {
    const leafByKind = { array: ["x"], null: null, nan: NaN, infinity: Infinity } as const;
    const snippetByKind = {
      array: "array",
      null: "null",
      nan: "NaN",
      infinity: "Infinity",
    } as const;
    const leaf: unknown = leafByKind[kind];
    const snippet = snippetByKind[kind];
    try {
      normalizeObject(nestValue(path, leaf) as DocumentData, []);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
      expect((error as BaerlyError).message).toContain(snippet);
      return;
    }
    throw new Error("Expected BaerlyError{InvalidConfig}, none thrown");
  });

  // Inject a forbidden KEY at the bottom of a 0–2 deep key path.
  fcTest.prop({
    path: fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 2 }),
    key: fc.constantFrom("$or", "__proto__", "constructor", "prototype"),
  })("rejects a forbidden key at any nested depth", ({ path, key }) => {
    // `__proto__` must be an OWN property — build via JSON.parse so it
    // doesn't act as a prototype setter.
    const inner =
      key === "$or" ? { $or: "x" } : (JSON.parse(`{${JSON.stringify(key)}:"x"}`) as object);
    try {
      normalizeObject(nestValue(path, inner) as DocumentData, []);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
      expect((error as BaerlyError).message).toContain(key);
      return;
    }
    throw new Error("Expected BaerlyError{InvalidConfig}, none thrown");
  });
});
