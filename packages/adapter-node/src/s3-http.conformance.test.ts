import { AwsClient } from "aws4fetch";
import { fc } from "@fast-check/vitest";
import { beforeAll, describe, expect, test } from "vitest";
import { defineStorageConformanceSuite } from "@baerly/protocol/conformance";
import { S3HttpStorage } from "./s3-http.ts";
import { createBucket } from "../../../tests/fixtures/s3-fixtures.ts";
import { MINIO_ENDPOINT, MINIO_HOST_PORT } from "../../../tests/setup/ports.ts";
import { minioStorage } from "./storage-factories.ts";

// Same Minio that `pnpm dev:storage` provisions. Endpoint and creds
// are pinned across the existing Minio-touching tests
// (`tests/integration/randomized.test.ts`,
//  `tests/integration/conformance.test.ts`,
//  `docker-compose.yml`). Re-use; do not invent. The endpoint comes
// from `tests/setup/ports.ts` so per-worktree port overrides flow through.
const MINIO_ACCESS_KEY = "baerly";
const MINIO_SECRET_KEY = "ZOAmumEzdsUUcVlQ";
const MINIO_REGION = "us-east-1";
const BUCKET = "baerly-conformance-adapter-node";

const minioEnabled = process.env["MINIO"] === "1";

const signer = new AwsClient({
  accessKeyId: MINIO_ACCESS_KEY,
  secretAccessKey: MINIO_SECRET_KEY,
  region: MINIO_REGION,
  service: "s3",
});
const sign = (req: Request): Promise<Request> => signer.sign(req);

// Minio's REST gateway rejects request paths whose resource component
// is `.` or `..` (it validates URL paths as POSIX paths on the backing
// filesystem) — both `?prefix=.` listing and `PUT /bucket/.` (key=".")
// surface as `XMinioInvalidResourceName` / `BucketAlreadyOwnedByYou`.
// AWS S3 and R2 have no such restriction. Pin a `.`-free key + prefix
// arbitrary for the Minio run only; everything else stays default.
const MINIO_KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const MINIO_KEY_ARB = fc.string({
  minLength: 1,
  maxLength: 32,
  unit: fc.constantFrom(...MINIO_KEY_CHARS.split("")),
});
const MINIO_PREFIX_CHAR_ARB = fc.constantFrom(...MINIO_KEY_CHARS.split(""));

// Mirror `tests/integration/time.test.ts`'s `describe.runIf(minioEnabled)`
// pattern: the entire block is no-op'd on a fresh checkout, then runs
// end-to-end under `MINIO=1 pnpm test`.
describe.runIf(minioEnabled)(`S3HttpStorage @ Minio :${MINIO_HOST_PORT}`, () => {
  beforeAll(async () => {
    // `createBucket` tolerates 409 BucketAlreadyOwnedByYou so test
    // re-runs against the persistent dev Minio don't fail.
    await createBucket(signer, MINIO_ENDPOINT, BUCKET);
  });

  defineStorageConformanceSuite(
    `S3HttpStorage @ Minio :${MINIO_HOST_PORT}`,
    async () => ({
      storage: new S3HttpStorage({
        endpoint: MINIO_ENDPOINT,
        bucket: BUCKET,
        sign,
      }),
    }),
    {
      // S3 + the existing `S3HttpStorage` impl supports the full
      // capability set; Minio preserves key case verbatim. (CAS is
      // mandatory — the suite always exercises it, no opt-in flag.)
      caseSensitiveKeys: true,
      supportsAbort: true,
      keyArb: MINIO_KEY_ARB,
      prefixCharArb: MINIO_PREFIX_CHAR_ARB,
    },
  );
});

// Re-run the same conformance suite through the `minioStorage` factory
// — the public DX surface. Reuses the same bucket (createBucket
// tolerates 409) and the same Minio-safe arbitraries.
describe.runIf(minioEnabled)(`minioStorage factory @ Minio :${MINIO_HOST_PORT}`, () => {
  beforeAll(async () => {
    await createBucket(signer, MINIO_ENDPOINT, BUCKET);
  });

  defineStorageConformanceSuite(
    `minioStorage factory @ Minio :${MINIO_HOST_PORT}`,
    async () => ({
      storage: minioStorage({
        endpoint: MINIO_ENDPOINT,
        bucket: BUCKET,
        credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
      }),
    }),
    {
      caseSensitiveKeys: true,
      supportsAbort: true,
      keyArb: MINIO_KEY_ARB,
      prefixCharArb: MINIO_PREFIX_CHAR_ARB,
    },
  );
});

// End-to-end proof of the `encoding-type=url` request↔parser contract
// against a real S3 implementation. The conformance `keyArb` above is
// restricted to URL-safe chars, so it never exercises a key containing a
// literal `%`, `+`, space, or non-ASCII byte — exactly the keys that break
// when the list request omits `encoding-type=url` while the parser
// url-decodes the key. The `%` case is the sharpest: without
// `encoding-type=url`, Minio returns the key raw and `decodeURIComponent`
// throws an unguarded `URIError` on the dangling `%`.
describe.runIf(minioEnabled)(
  `S3HttpStorage list key round-trip @ Minio :${MINIO_HOST_PORT}`,
  () => {
    beforeAll(async () => {
      await createBucket(signer, MINIO_ENDPOINT, BUCKET);
    });

    test("special-character keys survive a put → list round trip", async () => {
      const storage = new S3HttpStorage({ endpoint: MINIO_ENDPOINT, bucket: BUCKET, sign });
      // Unique-ish, `.`-free prefix so this never collides with the
      // conformance suite's random keys. Each key mixes a `+`, a space, a
      // literal `%`, and a non-ASCII char (é).
      const prefix = "enc-roundtrip-fixture/";
      const keys = [`${prefix}report+50% café`, `${prefix}a b%c+d`, `${prefix}90% ✓ done`];
      const body = new TextEncoder().encode("x");
      for (const key of keys) {
        await storage.put(key, body);
      }
      try {
        const seen: string[] = [];
        for await (const entry of storage.list(prefix)) {
          seen.push(entry.key);
        }
        expect(seen.toSorted()).toEqual(keys.toSorted());
      } finally {
        for (const key of keys) {
          await storage.delete(key);
        }
      }
    });
  },
);
