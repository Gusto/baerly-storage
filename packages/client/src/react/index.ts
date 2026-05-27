/**
 * React bindings for `@baerly/client`. Wrap your app once in
 * {@link BaerlyProvider}; every hook reads the client from context.
 *
 * **Reads:** {@link useQuery}`(callback, deps?)` — reactive. Subscribes
 * to every table the callback touches and re-runs on log events or
 * `deps` change. Return the exported `useQuery.skip` sentinel from
 * the callback to defer / conditional-render.
 *
 * **Mutations:** {@link useMutation}`()` → `[mutate, { isPending, error }]`.
 * `mutate(callback)` runs the callback against the real client;
 * `isPending` refcounts in-flight calls.
 *
 * **Escape hatch:** {@link useBaerlyClient} — returns the raw
 * {@link BaerlyClient} for imperative use.
 */

export { BaerlyProvider, useBaerlyClient } from "./provider.ts";
export type { BaerlyProviderProps } from "./provider.ts";

export { useQuery } from "./use-query.ts";
export type { UseQueryResult } from "./use-query.ts";

export { useMutation } from "./use-mutation.ts";
export type { UseMutationTuple } from "./use-mutation.ts";
