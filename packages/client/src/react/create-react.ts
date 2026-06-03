import type { BaerlyConfig, UnboundConfig } from "@baerly/protocol";
import type { ReactNode } from "react";
import type { BaerlyClient } from "../client.ts";
import { BaerlyProvider, useBaerlyClient } from "./provider.ts";
import { useMutation, type UseMutationTuple } from "./use-mutation.ts";
import { useQuery, type UseQueryResult } from "./use-query.ts";

/**
 * Props for the config-bound `BaerlyProvider` returned by
 * {@link createBaerlyReact}. `client` is typed `BaerlyClient<TConfig>`
 * to document the intended binding; the hooks carry `TConfig`
 * themselves, so row inference holds regardless of the client value's
 * own inferred type.
 */
export interface BaerlyProviderProps<TConfig extends BaerlyConfig> {
  readonly client: BaerlyClient<TConfig>;
  readonly children?: ReactNode;
}

/**
 * The config-bound React surface returned by {@link createBaerlyReact}.
 * Every hook is pinned to `TConfig`, so `c.collection("notes")` inside
 * a `useQuery` / `useMutation` callback infers the real row type — no
 * `as Promise<Note[]>` cast.
 */
export interface BaerlyReact<TConfig extends BaerlyConfig> {
  /** Wrap your app once; provides the bound client to every hook below it. */
  readonly BaerlyProvider: (props: BaerlyProviderProps<TConfig>) => React.JSX.Element;
  /**
   * Reactive read. The callback receives `BaerlyClient<TConfig>`, so
   * the chain is fully typed. `useQuery.skip` short-circuits to
   * `{ status: "skipped" }`.
   */
  readonly useQuery: {
    <T>(
      callback: (client: BaerlyClient<TConfig>) => Promise<T> | symbol,
      deps?: ReadonlyArray<unknown>,
    ): UseQueryResult<T>;
    /**
     * Sentinel — return it from the callback to defer the read
     * (`{ status: "skipped" }`, no subscription). Typed `symbol` (not
     * the impl's `unique symbol`) so the bound surface stays nameable
     * across the package boundary; identity-compared at runtime.
     */
    readonly skip: symbol;
  };
  /** Imperative mutation hook → `[mutate, { isPending, error }]`. */
  readonly useMutation: () => UseMutationTuple<TConfig>;
  /** Escape hatch — the raw bound {@link BaerlyClient} for imperative use. */
  readonly useBaerlyClient: () => BaerlyClient<TConfig>;
}

/**
 * Build the typed React surface for one `baerly.config.ts`. Call it
 * once at module scope and export the result; every hook is bound to
 * the config so collection names autocomplete and row types infer
 * end-to-end. This is the only React entry point — there are no
 * loose, unbound hooks to import by mistake.
 *
 * @example
 * ```ts
 * // src/web/client.ts
 * import { createBaerlyClient } from "@gusto/baerly-storage/client";
 * import { createBaerlyReact } from "@gusto/baerly-storage/client/react";
 * import config from "../../baerly.config.ts";
 *
 * export const client = createBaerlyClient({ baseUrl: "", config });
 * export const { BaerlyProvider, useQuery, useMutation } =
 *   createBaerlyReact<typeof config>();
 * ```
 *
 * ```tsx
 * // any component
 * import { useQuery } from "./client.ts";
 * const notes = useQuery((c) => c.collection("notes").all(), []);
 * //    ^? UseQueryResult<Note[]>   — no cast
 * ```
 *
 * Omit the type parameter (`createBaerlyReact()`) for an unbound app;
 * collection names widen to `string` and rows to `DocumentData`,
 * matching the in-process `Db.collection` fallback.
 */
export const createBaerlyReact = <
  TConfig extends BaerlyConfig = UnboundConfig,
>(): BaerlyReact<TConfig> => ({
  // Identical runtime implementations — the generic is erased, so the
  // factory only re-pins each hook's type to `TConfig`. The
  // recorder-proxy in `useQuery` is structurally typed as
  // `BaerlyClient`, so binding a narrower config is a no-op at runtime.
  BaerlyProvider: BaerlyProvider as BaerlyReact<TConfig>["BaerlyProvider"],
  useQuery: useQuery as unknown as BaerlyReact<TConfig>["useQuery"],
  useMutation: useMutation as BaerlyReact<TConfig>["useMutation"],
  useBaerlyClient: useBaerlyClient as BaerlyReact<TConfig>["useBaerlyClient"],
});
