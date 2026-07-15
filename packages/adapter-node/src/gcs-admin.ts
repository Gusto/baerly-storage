/**
 * GCS bucket-administration probes over the native XML API — read-only
 * config checks that fall outside the four-verb `Storage` interface.
 * Kept in the adapter so GCS wire details (endpoint/URL shape, the
 * `?versioning` sub-resource, the XML response, GOOG4 signing) live
 * behind the adapter boundary rather than leaking into the CLI.
 */

import { DEFAULT_GCS_ENDPOINT } from "./gcs-http.ts";
import { goog4Signer } from "./credentials/goog4-signer.ts";
import type { Credentials, CredentialsProvider } from "./credentials/types.ts";

/** Case-sensitive per the GCS `?versioning` XML shape; tolerate surrounding whitespace. */
const VERSIONING_ENABLED_RE = /<Status>\s*Enabled\s*<\/Status>/;

/**
 * Result of {@link gcsVersioningStatus}. `inconclusive` carries a
 * human-readable `reason` (an `HTTP <status>` string, or a thrown
 * error's message) so a diagnostic caller can explain why the probe
 * couldn't decide without re-deriving it.
 */
export type GcsVersioningStatus =
  | { readonly kind: "enabled" }
  | { readonly kind: "disabled" }
  | { readonly kind: "inconclusive"; readonly reason: string };

/**
 * Read a GCS bucket's Object Versioning setting over the native XML API
 * (`GET <endpoint>/<bucket>?versioning`), signed with GOOG4-HMAC-SHA256.
 * Never throws — a non-2xx response or a network error resolves to
 * `{ kind: "inconclusive", reason }`, so callers (e.g. `baerly doctor`)
 * can degrade gracefully instead of aborting.
 */
export async function gcsVersioningStatus(opts: {
  bucket: string;
  credentials: Credentials | CredentialsProvider;
  /** Defaults to the native GCS host. */
  endpoint?: string;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
}): Promise<GcsVersioningStatus> {
  const endpoint = (opts.endpoint ?? DEFAULT_GCS_ENDPOINT).replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const sign = goog4Signer({ credentials: opts.credentials });
  const url = `${endpoint}/${opts.bucket}?versioning`;
  try {
    const signed = await sign(new Request(url, { method: "GET" }));
    const res = await fetchImpl(signed);
    if (!res.ok) {
      return { kind: "inconclusive", reason: `HTTP ${res.status}` };
    }
    const body = await res.text();
    return VERSIONING_ENABLED_RE.test(body) ? { kind: "enabled" } : { kind: "disabled" };
  } catch (error) {
    return {
      kind: "inconclusive",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
