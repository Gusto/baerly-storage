// tests/integration/s3-worker-safe.test.ts
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
const s3Entry = resolve(distDir, "s3.js");

describe("@gusto/baerly-storage/s3 is Worker-safe", () => {
  test("dist/s3.js exists (built by pretest)", () => {
    expect(existsSync(s3Entry)).toBe(true);
  });

  test("bundles for the browser/worker platform with no node: builtin", async () => {
    // platform:"browser" does NOT auto-externalize node: builtins — if
    // the closure imports one, esbuild fails to resolve it. A clean build
    // proves the closure is Workerd-loadable.
    const result = await build({
      entryPoints: [s3Entry],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const code = result.outputFiles.map((f) => f.text).join("\n");
    // Belt-and-suspenders: no literal node: specifier survived inlining.
    expect(code).not.toMatch(/["']node:/);
  });
});
