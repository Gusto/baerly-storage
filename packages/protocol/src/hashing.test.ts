import { expect, test, describe } from "vitest";

import { fromB64, toB64, or, inside, versionFromContent } from "./hashing";
import { uuid } from "./types";

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
  test("forall a, b: a inside (a or b) ", () => {
    const enc = new TextEncoder();
    for (let tries = 0; tries < 10; tries++) {
      const a = toB64(enc.encode(uuid()));
      const b = toB64(enc.encode(uuid()));

      const a_or_b = or(a, b);

      expect(inside(a, b)).toBe(false);
      expect(inside(b, a)).toBe(false);
      expect(inside(a_or_b, a)).toBe(false);
      expect(inside(a_or_b, b)).toBe(false);
      expect(inside(a, a_or_b)).toBe(true);
      expect(inside(b, a_or_b)).toBe(true);
      expect(inside(a, a)).toBe(true);
      expect(inside(b, b)).toBe(true);
      expect(inside(a_or_b, a_or_b)).toBe(true);
    }
  });
});
