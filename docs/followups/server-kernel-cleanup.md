# Followups: `@baerly/server` kernel cleanup

**Source: 2026-05-19 analyst triage (A4, B-series).** Verified
against current state. Dropped or rescoped:
- **B5** (defensive `undefined` spreads) — grep returns 0 hits;
  analyst was wrong.
- **B14** (SingleAttemptOutcome 350-line split) — actual is a
  9-line discriminated union; overstated.
- **B23** (`IN_FANOUT_PARALLELISM`) — constant not found; only
  half of the claim is real (the `THRESHOLD` exposure question).

Items I haven't grep-verified line-for-line are tagged
**[needs-verify]** — the worker picks them up and confirms
before editing. Per project memory, this brief had ~70%
file:line accuracy; verifying first is cheaper than rolling
back.

The kernel barrel (`packages/server/src/index.ts`) and the
writer/query/planner triangle are the load-bearing surface.
Cleanups here pay back across every downstream package.

---

## Barrel + module-level

### A4. Top-level barrel re-exports ~40 internal symbols

**Severity: HIGH. Public-surface bloat.**

`packages/server/src/index.ts` currently exports ~40 named
symbols including compactor, GC, HTTP internals, index helpers,
admin verbs — many marked `@internal` and re-exported anyway.

The 2026-05-18 bundle-trim moved maintenance + observability
to subpath entries; this is the next pass.

**Fix:** Reduce the top-level barrel to ~10 symbols:
- `Db`, `defineConfig`, `BaerlyConfig`, `CollectionDefinition`
- `BaerlyError`, `BaerlyErrorCode`
- `Table`, `Query`, `Verifier`, `Storage`
- `MemoryStorage`, `SchemaValidator`, `SchemaIssue`

Move admin verbs (`compact`, `runGc`, `rebuildIndex`,
`migrateCollection`, `claimWriter`) behind
`baerly-storage/admin`. Drop the `@internal` re-exports —
`http/router.ts` and `http/since.ts` can import them directly
within-package.

### B22. Move `migrate.ts` off the kernel barrel

**Severity: LOW. Not a deletion — an admin-subpath relocation.**

`packages/server/src/migrate.ts` (~255 LoC) implements
`migrateCollection`. Sole non-test caller is
`baerly admin migrate` via the public re-export at
`packages/server/src/index.ts:58`.

**Fix:** Move to a subpath entry (e.g.
`@baerly/server/migrate` or fold into `baerly-storage/admin`).
Update CLI import + any bundle-size budget assertion.

---

## Query / planner

### B2. `runFirstWithMeta` is a redundant alias of `runAllWithMeta`

**Severity: MEDIUM. Two near-identical functions.**

`packages/server/src/query.ts:304` `runFirstWithMeta` calls
`runRead` with `limit:1` and picks `rows[0]`. The router (sole
production caller) could pass `{ ...state, limit: 1 }` to
`runAllWithMeta:326` and pick `rows[0]`.

Both shims re-run `validatePredicate` even though `makeQuery`
already validated (see B3).

**Fix:** Delete `runFirstWithMeta`; have the router call
`runAllWithMeta` with limit 1.

### B3. Predicate validated 3× per call **[needs-verify]**

**Severity: LOW. Wasted work, no correctness gap.**

Analyst claim: `makeQuery` validates on entry; `.where()`
validates `p` before merge then calls `makeQuery` (re-validate);
`runFirstWithMeta`/`runAllWithMeta` validate yet again.

