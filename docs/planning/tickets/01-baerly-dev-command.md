# 01 — `baerly dev` unified local-development verb

**One-liner.** Add a `dev` subcommand to `@baerly/cli` that boots a
Node `http.Server` over `LocalFsStorage` regardless of the
configured deploy target, with a `--wrangler` escape hatch for
Cloudflare-target parity testing.

**Estimated effort.** 2 days. **Risk.** Medium — first CLI verb
that imports `@baerly/adapter-node` and brings up a live listener.

---

> **Self-contained.** You don't need to consult any planning notes
> or chat logs. Everything you need is in this file, the repo
> source, `CLAUDE.md`, and the path-scoped conventions referenced
> at the bottom.

## Why we're doing this

After scaffolding, the canonical day-1 path should be:

```
$ npm create baerly@latest my-app
$ cd my-app && pnpm install
$ pnpm dev   # → baerly dev → http://localhost:3000
```

Today there is no `baerly dev`. The two templates' `dev` scripts
diverge: `examples/minimal-cloudflare/apps/server/package.json`
runs `wrangler dev` (downloads `workerd` on first run, slower
boot, requires R2 emulator), and
`examples/minimal-node/apps/server/package.json` runs
`tsx watch src/server.ts` (already fine, but bespoke per
template). Convex's `convex dev`, Prisma's `prisma dev`, and
similar verbs have shown that **one unified local-dev verb that
works the same regardless of deploy target** is the canonical
shape users expect.

`baerly dev` does this: it boots a Node listener over
`LocalFsStorage` on `:3000` so iteration is fast and identical
across CF and Node targets. When the user wants CF parity
(R2-binding behavior, observability hooks), `baerly dev --wrangler`
shells out to `wrangler dev` from `apps/server/`. The default path
needs zero external binaries.

## Current state

- The CLI is built with `citty`. Subcommands are registered in
  `packages/cli/src/baerly.ts:46` (`subCommands: { ... }`). Each
  subcommand is a `defineCommand` block in its own module
  (`src/<cmd>.ts`).
- The config loader is at `packages/cli/src/config.ts:72`:
  `loadAppConfig(cwd?: string): Promise<AppConfig>`. The
  `AppConfig` interface (line 30) declares fields including
  `app: string`, `tenant?: string`, `target: "cloudflare" |
  "node"`, plus optional fields used by deploy/doctor.
- `@baerly/adapter-node` exports the listener factory and the
  re-exported `LocalFsStorage`. See
  `packages/adapter-node/src/index.ts:37-41`:
  - `LocalFsStorage` (re-exported from `@baerly/dev`)
  - `LocalFsStorageOptions` type
  - `createListener` from `./server.ts`
  - `runMaintenanceTick` (also from `./server.ts`)
- `@baerly/server` (the main barrel) re-exports the verifier
  factories: `sharedSecret`, `cloudflareAccess`
  (`packages/server/src/index.ts:119-120`).
- `@baerly/dev` exports `ensureTable(storage, { app, tenant,
  table })` from `packages/dev/src/ensure-table.ts:29`.
- `BaerlyError` is the error base class at
  `packages/protocol/src/errors.ts`; the relevant code for
  CLI-level user-facing errors is `"InvalidConfig"`.
- The CLI's existing `@baerly/cli/package.json` dependencies
  (lines 20-30) **do not** include `@baerly/adapter-node`. This
  ticket adds it.

The CLI's exit-code contract (from `packages/cli/README.md`):
0 = success, 1 = user error, 2 = storage error, 3 = protocol
invariant. `--json` flips stdout to a JSON envelope. Errors thrown
synchronously from a command body propagate through citty's
runner; the existing pattern in `packages/cli/src/copy.ts` and
`packages/cli/src/inspect.ts` wraps the body in `try { ... } catch
(err) { ... process.exit(N) }` with JSON-vs-plaintext branching.

## Implementation steps

### Step 1. Add `@baerly/adapter-node` to the CLI's deps

Edit `packages/cli/package.json`. Add to `dependencies`:

```json
"@baerly/adapter-node": "workspace:*",
```

Run `pnpm install` to update the lockfile (no other changes
needed).

### Step 2. Create `packages/cli/src/dev.ts`

The command body (commit to this shape — names and ordering
intentional):

