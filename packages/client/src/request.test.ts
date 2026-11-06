import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { backoffMillis, parseRetryAfterMillis } from "./request-retry.ts";
import { type Fetcher, request, type RequestContext } from "./request.ts";

const okBody = { data: [1], _meta: { manifest_pointer: "c", fresh: true } };

const ok = (): Response => new Response(JSON.stringify(okBody), { status: 200 });

const envelope = (status: number, code: string): Response =>
  new Response(JSON.stringify({ error: { code, message: "from server", retriable: true } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const bare = (status: number, headers?: Record<string, string>): Response =>
  new Response("upstream sad", { status, headers });

/** A fetcher that plays `steps` in order (the last repeats) and counts calls. */
const scripted = (steps: ReadonlyArray<Response | Error>) => {
  const calls: Array<Request> = [];
  const fetch: Fetcher = (req) => {
    calls.push(req);
    const step = steps[Math.min(calls.length, steps.length) - 1];
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step!.clone());
  };
  const ctx: RequestContext = { baseUrl: "http://x", fetch, headers: new Headers() };
  return { ctx, calls };
};

const get = (ctx: RequestContext, signal?: AbortSignal) =>
  request<Array<number>>(ctx, { method: "GET", path: "/v1/c/t", signal });

/** Drive the retry backoff to completion without waiting in real time. */
const settle = async <T>(p: Promise<T>): Promise<T> => {
  const outcome = p.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const r = await outcome;
  if ("error" in r) {
    throw r.error;
  }
  return r.value;
};

describe("request GET retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test.each([502, 503, 504, 408, 429])(
    "retries an envelope-less %i then succeeds",
    async (status) => {
      const { ctx, calls } = scripted([bare(status), ok()]);
      await expect(settle(get(ctx))).resolves.toEqual([1]);
      expect(calls).toHaveLength(2);
      expect(calls[1]).not.toBe(calls[0]);
    },
  );

  test("retries a thrown fetch then succeeds", async () => {
    const { ctx, calls } = scripted([new TypeError("fetch failed"), ok()]);
    await expect(settle(get(ctx))).resolves.toEqual([1]);
    expect(calls).toHaveLength(2);
  });

  test.each([
    { error: "upstream unavailable" },
    { error: null },
    { error: {} },
    { error: { message: "upstream unavailable" } },
    { error: { code: 503, message: "upstream unavailable" } },
    { error: ["upstream unavailable"] },
  ])("retries a proxy JSON error without an envelope: $error", async ({ error }) => {
    const { ctx, calls } = scripted([Response.json({ error }, { status: 503 }), ok()]);
    await expect(settle(get(ctx))).resolves.toEqual([1]);
    expect(calls).toHaveLength(2);
  });

  test("cap reached: throws the same NetworkError as a single attempt", async () => {
    const { ctx, calls } = scripted([bare(503)]);
    const err = await settle(get(ctx)).catch((error: unknown) => error);
    expect(err).toMatchObject({ code: "NetworkError", status: 503, retriable: true });
    expect(calls).toHaveLength(3);
  });

  test("cap reached on a thrown fetch rethrows the original error", async () => {
    const boom = new TypeError("fetch failed");
    const { ctx, calls } = scripted([boom]);
    await expect(settle(get(ctx))).rejects.toBe(boom);
    expect(calls).toHaveLength(3);
  });

  test("a non-transient 4xx without an envelope is not retried", async () => {
    const { ctx, calls } = scripted([bare(404)]);
    await expect(settle(get(ctx))).rejects.toMatchObject({ code: "Internal", status: 404 });
    expect(calls).toHaveLength(1);
  });

  test("an enveloped NetworkError is not retried", async () => {
    const { ctx, calls } = scripted([envelope(503, "NetworkError"), ok()]);
    await expect(settle(get(ctx))).rejects.toMatchObject({ code: "NetworkError", status: 503 });
    expect(calls).toHaveLength(1);
  });

  test("an enveloped unknown code on a 5xx is not retried", async () => {
    const { ctx, calls } = scripted([envelope(503, "SomeFutureCode"), ok()]);
    await expect(settle(get(ctx))).rejects.toMatchObject({ code: "NetworkError", status: 503 });
    expect(calls).toHaveLength(1);
  });

  test("honours Retry-After delta-seconds", async () => {
    const { ctx, calls } = scripted([bare(503, { "retry-after": "3" }), ok()]);
    const p = get(ctx);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual([1]);
    expect(calls).toHaveLength(2);
  });

  test("honours Retry-After as an HTTP-date", async () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { ctx, calls } = scripted([
      bare(503, { "retry-after": "Tue, 01 Jan 2030 00:00:04 GMT" }),
      ok(),
    ]);
    const p = get(ctx);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual([1]);
  });

  test("a Retry-After beyond the ceiling is not waited on: fails as today", async () => {
    const { ctx, calls } = scripted([bare(503, { "retry-after": "86400" }), ok()]);
    await expect(settle(get(ctx))).rejects.toMatchObject({ code: "NetworkError", status: 503 });
    expect(calls).toHaveLength(1);
  });

  test("an unparseable Retry-After falls back to jittered backoff", async () => {
    const { ctx, calls } = scripted([bare(503, { "retry-after": "soon" }), ok()]);
    await expect(settle(get(ctx))).resolves.toEqual([1]);
    expect(calls).toHaveLength(2);
  });

  test("abort during backoff stops immediately with the abort reason", async () => {
    const { ctx, calls } = scripted([bare(503, { "retry-after": "5" }), ok()]);
    const controller = new AbortController();
    const p = get(ctx, controller.signal);
    const outcome = p.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    expect(calls).toHaveLength(1);
  });

  test("an AbortError from fetch is never retried", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const { ctx, calls } = scripted([abort, ok()]);
    await expect(settle(get(ctx))).rejects.toBe(abort);
    expect(calls).toHaveLength(1);
  });

  test("a signal aborted during a failed attempt makes no retry", async () => {
    const controller = new AbortController();
    const calls: Array<Request> = [];
    const ctx: RequestContext = {
      baseUrl: "http://x",
      headers: new Headers(),
      fetch: (req) => {
        calls.push(req);
        controller.abort();
        return Promise.reject(new TypeError("fetch failed"));
      },
    };
    await expect(settle(get(ctx, controller.signal))).rejects.toMatchObject({
      message: "fetch failed",
    });
    expect(calls).toHaveLength(1);
  });

  test("backoff is full-jitter exponential, capped", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(backoffMillis(0)).toBe(125);
    expect(backoffMillis(1)).toBe(250);
    expect(backoffMillis(20)).toBe(5_000);
  });

  test.each(["1.5", "-1", "", "soon"])("parseRetryAfterMillis rejects %j", (value) => {
    expect(parseRetryAfterMillis(value)).toBeUndefined();
  });
});

