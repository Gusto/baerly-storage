import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { fromB64, toB64, or, inside, versionFromContent } from "./hashing";

describe("b64/uint", () => {
  test("round trip", () => {
    const start = toB64(new TextEncoder().encode("cool"));
    expect(toB64(fromB64(start))).toBe(start);
  });
});

describe("versionFromContent", () => {
  const enc = new TextEncoder();

  test("same body yields same VersionId (idempotent)", async () => {
    const body = enc.encode('{"hello":"world"}');
    const a = await versionFromContent(body);
    const b = await versionFromContent(body);
    expect(a).toBe(b);
  });

  test("different bodies yield different VersionIds", async () => {
    const a = await versionFromContent(enc.encode('{"hello":"world"}'));
    const b = await versionFromContent(enc.encode('{"hello":"World"}'));
    expect(a).not.toBe(b);
  });

  test("VersionId is 32 lowercase hex chars", async () => {
    const v = await versionFromContent(enc.encode("anything"));
    expect(v).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("or and inside", () => {
  // `or` / `inside` are defined byte-wise over equal-length operands
  // (the protocol uses them on fixed-width hashes); generate `a` and `b`
  // at a shared length so the property is well-formed.
  const equalLengthPair = fc
    .integer({ min: 1, max: 32 })
    .chain((n) =>
      fc.tuple(
        fc.uint8Array({ minLength: n, maxLength: n }),
        fc.uint8Array({ minLength: n, maxLength: n }),
      ),
    );

  test.prop({ pair: equalLengthPair })("forall a, b: a inside (a or b)", ({ pair: [a, b] }) => {
    const aB64 = toB64(a);
    const bB64 = toB64(b);
    const a_or_b = or(aB64, bB64);

    // monotonicity under or
    expect(inside(aB64, a_or_b)).toBe(true);
    expect(inside(bB64, a_or_b)).toBe(true);
    // reflexivity
    expect(inside(aB64, aB64)).toBe(true);
    expect(inside(bB64, bB64)).toBe(true);
    expect(inside(a_or_b, a_or_b)).toBe(true);
  });
});
