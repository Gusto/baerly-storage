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

interface AcceptedCanonicalJsonVector {
  readonly name: string;
  readonly value: CanonicalJsonValue;
  readonly canonical: string;
  readonly sha256: string;
}

interface RejectedCanonicalJsonVector {
  readonly name: string;
  readonly placement: "root-string" | "object-value" | "object-key";
  readonly encoding: "utf16-code-units" | "unicode-code-points";
  readonly values: readonly number[];
  readonly reason: "non-ijson-string";
}

type CanonicalJsonVector = AcceptedCanonicalJsonVector | RejectedCanonicalJsonVector;

const vectors = vectorsJson as readonly CanonicalJsonVector[];

const isAcceptedVector = (vector: CanonicalJsonVector): vector is AcceptedCanonicalJsonVector =>
  "canonical" in vector;

const acceptedVectors = vectors.filter(isAcceptedVector);
const rejectedVectors = vectors.filter(
  (vector): vector is RejectedCanonicalJsonVector => !isAcceptedVector(vector),
);

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

const isIjsonString = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const leading = value.charCodeAt(index);
    let codePoint = leading;
    if (leading >= 0xd800 && leading <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || trailing < 0xdc00 || trailing > 0xdfff) {
        return false;
      }
      codePoint = (leading - 0xd800) * 0x400 + trailing - 0xdc00 + 0x10000;
      index += 1;
    } else if (leading >= 0xdc00 && leading <= 0xdfff) {
      return false;
    }
    if ((codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe) {
      return false;
    }
  }
  return true;
};

const isAcceptedGeneratedJson = (value: unknown): boolean => {
  if (typeof value === "string") {
    return isIjsonString(value);
  }
  if (Array.isArray(value)) {
    return value.every(isAcceptedGeneratedJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).every(
      (key) =>
        key !== "__proto__" &&
        isIjsonString(key) &&
        isAcceptedGeneratedJson((value as Record<string, unknown>)[key]),
    );
  }
  return true;
};

const acceptedJsonValue = fc.jsonValue().filter(isAcceptedGeneratedJson);

const reconstructRejectedString = (vector: RejectedCanonicalJsonVector): string =>
  vector.encoding === "utf16-code-units"
    ? String.fromCharCode(...vector.values)
    : String.fromCodePoint(...vector.values);

const rejectedVectorInput = (
  vector: RejectedCanonicalJsonVector,
  value: string,
): CanonicalJsonValue => {
  switch (vector.placement) {
    case "root-string": {
      return value;
    }
    case "object-value": {
      return { value };
    }
    case "object-key": {
      return { [value]: null };
    }
  }
};