describe("request retry opt-out", () => {
  test("retry: false makes a GET single-attempt", async () => {
    const { ctx, calls } = scripted([bare(503), ok()]);
    await expect(
      request(ctx, { method: "GET", path: "/v1/c/t", retry: false }),
    ).rejects.toMatchObject({ code: "NetworkError", status: 503 });
    expect(calls).toHaveLength(1);
  });
});

describe("request non-GET is never retried", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "%s with an envelope-less 503 makes one call",
    async (method) => {
      const { ctx, calls } = scripted([bare(503), ok()]);
      await expect(
        settle(request(ctx, { method, path: "/v1/c/t", body: { a: 1 } })),
      ).rejects.toMatchObject({ code: "NetworkError", status: 503 });
      expect(calls).toHaveLength(1);
    },
  );

  test("POST with a thrown fetch makes one call", async () => {
    const boom = new TypeError("fetch failed");
    const { ctx, calls } = scripted([boom, ok()]);
    await expect(
      settle(request(ctx, { method: "POST", path: "/v1/c/t", body: { a: 1 } })),
    ).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });
});

/** The server's backpressure refusal: 503, enveloped, `Retry-After` + `retryAfter`. */
const pending = (opts: { header?: string; retryAfter?: number } = {}): Response =>
  new Response(
    JSON.stringify({
      error: {
        code: "MaintenancePending",
        message: "waiting on maintenance",
        retriable: true,
        ...(opts.retryAfter !== undefined && { retryAfter: opts.retryAfter }),
      },
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        ...(opts.header !== undefined && { "retry-after": opts.header }),
      },
    },
  );

/** The success each verb's route answers with. */
const served = (method: string): Response => {
  if (method === "GET") {
    return ok();
  }
  if (method === "POST") {
    return new Response(JSON.stringify({ _id: "a" }), { status: 201 });
  }
  if (method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ modified: 1 }), { status: 200 });
};

