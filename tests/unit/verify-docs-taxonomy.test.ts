import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../../scripts/verify-docs-taxonomy.mjs", import.meta.url).pathname;

function runScript(projectRoot: string): { code: number | null; stdout: string; stderr: string } {
  // The script reads VERIFY_DOCS_TAXONOMY_ROOT to allow pointing at a temp
  // dir; projectRoot must have docs/spec/ and docs/adr/ subdirectories.
  const result = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, VERIFY_DOCS_TAXONOMY_ROOT: projectRoot },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "verify-docs-taxonomy-test-"));
  mkdirSync(join(tmpRoot, "docs", "spec"), { recursive: true });
  mkdirSync(join(tmpRoot, "docs", "adr"), { recursive: true });
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function writeSpec(rel: string, body: string): void {
  writeFileSync(join(tmpRoot, "docs", "spec", rel), body);
}
function writeAdr(rel: string, body: string): void {
  writeFileSync(join(tmpRoot, "docs", "adr", rel), body);
}

/** A clean, minimal-but-valid spec + ADR tree the lint should accept. */
function seedValidTree(): void {
  writeSpec(
    "README.md",
    `---\ndoc_type: evidence-index\n---\n` +
      `# spec\n\n## Current contracts\n\n- [sync-protocol.md](sync-protocol.md)\n\n` +
      `## Semantic references\n\n- [json-merge-patch.md](json-merge-patch.md)\n\n` +
      `## Verification\n\n- [causal-consistency-checking.md](causal-consistency-checking.md)\n\n` +
      `## Adapter edge cases\n\n- [s3-xml-escaping-cases.md](s3-xml-escaping-cases.md)\n\n` +
      `## Historical, rationale & evidence\n\n` +
      `- [writer-fence-adversarial-model.md](writer-fence-adversarial-model.md)\n` +
      `- [prior-art.md](prior-art.md)\n`,
  );
  writeSpec("sync-protocol.md", `---\ndoc_type: current-contract\n---\n`);
  writeSpec("json-merge-patch.md", `---\ndoc_type: semantic-reference\n---\n`);
  writeSpec("causal-consistency-checking.md", `---\ndoc_type: verification\n---\n`);
  writeSpec("s3-xml-escaping-cases.md", `---\ndoc_type: adapter-edge-case\n---\n`);
  writeSpec("writer-fence-adversarial-model.md", `---\ndoc_type: historical\n---\n`);
  writeSpec("prior-art.md", `---\ndoc_type: rationale\n---\n`);
  writeAdr("README.md", `---\ndoc_type: evidence-index\n---\n# adr\n\n- [001 — X](./001-x.md)\n`);
  writeAdr("001-x.md", `---\ndoc_type: adr\n---\n`);
}

test("passes on a clean spec + ADR tree", () => {
  seedValidTree();
  const r = runScript(tmpRoot);
  expect(r.code).toBe(0);
});

test("fails when a spec doc is missing doc_type", () => {
  seedValidTree();
  writeSpec("new-spec.md", `---\ntitle: New\n---\n`);
  // also index it so we isolate the doc_type failure
  writeSpec(
    "README.md",
    `---\ndoc_type: evidence-index\n---\n# spec\n\n` +
      `- [sync-protocol.md](sync-protocol.md)\n- [prior-art.md](prior-art.md)\n- [new-spec.md](new-spec.md)\n`,
  );
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/new-spec\.md: missing `doc_type:`/);
});

test("fails when an ADR is missing doc_type", () => {
  seedValidTree();
  writeAdr("002-y.md", `---\ntitle: Y\n---\n`);
  writeAdr(
    "README.md",
    `---\ndoc_type: evidence-index\n---\n# adr\n\n- [001 — X](./001-x.md)\n- [002 — Y](./002-y.md)\n`,
  );
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/002-y\.md: missing `doc_type:`/);
});

test("fails on a doc_type outside the controlled vocabulary", () => {
  seedValidTree();
  writeSpec("sync-protocol.md", `---\ndoc_type: made-up\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/not in the spec vocabulary/);
});

test("fails when an ADR carries a non-adr doc_type", () => {
  seedValidTree();
  writeAdr("001-x.md", `---\ndoc_type: current-contract\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/invalid for an ADR/);
});

test("fails on an unindexed spec doc", () => {
  seedValidTree();
  writeSpec("orphan.md", `---\ndoc_type: verification\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/orphan\.md: not linked from/);
});

test("fails on a duplicate index entry", () => {
  seedValidTree();
  writeSpec(
    "README.md",
    `---\ndoc_type: evidence-index\n---\n# spec\n\n` +
      `- [sync-protocol.md](sync-protocol.md)\n- [sync-protocol.md](sync-protocol.md)\n- [prior-art.md](prior-art.md)\n`,
  );
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/links sync-protocol\.md 2 times/);
});

test("fails when prior-art is filed as a current contract via doc_type", () => {
  seedValidTree();
  writeSpec("prior-art.md", `---\ndoc_type: current-contract\n---\n`);
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/prior-art\.md: doc_type `current-contract` is wrong/);
});

test("fails when a historical doc is listed under Current contracts", () => {
  seedValidTree();
  // prior-art keeps doc_type: rationale but is moved under the
  // "Current contracts" heading — section/metadata incoherence.
  writeSpec(
    "README.md",
    `---\ndoc_type: evidence-index\n---\n# spec\n\n## Current contracts\n\n` +
      `- [sync-protocol.md](sync-protocol.md)\n- [prior-art.md](prior-art.md)\n`,
  );
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(
    /prior-art\.md has doc_type `rationale` but is listed under "Current contracts", not "Historical, rationale & evidence"/,
  );
});

test("fails when a current-contract doc is filed under another heading", () => {
  seedValidTree();
  // sync-protocol keeps doc_type: current-contract but is moved out of the
  // "Current contracts" section into "Historical" — forward-direction
  // incoherence: a live contract hiding under the wrong heading.
  writeSpec(
    "README.md",
    `---\ndoc_type: index\n---\n# spec\n\n## Current contracts\n\n` +
      `## Historical, rationale & evidence\n\n` +
      `- [sync-protocol.md](sync-protocol.md)\n- [prior-art.md](prior-art.md)\n`,
  );
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(
    /sync-protocol\.md has doc_type `current-contract` but is listed under "Historical, rationale & evidence", not "Current contracts"/,
  );
});

test.each([
  ["json-merge-patch.md", "semantic-reference", "Semantic references"],
  ["causal-consistency-checking.md", "verification", "Verification"],
  ["s3-xml-escaping-cases.md", "adapter-edge-case", "Adapter edge cases"],
])("fails when %s is filed outside its doc_type section", (file, docType, expectedSection) => {
  seedValidTree();
  writeSpec(file, `---\ndoc_type: ${docType}\n---\n`);
  writeSpec(
    "README.md",
    `---\ndoc_type: index\n---\n# spec\n\n## Current contracts\n\n` +
      `- [sync-protocol.md](sync-protocol.md)\n\n` +
      `## Historical, rationale & evidence\n\n` +
      `- [prior-art.md](prior-art.md)\n- [${file}](${file})\n`,
  );
  const r = runScript(tmpRoot);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(
    `${file} has doc_type \`${docType}\` but is listed under "Historical, rationale & evidence", not "${expectedSection}"`,
  );
});
