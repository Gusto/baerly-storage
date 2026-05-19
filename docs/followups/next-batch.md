# Next-batch followups (triage in progress)

This file holds analyst-surfaced findings still pending triage.
Validated findings are extracted to their own per-topic docs in
this folder; invalid / stale items are removed entirely.

---

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

---

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

#### A3. README "Quick start" can't be followed — **HIGH**

The "Quick start" block admits `pnpm dlx create-baerly@latest`
"doesn't resolve end-to-end" and tells users to clone and run
inside the workspace. The "Or wire it by hand" snippet imports
`createListener` from `@baerly/adapter-node`, `sharedSecret`
from `@baerly/server/auth`, `LocalFsStorage` + `ensureTable`
from `@baerly/dev` — three workspace packages a user can't
install from npm. This is the user-facing face of the
package-name schism; resolve them together.

**Fix:** Either land the publishes before the README ships, or
mark the README as preview and replace the snippets with the
one path that *works today*.

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

#### B18. Wire `ServerWriter.options.tenant` (or drop the metric label) — **LOW**

The `tenant` option exists in `ServerWriterOptions` and labels
the writer's metric emissions (`db.tenant.put_rate`,
`db.tenant.commit_latency`). Every production `new ServerWriter`
callsite (`query.ts:339`, `db.ts:530`, `cli/src/admin/restore.ts:208`)
omits it; only tests pass it. Both adapters already compute
`tenantPrefix` at the request boundary
(`adapter-node/src/server.ts:278`,
`adapter-cloudflare/src/worker.ts:331`) but don't thread it
through to the writer.

**Fix:** Either wire `tenantPrefix` → `ServerWriter.tenant` in
both adapters and the `Db` transaction path, or drop the
labelled metric variants. Don't leave it half-wired.

#### B22. Move `migrate.ts` off the kernel barrel — **LOW**

`packages/server/src/migrate.ts` (255 LoC) implements
`migrateCollection`. Sole non-test caller is `baerly admin
migrate` via the public re-export at
`packages/server/src/index.ts:51`. The function is part of the
documented operator surface, not dead code.

**Fix:** Move to a subpath entry (e.g. `@baerly/server/migrate`)
consistent with the bundle-trim pattern that moved maintenance +
observability off the kernel barrel. Update the CLI's import
and any bundle-size budget assertion. **Not a deletion.**

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

### D. Protocol kernel

#### D1. `protocol/db.ts` exports `Table`/`Query`/`Predicate` — no `Db` class — **HIGH**

Both packages have a `db.ts`; only the server's contains a
`Db` class. The same filename in two packages with different
concepts is a navigation/grep landmine. An LLM expects
`db.ts` to define `Db`.

**Fix:** Rename `packages/protocol/src/db.ts` → `table-api.ts`
or move into `query/` next to `predicate.ts`.

#### D6. `claimWriter` + `WriterFence.lease_until` are reserved-for-future — **MEDIUM**

`packages/protocol/src/coordination/current-json.ts:315`
implements `claimWriter` (~95 LoC two-CAS-round-trip).
`WriterFence.lease_until` (L162-168) is documented "Reserved for
future manual rotation workflows; current code only writes the
field through if a caller supplies it and does not read it."
Zero production read consumers; `claimWriter` is re-exported
from `packages/server/src/index.ts:120` as documented public API
("Reserved for admin rotation workflows and initial provisioning").
`epoch` is the safety-load-bearing field
(`server-writer.ts:502,869,875`) and must stay.

**Fix:** Defer. Deletion is a public-API surface change; couple
with the package-publish decision. If kept, leave the tests
that pin the CAS round-trip contract.

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

#### I14. `tests/fixtures/consistency.ts` uses `eval()` and has near-zero readers — **LOW**

`CausalSystem.check(grounding, knowledge_base)` via `eval(...)`
of stringified expressions. Imported only by
`tests/unit/consistency.test.ts`; re-exported from
`randomized-cascade.ts` but the runtime path uses a different
checker per "Leaving consistency.ts untouched."

**Fix:** Verify the cascade doesn't consume the `eval()`-based
checker. If only `consistency.test.ts` uses it, inline the
helpers there.

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

#### I20. Coverage / load-harness / extract-bench-calibration / fetch-bench-fixtures — drop with I1-I3 — **LOW**

`scripts/extract-bench-calibration.ts` +
`scripts/fetch-bench-fixtures.sh` exist only to feed the load
harness. Calibration.json is already checked in; scripts only
re-run on corpora refresh (which is fixed-date by design).

**Fix:** Delete with I2.
