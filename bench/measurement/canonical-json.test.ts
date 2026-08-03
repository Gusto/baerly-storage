import { fc, test as propertyTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import vectorsJson from "./canonical-json-vectors.json" with { type: "json" };
import {
  CANONICAL_JSON_MAX_DEPTH,
  CANONICAL_JSON_VECTOR_CORPUS_DIGEST,
  CANONICAL_JSON_VERSION,
  CanonicalJsonError,
  type CanonicalJsonRejectionReason,
  type CanonicalJsonValue,
  canonicalJson,
  hashCanonicalJson,
  sha256Hex,
} from "./canonical-json.ts";

interface CanonicalJsonVector {
  readonly name: string;
  readonly value: CanonicalJsonValue;
  readonly canonical: string;
  readonly sha256: string;
}

const vectors = vectorsJson as readonly CanonicalJsonVector[];

const runtimeValue = (value: unknown): CanonicalJsonValue => value as CanonicalJsonValue;

const expectCanonicalError = (
  value: unknown,
  reason: CanonicalJsonRejectionReason,
  path?: string,
): CanonicalJsonError => {
  let thrown: unknown;
  try {
    canonicalJson(runtimeValue(value));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CanonicalJsonError);
  expect(thrown).toMatchObject({ code: "CanonicalJsonError", reason });
  if (path !== undefined) {
    expect(thrown).toMatchObject({ path });
  }
  return thrown as CanonicalJsonError;
};

const normalizeNegativeZero = (value: unknown): unknown => {
  if (typeof value === "number") {
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeNegativeZero);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeNegativeZero(child)]),
    );
  }
  return value;
};

const hasNoForbiddenKey = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.every(hasNoForbiddenKey);
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).every(
      (key) => key !== "__proto__" && hasNoForbiddenKey((value as Record<string, unknown>)[key]),
    );
  }
  return true;
};

const acceptedJsonValue = fc.jsonValue().filter(hasNoForbiddenKey);

describe("canonical vector contract", () => {
  test("publishes the versioned corpus contract", () => {
    expect(CANONICAL_JSON_VERSION).toBe("baerly-canonical-json-v1");
    expect(CANONICAL_JSON_MAX_DEPTH).toBe(256);
    expect(CANONICAL_JSON_VECTOR_CORPUS_DIGEST).toBe(
      "2f7eecfc4324c311d306db52eb4589d628df835a3e76a9715e290ad099ef7d01",
    );
  });

  test("contains each exact portable vector name once", () => {
    expect(vectors.map(({ name }) => name)).toEqual([
      "empty-object",
      "empty-array",
      "scalar-null",
      "scalar-true",
      "scalar-string",
      "key-sort-basic",
      "array-order-ascending",
      "array-order-descending",
      "nested-containers",
      "key-sort-utf16-code-unit",
      "shared-subobject-dag",
      "proto-adjacent-keys",
      "three-level-nesting",
      "anchor-single-key",
    ]);
    expect(new Set(vectors.map(({ name }) => name)).size).toBe(vectors.length);
  });

  test("serializes and hashes every portable vector", async () => {
    for (const vector of vectors) {
      const actual = canonicalJson(vector.value);
      expect(actual).toBe(vector.canonical);
      await expect(sha256Hex(actual)).resolves.toBe(vector.sha256);
      expect(canonicalJson(runtimeValue(JSON.parse(vector.canonical)))).toBe(vector.canonical);
    }
  });

  test("pins the digest of the produced vector corpus", async () => {
    const corpus = vectors.map(({ value }) => canonicalJson(value)).join("\n");
    await expect(sha256Hex(corpus)).resolves.toBe(CANONICAL_JSON_VECTOR_CORPUS_DIGEST);
  });

  test("pins an independent SHA-256 anchor for the canonical single-key object", async () => {
    await expect(sha256Hex('{"a":1}')).resolves.toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });
});

