import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { assertSnapshotDocId, compareDocIds } from "../../packages/server/src/snapshot-doc-id.ts";
import {
  DOC_ID_MAX_UTF8_BYTES,
  docIdNearPairArb,
  invalidDocIdArb,
  makeValidDocIdArb,
  validDocIdArb,
} from "../fixtures/scalar-doc-id-arbitraries.ts";

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const codePoints = (value: string): number[] => Array.from(value, (char) => char.codePointAt(0)!);
// eslint-disable-next-line no-control-regex -- intentional control-char class
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Every rule an ID breaks, judged independently of the validator. */
const brokenRules = (id: string): string[] => {
  const broken: string[] = [];
  if (!id.isWellFormed()) {
    broken.push("surrogate");
  }
  if (id === "") {
    broken.push("empty");
  }
  if (id.includes("/")) {
    broken.push("slash");
  }
  if (id === ".") {
    broken.push("dot");
  }
  if (id === "..") {
    broken.push("dot-dot");
  }
  if (CONTROL.test(id)) {
    broken.push("control");
  }
  if (id.startsWith("_")) {
    broken.push("leading-underscore");
  }
  if (byteLength(id) > DOC_ID_MAX_UTF8_BYTES) {
    broken.push("too-long");
  }
  return broken;
};

const expectedRule = (rule: string): string => {
  if (rule.includes("surrogate")) {
    return "surrogate";
  }
  return rule.endsWith("-control") ? "control" : rule;
};

describe("validDocIdArb", () => {
  fcTest.prop({ id: validDocIdArb })("generates only in-domain IDs", ({ id }) => {
    expect(brokenRules(id)).toEqual([]);
    expect(() => assertSnapshotDocId(id)).not.toThrow();
  });

  fcTest.prop({
    maxCodePoints: fc.integer({ min: 1, max: 40 }),
    seed: fc.integer(),
  })("honors maxCodePoints in short mode", ({ maxCodePoints, seed }) => {
    const [id] = fc.sample(makeValidDocIdArb({ maxCodePoints, longBand: false }), {
      seed,
      numRuns: 1,
    });
    expect(brokenRules(id!)).toEqual([]);
    expect(codePoints(id!).length).toBeLessThanOrEqual(maxCodePoints);
  });

  test("covers high-BMP, U+FFFD, U+FFFF, astral, and the 250–256-byte band", () => {
    const sample = fc.sample(validDocIdArb, { seed: 1, numRuns: 2000 });
    const points = new Set(sample.flatMap(codePoints));
    expect(points.has(0xfffd)).toBe(true);
    expect(points.has(0xffff)).toBe(true);
    expect([...points].some((point) => point >= 0xe000 && point <= 0xffff)).toBe(true);
    expect([...points].some((point) => point > 0xffff)).toBe(true);
    expect([...points].some((point) => point >= 0x300 && point <= 0x36f)).toBe(true);
    expect(sample.some((id) => byteLength(id) >= 250)).toBe(true);
    expect(sample.some((id) => byteLength(id) === DOC_ID_MAX_UTF8_BYTES)).toBe(true);
  });
});

describe("invalidDocIdArb", () => {
  fcTest.prop({ value: invalidDocIdArb })(
    "breaks exactly the rule it is tagged with",
    ({ value }) => {
      expect(brokenRules(value.id)).toEqual([expectedRule(value.rule)]);
      expect(() => assertSnapshotDocId(value.id)).toThrowError(
        expect.objectContaining({ code: "InvalidConfig" }),
      );
    },
  );

  test("covers every rule, position, and too-long tail width", () => {
    const sample = fc.sample(invalidDocIdArb, { seed: 1, numRuns: 5000 });
    const tags = new Set(sample.map(({ rule, detail }) => `${rule}:${detail}`));
    for (const rule of [
      "unpaired-high-surrogate",
      "unpaired-low-surrogate",
      "reversed-surrogate-pair",
      "c0-control",
      "del-control",
      "c1-control",
      "slash",
    ]) {
      for (const position of ["start", "middle", "end"]) {
        expect(tags).toContain(`${rule}:${position}`);
      }
    }
    for (const tag of ["dot:exact", "dot-dot:exact", "empty:exact", "leading-underscore:start"]) {
      expect(tags).toContain(tag);
    }
    for (const width of [1, 2, 3, 4]) {
      expect(tags).toContain(`too-long:${width}-byte last char`);
    }
    for (const { rule, detail, id } of sample) {
      if (rule === "too-long") {
        expect(byteLength(id)).toBe(DOC_ID_MAX_UTF8_BYTES + 1);
        expect(String(byteLength(String.fromCodePoint(codePoints(id).at(-1)!)))).toBe(
          detail.charAt(0),
        );
      }
    }
  });
});

describe("docIdNearPairArb", () => {
  fcTest.prop({ pair: docIdNearPairArb })(
    "yields distinct in-domain IDs that collide under the named mistake",
    ({ pair: { kind, left, right } }) => {
      expect(brokenRules(left)).toEqual([]);
      expect(brokenRules(right)).toEqual([]);
      expect(left).not.toBe(right);
      switch (kind) {
        case "normalization": {
          expect(left.normalize("NFC")).toBe(right.normalize("NFC"));
          break;
        }
        case "case": {
          expect(left.toLowerCase()).toBe(right.toLowerCase());
          break;
        }
        case "proper-prefix": {
          expect(right.startsWith(left)).toBe(true);
          break;
        }
        case "high-bmp-vs-astral": {
          // Code-point order and JS `<` disagree on every such pair.
          expect(compareDocIds(left, right)).toBe(-1);
          expect(left < right).toBe(false);
          break;
        }
      }
    },
  );

  test("covers every kind", () => {
    const kinds = new Set(
      fc.sample(docIdNearPairArb, { seed: 1, numRuns: 500 }).map(({ kind }) => kind),
    );
    expect([...kinds].toSorted()).toEqual([
      "case",
      "high-bmp-vs-astral",
      "normalization",
      "proper-prefix",
    ]);
  });
});
