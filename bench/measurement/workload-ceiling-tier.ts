/**
 * Which Cloudflare account every Node-side tool in the capture talks to.
 *
 * `WORKLOAD_CEILING_TIER` is one operator decision with four consumers that
 * must agree: `workload-ceiling-provision.ts` writes fixtures into that
 * account's bucket, `workload-ceiling-provision-sweep.ts` calibrates against
 * it, `bench/workload-ceiling-worker/deploy.mjs` deploys the study Worker
 * into it, and `workload-ceiling-collect.ts` queries its telemetry. A value
 * none of them recognizes has to stop the run rather than resolve to one:
 * coercing `WORKLOAD_CEILING_TIER=fre` to `paid` provisions, deploys, and
 * collects against an account the operator never named, and the evidence it
 * writes carries no trace of the substitution. Its sibling knob
 * `WORKLOAD_CEILING_THERMAL_CLASS` already fails loud, and this one decides
 * more.
 *
 * It lives here rather than in `workload-ceiling-harness.ts` because that
 * module is imported by the deployed Worker (`tsconfig.cloudflare.json`), and
 * operator credential vocabulary does not belong in the Workers program. It
 * lives here rather than in `tests/fixtures/endpoint-creds.ts` because that
 * fixture is shared with the credential-gated conformance and randomized
 * suites, which have no `WORKLOAD_CEILING_TIER`.
 */
import { CLOUDFLARE_TIERS, type CloudflareTier } from "../../tests/fixtures/endpoint-creds.ts";
import { WorkloadCeilingHarnessError } from "./workload-ceiling-harness.ts";

/**
 * Pure. Resolves the credential tier from an env bag, defaulting to `paid`
 * when unset or blank and rejecting anything else by name.
 *
 * Case and surrounding whitespace are forgiven — an operator exporting
 * `WORKLOAD_CEILING_TIER=Free` meant `free`, and silently reading that as
 * `paid` is the failure this function exists to prevent.
 */
export function resolveWorkloadCeilingTier(
  env: Record<string, string | undefined>,
): CloudflareTier {
  const raw = env["WORKLOAD_CEILING_TIER"];
  if (raw === undefined || raw.trim() === "") {
    return "paid";
  }
  const tier = raw.toLowerCase().trim();
  if (!(CLOUDFLARE_TIERS as readonly string[]).includes(tier)) {
    throw new WorkloadCeilingHarnessError(
      "WORKLOAD_CEILING_TIER",
      `must be one of ${CLOUDFLARE_TIERS.join(", ")}; got ${JSON.stringify(raw)}`,
    );
  }
  return tier as CloudflareTier;
}
