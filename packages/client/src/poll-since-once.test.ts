import { describe, expect, test } from "vitest";
import type { SinceResponse } from "./contract.ts";
import { pollSinceOnce } from "./poll-since-once.ts";
import type { RequestContext } from "./request.ts";
import { MockFetch } from "./testing/index.ts";

const sinceBody = (): SinceResponse => ({ events: [], next_cursor: "c-2" });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ctxFor = (mock: MockFetch): RequestContext => ({
  baseUrl: "http://x",
  fetch: mock.fetch,
  headers: new Headers(),
});

describe("pollSinceOnce", () => {
  test("constructs /v1/since URL with table + cursor query params", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("table")).toBe("tickets");
      expect(url.searchParams.get("cursor")).toBe("c-1");
      return jsonResponse(sinceBody());
    });
    const res = await pollSinceOnce(ctxFor(mock), "tickets", "c-1", undefined);
    expect(res).toEqual({ events: [], next_cursor: "c-2" });
  });

  test("empty cursor is sent literally (the wire-protocol 'start at head' sentinel)", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("cursor")).toBe("");
      return jsonResponse(sinceBody());
    });
    await pollSinceOnce(ctxFor(mock), "tickets", "", undefined);
  });

  test("returns the raw envelope (events + next_cursor)", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () =>
      jsonResponse({
        events: [{ table: "tickets", _id: "a", op: "insert", lsn: "01" }],
        next_cursor: "c-3",
      }),
    );
    const res = await pollSinceOnce(ctxFor(mock), "tickets", "c-2", undefined);
    expect(res.events).toHaveLength(1);
    expect(res.next_cursor).toBe("c-3");
  });

  test("propagates the AbortSignal to the underlying fetch (and rejects when fired)", async () => {
    // Drive the underlying fetcher directly so we can observe signal
    // propagation without depending on MockFetch's regex matcher.
    let receivedSignal: AbortSignal | null = null;
    const ctx: RequestContext = {
      baseUrl: "http://x",
      fetch: async (req: Request) => {
        receivedSignal = req.signal;
        return new Promise<Response>((_, reject) => {
          if (req.signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          req.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      headers: new Headers(),
    };
    const controller = new AbortController();
    const promise = pollSinceOnce(ctx, "tickets", "", controller.signal);
    // Defer the abort one tick so the fetcher has registered its
    // listener.
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal).not.toBeNull();
  });

  test("transport errors bubble out (no swallowing)", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () =>
      jsonResponse({ error: { code: "Internal", message: "boom" } }, 500),
    );
    await expect(pollSinceOnce(ctxFor(mock), "tickets", "", undefined)).rejects.toMatchObject({
      name: "BaerlyError",
    });
  });

  test("table names are URL-encoded so '/' and '&' round-trip cleanly", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("table")).toBe("a/b&c");
      return jsonResponse(sinceBody());
    });
    await pollSinceOnce(ctxFor(mock), "a/b&c", "", undefined);
  });

  test("cursor values containing reserved URL characters round-trip cleanly", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get("cursor")).toBe("seq=42&extra");
      return jsonResponse(sinceBody());
    });
    await pollSinceOnce(ctxFor(mock), "tickets", "seq=42&extra", undefined);
  });
});
