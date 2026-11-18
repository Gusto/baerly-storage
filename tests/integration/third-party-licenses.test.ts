import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSync, Visitor } from "rolldown/utils";
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

/** Placeholder `renderNotices` writes when a package ships no license file. */
const MISSING_LICENSE_TEXT = "(no license text found in package)";

/** Package names from a notices file's `<name>@<version>` block headers. */
const noticeNames = (manifest: string): string[] =>
  [...manifest.matchAll(/^(@?[^@\s]+)@\S+\nLicense: /gm)].map((m) => m[1]!).toSorted();

// Every third-party lib bundled into the root package across both
// rolldown builds. The library entries (root config) bundle the first
// group; the `baerly` bin (cli config) adds citty + jsonc-parser. The
// manifest MUST list each — a missing entry means a notice we're
// legally required to ship went missing.
const EXPECTED_LIBS = [
  // root library entries
  "aws4fetch",
  "@rgrove/parse-xml",
  "hono",
  "@hono/node-server",
  "jose",
  "@logtape/logtape",
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
        new RegExp(`^${RegExp.escape(lib)}@`, "m"),
      );
    }
  });

  test("carries verbatim license text", () => {
    const manifest = readFileSync(manifestPath, "utf8");
    // The MIT permission grant is the load-bearing notice MIT requires
    // to travel with the code; most bundled libs are MIT.
    expect(manifest).toContain("Permission is hereby granted");
    // ISC-licensed libs carry their own grant wording.
    expect(manifest).toMatch(/Permission to use, copy, modify|Permission is hereby granted/);
  });

  test("carries license text for every lib", () => {
    expect(readFileSync(manifestPath, "utf8")).not.toContain(MISSING_LICENSE_TEXT);
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

// `@gusto/create-baerly-storage` bundles every third-party dependency (its
// rolldown config externalizes only `node:` builtins), so its tarball ships
// its own notices file next to `dist/index.js`.
describe("create-baerly-storage bundles its dependencies with notices", () => {
  const scaffolderDist = resolve(__dirname, "../../packages/create-baerly-storage/dist");
  const scaffolderPkg = JSON.parse(
    readFileSync(resolve(scaffolderDist, "../package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  test("declares no runtime dependencies", () => {
    expect(scaffolderPkg.dependencies ?? {}).toEqual({});
  });

  test("dist/index.js imports only Node builtins", () => {
    const path = resolve(scaffolderDist, "index.js");
    const { program, errors } = parseSync(path, readFileSync(path, "utf8"), { lang: "js" });
    expect(errors).toEqual([]);
    const specifiers: string[] = [];
    const add = (node: unknown) => {
      if (node !== null && typeof node === "object" && "value" in node) {
        specifiers.push(String(node.value));
      }
    };
    new Visitor({
      ImportDeclaration: (n) => add(n.source),
      ExportAllDeclaration: (n) => add(n.source),
      ExportNamedDeclaration: (n) => add(n.source),
      ImportExpression: (n) => add(n.source),
    }).visit(program);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  // The expected set comes from the bundle itself: every `node_modules`
  // package the sourcemap names was inlined into `dist/index.js`.
  test("dist/THIRD-PARTY-LICENSES.txt lists exactly the bundled libs", () => {
    const map = JSON.parse(readFileSync(resolve(scaffolderDist, "index.js.map"), "utf8")) as {
      sources: string[];
    };
    const bundled = new Set<string>();
    for (const source of map.sources) {
      const name = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source)?.[1];
      if (name !== undefined) {
        bundled.add(name);
      }
    }
    // Guards against a sourcemap that stopped naming node_modules paths.
    expect([...bundled]).toEqual(expect.arrayContaining(["@clack/prompts", "citty"]));

    const manifest = readFileSync(resolve(scaffolderDist, "THIRD-PARTY-LICENSES.txt"), "utf8");
    expect(manifest).toContain("The @gusto/create-baerly-storage published package");
    expect(noticeNames(manifest)).toEqual([...bundled].toSorted());
  });

  test("dist/THIRD-PARTY-LICENSES.txt carries license text for every lib", () => {
    const manifest = readFileSync(resolve(scaffolderDist, "THIRD-PARTY-LICENSES.txt"), "utf8");
    expect(manifest).not.toContain(MISSING_LICENSE_TEXT);
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
