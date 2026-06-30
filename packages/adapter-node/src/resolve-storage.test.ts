import { describe, expect, test } from "vitest";
import { resolveStorageFromEnv } from "./resolve-storage.ts";

// Canonical coverage for the exported storage resolver. The Node example
// scaffolds re-export this, so an app that uses the safe default cannot
// reintroduce the silent non-durable fallback that lost data in
// production (Gusto/web#24499). The example re-export is drift-fenced in
// tests/integration/node-storage-resolution.test.ts.

const FULL_AWS_CREDS = {
  AWS_ACCESS_KEY_ID: "ak",
  AWS_SECRET_ACCESS_KEY: "sk",
} as const;

describe("resolveStorageFromEnv — local dev fallback", () => {
  test("falls back to local-fs when no bucket and not deployed", () => {
    const { storage, label } = resolveStorageFromEnv({});
    expect(storage).toBeDefined();
    expect(label).toContain("local-fs");
    expect(label).toContain("not a production store");
  });

  test("local-fs label reflects BAERLY_DATA_DIR when set", () => {
    const { label } = resolveStorageFromEnv({ BAERLY_DATA_DIR: "/data/here" });
    expect(label).toContain("/data/here");
  });
});

describe("resolveStorageFromEnv — bucket selection", () => {
  test("BUCKET → s3, even in a deployment", () => {
    const { storage, label } = resolveStorageFromEnv({
      NODE_ENV: "production",
      BUCKET: "my-bucket",
      ...FULL_AWS_CREDS,
    });
    expect(storage).toBeDefined();
    expect(label).toBe("s3 (bucket=my-bucket)");
  });

  test("R2_ACCOUNT_ID → r2 (takes priority over plain BUCKET)", () => {
    const { label } = resolveStorageFromEnv({
      R2_ACCOUNT_ID: "acct",
      BUCKET: "my-bucket",
      ...FULL_AWS_CREDS,
    });
    expect(label).toBe("r2 (bucket=my-bucket)");
  });

  test("a configured bucket missing its credentials fails loud", () => {
    expect(() => resolveStorageFromEnv({ BUCKET: "my-bucket" })).toThrow(
      /Missing required env var/,
    );
  });

  test("an empty-string BUCKET is treated as unset (local dev falls back, not a confusing throw)", () => {
    const { label } = resolveStorageFromEnv({ BUCKET: "" });
    expect(label).toContain("local-fs");
  });

  test("an empty-string R2_ACCOUNT_ID is ignored; a real BUCKET still selects s3", () => {
    const { label } = resolveStorageFromEnv({
      R2_ACCOUNT_ID: "",
      BUCKET: "my-bucket",
      ...FULL_AWS_CREDS,
    });
    expect(label).toBe("s3 (bucket=my-bucket)");
  });
});

describe("resolveStorageFromEnv — production fail-loud guard", () => {
  test("NODE_ENV=production with no bucket refuses to start", () => {
    expect(() => resolveStorageFromEnv({ NODE_ENV: "production" })).toThrow(/Refusing to start/);
  });

  test("the throw names a real bucket so the operator knows the fix", () => {
    let message = "";
    try {
      resolveStorageFromEnv({ NODE_ENV: "production" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("AWS S3");
    expect(message).toContain("Cloudflare R2");
    expect(message).toContain("BUCKET");
  });

  // Per-marker coverage of the deploy-detection predicate lives in
  // packages/protocol/src/env.test.ts; here we only confirm the resolver
  // fails closed when isDeployedEnv is true via one representative marker.
  test("a PaaS marker (NODE_ENV unset) refuses to start", () => {
    expect(() => resolveStorageFromEnv({ KUBERNETES_SERVICE_HOST: "1" })).toThrow(
      /Refusing to start/,
    );
  });

  test("polarity: local dev falls back, deployment throws", () => {
    expect(() => resolveStorageFromEnv({})).not.toThrow();
    expect(() => resolveStorageFromEnv({ NODE_ENV: "production" })).toThrow(/Refusing to start/);
  });
});
