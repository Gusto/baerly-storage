import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_GCS_ENDPOINT } from "@baerly/adapter-node";
import { parseBucketUri } from "./bucket-uri.ts";

// Save/restore only the GCS HMAC env vars this suite mutates, so it can't
// leak into (or be perturbed by) the ambient environment.
const GCS_ENV_KEYS = ["BAERLY_GCS_HMAC_ACCESS_KEY_ID", "BAERLY_GCS_HMAC_SECRET"] as const;

describe("parseBucketUri — gcs://", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of GCS_ENV_KEYS) {
      saved[k] = process.env[k];
    }
    process.env["BAERLY_GCS_HMAC_ACCESS_KEY_ID"] = "GOOG1ETESTKEY";
    process.env["BAERLY_GCS_HMAC_SECRET"] = "test-secret";
  });

  afterEach(() => {
    for (const k of GCS_ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  test("resolves a bare bucket to the native GCS endpoint + HMAC creds from env", async () => {
    const parsed = await parseBucketUri("gcs://my-bucket");
    expect(parsed.keyPrefix).toBe("");
    expect(parsed.gcs).toEqual({
      endpoint: DEFAULT_GCS_ENDPOINT,
      bucket: "my-bucket",
      credentials: { accessKeyId: "GOOG1ETESTKEY", secretAccessKey: "test-secret" },
    });
    // A constructed Storage handle (no network at construction time).
    expect(typeof parsed.storage.get).toBe("function");
    expect(typeof parsed.storage.put).toBe("function");
  });

  test("parses and normalizes a key prefix (adds trailing slash)", async () => {
    const parsed = await parseBucketUri("gcs://my-bucket/tenants/acme");
    expect(parsed.gcs?.bucket).toBe("my-bucket");
    expect(parsed.keyPrefix).toBe("tenants/acme/");
  });

  test("rejects an empty bucket name with InvalidConfig", async () => {
    await expect(parseBucketUri("gcs://")).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("rejects a missing HMAC env var with InvalidConfig", async () => {
    delete process.env["BAERLY_GCS_HMAC_ACCESS_KEY_ID"];
    await expect(parseBucketUri("gcs://my-bucket")).rejects.toMatchObject({
      code: "InvalidConfig",
    });
  });
});
