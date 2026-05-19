# `@baerly/client` small polish: stableKey coverage, polyfill, type re-exports

**Severity: LOW. Three small DX/cleanliness items, ~30 min of
combined work. Bundle for a single PR.**

## 1. `stableKey` lacks test coverage for operator-shape predicates

`packages/client/src/stable-key.ts:18-29`'s comment claims
predicates carry `JSONArraylessObject`, but per
`@baerly/protocol/src/db.ts`, `Predicate<T>` supports operator
shapes:

```ts
{ status: { $in: ["open", "p1"] } }
{ priority: { $gt: 3 } }
```

The implementation does stringify operators correctly (the
recursive descent handles any JSON-serializable value), so the
analyst's "blind spot" framing is overstated — it isn't broken.
But the test files (`use-live-query.test.ts`,
`use-live-document.test.ts`) have zero tests over operator-shape
predicates. The first time someone writes:

```tsx
useLiveQuery(client, "tickets", { priority: { $in: [1, 2, 3] } });
```

…they're trusting an untested code path.

**Fix:** Add 2-3 test cases to the relevant `*.test.ts` file:

```ts
test("stableKey is stable across array order in $in", () => {
  expect(stableKey({ p: { $in: ["a", "b"] } }))
    .toBe(stableKey({ p: { $in: ["a", "b"] } }));
});
test("stableKey distinguishes $gt from $lt", () => {
  expect(stableKey({ p: { $gt: 1 } }))
    .not.toBe(stableKey({ p: { $lt: 1 } }));
});
```

Coverage gap closed; no implementation change needed.

## 2. `findLast` polyfill is dead weight

`packages/client/src/use-live-document.ts:108-121` implements a
polyfill for `Array.prototype.findLast`. The native method is
baseline since July 2022 — Node 20+, Workerd, all modern
browsers. Line 64 even calls it via optional chaining
(`events.findLast?.(...)`), defensively guarding against a
runtime that won't be encountered in practice.

`@baerly/client` peer-depends on a modern runtime (the rest of
the codebase targets ES2025). Pinning a 2022-baseline method as
"polyfill-required" is inconsistent.

**Fix:** Delete the polyfill block. Use `events.findLast(...)`
directly (drop the `?.`). The runtime supports it.

## 3. `@baerly/client/index.ts` doesn't re-export protocol types

`packages/client/src/index.ts` exports the client's own
surface — `createBaerlyClient`, `BaerlyClient`,
`BaerlyClientOptions`, `ClientQuery`, `ClientTable`,
`BaerlyClientError`, `Fetcher` — but **not** the protocol types
that appear on the public method signatures and result shapes:

- `Predicate`
- `OrderSpec`
- `ConsistencyLevel`
- `JSONArraylessObject` (or `BaerlyDocument`, per analyst A8)
- `LogEntry`
- `BaerlyErrorCode`

So a user writing:

```ts
import { createBaerlyClient } from "@baerly/client";
import type { Predicate, ConsistencyLevel } from "@baerly/protocol";
//                                              ^ second import
```

…has to dual-import. Single-import is the table-stakes DX bar.

**Fix:** Re-export the six types from `@baerly/client/index.ts`:

```ts
export type {
  Predicate,
  OrderSpec,
  ConsistencyLevel,
  JSONArraylessObject,
  LogEntry,
  BaerlyErrorCode,
} from "@baerly/protocol";
```

Coordinate with A1 (`unify-baerly-storage.md`) — if the
public-package decision lands as "consolidate to
`baerly-storage`," the re-export source changes but the surface
goal is the same.

## Why bundle

Three small items, ~30 minutes total, same package, same PR.
None requires architectural alignment. All three reduce friction
for users who write code against the client today.

## Cross-references

- A8 (analyst's): `JSONArraylessObject` → `BaerlyDocument` rename.
  If that lands first, re-export the new name; if not, re-export
  the existing one and rename later. Either way, the bullet here
  doesn't change.
- A1 (`unify-baerly-storage.md`) governs the import path; this
  doc covers the export side only.
