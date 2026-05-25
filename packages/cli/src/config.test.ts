import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { loadAppConfig } from "./config.ts";

describe("loadAppConfig — auth field", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-cli-config-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("rejects a config that omits `auth`", async () => {
    await writeFile(
      join(root, "baerly.config.json"),
      JSON.stringify({ app: "x", tenant: "t", target: "cloudflare" }),
      "utf8",
    );
    await expect(loadAppConfig(root)).rejects.toThrow(/auth.+must be one of/);
  });

  test("rejects a config with a bogus `auth` value", async () => {
    await writeFile(
      join(root, "baerly.config.json"),
      JSON.stringify({ app: "x", tenant: "t", target: "cloudflare", auth: "jwt" }),
      "utf8",
    );
    await expect(loadAppConfig(root)).rejects.toThrow(/auth.+must be one of/);
  });

  test('accepts `auth: "none"` and round-trips the value', async () => {
    await writeFile(
      join(root, "baerly.config.json"),
      JSON.stringify({ app: "x", tenant: "t", target: "cloudflare", auth: "none" }),
      "utf8",
    );
    const config = await loadAppConfig(root);
    expect(config.auth).toBe("none");
  });

  test('accepts `auth: "shared-secret"` and round-trips the value', async () => {
    await writeFile(
      join(root, "baerly.config.json"),
      JSON.stringify({
        app: "x",
        tenant: "t",
        target: "node",
        auth: "shared-secret",
      }),
      "utf8",
    );
    const config = await loadAppConfig(root);
    expect(config.auth).toBe("shared-secret");
  });

  test("throws BaerlyError(InvalidConfig) on missing auth (code discriminant pinned)", async () => {
    await writeFile(
      join(root, "baerly.config.json"),
      JSON.stringify({ app: "x", tenant: "t", target: "cloudflare" }),
      "utf8",
    );
    try {
      await loadAppConfig(root);
      expect.fail("expected InvalidConfig throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });
});
