# Followups — client-dx-types-and-fetcher-docs branch

Branch: `worktree-client-dx-types-and-fetcher-docs` (will merge into local main).
Started: 2026-05-17.

These survive the merge and are picked up by the next branch.

## Pre-publish polish (T2 code review)

Surfaced during T2 (`02-client-typed-config.md`) code review. All deferrable — `@baerly/client` is `private: true` so today's behavior is unchanged. Address before the package is published.

- **`@baerly/server` dep kind on `@baerly/client`.** Today added to `dependencies` (`packages/client/package.json`); imports from it are type-only. When `@baerly/client` is published, every consumer pulls `@baerly/server`'s transitive set (hono + logtape + picocolors) even when they don't bind a config. Move to either:
  - `devDependencies` — types still flow via TS bundler resolution; consumers must install `@baerly/server` themselves if they want bound configs (they already do, since the kernel is the main runtime).
  - `peerDependencies` with `peerDependenciesMeta: { optional: true }` — mirrors the existing `react` pattern on `@baerly/client`.
- **Hoist `Equal` / `Expect` type-assert helpers.** Currently duplicated in `packages/server/src/config.test-d.ts` (T1) and `packages/client/src/client.test-d.ts` (T2). T3's `.test-d.ts` will be a third copy. Pull to a shared module (`tests/fixtures/type-assert.ts` or `packages/protocol/src/test-utils.ts`) when the third copy appears or anytime after.
- **Document the schemaless-collection fallback** in `BaerlyClient<TConfig>.table()` JSDoc (`packages/client/src/client.ts:142-149`). `RowOf<C, "name">` for a collection declared without a schema falls through to `Record<string, unknown>`, intersected with `JSONArraylessObject` it collapses to `JSONArraylessObject` rows — same as the legacy `<T>` overload. Worth one sentence so callers don't expect a stricter type.
- **Normalize `@example` style** at `packages/client/src/client.ts:60`. Existing `@example` blocks use inline string literals (`baseUrl: "https://api.example.com"`); the new one uses bare `baseUrl` referencing an implied outer scope. Pick one style and apply consistently across the file.

## Post-T3 polish (T3 code review)

- **Add a negative-case test-d assertion** to `packages/server/src/config.test-d.ts` documenting the unknown-collection-name fallthrough. Today `db.table("notACollection")` under a bound `TConfig` silently resolves to overload #2 (`Table<JSONArraylessObject>`) rather than producing a type error — identical behavior to `BaerlyClient.table`. The happy-path assertion (lines 97-104) doesn't exercise this. Suggested append: an assertion that `typeof typoRow extends JSONArraylessObject | undefined`. Locks in the documented intent and prevents accidental regression if a future "narrow only" single-overload pattern lands.
- **Inline comment on the `db.table` overload triplet** at `packages/server/src/db.ts:399-405`. The three-signature pattern's resolution order (narrow #1, legacy #2, impl widest) and the byte-identicality reasoning for `makeTable<JSONArraylessObject>` are not obvious without reading the ticket. Add a short comment block above the first signature.
- **Update `config.test-d.ts` header comment** at line 1-7 to reflect that the file now covers types from two modules (`config` + `db`) — T3 appended Db assertions but the header still reads as if it covers only `RowOf` / `CollectionNames`.

## Post-T5 polish (T5 code review)

- **Re-export `Fetcher` from `@baerly/client/index.ts`.** Today the guide page inlines `type Fetcher = (req: Request) => Promise<Response>` in each recipe because `Fetcher` isn't on the public surface. One re-export line removes the boilerplate from every code block. (`packages/client/src/request.ts:9` is the source.)
- **Tighten `ClientTable` generic in the "what this is not" example** (`docs/guide/client-middleware.md:184`). Currently uses `ClientTable` with no generic param (defaults to `JSONArraylessObject`). Explicit `ClientTable<JSONArraylessObject>` or a concrete row type would teach the generic shape better.
- **Document the "no infinite loop" property of `withAuthRefresh`** (`docs/guide/client-middleware.md:112-125`). Add one sentence: "If the refreshed call also returns 401, this wrapper returns that response without retrying again." Hardens the recipe against being mis-copied into a loop.
