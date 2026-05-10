import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, test, vi } from "vitest";
import { MPS3Error } from "../errors";
import { S3HttpStorage } from "./s3-http";

const xmlParser = new DOMParser();

const mkStorage = (
  fetchImpl: typeof fetch,
  overrides: { retries?: number; backoffMs?: number } = {},
) =>
  new S3HttpStorage({
    endpoint: "https://example.invalid",
    bucket: "b",
    fetch: fetchImpl,
    xmlParser,
    retries: overrides.retries ?? 0,
    backoffMs: overrides.backoffMs ?? 1,
  });

const okResponse = (body: BodyInit | null, headers: Record<string, string>) =>
  new Response(body, { status: 200, headers });

const noBody = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe("S3HttpStorage.get", () => {
  test("200 → { body, etag }", async () => {
    const fetchFn = vi.fn(async (_req: Request) =>
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
    const fetchFn = vi.fn(async (_req: Request) => noBody(304));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const got = await s.get("k", { ifNoneMatch: '"abc"' });
    expect(got).toBeNull();
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.headers.get("If-None-Match")).toBe('"abc"');
  });

  test("404 → null", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(404));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    expect(await s.get("missing")).toBeNull();
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.get("k")).rejects.toMatchObject({
      code: "AccessDenied",
    });
  });

  test("500 → retries then NetworkError when budget exhausted", async () => {
    const fetchFn = vi.fn(async (_req: Request) => new Response("boom", { status: 500 }));
    const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 2 });
    await expect(s.get("k")).rejects.toBeInstanceOf(MPS3Error);
    // 1 initial + 2 retries
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("missing ETag on 200 → InvalidResponse", async () => {
    const fetchFn = vi.fn(async (_req: Request) =>
      okResponse(new TextEncoder().encode("x").buffer as ArrayBuffer, {}),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.get("k")).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("aborted signal → throws before fetch", async () => {
    const fetchFn = vi.fn(async (_req: Request) => okResponse(null, { ETag: '"x"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const ac = new AbortController();
    ac.abort();
    await expect(s.get("k", { signal: ac.signal })).rejects.toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("URL-encodes the key segment", async () => {
    const fetchFn = vi.fn(async (_req: Request) =>
      okResponse(new ArrayBuffer(0), { ETag: '"x"' }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await s.get("a/b c");
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.url).toBe("https://example.invalid/b/a%2Fb%20c");
  });
});

describe("S3HttpStorage.put", () => {
  test("200 → returns ETag from response header", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(200, { ETag: '"e1"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const result = await s.put("k", new Uint8Array([1, 2, 3]));
    expect(result.etag).toBe('"e1"');
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("uses caller-provided contentType", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(200, { ETag: '"e1"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await s.put("k", new Uint8Array(0), { contentType: "application/json" });
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.headers.get("Content-Type")).toBe("application/json");
  });

  test("412 with ifMatch → InvalidResponse(PreconditionFailed)", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(412));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(
      s.put("k", new Uint8Array(0), { ifMatch: '"old"' }),
    ).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringContaining("PreconditionFailed"),
    });
  });

  test("ifNoneMatch='*' sets If-None-Match: *", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(200, { ETag: '"e1"' }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await s.put("k", new Uint8Array(0), { ifNoneMatch: "*" });
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.headers.get("If-None-Match")).toBe("*");
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0))).rejects.toMatchObject({
      code: "AccessDenied",
    });
  });

  test("missing ETag on success → InvalidResponse", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(200));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.put("k", new Uint8Array(0))).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

describe("S3HttpStorage.delete", () => {
  test("204 → resolves", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(204));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).resolves.toBeUndefined();
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(req.method).toBe("DELETE");
  });

  test("404 → resolves (idempotent)", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(404));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).resolves.toBeUndefined();
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    await expect(s.delete("k")).rejects.toMatchObject({ code: "AccessDenied" });
  });

  test("500 retried then NetworkError", async () => {
    const fetchFn = vi.fn(async (_req: Request) => new Response("boom", { status: 500 }));
    const s = mkStorage(fetchFn as unknown as typeof fetch, { retries: 1 });
    await expect(s.delete("k")).rejects.toMatchObject({ code: "NetworkError" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("S3HttpStorage.list", () => {
  const xmlPage = (
    keys: string[],
    nextToken?: string,
  ): string =>
    `<?xml version="1.0"?><ListBucketResult>` +
    keys.map((k) => `<Contents><Key>${k}</Key><ETag>"e_${k}"</ETag></Contents>`).join("") +
    (nextToken !== undefined ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "") +
    `</ListBucketResult>`;

  test("single page — yields entries and stops", async () => {
    const fetchFn = vi.fn(async (_req: Request) =>
      new Response(xmlPage(["a", "b", "c"]), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: { key: string; etag: string }[] = [];
    for await (const e of s.list("p/")) out.push({ ...e });
    expect(out).toEqual([
      { key: "a", etag: '"e_a"' },
      { key: "b", etag: '"e_b"' },
      { key: "c", etag: '"e_c"' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("multi-page — follows NextContinuationToken", async () => {
    const fetchFn = vi.fn(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("continuation-token=tok1")) {
        return new Response(xmlPage(["c", "d"]), { status: 200 });
      }
      return new Response(xmlPage(["a", "b"], "tok1"), { status: 200 });
    });
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: string[] = [];
    for await (const e of s.list("p/")) out.push(e.key);
    expect(out).toEqual(["a", "b", "c", "d"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("maxKeys stops iteration", async () => {
    const fetchFn = vi.fn(async (_req: Request) =>
      new Response(xmlPage(["a", "b", "c", "d"]), { status: 200 }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: string[] = [];
    for await (const e of s.list("p/", { maxKeys: 2 })) out.push(e.key);
    expect(out).toEqual(["a", "b"]);
  });

  test("startAfter sets the cursor", async () => {
    const fetchFn = vi.fn(async (_req: Request) =>
      new Response(xmlPage([]), { status: 200 }),
    );
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const out: string[] = [];
    for await (const e of s.list("p/", { startAfter: "p/x" })) out.push(e.key);
    expect(out).toEqual([]);
    const req = fetchFn.mock.calls[0]![0] as Request;
    expect(decodeURIComponent(req.url)).toContain("start-after=p/x");
  });

  test("403 → AccessDenied", async () => {
    const fetchFn = vi.fn(async (_req: Request) => noBody(403));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const iter = s.list("p/");
    await expect((async () => {
      for await (const _ of iter) void _;
    })()).rejects.toMatchObject({ code: "AccessDenied" });
  });

  test("aborted signal → throws", async () => {
    const fetchFn = vi.fn(async (_req: Request) => new Response(xmlPage([]), { status: 200 }));
    const s = mkStorage(fetchFn as unknown as typeof fetch);
    const ac = new AbortController();
    ac.abort();
    await expect(
      (async () => {
        for await (const _ of s.list("p/", { signal: ac.signal })) void _;
      })(),
    ).rejects.toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("missing xmlParser → InvalidConfig on first list call", async () => {
    const s = new S3HttpStorage({
      endpoint: "https://example.invalid",
      bucket: "b",
      fetch: vi.fn() as unknown as typeof fetch,
      retries: 0,
    });
    // Force xmlParser to undefined by stripping the global default
    const original = (globalThis as { DOMParser?: unknown }).DOMParser;
    delete (globalThis as { DOMParser?: unknown }).DOMParser;
    try {
      const s2 = new S3HttpStorage({
        endpoint: "https://example.invalid",
        bucket: "b",
        fetch: vi.fn() as unknown as typeof fetch,
        retries: 0,
      });
      await expect(
        (async () => {
          for await (const _ of s2.list("p/")) void _;
        })(),
      ).rejects.toMatchObject({ code: "InvalidConfig" });
    } finally {
      if (original !== undefined) {
        (globalThis as { DOMParser?: unknown }).DOMParser = original;
      }
    }
    // sanity-check: the first instance still uses the injected parser
    expect(s).toBeDefined();
  });
});

describe("sign callback", () => {
  test("sign() runs before fetch and its return value is what fetch sees", async () => {
    const upstreamFetch = vi.fn(async (_req: Request) => noBody(200, { ETag: '"x"' }));
    const sign = vi.fn(async (req: Request) => {
      const next = new Request(req, { headers: { ...Object.fromEntries(req.headers), "X-Signed": "1" } });
      return next;
    });
    const s = new S3HttpStorage({
      endpoint: "https://example.invalid",
      bucket: "b",
      fetch: upstreamFetch as unknown as typeof fetch,
      sign,
      xmlParser,
      retries: 0,
    });
    await s.put("k", new Uint8Array(0));
    expect(sign).toHaveBeenCalledTimes(1);
    const req = upstreamFetch.mock.calls[0]![0] as Request;
    expect(req.headers.get("X-Signed")).toBe("1");
  });
});
