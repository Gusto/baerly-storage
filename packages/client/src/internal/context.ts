import type { BaerlyClient } from "../client.ts";
import type { RequestContext } from "../request.ts";

/**
 * Symbol-keyed slot on every `BaerlyClient` carrying the internal
 * `RequestContext`. Lets internals (e.g. the React
 * `subscription-pool`) reach the same fetcher / headers resolution
 * the typed API uses, without widening the public `BaerlyClient`
 * surface.
 *
 * Symbol is module-scoped — users cannot import it from package
 * internals, so the slot is invisible outside this package.
 */
export const CLIENT_CONTEXT: unique symbol = Symbol("baerly.client.context");

interface ClientWithContext {
  readonly [CLIENT_CONTEXT]: RequestContext;
}

/**
 * Returns the internal `RequestContext` stashed on `client` by
 * `createBaerlyClient`. Throws if called with a client not produced
 * by `createBaerlyClient` (e.g. a test stub) — that is the right
 * signal for callers, who in production have no other way to obtain
 * a `BaerlyClient` instance.
 */
export const getClientContext = (client: BaerlyClient): RequestContext => {
  const ctx = (client as unknown as Partial<ClientWithContext>)[CLIENT_CONTEXT];
  if (ctx === undefined) {
    throw new Error(
      "getClientContext: client was not produced by createBaerlyClient (missing internal context slot)",
    );
  }
  return ctx;
};
