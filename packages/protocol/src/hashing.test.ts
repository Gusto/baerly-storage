import { describe, expect, test } from "vitest";

import { versionFromContent } from "./hashing.ts";

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

  test("padStart padding char is '0' not empty string", async () => {
    // The padStart(2, '0') call at line 44 is critical: if the second
    // argument is mutated to '' (empty string), then single-digit hex bytes
    // (0-15) won't be zero-padded. For input "payload_0", SHA-256 byte 11
    // is 0x09, producing single-digit "9" which needs "09" via padStart.
    // If the mutation to padStart(2, '') occurs, byte 11 produces "9" not "09",
    // shifting all subsequent digits and producing a different final 32-char VersionId.
    const v = await versionFromContent(enc.encode("payload_0"));
    expect(v).toBe("4f9373494fa72c4f2341a1097b5fda56");
  });
});
