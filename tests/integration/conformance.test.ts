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
import { AwsClient } from "aws4fetch";
import { fc } from "@fast-check/vitest";
import { describe } from "vitest";

import { DEFAULT_GCS_ENDPOINT, GcsHttpStorage, S3HttpStorage } from "@baerly/adapter-node";
// `goog4Signer` is not on the `/node` barrel (see adapter-node/src/index.ts);
// import it from the curated GCS family barrel `gcs.ts` — the `@gusto/
// baerly-storage/gcs` subpath source — exactly as the s3-worker suites
// import `sigV4Signer` from `s3.ts` (the `/s3` subpath source).
import { goog4Signer } from "../../packages/adapter-node/src/gcs.ts";
import {
  type ConformanceOptions,
  defineStorageConformanceSuite,
} from "@baerly/protocol/conformance";

import { createBucket } from "../fixtures/s3-fixtures.ts";
import { type EndpointCreds, loadEndpointCreds } from "../fixtures/endpoint-creds.ts";
import { MINIO_ACCESS_KEY, MINIO_ENDPOINT, MINIO_SECRET_KEY } from "../setup/ports.ts";

// A bare `.` / `..` key is unaddressable over the S3 HTTP API on *every*
// backend — RFC 3986 dot-segment removal (universal across every URL
// parser) rewrites `<bucket>/.` → `<bucket>/` before the request is sent
// — so the shared `DEFAULT_KEY_ARB` already excludes it and every adapter
// rejects it with `InvalidConfig` (see the "key namespace" conformance
// block + docs/spec/storage-compatibility.md). This extra `.`-free pin is
// therefore now defense-in-depth for the Minio variant, whose REST gateway
// additionally validates URL paths as POSIX paths on the backing
// filesystem. It is redundant with the default arb for bare `.`/`..`;
// dropping it (letting Minio exercise dot-containing keys like `a.b`) is a
// safe follow-up once verified against a live `pnpm test:minio` run.
// Mirror the pattern in `packages/adapter-node/src/s3-http.conformance.test.ts`.
const MINIO_KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const MINIO_KEY_ARB = fc.string({
  minLength: 1,
  maxLength: 32,
  unit: fc.constantFrom(...MINIO_KEY_CHARS.split("")),
});
const MINIO_PREFIX_CHAR_ARB = fc.constantFrom(...MINIO_KEY_CHARS.split(""));

const MINIO = process.env["MINIO"] === "1";
const CONFORMANCE = process.env["CONFORMANCE"] === "1";

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
          endpoint: MINIO_ENDPOINT,
          region: "us-east-1",
          bucket: "baerly-conformance-multi",
          credentials: {
            accessKeyId: MINIO_ACCESS_KEY,
            secretAccessKey: MINIO_SECRET_KEY,
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
  if (ep.builtIn) {
    creds = ep.builtIn;
  } else if (ep.file && CONFORMANCE) {
    creds = await loadEndpointCreds(ep.file);
  }
  resolvedEndpoints.push({ name: ep.name, creds });
}

// Outer suite so vitest doesn't error with "No test suite found" on
// fresh checkouts where neither `CONFORMANCE=1` nor `MINIO=1` resolves
// any endpoint creds. Inner `describe.runIf` then per-endpoint skips.
describe("conformance", () => {
  for (const ep of resolvedEndpoints) {
    describe.runIf(ep.creds !== null)(ep.name, () => {
      if (ep.creds === null) {
        return;
      } // unreachable; satisfies the type checker
      const c = ep.creds;
      const signer = new AwsClient({
        accessKeyId: c.credentials.accessKeyId,
        secretAccessKey: c.credentials.secretAccessKey,
        region: c.region,
        service: "s3",
      });
      const isGcs = ep.name === "gcs";
      // GCS native is the sanctioned path: SigV4 (`AwsClient`) can't carry
      // `x-goog-if-generation-match` (GCS rejects mixed `x-amz-*`/`x-goog-*`
      // with 400 ExcessHeaderValues), so GCS signs with GOOG4-HMAC-SHA256 and
      // drives `GcsHttpStorage`. Every other endpoint stays on the shared
      // SigV4 `AwsClient` → `S3HttpStorage` path untouched.
      const sign: (req: Request) => Promise<Request> = isGcs
        ? goog4Signer({ credentials: c.credentials })
        : (req: Request): Promise<Request> => signer.sign(req);

      const isMinio = ep.name === "node-minio";
      // Real Cloudflare R2's S3 `ListObjectsV2` is eventually consistent
      // (list-after-write / list-after-delete lag), unlike AWS S3 (strong
      // since Dec 2020) and the local Minio dev stack. Flag it so the
      // conformance harness polls list/read-back assertions instead of
      // asserting a single immediate snapshot over the wire.
      const isR2 = ep.name === "cloudflare";
      // aws / gcs / cloudflare are real remote HTTP endpoints where every
      // op is a network round-trip, so the fast-check property tests must
      // run at a reduced `numRuns` under a raised timeout (independent of
      // the consistency model — AWS S3 is strongly consistent yet still
      // remote). Without this the properties hammer the network 100× under
      // the default 5s timeout, time out mid-iteration, and orphan-bleed
      // writes into later tests. Minio is the local dev stack (127.0.0.1)
      // and stays on the full local fuzz budget.
      const isRemote = ep.name === "aws" || ep.name === "gcs" || isR2;
      let conformanceOptions: ConformanceOptions | undefined;
      if (isMinio) {
        conformanceOptions = { keyArb: MINIO_KEY_ARB, prefixCharArb: MINIO_PREFIX_CHAR_ARB };
      } else if (isRemote) {
        conformanceOptions = {
          remoteNetwork: true,
          eventuallyConsistentList: isR2,
          // GCS's version token is an int64 `generation`, not an ETag: a
          // quoted-hex CAS value is a *malformed* precondition (400
          // InvalidArgument), so feed a well-formed-but-stale generation that
          // no live object carries (→ 412 → Conflict). And GCS's native XML
          // API honors the generation preconditions only as 412-CAS writes,
          // never as a 304-when-unchanged read, so a version-token conditional
          // read can't 304 — opt out (the kernel never issues one). Both are
          // no-ops for aws/R2.
          ...(isGcs && { staleEtag: "1", supportsConditionalGet: false }),
        };
      }
      defineStorageConformanceSuite(
        `${isGcs ? "GcsHttpStorage" : "S3HttpStorage"} @ ${ep.name}`,
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
          // The classes share {bucket, sign} but diverge on `endpoint`. The
          // native GcsHttpStorage pins the GCS XML-API host and deliberately
          // ignores the creds-file `endpoint` (an S3-interop URL); construct
          // it off DEFAULT_GCS_ENDPOINT to match the `gcsStorage` factory
          // rather than threading `c.endpoint` through. Only the S3 family
          // (aws / minio / R2) consumes the creds endpoint.
          const storage = isGcs
            ? new GcsHttpStorage({ endpoint: DEFAULT_GCS_ENDPOINT, bucket: c.bucket, sign })
            : new S3HttpStorage({ endpoint: c.endpoint, bucket: c.bucket, sign });
          return { storage };
        },
        conformanceOptions,
      );
    });
  }
});
