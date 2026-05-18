/**
 * Multi-endpoint `Storage` conformance gate.
 *
 * Drives {@link defineStorageConformanceSuite} against
 * {@link S3HttpStorage} once per supported S3-compatible endpoint:
 * AWS, GCS, Cloudflare R2 (HTTP), and the local Minio dev stack. The
 * credentials-required endpoints load their config from
 * `credentials/{aws,gcs,cloudflare}.json` (gitignored) under
 * `CONFORMANCE=1`; the Minio variant is gated on `MINIO=1` and points
 * at `pnpm dev:storage`'s `127.0.0.1:9102`. Endpoints with no
 * available credentials are skipped via `describe.runIf` — the file
 * tolerates a fresh checkout with no credentials on disk.
 *
 * Baerly-shaped invariants (versioning mode, parallel-writer-on-single-
 * key) are dropped — those are manifest-coordination assertions, not
 * `Storage` assertions, and live in
 * `tests/integration/randomized.test.ts` per the cascade.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AwsClient } from "aws4fetch";
import { fc } from "@fast-check/vitest";
import { DOMParser } from "@xmldom/xmldom";
import { describe } from "vitest";

import { S3HttpStorage } from "@baerly/adapter-node";
import { defineStorageConformanceSuite } from "@baerly/protocol/conformance";

import { createBucket } from "../fixtures/s3-fixtures.ts";

// Minio's REST gateway rejects request paths whose resource component
// is `.` or `..` (it validates URL paths as POSIX paths on the backing
// filesystem). AWS S3 and R2 have no such restriction. Pin a `.`-free
// key + prefix arbitrary for the Minio variant only; everything else
// stays default. Mirror the pattern in
// `packages/adapter-node/src/s3-http.conformance.test.ts`.
const MINIO_KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const MINIO_KEY_ARB = fc.string({
  minLength: 1,
  maxLength: 32,
  unit: fc.constantFrom(...MINIO_KEY_CHARS.split("")),
});
const MINIO_PREFIX_CHAR_ARB = fc.constantFrom(...MINIO_KEY_CHARS.split(""));

interface EndpointCreds {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

async function loadCreds(file: string): Promise<EndpointCreds | null> {
  try {
    const raw = await readFile(join("credentials", file), "utf8");
    return JSON.parse(raw) as EndpointCreds;
  } catch {
    return null;
  }
}

const MINIO = process.env["MINIO"] === "1";
const CONFORMANCE = process.env["CONFORMANCE"] === "1";

const xmlParser = new DOMParser();

interface Endpoint {
  name: string;
  file?: string;
  builtIn?: EndpointCreds;
}

const endpoints: Endpoint[] = [
  { name: "aws", file: "aws.json" },
  { name: "gcs", file: "gcs.json" },
  { name: "cloudflare", file: "cloudflare.json" },
  // Minio under `pnpm dev:storage`. Endpoint + creds match every other
  // Minio-touching test in this repo (`randomized.test.ts`,
  // `s3-http.conformance.test.ts`, `docker-compose.yml`).
  {
    name: "node-minio",
    builtIn: MINIO
      ? {
          endpoint: "http://127.0.0.1:9102",
          region: "us-east-1",
          bucket: "baerly-conformance-multi",
          credentials: {
            accessKeyId: "baerly",
            secretAccessKey: "ZOAmumEzdsUUcVlQ",
          },
        }
      : undefined,
  },
];

// Resolve credentials at module top level — vitest collects suites
// synchronously, so `describe` callbacks must not be `async`. The
// `await loadCreds(...)` calls happen here, before any `describe`.
const resolvedEndpoints: { name: string; creds: EndpointCreds | null }[] = [];
for (const ep of endpoints) {
  let creds: EndpointCreds | null = null;
  if (ep.builtIn) creds = ep.builtIn;
  else if (ep.file && CONFORMANCE) creds = await loadCreds(ep.file);
  resolvedEndpoints.push({ name: ep.name, creds });
}

// Outer suite so vitest doesn't error with "No test suite found" on
// fresh checkouts where neither `CONFORMANCE=1` nor `MINIO=1` resolves
// any endpoint creds. Inner `describe.runIf` then per-endpoint skips.
describe("conformance", () => {
  for (const ep of resolvedEndpoints) {
    describe.runIf(ep.creds !== null)(ep.name, () => {
      if (ep.creds === null) return; // unreachable; satisfies the type checker
      const c = ep.creds;
      const signer = new AwsClient({
        accessKeyId: c.credentials.accessKeyId,
        secretAccessKey: c.credentials.secretAccessKey,
        region: c.region,
        service: "s3",
      });
      const sign = (req: Request): Promise<Request> => signer.sign(req);

      const isMinio = ep.name === "node-minio";
      defineStorageConformanceSuite(
        `S3HttpStorage @ ${ep.name}`,
        async () => {
          // `createBucket` tolerates 409 BucketAlreadyOwnedByYou, so
          // re-runs against persistent buckets (Minio dev stack, real
          // cloud buckets) don't fail the per-test factory. Skip for
          // remote endpoints where the bucket is provisioned out-of-
          // band (AWS / GCS / R2 buckets in `credentials/*.json` are
          // expected to exist already).
          if (isMinio) {
            await createBucket(signer, c.endpoint, c.bucket);
          }
          return {
            storage: new S3HttpStorage({
              endpoint: c.endpoint,
              bucket: c.bucket,
              sign,
              xmlParser,
            }),
          };
        },
        isMinio ? { keyArb: MINIO_KEY_ARB, prefixCharArb: MINIO_PREFIX_CHAR_ARB } : undefined,
      );
    });
  }
});