describe("request MaintenancePending retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test.each(["GET", "POST", "PATCH", "PUT", "DELETE"] as const)(
    "%s is resent after Retry-After with the identical body",
    async (method) => {
      const { ctx, calls } = scripted([pending({ header: "2", retryAfter: 2 }), served(method)]);
      const body = method === "GET" || method === "DELETE" ? undefined : { doc: { _id: "a" } };
      const outcome = request(ctx, { method, path: "/v1/c/t/a", body }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toBe("resolved");
      expect(calls).toHaveLength(2);
      expect(calls[1]!.method).toBe(method);
      const first = await calls[0]!.text();
      await expect(calls[1]!.text()).resolves.toBe(first);
    },
  );

  test("the envelope's retryAfter is honoured without a header", async () => {
    const { ctx, calls } = scripted([pending({ retryAfter: 3 }), served("POST")]);
    const p = request(ctx, { method: "POST", path: "/v1/c/t", body: { doc: {} } });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ _id: "a" });
    expect(calls).toHaveLength(2);
  });

  test("the longer of header and envelope hint wins", async () => {
    const { ctx, calls } = scripted([pending({ header: "4", retryAfter: 1 }), served("PATCH")]);
    const p = request(ctx, { method: "PATCH", path: "/v1/c/t/a", body: { patch: {} } });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toEqual({ modified: 1 });
    expect(calls).toHaveLength(2);
  });

  test("with no hint at all it falls back to jittered backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ctx, calls } = scripted([pending(), served("PUT")]);
    await settle(request(ctx, { method: "PUT", path: "/v1/c/t/a", body: { doc: {} } }));
    expect(calls).toHaveLength(2);
  });

  test("the attempt cap is reached, then the MaintenancePending error surfaces", async () => {
    const { ctx, calls } = scripted([pending({ header: "1", retryAfter: 1 })]);
    await expect(
      settle(request(ctx, { method: "POST", path: "/v1/c/t", body: { doc: {} } })),
    ).rejects.toMatchObject({ code: "MaintenancePending", status: 503, retryAfter: 1 });
    expect(calls).toHaveLength(3);
  });

  test("a hint above the wait ceiling surfaces the error without waiting", async () => {
    const { ctx, calls } = scripted([pending({ header: "60", retryAfter: 60 }), served("POST")]);
    await expect(
      request(ctx, { method: "POST", path: "/v1/c/t", body: { doc: {} } }),
    ).rejects.toMatchObject({ code: "MaintenancePending", retryAfter: 60 });
    expect(calls).toHaveLength(1);
  });

  test("retry: false surfaces the first MaintenancePending", async () => {
    const { ctx, calls } = scripted([pending({ retryAfter: 1 }), ok()]);
    await expect(
      request(ctx, { method: "GET", path: "/v1/since", retry: false }),
    ).rejects.toMatchObject({ code: "MaintenancePending", retryAfter: 1 });
    expect(calls).toHaveLength(1);
  });

  test("an abort during the wait stops at once", async () => {
    const ac = new AbortController();
    const reason = new Error("stop");
    const { ctx, calls } = scripted([pending({ retryAfter: 1 }), served("POST")]);
    const p = request(ctx, {
      method: "POST",
      path: "/v1/c/t",
      body: { doc: {} },
      signal: ac.signal,
    });
    const outcome = p.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    ac.abort(reason);
    await expect(outcome).resolves.toBe(reason);
    expect(calls).toHaveLength(1);
  });

  test("a non-GET resent after MaintenancePending still sends an envelope-less 503 once", async () => {
    const { ctx, calls } = scripted([pending({ retryAfter: 1 }), bare(503), served("POST")]);
    await expect(
      settle(request(ctx, { method: "POST", path: "/v1/c/t", body: { doc: {} } })),
    ).rejects.toMatchObject({ code: "NetworkError", status: 503 });
    expect(calls).toHaveLength(2);
  });

  test.each(["GET", "POST", "PATCH", "PUT", "DELETE"] as const)(
    "%s is never resent after CapacityExceeded or an enveloped NetworkError",
    async (method) => {
      for (const [status, code] of [
        [409, "CapacityExceeded"],
        [502, "NetworkError"],
      ] as const) {
        const { ctx, calls } = scripted([envelope(status, code), served(method)]);
        await expect(
          settle(
            request(ctx, { method, path: "/v1/c/t/a", body: method === "GET" ? undefined : {} }),
          ),
        ).rejects.toMatchObject({ code, status });
        expect(calls).toHaveLength(1);
      }
    },
  );

  test("retryAfter stays off a code other than MaintenancePending", async () => {
    const { ctx } = scripted([bare(503, { "retry-after": "1" })]);
    const error = await request(ctx, { method: "POST", path: "/v1/c/t", body: {} }).then(
      () => undefined,
      (error_: unknown) => error_ as { code?: string; retryAfter?: number },
    );
    expect(error?.code).toBe("NetworkError");
    expect(error?.retryAfter).toBeUndefined();
  });
});
