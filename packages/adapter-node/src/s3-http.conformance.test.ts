import { AwsClient } from "aws4fetch";
import { DOMParser } from "@xmldom/xmldom";
import { fc } from "@fast-check/vitest";
import { beforeAll, describe } from "vitest";
import { defineStorageConformanceSuite } from "@baerly/protocol/conformance";
import { S3HttpStorage } from "@baerly/protocol";
import { createBucket } from "../../../tests/fixtures/s3-fixtures.ts";

// Same Minio that `pnpm dev:storage` provisions. Endpoint and creds
// are pinned across the existing Minio-touching tests
// (`tests/integration/randomized.test.ts`,
//  `tests/integration/conformance.test.ts`,
//  `docker-compose.yml`). Re-use; do not invent.
const MINIO_ENDPOINT = "http://127.0.0.1:9102";
const MINIO_ACCESS_KEY = "baerly";
const MINIO_SECRET_KEY = "ZOAmumEzdsUUcVlQ";
const MINIO_REGION = "us-east-1";
const BUCKET = "baerly-conformance-adapter-node";

const minioEnabled = process.env.MINIO === "1";

const signer = new AwsClient({
  accessKeyId: MINIO_ACCESS_KEY,
  secretAccessKey: MINIO_SECRET_KEY,
  region: MINIO_REGION,
  service: "s3",
});
const sign = (req: Request): Promise<Request> => signer.sign(req);
const xmlParser = new DOMParser();

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
describe.runIf(minioEnabled)("S3HttpStorage @ Minio :9102", () => {
  beforeAll(async () => {
    // `createBucket` tolerates 409 BucketAlreadyOwnedByYou so test
    // re-runs against the persistent dev Minio don't fail.
    await createBucket(signer, MINIO_ENDPOINT, BUCKET);
  });

  defineStorageConformanceSuite(
    "S3HttpStorage @ Minio :9102",
    async () => ({
      storage: new S3HttpStorage({
        endpoint: MINIO_ENDPOINT,
        bucket: BUCKET,
        sign,
        xmlParser,
      }),
    }),
    {
      // S3 + the existing `S3HttpStorage` impl supports the full
      // capability set; Minio preserves key case verbatim.
      caseSensitiveKeys: true,
      supportsCAS: true,
      supportsAbort: true,
      keyArb: MINIO_KEY_ARB,
      prefixCharArb: MINIO_PREFIX_CHAR_ARB,
    },
  );
});
