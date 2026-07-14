import { describe, expect, test, vi } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { GcsHttpStorage } from "./gcs-http.ts";

const passthroughSign = (req: Request) => Promise.resolve(req);

function stub(handler: (req: Request) => Response): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new Request(input, init)))) as typeof fetch;
}

describe("GcsHttpStorage", () => {
  test("ifNoneMatch:'*' emits x-goog-if-generation-match:0 and returns generation as etag", async () => {
    let seen = "";
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub((req) => {
        seen = req.headers.get("x-goog-if-generation-match") ?? "";
        return new Response(null, {
          status: 200,
          headers: { "x-goog-generation": "1712000000000001" },
        });
      }),
    });
    const res = await s.put("log/1", new Uint8Array([1]), { ifNoneMatch: "*" });
    expect(seen).toBe("0");
    expect(res.etag).toBe("1712000000000001");
  });

  test("ifMatch emits x-goog-if-generation-match:<gen> and does NOT emit :0", async () => {
    let seen = "";
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub((req) => {
        seen = req.headers.get("x-goog-if-generation-match") ?? "";
        return new Response(null, { status: 200, headers: { "x-goog-generation": "999" } });
      }),
    });
    const res = await s.put("current.json", new Uint8Array([1]), { ifMatch: "1712000000000001" });
    expect(seen).toBe("1712000000000001");
    expect(res.etag).toBe("999");
  });

  test("put with no precondition emits no x-goog-if-generation-match header", async () => {
    let hasHeader = true;
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub((req) => {
        hasHeader = req.headers.has("x-goog-if-generation-match");
        return new Response(null, { status: 200, headers: { "x-goog-generation": "42" } });
      }),
    });
    await s.put("current.json", new Uint8Array([1]));
    expect(hasHeader).toBe(false);
  });

  test("412 maps to Conflict for a create collision (ifNoneMatch:'*')", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(
        () => new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 }),
      ),
    });
    await expect(s.put("log/1", new Uint8Array([1]), { ifNoneMatch: "*" })).rejects.toMatchObject({
      code: "Conflict",
    });
  });

  test("412 maps to Conflict for a stale CAS (ifMatch)", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(null, { status: 412 })),
    });
    await expect(
      s.put("current.json", new Uint8Array([1]), { ifMatch: "stale" }),
    ).rejects.toMatchObject({ code: "Conflict" });
  });

  test("put surfaces AccessDenied on 403", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(null, { status: 403 })),
    });
    await expect(s.put("current.json", new Uint8Array([1]))).rejects.toMatchObject({
      code: "AccessDenied",
    });
  });

  test("put throws InvalidResponse when x-goog-generation is absent (even if ETag present)", async () => {
    // ETag is a quoted-MD5, not the generation — there is deliberately no fallback.
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(null, { status: 200, headers: { ETag: '"abc123"' } })),
    });
    await expect(s.put("current.json", new Uint8Array([1]))).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("get throws InvalidResponse when x-goog-generation is absent (even if ETag present)", async () => {
    // Same reasoning as put: no ETag fallback for the version token.
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(
        () => new Response(new Uint8Array([1]), { status: 200, headers: { ETag: '"abc123"' } }),
      ),
    });
    await expect(s.get("current.json")).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("get returns body + generation-as-etag on 200", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(
        () =>
          new Response(new Uint8Array([7, 8, 9]), {
            status: 200,
            headers: { "x-goog-generation": "555" },
          }),
      ),
    });
    const res = await s.get("k");
    expect(res).not.toBeNull();
    expect(res!.etag).toBe("555");
    expect([...res!.body]).toEqual([7, 8, 9]);
  });

  // GCS has no generation-based conditional GET: x-goog-if-generation-not-match
  // is evaluated against the MD5 ETag, never the generation carried as the
  // opaque etag, so a version-token conditional read can never 304. get()
  // therefore ignores ifNoneMatch entirely (emits NEITHER the x-goog- header
  // nor S3's If-None-Match) — consistent with supportsConditionalGet:false in
  // the conformance suite. The kernel never issues a conditional read anyway.
  test("get ignores ifNoneMatch (GCS has no generation-based conditional read)", async () => {
    let hasGenerationHeader = true;
    let hasIfNoneMatch = true;
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub((req) => {
        hasGenerationHeader = req.headers.has("x-goog-if-generation-not-match");
        hasIfNoneMatch = req.headers.has("If-None-Match");
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "x-goog-generation": "556" },
        });
      }),
    });
    const res = await s.get("k", { ifNoneMatch: "555" });
    expect(hasGenerationHeader).toBe(false);
    expect(hasIfNoneMatch).toBe(false);
    expect(res!.etag).toBe("556");
  });

  // Defensive: get() sends no conditional header, so a conformant GCS won't
  // return 304 — but a caching proxy/gateway could, and 304 maps to null.
  test("get maps a 304 response to null", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(null, { status: 304 })),
    });
    await expect(s.get("k")).resolves.toBeNull();
  });

  test("get of missing key returns null (404)", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(null, { status: 404 })),
    });
    await expect(s.get("nope")).resolves.toBeNull();
  });

  test("delete is idempotent on 404", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(null, { status: 404 })),
    });
    await expect(s.delete("nope")).resolves.toBeUndefined();
  });

  // The version token is the generation, not the MD5 <ETag>: list must yield
  // the <Generation> element so a list etag equals what get/put return for the
  // same object. The mock XML mirrors a real GCS ListBucketResult (verified on
  // the wire) — it carries BOTH <Generation> and a quoted-MD5 <ETag>, so this
  // proves the generation is preferred over the ETag, not merely read.
  test("list yields <Generation> as the entry etag, not the MD5 <ETag>", async () => {
    const xml =
      `<?xml version='1.0' encoding='UTF-8'?>` +
      `<ListBucketResult xmlns='http://doc.s3.amazonaws.com/2006-03-01'>` +
      `<Name>b</Name><Prefix>log/</Prefix><KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>` +
      `<Contents><Key>log/1</Key><Generation>1784000000000001</Generation>` +
      `<MetaGeneration>1</MetaGeneration><ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag><Size>2</Size></Contents>` +
      `<Contents><Key>log/2</Key><Generation>1784000000000002</Generation>` +
      `<MetaGeneration>1</MetaGeneration><ETag>"098f6bcd4621d373cade4e832627b4f6"</ETag><Size>2</Size></Contents>` +
      `</ListBucketResult>`;
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(xml, { status: 200 })),
    });
    const entries: { key: string; etag: string }[] = [];
    for await (const e of s.list("log/")) {
      entries.push({ key: e.key, etag: e.etag });
    }
    expect(entries).toEqual([
      { key: "log/1", etag: "1784000000000001" },
      { key: "log/2", etag: "1784000000000002" },
    ]);
  });

  // Sanity that the invalid-key choke point (assertValidStorageKey) is wired
  // through #objectUrl exactly like S3HttpStorage.
  test("rejects an unaddressable '.' key before dispatch", async () => {
    const s = new GcsHttpStorage({
      bucket: "b",
      sign: passthroughSign,
      fetch: stub(() => new Response(null, { status: 200, headers: { "x-goog-generation": "1" } })),
    });
    await expect(s.put(".", new Uint8Array([1]))).rejects.toBeInstanceOf(BaerlyError);
  });
});

