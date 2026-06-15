---
title: Extending Baerly
audience: coder
summary: Worked patterns for adding methods to Db, Query verbs, and Collection verbs.
last-reviewed: 2026-06-12
tags: [extending, api-design, patterns]
related: [architecture.md, "../adr/002-api-surface-lock.md", "../adr/003-naming-convention.md", "conventions/tests.md"]
---

# Extending Baerly

Three worked examples for the most common extension shapes. Follow these
patterns and your changes will fit the codebase's conventions.

> Before adding a feature, read [architecture.md](architecture.md) so you
> know which module owns what. Most additions touch
> `packages/server/src/db.ts` or `packages/server/src/collection.ts`, but the
> *invariants* live in `packages/server/src/writer.ts`.

> Before adding a public symbol to a barrel, read
> [ADR-003 — `Baerly`-prefix naming convention](../adr/003-naming-convention.md).
> It codifies when an export carries the `Baerly` prefix and when it
> stays generic.

---

## 1. Add a new public method on `Db`

We'll work through `collections()` — list every collection that has at least
one mutation logged against it.

### Where to add the method

Public methods live on the `Db` class in
`packages/server/src/db.ts`. The typical surface is `Collection<T>` (in
`packages/server/src/collection.ts`), reached via
`db.collection<T>(name)` — so most additions are actually new verbs on
`Collection<T>` / `Query<T>`. The `Collection<T>` / `Query<T>` interfaces
themselves are locked in `@baerly/protocol`; adding a new verb is
a coordinated change.

```ts
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
```

### Conventions to follow

- **Check for redundancy first.** Before adding a method, run the
  "One canonical form per operation" check in
  [conventions/change-discipline.md](conventions/change-discipline.md).
  If the new method's operation is already expressible via an
  existing type-valid path, plan for removal of the old path in the
  same PR — or amend [ADR-002](../adr/002-api-surface-lock.md) with
  the justification for keeping both.
- **JSDoc with `@example`.** IDE hover and `tsgo` surface these
  directly from source — they are the public-API reference.
- **No state on `Db`.** `Db` carries the `Storage` handle and the
  `app` / `tenant` pair only. Per-request state belongs in the
  caller; per-write state belongs in a fresh `Writer`.
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
[docs/conventions/tests.md](conventions/tests.md) for where the file
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
pnpm verify        # typecheck + verify:examples + lint
pnpm test          # vitest run
```

---

## 1b. Declare a schema for a collection

Schemas in Baerly are caller-declared at the server boundary: every
`insert` / `update` / `replace` validates the resulting *post-image*
against a `SchemaValidator` you attach to a `CollectionDefinition`.
Invalid input throws `BaerlyError{code:"SchemaError"}` carrying a
machine-readable `.issues` array of `{path, message}` entries; the
HTTP layer ships them on the 400 response body so a UI can render
field-level errors directly.

### Adapter shape

`SchemaValidator` (from `@baerly/server`) is the
[StandardSchemaV1](https://standardschema.dev/) interface — a
pure-type contract implemented by Zod 3.24+, Valibot 0.36+, ArkType
2.0+, and others. The interface lives in
`packages/server/src/schema.ts`; the repo carries no runtime dep on
any validator library — you bring whichever library you like.

### Zod example

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

Both forms compile to the same `SchemaValidator`-shaped object; the
adapter `validateOrThrow` in `packages/server/src/schema.ts` doesn't
know (or care) which library produced it.

### What gets validated

| Verb       | Validated value                                             |
|------------|-------------------------------------------------------------|
| `insert`   | `{ ...doc, _id }` — the post-image with the minted/honoured `_id` |
| `update`   | `merge(prev, patch)` — the merged post-image, not the patch |
| `replace`  | `{ ...doc, _id: existingId }` — the post-image              |
| `delete`   | — (no body to validate)                                     |

For `update` we validate the merged result, not the patch: a partial
patch (`{ status: "closed" }`) wouldn't satisfy a schema requiring
other fields, and the schema is the shape of the *final row*, not of
a delta.

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

The previous `schemas:` / `indexes:` overrides on `Db.create` were
cut on 2026-05-27 — see [`docs/adr/002-api-surface-lock.md`](../adr/002-api-surface-lock.md)
for the reasoning.

### Forward-only migration

Schema migrations are forward-only. The forward-compatible
schema-versioning mechanism lives on the `CurrentJson` coordination
document: the `schema_version` field (currently `2`, constant
`CURRENT_JSON_SCHEMA_VERSION` in
`packages/protocol/src/constants.ts`) is bumped monotonically on any
breaking change to `CurrentJson` field semantics; readers must reject
unknown major versions with `BaerlyError{code:"InvalidResponse"}`.
Adding a new optional field to `CurrentJson` is non-breaking.

The `LogEntry` CDC wire shape has a separate
forward/backward-compatibility policy documented in
[`docs/spec/log-entry-shape.md`](../../docs/spec/log-entry-shape.md):
new optional fields are additive; renaming, removing, or narrowing a
field is a major-version migration. Pre-launch the shape may still
narrow. `LogEntry` does not carry its own `schema_version` field, and there
is no out-of-band announcement opcode today — `op` is the closed
union `"I" | "U" | "D"`. If a schema-change announcement channel is
ever needed, it would arrive as a deliberate major-version migration
(a new `op` value or a top-level `_v` field — see
[`docs/spec/log-entry-shape.md` §Stability](../../docs/spec/log-entry-shape.md)),
not via an existing opcode. Document-level rewrite tooling is
application-layer work; the protocol does not supply rewrite logic.

---

## 1c. Declare an index on a collection

Indexes are declared on the collection config under
`BaerlyConfig.collections[*].indexes`. Each `IndexDefinition` has a
`name`, an `on` (single field or composite), and an optional
`predicate?` (filtered index — only docs matching the predicate
project keys). The auto-planner picks a walk plan from the declared
set at read time; there is no manual-hint API on `Query<T>`.

### `IndexDefinition` shape

```ts
// packages/server/src/indexes.ts
export interface IndexDefinition {
  readonly name: string;                       // /^[a-z][a-z0-9_]*$/
  readonly on: string | readonly string[];     // top-level field(s)
  readonly predicate?: PredicateWire;          // { clauses: PredicateClause[] }
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

- See [architecture.md](architecture.md) §"Planner step (between
  the predicate and the log fold)" for the lifecycle. The summary:
  if the predicate covers a declared index's `on` tuple, the
  planner emits `IndexWalkPlan` and the reader walks the encoded
  index prefix; otherwise it emits `FullScanPlan` and the read
  falls through to the snapshot+log fold.

