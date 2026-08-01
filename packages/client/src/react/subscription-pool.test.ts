import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { LOADING_SNAPSHOT, poolFor } from "./subscription-pool.ts";

const sinceForever = (): Promise<Response> => new Promise<Response>(() => {});

const makeClient = (mock: MockFetch) =>
  createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });

const waitMicrotasks = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
};

describe("subscription-pool", () => {
  test("returns LOADING_SNAPSHOT before any subscription", () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", sinceForever);
    const client = makeClient(mock);
    const pool = poolFor(client);
    expect(pool.getSnapshot("missing-sig")).toBe(LOADING_SNAPSHOT);
  });

  test("attach with no cache triggers the fetcher and surfaces the resolved value", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", sinceForever);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const fetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "a" }]);
    const notify = vi.fn<() => void>();
    const unsubscribe = pool.attach("sig-A", ["notes"], new Set(["notes"]), fetcher, notify);
    await waitMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalled();
    expect(pool.getSnapshot("sig-A")).toEqual({
      status: "ok",
      data: [{ _id: "a" }],
      error: undefined,
    });
    unsubscribe();
  });

  test("two subscribers with the same signature share one cache + one fetch", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", sinceForever);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const fetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "x" }]);
    const u1 = pool.attach("shared", ["notes"], new Set(["notes"]), fetcher, vi.fn<() => void>());
    const u2 = pool.attach("shared", ["notes"], new Set(["notes"]), fetcher, vi.fn<() => void>());
    await waitMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const snap1 = pool.getSnapshot("shared");
    const snap2 = pool.getSnapshot("shared");
    expect(snap1).toBe(snap2); // same reference
    u1();
    u2();
  });

  test("rejection surfaces as { status: 'error', error: BaerlyError }", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", sinceForever);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const fetcher = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(new BaerlyError("Conflict", "lost"));
    const unsubscribe = pool.attach(
      "sig-E",
      ["notes"],
      new Set(["notes"]),
      fetcher,
      vi.fn<() => void>(),
    );
    await waitMicrotasks();
    const snap = pool.getSnapshot("sig-E");
    expect(snap.status).toBe("error");
    expect(snap.error).toBeInstanceOf(BaerlyError);
    unsubscribe();
  });

  test("refcount: last unsubscribe evicts the cache entry", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", sinceForever);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const fetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue("hello");
    const u1 = pool.attach("evict", ["notes"], new Set(["notes"]), fetcher, vi.fn<() => void>());
    const u2 = pool.attach("evict", ["notes"], new Set(["notes"]), fetcher, vi.fn<() => void>());
    await waitMicrotasks();
    expect(pool.getSnapshot("evict")).toMatchObject({ status: "ok", data: "hello" });
    u1();
    // still has one subscriber → cache intact
    expect(pool.getSnapshot("evict")).toMatchObject({ status: "ok" });
    u2();
    // no subscribers → cache evicted → LOADING_SNAPSHOT
    expect(pool.getSnapshot("evict")).toBe(LOADING_SNAPSHOT);
  });

  test("poolFor returns the same pool for the same client (cached)", () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", sinceForever);
    const client = makeClient(mock);
    expect(poolFor(client)).toBe(poolFor(client));
  });

  test("SchemaError re-bootstraps the cursor instead of retrying it", async () => {
    // `/v1/since` returns SchemaError (400) for two permanent cursor
    // states: the entry was folded into a snapshot and GC'd, or the
    // cursor was minted in a generation `restore --force` truncated.
    // Neither clears on retry, so the pool must drop the cursor and
    // re-bootstrap. Before this behaviour existed the loop retried the
    // same rejected cursor at 1 req/s forever with the table frozen.
    const cursors: (string | null)[] = [];
    let servedEvent = false;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req: Request) => {
      const url = new URL(req.url);
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor !== null && cursor.length > 0) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "SchemaError", message: "cursor … generation that no longer exists" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (servedEvent) {
        // Subsequent bootstraps hang, like a real idle long-poll. The
        // request is still recorded above, which is all the assertion
        // needs. Resolving instantly instead would spin the poll loop
        // in microtasks with no timer to yield to, and the fake-timer
        // advance below would never return.
        return sinceForever();
      }
      servedEvent = true;
      // Bootstrap poll: hand back one event so the pool adopts a cursor.
      return Promise.resolve(
        new Response(
          JSON.stringify({ events: [{ lsn: "aaa_bbb_ccc" }], next_cursor: "deadbeef.aaa_bbb_ccc" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const fetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
      const unsubscribe = pool.attach(
        "gen",
        ["notes"],
        new Set(["notes"]),
        fetcher,
        vi.fn<() => void>(),
      );

      await waitMicrotasks(40);

      // The rejected cursor must not be retried: after the 400 the pool
      // goes back to "" rather than sending `deadbeef.…` a second time.
      expect(cursors.filter((c) => c === "deadbeef.aaa_bbb_ccc")).toHaveLength(1);

      // The re-bootstrap is deliberately behind the 1s error backoff,
      // not immediate — see the oscillation test below for why.
      await vi.advanceTimersByTimeAsync(1_000);
      unsubscribe();
      expect(cursors.filter((c) => c === "" || c === null).length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a cursor rejected on every lap backs off instead of hot-looping", async () => {
    // The shape a mixed-version fleet produces mid-rolling-deploy: one
    // replica hands back a cursor the other refuses. The
    // `poll.cursor !== ""` guard bounds a same-iteration respin but NOT
    // this two-iteration oscillation — "" succeeds, adopts a cursor,
    // that cursor 400s, repeat. So the SchemaError path must fall
    // through to the 1s backoff rather than `continue` past it;
    // otherwise this runs at network speed with an invalidate storm
    // every lap.
    let requests = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req: Request) => {
      requests += 1;
      if (requests > 200) {
        // Circuit breaker. On regression the loop spins at microtask
        // speed and never yields to a timer, so `advanceTimersByTime`
        // would pump forever and hang the runner. Parking the poll here
        // lets the advance return and the bound below fail loudly.
        return sinceForever();
      }
      const cursor = new URL(req.url).searchParams.get("cursor");
      if (cursor !== null && cursor.length > 0) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "SchemaError", message: "dead cursor" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      // Bootstrap always succeeds, and always hands back a doomed cursor.
      return Promise.resolve(
        new Response(
          JSON.stringify({ events: [{ lsn: "aaa_bbb_ccc" }], next_cursor: "deadbeef.aaa_bbb_ccc" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });

    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "gen",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );

      await waitMicrotasks(40);
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      unsubscribe();

      // Two requests per backoff cycle (bootstrap + doomed resume), so
      // ~5 simulated seconds is ~12. Without the backoff the loop is
      // bounded only by microtask scheduling and blows past this.
      expect(requests).toBeLessThan(20);
    } finally {
      vi.useRealTimers();
    }
  });
});
