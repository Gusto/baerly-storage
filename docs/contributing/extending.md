---
title: Extending baerly-storage
audience: coder
summary: Worked patterns for adding methods to Db, Query verbs, and Collection verbs.
last-reviewed: 2026-06-28
tags: [extending, api-design, patterns]
related:
  [
    "../architecture.md",
    "conventions/change-discipline.md",
    "conventions/tests.md",
  ]
---

# Extending baerly-storage

Most extension work starts with one question: which layer owns the new
behavior? If the change is only a nicer way to ask for existing data, it
belongs near `Db`, `Collection<T>`, or `Query<T>`. If it changes what a write
means, it belongs in the protocol wire shape and `Writer`. If it changes where
bytes live, it belongs behind `Storage`.

This page walks through those shapes. Use the examples as placement rules first
and code templates second; the right file follows from the layer that owns the
invariant.

> Before adding a feature, read [architecture.md](../architecture.md) so you
> know which module owns what. Most public API additions touch
> `packages/server/src/db.ts` or `packages/server/src/collection.ts`, but write
> _invariants_ live in `packages/server/src/writer.ts`.

> Before adding a public symbol to a barrel, read
> [§6 Naming a public symbol](#6-naming-a-public-symbol) — it codifies
> when an export carries the `Baerly` prefix and when it stays generic,
> including the rejected "prefix everything" alternative.

---

## 1. Add a new public method on `Db`

We'll work through `collections()` — list every collection with a manifest under
the tenant prefix.

### Where to add the method

Start with the call site. A tenant-level operation belongs on `Db`; an operation
on one collection or one filtered row set usually belongs on `Collection<T>` or
`Query<T>`, reached through `db.collection<T>(name)`.

Concretely, `Db` lives in `packages/server/src/db.ts`, and the collection
implementation lives in `packages/server/src/collection.ts`. The
`Collection<T>` / `Query<T>` interfaces themselves are locked in
`@baerly/protocol`; adding a new verb there is a coordinated protocol-surface
change, not a server-only edit.

````ts
// packages/server/src/db.ts (inside class Db)

/**
 * List every collection name present under this tenant's manifest
 * prefix. Reads object storage; no caching layer.
 *
 * @returns array of collection names, in unspecified order
 *
 * @example
 * ```ts
 * await db.collection("tickets").insert({ title: "hello" });
 * const collections = await db.collections();
 * // → ["tickets"]
 * ```
 */
public async collections(): Promise<string[]> {
  const prefix = physicalPrefixFor(this.app, this.tenant) +
    "manifests/";
  const out = new Set<string>();
  for await (const entry of this.#storage.list(prefix)) {
    // entry.key === "<prefix><collection>/current.json"
    const tail = entry.key.slice(prefix.length);
    const name = tail.split("/")[0];
    if (name) out.add(name);
  }
  return [...out];
}
````

### Conventions to follow

- **Check for redundancy first.** Before adding a method, run the
  "One canonical form per operation" check in
  [conventions/change-discipline.md](conventions/change-discipline.md).
  If the new method's operation is already expressible via an
  existing type-valid path, plan for removal of the old path in the
  same PR — or amend the
  [API surface lock](conventions/change-discipline.md#api-surface-lock)
  with the justification for keeping both.
- **JSDoc with `@example`.** IDE hover and `tsgo` surface these
  directly from source — they are the public-API reference.
- **No request state on `Db`.** `Db` carries stable construction state:
  the `Storage` handle, the `app` / `tenant` pair, and derived schema/index
  maps. Per-request state belongs in the caller; per-write state belongs in a
  fresh `Writer`.
- **Reads are on-demand.** Use the injected `#storage` directly for
  `list` / `get` reads; use `Collection<T>.where(...).all()` for log-fold
  reads. Don't build a parallel cache layer.
- **No new throw without `BaerlyError`.** If the method can fail,
  throw `new BaerlyError("Code", "context")` from
  `packages/protocol/src/errors.ts`.
- **Internal helpers stay co-located.** Either a module-private
  function in `packages/server/src/db.ts` or a fresh sibling file
  exported as `@internal`.

### Add a test

For a behavior that doesn't require a network round trip, prefer a
focused test in a topic-specific file. See
[docs/contributing/conventions/tests.md](conventions/tests.md) for where the file
lives.

```ts
import { test, expect, describe } from "vitest";
import { Db } from "@baerly/server";
import { MemoryStorage } from "@baerly/server";

describe("Db.collections()", () => {
  test("reflects writes", async () => {
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "test",
      tenant: "acme",
    });
    await db.collection("tickets").insert({ title: "x" });
    await db.collection("users").insert({ name: "Ada" });
    const collections = await db.collections();
    expect(collections.sort()).toEqual(["tickets", "users"]);
  });
});
```

For protocol-shape changes (anything in
`packages/server/src/writer.ts`), also add a property-based
variant in `tests/integration/randomized.test.ts` so the behavior is
exercised under random write interleavings.

### Verify

```sh
pnpm verify        # typecheck + examples + lint + format + docs guards
pnpm test          # build + vitest default project
```

---

## 1b. Declare a schema for a collection

Schemas in baerly-storage are caller-declared at the server boundary: every
`insert` / `update` / `replace` validates the resulting _post-image_
against a `SchemaValidator` you attach to a `CollectionDefinition`.
Invalid input throws `BaerlyError{code:"SchemaError"}` carrying a
machine-readable `.issues` array of `{path, message}` entries; the raw HTTP
400 response body includes those issues for clients that read the envelope
directly.

### Adapter shape

`SchemaValidator` (re-exported from `@baerly/server`) is the
[StandardSchemaV1](https://standardschema.dev/) interface — a pure-type
contract implemented by Zod, Valibot, ArkType, and other schema libraries.
The type is defined in `packages/protocol/src/schema.ts`; the runtime adapter
`validateOrThrow` lives in `packages/server/src/schema.ts`. The repo carries no
runtime dep on any validator library — you bring whichever library you like.

### Zod example

This is the runtime-only `BaerlyConfig` shape. Scaffolded `baerly.config.ts`
files can also include deploy metadata such as `app`, `tenant`, `target`, and
`auth`.

```ts
// baerly.config.ts
import { defineConfig } from "@gusto/baerly-storage/config";
import { z } from "zod";

const Ticket = z.object({
  _id: z.string(),
  status: z.enum(["open", "closed"]),
  title: z.string().min(1),
});

export default defineConfig({
  collections: {
    tickets: { schema: Ticket },
  },
});
```

### Valibot example

```ts
// baerly.config.ts
import { defineConfig } from "@gusto/baerly-storage/config";
import * as v from "valibot";

const Ticket = v.object({
  _id: v.string(),
  status: v.picklist(["open", "closed"]),
  title: v.pipe(v.string(), v.minLength(1)),
});

export default defineConfig({
  collections: {
    tickets: { schema: Ticket },
  },
});
```

Both forms compile to the same `SchemaValidator`-shaped object;
`validateOrThrow` in `packages/server/src/schema.ts` is library-agnostic.

### What gets validated

| Verb      | Validated value                                                   |
| --------- | ----------------------------------------------------------------- |
| `insert`  | `{ ...doc, _id }` — the post-image with the minted/honoured `_id` |
| `update`  | `merge(prev, patch)` — the merged post-image, not the patch       |
| `replace` | `{ ...doc, _id: existingId }` — the post-image                    |
| `delete`  | — (no body to validate)                                           |

For `update` we validate the merged result, not the patch: a partial
patch (`{ status: "closed" }`) wouldn't satisfy a schema requiring
other fields, and the schema is the shape of the _final row_, not of
a delta.

`_id` is part of the validated shape and is required. The post-image
always carries `_id` (the server mints a UUIDv7 for inserts that omit
it), so the schema must assert it — author `_id: z.string()`, not
`.optional()`.

A multi-row `update()` is **not** transactional across rows. Validation
runs per row on the merged post-image, and each row commits
independently: if row N fails, rows 0..N-1 are already committed and stay
committed, and the call throws `BaerlyError{code:"SchemaError"}` on row
N. The schema seam inherits the per-row atomicity contract; it does not
add all-or-nothing semantics on top of it.

### Wiring schemas into `Db.create`

Schemas are declared on the collection, not on `Db.create` — pass
the `defineConfig({...})` value from `baerly.config.ts` (see the
Zod example above) as the `config` field:

```ts
import config from "../baerly.config.ts";
const db = Db.create({ storage, app, tenant, config });
```

The kernel derives the per-collection schema and index maps from
`config.collections` internally via `collectionsToMaps`
(re-exported from `@gusto/baerly-storage` for tests that want to
construct the maps directly). When `config` is omitted, schema
validation is a no-op.

The previous `schemas:` / `indexes:` overrides on `Db.create` are no longer
supported — they duplicated `config.collections[*]`, and a second
type-valid path to the same capability is redundant ceremony (see the
[API surface lock](conventions/change-discipline.md#api-surface-lock)).

### Forward-only migration

Collection schemas validate future writes; they do not rewrite existing rows.
If a deployment needs old documents to satisfy a stricter Zod/Valibot shape,
that backfill is application-layer work.

The validator runs only on the write path — never on reads, export, or
replay. The log stores the post-image produced at write time, and replay
folds those stored documents directly without re-validating. A schema
change therefore never retroactively rejects existing rows: documents
written under an older schema remain readable and exportable regardless
of the current schema.

Two alternatives were rejected. **Validating the incoming patch** (not
the post-image) would fail any schema with required fields a valid
partial update doesn't restate. **A baerly-proprietary validator
signature** was rejected for the ecosystem-neutral `StandardSchemaV1`
contract, so any compatible library (Zod, Valibot, ArkType, …) works via
the `SchemaValidator` type from `@baerly/protocol`.

Protocol artifact migrations are separate. The forward-compatible
schema-versioning mechanism lives on the `CurrentJson` coordination document:
the `schema_version` field (currently `3`, constant
`CURRENT_JSON_SCHEMA_VERSION` in `packages/protocol/src/constants.ts`) is bumped
monotonically on any breaking change to `CurrentJson` field semantics; readers
must reject unknown major versions with `BaerlyError{code:"InvalidResponse"}`.
Adding a new optional field to `CurrentJson` is non-breaking.

The `LogEntry` CDC wire shape has a separate
forward/backward-compatibility policy documented in
[`docs/spec/log-entry-shape.md`](../../docs/spec/log-entry-shape.md):
new optional fields are additive; renaming, removing, repurposing, or
narrowing a field is a breaking wire change. Since 0.3.0, `LogEntry`
is a public early-access baseline; it is still pre-1.0 and soaking, but
those changes require an explicit compatibility decision,
changelog/migration notes, and a versioned release. `LogEntry` does not
carry its own `schema_version` field, and there is no out-of-band
announcement opcode today — `op` is the closed
union `"I" | "U" | "D"`. If a schema-change announcement channel is
ever needed, it would arrive as a deliberate major-version migration
(a new `op` value or a top-level `_v` field — see
[`docs/spec/log-entry-shape.md` §Stability](../../docs/spec/log-entry-shape.md)),
not via an existing opcode. Document-level rewrite tooling is
application-layer work; the protocol does not supply rewrite logic.

---

## 1c. Declare an index on a collection

An index is a second set of storage keys that lets a read start near matching
documents instead of walking every row. The writer maintains those keys; the
reader decides whether they help.

Concretely, indexes are declared on the collection config under
`BaerlyConfig.collections[*].indexes`. Each `IndexDefinition` has a `name`, an
`on` field tuple, and an optional `predicate?` for a filtered index. The
auto-planner picks a walk plan from the declared set at read time; there is no
manual-hint API on `Query<T>`.

### `IndexDefinition` shape

```ts
// packages/protocol/src/indexes.ts
export interface IndexDefinition {
  readonly name: string; // /^[a-z][a-z0-9_]*$/
  readonly on: string | readonly string[]; // top-level field(s)
  readonly predicate?: PredicateWire; // { clauses: PredicateClause[] }
}
```

### Worked example — single-field

```ts
// baerly.config.ts
import { defineConfig } from "@gusto/baerly-storage/config";

export default defineConfig({
  collections: {
    tickets: {
      indexes: [{ name: "by_status", on: "status" }],
    },
  },
});
```

### Worked example — composite

```ts
// Composite on [status, priority]. A query like
//   db.collection("tickets").where({ status: "open", priority: "p1" }).all()
// walks under <prefix>/index/by_status_priority/<status-b32>/<priority-b32>/.
// When only `priority` is present, the planner emits FullScanPlan
// (no left anchor on `status`).
{ name: "by_status_priority", on: ["status", "priority"] },
```

### Worked example — filtered

```ts
// Only `status = "open"` docs project keys. Smaller LIST footprint
// than a dense `by_assignee` when most tickets are closed.
{ name: "by_open_assignee",
  on: "assignee",
  predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] } },
```

### What the planner does at read time

- See [architecture.md](../architecture.md) §"Planner step (between
  the predicate and the log fold)" for the lifecycle. The summary:
  if the predicate covers a declared index's `on` tuple, the
  planner emits `IndexWalkPlan` and the reader walks the encoded
  index prefix; otherwise it emits `FullScanPlan` and the read
  falls through to the snapshot+log fold.

### Conventions to follow

- Top-level fields only on `on` — dotted-path values throw
  `SchemaError` at projection time
  (`packages/server/src/indexes.ts:337-345`).
- `name` must match `/^[a-z][a-z0-9_]*$/`. A name in the reserved
  leading-`_` namespace throws `InvalidConfig`; a name that fails the
  regex throws `SchemaError`.
- `predicate?` is a `PredicateWire` —
  `{ clauses: PredicateClause[] }`. It accepts the full operator vocabulary (`eq`,
  `gt` / `gte`, `lt` / `lte`, `in`) end-to-end. `predicateImplies`
  reasons about range and `in` containment, so the planner prefers
  a filtered index whenever the query's bounds (whether expressed
  as equality, `in` members, or another range) fall inside the
  filter's bounds.
- A filtered index is sound only when the query predicate implies the index
  predicate. Keep an unfiltered fallback for broader queries; otherwise the
  planner can route through the filtered index as a last resort and miss rows
  outside the filter.
- **Numeric range and `in` walks route through the index** — see
  [`docs/contributing/features.md`](features.md)
  §"Numeric range and `in` walks".
  The value-order-preserving encoder keeps numeric and string ranges
  in disjoint, sortable slots; string-encoded values (ISO 8601
  timestamps, zero-padded numerics) remain a fine choice when you
  want a single key space across heterogenous inputs.
- When no predicate is given, no indexes are declared, or the
  predicate is operator-only on a non-indexed field, `planQuery`
  emits `FullScanPlan` and the read walks the log-fold unchanged.

### Adding an index to an existing deployment

Run one of these forms:

```sh
pnpm build && pnpm baerly admin rebuild-index \
  --bucket=<uri> --collection=<collection> --index=<name> --on=<field>

pnpm build && pnpm baerly admin rebuild-index \
  --bucket=<uri> --collection=<collection> --index=<name> --config=<compiled-js-mjs-or-json>
```

The command also accepts `--app` and `--tenant`; when omitted, they default from
`baerly.config.ts`. Use `--on` only for a single-field unfiltered index. Use
`--config` with a compiled `.js`, `.mjs`, or `.json` config to resolve the
matching declared index; the current CLI resolves the index's `on` field only,
so do not use it as the source of truth for filtered-index predicates. The
writer emits forward entries on every commit; pre-existing rows are not
back-projected until rebuild runs.

### Verify

```sh
pnpm verify        # typecheck + examples + lint + format + docs guards
pnpm test          # build + vitest default project
```

---

## 2. Add a new write primitive

Use this pattern when the new operation cannot be represented as today's
`insert` / `update` / `replace` / `delete` flow. Existing log entries mean
public API convenience; a new durable fact in the log means a new write
primitive.

Concretely, that means adding a new `op` (e.g. a TRUNCATE analogue) or a new
shape of `CommitInput` that the existing `Writer.commit` path can't express.

The write primitive lives in two places:

1. **The wire shape** — `LogEntry` in
   `packages/protocol/src/log.ts`. Adding a new `op` letter is a
   **major-version migration** (see
   [spec/log-entry-shape.md §Stability](../spec/log-entry-shape.md)).
2. **The commit path** — `Writer` in
   `packages/server/src/writer.ts`. Extend `CommitInput`
   with the new shape and update `commit` to emit
   the new `LogEntry`.

### File template

```ts
// packages/server/src/writer.ts (extending CommitInput)

export interface CommitInput {
  readonly op: "I" | "U" | "D" | "T"; // new: T
  readonly collection: string;
  readonly docId?: string; // if undefined for a new op, audit Writer's doc-id guard
  readonly body?: DocumentData;
  // ...
}
```

Today `CommitInput.docId` is required and `Writer.commit` validates it before
any op-specific branch. A collection-wide op must update that guard, the
`LogEntry` field requirements, and every reader fold that assumes one log entry
maps to one document id.

### Wire it in

- Update the collection API (`packages/server/src/collection.ts`) so callers
  can reach the new primitive. If the new primitive doesn't fit
  the `Collection<T>` shape, extend `Db` directly.
- Add the new `op` discriminant to the field-requirement matrix in
  [spec/log-entry-shape.md](../spec/log-entry-shape.md).
- Update `packages/server/src/query.ts` if the reader needs to fold
  the new entry shape into the row set.
- If this changes protocol-visible state (a new field on
  `current.json`, a new `op`, a new storage layout), document it in
  [spec/sync-protocol.md](../spec/sync-protocol.md) and add a coverage entry in
  [spec/causal-consistency-checking.md](../spec/causal-consistency-checking.md).

### Don't

- ❌ Add a config knob unless it's user-facing. Internal toggles bloat
  `WriterOptions`; prefer a constant in
  `packages/protocol/src/constants.ts`.
- ❌ Add new ambient dependencies inside `Writer` without threading them
  through the existing seams. The class accepts an injected `random` callback
  for retry jitter; protocol timestamps should follow the existing
  `Date.now()` plus timestamp-helper pattern, or use
  `StoragePutResult.serverDate` where a protocol path explicitly requires
  storage-server provenance. Do not reach for `node:fs` directly.
- ❌ Use baseUrl-style imports — there's no `baseUrl` configured.

---

## 3. Add a new `Storage` impl

`Storage` is the narrow boundary between the protocol and an object store. A new
backend should make the existing read/write/list/delete contract true; it should
not teach the protocol about a new provider.

The `Storage` interface is defined in
`packages/protocol/src/storage/types.ts` and re-exported from
`packages/protocol/src/storage/index.ts`. New impls land in their own package
under `packages/` (`adapter-node`, `adapter-cloudflare`, `adapter-lambda`, …)
or as direct exports of `@baerly/dev` for the local-dev case.

### File template

```ts
// packages/adapter-fly/src/fly-storage.ts
import type { Storage, StorageGetResult, StorageListEntry, StoragePutResult } from "@baerly/server";
import { BaerlyError } from "@baerly/server";

export class FlyStorage implements Storage {
  // ... implement get / put / delete / list per the interface JSDoc
}
```

### Conformance

Every `Storage` impl is exercised by
`defineStorageConformanceSuite` in
`packages/protocol/src/storage/conformance.ts`. The suite is
factory-driven — pass a function that mints a fresh `Storage`
handle pointed at an empty bucket; the suite handles the rest.

Live examples:

- `packages/adapter-node/src/s3-http.conformance.test.ts` — Minio
  variant, gated on `MINIO=1`.
- `packages/adapter-cloudflare/src/r2-binding-storage.conformance.test.ts`
  — Workerd variant, runs under the `cloudflare-pool` vitest
  project.

Wire your new impl in the same shape. The conformance suite is
authoritative — passing it is the gate that says "this is a real
`Storage` impl."

---

## 4. Add a new test

### File naming and location

See [docs/contributing/conventions/tests.md](conventions/tests.md)
for where to put the file (colocated unit under
`packages/<pkg>/src/`, `tests/unit/`, `tests/integration/`, or
`tests/fixtures/`) and how to name it.

### Test template

```ts
import { test, expect, describe } from "vitest";
import { Db } from "@baerly/server";
import { MemoryStorage } from "@baerly/server";

describe("my feature", () => {
  test("does the thing", async () => {
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "test",
      tenant: "acme",
    });
    // ...
    expect(thing).toBe(expectedThing);
  });
});
```

### When to write a property-based test

Reach for `randomized.test.ts`-style coverage when the behavior depends on
_ordering_ — interleaved writes, replay sequence, partial failures.
Property-based tests catch races that example tests can't.

A property test in this codebase typically:

1. Generates a random sequence of `insert` / `update` / `delete`
   operations across multiple writers.
2. Runs them through `Db` + `Writer` (often with multiple
   writers contending on the same `current.json`).
3. Asserts a property like "every observer eventually sees a
   sequence consistent with some serialization of the writes" or
   "no client observes a state that contradicts a happened-before
   relation".

Look at `tests/integration/randomized.test.ts` and
`tests/unit/consistency.test.ts` for the patterns in use.

### When to assert on errors

Check the `code`, not the message:

```ts
import { BaerlyError } from "@baerly/server";

expect.assertions(1);
try {
  await db.collection("users").insert(/* something invalid */);
} catch (err) {
  expect((err as BaerlyError).code).toBe("InvalidConfig");
}
```

Don't string-match on `error.message` — those are not stable.

### Performance budget

The full `pnpm test` should stay under ~30s on a developer laptop. If your
test sleeps or polls, prefer `await Promise.resolve()` ticks or short
intervals (≤50ms) to keep the suite snappy.

---

## 5. Shared utilities on the public surface

Some functions live below the `Db` / `Collection<T>` API and are exported from
`@baerly/server` for consumers — adapters, the CLI, admin tooling — that need to
compose protocol primitives directly. They are `@public` and stable; the JSDoc
on each is the canonical reference.

- **`loadSnapshotAsMap(storage, key, expectedCollection, signal?)`**
  (`packages/server/src/snapshot.ts`) — load a content-addressed
  snapshot, verify its SHA-256 against the filename, and return the
  docs as a `Map<_id, body>`. Used internally by the compactor,
  reader, GC, rebuild-index, and migrate paths. Prefer this over
  hand-rolling a snapshot reader — the function bakes in the hash
  check, schema-version gate, and collection-mismatch guard.

Other utilities (e.g. `compact`, `runGc`, `rebuildIndex`) are
end-to-end orchestrators rather than helpers; their entry points are
documented in [architecture.md](../architecture.md) under "Where
invariants live."

---

## 6. Naming a public symbol

The package is `baerly-storage`. The `Baerly` prefix that appears on a
few public symbols is a shortening of the package name — used to
disambiguate from globals or common user identifiers where a bare symbol
would be unreadable. It is not a brand applied universally; doing so
would just re-state the package name on every export. Apply this rule
before adding a new export to a barrel.

**The `Baerly` prefix carries a symbol when:**

1. The bare name would **collide** with a global (`Error`) or a name
   users routinely declare (`Config`, `Client`, `Env`, `Storage`).
   Prefix to disambiguate — `BaerlyError`, `BaerlyClient`,
   `BaerlyConfig`, `BaerlyAppConfig`. (`BaerlyError` is _caught_; the
   `*Config` types are used as `Db<typeof config>` type args, not
   constructed by name — users call `defineConfig({...})` — so the
   operative test is collision, not "construct or catch".)
2. It is a platform-integration entry function the user puts behind
   `export default` — `baerlyWorker`, `baerlyNode`, `baerlyDev`.
   Generic names (`worker()`, `node()`) would be unreadable at the
   call site.
3. It mirrors a platform-defined type the user would otherwise
   re-alias — `BaerlyEnv` extending Cloudflare's `Env`.

**The `Baerly` prefix is dropped when:**

1. The symbol is generic to the import context — `Db`, `Collection`,
   `Query`, `Storage`, `Writer`. Adding the prefix duplicates
   `baerly-storage` from the import line.
2. The subpath already disambiguates — `/auth/sharedSecret`,
   `/maintenance/compact`, `/observability/withObservability`,
   `/client/react/useQuery`. The path supplies the namespace.
3. The symbol is a strategy or adapter that names its underlying
   technology — `S3HttpStorage`, `r2BindingStorage`, `MemoryStorage`,
   `bearerJwt`, `cloudflareAccess`. The technology name is what users
   look for.

If a symbol falls cleanly into "drops" but the rule feels wrong, that
is a signal the boundary is off — surface to a maintainer rather than
papering over it with the prefix. Exported-symbol renames are breaking
changes held to the
[API surface lock](conventions/change-discipline.md#api-surface-lock)
bar; `Baerly`-prefix decisions that would change an export are
API-lock work, not hygiene.

**Rejected: prefix every symbol.** `BaerlyDb`, `BaerlyCollection`,
`BaerlyStorage` re-state the package name inside its own export and break
the zero-shot-legibility criterion in the
[product thesis](../about/thesis.md); rejected. Drift control stays
prose, not a lint rule — once a symbol ships, a rename is held to the
API-surface-lock bar above.