// The single-page happy path is covered above. GcsHttpStorage.list carries a
// bespoke continuation-token pagination loop and a 429 rate-limit retry
// (Retry-After honoring + budget-exhaustion throw) that the happy-path test
// never reaches. GCS's documented ~1-write/s ceiling makes 429s realistic and
// a >1000-key log listing during compaction/GC drives pagination, so a silent
// bug here drops keys. These mirror the S3HttpStorage.list coverage in
// s3-http.test.ts — the two loops are structurally identical.
describe("GcsHttpStorage.list retry + pagination", () => {
  // GCS's list etag is <Generation>, not the MD5 <ETag>: pages carry both so a
  // regression that reads the wrong element is caught.
  const gen = (k: string): string => `1784${k.charCodeAt(0)}000000`;
  const xmlPage = (keys: string[], nextToken?: string): string =>
    `<?xml version="1.0"?><ListBucketResult>` +
    keys
      .map(
        (k) =>
          `<Contents><Key>${k}</Key><Generation>${gen(k)}</Generation>` +
          `<ETag>"md5_${k}"</ETag></Contents>`,
      )
      .join("") +
    (nextToken !== undefined ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "") +
    `</ListBucketResult>`;

  // retries:0 so the inner per-request #retry adds no timers — the outer
  // rate-limit loop's delay is then the only clock, matching the s3 fixture.
  const mkList = (fetchImpl: typeof fetch): GcsHttpStorage =>
    new GcsHttpStorage({ bucket: "b", sign: passthroughSign, fetch: fetchImpl, retries: 0 });

  const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return input.url;
  };

  test("multi-page — follows NextContinuationToken", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      if (urlOf(input).includes("continuation-token=tok1")) {
        return new Response(xmlPage(["c", "d"]), { status: 200 });
      }
      return new Response(xmlPage(["a", "b"], "tok1"), { status: 200 });
    });
    const s = mkList(fetchFn);
    const out: { key: string; etag: string }[] = [];
    for await (const e of s.list("log/")) {
      out.push({ key: e.key, etag: e.etag });
    }
    expect(out).toEqual([
      { key: "a", etag: gen("a") },
      { key: "b", etag: gen("b") },
      { key: "c", etag: gen("c") },
      { key: "d", etag: gen("d") },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("maxKeys stops iteration mid-page", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(xmlPage(["a", "b", "c", "d"]), { status: 200 }),
    );
    const out: string[] = [];
    for await (const e of mkList(fetchFn).list("log/", { maxKeys: 2 })) {
      out.push(e.key);
    }
    expect(out).toEqual(["a", "b"]);
  });

  test("startAfter sets the cursor", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(xmlPage([]), { status: 200 }));
    for await (const _ of mkList(fetchFn).list("log/", { startAfter: "log/x" })) {
      void _;
    }
    expect(decodeURIComponent(urlOf(fetchFn.mock.calls[0]![0]))).toContain("start-after=log/x");
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
    await expect(
      (async () => {
        for await (const _ of mkList(fetchFn).list("log/")) {
          void _;
        }
      })(),
    ).rejects.toMatchObject({ code: "AccessDenied" });
  });

  test("aborted signal → throws before fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(xmlPage([]), { status: 200 }));
    const ac = new AbortController();
    ac.abort();
    await expect(
      (async () => {
        for await (const _ of mkList(fetchFn).list("log/", { signal: ac.signal })) {
          void _;
        }
      })(),
    ).rejects.toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("429 with Retry-After → outer loop waits the hint, not the default backoff", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchFn = vi.fn<typeof fetch>(async () => {
        calls++;
        if (calls === 1) {
          return new Response(null, { status: 429, headers: { "Retry-After": "3" } });
        }
        return new Response(xmlPage([]), { status: 200 });
      });
      const drain = (async () => {
        for await (const _ of mkList(fetchFn).list("log/")) {
          void _;
        }
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // Without the hint the loop retries at the 1s default; the 3s hint wins.
      await vi.advanceTimersByTimeAsync(2999);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      await drain;
    } finally {
      vi.useRealTimers();
    }
  });

  test("retry budget exhausted → NetworkError carries last-seen retryAfterSeconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
      );
      const drain = (async () => {
        for await (const _ of mkList(fetchFn).list("log/")) {
          void _;
        }
      })();
      const caught = drain.catch((error: unknown) => error);
      // 10 attempts × max(2s hint, 1s default) = 20s of in-loop waits.
      await vi.advanceTimersByTimeAsync(60_000);
      const err = (await caught) as BaerlyError;
      expect(err).toBeInstanceOf(BaerlyError);
      expect(err.code).toBe("NetworkError");
      expect(err.cause).toMatchObject({ status: 429, retryAfterSeconds: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});
