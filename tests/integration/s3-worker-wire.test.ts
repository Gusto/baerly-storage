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

const ENDPOINT = "https://s3.us-east-1.amazonaws.com";
const BUCKET = "wire-test";

interface Stored {
  body: Uint8Array;
  etag: string;
}

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | null;
}

/**
 * A minimal in-memory S3 over `fetch` — only the verbs `S3HttpStorage`
 * emits: `PUT` (with `If-None-Match: "*"` create-if-absent and `If-Match`
 * CAS), object `GET`, `GET list-type=2` (→ `ListObjectsV2` XML), and
 * `DELETE`. Every inbound request is recorded so a test can assert the
 * real SigV4 `Authorization` header rode along — i.e. the signer ran in
 * the chain and was not silently bypassed.
 */
function makeS3Stub(): { fetchImpl: typeof fetch; seen: SeenRequest[] } {
  const store = new Map<string, Stored>();
  const seen: SeenRequest[] = [];
  let seq = 0;

  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.get("authorization"),
    });
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${BUCKET}/?`), ""));

    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).toSorted();
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
        keys
          .map(
            (k) =>
              `<Contents><Key>${encodeURIComponent(k)}</Key><ETag>${store.get(k)!.etag}</ETag></Contents>`,
          )
          .join("") +
        `</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
    }

    if (req.method === "GET") {
      const hit = store.get(key);
      return hit === undefined
        ? new Response(null, { status: 404 })
        : // `Uint8Array<ArrayBufferLike>` isn't assignable to the narrowed
          // lib.dom `BodyInit`, though the runtime accepts it — same cast
          // `S3HttpStorage#put` makes.
          new Response(hit.body as BodyInit, { status: 200, headers: { ETag: hit.etag } });
    }

    if (req.method === "PUT") {
      const exists = store.has(key);
      if (req.headers.get("If-None-Match") === "*" && exists) {
        return new Response(null, { status: 412 });
      }
      const ifMatch = req.headers.get("If-Match");
      if (ifMatch !== null && (!exists || store.get(key)!.etag !== ifMatch)) {
        return new Response(null, { status: 412 });
      }
      const body = new Uint8Array(await req.arrayBuffer());
      const etag = `"etag-${seq++}"`;
      store.set(key, { body, etag });
      return new Response(null, { status: 200, headers: { ETag: etag } });
    }

    if (req.method === "DELETE") {
      store.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;

  return { fetchImpl, seen };
}

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
    const { fetchImpl, seen } = makeS3Stub();
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
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) {
      expect(r.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    }
  });

  test("If-None-Match:'*' create-if-absent conflict maps to Conflict", async () => {
    const { fetchImpl } = makeS3Stub();
    const s = mkStorage(fetchImpl);

    await s.put("log/00000001", new Uint8Array([1]), { ifNoneMatch: "*" });
    const conflict = await s
      .put("log/00000001", new Uint8Array([2]), { ifNoneMatch: "*" })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(BaerlyError);
    expect((conflict as BaerlyError).code).toBe("Conflict");
  });

  test("list parses ListObjectsV2 XML with fast-xml-parser in-isolate", async () => {
    const { fetchImpl } = makeS3Stub();
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
