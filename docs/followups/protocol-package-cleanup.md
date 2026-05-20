# Followups: `@baerly/protocol` package cleanup

**Source: 2026-05-19 analyst triage (D-series).** Verified
against current state. D6 deferred by analyst (couple with
publish direction). D14 dropped — ifNoneMatch:"*" claim not
found; the `versionId`-on-`get` half is folded into D15.
D12 line count corrected (1226, not 1086).

The protocol package is documented as "Internal protocol
kernel — implementation detail of @baerly/server. Not a public
API." But examples + tests import from it heavily (167 grep
hits — see `publish-direction.md`). Cleaning the inside of the
package is decoupled from that strategic question; do these
first.

---

## File / module shape

### D1. `protocol/db.ts` exports `Table`/`Query`/`Predicate` — no `Db` class

**Severity: HIGH. Grep + LLM navigation landmine.**

Two packages have a `db.ts` (`packages/server/src/db.ts` defines
the `Db` class; `packages/protocol/src/db.ts:14,99,124` defines
`Table`/`Query`/`Predicate` types). An LLM reading the kernel
expects `db.ts` to define `Db`.

**Fix:** Rename `packages/protocol/src/db.ts` → `table-api.ts`
or move into `query/` next to `predicate.ts`. Update internal
imports. Public consumers (via `baerly-storage` re-exports)
are unaffected.

### D15. `S3HttpStorage` lives in `@baerly/protocol` despite the adapter pattern

**Severity: MEDIUM. 436 LoC of concrete S3+retry in the pure
kernel.**

`packages/protocol/src/storage/s3-http.ts:171` is 436 lines of
S3 protocol engine. `@baerly/adapter-node/index.ts:69` already
re-exports it — that's the user-facing entry. Asymmetric with
`@baerly/adapter-cloudflare`'s `r2-binding-storage.ts` living
in its own package.

**Fix:** Move `s3-http.ts` to `packages/adapter-node/src/`.
Keep protocol as pure-interface + `MemoryStorage`. Update
re-exports. Watch for: bench/, manual-e2e/, conformance test
imports — these need their paths updated.

While moving, also relocate the `versionId`-on-`Storage.get`
parameter: per the analyst, it's declared on the interface but
never set on production paths. Consider whether the param can
be dropped from `Storage.get` entirely.

### D17. `metrics.ts:InMemoryMetricsRecorder` is observability harness in the kernel

**Severity: LOW.**

`packages/protocol/src/metrics.ts:132` is a 50-line "memory-
grows-unbounded — not suitable for production" recorder sitting
next to the load-bearing `MetricsRecorder` interface.

**Fix:** Move `InMemoryMetricsRecorder` to
`@baerly/server/observability`. Keep `MetricsRecorder` (the
interface) + `noopMetricsRecorder` + `teeMetricsRecorders` in
protocol.

### D16. `conformance.ts` imports vitest at module top

**Severity: LOW. Cross-runtime risk.**

`packages/protocol/src/storage/conformance.ts:1` does
`import { fc, test as fcTest } from "@fast-check/vitest"` + a
vitest import. Loaded via subpath `./conformance`; careless
`import *` would drag vitest into Workerd.

**Fix:** Either move to a dedicated `@baerly/test-storage`
package, or rewrite the package description to acknowledge the
test-only subpath + verify the package.json `exports` doesn't
expose it on the default entry.

### D20. R2-free-tier constants belong in the CLI, not the protocol kernel

**Severity: LOW. Wrong-package home for pricing literals.**

`packages/protocol/src/constants.ts:227,237,251` declares
`R2_FREE_TIER_CLASS_A_OPS_PER_MONTH`,
`R2_FREE_TIER_CLASS_B_OPS_PER_MONTH`,
`R2_FREE_TIER_STORAGE_GB_PER_MONTH`. These drift when
Cloudflare changes rate sheets.

**Fix:** Move to `@baerly/cli` (likely `packages/cli/src/cost/`
which already maintains pricing tables — see `cli-cleanup.md`
§G3 for the strategic question about that subtree).

Keep `STORAGE_OPS_PER_LOGICAL_WRITE = 3` in protocol — that's
a real cost-model invariant, not a pricing literal.

---

## Types + interface ergonomics

### D8, D9. ~~Brand types + pre-collections-era types~~

