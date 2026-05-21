import { createContext, createElement, useContext, type ReactNode } from "react";
import type { BaerlyConfig, UnboundConfig } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";

const ClientContext = createContext<BaerlyClient | undefined>(undefined);

export interface BaerlyProviderProps {
  readonly client: BaerlyClient;
  readonly children?: ReactNode;
}

/**
 * Provides a {@link BaerlyClient} to every Baerly React hook below it.
 * Wrap your app once near the root; the hooks read the client from
 * this context and have no `client` argument.
 *
 * @example
 * ```tsx
 * import { createBaerlyClient } from "baerly-storage/client";
 * import { BaerlyProvider } from "baerly-storage/client/react";
 *
 * const client = createBaerlyClient({ baseUrl: "/api" });
 *
 * <BaerlyProvider client={client}>
 *   <App />
 * </BaerlyProvider>
 * ```
 */
export const BaerlyProvider = ({ client, children }: BaerlyProviderProps): React.JSX.Element =>
  createElement(ClientContext.Provider, { value: client }, children);

/**
 * Returns the {@link BaerlyClient} provided by the nearest
 * {@link BaerlyProvider}. Throws a clear error if called outside a
 * provider — every hook in this package uses it, so a missing
 * provider surfaces here first.
 *
 * Use this directly when you need imperative access — e.g. inside an
 * event handler that performs a one-shot read or a custom long-poll.
 * For declarative reads and mutations, prefer the typed hooks.
 *
 * @example
 * ```tsx
 * const client = useBaerlyClient<MyConfig>();
 * const onExport = async () => {
 *   const rows = await client.table("tickets").all();
 *   download(rows);
 * };
 * ```
 */
export const useBaerlyClient = <
  TConfig extends BaerlyConfig = UnboundConfig,
>(): BaerlyClient<TConfig> => {
  const client = useContext(ClientContext);
  if (client === undefined) {
    throw new Error(
      "useBaerlyClient (and every Baerly React hook) must be used inside <BaerlyProvider>. " +
        "Wrap your app: <BaerlyProvider client={client}>…</BaerlyProvider>.",
    );
  }
  return client as BaerlyClient<TConfig>;
};
