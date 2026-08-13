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

const sinceOk = (nextCursor = ""): Response =>
  new Response(JSON.stringify({ events: [], next_cursor: nextCursor }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const sinceError = (
  code: "SchemaError" | "Unauthorized",
  status: number,
  retriable: boolean,
): Response =>
  new Response(
    JSON.stringify({
      error: { code, message: `${code} from test`, retriable },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

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

  test("a terminal poll error stops retrying and preserves successful query data", async () => {
    let rejectPoll: ((response: Response) => void) | undefined;
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return new Promise<Response>((resolve) => {
        rejectPoll = resolve;
      });
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const notify = vi.fn<() => void>();
      const unsubscribe = pool.attach(
        "terminal",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "before-expiry" }]),
        notify,
      );
      await waitMicrotasks();
      expect(pool.getSnapshot("terminal")).toMatchObject({
        status: "ok",
        data: [{ _id: "before-expiry" }],
      });

      rejectPoll?.(sinceError("Unauthorized", 401, false));
      await waitMicrotasks(12);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(sinceCalls).toBe(1);
      expect(pool.getSnapshot("terminal")).toMatchObject({
        status: "error",
        data: [{ _id: "before-expiry" }],
        error: { code: "Unauthorized", retriable: false },
      });
      expect(notify).toHaveBeenCalled();
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  // One `InvalidResponse` case is enough here: malformed JSON and a
  // wrong `SinceResponse` shape both reach the pool as the same
  // non-retriable `InvalidResponse` `BaerlyError`, so they take one code
  // path. Which successful-200 bodies produce that error is
  // `pollSinceOnce`'s contract, pinned in `poll-since-once.test.ts`.
  test("a malformed successful poll response is terminal and preserves successful query data", async () => {
    let releasePoll: ((response: Response) => void) | undefined;
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return new Promise<Response>((resolve) => {
        releasePoll = resolve;
      });
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const signature = "invalid-response";
      const unsubscribe = pool.attach(
        signature,
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "last-good" }]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks();
      expect(pool.getSnapshot(signature)).toMatchObject({
        status: "ok",
        data: [{ _id: "last-good" }],
      });

      releasePoll?.(
        new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      );
      await waitMicrotasks(16);
      expect(pool.getSnapshot(signature)).toMatchObject({
        status: "error",
        data: [{ _id: "last-good" }],
        error: { code: "InvalidResponse" },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sinceCalls).toBe(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a complete unsubscribe after a terminal poll error permits a fresh poll", async () => {
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return Promise.resolve(sinceError("Unauthorized", 401, false));
    });
    const client = makeClient(mock);
    const pool = poolFor(client);
    const attach = () =>
      pool.attach(
        "terminal-remount",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );

    const firstUnsubscribe = attach();
    await waitMicrotasks(12);
    expect(sinceCalls).toBe(1);
    firstUnsubscribe();

    const secondUnsubscribe = attach();
    await waitMicrotasks(12);
    expect(sinceCalls).toBe(2);
    secondUnsubscribe();
  });

  test("a subscriber joining a terminal table receives its error without reviving the dead poll", async () => {
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return Promise.resolve(sinceError("Unauthorized", 401, false));
    });
    const client = makeClient(mock);
    const pool = poolFor(client);
    const firstUnsubscribe = pool.attach(
      "terminal-first",
      ["notes"],
      new Set(["notes"]),
      vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "first" }]),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(12);
    expect(pool.getSnapshot("terminal-first").status).toBe("error");

    const secondUnsubscribe = pool.attach(
      "terminal-second",
      ["notes"],
      new Set(["notes"]),
      vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "second" }]),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(12);

    expect(sinceCalls).toBe(1);
    expect(pool.getSnapshot("terminal-second")).toMatchObject({
      status: "error",
      data: undefined,
      error: { code: "Unauthorized" },
    });
    firstUnsubscribe();
    secondUnsubscribe();
  });

  test("another table's event cannot mask a terminal error, but refetch restarts only the failed poll", async () => {
    let releaseComments: ((response: Response) => void) | undefined;
    let notesSinceCalls = 0;
    const signals = {
      comments: new Set<AbortSignal>(),
      notes: new Set<AbortSignal>(),
    };
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      const collection = new URL(req.url).searchParams.get("collection");
      if (collection === "notes") {
        notesSinceCalls += 1;
        signals.notes.add(req.signal);
        return notesSinceCalls === 1
          ? Promise.resolve(sinceError("Unauthorized", 401, false))
          : sinceForever();
      }
      signals.comments.add(req.signal);
      return new Promise<Response>((resolve) => {
        releaseComments = resolve;
      });
    });
    const client = makeClient(mock);
    const pool = poolFor(client);
    const fetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "last-good" }]);
    const unsubscribe = pool.attach(
      "terminal-multi-table",
      ["comments", "notes"],
      new Set(["comments", "notes"]),
      fetcher,
      vi.fn<() => void>(),
    );
    await waitMicrotasks(16);
    expect(pool.getSnapshot("terminal-multi-table").status).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(1);

    releaseComments?.(
      new Response(
        JSON.stringify({ events: [{ lsn: "aaa_bbb_ccc" }], next_cursor: "comments-cursor" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await waitMicrotasks(16);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(pool.getSnapshot("terminal-multi-table")).toMatchObject({
      status: "error",
      data: [{ _id: "last-good" }],
      error: { code: "Unauthorized" },
    });
    expect(notesSinceCalls).toBe(1);
    const commentsSignalsBeforeRecovery = [...signals.comments];

    pool.refetch("terminal-multi-table");
    await waitMicrotasks(16);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(pool.getSnapshot("terminal-multi-table")).toMatchObject({
      status: "ok",
      data: [{ _id: "last-good" }],
      error: undefined,
    });
    expect(notesSinceCalls).toBe(2);
    expect(signals.notes.size).toBe(2);
    expect([...signals.comments]).toEqual(commentsSignalsBeforeRecovery);
    const [oldNotesSignal, liveNotesSignal] = [...signals.notes];
    expect(oldNotesSignal?.aborted).toBe(true);
    expect(liveNotesSignal?.aborted).toBe(false);
    expect(commentsSignalsBeforeRecovery.every((signal) => !signal.aborted)).toBe(true);
    unsubscribe();
  });

  test("refetch restarts one shared terminal poll and preserves its refcount", async () => {
    const pollSignals = new Set<AbortSignal>();
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      sinceCalls += 1;
      pollSignals.add(req.signal);
      return sinceCalls === 1
        ? Promise.resolve(sinceError("Unauthorized", 401, false))
        : sinceForever();
    });
    const client = makeClient(mock);
    const pool = poolFor(client);
    const firstFetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "first" }]);
    const secondFetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "second" }]);
    const firstUnsubscribe = pool.attach(
      "shared-terminal-first",
      ["notes"],
      new Set(["notes"]),
      firstFetcher,
      vi.fn<() => void>(),
    );
    const secondUnsubscribe = pool.attach(
      "shared-terminal-second",
      ["notes"],
      new Set(["notes"]),
      secondFetcher,
      vi.fn<() => void>(),
    );
    await waitMicrotasks(16);
    expect(pool.getSnapshot("shared-terminal-first").status).toBe("error");
    expect(pool.getSnapshot("shared-terminal-second").status).toBe("error");

    pool.refetch("shared-terminal-first");
    pool.refetch("shared-terminal-second");
    await waitMicrotasks(16);

    expect(firstFetcher).toHaveBeenCalledTimes(2);
    expect(secondFetcher).toHaveBeenCalledTimes(2);
    expect(sinceCalls).toBe(2);
    expect(pollSignals.size).toBe(2);
    const [oldSignal, recoveredSignal] = [...pollSignals];
    expect(oldSignal?.aborted).toBe(true);
    expect(recoveredSignal?.aborted).toBe(false);

    firstUnsubscribe();
    expect(recoveredSignal?.aborted).toBe(false);
    secondUnsubscribe();
    expect(recoveredSignal?.aborted).toBe(true);
  });

  test("retriable transport failures use jittered exponential backoff and reset after success", async () => {
    const callTimes: number[] = [];
    let calls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      calls += 1;
      callTimes.push(Date.now());
      if (calls === 1 || calls === 2 || calls === 4) {
        throw new TypeError("transport unavailable");
      }
      if (calls === 3) {
        return Promise.resolve(sinceOk());
      }
      return sinceForever();
    });
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "backoff",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(12);
      expect(callTimes).toEqual([0]);

      await vi.advanceTimersByTimeAsync(124);
      expect(callTimes).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(callTimes).toEqual([0, 125]);

      await vi.advanceTimersByTimeAsync(249);
      expect(callTimes).toEqual([0, 125]);
      await vi.advanceTimersByTimeAsync(1);
      await waitMicrotasks(12);
      expect(callTimes).toEqual([0, 125, 375, 375]);

      await vi.advanceTimersByTimeAsync(124);
      expect(callTimes).toEqual([0, 125, 375, 375]);
      await vi.advanceTimersByTimeAsync(1);
      expect(callTimes).toEqual([0, 125, 375, 375, 500]);
      unsubscribe();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  test("retriable poll backoff stops growing at its configured cap", async () => {
    const callTimes: number[] = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      callTimes.push(Date.now());
      if (callTimes.length < 9) {
        throw new TypeError("transport unavailable");
      }
      return sinceForever();
    });
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "backoff-cap",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(12);
      await vi.advanceTimersByTimeAsync(17_875);

      expect(callTimes).toHaveLength(9);
      expect(callTimes.slice(1).map((time, index) => time - callTimes[index]!)).toEqual([
        125, 250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
      ]);
      unsubscribe();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  test("unsubscribe cancels a pending retry after a retriable poll failure", async () => {
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      throw new TypeError("transport unavailable");
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "abort-retry",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(12);
      expect(sinceCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      unsubscribe();
      await waitMicrotasks();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sinceCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

      // The re-bootstrap is deliberately behind the retry backoff, not
      // immediate — see the oscillation test below for why.
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
    // through to the retry backoff rather than `continue` past it;
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
    vi.spyOn(Math, "random").mockReturnValue(0.999);
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
        await vi.advanceTimersByTimeAsync(250);
      }
      unsubscribe();

      // Two requests per backoff cycle (bootstrap + doomed resume), so
      // ~1.25 simulated seconds stays below 20. A successful bootstrap
      // resets the attempt counter, so every doomed resume uses the
      // initial jitter window. Without any backoff the loop is bounded
      // only by microtask scheduling and blows past this.
      expect(requests).toBeLessThan(20);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
