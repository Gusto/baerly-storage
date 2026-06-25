import type { BaerlyConfig, Verifier } from "@baerly/protocol";
import type { SpecIR } from "./ir.ts";
import rawSpecIr from "../../spec/baerly.spec.json" with { type: "json" };

// Import the JSON as data (not ir.ts which drags the HTTP router into
// the kernel closure). Cast to SpecIR so callers get typed access to
// errorCodes, specVersion, etc. without following the ir.ts import chain.
const specIr = rawSpecIr as unknown as SpecIR;

/** A declared collection summary, emitted only to authed callers. */
export interface SpecCollection {
  readonly name: string;
  readonly indexes: ReadonlyArray<string>;
  readonly schemaVendor?: string;
}

/** The /v1/spec response: the static IR plus an optional authed collections section. */
export type SpecResponse = SpecIR & { collections?: ReadonlyArray<SpecCollection> };

/**
 * Build the /v1/spec response body. With no `config` (anonymous caller)
 * the static contract IR is returned verbatim. With a `config` (the
 * request already carried a valid identity), the declared collection
 * names + index names + schema vendor are appended — these are gated
 * behind the verifier so unauthenticated callers can't enumerate tenant
 * collection names.
 */
export function buildSpecResponse(config?: BaerlyConfig): SpecResponse {
  if (config === undefined) {
    return specIr as SpecResponse;
  }
  const collections: SpecCollection[] = Object.entries(config.collections).map(
    ([name, def]): SpecCollection => {
      const indexes = (def.indexes ?? []).map((ix) => ix.name);
      if (def.schema !== undefined) {
        return { name, indexes, schemaVendor: def.schema["~standard"].vendor };
      }
      return { name, indexes };
    },
  );
  return { ...(specIr as SpecResponse), collections };
}

// Shared `GET /v1/spec` handler for both adapters (keeps the response shape
// from drifting). `resolve` yields the adapter's verifier + tenant config.
// Run tolerantly: any `resolve` or verifier failure degrades to the anonymous
// static contract — it is public infra that must stay up when auth/config is
// unhealthy. Collections are appended only for a non-null identity, so an
// unauthenticated probe never enumerates them.
export async function handleSpecRequest(
  request: Request,
  resolve: () => Promise<{ verifier: Verifier; config: BaerlyConfig | undefined }>,
): Promise<Response> {
  let config: BaerlyConfig | undefined;
  try {
    const { verifier, config: resolved } = await resolve();
    const identity = await verifier(request);
    if (identity !== null) {
      config = resolved;
    }
  } catch (error) {
    // A verifier *reject* is `null` (handled above); reaching here means
    // resolve() or the verifier *threw* — the auth backend or tenant config
    // is unhealthy. Stay tolerant (the static contract is public infra and
    // must stay up), but emit one operational signal so the outage isn't
    // invisible on this anonymous, pre-observability route. `console.warn`
    // (not a canonical line) matches the adapters' other ops warnings and
    // keeps this light module out of the observability closure.
    console.warn("[baerly] /v1/spec degraded to the anonymous contract:", error);
  }
  return new Response(JSON.stringify(buildSpecResponse(config)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