describe("canonical serialization", () => {
  test.each([
    [null, "null"],
    [false, "false"],
    [true, "true"],
    ["", '""'],
    ["é😀", '"é😀"'],
    ["\u0000\b\t\n\f\r", '"\\u0000\\b\\t\\n\\f\\r"'],
    ["\ud800", '"\\ud800"'],
    ["\udc00", '"\\udc00"'],
    [0, "0"],
    [1.5, "1.5"],
    [4.5, "4.5"],
    [0.002, "0.002"],
    [0.000001, "0.000001"],
    [0.0000001, "1e-7"],
    [Number("333333333.33333329"), "333333333.3333333"],
    [1e30, "1e+30"],
    [1e-27, "1e-27"],
    [Number.MIN_VALUE, "5e-324"],
    [Number.MAX_VALUE, "1.7976931348623157e+308"],
  ] as const)("uses JSON scalar encoding for %j", (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  test("normalizes negative zero to the canonical number zero", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ nested: [-0] })).toBe('{"nested":[0]}');
  });

  test("sorts keys by UTF-16 code unit at every object depth", () => {
    expect(canonicalJson({ outer: { ﬀ: 1, "😀": 2 }, a: 3 })).toBe(
      '{"a":3,"outer":{"😀":2,"ﬀ":1}}',
    );
  });

  test("accepts null-prototype objects", () => {
    const value = Object.create(null) as Record<string, CanonicalJsonValue>;
    value["z"] = 1;
    value["a"] = 2;
    expect(canonicalJson(value)).toBe('{"a":2,"z":1}');
  });

  test("allows shared acyclic references", () => {
    const shared = { n: 1 };
    expect(canonicalJson({ b: shared, a: shared })).toBe('{"a":{"n":1},"b":{"n":1}}');
  });

  test("never invokes toJSON", () => {
    let calls = 0;
    const value = {
      a: 1,
      toJSON(): never {
        calls += 1;
        throw new Error("must not execute");
      },
    };
    expectCanonicalError(value, "function-value", "$.toJSON");
    expect(calls).toBe(0);
  });
});

describe("deterministic rejections", () => {
  test("rejects undefined values", () => {
    expectCanonicalError(undefined, "undefined-value", "$");
    expectCanonicalError({ a: undefined }, "undefined-value", "$.a");
  });

  test("rejects function values", () => {
    expectCanonicalError({ fn: () => undefined }, "function-value", "$.fn");
  });

  test("rejects symbol values", () => {
    expectCanonicalError([Symbol("value")], "symbol-value", "$[0]");
  });

  test("rejects bigint values", () => {
    expectCanonicalError({ n: 1n }, "bigint-value", "$.n");
  });

  test("rejects non-finite numbers", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectCanonicalError(value, "non-finite-number", "$");
    }
  });

  test("rejects every non-plain object family", () => {
    class Instance {
      readonly marker = true;
    }
    for (const value of [
      new Date(0),
      new Map(),
      new Set(),
      /x/,
      new Instance(),
      new Number(1),
      new Uint8Array([1]),
    ]) {
      expectCanonicalError(value, "non-plain-object", "$");
    }
  });

  test("rejects only back-edges on the current traversal path as cycles", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expectCanonicalError(value, "cyclic-reference", "$.self");
  });

  test("rejects a sparse array before considering its extra properties", () => {
    const value: CanonicalJsonValue[] = [];
    value.length = 2;
    Object.defineProperty(value, "extra", { value: 1, enumerable: true });
    expectCanonicalError(value, "array-hole", "$[0]");
  });

  test("rejects non-index array properties", () => {
    const value = [1] as CanonicalJsonValue[] & { extra?: number };
    value.extra = 2;
    expectCanonicalError(value, "array-extra-property", "$.extra");
  });

  test("rejects own symbol keys on arrays and objects", () => {
    const key = Symbol("key");
    const objectValue = { a: 1 };
    const arrayValue = [1];
    Object.defineProperty(objectValue, key, { value: 2, enumerable: true });
    Object.defineProperty(arrayValue, key, { value: 2, enumerable: true });
    expectCanonicalError(objectValue, "symbol-key", "$");
    expectCanonicalError(arrayValue, "symbol-key", "$");
  });

  test("rejects an own __proto__ key", () => {
    const value = Object.create(null) as Record<string, CanonicalJsonValue>;
    Object.defineProperty(value, "__proto__", { value: 1, enumerable: true });
    expectCanonicalError(value, "forbidden-key", '$["__proto__"]');
  });

  test("rejects non-enumerable own properties on arrays and objects", () => {
    const objectValue = { a: 1 };
    const arrayValue = [1];
    Object.defineProperty(objectValue, "hidden", { value: 2, enumerable: false });
    Object.defineProperty(arrayValue, "hidden", { value: 2, enumerable: false });
    expectCanonicalError(objectValue, "non-enumerable-own-property", "$.hidden");
    expectCanonicalError(arrayValue, "non-enumerable-own-property", "$.hidden");
  });

  test("rejects accessors on arrays and objects without invoking getters", () => {
    let calls = 0;
    const objectValue = { a: 1 };
    const arrayValue = [1];
    const setterValue = { a: 1 };
    Object.defineProperty(objectValue, "computed", {
      get: () => {
        calls += 1;
        return 2;
      },
      enumerable: true,
    });
    Object.defineProperty(arrayValue, "computed", {
      get: () => {
        calls += 1;
        return 2;
      },
      enumerable: true,
    });
    Object.defineProperty(setterValue, "computed", {
      set: () => {
        calls += 1;
      },
      enumerable: true,
    });
    expectCanonicalError(objectValue, "accessor-own-property", "$.computed");
    expectCanonicalError(arrayValue, "accessor-own-property", "$.computed");
    expectCanonicalError(setterValue, "accessor-own-property", "$.computed");
    expect(calls).toBe(0);
  });

  test("rejects values deeper than the versioned maximum", () => {
    let accepted: unknown = null;
    for (let depth = 0; depth < CANONICAL_JSON_MAX_DEPTH; depth += 1) {
      accepted = [accepted];
    }
    expect(() => canonicalJson(runtimeValue(accepted))).not.toThrow();

    const rejected = [accepted];
    expectCanonicalError(rejected, "max-depth-exceeded");
  });
});

