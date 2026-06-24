import { describe, expect, test } from "vitest";
import {
  BEARER_JWT_CONFIG_RESOLUTION,
  CLOUDFLARE_ACCESS_CONFIG_RESOLUTION,
  SHARED_SECRET_CONFIG_RESOLUTION,
} from "./auth-resolution.ts";
import {
  CURRENT_JSON_CONTENT_TYPE,
  GC_PENDING_CONTENT_TYPE,
  MANIFEST_POINTER_EMPTY_SNAPSHOT,
  NO_AUTH_CONFIGURED_MESSAGE,
  SHARED_SECRET_MISSING_MESSAGE,
} from "./constants.ts";

describe("wire-contract constants", () => {
  test("CURRENT_JSON_CONTENT_TYPE is an on-bucket contract", () => {
    // Written as the Content-Type header on every current.json PUT;
    // S3/R2 stores and returns it on subsequent GETs.
    expect(CURRENT_JSON_CONTENT_TYPE).toBe("application/json");
  });

  test("GC_PENDING_CONTENT_TYPE is an on-bucket contract", () => {
    // Written as the Content-Type header on every gc/pending.json PUT;
    // S3/R2 stores and returns it on subsequent GETs.
    expect(GC_PENDING_CONTENT_TYPE).toBe("application/json");
  });

  test("MANIFEST_POINTER_EMPTY_SNAPSHOT is an on-wire cursor contract", () => {
    // Serialised into _meta.manifest_pointer on HTTP read responses as
    // "<snapshot>@<tail_hint>" — null snapshots use this literal so the
    // cursor is byte-stable and never empty (e.g. "none@0").
    expect(MANIFEST_POINTER_EMPTY_SNAPSHOT).toBe("none");
  });

  test("NO_AUTH_CONFIGURED_MESSAGE is locked operator-facing wording", () => {
    // Consumed by adapter-cloudflare/worker.ts, adapter-node/server.ts, and
    // cli/doctor/cloudflare.ts — the exact string is an off-process contract
    // that operators and tools match against.
    expect(NO_AUTH_CONFIGURED_MESSAGE).toBe(
      'baerly: no auth configured. Set `auth` in baerly.config.ts ("none", "shared-secret") or pass `verifier` on the adapter factory.',
    );
  });

  test("SHARED_SECRET_MISSING_MESSAGE is locked operator-facing wording", () => {
    // Consumed by adapter-cloudflare/worker.ts, adapter-node/baerly-node.ts,
    // and cli/doctor/cloudflare.ts — the exact string is an off-process
    // contract that operators and tools match against.
    expect(SHARED_SECRET_MISSING_MESSAGE).toBe(
      'baerly: auth="shared-secret" but SHARED_SECRET env is empty/unset. Cloudflare: `wrangler secret put SHARED_SECRET`, or add to .dev.vars for local dev. Node: set in process env.',
    );
  });

  test("SHARED_SECRET_CONFIG_RESOLUTION is locked corrective-action wording", () => {
    expect(SHARED_SECRET_CONFIG_RESOLUTION).toBe(
      'Pass a non-empty `secret` and a non-empty `tenantPrefix` with no "/" to sharedSecret({ secret, tenantPrefix }).',
    );
  });

  test("BEARER_JWT_CONFIG_RESOLUTION is locked corrective-action wording", () => {
    expect(BEARER_JWT_CONFIG_RESOLUTION).toBe(
      'Provide non-empty `issuer`, `audience`, and at least one `algorithms` entry; `tenantClaim` and `tenantPrefix` are mutually exclusive and `tenantPrefix` must be non-empty with no "/".',
    );
  });

  test("CLOUDFLARE_ACCESS_CONFIG_RESOLUTION is locked corrective-action wording", () => {
    expect(CLOUDFLARE_ACCESS_CONFIG_RESOLUTION).toBe(
      "Pass a non-empty `teamDomain` and a 64-char lowercase-hex `audienceTag` (the Application Audience (AUD) tag from the CF Access app config).",
    );
  });
});
