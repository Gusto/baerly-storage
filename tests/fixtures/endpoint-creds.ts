/**
 * Shape of a `credentials/<provider>.json` file (gitignored) consumed by
 * the credential-gated integration + bench suites. Unifies what was
 * duplicated as `EndpointCreds` (conformance) and `GcsCreds` (randomized,
 * bench) — all three parse the same file shape.
 *
 * `endpoint` / `region` drive the S3-family endpoints (aws / minio / R2);
 * the native `gcsStorage` ignores them (it pins the GCS XML-API host and
 * signs with GOOG4), so on the GCS path only `bucket` + `credentials`
 * are read.
 */
export interface EndpointCreds {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read `credentials/<file>` and parse it as {@link EndpointCreds}, or
 * return `null` when the file is absent/unreadable (the standard
 * credential-gated skip signal). Callers that want a hard failure on a
 * present-but-broken file should read + parse inline instead.
 */
export async function loadEndpointCreds(file: string): Promise<EndpointCreds | null> {
  try {
    const raw = await readFile(join("credentials", file), "utf8");
    return JSON.parse(raw) as EndpointCreds;
  } catch {
    return null;
  }
}

/**
 * Cloudflare tier selector for credential loading — "paid" (default)
 * uses the standard `credentials/cloudflare*.json` files, "free" uses
 * `credentials/cloudflare*-free.json` files.
 *
 * NOTE: the "free" suffix names a credential set, NEVER a verified Workers
 * plan tier. The 2026-08-20 rehearsal found the account behind
 * `cloudflare-deploy-free.json` does NOT enforce the free plan's 10 ms CPU
 * limit (cpu_ms 52–54 succeeded), i.e. almost certainly a paid plan — see
 * `docs/superpowers/programs/increase-workload-ceiling/runbooks/
 * lane-b-preflight.md` § Q4 before treating `WORKLOAD_CEILING_TIER=free`
 * output as `cf-free` evidence.
 */
export type CloudflareTier = "paid" | "free";

/**
 * Shape of `credentials/cloudflare-deploy.json` (gitignored) — a Cloudflare
 * API token (`Workers Scripts:Edit`, `R2:Edit`, `Account:Read` scopes, per
 * `docs/contributing/day-one-gate.md`) plus account id, repo-scoped so
 * neither has to live in shell env or a global dotfile. Deliberately a
 * separate file from `cloudflare.json`: that one holds R2's S3-family
 * `EndpointCreds` shape, this one holds wrangler/GraphQL-Analytics-API auth,
 * and the two are read by different tools for different purposes.
 */
export interface CloudflareDeployCreds {
  api_token: string;
  account_id: string;
}

/**
 * Resolve the Cloudflare tier from the environment. Returns "free" if
 * `WORKLOAD_CEILING_TIER` is set to "free" (case-insensitive), otherwise
 * returns "paid" as the default.
 */
export function resolveCloudflareTier(): CloudflareTier {
  const tier = process.env["WORKLOAD_CEILING_TIER"]?.toLowerCase().trim();
  return tier === "free" ? "free" : "paid";
}

/**
 * Get the R2 credentials filename for a given tier. Returns
 * `cloudflare.json` for "paid", `cloudflare-free.json` for "free".
 */
export function cloudflareR2CredsFilename(tier: CloudflareTier): string {
  return tier === "free" ? "cloudflare-free.json" : "cloudflare.json";
}

/**
 * Get the Workers API credentials filename for a given tier. Returns
 * `cloudflare-deploy.json` for "paid", `cloudflare-deploy-free.json` for "free".
 */
export function cloudflareDeployCredsFilename(tier: CloudflareTier): string {
  return tier === "free" ? "cloudflare-deploy-free.json" : "cloudflare-deploy.json";
}

/**
 * Read `credentials/cloudflare-deploy.json` and parse it as
 * {@link CloudflareDeployCreds}, or return `null` when the file is
 * absent/unreadable — the same credential-gated skip signal as
 * {@link loadEndpointCreds}.
 *
 * @deprecated Use {@link loadCloudflareDeployCredsForTier} instead for
 *   tier-aware credential loading. This function is retained for backward
 *   compatibility with existing callers that don't need tier selection.
 */
export async function loadCloudflareDeployCreds(): Promise<CloudflareDeployCreds | null> {
  try {
    const raw = await readFile(join("credentials", "cloudflare-deploy.json"), "utf8");
    return JSON.parse(raw) as CloudflareDeployCreds;
  } catch {
    return null;
  }
}

/**
 * Read Cloudflare Workers API credentials for the specified tier.
 * Uses `cloudflare-deploy.json` for "paid" tier, `cloudflare-deploy-free.json`
 * for "free" tier. Returns `null` when the file is absent/unreadable.
 */
export async function loadCloudflareDeployCredsForTier(
  tier: CloudflareTier,
): Promise<CloudflareDeployCreds | null> {
  try {
    const filename = cloudflareDeployCredsFilename(tier);
    const raw = await readFile(join("credentials", filename), "utf8");
    return JSON.parse(raw) as CloudflareDeployCreds;
  } catch {
    return null;
  }
}

/**
 * Load Cloudflare Workers API credentials, using the tier from
 * `WORKLOAD_CEILING_TIER` environment variable (defaulting to "paid").
 * This is the preferred method for workload-ceiling tools.
 */
export async function loadCloudflareDeployCredsWithEnvTier(): Promise<CloudflareDeployCreds | null> {
  return loadCloudflareDeployCredsForTier(resolveCloudflareTier());
}

/**
 * Load R2 credentials for the specified tier. Uses `cloudflare.json` for
 * "paid" tier, `cloudflare-free.json` for "free" tier. Returns `null`
 * when the file is absent/unreadable.
 */
export async function loadCloudflareR2CredsForTier(
  tier: CloudflareTier,
): Promise<EndpointCreds | null> {
  return loadEndpointCreds(cloudflareR2CredsFilename(tier));
}

/**
 * Load R2 credentials, using the tier from `WORKLOAD_CEILING_TIER`
 * environment variable (defaulting to "paid"). This is the preferred method
 * for workload-ceiling tools.
 */
export async function loadCloudflareR2CredsWithEnvTier(): Promise<EndpointCreds | null> {
  return loadCloudflareR2CredsForTier(resolveCloudflareTier());
}