describe("canonical properties", () => {
  propertyTest.prop({
    value: fc.dictionary(
      fc.string().filter((key) => key !== "__proto__"),
      acceptedJsonValue,
    ),
  })("permuting object insertion order preserves canonical bytes", ({ value }) => {
    const reversed = Object.fromEntries(Object.entries(value).toReversed());
    expect(canonicalJson(runtimeValue(reversed))).toBe(canonicalJson(runtimeValue(value)));
  });

  propertyTest.prop({ value: acceptedJsonValue })(
    "canonicalizing parsed canonical JSON is byte-stable",
    ({ value }) => {
      const once = canonicalJson(runtimeValue(value));
      expect(canonicalJson(runtimeValue(JSON.parse(once)))).toBe(once);
    },
  );

  propertyTest.prop({ value: acceptedJsonValue })(
    "parse round-trip preserves each logical JSON value",
    ({ value }) => {
      const parsed: unknown = JSON.parse(canonicalJson(runtimeValue(value)));
      expect(parsed).toEqual(normalizeNegativeZero(value));
    },
  );

  test("parse round-trip normalizes negative zero at every nesting level", () => {
    const value = { root: -0, nested: [-0, { value: -0 }] };
    expect(JSON.parse(canonicalJson(value))).toEqual({ root: 0, nested: [0, { value: 0 }] });
  });

  propertyTest.prop({ value: fc.anything() })(
    "arbitrary JavaScript values return canonical bytes or a canonical error",
    ({ value }) => {
      try {
        expect(typeof canonicalJson(runtimeValue(value))).toBe("string");
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalJsonError);
      }
    },
  );
});

describe("SHA-256 framing", () => {
  test("hashes strings as their exact UTF-8 bytes", async () => {
    const text = "é😀";
    await expect(sha256Hex(text)).resolves.toBe(await sha256Hex(new TextEncoder().encode(text)));
  });

  test("does not add a prefix, suffix, separator, or newline", async () => {
    await expect(sha256Hex('{"a":1}')).resolves.toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
    await expect(sha256Hex('{"a":1}\n')).resolves.not.toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });

  test("hashCanonicalJson is exactly the hash of the canonical bytes", async () => {
    const value = { z: 1, a: [-0, "x"] };
    await expect(hashCanonicalJson(value)).resolves.toBe(
      "0b73c37eac3f4272af1a8e4de37513a0a41b82f115ab9ccb5adbde64cad68b39",
    );
    await expect(hashCanonicalJson(value)).resolves.toBe(await sha256Hex('{"a":[0,"x"],"z":1}'));
  });

  test("hashCanonicalJson rejects unsupported values asynchronously", async () => {
    const promise = hashCanonicalJson(runtimeValue(undefined));
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toMatchObject({
      code: "CanonicalJsonError",
      reason: "undefined-value",
      path: "$",
    });
  });
});
