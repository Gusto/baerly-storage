/**
 * Unit tests for `checkIndexFilterDrift`.
 *
 * The happy-path coverage (drift detected → warning, in-sync → ok,
 * auto-rebuild → info) lives in the per-backend doctor tests, where
 * the dispatcher seam is exercised end-to-end. These tests pin the
 * environment-sensitive and configuration-shape error branches:
 *
 *   - No collections declared → single `info` finding.
 *   - No filtered indexes declared → single `info` finding.
 *   - Missing storage env vars → single `error` finding scoped to
 *     `index-filter-drift.env`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AppConfig, LoadedCollection } from "../config.ts";
import { checkIndexFilterDrift } from "./index-filter-drift.ts";

const APP: AppConfig = {
  app: "test",
  tenant: "t",
  target: "node",
  repoRoot: "/tmp/index-filter-drift-test",
};

const STORAGE_ENV_KEYS = ["BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const;

describe("checkIndexFilterDrift", () => {
  let savedEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedEnv = {};
    for (const k of STORAGE_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of STORAGE_ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  test("emits one info finding when no collections are declared", async () => {
    const findings = await checkIndexFilterDrift(APP, undefined);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.check).toBe("index-filter-drift");
    expect(findings[0]!.message).toMatch(/No collections declared/);
  });

  test("emits one info finding when collections declare no filtered indexes", async () => {
    const collections: LoadedCollection[] = [
      { name: "users", indexes: [] },
      { name: "tickets", indexes: [{ name: "by_status", on: "status" }] },
    ];
    const findings = await checkIndexFilterDrift(APP, collections);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.message).toMatch(/No filtered indexes/);
  });

  test("emits one error finding when required storage env vars are missing", async () => {
    const collections: LoadedCollection[] = [
      {
        name: "users",
        indexes: [{ name: "admins", on: "role", predicate: { role: "admin" } }],
      },
    ];
    const findings = await checkIndexFilterDrift(APP, collections);
    const err = findings.find((f) => f.check === "index-filter-drift.env");
    expect(err).toBeDefined();
    expect(err!.severity).toBe("error");
    expect(err!.message).toContain("BUCKET");
    expect(err!.message).toContain("AWS_ACCESS_KEY_ID");
    expect(err!.message).toContain("AWS_SECRET_ACCESS_KEY");
    expect(err!.fix).toContain("S3_ENDPOINT");
  });

  test("error finding lists only the missing env vars (partial coverage)", async () => {
    process.env["BUCKET"] = "test-bucket";
    process.env["AWS_ACCESS_KEY_ID"] = "AKIA";
    // AWS_SECRET_ACCESS_KEY intentionally absent.
    const collections: LoadedCollection[] = [
      {
        name: "users",
        indexes: [{ name: "admins", on: "role", predicate: { role: "admin" } }],
      },
    ];
    const findings = await checkIndexFilterDrift(APP, collections);
    const err = findings.find((f) => f.check === "index-filter-drift.env");
    expect(err).toBeDefined();
    expect(err!.message).not.toContain("BUCKET,");
    expect(err!.message).not.toContain("AWS_ACCESS_KEY_ID,");
    expect(err!.message).toContain("AWS_SECRET_ACCESS_KEY");
  });
});
