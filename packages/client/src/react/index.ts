/**
 * React bindings for `@baerly/client`. Two declarative live-read
 * hooks are the primary surface; consumers almost never need
 * `useInvalidationTick` directly.
 *
 * - {@link useLiveQuery} — live `.where(...).all()`. Returns a
 *   discriminated union over `loading` / `ok` / `error`.
 * - {@link useLiveDocument} — live `.where({ _id }).first()`. Returns
 *   a discriminated union over `loading` / `ok` / `missing` / `error`.
 * - {@link useInvalidationTick} — escape hatch over the raw `/v1/since`
 *   event stream. Returns a monotonic integer that advances on log
 *   events. Use only when you need to invalidate your own caches.
 */

export { useInvalidationTick } from "./use-invalidation-tick.ts";
export type { UseInvalidationTickOptions } from "./use-invalidation-tick.ts";

export { useLiveQuery } from "./use-live-query.ts";
export type { UseLiveQueryOptions, UseLiveQueryResult } from "./use-live-query.ts";

export { useLiveDocument } from "./use-live-document.ts";
export type { UseLiveDocumentOptions, UseLiveDocumentResult } from "./use-live-document.ts";
