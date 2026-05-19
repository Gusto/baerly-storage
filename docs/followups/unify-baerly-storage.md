# Followups: unify-baerly-storage

Carried over from the 2026-05-18 unify-baerly-storage merge (10
commits, `ad094cc..c711d53`). Each entry is a pre-existing
concern surfaced during review or an intentionally-deferred scope
the plan called out. None blocked the merge.

---

## 1. CF subpath closure pulls `S3HttpStorage`

**Severity: MEDIUM. Contradicts the optional-peer design.**

`dist/cloudflare.js` re-exports `S3HttpStorage`, which means the
closure pulls `aws4fetch` and `@xmldom/xmldom` even for consumers
who only use the R2 binding. Today, `import { r2BindingStorage }
from "baerly-storage/cloudflare"` fails to load without those
peers installed, despite the design intent that CF-only consumers
shouldn't carry Node deps.

Two paths to fix:

- **Split the S3 path off the CF aggregator.** Move
  `S3HttpStorage` out of `packages/adapter-cloudflare/src/index.ts`
  re-exports; consumers who need S3 from Workers can import it
  from `baerly-storage/node` (or a new dedicated subpath).
- **Make the peers required.** Update
  `peerDependenciesMeta.optional` so `aws4fetch` and
  `@xmldom/xmldom` aren't optional for `baerly-storage/cloudflare`
  consumers. Less elegant but reflects current reality.

The first option is the better DX. Verify by re-running the
T9-style smoke install with only `@cloudflare/workers-types` as
the installed peer — `import("baerly-storage/cloudflare")` must
load.

## 2. `DOMParser()` not `@__PURE__`-annotated

**Severity: LOW. Load-time side effect.**

`packages/adapter-node/src/storage-factories.ts:6` instantiates a
shared `DOMParser` at module scope. The instance is stateless and
the comment in source says one shared parser is safe — but the
node/CF/baerly bundles all carry the unannotated `new DOMParser()`
at module top, so tree-shakers can't drop the xmldom subgraph
from consumers who only use `baerlyNode` with a non-S3 storage.

Fix: wrap the instantiation in `/* @__PURE__ */` or move it into
the factory closure where it'll only run when an S3-style storage
is actually constructed.

## 3. `@baerly/dev` barrel re-exports `baerlyDev`

**Severity: LOW. Static-closure bloat for non-vite consumers.**

`packages/dev/src/index.ts:6` re-exports `baerlyDev` from
`./vite-plugin.ts`. That pulls the full vite-plugin closure into
`dist/dev.js` even for consumers who only want `LocalFsStorage`,
`printDevBanner`, or `ensureTable`.

Fix: drop `baerlyDev` from the `dev` barrel. The
`baerly-storage/dev/vite` subpath already exists for vite users.

## 4. Shebang bleeds into CLI chunk files

**Severity: LOW. Cosmetic.**

`packages/cli/rolldown.config.ts` uses an unconditional `banner`,
so both `dist/baerly.js` (the bin entry) and `dist/logger-pretty-*.js`
(a chunk file) start with `#!/usr/bin/env node`. Node treats the
shebang as a comment in imported modules, so there's no runtime
break, but it's a mildly surprising artifact in the published
tarball.

Fix: change banner to `(chunk) => chunk.isEntry ? "#!/usr/bin/env
node" : ""`.

## 5. `MetricsRecorder` interface has no public re-export

**Severity: LOW. DX gap for advanced consumers.**

`@baerly/protocol` declares the `MetricsRecorder` interface used
by `InMemoryMetricsRecorder` and `RequestScopedMetricsRecorder`
(both of which ARE publicly re-exported, the former from
`baerly-storage` and the latter from
`baerly-storage/observability`). Consumers who want to implement
a custom recorder (e.g., emit OTLP) need the interface type but
have nowhere to import it from the published surface — they'd
have to fall back to `@baerly/protocol`, which isn't published.

Fix: add `export type { MetricsRecorder } from "@baerly/protocol"`
to `packages/server/src/observability/index.ts` (or wherever the
existing recorder exports live). One-line change, mirrors the
T8 `JSONArraylessObject` move.

## 6. `pnpm pack` fails in worktrees

**Severity: LOW. Repo infra footgun.**

`pnpm pack` runs the `prepare` lifecycle script (`lefthook install
&& pnpm run build`), and `lefthook install` errors with `Error:
core.hooksPath is set locally to '<main-repo>/.git/hooks'` inside
git-worktree dirs because pnpm sets `core.hooksPath` locally.
T9's verification used `npm pack --ignore-scripts` as a workaround.

Pre-publish from a clean checkout works fine; this only affects
maintainer workflow inside worktrees. Options:

- Document `npm pack --ignore-scripts` as the worktree-friendly
  path in `docs/contributing/development.md`.
- Or move the `prepare`-time build invocation elsewhere (e.g.,
  `prepublishOnly` instead of `prepare`) so `pnpm pack` doesn't
  trip it.

## 7. `manual-e2e/` + `bench/` still import from `@baerly/*`

**Severity: LOW. Intentional plan deferral.**

The plan's §"Out of scope (deferred to follow-ups)" called out
that `manual-e2e/` and `bench/` would not be rewritten on this
branch. Both still import from internal `@baerly/server`,
`@baerly/adapter-*`, etc. These are maintainer-only directories
(run against deployed URLs or local Minio), not part of the
published surface — but for symmetry with the rest of the repo
they should land on `baerly-storage/*` eventually.

Affected files (non-exhaustive):
- `manual-e2e/cloudflare/worker-entry.ts:1`
- `manual-e2e/node/server-entry.ts:1`
- `bench/load-harness/*.ts`
- `bench/compactor-loop.ts`

Apply the same rename map T6 used; no new architecture decisions.
