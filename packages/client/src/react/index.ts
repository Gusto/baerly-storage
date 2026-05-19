/**
 * React bindings for `@baerly/client`. Wrap your app once in
 * {@link BaerlyProvider}; every hook here reads the client from
 * context.
 *
 * **Reads:**
 * - {@link useLiveQuery} — live `.where(where).all()`. Returns a
 *   discriminated union over `loading` / `ok` / `error`.
 * - {@link useLiveDocument} — live `.where({ _id }).first()`. Returns
 *   a discriminated union over `loading` / `ok` / `missing` / `error`.
 * - {@link useInvalidationTick} — escape hatch over the raw
 *   `/v1/since` event stream; advances on log events. Use only when
 *   you need to invalidate your own caches.
 *
 * **Mutations:**
 * - {@link useInsert} — `mutate(doc)` → `{ _id }`.
 * - {@link useUpdate} — `mutate(id, patch)` → `{ modified }` (JSON-merge-patch).
 * - {@link useReplace} — `mutate(id, doc)` → `void` (whole-document overwrite).
 * - {@link useDelete} — `mutate(id)` → `{ deleted }` (`0 | 1`).
 *
 * **Escape hatch:**
 * - {@link useBaerlyClient} — returns the provided {@link BaerlyClient}
 *   for imperative use.
 */

export { BaerlyProvider, useBaerlyClient } from "./provider.ts";
export type { BaerlyProviderProps } from "./provider.ts";

export { useInvalidationTick } from "./use-invalidation-tick.ts";
export type { UseInvalidationTickOptions } from "./use-invalidation-tick.ts";

export { useLiveQuery } from "./use-live-query.ts";
export type { UseLiveQueryOptions, UseLiveQueryResult } from "./use-live-query.ts";

export { useLiveDocument } from "./use-live-document.ts";
export type { UseLiveDocumentOptions, UseLiveDocumentResult } from "./use-live-document.ts";

export { useInsert } from "./use-insert.ts";
export type { UseInsertOptions, UseInsertResult } from "./use-insert.ts";

export { useUpdate } from "./use-update.ts";
export type { UseUpdateOptions, UseUpdateResult } from "./use-update.ts";

export { useReplace } from "./use-replace.ts";
export type { UseReplaceOptions, UseReplaceResult } from "./use-replace.ts";

export { useDelete } from "./use-delete.ts";
export type { UseDeleteOptions, UseDeleteResult } from "./use-delete.ts";
