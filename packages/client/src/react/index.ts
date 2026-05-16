/**
 * React bindings for `@baerly/client`. Two declarative live-read
 * hooks are the primary surface; consumers almost never need
 * `useChanges` directly.
 *
 * - {@link useLiveQuery} — live `.where(...).all()`. Returns `rows`.
 * - {@link useLiveDocument} — live `.where({ _id }).first()`.
 *   Returns `row`.
 * - {@link useChanges} — escape hatch over the raw `/v1/since`
 *   event stream. Use only for custom reducers, debug overlays, or
 *   accumulating feeds.
 */

export { useChanges } from "./use-changes.ts";
export type { UseChangesOptions, UseChangesResult } from "./use-changes.ts";

export { useLiveQuery } from "./use-live-query.ts";
export type { UseLiveQueryOptions, UseLiveQueryResult } from "./use-live-query.ts";

export { useLiveDocument } from "./use-live-document.ts";
export type { UseLiveDocumentOptions, UseLiveDocumentResult } from "./use-live-document.ts";
