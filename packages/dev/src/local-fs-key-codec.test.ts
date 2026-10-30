import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { decodeComponents, encodeKey, NAME_MAX_BYTES } from "./local-fs-key-codec.ts";

const COMPONENT_RE = /^[a-z0-9._%~-]+$/;

/** A valid key segment: non-empty, no `/`, not `.`/`..`, well-formed. */
const SEGMENT_ARB = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 24 })
  .filter((s) => !s.includes("/") && s !== "." && s !== ".." && s.isWellFormed());

const KEY_ARB = fc
  .array(SEGMENT_ARB, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("/"));

/** How a folding filesystem sees a name. */
const FOLDS: ReadonlyArray<[string, (s: string) => string]> = [
  ["NFD + lowercase", (s) => s.normalize("NFD").toLowerCase()],
  ["NFC + lowercase", (s) => s.normalize("NFC").toLowerCase()],
  ["NFKD + uppercase", (s) => s.normalize("NFKD").toUpperCase()],
];

const assertComponentShape = (components: readonly string[]): void => {
  for (const c of components) {
    expect(c).toMatch(COMPONENT_RE);
    expect(c.startsWith(".")).toBe(false);
    expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(NAME_MAX_BYTES);
  }
};

describe("local-fs key codec — properties", () => {
  fcTest.prop({ key: KEY_ARB })("decode(encode(k)) === k", ({ key }) => {
    expect(decodeComponents(encodeKey(key))).toBe(key);
  });

  fcTest.prop({ key: KEY_ARB })(
    "every component is fold-invariant ASCII, not dot-led, and within NAME_MAX",
    ({ key }) => {
      assertComponentShape(encodeKey(key));
    },
  );

  /**
   * A key plus its case and normalization variants — the spellings a
   * folding filesystem would merge. Random keys alone almost never contain
   * such twins, so the injectivity property is fed them directly.
   */
  const withTwins = (key: string): string[] =>
    [
      ...new Set([
        key,
        key.toUpperCase(),
        key.toLowerCase(),
        key.normalize("NFC"),
        key.normalize("NFD"),
        key.normalize("NFD").toUpperCase(),
      ]),
    ].filter((k) => k.split("/").every((s) => s !== "" && s !== "." && s !== ".."));

  const TWIN_UNIT = fc.constantFrom("A", "a", "é", "É", "é", "Σ", "K");
  const TWIN_PRONE_KEY_ARB = fc.oneof(
    KEY_ARB,
    fc.array(TWIN_UNIT, { minLength: 1, maxLength: 8 }).map((units) => units.join("")),
  );

  for (const [label, fold] of FOLDS) {
    fcTest.prop({ keys: fc.uniqueArray(TWIN_PRONE_KEY_ARB, { minLength: 1, maxLength: 16 }) })(
      `distinct keys stay distinct under ${label}`,
      ({ keys }) => {
        const all = [...new Set(keys.flatMap(withTwins))];
        const folded = new Set(all.map((k) => fold(encodeKey(k).join("/"))));
        expect(folded.size).toBe(all.length);
      },
    );
  }
});

describe("local-fs key codec — fixed vectors", () => {
  const distinctUnderFolding = (keys: readonly string[]): void => {
    for (const [, fold] of FOLDS) {
      expect(new Set(keys.map((k) => fold(encodeKey(k).join("/")))).size).toBe(keys.length);
    }
    for (const k of keys) {
      expect(decodeComponents(encodeKey(k))).toBe(k);
    }
  };

  test("NFC / NFD é and case pairs", () => {
    expect(encodeKey("é")).toEqual(["%c3%a9"]);
    expect(encodeKey("é")).toEqual(["e%cc%81"]);
    expect(encodeKey("A")).toEqual(["%41"]);
    expect(encodeKey("a")).toEqual(["a"]);
    distinctUnderFolding(["é", "é", "A", "a"]);
  });

  test("Σ / σ / ς and K / Kelvin sign", () => {
    distinctUnderFolding(["Σ", "σ", "ς"]);
    distinctUnderFolding(["K", "k", "K"]);
  });

  test("kernel-written keys are unchanged on disk", () => {
    const key = "app/my-app/tenant/t1/manifests/users/log/0000000000000001.json";
    expect(encodeKey(key)).toEqual(key.split("/"));
    const marker =
      "app/a/tenant/t/manifests/c/index/by_status/0123456789abcdefghijklmnopqrstuv/018f2e3a-7b1c-7def-8abc-0123456789ab.json";
    expect(encodeKey(marker)).toEqual(marker.split("/"));
  });

  test("a leading dot is escaped; an interior dot is not", () => {
    expect(encodeKey(".DS_Store")).toEqual(["%2e%44%53_%53tore"]);
    expect(encodeKey("x/.baerly-tmp-1")).toEqual(["x", "%2ebaerly-tmp-1"]);
    expect(encodeKey("current.json")).toEqual(["current.json"]);
  });

  test("a 256-byte _id plus .json splits with a continuation", () => {
    const key = `ix/${"a".repeat(256)}.json`;
    const components = encodeKey(key);
    assertComponentShape(components);
    expect(components).toHaveLength(3);
    expect(components[1]!.endsWith("~")).toBe(true);
    expect(decodeComponents(components)).toBe(key);
  });

  test("a 256-byte segment of é splits between triplets", () => {
    const key = "é".repeat(128); // 256 UTF-8 bytes, 768 encoded
    const components = encodeKey(key);
    assertComponentShape(components);
    expect(components.length).toBeGreaterThan(1);
    for (const c of components) {
      // Every part is whole triplets (plus the marker): never split inside one.
      expect(c.replace(/~$/, "")).toMatch(/^(%[0-9a-f]{2})+$/);
    }
    expect(decodeComponents(components)).toBe(key);
  });

  test("a split never starts a component with a literal dot", () => {
    const key = `x${".".repeat(600)}`;
    const components = encodeKey(key);
    assertComponentShape(components);
    expect(decodeComponents(components)).toBe(key);
  });

  test("lone surrogates are rejected", () => {
    expect(() => encodeKey("a\uD800")).toThrow(expect.objectContaining({ code: "InvalidConfig" }));
  });

  test("non-canonical or foreign names do not decode", () => {
    for (const bad of [
      ["A.json"], // uppercase literal
      ["%61"], // escaped literal
      ["%C3%A9"], // uppercase hex
      ["%c3"], // invalid UTF-8
      ["%2"], // truncated escape
      ["a~"], // dangling continuation
      ["a~", "b"], // continuation where no split was needed
      ["x", "%2e"], // decodes to a "." segment
      ["a%2fb"], // decodes to a "/" inside a segment
      ["café"], // raw non-ASCII
    ]) {
      expect({ bad, decoded: decodeComponents(bad) }).toEqual({ bad, decoded: null });
    }
  });
});
