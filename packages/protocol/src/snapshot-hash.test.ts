import { describe, expect, it } from "vitest";
import { snapshotHash } from "./snapshot-hash";

describe("snapshotHash", () => {
  it("returns a 64-char lowercase hex string", async () => {
    const h = await snapshotHash(new Uint8Array([1, 2, 3]));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const a = await snapshotHash(new TextEncoder().encode("hello"));
    const b = await snapshotHash(new TextEncoder().encode("hello"));
    expect(a).toBe(b);
  });

  it("differs across bodies", async () => {
    const a = await snapshotHash(new TextEncoder().encode("a"));
    const b = await snapshotHash(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });
});
