/**
 * S3-over-HTTP executes *inside Workerd* — the wire-execution proof.
 *
 * `tests/integration/s3-worker-safe.test.ts` proves the
 * `@gusto/baerly-storage/s3` closure *bundles* for the browser/worker
 * platform (no `node:` builtin survives). That is a load check, not a
 * run check. This test proves the closure actually *runs* inside a real
 * Workerd isolate: it instantiates `S3HttpStorage` with the real
 * `sigV4Signer` (aws4fetch → WebCrypto) and drives a
 * put → get → conditional-create → list round-trip through an in-memory
 * S3-shaped `fetch` stub.
 *
 * That exercises the exact seams the Node-side S3 tests cannot reach from
 * Workerd, and which the docs flag as otherwise only covered by the
 * manual e2e (see `manual-e2e/README.md`):
 *   - aws4fetch SigV4 signing under Workerd's WebCrypto (not `node:crypto`),
 *   - `fast-xml-parser` parsing a `ListObjectsV2` body in-isolate,
 *   - the `Request` body / `Response.arrayBuffer` plumbing under Workerd.
 *
 * Runs under the `cloudflare-pool` vitest project (Workerd/miniflare) via
 * `pnpm test:adapter-cloudflare` — no MinIO, no docker, no network: the
 * stub is the terminal `fetch`. It lives under `tests/` (not
 * `packages/adapter-cloudflare/src/`) because the package-layer linter
 * forbids `adapter-cloudflare → adapter-node`, and it imports the
 * node-free `/s3` barrel by relative path — NOT `@baerly/adapter-node`,
 * whose index barrel drags `node:http` and would fail to bundle here.
 */
import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { S3HttpStorage, sigV4Signer } from "../../packages/adapter-node/src/s3.ts";
import { assertAllRequestsSigned, makeS3Stub } from "../fixtures/s3-memory-stub.ts";

const ENDPOINT = "https://s3.us-east-1.amazonaws.com";
const BUCKET = "wire-test";

const mkStorage = (fetchImpl: typeof fetch): S3HttpStorage =>
  new S3HttpStorage({
    endpoint: ENDPOINT,
    bucket: BUCKET,
    fetch: fetchImpl,
    sign: sigV4Signer({
      accessKeyId: "AKIAWIRETEST",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    }),
    retries: 0,
  });

describe("@gusto/baerly-storage/s3 executes inside Workerd", () => {
  test("sigV4Signer signs a Request with Workerd's WebCrypto", async () => {
    const sign = sigV4Signer({ accessKeyId: "AKIA", secretAccessKey: "secret", region: "auto" });
    const signed = await sign(
      new Request(`${ENDPOINT}/${BUCKET}/log/00000001`, {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    // AWS4-HMAC-SHA256 + a content hash — computed via `crypto.subtle`,
    // which is the whole point of running this in-isolate.
    expect(signed.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(signed.headers.get("x-amz-content-sha256")).toBeTruthy();
  });

  test("put → get round-trips bytes through real signed requests", async () => {
    const { fetchImpl, seen } = makeS3Stub(BUCKET);
    const s = mkStorage(fetchImpl);

    const put = await s.put("docs/greeting", new TextEncoder().encode("hello from workerd"), {
      ifNoneMatch: "*",
    });
    expect(put.etag).toBeTruthy();

    const got = await s.get("docs/greeting");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.body)).toBe("hello from workerd");

    // Every request that reached the wire carried a SigV4 header — proof
    // the real aws4fetch signer ran in the chain in-isolate.
    assertAllRequestsSigned(seen);
  });

  test("If-None-Match:'*' create-if-absent conflict maps to Conflict", async () => {
    const { fetchImpl } = makeS3Stub(BUCKET);
    const s = mkStorage(fetchImpl);

    await s.put("log/00000001", new Uint8Array([1]), { ifNoneMatch: "*" });
    const conflict = await s
      .put("log/00000001", new Uint8Array([2]), { ifNoneMatch: "*" })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(BaerlyError);
    expect((conflict as BaerlyError).code).toBe("Conflict");
  });

  test("list parses ListObjectsV2 XML with fast-xml-parser in-isolate", async () => {
    const { fetchImpl } = makeS3Stub(BUCKET);
    const s = mkStorage(fetchImpl);

    await s.put("p/a", new Uint8Array([1]), { ifNoneMatch: "*" });
    await s.put("p/b", new Uint8Array([2]), { ifNoneMatch: "*" });
    await s.put("other/c", new Uint8Array([3]), { ifNoneMatch: "*" });

    const keys: string[] = [];
    for await (const entry of s.list("p/")) {
      keys.push(entry.key);
    }
    expect(keys.toSorted()).toEqual(["p/a", "p/b"]);
  });
});
