import { describe, expect, test } from "vitest";
import { PAAS_MARKERS, isDeployedEnv } from "./env.ts";

describe("isDeployedEnv", () => {
  test("empty env is not deployed (local dev / test default)", () => {
    expect(isDeployedEnv({})).toBe(false);
  });

  test("NODE_ENV=production is deployed", () => {
    expect(isDeployedEnv({ NODE_ENV: "production" })).toBe(true);
  });

  test("NODE_ENV=test / development is not deployed", () => {
    expect(isDeployedEnv({ NODE_ENV: "test" })).toBe(false);
    expect(isDeployedEnv({ NODE_ENV: "development" })).toBe(false);
  });

  test("CI=true alone is not deployed (plain GitHub Actions)", () => {
    expect(isDeployedEnv({ CI: "true" })).toBe(false);
  });

  test("each PaaS marker independently trips the signal", () => {
    for (const marker of PAAS_MARKERS) {
      expect(isDeployedEnv({ [marker]: "1" })).toBe(true);
    }
  });

  test("a PaaS marker set to empty string does not trip the signal", () => {
    for (const marker of PAAS_MARKERS) {
      expect(isDeployedEnv({ [marker]: "" })).toBe(false);
    }
  });

  test("CI suppresses PaaS markers (k8s-hosted CI agent)", () => {
    for (const marker of PAAS_MARKERS) {
      expect(isDeployedEnv({ [marker]: "1", CI: "true" })).toBe(false);
    }
  });

  test("CI does not suppress an explicit NODE_ENV=production", () => {
    expect(isDeployedEnv({ NODE_ENV: "production", CI: "true" })).toBe(true);
  });

  test("CI=false does not suppress (a literal non-CI value)", () => {
    expect(isDeployedEnv({ KUBERNETES_SERVICE_HOST: "1", CI: "false" })).toBe(true);
  });
});
