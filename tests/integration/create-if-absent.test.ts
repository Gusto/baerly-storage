/**
 * MinIO-gated regression pin for baerly's `ifNoneMatch: "*"`
 * create-if-absent wire encoding.
 *
 * {@link S3HttpStorage.put} emits a BARE `*` for create-if-absent
 * (`packages/adapter-node/src/s3-http.ts:265-266`):
 *
 *   if (opts?.ifNoneMatch === "*") {
 *     headers.set("If-None-Match", "*");
 *   }
 *
 * — i.e. the literal `*`, NOT a quoted `"*"`. MinIO's S3 conditional-
 * write support keys on the bare-`*` form; a refactor that "normalised"
 * the header to a quoted ETag-shaped `"*"` could silently break
 * create-if-absent against some MinIO versions, and the generic
 * conformance cascade wouldn't make the cause obvious. This focused
 * sequential test pins the bare-vs-quoted invariant: against live
 * MinIO, the first create succeeds and a second create on the same key
 * rejects with `Conflict`.
 *
 * This file now pins BOTH the sequential bare-`*` encoding AND the
 * concurrent exactly-one-winner atomicity: eight writers race the same
 * fresh key against live MinIO; exactly one must succeed and all others
 * must reject with `Conflict`.
 *
 * Gated on `MINIO=1` via `describe.runIf`, so it runs under
 * `pnpm test:minio` against `pnpm dev:storage`'s `127.0.0.1:9102` and
 * skips cleanly on a fresh checkout. Endpoint + credentials + the
 * `createBucket` helper match every other Minio-touching test in this
 * repo (`conformance.test.ts`, `randomized.test.ts`).
 */
import { AwsClient } from "aws4fetch";
import { describe, expect, test } from "vitest";

import { S3HttpStorage } from "@baerly/adapter-node";
import { uuid } from "@baerly/protocol";

import { createBucket } from "../fixtures/s3-fixtures.ts";
import { MINIO_ENDPOINT } from "../setup/ports.ts";

const MINIO = process.env["MINIO"] === "1";

// Endpoint + creds mirror the `node-minio` arm of `conformance.test.ts`
// and `randomized.test.ts` (and `docker-compose.yml`).
const ENDPOINT = MINIO_ENDPOINT;
const BUCKET = "baerly-create-if-absent";
const CREDS = { accessKeyId: "baerly", secretAccessKey: "ZOAmumEzdsUUcVlQ" };

describe.runIf(MINIO)("create-if-absent (bare-* against MinIO)", () => {
  const signer = new AwsClient({
    accessKeyId: CREDS.accessKeyId,
    secretAccessKey: CREDS.secretAccessKey,
    region: "us-east-1",
    service: "s3",
  });

  const storage = new S3HttpStorage({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    sign: (req) => signer.sign(req),
  });

  test("first create succeeds, second create on the same key conflicts", async () => {
    // `createBucket` tolerates 409 BucketAlreadyOwnedByYou, so re-runs
    // against the persistent dev-stack MinIO don't fail.
    await createBucket(signer, ENDPOINT, BUCKET);

    // `.`-free key: MinIO's REST gateway rejects `.`/`..` path
    // components (it validates URL paths as POSIX paths). `uuid()` is a
    // hyphenated UUID with no `.`, so it's safe here.
    const key = `create-if-absent/${uuid()}`;
    const body = new TextEncoder().encode("first");

    try {
      // 1. Create succeeds — no object at `key` yet.
      await expect(storage.put(key, body, { ifNoneMatch: "*" })).resolves.toBeDefined();

      // 2. Re-create with bare-`*` rejects with `Conflict` — the object
      //    now exists, so create-if-absent (412 → BaerlyError "Conflict")
      //    is enforced on the wire. A quoted-header refactor would fail
      //    this assertion against MinIO.
      await expect(
        storage.put(key, new TextEncoder().encode("second"), { ifNoneMatch: "*" }),
      ).rejects.toMatchObject({ code: "Conflict" });
    } finally {
      // 3. Clean up — best-effort; a leaked key doesn't fail the test.
      await storage.delete(key).catch(() => {});
    }
  });

  test("concurrent create-if-absent on a fresh key has exactly one winner", async () => {
    await createBucket(signer, ENDPOINT, BUCKET);
    const key = `create-if-absent/${uuid()}`;
    const enc = new TextEncoder();
    const RACERS = 16;
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: RACERS }, (_u, i) =>
          storage.put(key, enc.encode(`r${i}`), { ifNoneMatch: "*" }),
        ),
      );
      const winners = outcomes.filter((o) => o.status === "fulfilled").length;
      const conflicts = outcomes.filter(
        (o) => o.status === "rejected" && (o.reason as { code?: string }).code === "Conflict",
      ).length;
      expect(winners).toBe(1);
      expect(conflicts).toBe(RACERS - 1);
    } finally {
      await storage.delete(key).catch(() => {});
    }
  });
});
