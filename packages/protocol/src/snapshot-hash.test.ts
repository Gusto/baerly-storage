import { describe, expect, test } from "vitest";
import { snapshotHash } from "./snapshot-hash.ts";

describe("snapshotHash", () => {
  test("returns a 64-char lowercase hex string", async () => {
    const h = await snapshotHash(new Uint8Array([1, 2, 3]));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic", async () => {
    const a = await snapshotHash(new TextEncoder().encode("hello"));
    const b = await snapshotHash(new TextEncoder().encode("hello"));
    expect(a).toBe(b);
  });

  test("differs across bodies", async () => {
    const a = await snapshotHash(new TextEncoder().encode("a"));
    const b = await snapshotHash(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });
});
