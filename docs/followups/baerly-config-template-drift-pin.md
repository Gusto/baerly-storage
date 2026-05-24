# Pin `baerly.config.ts` template against `bolt-on` ↔ `scaffold` drift

**Severity: MEDIUM. Closes the only structural overlap between
`create-baerly`'s two emit paths.**

`pnpm create baerly .` dispatches to two different code paths
depending on whether `wrangler.jsonc` already exists in `outDir`.
Both paths can emit `baerly.config.ts`, from independent templates:

- **`packages/create-baerly/src/bolt-on.ts`'s `configTemplate(app, tenant)`** —
  inline interpolated string written when bolting onto an existing
  wrangler project.
- **`examples/<name>/baerly.config.ts`** — checked-in file run
  through `packages/create-baerly/src/substitute.ts` at scaffold
  time with `{{appName}}` / `{{tenant}}` sentinels.

Without a pin, the two can drift: a new required field added to
`baerly.config.ts` lands in one path and silently doesn't land in
the other. The four `examples/*/baerly.config.ts` files are typecheck-
gated by `pnpm verify:examples`, but `bolt-on.ts`'s template is just a
string — no compiler watches it.

## What to do

Add one integration test that drives both paths against the same
inputs and asserts the rendered `baerly.config.ts` is equivalent.

Recommended location: `packages/create-baerly/src/baerly-config-drift.test.ts`
(co-located with the other create-baerly tests; no infra needed).

Shape:

```ts
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { boltOnExistingWrangler } from "./bolt-on.ts";
import { runCreateBaerly } from "./runner.ts";

describe("baerly.config.ts drift pin", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  test("bolt-on and cloudflare scaffold emit equivalent baerly.config.ts shape", async () => {
    // Bolt-on path
    const boltDir = await mkdtemp(join(tmpdir(), "bolt-"));
    dirs.push(boltDir);
    await writeFile(
      join(boltDir, "wrangler.jsonc"),
      `{ "name": "foo", "main": "src/index.ts", "compatibility_date": "2026-05-24" }`,
    );
    await writeFile(join(boltDir, "package.json"), JSON.stringify({ name: "foo", version: "0.0.0" }));
    await boltOnExistingWrangler({ outDir: boltDir, tenant: "bar", runInstall: false });

    // Scaffold path
    const scaffoldRoot = await mkdtemp(join(tmpdir(), "scaffold-"));
    dirs.push(scaffoldRoot);
    const cwd = process.cwd();
    process.chdir(scaffoldRoot);
    try {
      const code = await runCreateBaerly(["foo", "--target=cloudflare", "--starter=minimal", "--json"]);
      expect(code).toBe(0);
    } finally {
      process.chdir(cwd);
    }

    const boltConfig = await readFile(join(boltDir, "baerly.config.ts"), "utf8");
    const scaffoldConfig = await readFile(join(scaffoldRoot, "foo", "baerly.config.ts"), "utf8");

    // Key-set comparison: byte-equality would fail on legitimate
    // formatting differences, but a new required field showing up
    // in one path will always shift the key set.
    expect(extractDefineConfigKeys(boltConfig).toSorted()).toEqual(
      extractDefineConfigKeys(scaffoldConfig).toSorted(),
    );
  });
});

const extractDefineConfigKeys = (src: string): string[] => {
  const body = src.match(/defineConfig\(\{([\s\S]*?)\}\)/)?.[1];
  if (!body) throw new Error("could not find defineConfig({...}) in source");
  return Array.from(body.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)).map((m) => m[1] as string);
};
```

The key-set comparison is the load-bearing assertion: byte-equality
would fail on legitimate differences (e.g. the bolt-on template
hard-codes `target: "cloudflare"` while the scaffold's `cloudflare`
example carries the same field via substitution), but a new required
field showing up in one path will always shift the key set.

## Wiring

- The test imports `boltOnExistingWrangler` + `runCreateBaerly` from
  sibling modules — no cross-package wiring needed.
- The file lives under `packages/create-baerly/src/`, so it's in the
  default vitest project glob. No infra needed (no Minio, no
  credentials).

## When to delete

If `baerly.config.ts` ever grows ≥3 required fields with non-trivial
validation, extract a shared `renderBaerlyConfig({app, tenant,
target}): string` (probably in `@baerly/protocol` since both
`bolt-on.ts` and the example templates would consume it), have both
paths import it, and delete this drift-pin test. The shared module's
existence is its own pin at that point.

Until then, the test is cheaper than the abstraction.