**Fix:** Validate exactly once at predicate construction (in
`.where()` and the router's predicate parser). Drop the
re-validations in the query-runner shims.

Verify before action: read the three call sites; the predicate
algebra is non-trivial and a missed validation could hide a
real input bug.

### B10 / B11. `IndexWalkPlan.postFilter` is dead

**Severity: LOW. Bookkeeping for a value nothing reads.**

Planner builds `postFilter` (residue of unconsumed predicate
keys at `query-planner.ts:474-506`). Executor at `query.ts`
re-applies the *full* original predicate (the "simpler
invariant" per JSDoc) — `postFilter` is never read.

`Candidate.consumed` / `consumedSet` exist only to compute
`postFilter`.

**Fix:**
- Drop `postFilter` from `IndexWalkPlan` (B10).
- Drop the residue-build + `consumed`/`consumedSet`
  bookkeeping in the planner (B11).
- Verify by re-running planner tests; coverage that depends on
  inspecting `postFilter` shape needs to be rewritten to assert
  on plan kind + observed behavior.

### B12. `FullScanPlan.reason` diagnostic with no consumer **[needs-verify]**

**Severity: LOW.**

Analyst claim: planner populates a `reason` discriminant at
four branches; JSDoc says "diagnostic — not part of the public
API"; only planner unit tests inspect it.

**Fix:** Return `{ kind: "full-scan" }` literal; replace
planner-test path coverage with a path-counter helper.

### B13. `tryExtractEq` / `tryExtractRange` / `tryExtractIn` triplicate op-key dispatch **[needs-verify]**

**Severity: LOW. Per-predicate overhead.**

Analyst claim: three helpers each call `Object.keys(op)`. The
partition loop then calls all three in sequence falling through
on `undefined`.

**Fix:** Single dispatch on op-key — one pass over
`Object.entries(op)` could populate all three maps. Halves
per-predicate-key cost.

### B9. `runIndexWalkPlan` reloads snapshot + log even though `runRead` did **[needs-verify]**

**Severity: MEDIUM. Two loads + two walks per index-walk read.**

Analyst claim: `runRead` reads `current.json` + snapshot + log;
then `runIndexWalkPlan` re-loads `head.snapshot` and re-walks
`[log_seq_start, next_seq)` from scratch to resolve docIds.

**Fix:** Restructure: load snapshot + log walk once at the top
of `runRead`, then branch on `plan.kind`. Halves read latency
on index-walks (worth measuring on the load harness if it's
unparked).

### B8. Log-fold loop duplicated four times **[needs-verify]**

**Severity: MEDIUM.**

Analyst claim: same "fold log entries onto `Map<docId, body>`
switching on I/U/D, ignoring T/M" loop in:
- `query.ts:743-762` (full-scan)
- `query.ts:978-998` (index-walk)
- `migrate.ts:163-178`
- `rebuild-index.ts:193-218`

Three include manual `JSON.parse(new TextDecoder().decode(...))`.
`rebuild-index.ts` re-implements its own sequential GET loop
instead of using `walkLogRange`.

**Fix:** Extract `foldLogEntriesOnto(map, entries, collection)`
to `log-walk.ts`. Switch `rebuild-index.ts` to `walkLogRange`.
Worth doing — protocol invariants (which entries to apply,
which to ignore) only need to be right in one place.

---

## Writer

### B4. `Db.transaction` re-implements `tableReadContext` (30-line copy)

**Severity: MEDIUM.**

`packages/server/src/db.ts:504` `transaction` mirrors
`db.ts:435` `tableReadContext` near-verbatim:
`currentJsonCache` lookup-or-allocate, `#schemas.get`,
`#indexes.get ?? EMPTY_INDEX_ARRAY`, `tablePrefix` build,
optional spreads.

**Fix:** Have `Db.transaction` call `this.tableReadContext(table)`
then build `makeTable({ ...ctx, txCtx })`. Deletes ~30 lines.

### B15. `isPreconditionFailed` and `isCasConflict` are the same function

**Severity: LOW.**

`packages/server/src/server-writer.ts:943` `isPreconditionFailed`;
line 951 `isCasConflict` is a same-named alias. The JSDoc
comment "kept as a separate predicate for call-site clarity"
doesn't justify a real function.

**Fix:** Delete `isCasConflict`. Replace call sites with
`isPreconditionFailed`.

### B16. `validateInput` checks impossible op/body combinations

**Severity: LOW.**

`packages/server/src/server-writer.ts:902` `validateInput`
checks `op === "D" && body !== undefined` and the inverse.
`CommitInput` is typed; every production caller (`query.ts`,
`db.ts`) builds the right shape from typed verbs. Writer
inputs are internal — these aren't system boundaries.

**Fix:** Delete `validateInput`.

### B18. Wire `ServerWriter.options.tenant` (or drop the metric label)

**Severity: LOW. Half-wired observability.**

`ServerWriter.options.tenant` (constructor `server-writer.ts:292`)
labels the writer's metric emissions
(`db.tenant.put_rate`, `db.tenant.commit_latency`). Every
production `new ServerWriter` callsite omits it; only tests pass
it. Both adapters already compute `tenantPrefix` at the request
boundary but don't thread it through to the writer.

**Fix:** Either wire `tenantPrefix` → `ServerWriter.tenant` in
both adapters and the `Db` transaction path, or drop the
labelled metric variants. Don't leave it half-wired.

### B14. Collapse the commit-attempt union **[scope reduced]**

**Severity: LOW. Brief overstated this one.**

The brief described `SingleAttemptOutcome` as "splitting one
logical operation across 350 lines." Actual: a 9-line
discriminated union (`server-writer.ts:250-259`). The
`commit` / `commitBatch` shared body is real but the line-count
framing was wrong.

Still worth a smaller pass:

**Fix:** Collapse to one body parameterised by
`maxAttempts: 1 | 8` and the adoption flag. Drop the
`SingleAttemptOutcome` union; throw `Conflict` directly and let
the loop catch. Verify the only behavioural fork
(`adoptOwnSessionOnLogConflict`) is properly preserved.

---

## Naming + sentinels

### B24. Rename `ServerWriter` → `Writer`

**Severity: LOW. Naming drift.**

Class is `ServerWriter`; variables are `writer`; specs and
JSDoc switch between "the writer," "Writer," and "ServerWriter."
The `@baerly/server` package context makes "Server" redundant.

**Fix:** Rename → `Writer`. Update all references.

While there, consider merging `commit` and `commitBatch` into
`commit(inputs: CommitInput | readonly CommitInput[])` — drops
one of the two surfaces consumers have to learn.

### B6. Empty-collection sentinels are theatre

**Severity: LOW.**

`packages/server/src/db.ts:87-98` defines `EMPTY_SCHEMA_MAP` /
`EMPTY_INDEX_MAP` / `EMPTY_INDEX_ARRAY` with comments saying
they're "frozen so accidental `.set(...)` throws." They aren't
`Object.frozen`; they're typed `ReadonlyMap` / `ReadonlyArray`
(type-level only, runtime can mutate).

**Fix:** Inline `?? new Map()` / `?? []` at call sites. Drop
the three constants + the misleading comment.

### B7. `Object.freeze({ ...state })` in `makeQuery` **[needs-verify]**

**Severity: LOW.**

Analyst claim: `query.ts:258` freezes a fresh-spread object.
Every modifier already passes a fresh spread; the freeze
catches nothing. Shallow freeze doesn't even protect nested
predicate/order objects.

**Fix:** Drop the freeze.

---

## Knob exposure

### B23. `IN_FANOUT_THRESHOLD` — pick "configurable" or "constant"

**Severity: LOW. Scope reduced — brief had the partner wrong.**

`IN_FANOUT_THRESHOLD` is `Db.create`-overridable with 6 lines
of validation in `db.ts:211` + JSDoc. Brief framed this as
asymmetric with `IN_FANOUT_PARALLELISM`, but the latter
constant **doesn't exist** anywhere in the codebase (verified).

So the question is: keep `IN_FANOUT_THRESHOLD` configurable, or
hard-code 50?

**Fix:** Drop `inFanoutThreshold` from `Db.create`. Hard-code.
Simplify the constructor and `TableReadContext`. If users hit
it pre-launch, they file a bug — the answer to bug reports is
"good, let's tune the default."

If the brief author was thinking of a related parallelism knob
that's now an arg-pass-through, that's a different ticket.

---

## Dropped (invalid)

- **B5** — defensive `...(x !== undefined ? { x } : {})`
  spreads. Grep across `packages/server/src/` finds zero
  matches. Either was cleaned up already, or the analyst saw
  it in a different package.
