import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveStorage } from "../../examples/minimal-node/src/server/resolve-storage.ts";

/**
 * Coverage for the PR's central safety feature: the Node example
 * servers refuse to start on local-fs in a detected deployment. The
 * decision logic lives in each example's `src/server/resolve-storage.ts`
 * (byte-identical, drift-fenced below) so it can be exercised here as a
 * pure function of the environment rather than only by hand at runtime.
 */

const FULL_AWS_CREDS = {
  AWS_ACCESS_KEY_ID: "ak",
  AWS_SECRET_ACCESS_KEY: "sk",
} as const;

const PAAS_MARKERS = [
  "RAILWAY_ENVIRONMENT",
  "RENDER",
  "FLY_APP_NAME",
  "K_SERVICE",
  "DYNO",
  "KUBERNETES_SERVICE_HOST",
  "ECS_CONTAINER_METADATA_URI_V4",
];

describe("resolveStorage — local dev fallback", () => {
  test("falls back to local-fs when no bucket and not deployed", () => {
    const { storage, label } = resolveStorage({});
    expect(storage).toBeDefined();
    expect(label).toContain("local-fs");
    expect(label).toContain("not a production store");
  });

  test("local-fs label reflects BAERLY_DATA_DIR when set", () => {
    const { label } = resolveStorage({ BAERLY_DATA_DIR: "/data/here" });
    expect(label).toContain("/data/here");
  });
});

describe("resolveStorage — bucket selection", () => {
  test("BUCKET → s3, even in a deployment", () => {
    const { storage, label } = resolveStorage({
      NODE_ENV: "production",
      BUCKET: "my-bucket",
      ...FULL_AWS_CREDS,
    });
    expect(storage).toBeDefined();
    expect(label).toBe("s3 (bucket=my-bucket)");
  });

  test("R2_ACCOUNT_ID → r2 (takes priority over plain BUCKET)", () => {
    const { label } = resolveStorage({
      R2_ACCOUNT_ID: "acct",
      BUCKET: "my-bucket",
      ...FULL_AWS_CREDS,
    });
    expect(label).toBe("r2 (bucket=my-bucket)");
  });

  test("a configured bucket missing its credentials fails loud", () => {
    expect(() => resolveStorage({ BUCKET: "my-bucket" })).toThrow(/Missing required env var/);
  });
});

describe("resolveStorage — production fail-loud guard", () => {
  test("NODE_ENV=production with no bucket refuses to start", () => {
    expect(() => resolveStorage({ NODE_ENV: "production" })).toThrow(/Refusing to start/);
  });

  test("the throw names a real bucket so the operator knows the fix", () => {
    let message = "";
    try {
      resolveStorage({ NODE_ENV: "production" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("AWS S3");
    expect(message).toContain("Cloudflare R2");
    expect(message).toContain("BUCKET");
  });

  // Every PaaS marker independently trips the guard — a regression that
  // drops one would silently let that platform boot on local-fs.
  for (const marker of PAAS_MARKERS) {
    test(`PaaS marker ${marker} (NODE_ENV unset) refuses to start`, () => {
      expect(() => resolveStorage({ [marker]: "1" })).toThrow(/Refusing to start/);
    });
  }

  // Pins the polarity of `!looksDeployed`: empty env must fall back (not
  // throw) AND a deployment must throw (not fall back). Inverting the
  // condition breaks exactly one of these.
  test("polarity: local dev falls back, deployment throws", () => {
    expect(() => resolveStorage({})).not.toThrow();
    expect(() => resolveStorage({ NODE_ENV: "production" })).toThrow(/Refusing to start/);
  });
});

describe("resolve-storage.ts drift across Node examples", () => {
  test("minimal-node and react-node copies are byte-identical", async () => {
    const read = (rel: string): Promise<string> =>
      readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const [minimal, react] = await Promise.all([
      read("../../examples/minimal-node/src/server/resolve-storage.ts"),
      read("../../examples/react-node/src/server/resolve-storage.ts"),
    ]);
    expect(react).toBe(minimal);
  });
});
