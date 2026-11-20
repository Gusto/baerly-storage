import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (args: readonly string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5_000 });

describe("tree op model CLI inputs", () => {
  test.each([
    "--min-fanout=1",
    "--min-fanout=0",
    "--min-fanout=2.5",
    "--min-fanout=Infinity",
    "--max-fanout=31",
    "--max-fanout=32.5",
    "--max-fanout=NaN",
    "--leaf-bytes=0",
    "--leaf-bytes=-1",
    "--leaf-bytes=1.5",
    "--leaf-bytes=Infinity",
    "--leaf-bytes=16384,",
    "--min-fill=0",
    "--min-fill=-0.5",
    "--min-fill=1.1",
    "--min-fill=NaN",
    "--t-bytes=0",
    "--t-bytes=Infinity",
    "--t-rows=-1",
    "--t-rows=1.5",
    "--tail=-1000",
    "--tail=1.5",
    "--tail=",
    "--lag=-1",
    "--lag=Infinity",
    "--neighbors=-1",
    "--neighbors=0.5",
    "--splits=-1",
    "--splits=NaN",
    "--concurrent=-1",
    "--concurrent=0.5",
    "--sharing=unknown",
    "--write-read=unknown",
  ])("rejects %s before printing a model", (arg) => {
    const result = run([arg]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test("keeps the default model runnable with unbounded maximum fanout", () => {
    const result = run([]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("max fanout Infinity");
  });

  test("accepts bounded fanout, fractional fill and zero operation counts", () => {
    const result = run([
      "--leaf-bytes=16384,65536",
      "--min-fill=0.25",
      "--min-fanout=2",
      "--max-fanout=32",
      "--t-bytes=1",
      "--t-rows=1",
      "--tail=0",
      "--lag=0",
      "--neighbors=0",
      "--splits=0",
      "--concurrent=0",
      "--sharing=shared",
      "--write-read=scan",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("max fanout 32");
  });
});
