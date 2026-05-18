# Fix: production writes never emit index entries

**Severity: HIGH — silent correctness bug. Fix before launch.**

The writer-side index-emission block in `ServerWriter` is correct
and well-tested in isolation, but the production write path
(`Db.create({ indexes })` → `db.table().insert()` / `db.transaction(...)`)
never threads `indexes` into the `ServerWriter`. Result: a user
who declares an index gets a *write* path that never emits the
index, while the *read* path queries an index that's never
populated. Reads miss rows that "exist" in the materialised
view.

The documented contract is false today
([docs/contributing/extending.md:331](../contributing/extending.md)):

> "The writer emits forward entries on every commit; pre-existing
> rows are not back-projected until rebuild runs."

Today, *no* rows are forward-emitted from the production write
path. Only `baerly admin rebuild-index` populates the index keys.

## Root cause

`ServerWriterOptions.indexes` is the only entry point for
writer-side emission (`packages/server/src/server-writer.ts:316-318, 593`):

```ts
const indexes = opts.options?.indexes ?? [];
…
if (this.#indexes.length > 0) { /* emit / diff / delete */ }
```

Every production `new ServerWriter(...)` callsite omits
`indexes`:

| Callsite | What is passed | What is missing |
|---|---|---|
| `packages/server/src/query.ts:338-343` (`writerFor`, used by all CRUD verbs on `db.table(...)`) | `metrics`, `currentJsonKey` | `indexes` — `ctx.indexes` is on the read context but never spread into `options` |
| `packages/server/src/db.ts:530-534` (`Db.transaction` batch writer) | `metrics`, `currentJsonKey` | `indexes` — `this.#indexes` exists at `:200, :223` but is not passed |
| `packages/cli/src/admin/restore.ts:208` | (none) | OK to omit — rebuild is expected after restore |

The writer-side machinery exists, is correct, and is heavily
tested. The tests reach it by constructing `new ServerWriter({
options: { indexes } })` *directly*, bypassing `Db`. So tests
pass while production silently degrades.

A code comment at `packages/server/src/query.test.ts:1300-1304`
already documents the gap (probably the author's TODO note):

```ts
// Writes go through `ServerWriter` with `options.indexes` directly
// because `Db.create({ indexes })` only threads to the planner,
// not to the writer's per-commit index emission ...
```

## Git context

The split is historical, not deliberate.

- `b0d5c14` (2026-05-12, *feat(server): emit secondary-index PUTs
  under the same CAS fence*) added writer-side emission via
  `ServerWriterOptions.indexes`. Did not touch `db.ts` / `query.ts`.
- `191ca48` (2026-05-13, *feat(server,protocol,client): introduce
  query-planner, composite-index reads*) added `indexes` to
  `Db.create`, `TableReadContext`, and the transaction-path read
  ctx — but only for the read planner. The diff threads
  `indexes:` into read-side context spreads at `db.ts:416, :500`
  and never touches the two `new ServerWriter(...)` callsites.
- `git log -S "options: { indexes" -- packages/server/src/` is
  empty — the wiring was never closed.

## Fix

Three concrete edits + one regression test.

### 1. Thread `ctx.indexes` in `query.ts:writerFor`

`packages/server/src/query.ts:338-343`:

```ts
const writerFor = (ctx: TableReadContext): ServerWriter =>
  new ServerWriter({
    storage: ctx.storage,
    currentJsonKey: `${ctx.tablePrefix}/current.json`,
    options: {
      ...(ctx.metrics !== undefined ? { metrics: ctx.metrics } : {}),
      indexes: ctx.indexes,
    },
  });
```

### 2. Thread `this.#indexes` in `Db.transaction`

`packages/server/src/db.ts:530-534`:

```ts
const writer = new ServerWriter({
  storage: this.#storage,
  currentJsonKey: `${tablePrefix}/current.json`,
  options: {
    metrics: this.#metrics,
    indexes: this.#indexes.get(table) ?? EMPTY_INDEX_ARRAY,
  },
});
```

(Or inline if EMPTY_INDEX_ARRAY is removed per B6 — keep the
default-empty-array semantic either way.)

### 3. Delete or fix the acknowledged-gap comment

`packages/server/src/query.test.ts:1300-1304`'s explanation
becomes stale. Either delete it (if the test is rewritten to go
through `Db.create`), or pin the comment to the new test's
location.

### 4. Add an end-to-end regression test

Place in `tests/integration/randomized.test.ts` or a new
`tests/integration/index-emission-e2e.test.ts`:

- Construct `Db.create({ indexes: { collection: [indexDef] } })`.
- `await db.table(collection).insert({ ... })`.
- `await db.transaction(...)` that touches the same collection.
- Assert: the index-prefix key set under
  `tablePrefix/_index/<indexName>/...` matches
  `allIndexKeysFor(indexDef, row)` for each inserted/updated/deleted
  row.

The existing emission tests construct `ServerWriter` directly
and don't exercise the production wiring; without this test the
gap can reopen.

## Out of scope

- The rebuild path (`baerly admin rebuild-index` and `rebuildIndex`)
  is correct as-is. Don't touch.
- Index-planner reads (B9, B10, B11) are separate concerns; this
  fix doesn't depend on them.
- Whether `inFanoutThreshold` should be a public knob (B23) is
  unrelated.

## Verification

After the fix:

1. `pnpm test` — all existing tests pass.
2. New regression test passes.
3. `pnpm test:randomize FC_NUM_RUNS=2000` — confirm property
   coverage on the wired path.
4. Run `baerly admin rebuild-index` on a small fresh fixture
   *after* doing 100 mixed writes — assert the rebuild is a
   no-op (live index already matches snapshot+log fold).
