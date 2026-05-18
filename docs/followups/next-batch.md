### 1. Node `baerly dev` boots the API but not the SPA in dev

**STATUS: deferred — design question, narrower scope after flatten.**
**Effort:** M (vite child-process + banner URL threading).

`baerly dev` (`packages/cli/src/dev.ts`) only boots the Node API
listener over `LocalFsStorage`. After the scaffold flatten the SPA
lives at `src/web/` in the same package, but `pnpm dev` still
launches only the API on `:3000`; a user has to `pnpm build` once
and then revisit, or spawn `vite` themselves. Cloudflare scaffolds
solved this via `@cloudflare/vite-plugin` (item 10); Node has no
equivalent because the Node listener isn't a Vite environment.

Options:
- Have `baerly dev --web` (Node target only) spawn `vite` from the
  scaffold root and thread its URL into
  `printDevBanner({ primaryUrl: ... })`.
- Or document the two-process flow in each Node example's README
  and ship a `dev:web` script.

### 2. `helpdesk-cloudflare` could adopt the banner / log helpers

**STATUS: deferred; revisit next time the example is touched.**
**Effort:** S–M (~0.5d, depends on wrapper shape).

`examples/helpdesk-cloudflare/` runs under wrangler, not a Node
`http.Server`. `printDevBanner` (or a thin wrapper that takes the
wrangler URL plus the vite URL) would improve first-touch UX.
Related to item 10 — same workspace, related fix.

### 3. `.oxlintrc.json` lint posture is "make it pass," not "lock it in"

**STATUS: deferred; pre-1.0 hardening.**
**Effort:** M (audit each disabled rule + fix the violations it surfaces).

Two concerns:

1. Only `correctness`, `suspicious`, `perf` are denied at the
   `categories` level. `style` (and to some extent `pedantic`) is
   left at default — for a pre-publish library aiming at strictest
   posture, `style: "deny"` (or `"warn"`) would catch a layer of
   consistency issues currently invisible. `restriction` /
   `nursery` are correctly opt-in; leave those alone.
2. The `**/*.test.ts` override turns off six vitest rules:
   `no-standalone-expect`, `require-mock-type-parameters`,
   `require-to-throw-message`, `no-conditional-expect`,
   `expect-expect`, `valid-title`. At minimum `expect-expect` and
   `valid-title` are very cheap wins — disabling them looks like a
   "shut it up to land a PR" move rather than a deliberate posture
   choice. Walk each one, decide if it really conflicts with the
   property-test cascade style, and re-enable the rest.

The top-level `eslint/no-await-in-loop: "off"` is plausibly
correct (the writer loops are sequential by design), but worth a
sanity check + a code comment if it stays off.

### 4. Root `tsconfig.json` is missing strictest-tier flags

**STATUS: deferred; pre-1.0 hardening.**
**Effort:** M (each flag will surface latent unsoundness — budget
half a day per flag for the cleanup pass).

