# Pin `baerly.config.ts` template against `baerly init` ↔ `create-baerly` drift

**Severity: MEDIUM. Closes the only structural overlap between
`baerly init` and `create-baerly`.**

`baerly init` and `create-baerly` are intentionally separate
binaries serving different audiences (operator wiring vs. fresh-app
scaffolding). The only file shape they both produce is
`baerly.config.ts`, rendered from two independent code paths:

- **`packages/cli/src/init.ts:60-68`** — inline `template(app, tenant,
  target)` returning a hand-written interpolated string.
- **`examples/<name>/baerly.config.ts`** — checked-in file run
  through `packages/create-baerly/src/substitute.ts` at scaffold
  time with `{{appName}}` / `{{tenant}}` sentinels.

Without a pin, the two can drift: a new required field added to
`baerly.config.ts` lands in one path and silently doesn't land in
the other. The four `examples/*/baerly.config.ts` files are typecheck-
gated by `pnpm verify:examples`, but `init.ts`'s template is just a
string — no compiler watches it.

## What to do

Add one integration test that drives both paths against the same
inputs and asserts the rendered `baerly.config.ts` is equivalent.

Recommended location: `tests/integration/baerly-config-drift.test.ts`
(cross-package; same tier as `http-conformance` / `randomized` /
`export-smoke`).

Shape:

```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runInit } from "@baerly/cli";
import { runCreateBaerly } from "create-baerly/src/runner.ts";

describe("baerly.config.ts drift pin", () => {
  let dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  test.each([
    { target: "cloudflare" as const, starter: "minimal" as const },
    { target: "node" as const, starter: "minimal" as const },
  ])("init vs create-baerly emit equivalent config for $target", async ({ target, starter }) => {
    const initDir = await mkdtemp(join(tmpdir(), "init-"));
    const scaffoldRoot = await mkdtemp(join(tmpdir(), "scaffold-"));
    dirs.push(initDir, scaffoldRoot);

    const cwd = process.cwd();
    process.chdir(initDir);
    try {
      const initCode = await runInit(["--app=foo", "--tenant=bar", `--target=${target}`, "--force"]);
      expect(initCode).toBe(0);
    } finally {
      process.chdir(cwd);
    }

    process.chdir(scaffoldRoot);
    try {
      const code = await runCreateBaerly(["foo", `--target=${target}`, `--starter=${starter}`, "--json"]);
      expect(code).toBe(0);
    } finally {
      process.chdir(cwd);
    }

    const initConfig = await readFile(join(initDir, "baerly.config.ts"), "utf8");
    const scaffoldConfig = await readFile(join(scaffoldRoot, "foo", "baerly.config.ts"), "utf8");

    // Either:
    //  (a) assert byte-equal modulo whitespace + import path differences, OR
    //  (b) parse both via a JS regex over `defineConfig({ … })` and assert
    //      the key set is identical. (b) is more resilient to legitimate
    //      shape differences like the imports stanza.
    const keysFromInit = extractDefineConfigKeys(initConfig);
    const keysFromScaffold = extractDefineConfigKeys(scaffoldConfig);
    expect(keysFromInit.toSorted()).toEqual(keysFromScaffold.toSorted());
  });
});

const extractDefineConfigKeys = (src: string): string[] => {
  const body = src.match(/defineConfig\(\{([\s\S]*?)\}\)/)?.[1];
  if (!body) throw new Error("could not find defineConfig({...}) in source");
  return Array.from(body.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)).map((m) => m[1]);
};
```

The key-set comparison is the load-bearing assertion: byte-equality
would fail on legitimate differences (e.g. `init`'s template
hard-codes the import from `"baerly-storage/config"` while a scaffold's
might evolve to a different shape), but a new required field
showing up in one path will always shift the key set.

## Wiring

- The test imports `runInit` from `@baerly/cli` and `runCreateBaerly`
  from `create-baerly/src/runner.ts`. Both are already exported for
  test consumption.
- `tests/integration/` is in the default vitest project glob, so
  this runs on every `pnpm test` / `pnpm verify`. No infra needed
  (no Minio, no credentials).
- Add `create-baerly` to the root devDependencies if not already
  workspace-linked from `tests/`. Confirm via `pnpm install --frozen-lockfile`
  after the edit.

## When to delete

If `baerly.config.ts` ever grows ≥3 required fields with non-trivial
validation, extract a shared `renderBaerlyConfig({app, tenant,
target}): string` (probably in `@baerly/protocol` since both
`@baerly/cli` and `create-baerly` would consume it), have both paths
import it, and delete this drift-pin test. The shared module's
existence is its own pin at that point.

Until then, the test is cheaper than the abstraction.