const rejectedVectorPath = (vector: RejectedCanonicalJsonVector, value: string): string => {
  switch (vector.placement) {
    case "root-string": {
      return "$";
    }
    case "object-value": {
      return "$.value";
    }
    case "object-key": {
      return `$[${JSON.stringify(value)}]`;
    }
  }
};

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
      "reject-lone-high-surrogate-root",
      "reject-lone-low-surrogate-root",
      "reject-lone-high-surrogate-nested",
      "reject-lone-low-surrogate-key",
      "reject-bmp-noncharacter-root",
      "reject-plane-end-noncharacter-key",
      "reject-supplementary-noncharacter-root",
    ]);
    expect(new Set(vectors.map(({ name }) => name)).size).toBe(vectors.length);
  });

  test("serializes and hashes every portable vector", async () => {
    for (const vector of acceptedVectors) {
      const actual = canonicalJson(vector.value);
      expect(actual).toBe(vector.canonical);
      await expect(sha256Hex(actual)).resolves.toBe(vector.sha256);
      expect(canonicalJson(runtimeValue(JSON.parse(vector.canonical)))).toBe(vector.canonical);
    }
  });

  test("pins the digest of the produced vector corpus", async () => {
    const corpus = acceptedVectors.map(({ value }) => canonicalJson(value)).join("\n");
    await expect(sha256Hex(corpus)).resolves.toBe(CANONICAL_JSON_VECTOR_CORPUS_DIGEST);
  });

  test("rejects every portable I-JSON string-domain vector", () => {
    expect(rejectedVectors).toHaveLength(7);
    for (const vector of rejectedVectors) {
      const value = reconstructRejectedString(vector);
      expectCanonicalError(
        rejectedVectorInput(vector, value),
        vector.reason,
        rejectedVectorPath(vector, value),
      );
    }
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

  test("preserves valid UTF-16 surrogate pairs in values and property names", () => {
    const validPair = String.fromCharCode(0xd83d, 0xde00);
    expect(canonicalJson(validPair)).toBe('"😀"');
    expect(canonicalJson({ [validPair]: validPair })).toBe('{"😀":"😀"}');
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

  test("reports the same reason and path regardless of property insertion order", () => {
    const lone = String.fromCharCode(0xd800);
    // Each builder produces the same logical value with two defects, inserted
    // in opposite orders. Before the keys were sorted ahead of validation these
    // pairs disagreed: `Reflect.ownKeys` order decided which defect was found.
    const pairs: readonly {
      readonly first: () => object;
      readonly second: () => object;
      readonly reason: CanonicalJsonRejectionReason;
      readonly path: string;
    }[] = [
      {
        first: () => {
          const value = {};
          Object.defineProperty(value, "alpha", { value: 1, enumerable: false });
          Object.defineProperty(value, "beta", { get: () => 1, enumerable: true });
          return value;
        },
        second: () => {
          const value = {};
          Object.defineProperty(value, "beta", { get: () => 1, enumerable: true });
          Object.defineProperty(value, "alpha", { value: 1, enumerable: false });
          return value;
        },
        reason: "non-enumerable-own-property",
        path: "$.alpha",
      },
      {
        first: () => {
          const value = Object.create(null) as Record<string, unknown>;
          Object.defineProperty(value, "__proto__", { value: 1, enumerable: true });
          value[lone] = 1;
          return value;
        },
        second: () => {
          const value = Object.create(null) as Record<string, unknown>;
          value[lone] = 1;
          Object.defineProperty(value, "__proto__", { value: 1, enumerable: true });
          return value;
        },
        reason: "forbidden-key",
        path: '$["__proto__"]',
      },
    ];

    for (const { first, second, reason, path } of pairs) {
      expectCanonicalError(first(), reason, path);
      expectCanonicalError(second(), reason, path);
    }
  });

  test("rewraps an engine-level failure as CanonicalJsonError", () => {
    // Proxies are outside the ACCEPTED DOMAIN, but the error-TYPE guarantee
    // still has to hold: a foreign throw from inside the traversal must not
    // escape as a bare TypeError. This is the cheap, deterministic stand-in for
    // the real trigger — a >512MB output, which throws a bare V8 RangeError but
    // costs ~1.2GB of RSS to provoke and so is unfit for the default suite.
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new TypeError("engine-level failure");
        },
      },
    );
    const error = expectCanonicalError(hostile, "serialization-failed", "$");
    expect(error.cause).toBeInstanceOf(TypeError);
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
      fc.string().filter((key) => key !== "__proto__" && isIjsonString(key)),
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
    "generated ordinary non-Proxy JavaScript values return canonical bytes or a canonical error",
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

  test("hashCanonicalJson rejects a non-I-JSON string asynchronously", async () => {
    const promise = hashCanonicalJson(String.fromCharCode(0xd800));
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toMatchObject({
      code: "CanonicalJsonError",
      reason: "non-ijson-string",
      path: "$",
    });
  });

  test("sha256Hex rejects a non-I-JSON string rather than hashing substituted bytes", async () => {
    for (const codeUnit of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
      const promise = sha256Hex(String.fromCharCode(codeUnit));
      expect(promise).toBeInstanceOf(Promise);
      await expect(promise).rejects.toMatchObject({
        code: "CanonicalJsonError",
        reason: "non-ijson-string",
        path: "$",
      });
    }
    await expect(sha256Hex(String.fromCharCode(0xfffe))).rejects.toMatchObject({
      reason: "non-ijson-string",
    });
  });

  test("sha256Hex is injective where TextEncoder alone would collide", async () => {
    // TextEncoder.encode substitutes U+FFFD for a lone surrogate, so every one
    // of these would otherwise hash to sha256Hex("�"). Validation is what
    // keeps the exported function injective over its declared string type.
    const substitute = await sha256Hex("�");
    for (const codeUnit of [0xd800, 0xdfff]) {
      await expect(sha256Hex(String.fromCharCode(codeUnit))).rejects.toBeInstanceOf(
        CanonicalJsonError,
      );
    }
    // The raw bytes remain reachable, and stay distinct from the substitution.
    await expect(sha256Hex(new Uint8Array([0xed, 0xa0, 0x80]))).resolves.not.toBe(substitute);
    // A valid surrogate pair is untouched by the guard.
    await expect(sha256Hex("\u{10000}")).resolves.not.toBe(substitute);
  });
});