```ts
import { createServer } from "node:http";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { createListener, LocalFsStorage } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server";
import { ensureTable } from "@baerly/dev";
import { BaerlyError } from "@baerly/protocol";
import { spawn } from "node:child_process";
import { loadAppConfig } from "./config.ts";

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = "./.baerly-data";
const DEV_SECRET_FALLBACK = "dev-only-secret";

export const runDev = async (opts: {
  cwd?: string;
  port: number;
  dataDir: string;
  wrangler: boolean;
  json: boolean;
}): Promise<{ port: number; dataDir: string; target: string }> => {
  const cwd = opts.cwd ?? process.cwd();
  const config = await loadAppConfig(cwd);
  if (opts.wrangler) {
    if (config.target !== "cloudflare") {
      throw new BaerlyError(
        "InvalidConfig",
        "--wrangler requires baerly.config.ts:target === 'cloudflare'",
      );
    }
    return runWranglerDev({ cwd, config });
  }
  const dataDir = resolve(cwd, opts.dataDir);
  const storage = new LocalFsStorage({ root: dataDir });
  const tenant = config.tenant ?? "default";
  const verifier = sharedSecret({
    secret: process.env.BAERLY_DEV_SECRET ?? DEV_SECRET_FALLBACK,
    tenantPrefix: tenant,
  });
  // If config declares collections, ensure each table exists in the
  // local store before the listener serves any request.
  for (const [table] of Object.entries(config.collections ?? {})) {
    await ensureTable(storage, { app: config.app, tenant, table });
  }
  const listener = createListener({ app: config.app, storage, verifier });
  const server = createServer(listener);
  await new Promise<void>((res) => server.listen(opts.port, res));
  printBanner({ port: opts.port, dataDir, tenant, target: config.target, json: opts.json });
  return { port: opts.port, dataDir, target: config.target };
};

const runWranglerDev = (...): Promise<...> => {
  // spawn("wrangler", ["dev"], { cwd: resolve(cwd, "apps/server"), stdio: "inherit" })
  // return a promise that resolves on process exit
};

const printBanner = (...) => {
  // pc.bold(pc.cyan("baerly dev"))
  // port, data dir, tenant, verifier mode, target — single block
};

export const dev = defineCommand({
  meta: {
    name: "dev",
    description: "Boot a local Node listener over LocalFsStorage on http://localhost:3000.",
  },
  args: {
    port: { type: "string", description: "Listen port", valueHint: "n" },
    "data-dir": { type: "string", description: "LocalFsStorage root", valueHint: "path" },
    wrangler: {
      type: "boolean",
      description: "Cloudflare target only: spawn `wrangler dev` from apps/server/.",
    },
    json: { type: "boolean", description: "Emit JSON envelope to stdout." },
  },
  run: async ({ args }) => {
    try {
      const port = args.port !== undefined ? Number.parseInt(args.port, 10) : DEFAULT_PORT;
      if (!Number.isFinite(port) || port <= 0) {
        throw new BaerlyError("InvalidConfig", `--port must be a positive integer (got ${args.port})`);
      }
      const dataDir = args["data-dir"] ?? DEFAULT_DATA_DIR;
      const result = await runDev({
        port,
        dataDir,
        wrangler: args.wrangler === true,
        json: args.json === true,
      });
      if (args.json === true) {
        process.stdout.write(JSON.stringify({ result: { command: "dev", status: "ok", ...result } }) + "\n");
      }
    } catch (err) {
      handleCliError(err, "dev", args.json === true);  // existing pattern in other commands
    }
  },
});
```

Notes:
- `loadAppConfig` already throws `BaerlyError` on missing/invalid
  config — let it propagate.
- The verifier secret falls back to a literal `"dev-only-secret"`;
  document that the user can override via `BAERLY_DEV_SECRET` env.
- The listener bind is non-blocking: `server.listen(port)` returns
  the server; we await the `listening` event (or use the callback
  form) so subsequent log lines fire after the port is open. The
  process stays alive because the server's open socket keeps the
  event loop busy — do not call `process.exit(0)`.

### Step 3. Register the command

Edit `packages/cli/src/baerly.ts`. In the `subCommands` object
(currently at line 46), add an entry mapping `"dev"` to a
lazy-loaded import of `dev` from `./dev.ts`. Match the existing
pattern used by `init`, `inspect`, etc. (read those entries
verbatim and copy the shape).

### Step 4. Tests in `packages/cli/src/dev.test.ts`

Cover, in this order:

1. `runDev({ port: 0, dataDir: tmpdir(), wrangler: false, json:
   false })` brings up a listener on an ephemeral port; the
   returned port can be `fetch`'d (`GET /v1/since?app=...` returns
   200 with the right headers, given a `BAERLY_DEV_SECRET` env).
2. `runDev({ ...,  wrangler: true })` with `config.target === "node"`
   throws `BaerlyError("InvalidConfig", ...)`.
3. `runDev({ ..., port: NaN })` rejects (`--port` validation).
4. `config.collections` declared → `ensureTable` is called for
   each before the first request. Use a counting `Storage` proxy
   or assert via a `getMany("baerly:tables/")` listing after boot.
5. JSON-mode regression: `runDev(...)` with `json: true` causes
   the command body to write a JSON envelope to stdout.

