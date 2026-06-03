/**
 * React bindings for `@baerly/client`. Call {@link createBaerlyReact}
 * once with your config type to get a fully typed
 * `{ BaerlyProvider, useQuery, useMutation, useBaerlyClient }` set,
 * then export and import those from your own module:
 *
 * ```ts
 * // src/web/client.ts
 * export const { BaerlyProvider, useQuery, useMutation } =
 *   createBaerlyReact<typeof config>();
 * ```
 *
 * This is the only React entry point. The hooks are not exported
 * loose: an unbound hook can't see the config, so `c.collection(name)`
 * would silently degrade to `DocumentData` rows and force casts.
 * Binding once at the factory keeps every callback inferred.
 *
 * **Reads:** `useQuery(callback, deps?)` — reactive. Subscribes to every
 * collection the callback touches and re-runs on log events or `deps`
 * change. Return `useQuery.skip` to defer / conditional-render.
 *
 * **Mutations:** `useMutation()` → `[mutate, { isPending, error }]`.
 * `mutate(callback)` runs the callback against the real client.
 *
 * **Escape hatch:** `useBaerlyClient()` — the raw bound
 * {@link BaerlyClient} for imperative use.
 */

export { type BaerlyProviderProps, type BaerlyReact, createBaerlyReact } from "./create-react.ts";
export type { UseQueryResult } from "./use-query.ts";
export type { UseMutationTuple } from "./use-mutation.ts";
