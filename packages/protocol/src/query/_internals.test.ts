import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import type { DocumentValue } from "../json.ts";
import {
  compareScalar,
  deepEqualDocumentValue,
  formatPath,
  sameComparableType,
} from "./_internals.ts";

describe("compareScalar", () => {
  test("orders numbers by sign; distinguishes a-b from a+b", () => {
    // a<b → negative. The `-`→`+` mutant would make this +5, so the sign
    // assertion kills it.
    expect(compareScalar(2, 3)).toBeLessThan(0);
    expect(compareScalar(3, 2)).toBeGreaterThan(0);
    expect(compareScalar(2, 2)).toBe(0);
  });

  test("orders strings with exact -1 / 1 / 0 (kills literal + relational mutants)", () => {
    expect(compareScalar("a", "b")).toBe(-1);
    expect(compareScalar("b", "a")).toBe(1);
    expect(compareScalar("a", "a")).toBe(0);
  });

  test("non-comparable / mixed types fall through to 0", () => {
    expect(compareScalar(1, "a")).toBe(0);
    expect(compareScalar("a", 2)).toBe(0);
  });

  test("string/number mix never enters the string branch (kills the string-guard force-true/|| mutants)", () => {
    // Real code only compares string<string. If the string-guard were
    // forced true (or relaxed to `||`), `"2" < 10` would coerce and return
    // a non-zero ordering; the real fall-through keeps it 0.
    expect(compareScalar("2" as unknown as DocumentValue, 10)).toBe(0);
    expect(compareScalar(10, "2" as unknown as DocumentValue)).toBe(0);
  });

  fcTest.prop([fc.double({ noNaN: true }), fc.double({ noNaN: true })])(
    "number compare agrees with native sign for all pairs",
    (a, b) => {
      expect(Math.sign(compareScalar(a, b))).toBe(Math.sign(a - b));
    },
  );
});

describe("sameComparableType", () => {
  test("true only when both operands are the same primitive kind", () => {
    expect(sameComparableType(1, 2)).toBe(true);
    expect(sameComparableType("a", "b")).toBe(true);
    expect(sameComparableType(1, "a")).toBe(false);
    expect(sameComparableType("a", 1)).toBe(false);
    expect(
      sameComparableType(true as unknown as DocumentValue, true as unknown as DocumentValue),
    ).toBe(false);
  });
});

describe("formatPath", () => {
  test("empty path renders <root> (kills length===0 boundary mutant)", () => {
    expect(formatPath([])).toBe("<root>");
  });

  test("non-empty path joins JSON-quoted segments with dots", () => {
    expect(formatPath(["x"])).toBe('"x"');
    expect(formatPath(["a", "b"])).toBe('"a"."b"');
  });
});

describe("deepEqualDocumentValue", () => {
  test("reference-equal primitives are equal; differing primitives are not", () => {
    expect(deepEqualDocumentValue(1, 1)).toBe(true);
    expect(deepEqualDocumentValue("a", "a")).toBe(true);
    expect(deepEqualDocumentValue(1, 2)).toBe(false);
  });

  test("primitive vs object is unequal (kills typeof-guard mutant)", () => {
    expect(deepEqualDocumentValue(1, { a: 1 } as unknown as DocumentValue)).toBe(false);
  });

  test("primitive vs empty object is unequal (kills the object-guard `false`/`&&` mutants)", () => {
    // Both `Object.keys(1)` and `Object.keys({})` are empty, so without the
    // typeof guard (forced false, or relaxed to `&&`) the key-walk would
    // wrongly declare them equal. The guard must short-circuit to false.
    expect(deepEqualDocumentValue(1, {} as unknown as DocumentValue)).toBe(false);
    expect(deepEqualDocumentValue({} as unknown as DocumentValue, 1)).toBe(false);
    expect(deepEqualDocumentValue(2, 3)).toBe(false);
  });

  test("structurally-equal flat objects are equal (kills the `!`-drop on the recursion)", () => {
    // Distinct references with one primitive key. `a === b` is false, so the
    // walk recurses into the leaf; dropping the `!` on the recursive call
    // would invert this to `false`.
    expect(
      deepEqualDocumentValue(
        { a: 1 } as unknown as DocumentValue,
        { a: 1 } as unknown as DocumentValue,
      ),
    ).toBe(true);
    expect(
      deepEqualDocumentValue(
        { a: 1, b: 2 } as unknown as DocumentValue,
        { a: 1, b: 2 } as unknown as DocumentValue,
      ),
    ).toBe(true);
    expect(
      deepEqualDocumentValue(
        { a: 1 } as unknown as DocumentValue,
        { a: 2 } as unknown as DocumentValue,
      ),
    ).toBe(false);
  });

  test("a key whose value is undefined is unequal to a defined value (kills the undefined-guard mutants)", () => {
    // The `as === undefined || bs === undefined` guard must fire so the
    // recursion never sees a phantom `undefined`. Dropping the guard (or
    // emptying its body) would make both-undefined slots compare equal.
    expect(
      deepEqualDocumentValue(
        { a: undefined } as unknown as DocumentValue,
        { a: undefined } as unknown as DocumentValue,
      ),
    ).toBe(false);
  });

  test("differing key counts are unequal (kills `!==`→`===` on length)", () => {
    expect(
      deepEqualDocumentValue(
        { a: 1 } as unknown as DocumentValue,
        { a: 1, b: 2 } as unknown as DocumentValue,
      ),
    ).toBe(false);
  });

  test("missing key on b is unequal (kills `!(key in b)`)", () => {
    expect(
      deepEqualDocumentValue(
        { a: 1 } as unknown as DocumentValue,
        { b: 1 } as unknown as DocumentValue,
      ),
    ).toBe(false);
  });

  test("recurses into nested objects", () => {
    expect(
      deepEqualDocumentValue(
        { a: { b: 1 } } as unknown as DocumentValue,
        { a: { b: 1 } } as unknown as DocumentValue,
      ),
    ).toBe(true);
    expect(
      deepEqualDocumentValue(
        { a: { b: 1 } } as unknown as DocumentValue,
        { a: { b: 2 } } as unknown as DocumentValue,
      ),
    ).toBe(false);
  });
});
