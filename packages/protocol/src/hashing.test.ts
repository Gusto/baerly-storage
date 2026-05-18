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
});
