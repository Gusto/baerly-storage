import { spawnSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const driver = new URL("./drive.ts", import.meta.url).href;

/** Run the real CLI with synthetic fixture files and no network or disk writes. */
const runFold = (kind: string) =>
  spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       import { syncBuiltinESMExports } from "node:module";
       const read = fs.readFileSync;
       const manifest = {
         tenant: "sample", kind: ${JSON.stringify(kind)}, smallFile: "small.json",
         snapshotKey: "original", logSeqStart: 6400, tailEntries: 6300, docId: "doc"
       };
       fs.readFileSync = (path, ...args) => {
         if (path === "bench-test-secret") return "x".repeat(32);
         if (String(path).endsWith("/out/manifest.json")) return JSON.stringify([manifest]);
         if (String(path).endsWith("/out/fixtures/small.json")) return "{}";
         return read(path, ...args);
       };
       fs.mkdirSync = () => {};
       fs.appendFileSync = () => {};
       syncBuiltinESMExports();
       globalThis.setTimeout = (fn) => { fn(); return 0; };
       let heads = 0;
       globalThis.fetch = async (url, options) => {
         console.log(JSON.stringify({ request: { path: url.pathname, body: options.body } }));
         if (url.pathname === "/bench/head") {
           return Response.json({ current: {
             snapshot: ++heads === 1 ? "original" : "folded",
             log_seq_start: heads === 1 ? 6400 : 12701
           } });
         }
         return Response.json({});
       };
       process.env.BENCH_URL = "https://bench.invalid";
       process.env.BENCH_SECRET_FILE = "bench-test-secret";
       process.argv = [process.execPath, "drive.ts", "fold", "sample", "1"];
       await import(${JSON.stringify(driver)});`,
    ],
    { encoding: "utf8", timeout: 25_000 },
  );

describe("forced fold CLI", () => {
  test.each(["rw", "natural"])("rejects %s cells before any request", (kind) => {
    const result = runFold(kind);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  test("cleans up the appended entry using the fixture's actual tail length", () => {
    const result = runFold("fold");
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const requests = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { request?: { path: string; body?: string } });
    const deletion = requests.find((line) => line.request?.path === "/bench/delete");
    expect(JSON.parse(deletion!.request!.body!)).toEqual([
      "app/pm/tenant/sample/manifests/notes/log/12700.json",
      "folded",
    ]);
  });
});
