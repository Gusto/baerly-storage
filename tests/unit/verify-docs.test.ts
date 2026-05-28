import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../../scripts/verify-docs.mjs", import.meta.url).pathname;

function runScript(projectRoot: string): { code: number | null; stdout: string; stderr: string } {
  // The script reads VERIFY_DOCS_ROOT to allow pointing at a temp dir;
  // projectRoot must have a `docs/` subdirectory.
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, VERIFY_DOCS_ROOT: projectRoot },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "verify-docs-test-"));
  mkdirSync(join(tmpRoot, "docs"));
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function write(rel: string, body: string): void {
  writeFileSync(join(tmpRoot, "docs", rel), body);
}

test("passes on a doc with valid frontmatter and resolved related link", () => {
  write(
    "a.md",
    `---\ntitle: A\naudience: meta\nlast-reviewed: 2026-05-28\nrelated: ["./b.md"]\n---\n`,
  );
  write("b.md", `---\ntitle: B\naudience: meta\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(0);
});

test("fails on missing audience field", () => {
  write("a.md", `---\ntitle: A\nlast-reviewed: 2026-05-28\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/missing 'audience'/);
});

test("fails on invalid audience value", () => {
  write("a.md", `---\ntitle: A\naudience: app-developer\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/invalid audience 'app-developer'/);
});

test("fails on broken related: link", () => {
  write("a.md", `---\ntitle: A\naudience: meta\nrelated: ["./does-not-exist.md"]\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/broken related link/);
});

test("fails on last-reviewed older than 180 days", () => {
  // 365 days ago is well past the 180d threshold.
  const stale = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  write("a.md", `---\ntitle: A\naudience: meta\nlast-reviewed: ${stale}\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/last-reviewed.*d ago/);
});
