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

---

## Simplification audit — 2026-05-18

A ruthless pre-launch audit across every package and folder, run
by nine parallel subagents on 2026-05-18. Goal: cut accretion,
dead code, and DX-hostile complexity before publish. The user
explicitly cares more about user DX + agent DX than contributor
experience, and there's no backwards-compat burden.

Findings grouped by area, each entry tagged **HIGH / MEDIUM /
LOW** for DX impact. HIGH = directly harms a user or an LLM
agent consuming the library zero-shot; MEDIUM = bloats the
kernel or invites drift; LOW = micro-cleanup. Triage by reading
HIGH entries first.

Items 1–14 above are the prior pre-1.0 hardening batch — separate
workstream, not duplicated here.

### A. Public surface — what users + agents see

#### A1. Package-name schism: published `baerly-storage` vs. `@baerly/*` workspace imports — **HIGH**

The only public package is the root `baerly-storage` (bundled
from `@baerly/server`). Every workspace package
(`@baerly/server`, `@baerly/client`, `@baerly/adapter-node`,
`@baerly/adapter-cloudflare`, `@baerly/dev`, `@baerly/protocol`,
`@baerly/cli`, `create-baerly`) is `private: true`. Yet
**every** README, AGENTS.md, JSDoc `@example`, and scaffolded
template imports from `@baerly/server`, `@baerly/adapter-node`,
`@baerly/dev`, `@baerly/client`, `@baerly/protocol`. A fresh
`npm install baerly-storage` resolves none of them.

**Fix:** Pick a side. Either (a) publish the `@baerly/*` scope
properly and either retire the root `baerly-storage` bundle or
make it a thin meta-package, **or** (b) rename all consumed
workspace names to `baerly-storage`/`baerly-storage/auth`/
`baerly-storage-adapter-node`/etc. and rewrite every example.
Option (a) is the cleaner path. Until this lands, `npm create
baerly@latest` produces apps that don't compile.

#### A2. `llms.txt` describes the wrong architecture — **HIGH**

Current content: "runs entirely client-side over any
S3-compatible storage. No server. The client polls a
time-ordered manifest log to sync state across writers."
Reality: `Db` runs server-side behind a Verifier; clients hit
HTTP via `@baerly/client`. An agent reading `llms.txt` first
will produce confidently broken code.

**Fix:** Rewrite to match reality. Better: replace the doc-
pointer section with a minimal zero-shot snippet that mirrors
what `create-baerly` actually scaffolds.

#### A3. README "Quick start" can't be followed — **HIGH**

(a) The "Quick start" block admits `pnpm dlx create-baerly@latest`
"doesn't resolve end-to-end" and tells users to clone and run
inside the workspace. That's not a quick start — that's "don't
use this yet."  (b) The "Or wire it by hand" snippet imports
`createListener` from `@baerly/adapter-node`, `sharedSecret`
from `@baerly/server/auth`, `LocalFsStorage` + `ensureTable`
from `@baerly/dev` — three packages that won't resolve from a
published `baerly-storage`. (c) README claims support for
"Backblaze" but no Backblaze factory or conformance test exists
in the repo (GCS exists but is missing from the claim).

**Fix:** Either land the publishes before the README ships, or
mark the README as preview and replace the snippets with the
one path that *works today*. Drop the Backblaze claim or add a
factory + conformance run.

#### A4. The top-level `baerly-storage` barrel re-exports ~50 internal symbols — **HIGH**

`packages/server/src/index.ts` currently exports the entire
compactor (`compact`, `encodeSnapshotBody`, `loadSnapshotAsMap`,
`snapshotKey`, `SEQ_DIGITS`, `SNAPSHOT_LEVEL`), GC (`runGc`),
HTTP internals (`MAX_BODY_BYTES`, `mapError`, `createRouter`,
`listEventsSince`, `longPollSince`), every index helper
(`allIndexKeysFor`, `encodeIndexValue`, `indexKeyFor`,
`indexKeyPrefix`, `projectIndexValues`, `validateIndexDefinition`),
`rebuildIndex`, `migrateCollection`, `ServerWriter`, log walkers,
`claimWriter`, plus `makeQuery`/`runAllWithMeta`/`runInsert`/
`serializeManifestPointer`/`tableReadContext`/`TxContext`/
`BufferedMutation`/`CurrentJsonCacheSlot`/`QueryState`/
`ReadResult`/`TableReadContext` — 13 of those still carry an
`@internal` JSDoc tag but ship anyway.

**Fix:** Reduce the top-level barrel to ~10 symbols: `Db`,
`defineConfig`, `BaerlyConfig`, `CollectionDefinition`,
`BaerlyError`, `BaerlyErrorCode`, `Table`, `Query`, `Verifier`,
`Storage`, `MemoryStorage`, `SchemaValidator`, `SchemaIssue`.
Move admin verbs (`compact`, `runGc`, `rebuildIndex`,
`migrateCollection`, `claimWriter`) behind `baerly-storage/admin`.
Drop the `@internal` re-exports — `http/router.ts` and `http/since.ts`
can import them directly within-package.

#### A5. `Db._raw` is the first JSDoc `@example` on the class — **HIGH**

