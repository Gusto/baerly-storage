/**
 * The HTTP adapters charge the request ledger's `external` pool exactly
 * once per HTTP attempt: retried attempts and each LIST page included,
 * nothing charged that is not sent. Counted against the real
 * `S3HttpStorage` / `GcsHttpStorage` over a fake `fetch`, so the check
 * covers the adapters' own charge point, not a fixture's. The R2 binding's
 * equivalent lives in `r2-binding-storage.request-accounting.test.ts`.
 */

import { RequestLedger, type Storage } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { GcsHttpStorage } from "../../packages/adapter-node/src/gcs-http.ts";
import { S3HttpStorage } from "../../packages/adapter-node/src/s3-http.ts";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";

/** ListObjectsV2 page `n` of `PAGES`, one key each, chained by continuation token. */
const PAGES = 3;
const listPage = (n: number): string =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
  `<Contents><Key>p%2F${n}</Key><ETag>"e${n}"</ETag><Generation>${n + 1}</Generation></Contents>` +
  (n < PAGES - 1
    ? `<IsTruncated>true</IsTruncated><NextContinuationToken>t${n + 1}</NextContinuationToken>`
    : `<IsTruncated>false</IsTruncated>`) +
  `</ListBucketResult>`;

/**
 * A `fetch` counting every request. The first attempt of each distinct
 * request (method + URL) answers 503, so every call costs one retry; the
 * second succeeds.
 */
const flakyFetch = () => {
  let sent = 0;
  const seen = new Set<string>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent += 1;
    const id = `${req.method} ${req.url}`;
    if (!seen.has(id)) {
      seen.add(id);
      return new Response(null, { status: 503 });
    }
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const token = url.searchParams.get("continuation-token");
      return new Response(listPage(token === null ? 0 : Number(token.slice(1))), { status: 200 });
    }
    const headers = { ETag: '"e"', "x-goog-generation": "1" };
    return req.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(req.method === "GET" ? "x" : null, { status: 200, headers });
  }) as typeof fetch;
  return { fetchImpl, sent: () => sent };
};

const adapters: Array<[string, (fetchImpl: typeof fetch) => Storage]> = [
  [
    "S3HttpStorage",
    (fetchImpl) =>
      new S3HttpStorage({
        endpoint: "https://s3.invalid",
        bucket: "b",
        fetch: fetchImpl,
        backoffMs: 0,
      }),
  ],
  [
    "GcsHttpStorage",
    (fetchImpl) =>
      new GcsHttpStorage({
        bucket: "b",
        sign: async (req) => req,
        fetch: fetchImpl,
        backoffMs: 0,
      }),
  ],
];

describe.each(adapters)("%s charges the external pool once per HTTP attempt", (_name, make) => {
  const run = async (fn: (s: Storage) => Promise<unknown>) => {
    const { fetchImpl, sent } = flakyFetch();
    const storage = make(fetchImpl);
    const ledger = new RequestLedger();
    await runWithContext(createObservabilityContext({ ledger }), () => fn(storage));
    return { charged: ledger.charged, sent: sent() };
  };

  test("get / put / delete, each retried once", async () => {
    const { charged, sent } = await run(async (s) => {
      await s.get("k");
      await s.put("k", new Uint8Array([1]));
      await s.delete("k");
    });
    expect(sent).toBe(6);
    expect(charged).toEqual({ internal: sent, external: sent, cache: 0 });
  });

  test(`a ${PAGES}-page list, each page retried once`, async () => {
    const keys: string[] = [];
    const { charged, sent } = await run(async (s) => {
      for await (const e of s.list("p/")) {
        keys.push(e.key);
      }
    });
    expect(keys).toEqual(["p/0", "p/1", "p/2"]);
    expect(sent).toBe(2 * PAGES);
    expect(charged).toEqual({ internal: sent, external: sent, cache: 0 });
  });

  test("an attempt past the limit is neither charged nor sent", async () => {
    const { fetchImpl, sent } = flakyFetch();
    const storage = make(fetchImpl);
    const ledger = new RequestLedger({ internal: 900, external: 1 });
    const err = await Promise.resolve(
      runWithContext(createObservabilityContext({ ledger }), () => storage.get("k")),
    ).catch((error: unknown) => error);
    // Attempt 1 (503) was charged and sent; the retry was refused unsent.
    expect(err).toMatchObject({ code: "CapacityExceeded", cause: { refused: true } });
    expect(sent()).toBe(1);
    expect(ledger.charged.external).toBe(1);
  });
});
