import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The package-layer gate is the `no-restricted-imports` overrides in
// `.oxlintrc.json`. Each fixture below is written into a scratch tree that
// carries a copy of that config and linted with the repo's oxlint, so a
// violation class that stops failing (or an allowed edge that starts failing)
// turns this red.

const ROOT = resolve(import.meta.dirname, "../..");
const RULE = "eslint(no-restricted-imports)";

// Independent of the config: package -> @baerly/* packages it may import.
const ALLOWS: Record<string, string[]> = {
  protocol: [],
  server: ["protocol"],
  dev: ["protocol", "server", "adapter-node"],
  "adapter-node": ["protocol", "server", "dev"],
  "adapter-cloudflare": ["protocol", "server", "dev"],
  client: ["protocol", "server"],
  cli: ["protocol", "server", "dev", "adapter-node", "adapter-cloudflare", "client"],
  "create-baerly-storage": ["protocol", "server", "cli"],
};
const PACKAGES = Object.keys(ALLOWS);

type Fixture = { path: string; source: string; violates: boolean };

const fixtures: Fixture[] = [];
for (const owner of PACKAGES) {
  for (const target of PACKAGES) {
    if (target === owner) {
      continue;
    }
    const violates = !ALLOWS[owner]!.includes(target);
    const base = `packages/${owner}/src/edge-${target}`;
    fixtures.push(
      { path: `${base}-bare.ts`, source: `import { x } from "@baerly/${target}";\nx;\n`, violates },
      {
        path: `${base}-subpath.ts`,
        source: `import { x } from "@baerly/${target}/http";\nx;\n`,
        violates,
      },
      {
        path: `${base}-dynamic.ts`,
        source: `export const m = import("@baerly/${target}");\n`,
        violates,
      },
      {
        path: `${base}-relative.ts`,
        source: `import { x } from "../../${target}/src/index.ts";\nx;\n`,
        violates,
      },
      {
        path: `${base}-reexport.ts`,
        source: `export { x } from "@baerly/${target}";\n`,
        violates,
      },
      {
        path: `${base}-type.ts`,
        source: `import type { X } from "@baerly/${target}";\nexport type Y = X;\n`,
        violates,
      },
    );
  }
}

// `node:` builtin purity: protocol allows none, server and adapter-cloudflare
// allow only `node:async_hooks`, the rest are Node-only by design.
const NODE_ALLOWS: Record<string, string[] | undefined> = {
  protocol: [],
  server: ["node:async_hooks"],
  "adapter-cloudflare": ["node:async_hooks"],
};
for (const owner of PACKAGES) {
  const allowed = NODE_ALLOWS[owner];
  for (const builtin of ["node:fs", "node:fs/promises", "node:async_hooks"]) {
    const violates = allowed !== undefined && !allowed.includes(builtin);
    const name = builtin.replace("node:", "node-").replace("/", "-");
    fixtures.push(
      {
        path: `packages/${owner}/src/${name}-static.ts`,
        source: `import * as m from "${builtin}";\nm;\n`,
        violates,
      },
      {
        path: `packages/${owner}/src/${name}-dynamic.ts`,
        source: `export const m = import("${builtin}");\n`,
        violates,
      },
    );
  }
}

// Not package edges: same-package relatives, third-party, and test files.
fixtures.push(
  {
    path: "packages/protocol/src/sibling.ts",
    source: `import { x } from "./json.ts";\nx;\n`,
    violates: false,
  },
  {
    path: "packages/protocol/src/third-party.ts",
    source: `import { x } from "aws4fetch";\nx;\n`,
    violates: false,
  },
  {
    path: "packages/protocol/src/exempt.test.ts",
    source: `import { x } from "@baerly/server";\nx;\n`,
    violates: false,
  },
  {
    path: "packages/protocol/src/exempt.test-d.ts",
    source: `import { x } from "@baerly/server";\nx;\n`,
    violates: false,
  },
);

let dir = "";
let flagged = new Set<string>();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "layer-rules-"));
  copyFileSync(join(ROOT, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
  for (const f of fixtures) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.source);
  }
  let stdout = "";
  try {
    stdout = execFileSync(
      join(ROOT, "node_modules/.bin/oxlint"),
      ["--format=json", "-c", ".oxlintrc.json", "packages"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // oxlint exits non-zero when it reports; the report is on stdout.
    stdout = (error as { stdout: string }).stdout;
  }
  const report = JSON.parse(stdout) as { diagnostics: { code: string; filename: string }[] };
  flagged = new Set(report.diagnostics.filter((d) => d.code === RULE).map((d) => d.filename));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("oxlint package-layer rules", () => {
  test("every fixture class is covered", () => {
    expect(fixtures.filter((f) => f.violates).length).toBeGreaterThan(100);
    expect(fixtures.filter((f) => !f.violates).length).toBeGreaterThan(30);
  });

  for (const owner of PACKAGES) {
    test(`${owner}: forbidden edges fail, allowed edges pass`, () => {
      const mine = fixtures.filter((f) => f.path.startsWith(`packages/${owner}/src/`));
      const wrong = mine
        .filter((f) => flagged.has(f.path) !== f.violates)
        .map((f) => `${f.path} (expected ${f.violates ? "violation" : "clean"})`);
      expect(wrong).toEqual([]);
    });
  }
});