Reuse the test fixtures from `packages/cli/src/copy.test.ts` for
the `tmpdir()` pattern, and from `packages/cli/src/init.test.ts`
for the `baerly.config.ts` synthesis.

### Step 5. Sanity-check the wrangler path manually

`runWranglerDev` should `spawn("wrangler", ["dev"], { cwd:
"apps/server", stdio: "inherit" })` and return a promise that
resolves on `close`. Do **not** capture stdout — let wrangler's
TTY output pass through. The CF example already includes
`wrangler` as a devDep (verified at
`examples/minimal-cloudflare/apps/server/package.json:devDependencies`).
Manual: from a scaffolded CF app, `baerly dev --wrangler` should
behave identically to running `wrangler dev` from
`apps/server/`.

## Conventions to follow

- `packages/cli/README.md` exit codes + `--json` envelope shape.
- `import` extensions: relative imports use `.ts` extension; cross-
  package imports use the package name (e.g.
  `"@baerly/adapter-node"`). See CLAUDE.md's "Conventions" section.
- Errors must be `BaerlyError` instances with the right `code`
  discriminant. The handler in `dev.ts:run` translates to exit
  codes per the existing pattern in `copy.ts` / `inspect.ts`.
- Tests use vitest; import from `"vitest"`. No jest, no
  `bun:test`. See `docs/conventions/tests.md`.
- Avoid `as string` widenings on branded types (none should be
  needed here, but flag if you find one).
- No new magic numbers — `DEFAULT_PORT` and `DEFAULT_DATA_DIR`
  are local constants; `BAERLY_DEV_SECRET` is an env-var name, fine
  to inline as a string literal.

## Verification

```sh
# Static
pnpm verify                                  # tsgo + oxlint
pnpm format:check packages/cli/src/dev.ts packages/cli/src/dev.test.ts

# Unit
pnpm -F @baerly/cli test                     # incl. dev.test.ts

# Manual smoke (from a scaffolded app dir)
pnpm exec baerly dev &                       # → :3000
sleep 1
curl -s -H "Authorization: Bearer dev-only-secret" \
     "http://localhost:3000/v1/since?app=$APP_NAME&tenant=default" | head -1
kill %1

# Manual smoke — JSON mode
pnpm exec baerly dev --json --port=4000 &
sleep 1
kill %1   # JSON envelope already printed on boot

# Manual smoke — wrangler delegation (CF scaffold only)
pnpm exec baerly dev --wrangler              # behaves like `wrangler dev`
```

Done when:
- All five `dev.test.ts` cases pass.
- `pnpm verify` clean.
- Manual smoke from each example dir lands a 200 on `/v1/since`.

## Out of scope

- **Watch mode / HMR.** Users get reload via the template's
  `tsx watch` / `wrangler dev`'s own reload. A future ticket can
  add `--watch` to `baerly dev` if demand emerges.
- **Custom verifier wiring.** v1 always uses `sharedSecret` with
  the env-var fallback. CF Access in dev is out of scope.
- **Multi-app / multi-tenant in one `dev` boot.** v1 reads exactly
  one `baerly.config.ts` and one tenant. Future tickets can layer
  multi-tenant routing.
- **`runMaintenanceTick` scheduling.** v1 does not run the
  maintenance loop in dev; the local store is small enough that
  this isn't required.

## Conflict notes

- **Depends on**: none.
- **Blocks**: ticket 03 (`examples/.../scripts.dev` switches to
  `baerly dev` only after this lands).
- **No file overlap** with tickets 02 (clack wizard — different
  package), 04 (pnpm pack + docs — touches root README and
  `package.json` `version`/`prepack` fields, no `src/` overlap),
  or 00 (ADR — docs only).

## Pointers

- `packages/cli/src/baerly.ts:46` — subCommands registration.
- `packages/cli/src/config.ts:30,72` — `AppConfig` interface and
  `loadAppConfig` loader.
- `packages/cli/src/copy.ts` — template for command body shape +
  try/catch error handling.
- `packages/cli/src/init.test.ts` — template for config-fixture
  test setup.
- `packages/adapter-node/src/index.ts:37-41` — `LocalFsStorage`,
  `createListener` exports.
- `packages/server/src/index.ts:119-120` — `sharedSecret` /
  `cloudflareAccess` re-exports.
- `packages/dev/src/ensure-table.ts:29` — `ensureTable` signature.
- `packages/protocol/src/errors.ts` — `BaerlyError` + codes.
- `packages/cli/README.md` — exit-code contract + `--json` envelope.
- `CLAUDE.md` — toolchain (`pnpm verify`, `pnpm test`), import
  extension convention.
- `docs/conventions/tests.md` — vitest patterns.
