import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_GCS_ENDPOINT } from "@baerly/adapter-node";
import { parseBucketUri } from "./bucket-uri.ts";

describe("parseBucketUri — gcs://", () => {
  beforeEach(() => {
    vi.stubEnv("BAERLY_GCS_HMAC_ACCESS_KEY_ID", "GOOG1ETESTKEY");
    vi.stubEnv("BAERLY_GCS_HMAC_SECRET", "test-secret");
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
    vi.stubEnv("BAERLY_GCS_HMAC_ACCESS_KEY_ID", undefined);
    await expect(parseBucketUri("gcs://my-bucket")).rejects.toMatchObject({
      code: "InvalidConfig",
    });
  });
});