`packages/server/src/db.ts:118-148`: the class-level `@example`
shows `db._raw.put(...)` / `db._raw.get(...)`. `_raw` is then
documented `@internal` ("Bypasses every higher-level invariant:
no LogEntry emit, no CAS on current.json, no schema check"). An
LLM reading the class docstring will produce code that bypasses
the entire database.

**Fix:** Replace the class `@example` with the canonical first-
touch pattern (`Db.create` → `db.table("x").insert(...)` →
`db.table("x").where({...}).all()`). Make `_raw` a private
field (`#raw`) or expose only via an explicit
`db.unsafeRawStorage()` accessor.

#### A6. `@baerly/protocol` says "Not a public API" but every example imports from it — **HIGH**

Package description: "Internal protocol kernel — implementation
detail of @baerly/server. Not a public API." Every template
imports `Verifier`, `Storage`, `JSONArraylessObject` directly
from `@baerly/protocol`.

**Fix:** Decide. Either rewrite the description (it *is* a
public types entry), or hide protocol and re-export
`Verifier`/`Storage`/`BaerlyDocument` (see A8) from the main
`baerly-storage` barrel. Combined with A1, the second option is
the cleaner path.

#### A7. `claimWriter`, `singleTenantDevVerifier`, `awsIamSigV4`, `allowlistIp`, `andAll` all carry "Do NOT call" warnings yet ship publicly — **MEDIUM**

A function exported with a "reserved for admin / dev-only / not
for production" JSDoc is going to get called. `awsIamSigV4`
(356 LOC) and `allowlistIp`/`andAll` (248 LOC) have zero
callers across `packages/`, `tests/`, `examples/`,
`manual-e2e/`, `bench/`, `eval/`. Speculative SigV4 + IPv6 CIDR
parser pre-launch is exactly the kind of accretion to cut.

**Fix:** Delete `awsIamSigV4`, `allowlistIp`, `andAll`
entirely. Move `claimWriter` to `baerly-storage/admin`
(or delete — only `packages/cli` and `tests/setup` use it).
Move `singleTenantDevVerifier` to `@baerly/adapter-cloudflare/dev`
or fold into `@baerly/server/auth` as `staticTenantVerifier`.

#### A8. `JSONArraylessObject` leaks JSON-merge-patch jargon into every typed insert — **MEDIUM**

Every `Table<T extends JSONArraylessObject>` forces users to
internalise a research-y constraint label that exists only
because JSON-merge-patch can't deep-merge top-level arrays. The
type is not re-exported from `@baerly/server`'s public barrel —
users have to grab it from `@baerly/protocol` separately.

**Fix:** Rename → `BaerlyDocument` (or just `Document`), re-
export from the public barrel with a one-line JSDoc: "plain
JSON object; nested objects ok; arrays only inside nested
objects."

#### A9. `Db.create` requires users to pre-flatten `BaerlyConfig.collections` — **MEDIUM**

`defineConfig` returns `{ collections: { name: { schema,
indexes } } }`. `Db.create` won't accept that shape — it
demands `schemas: Map<string, SchemaValidator>` and `indexes:
Map<string, IndexDefinition[]>` already flattened. The adapter
code does this; app code that constructs `Db` directly has to
repeat the boilerplate. The JSDoc literally says "the adapter
layer (or app code) flattens" — the library is making the user
pay tax to keep `Db` "library-agnostic" for a use case nobody has.

**Fix:** `Db.create` accepts `BaerlyConfig["collections"]`
directly and flattens internally. One shape, one path.

#### A10. JSDoc on `Table.where` says "no `$gt`/`$in`/`$or`" — but the validator + evaluator ship all of those — **HIGH**

`packages/protocol/src/db.ts:18-21`: "Day-one operator policy:
equality + dotted-path only — no `$or` / `$gt` / `$in` /
`$regex`." Reality: `PredicateOp` in `query/predicate.ts:55-62`
exports `$eq | $gt | $gte | $lt | $lte | $in` and the validator,
evaluator, and merger all handle them. An LLM reading the
`.d.ts` will believe range ops are unsupported and refuse to
emit them.

**Fix:** Update `Table.where` JSDoc to enumerate the supported
operators; add an `@example` showing `{ count: { $gte: 1 } }`
and `{ status: { $in: ["open", "pending"] } }`.

#### A11. JSDoc ticket-references leak internal planning into the IDE hover — **MEDIUM**

Multiple JSDoc strings cite "ticket 38", "ticket 10 §7", "ticket
11/16/26/70", "Phase 5/8", `.claude/research/planning/tickets/…`.
Users see these in IDE hover; they belong in commit messages.

**Fix:** `grep -rn "ticket [0-9]\|Phase [0-9]\|\\.claude/research"
packages/` and strip from JSDoc. Found in `config.ts:3`,
`table.ts:11-12`, `db.ts:482-486`, `query.ts:29-31`,
`server-writer.ts:33-34`, `maintenance.ts:15`, and many more.

#### A12. Seven stale JSDoc references to a `Syncer` class that doesn't exist — **HIGH**

`packages/protocol/src/constants.ts:5,26,50,94,231`,
`log.ts:27,144`, `server-writer.ts:27`, `since.ts:46` all
describe constants/helpers in terms of `Syncer.isValid`,
`Syncer.getLatest`, `Syncer.classifyMissingContent`,
`Syncer.generate_manifest_key()`, `Syncer.updateContent`. No
`Syncer` class exists. Largest doc-rot vector in the kernel.

**Fix:** Rewrite each block against the actual call site
(`ServerWriter`, `walkLogRange`). Where the underlying invariant
is gone (e.g. `MANIFEST_LIST_LOOKAHEAD_MILLIS`), delete the
constant too.

#### A13. `BaerlyErrorCode.OfflineNoCache` has no producer — **MEDIUM**

`packages/protocol/src/errors.ts:9-10` documents
`OfflineNoCache` as "Read attempted while `online: false`" but
no `online` flag exists anywhere. The dispatcher's `default →
500` arm lists it but never receives it.

**Fix:** Delete `OfflineNoCache`. Audit `Internal` (overused as
"shouldn't happen" where `InvalidResponse` would be more
truthful) and document each remaining code's current producer
site in `errors.ts`.

#### A14. `BaerlyClientError` duplicates `BaerlyError` for no win — **MEDIUM**

`packages/client/src/errors.ts` defines `BaerlyClientError`
that's identical to `BaerlyError` + a `status: number` field.
Comment claims "a future `@baerly/react-query` wrapper" — pure
speculation. Downside is real: callers can't write one
`instanceof` check across server-side and client-side error
handling. Zero call sites do `instanceof BaerlyClientError`.

**Fix:** Reuse `BaerlyError` everywhere; put `status` on
`cause` or a context bag. One error class, one `code`
discriminant.

#### A15. Each scaffolded template ships a 100+ line `AGENTS.md` that diverges from the others and from root README — **MEDIUM**

Four templates × ~120-line AGENTS.md → ~480 lines duplicated
with drift. Examples already disagree (only one mentions
`CLAUDE.md` mirror, only one documents Docker cron rationale).
Every predicate/schema change will require four updates.

**Fix:** Either (a) template + slot rendering at scaffold time
(canonical AGENTS.md in `packages/create-baerly/src/templates/agents/`
with `{{target}}` tokens), or (b) reduce per-template AGENTS.md
to a 5-line stub pointing at root `CLAUDE.md`. Single source of
truth.

### B. Server kernel (db, table, query, writer, indexes, schema, migrate)

#### B1. Production write path never emits index entries — entire writer index-emission block is dead — **HIGH**

`Db.create({ indexes })` threads index defs into the read-side
`TableReadContext.indexes`, but `query.ts:writerFor()` and
`Db.transaction`'s `ServerWriter` constructor never pass
`indexes` through `ServerWriterOptions`. Production paths
therefore never emit, diff, or delete index keys. The
`server-writer.ts:286-737` block (pre-image walks,
`inBatchImage`, `allIndexKeysFor`, `#readPreImage` at 764-800)
only runs from tests. The codebase ships *index reads* against
entries that *no production write produces*.

**Fix:** Thread `ctx.indexes` into `writerFor` and the
transaction-path writer — OR delete the writer-side index
machinery if indexes are intended to be read-only/rebuild-only.
Either way, the latent correctness gap must close.

#### B2. `query.ts:runFirstWithMeta` is a redundant alias of `runAllWithMeta` — **MEDIUM**

`runFirstWithMeta` calls `runRead` with `limit:1` and picks
`rows[0]`. The router (sole production caller) could pass
`{...state, limit:1}` to `runAllWithMeta` and pick `rows[0]`.
Both shims re-run `validatePredicate` even though `makeQuery`
already validated.

**Fix:** Delete `runFirstWithMeta`; have the router call
`runAllWithMeta` with limit 1.

#### B3. Predicate validated 3× per call — **LOW**

`makeQuery` validates on entry; `.where()` validates `p` before
merge, then calls `makeQuery` which validates again;
`runFirstWithMeta`/`runAllWithMeta` validate yet again even
though they're invoked only from the router with already-
validated chains.

**Fix:** Validate exactly once at predicate construction
(`.where()` and the router's predicate-parser). Drop the
re-validations.

#### B4. `Db.transaction` re-implements `tableReadContext` (30-line copy) — **MEDIUM**

`db.ts:466-505` mirrors `db.ts:397-422` near-verbatim:
`currentJsonCache` lookup-or-allocate, `#schemas.get`,
`#indexes.get ?? EMPTY_INDEX_ARRAY`, `tablePrefix` build,
optional spreads.

**Fix:** Have `Db.transaction` call `this.tableReadContext(table)`
then build `makeTable({ ...ctx, txCtx })`. Deletes ~30 lines.

#### B5. Defensive `...(x !== undefined ? { x } : {})` spreads everywhere — **LOW**

`tsconfig.json` does not enable `exactOptionalPropertyTypes`,
so an optional field assigned `undefined` is identical to
omitting it. These ceremonial spreads exist across `db.ts`,
`query.ts`, `server-writer.ts`, `contract.ts`, `query-planner.ts`
and add visual noise.

**Fix:** Direct assignment everywhere (`{ ..., schema,
inFanoutThreshold }`). If `exactOptionalPropertyTypes` lands
later (see existing item #4), it'll surface real holes — but
the current spreading is theatre.

#### B6. `EMPTY_SCHEMA_MAP` / `EMPTY_INDEX_MAP` / `EMPTY_INDEX_ARRAY` sentinels are theatre — **LOW**

`db.ts:80-92` defines three top-level sentinels with comments
saying they're "frozen so accidental `.set(...)` throws." They
aren't frozen. They're typed `ReadonlyMap`. And no internal
caller mutates them.

**Fix:** Inline `?? new Map()` / `?? []` at call sites. Drop
the three constants.

#### B7. `Object.freeze({ ...state })` in `makeQuery` — **LOW**

`query.ts:258` freezes a fresh-spread object. Every modifier
already passes a fresh spread; the freeze catches nothing real.
Shallow freeze doesn't even protect nested predicate/order
objects.

**Fix:** Drop the freeze.

#### B8. Log-fold loop duplicated four times — **MEDIUM**

`query.ts:743-762` (full-scan), `query.ts:978-998` (index-walk),
`migrate.ts:163-178`, `rebuild-index.ts:193-218` all contain
the same "fold log entries onto `Map<docId, body>` switching on
`I/U/D`, ignoring T/M" loop. Three include manual
`JSON.parse(new TextDecoder().decode(...))`. `rebuild-index.ts`
re-implements its own sequential GET loop instead of using
`walkLogRange`.

**Fix:** Extract `foldLogEntriesOnto(map, entries, collection)`
to `log-walk.ts`. Switch `rebuild-index.ts` to `walkLogRange`.

#### B9. `runIndexWalkPlan` reloads snapshot + log even though `runRead` did it — **MEDIUM**

`runRead` reads `current.json` + snapshot + log; then
`runIndexWalkPlan` re-loads `head.snapshot` and re-walks
`[log_seq_start, next_seq)` from scratch to resolve docIds.
Two loads + two walks per index-walk read = wasted work.

**Fix:** Restructure: load snapshot + log walk once at the top
of `runRead`, then branch on `plan.kind`. Halves read latency
on index-walks.

#### B10. `IndexWalkPlan.postFilter` is computed but never read by the executor — **LOW**

Planner builds `postFilter` (residue of unconsumed predicate
keys). Executor at `query.ts:1010` re-applies the *full*
original predicate ("the simpler invariant" per JSDoc). So
`postFilter` is built and attached and the executor ignores it.

**Fix:** Drop `postFilter` from `IndexWalkPlan`; drop the
residue-build + `consumed`/`consumedSet` bookkeeping in the
planner (see also B11).

#### B11. `Candidate.consumed`/`consumedSet` exist only to feed dead `postFilter` — **LOW**

Each candidate tracks the list of consumed predicate keys
solely so the winner can drop them when building `postFilter`.
Per B10, `postFilter` is unused.

**Fix:** Subsumed by B10.

#### B12. `FullScanPlan.reason` diagnostic with no consumer — **LOW**

`{ reason: "no-predicate" | "no-indexes-declared" |
"no-matching-index" | "predicate-uses-operators-only" }`
populated at four planner branches. JSDoc says "diagnostic —
not part of the public API." Only planner unit tests inspect
it.

**Fix:** Return `{ kind: "full-scan" }` literal; replace
planner-test path coverage with a path-counter helper.

#### B13. `tryExtractEq` / `tryExtractRange` / `tryExtractIn` triplicate op-key dispatch — **LOW**

Three helpers each call `Object.keys(op)`. The partition loop
then calls all three in sequence falling through on `undefined`.
One pass over `Object.entries(op)` could populate all three maps.

**Fix:** Single dispatch on op-key. Halves per-predicate-key cost.

#### B14. `SingleAttemptOutcome` discriminated union splits one logical operation across 350 lines — **MEDIUM**

`commit` and `commitBatch` both wrap a 250-line
`#singleAttemptCommit` private method via a tagged union
(`success | log-peer-race | cas-conflict`). The split exists to
share the body between two callers that differ only in (a)
retry budget (8 vs 1) and (b) error-message text on failure
modes. `adoptOwnSessionOnLogConflict` is the only behavioural
fork.

**Fix:** Collapse to one body parameterised by `maxAttempts: 1
| 8` and the adoption flag. Drop the `SingleAttemptOutcome`
union; throw `Conflict` directly and let the loop catch.

#### B15. `isPreconditionFailed` and `isCasConflict` are the same function — **LOW**

`server-writer.ts:919-927`: `const isCasConflict = (err) =>
isPreconditionFailed(err)`. Comment: "kept as a separate
predicate for call-site clarity." It's still a same-named
no-op alias.

**Fix:** Delete `isCasConflict`.

#### B16. `validateInput` checks impossible op/body combinations — **LOW**

`server-writer.ts:902-912` checks `op === "D" && body !==
undefined` and the inverse. `CommitInput` is typed; every
production caller (`query.ts`, `db.ts`) builds the right shape
from typed verbs. Writer inputs are internal — these aren't
system boundaries.

**Fix:** Delete `validateInput`.

#### B17. `CommitResult.entry` / `CommitBatchResult.entries` carry full `LogEntry` shape no caller reads — **LOW**

`writerFor(ctx).commit(...)` and `commitBatch(...)` return rich
results that every production caller (`query.ts:433,506,570,611`,
`db.ts:535`) discards. Only tests read them.

**Fix:** Return `void`. Tests can recompute or read state
directly.

#### B18. `ServerWriter.options.tenant` is test-only — **LOW**

Sole purpose: label histogram emissions. Every production caller
omits it. `if (this.#tenant !== "")` always takes the false
branch in production.

**Fix:** Drop the option and the conditional label-spreading.

#### B19. `verifyLogIntegrityOnCommit` adds a 35-line test-only opt-in branch — **LOW**

Toggle defaulted off; only one test opts in. The read path
catches the same condition on the next consult.

**Fix:** Delete the option and the `#walkLog` private method.

#### B20. `serializeManifestPointer` exported `@internal` for one in-file caller — **LOW**

Five-character expression (`${snapshot ?? "none"}@${next_seq}`)
with one caller in the same file.

**Fix:** Inline; drop the export.

#### B21. `RawStorageApi` duplicates `Storage` locally for a gratuitous signature difference — **LOW**

`db.ts:108-116` defines `RawStorageApi` separately from `Storage`
so its `delete` signature can be slightly narrower
(`opts?: { signal }` instead of `StorageDeleteOptions`).

**Fix:** Type `_raw` as `Storage`. Drop `RawStorageApi`.

#### B22. `migrate.ts` is a 255-line CLI helper living in the server kernel — **LOW**

Sole non-test caller: `packages/cli/src/admin/migrate.ts:37`.
Imports `compactor.ts`, `log-walk.ts`. No `Db`/`Table`/`Query`/
`ServerWriter` reference it.

**Fix:** Move to `@baerly/cli` (or a separate `@baerly/admin`
package). Cuts ~3KB from the published kernel bundle if not
tree-shaken.

#### B23. `IN_FANOUT_THRESHOLD` is configurable; `IN_FANOUT_PARALLELISM` is hard-coded — pick one — **LOW**

Two `$in` knobs with asymmetric exposure. `THRESHOLD` is
`Db.create`-overridable with 6 lines of validation in `db.ts:343-348`
and a long JSDoc. `PARALLELISM` is a module constant.

**Fix:** Drop `inFanoutThreshold` from `Db.create`. Hard-code
50. Simplify the constructor and `TableReadContext`. If users
hit it, they file a bug.

#### B24. Naming drift: `Writer`, `writer`, `ServerWriter` — **LOW**

The class is `ServerWriter`; variables are `writer`; specs and
JSDoc switch between "the writer," "Writer," and "ServerWriter."

**Fix:** Rename → `Writer`. The `@baerly/server` package
context makes "Server" redundant. Consider merging `commit` and
`commitBatch` into `commit(inputs: CommitInput |
readonly CommitInput[])`.

### C. Server periphery — auth, observability, http, compactor, gc, maintenance

#### C1. Router's verifier middleware is dead code — **HIGH**

`packages/server/src/http/router.ts:206-216` (plus
`CreateRouterOptions.verifier` and surrounding JSDoc). Both
adapters call the verifier *before* building per-request `Db`
and pass `verifier: undefined` to `createRouter`. The
`app.use("/v1/t/*", verifier)` branch never executes in
production. Adds an exported option, "Mode A vs Mode B" JSDoc
framing, and a code path tests must keep alive.

**Fix:** Delete `CreateRouterOptions.verifier`, the middleware
block, and the Mode-A/B JSDoc. One way: "adapter resolves
tenant, constructs `Db`, calls `createRouter({ db })`."

#### C2. Healthz served twice; `healthCheck` flag never `true` in production — **HIGH**

Both adapters serve `/v1/healthz` upstream and pass
`healthCheck: false`. The flag toggles a dead route
registration + a 3-line short-circuit.

**Fix:** Drop `healthCheck` from `CreateRouterOptions`. Delete
the route + path-check.

#### C3. Router "Mode A vs Mode B" branching is purely tests + the dead path above — **HIGH**

`router.ts:108-195` — 60 lines of observability middleware in
two modes. Adapters always provide ambient context (Mode A);
Mode B duplicates work already in `withObservability` and in
both adapters.

**Fix:** Delete Mode B (lines 147-194). Document
`createRouter` as "must be called inside `runWithContext`;
`flushCanonicalLine` is caller's responsibility." Healthz
short-circuit, `caughtError`/`c.error` reconciliation, and
`mapError` fallback all collapse.

#### C4. JWKS refresh-on-kid-miss + per-request WeakMap memo are over-engineered — **MEDIUM**

`bearer-jwt.ts:153-256`: `inflight` dedup + TTL cache +
per-minute kid-miss rate limit + stale-on-failure fallback +
`WeakMap<Request, Promise<...>>` per-request memoizer. The
router calls the verifier once per request — WeakMap has no
production hits. Kid-miss-rate-limit is for "key rotation +
thundering herd of unknown kids" — not a real pre-launch
workload.

**Fix:** Drop the `WeakMap` memo (lines 249-257). Drop the
kid-miss refresh path (237-247, 289-292). Keep `inflight` and
the TTL/stale-on-failure logic.

#### C5. `dev-landing.ts` ships HTML literal in the kernel bundle — **MEDIUM**

67 lines of HTML + `escapeHtml`, branched into by both
adapters' `GET /` handlers. Ships in the kernel bundle for
every prod deployment. The `appLabel` option is never set
externally.

**Fix:** Move to `@baerly/dev` (where dev-only concerns
belong), or dynamic-import it. At minimum drop `appLabel` — only
`escapeHtml(opts.app)` is realised.

#### C6. Compactor + GC + maintenance: three `withObservability` wrappers emit three canonical lines per tick — **MEDIUM**

`compactor.ts`, `gc.ts`, `maintenance.ts` each call
`withObservability(...)` + `teeMetricsRecorders(...)`.
`maintenance.ts` *also* wraps both children in its own
`withObservability` — operator sees three canonical lines per
cron tick for one unit of work.

**Fix:** `runScheduledMaintenance` skips its own scope; runs
`compact()` and `runGc()` in the caller's scope. Or invert:
maintenance owns the scope; `compact`/`runGc` accept the
recorder positionally.

#### C7. Three maintenance profiles for two real environments — **MEDIUM**

`CLOUDFLARE_FREE_TIER` / `CLOUDFLARE_PAID_TIER` / `NODE_PROFILE`.
`NODE_PROFILE`'s only non-default value is `maxEntriesPerRun:
100_000` — i.e. "fold the entire tail," which already happens
when `maxEntriesPerRun > nextSeq - logSeqStart`.

**Fix:** Keep `CLOUDFLARE_FREE_TIER` (the only non-trivial
one). Delete `NODE_PROFILE`; pass `{}` for Node. Rename to
make the asymmetry explicit.

#### C8. `skipCompact` / `skipGc` leak an even/odd-minute cron hack into the API — **MEDIUM**

Exist only so the CF Worker free-tier can alternate compaction
and GC across cron minutes (`worker.ts:423-424`). They turn
`runScheduledMaintenance` into "either of two functions";
`MaintenanceResult.compact | null` / `gc | null` discriminate
on this in every caller.

**Fix:** Expose `compactOnce` and `gcOnce` directly. The cron
handler calls whichever it wants. Drop the flags and the `null`
arms of `MaintenanceResult`.

#### C9. Observability exports 17 internal symbols nobody outside the adapters uses — **MEDIUM**

`observability/index.ts` exports `RequestScopedMetricsRecorder`,
`alsAwareRecorder`, `decideSample`, `serializeError`, `getLogger`,
`getEffectiveSampleRate`, `flushCanonicalLine`, `peekContext`,
`withObservability`, `observableStorage`, `deriveOutcome`,
`runWithContext`, `getCurrentContext`, `createObservabilityContext`,
+ six type aliases. Only `ObservabilityConfig` and `FriendlyLogLevel`
are read by adapter/example code. The barrel comment even says
"dormant. Nothing in @baerly/server's existing surface imports
from here yet."

**Fix:** Collapse the subpath. Export `ObservabilityConfig` +
`FriendlyLogLevel` from the main barrel. Move the rest to
`baerly-storage/internal` (or delete). Drop the
`./observability` subpath entirely.

#### C10. `peekContext` is exported but unused — **LOW**

Trivial wrapper around `getCurrentContext` (also exported).

**Fix:** Delete.

#### C11. `MetricsSnapshot` / `ObservationRow` / `MetricsSummary` are test-only on the public surface — **LOW**

Used only by observability's own tests via
`RequestScopedMetricsRecorder.snapshot()`. Production reads via
`summarize()`.

**Fix:** Demote to `@internal` or unexport.

#### C12. Three ways to produce an error Response: `mapError`, `mapToResponse`, `jsonError` — **LOW**

`router.ts:437-475`: `mapError` returns `{status, envelope}`,
`mapToResponse` wraps that in `c.json`, `jsonError` builds a
Response from `(code, message)` without going through
`mapError`. Handlers pick inconsistently.

**Fix:** Inline `jsonError(c, status, code, msg)` callers as
`mapToResponse(c, new BaerlyError(code, msg))`. One path.

#### C13. `ReadJsonResult` discriminated union over-modelled for two callers — **LOW**

`router.ts:491-554`: tagged union with `kind: "ok"|"err"`, a
redundant `status` + `code` + custom `message`. POST and PATCH
each do `if (body.kind === "err") return jsonError(c, ...)`.

**Fix:** Have `readJsonBody` throw `BaerlyError` directly; the
existing `try/catch` already calls `mapToResponse`.

#### C14. `Db._raw` + `rawAsStorage` half-implements `Storage` for one consumer — **MEDIUM**

`since.ts:322-346` builds a 1-method `Storage` (other three
throw `Internal`) because `Db` doesn't expose a tenant-aware
`get(key)`. The `eslint-disable no-underscore-dangle` at the
top of the file flags the smell.

**Fix:** Give `Db` a narrow `getCurrentJson(table)` and
`getLogEntry(table, seq)`. Delete `_raw` and `rawAsStorage`.

#### C15. `listEventsSince` exported from `@baerly/server` but only `longPollSince` consumes it — **LOW**

**Fix:** Keep module-private. Drop from `http/index.ts` and
the top-level barrel.

#### C16. `BAERLY_SINCE_TIMEOUT_MS` / `BAERLY_SINCE_POLL_INTERVAL_MS` env knobs nobody sets — **LOW**

Two env-overridable defaults plus per-call overrides
(`sinceTimeoutMs`/`sincePollIntervalMs`) plumbed through both
adapters. No template, example, or doc sets them.

**Fix:** Drop env-var resolution; keep only the per-call
options. Re-add the env path when a caller asks.

#### C17. Compactor/GC config knobs no caller actually tunes — **MEDIUM**

`CompactOptions` exposes `maxEntriesPerRun`, `minEntriesToCompact`,
`signal`, `metrics`. `RunGcOptions` adds `graceMillis`,
`maxMarksPerRun`, `maxSweepsPerRun`, `now`. Every knob is set
in exactly one of: a profile constant, the CLI `--min-entries`
flag, or a test. No production caller hand-tunes them.

**Fix:** Inline the profile defaults. Drop `minEntriesToCompact`
from the public surface. Re-add when day-N tuning request lands.

#### C18. `logger-pretty.ts` + `picocolors` is a CLI concern in the kernel — **LOW**

Loaded only when `sink === "console-pretty"`. Both adapters
resolve to `"console-json"` in prod. `picocolors` is the only
runtime dep beyond `aws4fetch`, `idb-keyval`, `@xmldom/xmldom`,
`hono/tiny`.

**Fix:** Move the pretty sink to `@baerly/dev` (matches the
`baerly dev` UX use case). Drop `picocolors` from the kernel
dep tree.

#### C19. Both adapters repeat ~30 lines of observability ceremony — **MEDIUM**

`adapter-cloudflare/worker.ts:233-290` and
`adapter-node/server.ts:158-290` reproduce: `ensureObservability()`
→ `alsAwareRecorder(operatorRecorder)` → build verifier-rejection
canonical line → build success canonical line → attach
`deriveOutcome(...)` → `flushCanonicalLine(...)`. 401-on-verifier-
rejection is verbatim in both.

**Fix:** Lift `runWithObservedRequest(req, verifier, handler)
→ Promise<Response>` into `@baerly/server`. Both adapters call
it. Combines with C1-C3 to make router config genuinely
trivial.

#### C20. `db.storage.class_a_ops_total` double-`_total`-suffix guard — **LOW**

`observability/recorder.ts:96-104`'s `summarize()` special-cases
counters whose name already ends in `_total`. The only such
counter is `observableStorage`'s — which chose to bake `_total`
into the name. The guard exists because the *emitter* chose
the wrong name.

**Fix:** Rename emitter counters to drop `_total` (let
`summarize()` add the suffix). Delete the guard.

#### C21. `CATEGORY` table maps 8 categories that collapse to 2 in practice — **LOW**

`auth`/`storage`/`writer` never flush a canonical line; the
remaining four (`compactor`, `gc`, `rebuild`, `maintenance`)
differ only by their `extra` fields. No external consumer
routes by category.

**Fix:** Collapse to `baerly.http` (request lines, verifier
warns) and `baerly.maintenance` (every non-request unit-of-work
+ storage debug). 2-entry `CATEGORY` constant; `UNIT_TO_CATEGORY`
folds.

#### C22. Module-header doc comments restate code in 30-50-line essays — **LOW**

`observability/context.ts:23-29`, `compactor.ts:96-105`,
`since.ts:1-4`, `gc.ts:38-41`. Each leads with a "Order of
operations / Cost model / Why this is here" preamble that
repeats inline JSDoc, the ticket file, and the spec doc.
~8% of audited LOC in this area.

**Fix:** Trim to one paragraph + one `@see`. Citations to
`.claude/research/...` don't belong in published source.

### D. Protocol kernel

#### D1. `protocol/db.ts` exports `Table`/`Query`/`Predicate` — no `Db` class — **HIGH**

Both packages have a `db.ts`; only the server's contains a
`Db` class. The same filename in two packages with different
concepts is a navigation/grep landmine. An LLM expects
`db.ts` to define `Db`.

**Fix:** Rename `packages/protocol/src/db.ts` → `table-api.ts`
or move into `query/` next to `predicate.ts`.

#### D2. Dead constants in `protocol/src/constants.ts` — **MEDIUM**

`MANIFEST_LIST_LOOKAHEAD_MILLIS`, `SYNCER_CLOCK_SKEW_MAX_RETRIES`,
`MEM_CACHE_CAPACITY`, `ORPHAN_MANIFEST_GRACE_MILLIS` are
referenced only from `constants.ts` itself + dead JSDoc
pointing at the (also dead) `Syncer` (see A12). `SESSION_ID_LENGTH`
has 2 callers and could be inlined.

**Fix:** Delete all four. Inline `SESSION_ID_LENGTH = 6` at
the two `slice(0, 6)` sites.

#### D3. `time.ts:adjustClock` + `measure` + `dateToSecs` are dead — **MEDIUM**

`adjustClock` (40 lines + `AdaptiveClockConfig`) implemented an
adaptive-clock feature that's gone — `S3HttpStorage` no longer
plumbs an `AdaptiveClockConfig`. `measure` and `dateToSecs`
have only test callers.

**Fix:** Delete `adjustClock`, `AdaptiveClockConfig`, `measure`,
`dateToSecs`. Keep only `timestamp` and `delay`. Shrinks
`time.ts` from 96 → ~20 lines.

#### D4. `hashing.ts:toB64`/`fromB64`/`or`/`inside`/`b64` are dead bloom-filter scaffolding — **MEDIUM**

Tested in `hashing.test.ts` but unused elsewhere.

**Fix:** Delete. Rename `hashing.ts` → `version.ts` (it now
only houses `versionFromContent`).

#### D5. `o-map.ts` is dead + the name explains nothing — **MEDIUM**

`OMap<K,V>` is unreferenced outside its own test. The name
("ordered map"? "object map"?) carries no signal in `.d.ts`.

**Fix:** Delete the file + test. Drop from barrel.

#### D6. `coordination/current-json.ts:claimWriter` is reserved-for-future dead code — **MEDIUM**

95 lines (~20% of the file) implementing a two-CAS-round-trip
writer-fence claim. `WriterFence.lease_until` is "reserved for
future manual rotation workflows; current code only writes the
field through if a caller supplies it and does not read it" —
explicit speculation.

**Fix:** Delete `claimWriter` and `lease_until` until a caller
exists. Keep `epoch` minting in `createCurrentJson` (only the
epoch is safety-load-bearing).

#### D7. `json.ts:diff` / `fold` / `clone` are dead — **MEDIUM**

Only `merge` is used (in `query.ts`). `clone`, `fold`, `diff`
have only `json.test.ts` callers.

**Fix:** Delete. Shrinks `json.ts` 78 → ~40 lines.

#### D8. Brand types `ManifestKey`, `S3VersionId`, `ContentVersionId`, `VersionId` leak with no enforcement — **MEDIUM**

`Storage.put`/`get` use plain `string` for `versionId`.
`ManifestKey` is unused. `versionFromUuid` exists solely to
produce a `ContentVersionId` brand nothing enforces.

**Fix:** Delete all four brand types and `versionFromUuid`.
Type `versionFromContent` as `Promise<string>`.

#### D9. `Ref` / `ResolvedRef` / `eq` / `url` / `resolveContentRef` / `resolveManifestRef` / `DeleteValue` are dead — **MEDIUM**

Pre-collections-era addressing model. Live only in `types.ts`.
`countKey` has one caller and is more legible inlined.

**Fix:** Delete the seven symbols. Inline `countKey`,
`uint2strDesc`, `str2uintDesc` at their 2-3 call sites.

#### D10. `xml.ts` parser ships 80% dead-commented S3 fields — **LOW**

Half the file body is commented-out `IsTruncated`, `Name`,
`Prefix`, `Delimiter`, `MaxKeys`, `CommonPrefixes`, `EncodingType`,
`Owner`, `Size`, `StorageClass` lines. Actually-consumed fields:
`Contents.{ETag,Key,LastModified}` + `NextContinuationToken`.

**Fix:** Strip dead comments. Drop the 4 unused fields from
`ParsedListObjectsV2Output`. Move `XmlParser`/`XmlNode` into
`xml.ts` (currently re-exported from `types.ts`).

#### D11. `verifier.ts` JSDoc describes semantics protocol can't enforce — **MEDIUM**

The JSDoc tells callers about two responsibilities ("scope
check (403)", "`Db` construction") that live in `@baerly/server`,
not the kernel. An LLM reading the kernel `.d.ts` for
`Verifier` gets a wall of server-side semantics.

**Fix:** Trim to the kernel-visible contract (`tenantPrefix:
non-empty, no /`; `identity: opaque`). Move dispatcher semantics
to `@baerly/server`.

#### D12. `predicate.ts` (1086 lines) packs three independent algebras — **MEDIUM**

(a) `validatePredicate` + helpers (~330 lines), (b) `matches`
evaluator (~130 lines), (c) `mergePredicates` + `predicateImplies`
(~600 lines — two algebra engines). `predicateImplies` is
planner-only; only `query-planner.ts` calls it.

**Fix:** Split into `query/validate.ts`, `query/matches.ts`,
`query/merge.ts`. Move `predicateImplies` into
`@baerly/server/query-planner.ts` (planner-only consumer).
Reduces per-change diff blast-radius.

#### D13. `Predicate<T>` index signature defeats key narrowing — **MEDIUM**

`{ readonly [K in keyof T]?: … } & { readonly [dottedPath: string]:
… }`. The string index signature dominates: any keyof T
narrowing is lost; `{ wrongField: "x" }` typechecks against
any predicate.

**Fix:** Drop the string index signature; require dotted paths
via an explicit sub-key (e.g. `where({...}, { dotted: {...} })`)
or a separate helper. Trades minor ergonomics for actual type
safety on field names — the brand-types philosophy says this
matters.

#### D14. `Storage` interface forces full capabilities on every adapter — **MEDIUM**

Every impl must support `versionId`, `signal` (abort),
`ifNoneMatch` on `get`, `ifMatch`/`ifNoneMatch:"*"` on `put`,
`lastModified` on `list`, `serverDate` on `put`. The
conformance suite gates `supportsAbort`/`supportsCAS` (capability
flags) but those don't propagate at runtime. `versionId` is
read on production paths but never set on `Storage.get({versionId})`
from production code.

**Fix:** Decide: either narrow the interface with capability
mixins (`Storage & CasCapable & VersionCapable`), or drop the
unused `versionId` parameter on `get()` and document
`Storage` as requiring CAS-by-`ETag` + abort universally.

#### D15. `S3HttpStorage` lives in `@baerly/protocol` despite the adapter pattern — **LOW**

400 lines of concrete S3+retry engine in the otherwise-pure
kernel. `@baerly/adapter-node/index.ts:69` already re-exports
it — that's the user-facing entry. Asymmetric with
`@baerly/adapter-cloudflare`'s `r2-binding-storage.ts` living
in its own package.

**Fix:** Move `S3HttpStorage` to `@baerly/adapter-node`. Keep
protocol as pure-interface + `MemoryStorage`. Symmetric.

#### D16. `conformance.ts` imports vitest at module top, lives in a "must run in Workerd + Node + browser" package — **LOW**

Hard `import { fc, test } from "@fast-check/vitest"` and
`import { ... } from "vitest"`. Loaded via subpath `./conformance`;
careless `import * from "@baerly/protocol"` would drag vitest
into Workerd.

**Fix:** Either move to a dedicated `@baerly/test-storage`
package, or rewrite the package description to acknowledge the
test-only subpath.

#### D17. `metrics.ts:InMemoryMetricsRecorder` is observability harness in the kernel — **LOW**

50-line "memory-grows-unbounded — not suitable for production"
class next to the load-bearing `MetricsRecorder` interface.

**Fix:** Move to `@baerly/server/observability`. Keep
`MetricsRecorder` + `noopMetricsRecorder` + `teeMetricsRecorders`
in protocol.

#### D18. `lsnParts` exists for a use case the lsn JSDoc forbids — **LOW**

`LogEntry.lsn` JSDoc: "**do not parse it** — use the `session` /
`seq` fields below." `lsnParts(lsn)` is then exported and used
by `since.ts:277` to recover `seq`.

**Fix:** Either delete `lsnParts` and have `since.ts` use
`LogEntry.seq` directly, or soften the JSDoc.

#### D19. `parseRetryAfter` is exported but only its own file consumes it — **LOW**

**Fix:** Drop the `export`. Test imports stay relative.

#### D20. R2-free-tier constants belong in the CLI, not the protocol kernel — **LOW**

`R2_FREE_TIER_CLASS_A_OPS_PER_MONTH`, `R2_FREE_TIER_CLASS_B_OPS_PER_MONTH`,
`R2_FREE_TIER_STORAGE_GB_PER_MONTH` etc. are pricing literals
that drift when Cloudflare changes rate sheets. Consumed only
by `@baerly/cli` doctor/banner.

**Fix:** Move to `@baerly/cli`. Keep
`STORAGE_OPS_PER_LOGICAL_WRITE = 3` in protocol (real cost-
model invariant).

### E. Client (browser + React hooks)

#### E1. `ClientTable.order()` is dead code on the wire — **HIGH**

Typed `order()` method on `ClientTable` / `ClientQuery` updates
`QueryState.order`, but `listParams()` never serializes it; the
server router passes `order: undefined` unconditionally. A user
writing `.order({ created_at: "desc" })` silently gets
unordered rows.

**Fix:** Either thread `order` through the query string and
have the server consume it, or remove `order()` from the client
surface for day one. Shipping a fluent method that silently lies
is the worst outcome.

#### E2. `replace()` is JSON-merge-patch, not replace — **HIGH**

`client.ts:330-348`'s `replace()` sends `PATCH { patch: doc }`
— identical to `update()`. JSDoc admits this. JSON-merge-patch
*preserves* keys absent from the patch. A user calling
`replace(newDoc)` to clear a field gets the old field silently
retained.

**Fix:** Either delete `replace()` until the server has a real
PUT route, or implement replace semantics (PUT, or PATCH with
explicit nulls for removed keys).

#### E3. `count()` secretly downloads every row — **HIGH**

`client.ts:302-312`: no `/v1/count` route exists, so `count()`
issues a list GET and takes `.length`. An agent calling
`client.table("tickets").count()` on a 100k-row table
silently downloads all of them.

**Fix:** Add a `/v1/count` route on the server before public
release, or remove `count()` from the client surface. A
method that secretly downloads everything is worse than a
missing one.

#### E4. `ClientTable` re-declares the protocol's `Table<T>` shape verbatim — **MEDIUM**

`client.ts:60-74,85-102` clones `Table<T>` / `Query<T>` method-
by-method with identical JSDoc. A `_ShapeParityProbe` in
`client.test.ts:193` compile-checks they agree — proving the
duplication is load-bearing dead weight.

**Fix:** Reuse `Table<T>` / `Query<T>` from `@baerly/protocol`
directly. Drop `ClientTable` / `ClientQuery` exports.

#### E5. Terminals do not accept per-call `AbortSignal` — **HIGH**

`first`/`all`/`count`/`insert`/`update`/`replace`/`delete` take
no options. Only `since()` and `healthz()` accept `{ signal }`.
Hooks must rely on a client-wide `signal` or unmount-time
cleanup — neither is correct for "cancel this specific list
when the predicate changes." `useLiveQuery` uses a `cancelled`
boolean flag instead of signal threading.

**Fix:** Add `{ signal }` as an optional second arg on every
terminal. Effect-cleanup `AbortController` should hit the
in-flight request.

#### E6. `useChanges` exposes the wrong semantics for its name — **HIGH**

JSDoc says "each render sees the latest non-empty batch only" —
agents will assume `useChanges` accumulates. The doc explicitly
tells users to `useReducer` themselves to dedup-and-accumulate.
The only existing consumers (`useLiveQuery`/`useLiveDocument`)
want a "tick when a refetch is warranted" signal, not raw events.

**Fix:** Either (a) hide `useChanges` and expose
`useInvalidationTick(client, table, predicate?)` whose result
is `number`, or (b) make `useChanges` accumulate-and-dedup-by-
`lsn` by default with `accumulate: false` opt-out. Today's
contract is a sharp edge with one footnote disclaimer.

#### E7. `useLiveDocument`'s "not yet read" vs "confirmed missing" is implicit — **MEDIUM**

After the first read returns `[]`, `row = undefined` and
`loading = false`. The combined state means "missing"; the
"loading first time" state has the same `row` value. Agents
will write `if (!row) return <NotFound />` and silently miss
the loading state.

**Fix:** Promote the discriminator: `{ status:
"loading"|"ok"|"missing"|"error", row?, error? }`. Or add a
`notFound: boolean` field.

#### E8. Hook signatures: `(client, table, predicate, opts)` positional — **MEDIUM**

Four positional params, third optional. TanStack/SWR settled on
one options-bag arg long ago.

**Fix:** Migrate to `useLiveQuery({ client, table, where?,
enabled? })`. Even better — put `client` on a context
(`<BaerlyProvider client={...}>`) so the hook is
`useLiveQuery({ table, where? })`. Every example currently
imports `client` from a module-scoped file.

#### E9. No `useInsert` / `useUpdate` / `useDelete` — examples use the wrong pattern — **MEDIUM**

Examples write `onClick={async () => { await client.table(...).delete(); ... }}` — no
in-flight state, no optimistic update, no error toast. The
library implies hooks should handle this but provides none.

**Fix:** Ship a thin TanStack-style `useMutation` (`{ mutate,
isPending, error }`), or commit to the imperative pattern and
make examples reflect that choice.

#### E10. Boolean-state naming inconsistency: `loading` vs `polling` vs (no) `isPending` — **LOW**

Three hooks ship three different "in-flight" field names.
React 19 + TanStack settled on `isPending`.

**Fix:** Standardise on `isLoading` or `isPending`. Drop
`polling` (see E11).

#### E11. `polling` and `error` from `useChanges` — `polling` unread, misleading — **LOW**

Neither downstream hook reads `polling`. It's `true` for ~24 of
every 25 seconds (long-poll wall-clock), so useless for a UI
spinner.

**Fix:** Drop `polling` from `UseChangesResult`.

#### E12. `useLiveQuery` resets cursor on `enabled` flip — **MEDIUM**

Deps `[client, table, enabled, since]`. Toggling enabled
`false → true` reassigns `currentCursor = since` (initial)
inside the effect, replaying history.

**Fix:** Persist cursor across `enabled` flips via a ref, or
document that re-enabling restarts.

#### E13. `MockFetch` (`@baerly/client/testing`) ships to consumers with zero external users — **MEDIUM**

82-line class. `grep MockFetch outside packages/client/` → 0
hits. `sideEffects: false` lets tree-shaking handle it, but
the subpath is on the published `exports` surface.

**Fix:** Drop the `./testing` subpath until a user asks. Or
replace `MockFetch` with a one-paragraph docs snippet showing
`vi.fn()` patterns idiomatically.

#### E14. `stableKey` is hand-rolled stable-stringify with predicate-shape blind spots — **LOW**

Comment claims predicates carry `JSONArraylessObject` — but
predicates include `PredicateOp` (`{ $in: [...] }`). No test
covers operator-shape predicates.

**Fix:** `JSON.stringify` with a sorted-keys replacer (10
lines, idiomatic) or `json-stable-stringify`. Add a test for
`{ priority: { $in: ["p1"] } }`.

#### E15. `findLastMatch` polyfill is dead weight — **LOW**

`Array.prototype.findLast` is baseline since July 2022; Node
24+, Workerd, all modern browsers ship it.

**Fix:** Drop the polyfill in `use-live-document.ts:102-113`.

#### E16. `healthz()` swallows `AbortError` as `false` — **MEDIUM**

`try { ...request... } catch { return false; }` — bare catch.
`AbortError` from caller-supplied signal returns `false`,
indistinguishable from "server is down."

**Fix:** Re-throw `AbortError`; only return `false` for
network/HTTP errors.

#### E17. `signal` on `BaerlyClientOptions` is constructor-scoped but named like per-request — **LOW**

A `signal` field on the constructor suggests "cancel client
construction" — actually "merged into every request the
client ever makes."

**Fix:** Rename `globalSignal` or `lifecycleSignal`. Document
on the field itself.

#### E18. `BaerlyClientError.code === "Internal" && status === 404` is undocumented sentinel for DELETE-404 — **MEDIUM**

`client.ts:367-369` swallows 404 on DELETE by matching `code ===
"Internal"` (the *request layer's* synth) instead of `"NotFound"`
(the *route's* envelope). Fragile.

**Fix:** Fix the request layer to preserve `NotFound`
consistently. Match `code === "NotFound"`.

#### E19. `index.ts` doesn't re-export protocol types — **LOW**

`Predicate`, `OrderSpec`, `ConsistencyLevel`, `JSONArraylessObject`,
`LogEntry`, `BaerlyErrorCode` aren't re-exported from
`@baerly/client`. Users must dual-import.

**Fix:** Re-export the six types that appear on the public
client surface. Single-import DX for the common case.

#### E20. Chainable builder allocates ~8 closures per modifier — **LOW**

`.where(...).where(...).consistency(...).all()` allocates 32+
closures (each `makeClientQuery` returns an object literal of
methods). Hot path on a refetching hook.

**Fix:** Either hoist methods onto a class/prototype, or
benchmark and accept. Flag for the bundle-size budget; not
launch-blocking.

### F. Adapters + dev + export

#### F1. `Env.TENANT` is a required worker field that the adapter never reads — **MEDIUM**

`Env.TENANT: string` declared non-optional; JSDoc admits
"TENANT is not special-cased by baerlyWorker." Every consuming
example must put a fake `TENANT` in `wrangler.jsonc` to
satisfy the type, then `src/server/index.ts` hard-codes the
tenant separately.

**Fix:** Either drop `TENANT` from `Env`, or wire `env.TENANT`
through `selectVerifier` and remove the literal in the example.

#### F2. Default `scheduled` handler is dead code in every shipped example — **MEDIUM**

`worker.ts:400-431`'s default cron handler only fires when
`env.CURRENT_JSON_KEY` is set. Zero examples set it; the
multi-tenant docs say "use `options.scheduled` instead." So
the entire single-tenant fallback (`env.CF_TIER`, profile
selection, minute-parity alternation) ships but never runs in
test or scaffold.

**Fix:** Either wire `CURRENT_JSON_KEY` in the minimal
template (so the cron actually does maintenance), or remove
the default `scheduled` path and require `options.scheduled`.

#### F3. `BaerlyWorkerOptions.handler` / `WorkerHandler` is unused dead surface — **MEDIUM**

No example, manual-e2e, or test uses it. Asymmetric (Node side
has no equivalent). Examples that need custom routes already
wrap `baerlyWorker(...)` in their own `fetch` (see
`minimal-cloudflare/src/server/index.ts:94-101`).

**Fix:** Delete `handler` / `WorkerHandler`. ~25 LoC plus a
public API field gone.

#### F4. `@baerly/export` is 1500 LOC for a feature with one CLI consumer — **MEDIUM**

Eight public exports, all consumed by exactly two call sites:
`packages/cli/src/export.ts` and one round-trip integration
test. The sidecar JSON exists solely so a round-trip test can
coerce SQLite 0/1 back to booleans. `where.property.test.ts`
(359 LOC, "property"-named but fixture-driven — `grep "fc\."`
returns zero hits) ships a hand-rolled SQL parser/evaluator as
a regression guard for eight fixtures.

**Fix:** Collapse `@baerly/export` into `packages/cli/src/export/`
as private modules. Drops a public package + a phantom
property-test file. If a future adapter needs the SQL emitters,
promote selectively.

#### F5. Body-streaming pump in Node adapter ignores backpressure — **MEDIUM**

`server.ts:317-327` hand-rolls `getReader()` / `while (chunk =
await reader.read())` to drain the router's `Response.body`
into `node:http`'s `ServerResponse`. No `res.once("drain", ...)`
on `res.write() === false` — silently drops backpressure.
Node 24's `Readable.fromWeb(response.body).pipe(res)` (or
`pipeline`) handles it correctly. `pipeline` is already
imported for static-asset streaming.

**Fix:** `await pipeline(Readable.fromWeb(response.body),
res)`.

#### F6. Cache LIST-URL index is invisible test-only state with brittle TTL coupling — **MEDIUM**

~150 of `cache.ts`'s 383 lines maintain an in-isolate
`Map<string, Map<string, Timer>>` index of LIST URLs so writes
can fan-out `cache.delete()` to filtered-list variants. Best-
effort (cold start has no index hit; "belt-and-braces bare-list
bust" at line 357 papers the gap). `MAX_KEYS_PER_TABLE = 256`
eviction has zero test coverage.

**Fix:** Drop the index. Make `withReadCache` skip LIST URLs
(`/v1/t/:table` without `:id`) entirely — list responses are
the hot footgun; per-doc URL caching is cheap and per-key
bustable. Cuts ~150 LoC.

#### F7. `__resetListUrlIndexForTests` leaks test state through module — **LOW**

Module-level `LIST_KEY_INDEX` requires a public reset helper
just so `afterEach` can clear it.

**Fix:** If F6 lands, gone. Otherwise attach the index to a
`WithReadCache` class instance instead of module scope.

#### F8. `cacheKeyFor` / `invalidateOnWrite` / `withReadCache` exported from CF adapter main entry — three plumbing fns with no example caller — **LOW**

`baerlyWorker` wires them internally. No template hand-wires.

**Fix:** Drop from public barrel. Document a `@baerly/adapter-
cloudflare/cache` subpath if advanced users ask.

#### F9. R2 binding storage error mapping is regex-on-message — **MEDIUM**

`r2-binding-storage.ts:160-167` maps errors via regex on
`e.message` (`/auth|permission|forbidden/i` → `AccessDenied`,
etc.). CF's binding error messages are not part of the platform
contract — silently regresses to `NetworkError` on rewording.

**Fix:** When CF types add typed binding errors, switch. For
now, add a regression test asserting the regex matches the
*current* miniflare error shape so a future binding change
fails here, not in production.

#### F10. JWKS factory missing from `@baerly/adapter-node`; auth presets re-import asymmetric — **MEDIUM**

Node adapter ships four `*Storage` factories but no
`bearerJwt`/`sharedSecret` factory; every Node example imports
them from `@baerly/server/auth` directly. CF examples similarly
import `cloudflareAccess`/`sharedSecret` from `@baerly/server/auth`.
Asymmetric.

**Fix:** Re-export auth presets from each adapter's barrel.
Saves one import line in every consuming app; makes the
adapter look like a single dep.

#### F11. `S3HttpStorage` re-exported from adapter barrel where factories already cover the case — **LOW**

`adapter-node/src/index.ts:69-70` exports raw `S3HttpStorage` +
`S3HttpStorageOptions` alongside the four factories. The
escape hatch is real but ships `xmldom`-typed symbols 99% of
callers don't touch. `manual-e2e/node/server-entry.ts:16` even
reaches for `S3HttpStorage` directly — proving the escape
hatch is *more discoverable* than the sugar.

**Fix:** Move to `@baerly/adapter-node/advanced` subpath. Keep
the agent-facing barrel small; the factory path becomes the
obvious default.

#### F12. `@baerly/dev` exports public surface for one CLI — **MEDIUM**

`printDevBanner`, `freeTierBudgetHint`, `ensureTable`,
`LocalFsStorage`, `baerlyDev` all in the public surface. Real
consumers: `packages/cli/src/dev.ts`, `examples/helpdesk`, one
CF/Node test each. The package is internal infra pretending to
be a library.

**Fix:** Reduce public surface to `LocalFsStorage`,
`ensureTable`, `baerlyDev` (the Vite plugin). Make
`printDevBanner` and `freeTierBudgetHint` internal (CLI is
in-repo, can import from `./internal/`).

#### F13. `freeTierBudgetHint` hard-codes R2 in a vendorless codebase — **LOW**

`budget-hint.ts:24` template literal references R2 free tier.
Used unconditionally by `baerly dev` — AWS/Minio/GCS users see
CF-branded ops budgets in their dev banner.

**Fix:** Either parameterise on storage flavor, or drop the
export and inline only on CF-aware paths.

#### F14. `LocalFsStorage` has no runtime guard against prod use — **LOW**

JSDoc warns about cross-process TOCTOU; nothing at runtime
guards. `examples/helpdesk` uses it for a quasi-production-
looking server, and `packages/cli/src/copy.ts` mounts it on
`file://` URIs.

**Fix:** Add a one-time `console.warn` outside `NODE_ENV=test`
on instantiation, OR rename → `DevFsStorage` so the intent is
visible at every call site.

#### F15. Two cache-test files with overlapping names — **LOW**

`cache.test.ts` (295 LOC) + `cache-status.test.ts` (371 LOC).
The second tests the canonical-line `cache_status` field which
is a worker-level concern, not a cache-module one.

**Fix:** Rename `cache-status.test.ts` →
`worker-cache-discriminator.test.ts` next to `worker.test.ts`.

#### F16. `baerlyDev` Vite plugin is `LocalFsStorage`-only with no escape hatch — **LOW**

Hard-coded `LocalFsStorage` + `sharedSecret`. No `storage` or
`verifier` override. An agent wanting Minio in dev drops to
raw `createListener`.

**Fix:** Accept `storage?: Storage`, `verifier?: Verifier`
overrides. Or rename → `baerlyLocalFsDev` to be honest about
scope.

#### F17. `runMaintenanceTick` (Node) wraps `runScheduledMaintenance` (kernel) for 20 lines of observability — **LOW**

Three layers of "tick" naming for the same compact-then-GC flow.

**Fix:** Inline the wrap in `baerlyNode`. Re-export
`runScheduledMaintenance` from the adapter; drop
`runMaintenanceTick`.

#### F18. Cross-product maintenance shape differs across adapters — **LOW**

Node uses `BaerlyNodeMaintenance: { tenants × collections }`
computed in-process. CF uses `CURRENT_JSON_KEY` env var for
one collection or `options.scheduled` for many. Two adapters,
two mental models.

**Fix:** Unify on `MaintenanceTargets: { currentJsonKeys:
readonly string[] }`. Extract `buildCurrentJsonKey(app,
tenant, collection)` to `@baerly/server/maintenance`.

#### F19. Error envelope shape diverges between adapters — **MEDIUM**

CF's `verifier === null` path inlines `errorEnvelope(...)`;
Node's calls `mapError(err)` for caught exceptions. CF doesn't
use `mapError` at all in the worker. A thrown `BaerlyError`
exits CF and Node with different 500 envelopes.

**Fix:** Use `mapError` consistently in both adapters' top-
level catch. Add a regression test asserting byte-identical
500 envelopes for the same thrown `BaerlyError`.

#### F20. `@baerly/export/package.json` is missing `publishConfig` block its siblings have — **LOW**

Siblings rewrite `./src/*.ts` → `./dist/*.js` for the published
artifact. `@baerly/export` doesn't — if made public it'd ship
raw `.ts` paths. Also missing `sideEffects: false`.

**Fix:** Add the block (or delete the package per F4).

### G. CLI + create-baerly

#### G1. `@baerly/cli` exports a public library API nobody imports — **HIGH**

`packages/cli/src/index.ts` re-exports 18+ symbols (`runCopy`,
`doCopy`, `parseBucketUri`, `runDev`, `runInit`, every
`admin/runXxx`, etc.). `grep` across `packages/`, `tests/`,
`examples/`, `manual-e2e/`, `bench/`, `eval/` for external
consumers returns zero hits. Exists only so vitest can call
`runFoo(argv)` without `process.exit`.

**Fix:** Delete `packages/cli/src/index.ts`. Drop the `exports`
block from `package.json`. Keep `bin: "./dist/baerly.js"` as
the only public artifact. Tests can co-locate with their
subcommand modules or use a test-only `index-internal.ts`.

#### G2. `baerly doctor` is a four-headed beast — **HIGH**

Accepts `--target`, `--fix`, `--usage`, `--check=index-filter-
drift`, `--rebuild-drift`, `--json`. Three of these are
independent verbs masquerading as flags. `--rebuild-drift` is a
*write operation* hiding inside a "doctor" that promises read-
only diagnosis.

**Fix:** Reduce `baerly doctor` to invariant-checking only.
Move `--usage` and `--check=index-filter-drift` into
`baerly admin`. `--rebuild-drift` → `baerly admin rebuild-index --all`
or fold into `baerly admin fsck --fix`.

#### G3. `cost/` subtree is scope creep — **HIGH**

`packages/cli/src/cost/` (project.ts 118 LOC, provider.ts 99 LOC,
229 LOC of tests) exists for one purpose: render a two-line USD/
month estimate as a footer on `baerly inspect`. Price tables are
hard-coded and require hand maintenance against pricing-log.md.
`inspect` always fires a writes/min estimator GET-storm to
print this footer.

**Fix:** Delete `cost/` and the trajectory footer from
`inspect`. If cost surfacing is desirable, ship as a separate
`baerly cost` verb. Or fold into existing graduation-hint in
`doctor/usage.ts`.

#### G4. `baerly copy` is kernel-class operator infra at the top level — **HIGH**

445 LOC bucket-to-bucket replicator with cursor grammar,
endpoint-pattern dispatch, snapshot encoding via
`@baerly/server`, write-path bypass. A peer of `admin migrate`/
`admin restore`, not of `dev`/`init`.

**Fix:** Move to `baerly admin copy`. First-impression `baerly
--help` then shows six day-1 verbs (`init/dev/deploy/doctor/
inspect/export`) instead of cluttering with operator forensics.

#### G5. Top-level `baerly --help` has 13 reachable verbs without ordering — **HIGH**

`copy / deploy / dev / doctor / init / inspect / export /
admin` at top, then `admin {rebuild-index / dump / restore /
compact / fsck / migrate}`. Neither alphabetical nor frequency-
ordered. Top-level description includes a forward reference to
`docs/about/pricing-log.md` — a docs URL no user can reach from
their terminal.

**Fix:** Order top-level by frequency: `dev, deploy, doctor,
init, inspect, export, admin`. Drop `copy` (per G4). Trim
description to one line. Move pricing-log breadcrumb to
README/website.

#### G6. Each subcommand re-implements `errorToExitCode` + `KNOWN_KEYS` + `resolveAppTenant` — **MEDIUM**

13 copies of `errorToExitCode`, 13 `KNOWN_KEYS` sets, 7 copies
of `resolveAppTenant` ceremony — ~800 LOC of copy-paste. A
bug fix has to ripple to 13 places.

**Fix:** Extract `defineBaerlySubcommand({ name, args, handler })`
that wraps arg-key whitelist, error→code mapping, `emitError`
integration, JSON-mode toggle. ~30-40% shrink per module.

#### G7. `inspect` does 5 storage walks for a glance command — **MEDIUM**

Per the docstring: 1 GET current.json + 1 GET snapshot + N
GETs log tail + K LISTs (per declared index) + 1 LIST snapshot/
prefix (orphan detection) + the writes/min estimator (another
LIST + up to 120 GETs of log entries). And the output lists
writer_fence, log_seq_start, next_seq, live_log_tail, row
counts, per-index counts, orphan snapshot keys, plus a 2-line
trajectory. Kernel-debugger UI for a "read-only summary."

**Fix:** Default to 3-line summary (collection, row count,
last-write time). Move snapshot-key / writer_fence /
log_seq_start / index counts behind `--verbose`. Move orphan-
snapshot detection into `admin fsck`. Move trajectory into
`baerly cost` (per G3).

#### G8. `inspect` silently falls back to `app=app, tenant=tenant` — **MEDIUM**

When `--app`/`--tenant` not passed and `baerly.config.ts` can't
load, hard-coded literals are used. A user running outside
their app dir gets confidently-wrong "current.json not found"
pointing at `app/app/tenant/tenant/...`. Same in every `admin
*` command.

**Fix:** Fail with `InvalidConfig` (exit 1) + hint pointing at
the flags. Centralise in the `defineBaerlySubcommand` helper
(per G6).

#### G9. `admin rebuild-index` policy differs from peers — **MEDIUM**

Uses citty's `default: "app"`/`default: "tenant"` — never
consults `baerly.config.ts`. Two policies for `--app`/`--tenant`
inside one `admin` subtree.

**Fix:** Standardise on the shared `resolveAppTenant` helper.

#### G10. The wizard prompts for `install` but drops the answer on the floor — **MEDIUM**

`prompts.ts:90-97` asks "Install dependencies?"; the value is
captured and never threaded further. Lying to the user.

**Fix:** Wire `install: true` through to scaffold + run
`pnpm install` in `outDir`, OR remove the prompt.

#### G11. The wizard never shows the `helpdesk` template — **MEDIUM**

`runWizard` returns `{projectName, target, install}` only. The
`helpdesk-cloudflare` template is reachable only via
`--starter=helpdesk` on the flag-driven path. A wizard user
has no way to discover it.

**Fix:** Add a select prompt with `minimal` / `helpdesk`. Or
drop the helpdesk template (564KB of the 964KB dist if
unreachable from the default flow).

#### G12. Scaffolded apps depend on `create-baerly` at runtime for `defineConfig` — **MEDIUM**

`baerly.config.ts` imports `defineConfig` from
`create-baerly/config` (an identity function). Every scaffolded
`package.json` therefore lists `create-baerly` as a runtime dep
— apps ship a coupling to the scaffolder forever.

**Fix:** Move `defineConfig` + `BaerlyAppConfig` into
`@baerly/server` (or a `@baerly/protocol`). Drop the
`create-baerly` runtime dep from scaffolds.

#### G13. `admin compact --skip-gc` / `--skip-compact` is a UX trap — **LOW**

A subcommand called `compact` accepts `--skip-compact`. The
GC-only path's verb should be `gc`.

**Fix:** Split: `baerly admin compact` (with `--also-gc`) and
`baerly admin gc`. Drop `--skip-*`.

#### G14. `doctor.ts` and `deploy/cloudflare.ts` each have a `defaultRunner` — **LOW**

Both wrap `node:child_process.spawn` for stdout/stderr piping.
Diverge slightly (doctor doesn't tee). ~20 LOC duplicated.

**Fix:** Hoist to `packages/cli/src/runner.ts`.

#### G15. `baerly init` and `baerly dev` have different banner styles — **LOW**

`init` emits no console banner — JSON envelope or silent
success. `dev` prints multi-line `printDevBanner` with "free-
tier budget hint" + tenant + verifier + data-dir. First-touch
inconsistency.

**Fix:** Unify. Strip `freeTierBudgetHint` from the `dev`
banner (per F13). Just show the URL.

#### G16. Env-var test hooks live in production code — **LOW**

`admin/dump.ts:219` and `restore.ts:210-212` branch on
`BAERLY_DUMP_STDOUT_PATH` / `BAERLY_RESTORE_STDIN_PATH` solely
so vitest can divert stdin/stdout to files.

**Fix:** Make `runDump`/`runRestore` accept `{ streams?:
{stdin?, stdout?} }`; tests pass file handles directly. Delete
the env-var branches.

#### G17. `BAERLY_REBUILD_INDEX_VERBOSE` is undocumented env-only verbosity — **LOW**

**Fix:** Replace with `--verbose`. Standardise across admin
commands.

#### G18. `loadConfigIndexes` re-implemented in 3 files — **LOW**

`inspect.ts:112-149`, `admin/fsck.ts:143-180`, partial in
`admin/rebuild-index.ts:120-175` — same 38-line function:
reject `.ts`, parse `.json`, otherwise dynamic-import and pluck
`cfg.collections?.[table]?.indexes ?? []`.

**Fix:** Hoist to `config.ts` as
`loadCollectionIndexes(configPath, table)`.

#### G19. `parseBucketUri` lives inside `copy.ts` but everyone imports it — **LOW**

7 CLI modules `import { parseBucketUri } from "./copy.ts"`.
Couples unrelated commands to a verb-named module.

**Fix:** Move `parseBucketUri` / `parseCursor` to
`packages/cli/src/bucket-uri.ts`.

#### G20. `S3_ENDPOINT` vs `BAERLY_S3_ENDPOINT` vs `R2_ENDPOINT` — three names for one concept — **MEDIUM**

`copy`/`inspect` read `BAERLY_S3_ENDPOINT`. The drift check
reads bare `S3_ENDPOINT` (collision risk with system env). CF
doctor `--usage` reads `R2_ENDPOINT`.

**Fix:** Standardise on `BAERLY_S3_ENDPOINT`.

#### G21. Scaffold ignore-list is split between hard-coded and manifest-declared — **LOW**

`scaffold.ts:178-187` unconditionally skips `node_modules`,
`dist`, `.wrangler`, `.dev.vars`, `.DS_Store`, `*.tsbuildinfo`
*in addition to* per-example manifest `excludePaths`.

**Fix:** Drop hard-coded list; require each manifest to declare
its own. The manifest exists for exactly this.

#### G22. AGENTS.md → CLAUDE.md copy hidden in `scaffold.ts:204-213` — **LOW**

Hard-wired in the walker, not declared in the manifest. Adding
a third coding-tool variant (`.cursorrules`, `.aider.conf`)
requires a code edit.

**Fix:** Add `manifest.copies: [{from: "AGENTS.md", to:
"CLAUDE.md"}]`. Drop the hardcoded branch.

### H. Examples (scaffolded user's first impression)

#### H1. `helpdesk-cloudflare` README "Quick start" tells the user the wrong command — **HIGH**

Says `wrangler secret put SHARED_SECRET` then `pnpm dev`. But
`pnpm dev` runs `vite` (with `@cloudflare/vite-plugin`), which
reads `.dev.vars` — `wrangler secret put` ships secrets to the
*deployed* Worker. Brand-new user types the documented commands;
dev server boots; first request gets 500 "No Verifier configured."

**Fix:** Replace with `cp .dev.vars.example .dev.vars` + edit.
`minimal-cloudflare`'s README documents the correct flow.

#### H2. `helpdesk-cloudflare` `vite-env.d.ts` declares the wrong VITE_ var — **HIGH**

Declares `VITE_HELPDESK_SECRET`. `src/web/client.ts:12` reads
`import.meta.env.VITE_SHARED_SECRET`. The typed accessor is
`undefined`; the client falls back to the literal
`"dev-shared-secret"`; any user trying to override silently
fails.

**Fix:** Use `VITE_SHARED_SECRET` in both. Add a one-line
comment in `.dev.vars.example`/`.env.example` documenting it.

#### H3. Every template's `pnpm test` script will fail — **HIGH**

(Cross-reference existing item #12; restated for completeness.)
All four scaffoldable templates declare `"test": "vitest run"`
without `vitest` in devDeps.

**Fix:** Drop the script, OR add `vitest` + a one-test
`smoke.test.ts` (round-trip the client against `LocalFsStorage`
or R2 binding). The latter is much higher value at scaffold time.

#### H4. `helpdesk/apps/` is empty stale scaffolder ceremony — **MEDIUM**

`examples/helpdesk/apps/server/` and `apps/web/` contain only
`node_modules` and untracked `dist/`. The flatten landed; the
`apps/` layout is dead. Anyone reading helpdesk wonders if
`apps/` belongs.

**Fix:** `rm -rf examples/helpdesk/apps/`. Add to `.gitignore`
(see H6).

#### H5. `helpdesk/.baerly-data/` is committed but seed lives in a Vite plugin — **MEDIUM**

14 JSON files of helpdesk-demo manifest/log/content checked
into git. `baerlyDev` calls `seedTickets` on every dev start —
data is ephemeral. `pnpm reset` literally `rm -rf .baerly-data`
proves the project considers it disposable.

**Fix:** Add `.baerly-data/` to a new `examples/helpdesk/.gitignore`.
`git rm -r examples/helpdesk/.baerly-data/`.

#### H6. `examples/helpdesk/` has no `.gitignore` at all — **MEDIUM**

Every other example has one. Helpdesk doesn't — `apps/` and
`.baerly-data/` churn every time someone runs `pnpm dev`.

**Fix:** Add `.gitignore`: `node_modules`, `dist`,
`.baerly-data`, `.env`, `.DS_Store`, `*.tsbuildinfo`.

#### H7. `examples/helpdesk/` largely duplicates `helpdesk-cloudflare` — **MEDIUM**

`App.tsx`, `main.tsx`, `TicketList.tsx`, `TicketDetail.tsx`,
`TicketForm.tsx`, `types.ts`, `client.ts` are essentially
identical to `helpdesk-cloudflare/src/web/`. Two file trees,
one app.

**Fix:** Either (a) delete `examples/helpdesk/` and replace
with a docs section, or (b) reframe as a 60-line getting-
started — drop CRUD UI duplication, keep just the seeded list
view, document `baerlyDev` + `useLiveQuery`. Pick one; today
it's neither.

#### H8. `helpdesk/scripts/dev.mjs` is a 28-line "SIGINT 130 → exit 0" hack — **MEDIUM**

Exists only to silence pnpm's `[ELIFECYCLE] Command failed.`
on Ctrl-C. Dev cosmetics, not pedagogy. A learner reading "the
canonical Node-side Baerly dev pattern" sees `dev: "node
scripts/dev.mjs"` and assumes this is required.

**Fix:** Drop `dev.mjs`. Change script to `"dev": "vite"`. Eat
the ELIFECYCLE noise or file upstream.

#### H9. Templates pin `pnpm@11.1.2` but AGENTS.md documents `pnpm@10.31.0`; Dockerfile also pins 10.31.0 — **MEDIUM**

Three locations, three versions. Existing item #9 also covers
the Dockerfile drift.

**Fix:** Standardise on `pnpm@11.1.2` (matches monorepo memory)
across `package.json:packageManager`, `AGENTS.md`, `Dockerfile`,
root CLAUDE.md.

#### H10. CF template `TENANT` wrangler var dead (cross-reference F1) — **LOW**

Both CF examples bind `"TENANT": "minimal-demo"` in
`wrangler.jsonc` but hard-code `tenantPrefix: "minimal-demo"`
literally in `src/server/index.ts`. Two-place update for one
literal.

**Fix:** Either drop `TENANT` from `wrangler.jsonc`, or wire
`env.TENANT` through `selectVerifier`.

#### H11. `minimal-cloudflare/src/server/index.ts` is 102 lines, ~70 of which are JSDoc — **LOW**

Including a commented-out `wrangler dev` landing-page snippet
(81-85). Actual logic is ~25 lines. `helpdesk-cloudflare`'s
equivalent is 61 lines — same logic, no monologue.

**Fix:** Trim to helpdesk-cloudflare shape. Long-form commentary
to `AGENTS.md`.

#### H12. `wrangler.jsonc` files are ~75 lines of identical commentary across CF templates — **LOW**

The two CF wrangler files differ only in `name` and
`bucket_name`. Sentinel substitution alone won't prevent drift
on the ~75 shared comment lines.

**Fix:** Trim per-file commentary to one or two lines pointing
at `AGENTS.md`. Wrangler tolerates minimal config — let users
see how small it can be.

#### H13. `minimal-cloudflare/src/web/main.ts` is a 4-line placeholder — **LOW**

(Plus identical placeholders in `minimal-node-railway` and
`minimal-node-docker`.) User runs `pnpm dev`, sees "Edit
src/web/main.ts to get started." No `createBaerlyClient`, no
`fetch("/v1/healthz")`, no demonstration the API actually works.

**Fix:** 15-line snippet: ping `/v1/healthz`, call
`createBaerlyClient`, insert a row, render it. Something
working beats `<p>Edit me</p>`.

#### H14. `uint8array-base64.d.ts` duplicated identically across four templates — **LOW**

Per memory `reference_uint8array_base64_shim.md`, load-bearing
and not removable yet.

**Fix:** No deletion. Add a parity check in
`scripts/add-ts-extensions.mjs` (or a new audit script)
verifying the four are byte-identical to prevent drift.

#### H15. CF templates' `scaffold.json` should `dropDevDeps: ["create-baerly"]` — **MEDIUM**

(Cross-reference existing item #11.) The README example
documents exactly this pattern but no template implements it.
`@baerly/cli` stays (`pnpm exec baerly deploy`), `create-baerly`
should drop.

**Fix:** Add `"dropDevDeps": ["create-baerly"]` to each
`.baerly/scaffold.json`.

#### H16. `.baerly/schema.lock.json` is shipped trivially empty with muddled purpose — **LOW**

Content: `{"schema_version": 1, "comment": "...", "tables": {}}`.
AGENTS.md says it's advisory ("an empty `{tables: {}}` is fine
when you supply schemas in code"). Occupies a prime `.baerly/`
slot suggesting it's load-bearing.

**Fix:** Either drop from the scaffold, or include one tiny
example entry with a one-line "remove if declaring schemas in
code" comment.

#### H17. `helpdesk-cloudflare` ships `cloudflareAccess` import dead on first run — **LOW**

Wired into `selectVerifier`; tree-shakes from the deploy, but
adds 6 unused lines + 5 lines of comment in source. Discoverable
but noisy for a "minimal" template.

**Fix:** Consider whether `minimal-cloudflare` "minimal" needs
CF Access at all — move CF Access wiring to a fenced "Upgrade
to CF Access" section in AGENTS.md. Ship `sharedSecret` only
in `src/server/index.ts`.

#### H18. `examples/README.md` minimal-node-railway/minimal-node-docker "Run it" block is stale — **LOW**

Says `BUCKET=... AWS_ACCESS_KEY_ID=... pnpm dev`. Template's
own README correctly says `pnpm dev` is creds-free (uses
`baerly dev` → `LocalFsStorage`). Catalog README didn't get
the memo.

**Fix:** Update catalog README's Node template blocks. Clarify
`pnpm dev` is creds-free; creds are for `pnpm start` / prod.

#### H19. `.gitignore` files drift across templates (4 different shapes) — **LOW**

Trailing-slash vs no-trailing-slash, base entries differ.

**Fix:** Standardise. Suggest: trailing-slash style, common
base (`node_modules/ dist/ .DS_Store *.tsbuildinfo`), per-
target extras.

#### H20. Node templates' `src/web/main.ts` is dead in the `baerly dev` flow — **LOW**

`pnpm dev` runs `baerly dev` (Node listener on `:3000` over
`LocalFsStorage`); the SPA only ships under `pnpm build && pnpm
start`. New users following the README run `pnpm dev` and
never see `src/web/`. `vite.config.ts` proxy port `8080`
doesn't match `baerly dev`'s `:3000`.

**Fix:** Either delete `src/web/`, `index.html`, `vite.config.ts`,
`tsconfig.app.json` from Node templates (drop `vite` + `@types/react`
from devDeps; go server-only), or add `pnpm dev:web` that runs
vite standalone. Today the SPA is half-shipped.

#### H21. `helpdesk-cloudflare/types.ts` imports `@baerly/protocol` not in `dependencies` — **LOW**

Resolves today only via transitive deps from `@baerly/server` +
`@baerly/client`. Phantom dependency.

**Fix:** Add `"@baerly/protocol": "workspace:*"` to
`helpdesk-cloudflare/package.json:dependencies`. Audit same in
`minimal-cloudflare/src/server/index.ts:26`.

#### H22. `minimal-node-docker/.dockerignore` allow-lists wrong dist path — **LOW**

Excludes `dist/server` (doesn't exist); does NOT exclude
`dist/client`. The Dockerfile relies on `dist/client/` being
copied via `COPY --from=build /app/dist/client dist/client`.
If a contributor adds `dist/` to `.dockerignore` (reasonable
default), the build fails.

**Fix:** Replace `dist/server` with `dist/`. Dockerfile
re-derives `dist/client` from the build stage; local `dist/`
is build noise.

#### H23. READMEs reference phantom file names (`worker.ts`, `server.ts`) — **LOW**

`minimal-cloudflare/README.md:143` mentions "the emitted
`worker.ts`" — file is `src/server/index.ts`.
`minimal-node-railway/README.md:135` mentions `server.ts` —
also `src/server/index.ts`.

**Fix:** Search-and-replace across READMEs.

#### H24. AGENTS.md "Indexes" example imports `defineConfig` from `@baerly/server` — the shipped file uses `create-baerly/config` — **MEDIUM**

Users copying the AGENTS.md example into their `baerly.config.ts`
will end up with two `defineConfig` imports with different
shapes.

**Fix:** Update AGENTS.md to consistently use
`create-baerly/config`'s `defineConfig`. (Or follow G12: move
`defineConfig` to `@baerly/server` and rewrite the shipped
config to import from there.)

#### H25. `examples/README.md` calls helpdesk both "fully-built CRUD app" and "dev-only teaching fixture" — **LOW**

Two contradictory positionings on the same page.

**Fix:** Lead with `helpdesk` as the "what does Baerly feel
like?" tour. Then "## Deployable templates" with the four
scaffoldable ones. One source of truth on what helpdesk is for.

#### H26. Node templates' `tsconfig.app.json` includes `vite.config.ts` — concerns mixed — **LOW**

`tsconfig.app.json` is the web/client project (lib DOM, types
vite/client, no node). `vite.config.ts` is a Node-side build
config.

**Fix:** Move `vite.config.ts` to the server project
(`tsconfig.server.json`/`tsconfig.worker.json`), or carve out a
`tsconfig.node.json` for tool configs.

#### H27. CF `.dev.vars.example` and Node `.env.example` are asymmetric on observability vars — **LOW**

CF's `.dev.vars.example` doesn't carry `LOG_LEVEL`/`LOG_SAMPLE`
(those live in `wrangler.jsonc:vars`). Node's `.env.example`
inlines them. Comparing Node-to-CF won't easily show "in CF,
observability lives in `vars`".

**Fix:** Add a one-line header comment to each example file
explaining the asymmetry.

### I. Contributor infrastructure — cut aggressively

The user explicitly cares less about contributor experience.
These cuts free maintainer time for DX work.

#### I1. `bench/r2-contention*` matrix is over-engineered for a one-engineer pre-1.0 — **HIGH**

`r2-contention.ts` (29k) + `r2-contention-matrix.ts` (9k) +
`r2-contention-interpret.ts` (16k) + `sigkill-child.ts` (4k)
implement a sweep-matrix → CSV → D1-D5 decision interpreter
for "should we ship on R2?" — already answered. Five sub-
scenarios. No PR runs it. The cost-model bound it validates is
already validated on every PR by `phase5-end-to-end.test.ts`'s
counting-storage proxy.

**Fix:** Keep `S2-idle` (the wire-level cost-model gate) as a
single ~200-line script. Delete the matrix, interpreter,
sigkill harness, and S2-multi/S5-compaction. ~20k+ LOC out.

#### I2. `bench/load-harness/` has 7 presets, 3 corpora, no published baseline — **HIGH**

~3k LOC of bench (`cli.ts` 19k, seven presets, MovieLens + GH
Archive calibration, manifest-cache modes, sweep matrix). Plus
three colocated tests + one at
`tests/unit/load-harness-presets.test.ts` verifying RNG
reproducibility. None is a correctness gate. No baseline
documented anywhere. Last touched in initial landing in
mid-May — has not been re-run against any code change.

**Fix:** Defer the whole tree to a post-1.0 perf branch. Delete
`tests/unit/load-harness-presets.test.ts`. If you need a
launch perf number, freeze ONE preset (`recent-first-crud`) +
ONE backend + ONE cache mode and delete the rest.

#### I3. `eval/` (3.1k LOC scaffolding eval) is one-shot launch preflight — **HIGH**

`run.mjs` (858), `score.mjs` (868), `check-acceptance.mjs`
(785), 7 prompts, 4 `eval:*` scripts. Drives Claude Code /
Codex CLI through scaffold → acceptance → score → report.
README states "first eval pass is `--app todo --trials 3`" —
explicit one-shot intent. Brings 3 integration tests + 4
fixture trees with it.

**Fix:** Run the launch preflight. Archive `eval/` to a
branch. Delete from `main`. Drops 3.1k LOC of harness + 3
integration tests + 4 fixture trees. Restore from git history
if needed post-launch.

#### I4. `tests/integration/day-one-handshake.test.ts` duplicates `manual-e2e/` — **MEDIUM**

379-line "manual deploy gate" test triple-gated by
`vitest.config.ts` glob + `describe.runIf` + env. Companion
6k-byte doc at `docs/contributing/day-one-gate.md`. Both
adapters' `manual-e2e/cloudflare/e2e.test.ts` and
`manual-e2e/node/e2e.test.ts` do the same cascade. Two parallel
"manual deploy" surfaces; one is enough.

**Fix:** Delete `day-one-handshake.test.ts` + the companion
doc + the `gate:day-one` script. Document any wall-clock budget
in `manual-e2e/README.md`.

#### I5. `tests/integration/since-options.test.ts` is 20 lines with no unique signal — **LOW**

One test asserting `createRouter({ sinceTimeoutMs:100 })`
returns within 500ms. HTTP conformance cascade already drives
`/v1/since` across four adapters.

**Fix:** Delete. If the timeout knob deserves coverage, fold
one `test()` into the cascade.

#### I6. `bench/resolve-ts.mjs` + `register-hooks.mjs` predate the `.ts`-extension lint rule — **MEDIUM**

Hook exists because "the protocol package's internal relative
imports omit file extensions." Since the May 12 refactor +
oxlint `import/extensions` rule, no extensionless relative
imports remain.

**Fix:** Drop both hook files. Change `bench:*` scripts to
plain `node bench/...`.

#### I7. `bench/compactor-loop.ts`, `bench/metrics.ts`, `bench/storage.ts`, `bench/types.ts`, `bench/toxiproxy.ts` — all R2-bench-only — **LOW**

~20k LOC consumed only by `r2-contention.ts`. Drops with I1.

**Fix:** If I1 lands, delete these too. Two parallel
`CountingStorage` proxies (`bench/storage.ts` and
`tests/fixtures/counting-storage.ts`) — keep only the test one.

#### I8. `bench/storage.test.ts` tests bench-only infrastructure — **LOW**

Picked up by `vitest.config.ts:140` glob; runs on every `pnpm
test`. The thing being tested is bench-only.

**Fix:** Delete with I1/I7.

#### I9. `tests/integration/baerly-copy-minio.test.ts` is one-assertion overhead with Minio gating — **LOW**

135 LOC asserting `find()` parity across buckets via `doCopy`
against Minio. The Minio-specific branch is already covered by
`s3-http.conformance.test.ts` + randomized cascade. The
in-process invariant ("doCopy moves bytes faithfully") would
be cheaper to test over `MemoryStorage`.

**Fix:** Rewrite over `MemoryStorage`/`LocalFsStorage`. Drop
Minio gating.

#### I10. `tests/integration/export-smoke.test.ts` requires Postgres on `:5433` for one test — **LOW**

`docker-compose.yml` Postgres exists for one test that asserts
`LogEntry` shape compiles against `pg` types. SQLite-based
smoke would deliver the same signal without containerised
Postgres.

**Fix:** Re-implement against SQLite (or in-memory). Drop
Postgres from compose. Drop `pg` + `@types/pg` from devDeps.
Drop the `test:export-smoke` script.

#### I11. `vitest.config.ts` has six CF globs that should be one directory rule — **MEDIUM**

`r2BindingConformanceGlob`, `r2BindingRandomizedGlob`,
`r2BindingTableApiGlob`, `cfWorkerTestGlob`, `cfCacheTestGlob`,
`cfHttpConformanceGlob` each hard-code one file. Every new
adapter-cloudflare test requires editing config.

**Fix:** One include glob (`packages/adapter-cloudflare/src/**/
*.test.ts` runs in `cloudflare-pool`) + one exclude from
`default`. Saves ~80 LOC.

#### I12. Coverage harness wired with no policy — **LOW**

`@vitest/coverage-v8` + `test:coverage` script + coverage block,
no thresholds, no CI gate.

**Fix:** Either commit to threshold-gated coverage + a doc, or
delete the block + the dep.

#### I13. `lefthook.yml` typecheck unscoped (cross-reference existing item #14) — **LOW**

Existing item already captures this. No new finding.

#### I14. `tests/fixtures/consistency.ts` uses `eval()` and has near-zero readers — **LOW**

`CausalSystem.check(grounding, knowledge_base)` via `eval(...)`
of stringified expressions. Imported only by
`tests/unit/consistency.test.ts`; re-exported from
`randomized-cascade.ts` but the runtime path uses a different
checker per "Leaving consistency.ts untouched."

**Fix:** Verify the cascade doesn't consume the `eval()`-based
checker. If only `consistency.test.ts` uses it, inline the
helpers there.

#### I15. `manual-e2e/fixtures/s3-key-escaping/` — six empty files of UX cargo — **LOW**

Six zero-byte hostile-key files + a README. No test
references them. Last touch was a refactor that moved them
under `manual-e2e/` without re-evaluation.

**Fix:** Move to `docs/spec/fixtures/` or delete entirely. The
randomized cascade already arbitraries-covers hostile keys.

#### I16. `phase5-crash-fuzz.test.ts` and `index-crash-fuzz.test.ts` overlap on `abortingStorage` — **LOW**

Same fixture, different scopes (writer/compactor/gc vs index
emission). Only the first is named `test:fuzz-phase5` in
scripts; the other runs as part of default `pnpm test`. Two
different gating models.

**Fix:** Confirm scope is non-overlapping. Rename for clarity
(`test:fuzz-maint` vs `test:fuzz-index`) so the maintenance/
index split is legible.

#### I17. `examples/*/smoke.test.ts` glob picks up only `helpdesk/smoke.test.ts` — **LOW**

`vitest.config.ts:135` includes `examples/*/smoke.test.ts` in
the default project. Only `examples/helpdesk/smoke.test.ts`
exists; the four scaffoldable templates don't have one.

**Fix:** Either remove the glob or ensure every template has
a smoke test (see H3 — folding both decisions together).

#### I18. `docs/contributing/day-one-gate.md` (6k) duplicates `manual-e2e/README.md` (11k) — **LOW**

Two manual-deploy walkthroughs covering the same
scaffold-deploy-roundtrip flow.

**Fix:** Collapse with I4. One canonical "manual deploy
verification" doc.

#### I19. `scripts/add-ts-extensions.mjs` is the right tool but not wired into `verify` — **LOW**

Script enforces a hard project invariant (CLAUDE.md anti-pattern
list) but isn't in `pnpm verify`. Oxlint's `import/extensions`
covers most cases; the script audits paths oxlint doesn't
(root configs, scripts).

**Fix:** Wire `node scripts/add-ts-extensions.mjs --check` into
`pnpm verify`, OR delete the script and trust oxlint.

#### I20. Coverage / load-harness / extract-bench-calibration / fetch-bench-fixtures — drop with I1-I3 — **LOW**

`scripts/extract-bench-calibration.ts` +
`scripts/fetch-bench-fixtures.sh` exist only to feed the load
harness. Calibration.json is already checked in; scripts only
re-run on corpora refresh (which is fixed-date by design).

**Fix:** Delete with I2.

---

## Summary

**Cuts available (rough order of magnitude):**

- **Examples + templates (H section):** ~500 LOC of stale READMEs, dead `apps/`, committed seed data, drift hacks, duplicate AGENTS.md. The user's first impression — fix first.
- **Public surface (A section):** ~50 internal symbols off the top-level barrel. The `JSONArraylessObject` → `BaerlyDocument` rename. `_raw` away from the class `@example`. README + `llms.txt` rewritten.
- **Server kernel (B section):** ~600 LOC across duplicated log-fold loops, dead `IndexWalkPlan.postFilter`, redundant query validation, dead defensive checks. `migrate.ts` (255 LOC) out of the kernel.
- **Server periphery (C section):** Mode-A/B router branching gone. Three maintenance profiles → one. Observability subpath collapsed. ~400 LOC.
- **Protocol kernel (D section):** Five dead modules (`o-map`, `time.ts:adjustClock`, `hashing` b64 helpers, `json.ts:diff/fold/clone`, dead `coordination` claimWriter). Brand types pruned. `predicate.ts` split for legibility. ~800 LOC.
- **Client + React (E section):** `order()` either fixed or deleted; `replace()` either fixed or deleted; `count()` either fixed or deleted. `BaerlyClientError` collapsed into `BaerlyError`. Hook surface tightened.
- **Adapters + dev + export (F section):** `@baerly/export` collapsed into the CLI (~2000 LOC + a public package gone). LIST-URL cache index dropped (~150 LOC). Adapter observability ceremony lifted to a shared helper.
- **CLI (G section):** `@baerly/cli` library exports deleted. `cost/` subtree deleted. `copy` moved to admin. Top-level help trimmed to 7 verbs. ~700 LOC.
- **Contributor infra (I section):** ~8k LOC of bench + 3k LOC of eval + 500 LOC of redundant tests/configs. ~12k total LOC out without losing a single correctness gate.

**Total realistic cut:** 15-25k LOC, plus a major DX cleanup of the public surface. Roughly halves the touchable codebase for the maintainer while making the library easier for users and agents to understand zero-shot.

**Recommended order:**

1. **Public surface (A1-A4, A10, A12)** — first impression for every user and agent. Days, not weeks.
2. **Templates (H1, H2, H3)** — broken-on-day-1 bugs.
3. **Contributor infra cuts (I1-I3)** — frees the most maintainer time per hour spent.
4. **Server + client correctness gaps (B1, E1-E3)** — silent-lie bugs masquerading as features.
5. **Everything else, by area, in any order.**