Already on: `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`,
`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
`isolatedModules`, `erasableSyntaxOnly`. Not on:

- `exactOptionalPropertyTypes` — separates `{ x?: T }` from
  `{ x?: T | undefined }`. Pre-1.0 is the right time to commit to
  one or the other across the public API.
- `noImplicitReturns` — catches `if/else` branches that fall off
  the end of a non-`void` function. Distinct from
  `noFallthroughCasesInSwitch`.
- `noPropertyAccessFromIndexSignature` — forces `m["k"]` for
  index-signature lookups, leaving `m.k` for declared keys. Good
  hygiene for protocol code that loads keys off `Record<string, …>`
  blobs.

Land them one at a time; each will surface real issues.

### 5. Root `package.json` is missing npm-registry publication fields

**STATUS: deferred; required before `npm publish`.**
**Effort:** S (~30 min, mostly deciding the canonical URLs).

Has: `name`, `version`, `description`, `keywords`, `license`,
`files`, `type`, `sideEffects`, `exports`, `publishConfig`,
`engines`, `packageManager`. Missing for a polished registry
listing: `repository`, `bugs`, `homepage`, `author`. Add before
publishing 1.0 — the npm UI surfaces all four. Also consider
`engines.pnpm` for symmetry with `engines.node`, and a top-level
`.npmrc` with `engine-strict=true` so contributors can't silently
install on Node 22.

### 6. Example tsconfigs silently bypass root strictness

**STATUS: deferred; pre-1.0 hardening.**
**Effort:** M (likely surfaces real type holes in the example
source).

All eight per-target tsconfigs under
`examples/{minimal,helpdesk}-{cloudflare,node-docker,node-railway}/tsconfig.{app,worker,server}.json`
declare `target`, `lib`, `module`, `moduleResolution`,
`allowImportingTsExtensions`, `strict`, `esModuleInterop`,
`skipLibCheck`, but they do **not** `extends:
"../../tsconfig.json"`. As a result they drop
`noUncheckedIndexedAccess`, `noUnusedLocals`,
`noUnusedParameters`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `verbatimModuleSyntax`,
`isolatedModules`, `erasableSyntaxOnly`. Scaffolded users inherit
the weakened config.

Two paths:

- Add `"extends": "../../tsconfig.json"` to each example
  tsconfig — works in-monorepo, but the scaffolder copies these
  files into a flat output tree where `../../tsconfig.json` won't
  exist. Either the scaffolder rewrites `extends` at scaffold
  time, or
- Inline the same strict flags in each example tsconfig (heavier
  but self-contained). This is what scaffolded users actually see,
  so it's probably the right answer.

### 7. Example tsconfigs target `ES2023`; root targets `ES2025`

**STATUS: deferred; pre-1.0 hardening.**
**Effort:** S (bump + verify each example still typechecks).

Examples target `ES2023` with `lib: ["ES2023", "DOM", "DOM.Iterable"]`.
Root targets `ES2025` + `ESNext.TypedArrays`. Node 24 and current
`workerd` both support `Array.prototype.toSorted`,
`Promise.withResolvers`, `Object.groupBy`, base-64 typed arrays.
Bump examples to match the root, including the `ESNext.TypedArrays`
lib (memory item: that shim is load-bearing — coordinate the bump
with deleting the per-example `uint8array-base64.d.ts` shim once
the lib lists it natively).

### 8. Wrangler `compatibility_date` is stale

**STATUS: deferred; quick hygiene before next CF deploy.**
**Effort:** XS (~5 min).

Both `examples/{minimal,helpdesk}-cloudflare/wrangler.jsonc` pin
`compatibility_date: "2025-06-01"`. Today is 2026-05-18 — almost
a year of `workerd` semantic improvements left on the floor. Bump
to a recent date (e.g. `"2026-05-01"`) and verify the worker test
suite still passes under the new flag set. Also worth touching
the `tests/setup/r2-binding.ts` miniflare config
(`compatibilityDate: "2025-01-01"` per `vitest.config.ts`) at the
same time.

### 9. `examples/minimal-node-docker/Dockerfile` has avoidable rough edges

**STATUS: deferred; pre-1.0 polish.**
**Effort:** S (~1h).

Three concrete issues:

- **pnpm version drift.** Line 14 hard-codes
  `corepack prepare pnpm@10.31.0 --activate`, but every template
  declares `"packageManager": "pnpm@11.1.2"`. The two will diverge
  again. Replace with `corepack enable && corepack install` and
  let `packageManager` drive — or read the literal out of
  `package.json`. (Memory item: pnpm 11 fixed the `allowBuilds`
  rename, so 11.1.2 is intentional, not accidental.)
- **No digest pinning.** `node:24-bookworm-slim` and
  `gcr.io/distroless/nodejs24-debian12` should pin
  `@sha256:...` for reproducibility of scaffolded user builds. At
  minimum a comment telling users to pin once they vendor.
- **`.dockerignore` excludes `dist/server`, not `dist/`.** Any host
  `dist/client` build from a prior run leaks into the build
  context. Replace the entry with `dist`.

Also: `pnpm install --prod --frozen-lockfile` (line 26) re-runs
the lockfile resolution in the same stage as the dev install.
Cheaper to `pnpm prune --prod`, or run the prod install into a
separate dir copied into the runtime stage.

### 10. Tooling-version drift across examples + helpdesk

**STATUS: deferred; pre-1.0 hardening.**
**Effort:** S (pick one version per tool, update each manifest).

A pre-publish sweep should unify:

- `typescript`: `examples/helpdesk/package.json` pins `5.7.2`;
  the four templates pin `^5.8.0`. Pick one.
- `vite`: helpdesk uses `^8.0.11`, the four templates use
  `^6.0.0`. Pick one (likely `^8`, matching the root devDep).
- `@vitejs/plugin-react`: helpdesk `^6.0.0`, cloudflare templates
  `^5.0.0`. Couple to the chosen vite major.
- `@types/node`: node templates pin `^25.0.0`, Dockerfile runtime
  is `node:24-bookworm-slim`. Match the runtime — pin `^24.x`.

### 11. Scaffold manifests don't drop `create-baerly` / `@baerly/cli`

**STATUS: confirmed bug — scaffolded users inherit broken refs.**
**Effort:** S (~30 min — append the right entries to each
`scaffold.json`'s `dropDevDeps`, regenerate the test scaffolds).

All four `examples/*/.baerly/scaffold.json` files have
`"dropDevDeps": []`. Each template lists
`"create-baerly": "workspace:*"` and `"@baerly/cli": "workspace:*"`
under `devDependencies`. Once scaffolded into a user repo outside
the monorepo, those `workspace:*` refs will fail to resolve.

`create-baerly` is genuinely not needed in a scaffolded
project — drop it. `@baerly/cli` *is* useful (scaffolded users
run `baerly dev` / `baerly deploy`), so either keep it but rewrite
the version to the published semver at scaffold time, or replace
with the public binary name (`baerly`) once that's settled.

### 12. Templates declare `pnpm test` but ship no vitest dependency

**STATUS: deferred; pre-1.0 hardening.**
**Effort:** XS (drop the script, or add a vitest devDep + a
one-line config).

Each of `examples/minimal-{cloudflare,node-docker,node-railway}/package.json`
and `examples/helpdesk-cloudflare/package.json` has
`"test": "vitest run"` but no `vitest` in devDependencies. Running
`pnpm test` in a freshly scaffolded project will fail with
"command not found." Either drop the script (templates currently
ship no `*.test.ts` source) or commit to shipping a minimal
example test.

### 13. `.oxfmtrc.json` is effectively empty

**STATUS: deferred; minor.**
**Effort:** XS.

```json
{ "$schema": "...", "ignorePatterns": [] }
```

No `printWidth`, `tabWidth`, `useTabs`, `semi`, `singleQuote`,
`trailingComma`, etc. Likely fine if the defaults match the
repo's actual style, but an explicit config is more
self-documenting for a 1.0 project — and prevents an oxfmt
default change from silently reformatting the tree on upgrade.

### 14. `lefthook.yml` typecheck always runs the full project

**STATUS: deferred; minor DX.**
**Effort:** XS.

The `typecheck` step has no `glob:`, so it runs `pnpm typecheck`
on every commit even when no `.ts` file is staged (e.g. a
docs-only commit). `tsgo` is fast, so the cost is bearable, but
gating on `glob: "*.{ts,tsx}"` saves a couple of seconds on the
common case. Also worth adding `skip: [merge, rebase]` at the
top of `pre-commit:` so the hook doesn't run during a `git
rebase --continue` after conflict resolution.
