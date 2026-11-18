import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const script = fileURLToPath(
  new URL("../../manual-e2e/migration/old-binary-harness.mjs", import.meta.url),
);
const scratch: string[] = [];
const capture = `data:text/javascript,${encodeURIComponent(`
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method === "HEAD") return new Response(null, {status: 404});
  if (request.method !== "PUT") throw new Error("unexpected request");
  console.log(JSON.stringify({url: request.url, body: await request.text()}));
  // Stop after capturing CreateBucket, before any old-binary seed/dump work.
  return new Response(null, {status: 400});
};
`)}`;

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration harness CreateBucket", () => {
  test.each([
    ["https://s3.us-west-2.amazonaws.com", "us-west-2", "us-west-2"],
    ["https://s3.cn-north-1.amazonaws.com.cn", "cn-north-1", "cn-north-1"],
    ["https://s3.us-east-1.amazonaws.com", "us-east-1", undefined],
    ["http://127.0.0.1:9102", "us-west-2", undefined],
    ["https://test.r2.cloudflarestorage.com", "auto", undefined],
  ])("configures %s in %s", (endpoint, region, location) => {
    const dir = mkdtempSync(join(tmpdir(), "migration-create-bucket-"));
    scratch.push(dir);
    const marker = join(dir, "0.6.0/node_modules/@gusto/baerly-storage/package.json");
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ version: "0.6.0" }));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        capture,
        script,
        "--versions",
        "0.6.0",
        "--out",
        dir,
        "--skip-install",
        "--bucket",
        "s3://migration-test",
        "--create-bucket",
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
        env: {
          ...process.env,
          BAERLY_S3_ENDPOINT: endpoint,
          BAERLY_S3_REGION: region,
          BAERLY_S3_ACCESS_KEY_ID: "synthetic-access-key",
          BAERLY_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
        },
      },
    );
    expect(result.status).toBe(1);
    const request = JSON.parse(result.stdout) as { url: string; body: string };
    expect(request.url).toBe(`${endpoint}/migration-test`);
    expect(request.body).toBe(
      location === undefined
        ? ""
        : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${location}</LocationConstraint></CreateBucketConfiguration>`,
    );
  });
});
