import { describe, expect, test } from "vitest";

import { BaerlyError } from "../errors.ts";

import type { PredicateBuilder } from "./builder.ts";
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