**Shipped 2026-05-19.** `ManifestKey`, `S3VersionId`,
`VersionId` (union), `versionFromUuid` deleted; `ContentVersionId`
kept (load-bearing as `versionFromContent` return type). All
seven pre-collections symbols (`Ref`, `ResolvedRef`, `eq`, `url`,
`resolveContentRef`, `resolveManifestRef`, `DeleteValue`) deleted.
Base32 utils (`countKey`/`uint2strDesc`/`str2uintDesc`) kept on
`@baerly/protocol` barrel — that package is described as internal
and the helpers are real internal protocol primitives.

### D13. `Predicate<T>` index signature defeats key narrowing

**Severity: MEDIUM. Real type-safety hole.**

`packages/protocol/src/table-api.ts:99-103`:
```ts
{ readonly [K in keyof T]?: … } & { readonly [dottedPath: string]: … }
```

The string index signature dominates: any `keyof T` narrowing
is lost; `{ wrongField: "x" }` typechecks against any predicate.

**Fix:** Drop the string index signature; require dotted paths
via an explicit sub-key (e.g.
`where({...}, { dotted: {...} })`) or a separate helper. Trades
minor ergonomics for actual type safety on field names — the
brand-types philosophy in the project says this matters.

### D11. `verifier.ts` JSDoc describes semantics protocol can't enforce

**Severity: MEDIUM. Wall of server-side semantics on a kernel type.**

`packages/protocol/src/verifier.ts:2-32` JSDoc tells callers
about "scope check (403)" + "`Db` construction" — both live in
`@baerly/server`, not the kernel. An LLM reading the kernel's
`.d.ts` for `Verifier` gets a wall of context that doesn't
apply to the type itself.

**Fix:** Trim to the kernel-visible contract: `tenantPrefix`
non-empty + no `/`; `identity` opaque. Move dispatcher
semantics to `@baerly/server` (the auth helpers' JSDoc or a
section in `docs/guide/`).

---

## Module size + structure

### D12. `predicate.ts` (1226 lines) packs three independent algebras

**Severity: MEDIUM. Diff blast-radius problem.**

`packages/protocol/src/predicate.ts` is **1226 lines** (analyst
said 1086 — slightly off). Three independent things:
- `validatePredicate` + helpers (~330 lines)
- `matches` evaluator (~130 lines)
- `mergePredicates` + `predicateImplies` (~600 lines — two
  algebra engines)

`predicateImplies` is planner-only — verified called only by
`packages/server/src/query-planner.ts:362,440`. Nothing else in
the codebase uses it.

**Fix:** Split into `query/validate.ts`, `query/matches.ts`,
`query/merge.ts`. Move `predicateImplies` into
`@baerly/server/query-planner.ts` (planner-only consumer).
Reduces per-change diff blast-radius and lets the kernel
package shrink.

### D10. `xml.ts` parser ships 80% dead-commented S3 fields

**Severity: LOW.**

`packages/protocol/src/xml.ts:36-50` has ~11 commented-out
`IsTruncated`, `Name`, `Prefix`, `Delimiter`, `MaxKeys`,
`CommonPrefixes`, `EncodingType`, `Owner`, `Size`,
`StorageClass` lines. Actually-consumed fields:
`Contents.{ETag,Key,LastModified}` + `NextContinuationToken`.

**Fix:** Strip the dead comments. Drop the 4 unused fields
from `ParsedListObjectsV2Output`. Move `XmlParser`/`XmlNode`
into `xml.ts` (currently re-exported from `types.ts`).

### D18. `lsnParts` exists for a use case the lsn JSDoc forbids

**Severity: LOW. Contradiction in the public surface.**

`packages/protocol/src/log.ts:30` `LogEntry.lsn` JSDoc:
"**do not parse it** — use the `session` / `seq` fields below."
But `lsnParts(lsn)` is exported (`log.ts:149`) and used by
`packages/protocol/src/storage/since.ts:277` to recover `seq`.

**Fix:** Either:
- Delete `lsnParts` and have `since.ts` use `LogEntry.seq`
  directly (preferred — JSDoc stays accurate).
- Or soften the JSDoc to "prefer the structured fields, but
  `lsnParts` is the kernel-blessed parser if you must."

Pick the first unless there's a reason `since.ts` can't reach
`LogEntry.seq` directly.

### D19. `parseRetryAfter` exported but only its own file consumes it

**Severity: LOW.**

`packages/protocol/src/storage/s3-http.ts:49` exports
`parseRetryAfter`. Only internal references: lines 79, 377, 498
(test). No external callers.

**Fix:** Drop the `export` keyword. Tests can import via the
relative path (or move test fixtures into the same module).
