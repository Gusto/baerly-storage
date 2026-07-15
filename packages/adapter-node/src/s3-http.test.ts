import { describe, expect, test, vi } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { S3HttpStorage } from "./s3-http.ts";

const mkStorage = (
  fetchImpl: typeof fetch,
  overrides: { retries?: number; backoffMs?: number } = {},
) =>
  new S3HttpStorage({
    endpoint: "https://example.invalid",
    bucket: "b",
    fetch: fetchImpl,
    retries: overrides.retries ?? 0,
    backoffMs: overrides.backoffMs ?? 1,
  });

const okResponse = (body: BodyInit | null, headers: Record<string, string>) =>
  new Response(body, { status: 200, headers });

const noBody = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

// `typeof fetch` accepts `RequestInfo | URL`. Tests that branch on the
// outgoing URL go through this helper to flatten all three shapes.
const urlOfFetchInput = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
};

describe("S3HttpStorage.get", () => {
  test("200 → { body, etag }", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) =>
      okResponse(new TextEncoder().encode("hello").buffer as ArrayBuffer, {
        ETag: '"abc"',
      }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const got = await s.get("k");
    expect(got).not.toBeNull();
    expect(got!.etag).toBe('"abc"');
    expect(new TextDecoder().decode(got!.body)).toBe("hello");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://example.invalid/b/k");
  });

  test("304 with ifNoneMatch → null", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(304));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const got = await s.get("k", { ifNoneMatch: '"abc"' });
    expect(got).toBeNull();
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.headers.get("If-None-Match")).toBe('"abc"');
  });

  test("404 → null", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(404));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.get("missing")).resolves.toBeNull();
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.get("k")).rejects.toMatchObject({
      code: "AccessDenied",
    });
  });

  test("500 → retries then NetworkError when budget exhausted", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => new Response("boom", { status: 500 }));
    const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 2 });
    await expect(s.get("k")).rejects.toBeInstanceOf(BaerlyError);
    // 1 initial + 2 retries
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("missing ETag on 200 → InvalidResponse", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) =>
      okResponse(new TextEncoder().encode("x").buffer as ArrayBuffer, {}),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.get("k")).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("aborted signal → throws before fetch", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => okResponse(null, { ETag: '"x"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const ac = new AbortController();
    ac.abort();
    await expect(s.get("k", { signal: ac.signal })).rejects.toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("URL-encodes the key segment", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) =>
      okResponse(new ArrayBuffer(0), { ETag: '"x"' }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await s.get("a/b c");
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.url).toBe("https://example.invalid/b/a%2Fb%20c");
  });

  test("429 → NetworkError with retryAfterSeconds when header present", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(429, { "Retry-After": "5" }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.get("k")).rejects.toMatchObject({
      code: "NetworkError",
      cause: { status: 429, retryAfterSeconds: 5 },
    });
  });

  test("429 without Retry-After → NetworkError, cause has status only", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(429));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    try {
      await s.get("k");
      expect.fail("expected throw");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("NetworkError");
      const cause = (error as BaerlyError).cause as { status: number; retryAfterSeconds?: number };
      expect(cause.status).toBe(429);
      expect(cause.retryAfterSeconds).toBeUndefined();
    }
  });

  test("503 → NetworkError with retryAfterSeconds", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(503, { "Retry-After": "2" }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.get("k")).rejects.toMatchObject({
      code: "NetworkError",
      cause: { status: 503, retryAfterSeconds: 2 },
    });
  });
});

describe("S3HttpStorage.put", () => {
  test("200 → returns ETag from response header", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(200, { ETag: '"e1"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const result = await s.put("k", new Uint8Array([1, 2, 3]));
    expect(result.etag).toBe('"e1"');
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("uses caller-provided contentType", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(200, { ETag: '"e1"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await s.put("k", new Uint8Array(0), { contentType: "application/json" });
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.headers.get("Content-Type")).toBe("application/json");
  });

  test("412 with ifMatch → Conflict", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(412));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0), { ifMatch: '"old"' })).rejects.toMatchObject({
      code: "Conflict",
      message: expect.stringContaining("precondition failed"),
    });
  });

  test("ifNoneMatch='*' sets If-None-Match: *", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(200, { ETag: '"e1"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await s.put("k", new Uint8Array(0), { ifNoneMatch: "*" });
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.headers.get("If-None-Match")).toBe("*");
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0))).rejects.toMatchObject({
      code: "AccessDenied",
    });
  });

  test("missing ETag on success → InvalidResponse", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(200));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0))).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("parses Date response header into serverDate", async () => {
    const date = new Date("2026-05-10T12:00:00Z");
    const fetchFn = vi.fn<typeof fetch>(async (_req) =>
      noBody(200, { ETag: '"e1"', Date: date.toUTCString() }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const result = await s.put("k", new Uint8Array(0));
    expect(result.etag).toBe('"e1"');
    expect(result.serverDate).toBeInstanceOf(Date);
    expect(result.serverDate?.getTime()).toBe(date.getTime());
  });

  test("missing Date header → no serverDate", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(200, { ETag: '"e1"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const result = await s.put("k", new Uint8Array(0));
    expect(result.serverDate).toBeUndefined();
  });

  test("429 → NetworkError with retryAfterSeconds when header present", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(429, { "Retry-After": "3" }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0))).rejects.toMatchObject({
      code: "NetworkError",
      cause: { status: 429, retryAfterSeconds: 3 },
    });
  });

  test("503 → NetworkError (retryable, not InvalidResponse)", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(503));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0))).rejects.toMatchObject({
      code: "NetworkError",
      cause: { status: 503 },
    });
  });

  test("409 on contended ifNoneMatch='*' → retryable NetworkError (not Conflict/InvalidResponse)", async () => {
    // AWS S3 returns 409 ConditionalRequestConflict when a concurrent
    // conditional create (If-None-Match:"*") races; Minio returns 412.
    // 409 must map to a retryable NetworkError so the single-write-commit
    // writer re-issues the same-seq PUT (→ 200 win or 412 Conflict), not a
    // direct Conflict, which would adopt-read a possibly-absent entry.
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(409));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0), { ifNoneMatch: "*" })).rejects.toMatchObject({
      code: "NetworkError",
      cause: { status: 409 },
    });
  });
});

