import { describe, expect, test } from "vitest";
import { sha256Hex } from "./sha256.ts";

describe("sha256Hex", () => {
  test("a subarray view hashes like the equivalent slice", async () => {
    const buf = new Uint8Array(64).map((_, i) => i * 7);
    await expect(sha256Hex(buf.subarray(5, 40))).resolves.toBe(await sha256Hex(buf.slice(5, 40)));
  });

  test("a SharedArrayBuffer-backed view hashes like a copy", async () => {
    const shared = new Uint8Array(new SharedArrayBuffer(32)).map((_, i) => i + 1);
    await expect(sha256Hex(shared.subarray(3, 20))).resolves.toBe(
      await sha256Hex(shared.slice(3, 20)),
    );
  });

  test("known vector", async () => {
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
