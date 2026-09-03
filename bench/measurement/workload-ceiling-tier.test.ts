import { describe, expect, test } from "vitest";
import {
  cloudflareDeployCredsFilename,
  cloudflareR2CredsFilename,
} from "../../tests/fixtures/endpoint-creds.ts";
import { WorkloadCeilingHarnessError } from "./workload-ceiling-harness.ts";
import { resolveWorkloadCeilingTier } from "./workload-ceiling-tier.ts";

describe("resolveWorkloadCeilingTier", () => {
  test("unset resolves to paid", () => {
    expect(resolveWorkloadCeilingTier({})).toBe("paid");
  });

  test("blank resolves to paid like unset", () => {
    expect(resolveWorkloadCeilingTier({ WORKLOAD_CEILING_TIER: "   " })).toBe("paid");
  });

  test.each([
    ["free", "free"],
    ["paid", "paid"],
    ["FREE", "free"],
    ["  free  ", "free"],
  ])("%j resolves to %j", (raw, expected) => {
    expect(resolveWorkloadCeilingTier({ WORKLOAD_CEILING_TIER: raw })).toBe(expected);
  });

  // The whole point of the strict check: a typo used to resolve to `paid`,
  // so the run provisioned, deployed, and collected against an account the
  // operator never named while writing evidence that read as legitimate.
  test.each(["fre", "Free tier", "0", "true"])("%j is rejected by name", (raw) => {
    try {
      resolveWorkloadCeilingTier({ WORKLOAD_CEILING_TIER: raw });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkloadCeilingHarnessError);
      expect((error as WorkloadCeilingHarnessError).field).toBe("WORKLOAD_CEILING_TIER");
    }
  });
});

describe("tier credential filenames", () => {
  test("each tier names its own credential files", () => {
    expect(cloudflareDeployCredsFilename("paid")).toBe("cloudflare-deploy.json");
    expect(cloudflareDeployCredsFilename("free")).toBe("cloudflare-deploy-free.json");
    expect(cloudflareR2CredsFilename("paid")).toBe("cloudflare.json");
    expect(cloudflareR2CredsFilename("free")).toBe("cloudflare-free.json");
  });
});
