---
title: Extending Baerly
audience: coder
summary: Worked patterns for adding methods to Db, Query verbs, and Table verbs.
last-reviewed: 2026-05-12
tags: [extending, api-design, patterns]
related: [architecture.md, "adr/0019-api-surface-lock.md", "conventions/tests.md"]
---

# Extending Baerly

Three worked examples for the most common extension shapes. Follow these
patterns and your changes will fit the codebase's conventions.

> Before adding a feature, read [architecture.md](architecture.md) so you
> know which module owns what. Most additions touch
> `packages/server/src/db.ts` or `packages/server/src/table.ts`, but the
> *invariants* live in `packages/server/src/server-writer.ts`.

---

## 1. Add a new public method on `Db`

We'll work through `tables()` — list every table that has at least
one mutation logged against it.

### Where to add the method

Public methods live on the `Db` class in
`packages/server/src/db.ts`. The typical surface is `Table<T>` (in
`packages/server/src/table.ts`), reached via
`db.table<T>(name)` — so most additions are actually new verbs on
`Table<T>` / `Query<T>`. The `Table<T>` / `Query<T>` interfaces
themselves are locked in `@baerly/protocol`; adding a new verb is
a coordinated change.

```ts
// packages/server/src/db.ts (inside class Db)

/**
 * List every table name present under this tenant's manifest
 * prefix. Reads object storage; no caching layer.
 *
 * @returns array of table names, in unspecified order
 *
 * @example
 * ```ts
 * await db.table("tickets").insert({ title: "hello" });
 * const tables = await db.tables();
 * // → ["tickets"]
 * ```
 */
public async tables(): Promise<string[]> {
  const prefix = physicalPrefixFor(this.app, this.tenant) +
    "manifests/";
  const out = new Set<string>();
  for await (const entry of this.#storage.list({ prefix })) {
    // entry.key === "<prefix><table>/current.json"
    const tail = entry.key.slice(prefix.length);
    const name = tail.split("/")[0];
    if (name) out.add(name);
  }
  return [...out];
}
```

### Conventions to follow

- **JSDoc with `@example`.** IDE hover and `tsgo` surface these
  directly from source — they are the public-API reference.
- **No state on `Db`.** `Db` carries the `Storage` handle and the
  `app` / `tenant` pair only. Per-request state belongs in the
  caller; per-write state belongs in a fresh `ServerWriter`.
- **Reads are on-demand.** Use the injected `#storage` directly for
  `list` / `get` reads; use `Table<T>.where(...).all()` for log-fold
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
import { MemoryStorage } from "@baerly/protocol";

describe("Db.tables()", () => {
  test("reflects writes", async () => {
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "test",
      tenant: "acme",
    });
    await db.table("tickets").insert({ title: "x" });
    await db.table("users").insert({ name: "Ada" });
    const tables = await db.tables();
    expect(tables.sort()).toEqual(["tickets", "users"]);
  });
});
```

For protocol-shape changes (anything in
`packages/server/src/server-writer.ts`), also add a property-based
variant in `tests/integration/randomized.test.ts` so the behavior is
exercised under random write interleavings.

### Verify

```sh
pnpm verify        # typecheck + lint
pnpm test          # vitest run
```

---

## 2. Add a new write primitive

Use this pattern when you're adding a new `op` (e.g. a TRUNCATE
analogue) or a new shape of `CommitInput` that the existing
`ServerWriter.commit` path can't express.

The write primitive lives in two places:

1. **The wire shape** — `LogEntry` in
   `packages/protocol/src/log.ts`. Adding a new `op` letter is a
   stability change (see [spec/log-entry-shape.md](spec/log-entry-shape.md)).
2. **The commit path** — `ServerWriter` in
   `packages/server/src/server-writer.ts`. Extend `CommitInput`
   with the new shape and update `commit` / `commitBatch` to emit
   the new `LogEntry`.

### File template

```ts
// packages/server/src/server-writer.ts (extending CommitInput)

export interface CommitInput {
  readonly op: "I" | "U" | "D" | "T";        // new: T
  readonly collection: string;
  readonly docId?: string;                    // undefined on op:"T"
  readonly body?: JSONArraylessObject;
  // ...
}
```

### Wire it in

- Update the table API (`packages/server/src/table.ts`) so callers
  can reach the new primitive. If the new primitive doesn't fit
  the `Table<T>` shape, extend `Db` directly.
- Add the new `op` discriminant to the field-requirement matrix in
  [spec/log-entry-shape.md](spec/log-entry-shape.md).
- Update `packages/server/src/query.ts` if the reader needs to fold
  the new entry shape into the row set.
- If this changes protocol-visible state (a new field on
  `current.json`, a new `op`, a new storage layout), document it in
  [spec/sync-protocol.md](spec/sync-protocol.md) and add a coverage entry in
  [spec/causal-consistency-checking.md](spec/causal-consistency-checking.md).

### Don't

- ❌ Add a config knob unless it's user-facing. Internal toggles bloat
  `ServerWriterOptions`; prefer a constant in
  `packages/protocol/src/constants.ts`.
- ❌ Reach for `Math.random`, `Date.now`, or `node:fs` directly inside
  `ServerWriter`. The class accepts injected `random` /
  `randomMillis` callbacks and reads time off the `Storage`
  response (`X-Baerly-Server-Time`) for clock correction.
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
  from "@baerly/protocol";
import { BaerlyError } from "@baerly/protocol";

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
import { MemoryStorage } from "@baerly/protocol";

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
2. Runs them through `Db` + `ServerWriter` (often with multiple
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
  await db.table("users").insert(/* something invalid */);
} catch (err) {
  expect((err as BaerlyError).code).toBe("InvalidConfig");
}
```

Don't string-match on `error.message` — those are not stable.

### Performance budget

The full `pnpm test` should stay under ~30s on a developer laptop. If your
test sleeps or polls, prefer `await Promise.resolve()` ticks or short
intervals (≤50ms) to keep the suite snappy.