describe("S3HttpStorage.delete", () => {
  test("204 → resolves", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(204));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).resolves.toBeUndefined();
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("DELETE");
  });

  test("404 → resolves (idempotent)", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(404));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).resolves.toBeUndefined();
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).rejects.toMatchObject({ code: "AccessDenied" });
  });

  test("500 retried then NetworkError", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => new Response("boom", { status: 500 }));
    const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 1 });
    await expect(s.delete("k")).rejects.toMatchObject({ code: "NetworkError" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("429 → NetworkError with retryAfterSeconds", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(429, { "Retry-After": "4" }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).rejects.toMatchObject({
      code: "NetworkError",
      cause: { status: 429, retryAfterSeconds: 4 },
    });
  });

  // An unexpected non-2xx/404 is a real failure, not a silently-swallowed
  // success: it routes through mapStorageError → InvalidResponse.
  test("400 → InvalidResponse (not silently swallowed)", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async (_req) => new Response("<Error><Code>BadRequest</Code></Error>", { status: 400 }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).rejects.toMatchObject({ code: "InvalidResponse" });
  });
});

describe("S3HttpStorage.list", () => {
  const xmlPage = (keys: string[], nextToken?: string): string =>
    `<?xml version="1.0"?><ListBucketResult>` +
    keys.map((k) => `<Contents><Key>${k}</Key><ETag>"e_${k}"</ETag></Contents>`).join("") +
    (nextToken !== undefined ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "") +
    `</ListBucketResult>`;

  test("single page — yields entries and stops", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async (_req) =>
        new Response(xmlPage(["a", "b", "c"]), {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: { key: string; etag: string }[] = [];
    for await (const e of s.list("p/")) {
      out.push({ ...e });
    }
    expect(out).toEqual([
      { key: "a", etag: '"e_a"' },
      { key: "b", etag: '"e_b"' },
      { key: "c", etag: '"e_c"' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("multi-page — follows NextContinuationToken", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = urlOfFetchInput(input);
      if (url.includes("continuation-token=tok1")) {
        return new Response(xmlPage(["c", "d"]), { status: 200 });
      }
      return new Response(xmlPage(["a", "b"], "tok1"), { status: 200 });
    });
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: string[] = [];
    for await (const e of s.list("p/")) {
      out.push(e.key);
    }
    expect(out).toEqual(["a", "b", "c", "d"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("maxKeys stops iteration", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async (_req) => new Response(xmlPage(["a", "b", "c", "d"]), { status: 200 }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: string[] = [];
    for await (const e of s.list("p/", { maxKeys: 2 })) {
      out.push(e.key);
    }
    expect(out).toEqual(["a", "b"]);
  });

  test("startAfter sets the cursor", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => new Response(xmlPage([]), { status: 200 }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: string[] = [];
    for await (const e of s.list("p/", { startAfter: "p/x" })) {
      out.push(e.key);
    }
    expect(out).toEqual([]);
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(decodeURIComponent(req.url)).toContain("start-after=p/x");
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const iter = s.list("p/");
    await expect(
      (async () => {
        for await (const _ of iter) {
          void _;
        }
      })(),
    ).rejects.toMatchObject({ code: "AccessDenied" });
  });

  test("aborted signal → throws", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_req) => new Response(xmlPage([]), { status: 200 }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const ac = new AbortController();
    ac.abort();
    await expect(
      (async () => {
        for await (const _ of s.list("p/", { signal: ac.signal })) {
          void _;
        }
      })(),
    ).rejects.toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("429 with Retry-After → outer loop waits the hint, not the 1s default", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchFn = vi.fn<typeof fetch>(async (_req) => {
        calls++;
        if (calls === 1) {
          return noBody(429, { "Retry-After": "3" });
        }
        return new Response(xmlPage([]), { status: 200 });
      });
      const s = mkStorage(fetchFn as unknown as typeof fetch);
      const iter = s.list("p/");
      const drain = (async () => {
        for await (const _ of iter) {
          void _;
        }
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // Without the hint the loop would retry at 1s. The hint pushes it to 3s.
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
      const fetchFn = vi.fn<typeof fetch>(async (_req) => noBody(429, { "Retry-After": "2" }));
      const s = mkStorage(fetchFn as unknown as typeof fetch);
      const iter = s.list("p/");
      const drain = (async () => {
        for await (const _ of iter) {
          void _;
        }
      })();
      const caught = drain.catch((error: unknown) => error);
      // 10 attempts × 2s = 20s of in-loop waits.
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

describe("retry honors Retry-After hint", () => {
  test("waits the hinted seconds, not the exponential schedule", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchFn = vi.fn<typeof fetch>(async (_req) => {
        calls++;
        if (calls === 1) {
          return noBody(429, { "Retry-After": "5" });
        }
        return okResponse(new TextEncoder().encode("ok").buffer as ArrayBuffer, { ETag: '"e"' });
      });
      const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 3, backoffMs: 100 });
      const p = s.get("k");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // Default exponential would have retried at 100ms; the hint keeps us waiting.
      await vi.advanceTimersByTimeAsync(4999);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      const got = await p;
      expect(got).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("clamps hint to maxDelayMs", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchFn = vi.fn<typeof fetch>(async (_req) => {
        calls++;
        // 60 seconds — clamped by parseRetryAfter to RETRY_AFTER_MAX_SECONDS,
        // and then clamped again to retry()'s maxDelayMs of 10_000ms.
        if (calls === 1) {
          return noBody(429, { "Retry-After": "60" });
        }
        return okResponse(new TextEncoder().encode("ok").buffer as ArrayBuffer, { ETag: '"e"' });
      });
      const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 3, backoffMs: 100 });
      const p = s.get("k");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(9999);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("raw network error wrapping", () => {
  test("terminal fetch error → NetworkError with original cause preserved", async () => {
    const cause = new Error("other side closed");
    const networkErr = Object.assign(new TypeError("fetch failed"), { cause });
    const fetchFn = vi.fn<typeof fetch>(async (_req) => {
      throw networkErr;
    });
    const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 1, backoffMs: 1 });
    const caughtError = await s.get("k").catch((error: unknown) => error);
    expect(caughtError).toBeInstanceOf(BaerlyError);
    expect((caughtError as BaerlyError).code).toBe("NetworkError");
    expect((caughtError as BaerlyError).cause).toBe(networkErr);
    // Pin the retry count: a terminal transient is retried, not short-circuited.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("a BaerlyError thrown by fetch passes through unwrapped (no double-wrap)", async () => {
    const original = new BaerlyError("Conflict", "precondition failed");
    const fetchFn = vi.fn<typeof fetch>(async (_req) => {
      throw original;
    });
    const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 1, backoffMs: 1 });
    const caughtError = await s.get("k").catch((error: unknown) => error);
    expect(caughtError).toBe(original);
  });

  test("transient fetch error that recovers → resolves successfully", async () => {
    let calls = 0;
    const cause = new Error("other side closed");
    const networkErr = Object.assign(new TypeError("fetch failed"), { cause });
    const fetchFn = vi.fn<typeof fetch>(async (_req) => {
      calls++;
      if (calls === 1) {
        throw networkErr;
      }
      return okResponse(new TextEncoder().encode("ok").buffer as ArrayBuffer, { ETag: '"e"' });
    });
    const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 1, backoffMs: 1 });
    const result = await s.get("k");
    expect(result).not.toBeNull();
    expect(result!.etag).toBe('"e"');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("sign callback", () => {
  test("sign() runs before fetch and its return value is what fetch sees", async () => {
    const upstreamFetch = vi.fn<typeof fetch>(async (_req) => noBody(200, { ETag: '"x"' }));
    const sign = vi.fn<(req: Request) => Promise<Request>>(async (req) => {
      const next = new Request(req, {
        headers: { ...Object.fromEntries(req.headers), "X-Signed": "1" },
      });
      return next;
    });
    const s = new S3HttpStorage({
      endpoint: "https://example.invalid",
      bucket: "b",
      fetch: upstreamFetch as unknown as typeof fetch,
      sign,
      retries: 0,
    });
    await s.put("k", new Uint8Array(0));
    expect(sign).toHaveBeenCalledTimes(1);
    const req = upstreamFetch.mock.calls[0]![0] as Request;
    expect(req.headers.get("X-Signed")).toBe("1");
  });
});
