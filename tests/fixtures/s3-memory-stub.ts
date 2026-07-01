/**
 * A minimal in-memory S3-over-`fetch` stub — only the verbs
 * `S3HttpStorage` emits: `PUT` (with `If-None-Match: "*"` create-if-absent
 * and `If-Match` CAS), object `GET`, `GET list-type=2` (→ `ListObjectsV2`
 * XML), and `DELETE`. Every inbound request is recorded so a test can
 * assert the real SigV4 `Authorization` header rode along — i.e. the
 * signer ran in the chain and was not silently bypassed.
 *
 * Import-free so it loads inside Workerd (the `cloudflare-pool` project),
 * the same constraint as `tests/fixtures/randomized-cascade.ts`. Shared by
 * the S3-from-a-Worker tests: `tests/integration/s3-worker-wire.test.ts`
 * (storage in isolation) and `tests/integration/s3-worker-e2e.test.ts`
 * (a full `baerlyWorker` routing HTTP through injected `S3HttpStorage`).
 */

import { expect } from "vitest";

export interface SeenRequest {
  method: string;
  url: string;
  authorization: string | null;
}

/**
 * Assert every recorded request carried a real SigV4 `Authorization`
 * header — i.e. the signer ran in the chain and nothing was silently
 * bypassed. Shared by the wire test (storage in isolation) and the e2e
 * test (full `baerlyWorker`), which both need the same proof. Imports
 * `expect` from `vitest`, available under both the default and
 * `cloudflare-pool` (Workerd) projects.
 */
export function assertAllRequestsSigned(seen: readonly SeenRequest[]): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const r of seen) {
    expect(r.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  }
}

interface Stored {
  body: Uint8Array;
  etag: string;
}

export function makeS3Stub(bucket: string): { fetchImpl: typeof fetch; seen: SeenRequest[] } {
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
    const key = decodeURIComponent(url.pathname.replace(new RegExp(`^/${bucket}/?`), ""));

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
