/**
 * Smoke tests for `scripts/lint-use-query.mjs`. Runs the scanner
 * out-of-process against synthetic source dropped into a real
 * scan-glob path (one of the scaffolds), asserts findings surface
 * for each violation pattern and stay quiet on supported patterns.
 *
 * The scanner is the edit-time half of the recorder safety net;
 * the runtime sentinel in `packages/client/src/react/use-query.ts`
 * is the runtime half.
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SCRIPT = join(REPO_ROOT, "scripts/lint-use-query.mjs");
const FIXTURE_DIR = join(REPO_ROOT, "examples/react-cloudflare/src/web");

let counter = 0;

const runOnFixture = (source: string): { exitCode: number; stderr: string } => {
  counter += 1;
  const name = `__lint-fixture-${process.pid}-${counter}.tsx`;
  const abs = join(FIXTURE_DIR, name);
  writeFileSync(abs, source);
  try {
    execFileSync("node", [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer | string };
    return {
      exitCode: e.status ?? 1,
      stderr: typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? ""),
    };
  } finally {
    rmSync(abs, { force: true });
  }
};

describe("lint-use-query", () => {
  test("flags async callbacks", () => {
    const { exitCode, stderr } = runOnFixture(
      `import { useQuery } from "baerly-storage/client/react";
const x = (id: string) => useQuery(async (c) => c.table("notes").get(id), [id]);
`,
    );
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/must be synchronous/);
  });

  test("flags `await` inside the callback body", () => {
    const { exitCode, stderr } = runOnFixture(
      `import { useQuery } from "baerly-storage/client/react";
const x = (id: string) => useQuery((c) => { return (async () => await c.table("notes").get(id))(); }, [id]);
`,
    );
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/must not contain `await`/);
  });

  test("does NOT flag awaits inside comments", () => {
    const { exitCode } = runOnFixture(
      `import { useQuery } from "baerly-storage/client/react";
const x = (id: string) => useQuery((c) => {
  // discussion of why we don't await here
  return c.table("notes").get(id);
}, [id]);
`,
    );
    expect(exitCode).toBe(0);
  });

  test("does NOT flag the supported patterns", () => {
    const { exitCode } = runOnFixture(
      `import { useQuery } from "baerly-storage/client/react";
const single = (id: string) => useQuery((c) => c.table("notes").get(id), [id]);
const skipForm = (id?: string) => useQuery((c) => id ? c.table("notes").get(id) : useQuery.skip, [id]);
const parallel = (id: string) => useQuery((c) => Promise.all([
  c.table("notes").get(id),
  c.table("comments").where({ noteId: id }).all(),
]), [id]);
`,
    );
    expect(exitCode).toBe(0);
  });
});
