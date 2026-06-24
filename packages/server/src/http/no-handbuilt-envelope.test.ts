import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Walk the three packages that emit wire responses; flag any hand-built
// `error: { code` object literal in non-test source. The single sanctioned
// constructor is `errorEnvelope` (packages/server/src/contract.ts). WS4's
// body-cap bug was a hand-built envelope that silently dropped a wire field —
// this guard makes that class of bug a red test, not a review miss.
const ROOTS = [
  "packages/server/src",
  "packages/adapter-node/src",
  "packages/adapter-cloudflare/src",
];
// `contract.ts` is where errorEnvelope itself lives.
const ALLOW = new Set(["packages/server/src/contract.ts"]);
// Repo root is four levels up from packages/server/src/http.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

function tsFiles(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const rel = join(dir, name);
    const full = join(REPO_ROOT, rel);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(rel));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(rel);
    }
  }
  return out;
}

describe("no hand-built wire error envelopes", () => {
  test("every error payload is built by errorEnvelope", () => {
    const offenders: string[] = [];
    // 80-char window avoids false positives from unrelated {error:…}/{code:…} coincidences; an offender placing 80+ chars before `code:` would slip through (acceptable — catches the realistic compact shape).
    const pattern = /error\s*:\s*\{[\s\S]{0,80}?\bcode\s*:/;
    for (const root of ROOTS) {
      for (const rel of tsFiles(root)) {
        if (ALLOW.has(rel)) {
          continue;
        }
        if (pattern.test(readFileSync(join(REPO_ROOT, rel), "utf8"))) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
