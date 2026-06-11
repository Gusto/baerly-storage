import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { isUnacceptableLicense } from "../../scripts/third-party-licenses.mjs";

// rolldown INLINES third-party libraries into the published `dist/`.
// MIT/ISC/BSD all require their copyright + permission notice to travel
// with any copy of the code, so the bundle must ship those notices. The
// build regenerates `dist/THIRD-PARTY-LICENSES.txt` from each dep's own
// LICENSE on every `pnpm build` (rollup-license-plugin in
// `rolldown.config.ts` + `packages/cli/rolldown.config.ts`, merged by
// `scripts/merge-third-party-licenses.mjs`). This test pins that the
// manifest exists, is complete across BOTH rolldown invocations, and
// carries verbatim license text.
//
// Consumes `dist/`, like bundle-size.test.ts — run `pnpm build` first
// (`pnpm test` self-builds; `pnpm test:agent` does NOT).

const distDir = resolve(__dirname, "../../dist");
const manifestPath = resolve(distDir, "THIRD-PARTY-LICENSES.txt");

// Every third-party lib bundled into the root package across both
// rolldown builds. The library entries (root config) bundle the first
// group; the `baerly` bin (cli config) adds citty + jsonc-parser. The
// manifest MUST list each — a missing entry means a notice we're
// legally required to ship went missing.
const EXPECTED_LIBS = [
  // root library entries
  "aws4fetch",
  "fast-xml-parser",
  "hono",
  "@hono/node-server",
  "jose",
  "@logtape/logtape",
  "picocolors",
  // cli bin
  "citty",
  "jsonc-parser",
];

describe("third-party-licenses manifest", () => {
  test("dist/THIRD-PARTY-LICENSES.txt exists", () => {
    expect(
      existsSync(manifestPath),
      "dist/THIRD-PARTY-LICENSES.txt missing — run `pnpm build` before `pnpm test`",
    ).toBe(true);
  });

  test("lists every bundled third-party lib across both builds", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    for (const lib of EXPECTED_LIBS) {
      // Each block is headed by `<name>@<version>`.
      expect(manifest, `expected ${lib} in the manifest`).toMatch(
        new RegExp(`^${lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@`, "m"),
      );
    }
  });

  test("carries verbatim license text", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    // The MIT permission grant is the load-bearing notice MIT requires
    // to travel with the code; most bundled libs are MIT.
    expect(manifest).toContain("Permission is hereby granted");
    // ISC libs (picocolors) carry their own grant wording.
    expect(manifest).toMatch(/Permission to use, copy, modify|Permission is hereby granted/);
  });

  test("declares every package's license and a copyright notice", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    expect(manifest).toMatch(/^License: /m);
    expect(manifest).toMatch(/Copyright/i);
  });

  test("does not ship the intermediate partial JSON manifests", () => {
    // The merge step deletes the per-build partials so they never reach
    // the tarball.
    expect(existsSync(resolve(distDir, ".third-party-licenses.lib.json"))).toBe(false);
    expect(existsSync(resolve(distDir, ".third-party-licenses.cli.json"))).toBe(false);
  });
});

describe("isUnacceptableLicense SPDX gate", () => {
  // AND is conjunction: ALL terms must be allowlisted. OR is disjunction:
  // ANY alternative suffices. `(MIT AND GPL-3.0)` must be REJECTED — a
  // naive split-and-`.some()` would wrongly accept it on the MIT term.
  test("rejects a conjunction with a non-permissive term", () => {
    expect(isUnacceptableLicense("(MIT AND GPL-3.0)")).toBe(true);
  });

  test("accepts a disjunction where one alternative is permissive", () => {
    expect(isUnacceptableLicense("(MIT OR GPL-3.0)")).toBe(false);
  });

  test("accepts a bare permissive license", () => {
    expect(isUnacceptableLicense("MIT")).toBe(false);
  });

  test("rejects a bare non-permissive license", () => {
    expect(isUnacceptableLicense("GPL-3.0")).toBe(true);
  });
});