### Conventions to follow

- Top-level fields only on `on` — dotted-path values throw
  `SchemaError` at projection time
  (`packages/server/src/indexes.ts:192-216`).
- `name` must match `/^[a-z][a-z0-9_]*$/`. A name in the reserved
  leading-`_` namespace throws `InvalidConfig`; a name that fails the
  regex throws `SchemaError`.
- `predicate?` is a {@link PredicateWire} — `{ clauses:
  PredicateClause[] }`. Accepts the full operator vocabulary (`eq`,
  `gt` / `gte`, `lt` / `lte`, `in`) end-to-end. `predicateImplies`
  reasons about range and `in` containment, so the planner prefers
  a filtered index whenever the query's bounds (whether expressed
  as equality, `in` members, or another range) fall inside the
  filter's bounds.
- **Numeric range and `in` walks route through the index** — see
  [`docs/features.md`](features.md) §"Numeric range and `in` walks".
  The value-order-preserving encoder keeps numeric and string ranges
  in disjoint, sortable slots; string-encoded values (ISO 8601
  timestamps, zero-padded numerics) remain a fine choice when you
  want a single key space across heterogenous inputs.
- When no predicate is given, no indexes are declared, or the
  predicate is operator-only on a non-indexed field, `planQuery`
  emits `FullScanPlan` and the read walks the log-fold unchanged.

### Adding an index to an existing deployment

Run

```sh
pnpm build && pnpm baerly admin rebuild-index <collection> <name>
```

to backfill. The writer emits forward entries on every commit;
pre-existing rows are not back-projected until rebuild runs.

### Verify

```sh
pnpm verify        # typecheck + verify:examples + lint
pnpm test          # vitest run
```

---

## 2. Add a new write primitive

Use this pattern when you're adding a new `op` (e.g. a TRUNCATE
analogue) or a new shape of `CommitInput` that the existing
`Writer.commit` path can't express.

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
  readonly op: "I" | "U" | "D" | "T";        // new: T
  readonly collection: string;
  readonly docId?: string;                    // undefined on op:"T"
  readonly body?: DocumentData;
  // ...
}
```

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
- ❌ Reach for `Math.random`, `Date.now`, or `node:fs` directly inside
  `Writer`. The class accepts an injected `random` callback for
  retry jitter; protocol timestamps should flow through the existing
  helper functions or through `StoragePutResult.serverDate` where the
  fence protocol explicitly requires storage-server provenance.
- ❌ Use baseUrl-style imports — there's no `baseUrl` configured.

---

## 3. Add a new `Storage` impl

The `Storage` interface lives in
`packages/protocol/src/storage/index.ts`. New impls land in their
own package under `packages/` (`adapter-node`, `adapter-cloudflare`,
`adapter-lambda`, …) or as direct exports of `@baerly/dev` for the
local-dev case.

### File template

```ts
// packages/adapter-fly/src/fly-storage.ts
import type { Storage, StorageGetResult, StorageListEntry, StoragePutResult }
  from "@baerly/server";
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

See [docs/conventions/tests.md](conventions/tests.md) for where to put
the file (colocated unit under `packages/<pkg>/src/`,
`tests/unit/`, `tests/integration/`, or `tests/fixtures/`) and how
to name it.

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
*ordering* — interleaved writes, replay sequence, partial failures.
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

A handful of functions live below the `Db` / `Collection<T>` API and are
exported from `@baerly/server` for consumers — adapters, the CLI,
admin tooling — that need to compose protocol primitives directly.
They are `@public` and stable; the JSDoc on each is the canonical
reference.

- **`loadSnapshotAsMap(storage, key, expectedCollection, signal?)`**
  (`packages/server/src/compactor.ts`) — load a content-addressed
  snapshot, verify its SHA-256 against the filename, and return the
  docs as a `Map<_id, body>`. Used internally by the compactor,
  reader, GC, rebuild-index, and migrate paths. Prefer this over
  hand-rolling a snapshot reader — the function bakes in the hash
  check, schema-version gate, and collection-mismatch guard.

Other utilities (e.g. `compact`, `runGc`, `rebuildIndex`) are
end-to-end orchestrators rather than helpers; their entry points are
documented in [architecture.md](architecture.md) under "Where
invariants live."
