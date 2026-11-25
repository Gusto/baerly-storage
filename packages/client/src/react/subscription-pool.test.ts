import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { createBaerlyClient } from "../client.ts";
import { withSignal } from "../internal/context.ts";
import { MockFetch } from "../testing/index.ts";
import { jsonResponse } from "../../../../tests/fixtures/json-response.ts";
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
  code: "CursorExpired" | "SchemaError" | "Unauthorized",
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
      .mockRejectedValue(new BaerlyError("WriteConflict", "lost"));
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
    // Three, not two: the first refetch revived the shared poll and
    // swept the second signature out of its stale error, then the
    // second refetch dispatched it again on its own account. The
    // second refetch finds a healthy poll, so `sinceCalls` stays at 2.
    expect(secondFetcher).toHaveBeenCalledTimes(3);
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

  test("refetch on one signature also clears the stale error on its siblings", async () => {
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return sinceCalls === 1
        ? Promise.resolve(sinceError("Unauthorized", 401, false))
        : sinceForever();
    });
    const client = makeClient(mock);
    const pool = poolFor(client);
    const callerFetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "caller" }]);
    const bystanderFetcher = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue([{ _id: "bystander" }]);
    const callerUnsubscribe = pool.attach(
      "sibling-caller",
      ["notes"],
      new Set(["notes"]),
      callerFetcher,
      vi.fn<() => void>(),
    );
    const bystanderUnsubscribe = pool.attach(
      "sibling-bystander",
      ["notes"],
      new Set(["notes"]),
      bystanderFetcher,
      vi.fn<() => void>(),
    );
    await waitMicrotasks(16);
    expect(pool.getSnapshot("sibling-caller").status).toBe("error");
    expect(pool.getSnapshot("sibling-bystander").status).toBe("error");

    // Only the caller refetches. The revived poll is healthy but the
    // collection is quiet, so no `/v1/since` event will ever arrive to
    // invalidate the bystander — reviving the poll has to clear it.
    pool.refetch("sibling-caller");
    await waitMicrotasks(16);

    expect(pool.getSnapshot("sibling-caller")).toMatchObject({
      status: "ok",
      data: [{ _id: "caller" }],
      error: undefined,
    });
    expect(pool.getSnapshot("sibling-bystander")).toMatchObject({
      status: "ok",
      data: [{ _id: "bystander" }],
      error: undefined,
    });
    // Each signature is dispatched exactly once by the refetch — the
    // caller directly, the bystander through the revival sweep that
    // skips it.
    expect(callerFetcher).toHaveBeenCalledTimes(2);
    expect(bystanderFetcher).toHaveBeenCalledTimes(2);

    callerUnsubscribe();
    bystanderUnsubscribe();
  });

  test("refetch dispatches a multi-table sibling once when both terminal polls revive", async () => {
    const sinceCalls = new Map<string, number>();
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      const collection = new URL(req.url).searchParams.get("collection") ?? "";
      const calls = (sinceCalls.get(collection) ?? 0) + 1;
      sinceCalls.set(collection, calls);
      return calls === 1 ? Promise.resolve(sinceError("Unauthorized", 401, false)) : sinceForever();
    });
    const client = makeClient(mock);
    const pool = poolFor(client);
    const callerFetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "caller" }]);
    const siblingFetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "sibling" }]);
    const tables = ["comments", "notes"];
    const chainTables = new Set(tables);
    const callerUnsubscribe = pool.attach(
      "multi-table-caller",
      tables,
      chainTables,
      callerFetcher,
      vi.fn<() => void>(),
    );
    const siblingUnsubscribe = pool.attach(
      "multi-table-sibling",
      tables,
      chainTables,
      siblingFetcher,
      vi.fn<() => void>(),
    );
    await waitMicrotasks(16);
    expect(pool.getSnapshot("multi-table-caller").status).toBe("error");
    expect(pool.getSnapshot("multi-table-sibling").status).toBe("error");

    pool.refetch("multi-table-caller");
    await waitMicrotasks(16);

    expect(callerFetcher).toHaveBeenCalledTimes(2);
    expect(siblingFetcher).toHaveBeenCalledTimes(2);
    expect(sinceCalls).toEqual(
      new Map([
        ["comments", 2],
        ["notes", 2],
      ]),
    );

    callerUnsubscribe();
    siblingUnsubscribe();
  });

  test("a non-envelope gateway 5xx retries instead of killing the poll", async () => {
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      // What a load balancer returns mid-rolling-deploy: a 5xx whose
      // body is not an `HttpErrorEnvelope`, so the client has to infer
      // the failure class from the status alone.
      return Promise.resolve(
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      );
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "gateway-5xx",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "last-good" }]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(16);
      expect(sinceCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(sinceCalls).toBeGreaterThan(1);
      // A retriable poll failure never fails the query, so subscribers
      // keep their data instead of being parked on a terminal error.
      expect(pool.getSnapshot("gateway-5xx")).toMatchObject({
        status: "ok",
        data: [{ _id: "last-good" }],
        error: undefined,
      });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
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
      vi.useRealTimers();
    }
  });

  test("a poll that keeps failing keeps retrying at a bounded interval", async () => {
    // The delay arithmetic — doubling, the cap, the jitter band — is
    // pinned in `subscription-retry.test.ts` against `retryDelay`
    // directly. What only the pool can show is that it feeds that
    // function a monotonically rising attempt and never gives up: no
    // max-attempts bail-out parks a table on a transport blip.
    const callTimes: number[] = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      callTimes.push(Date.now());
      throw new TypeError("transport unavailable");
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
      await vi.advanceTimersByTimeAsync(60_000);

      const gaps = callTimes.slice(1).map((time, index) => time - callTimes[index]!);
      // Rising while the bound doubles, then flat once it saturates,
      // with polls still arriving at the far end of the window.
      expect(gaps.length).toBeGreaterThan(8);
      for (let index = 1; index < 6; index += 1) {
        expect(gaps[index]!, `gap ${index}`).toBeGreaterThan(gaps[index - 1]!);
      }
      expect(new Set(gaps.slice(7)).size).toBe(1);
      unsubscribe();
    } finally {
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

  test("CursorExpired re-bootstraps the cursor instead of retrying it", async () => {
    // `/v1/since` returns CursorExpired (410) for two permanent cursor
    // states: the entries past it are no longer retained, or the cursor
    // was minted in a generation `restore --force` truncated. Neither
    // clears on retry, so the pool must drop the cursor and re-bootstrap.
    // Before this behaviour existed the loop retried the same rejected
    // cursor at 1 req/s forever with the table frozen.
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
              error: {
                code: "CursorExpired",
                message: "cursor … generation that no longer exists",
                retriable: false,
              },
            }),
            { status: 410, headers: { "content-type": "application/json" } },
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

      // The rejected cursor must not be retried: after the 410 the pool
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

  test("SchemaError on a resumed cursor parks the poll instead of re-bootstrapping", async () => {
    // A malformed cursor is a caller bug, not an expired one: only
    // CursorExpired drops the cursor. Any other non-retriable code parks
    // the poll until `refetch`.
    const cursors: (string | null)[] = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req: Request) => {
      const cursor = new URL(req.url).searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor !== null && cursor.length > 0) {
        return Promise.resolve(sinceError("SchemaError", 400, false));
      }
      return sinceOk("deadbeef.aaa_bbb_ccc");
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "malformed",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(40);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cursors).toEqual(["", "deadbeef.aaa_bbb_ccc"]);
      expect(pool.getSnapshot("malformed")).toMatchObject({
        status: "error",
        error: { code: "SchemaError" },
      });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a repeatedly rejected replacement cursor retains backoff across bootstrap success", async () => {
    // A cursor that expires again before it is used: "" succeeds,
    // adopts a cursor, that cursor 410s, repeat. The
    // `poll.cursor !== ""` guard bounds a same-iteration respin but NOT
    // this two-iteration oscillation. So the CursorExpired path must fall
    // through to the retry backoff rather than `continue` past it. The
    // successful bootstrap only supplies a candidate replacement; it
    // must not reset backoff until that replacement cursor succeeds.
    const callTimes: number[] = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req: Request) => {
      callTimes.push(Date.now());
      const cursor = new URL(req.url).searchParams.get("cursor");
      if (cursor !== null && cursor.length > 0) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "CursorExpired", message: "dead cursor" } }),
            { status: 410, headers: { "content-type": "application/json" } },
          ),
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
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
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
      expect(callTimes).toEqual([0, 0]);
      await vi.advanceTimersByTimeAsync(125);
      expect(callTimes).toEqual([0, 0, 125, 125]);
      await vi.advanceTimersByTimeAsync(125);
      expect(callTimes).toEqual([0, 0, 125, 125]);
      await vi.advanceTimersByTimeAsync(125);
      expect(callTimes).toEqual([0, 0, 125, 125, 375, 375]);
      await vi.advanceTimersByTimeAsync(500);
      expect(callTimes).toEqual([0, 0, 125, 125, 375, 375, 875, 875]);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an empty bootstrap adopts its position cursor without invalidating", async () => {
    // `/v1/since` answers `""` with a position cursor even when every
    // change is already folded. Staying on `""` would let a change commit
    // and fold between two polls unseen, so the pool must send it next.
    const cursors: Array<string | null> = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req: Request) => {
      cursors.push(new URL(req.url).searchParams.get("cursor"));
      return cursors.length === 1 ? sinceOk("deadbeef.0_0_vvvvvvvvvvu") : sinceForever();
    });
    const client = makeClient(mock);
    const pool = poolFor(client);
    const fetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
    const unsubscribe = pool.attach(
      "position",
      ["notes"],
      new Set(["notes"]),
      fetcher,
      vi.fn<() => void>(),
    );
    await waitMicrotasks(40);
    expect(cursors).toEqual(["", "deadbeef.0_0_vvvvvvvvvvu"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("an empty recovery bootstrap with a position cursor keeps backoff until that cursor succeeds", async () => {
    // As the repeatedly-rejected case above, but the bootstrap carries no
    // events: a position cursor is still an unproven replacement.
    const callTimes: number[] = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req: Request) => {
      callTimes.push(Date.now());
      const cursor = new URL(req.url).searchParams.get("cursor");
      if (cursor !== null && cursor.length > 0) {
        return Promise.resolve(sinceError("CursorExpired", 410, false));
      }
      return sinceOk("deadbeef.0_0_vvvvvvvvvvu");
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "empty-position-recovery",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );

      await waitMicrotasks(40);
      expect(callTimes).toEqual([0, 0]);
      await vi.advanceTimersByTimeAsync(125);
      expect(callTimes).toEqual([0, 0, 125, 125]);
      await vi.advanceTimersByTimeAsync(250);
      expect(callTimes).toEqual([0, 0, 125, 125, 375, 375]);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an empty recovery bootstrap resets backoff when it yields no replacement cursor", async () => {
    const callTimes: number[] = [];
    const cursors: Array<string | null> = [];
    let call = 0;
    let unsubscribe: (() => void) | undefined;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req: Request) => {
      call += 1;
      callTimes.push(Date.now());
      cursors.push(new URL(req.url).searchParams.get("cursor"));
      if (call === 1) {
        return sinceOk("deadbeef.aaa_bbb_ccc");
      }
      if (call === 2) {
        return sinceError("CursorExpired", 410, false);
      }
      if (call === 3) {
        return sinceOk("");
      }
      if (call === 4) {
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
      unsubscribe = pool.attach(
        "empty-recovery-tail",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([]),
        vi.fn<() => void>(),
      );

      await waitMicrotasks(40);
      expect(callTimes).toEqual([0, 0]);
      expect(cursors).toEqual(["", "deadbeef.aaa_bbb_ccc"]);

      await vi.advanceTimersByTimeAsync(125);
      expect(callTimes).toEqual([0, 0, 125, 125]);
      expect(cursors).toEqual(["", "deadbeef.aaa_bbb_ccc", "", ""]);

      await vi.advanceTimersByTimeAsync(124);
      expect(callTimes).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(callTimes).toEqual([0, 0, 125, 125, 250]);
    } finally {
      unsubscribe?.();
      vi.useRealTimers();
    }
  });

  const pendingPoll = (opts: { header?: string; retryAfter?: number }): Response =>
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

  test.each([
    ["the envelope's retryAfter", { retryAfter: 2 }],
    ["the Retry-After header", { header: "2" }],
  ])("MaintenancePending waits for %s, not the shorter backoff", async (_label, hint) => {
    const callTimes: number[] = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      callTimes.push(Date.now());
      return callTimes.length === 1 ? Promise.resolve(pendingPoll(hint)) : sinceForever();
    });
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Backoff alone would re-poll at 125 ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "pending",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "kept" }]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(12);
      expect(callTimes).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(callTimes).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(callTimes).toEqual([0, 2_000]);
      expect(pool.getSnapshot("pending")).toMatchObject({ status: "ok", data: [{ _id: "kept" }] });
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  test("CapacityExceeded parks the poll as terminal until refetch", async () => {
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return sinceCalls === 1
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "CapacityExceeded", message: "full", retriable: false },
              }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
          )
        : sinceForever();
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "capacity",
        ["notes"],
        new Set(["notes"]),
        vi.fn<() => Promise<unknown>>().mockResolvedValue([{ _id: "kept" }]),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(12);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sinceCalls).toBe(1);
      expect(pool.getSnapshot("capacity")).toMatchObject({
        status: "error",
        data: [{ _id: "kept" }],
        error: { code: "CapacityExceeded", retriable: false },
      });

      pool.refetch("capacity");
      await waitMicrotasks(16);
      expect(sinceCalls).toBe(2);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subscription-pool — the poll starts from the query's read", () => {
  /** A read envelope whose `_meta` names `sinceCursor` (omitted when undefined). */
  const readEnvelope = (data: unknown, sinceCursor?: string): Response =>
    jsonResponse({
      data,
      _meta: {
        manifest_pointer: "m",
        fresh: true,
        ...(sinceCursor !== undefined && { since_cursor: sinceCursor }),
      },
    });

  /** Records every `/v1/since` cursor; `respond` picks each reply (default: hang). */
  const recordSince = (
    mock: MockFetch,
    respond: (cursor: string) => Promise<Response> = sinceForever,
  ): string[] => {
    const cursors: string[] = [];
    mock.on("GET", "/v1/since", (req) => {
      const cursor = new URL(req.url).searchParams.get("cursor") ?? "";
      cursors.push(cursor);
      return respond(cursor);
    });
    return cursors;
  };

  /** A fetcher that reads `notes` through the pool's scoped client. */
  const readNotes =
    (client: ReturnType<typeof makeClient>) =>
    (signal: AbortSignal, onReadCursor: (collection: string, cursor: string) => void) =>
      withSignal(client, signal, onReadCursor).collection("notes").all();

  test("the first poll waits for the query and sends its _meta.since_cursor", async () => {
    let releaseRead: ((response: Response) => void) | undefined;
    const mock = new MockFetch();
    mock.on(
      "GET",
      "/v1/c/notes",
      () =>
        new Promise<Response>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const cursors = recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const unsubscribe = pool.attach(
      "seeded",
      ["notes"],
      new Set(["notes"]),
      readNotes(client),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(12);
    // A poll issued now would read the log at a different moment than
    // the query: a change committing and folding in between is lost.
    expect(cursors).toEqual([]);
    releaseRead?.(readEnvelope([{ _id: "a" }], "gen.0_0_00000000003"));
    await waitMicrotasks(12);
    expect(pool.getSnapshot("seeded")).toMatchObject({ status: "ok", data: [{ _id: "a" }] });
    expect(cursors).toEqual(["gen.0_0_00000000003"]);
    unsubscribe();
  });

  test("a by-id miss seeds the poll from the 404's _meta", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/notes/:id", () =>
      jsonResponse(
        {
          error: { code: "NotFound", message: "No such row: x", retriable: false },
          _meta: { manifest_pointer: "m", fresh: true, since_cursor: "gen.0_0_00000000001" },
        },
        404,
      ),
    );
    const cursors = recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const unsubscribe = pool.attach(
      "miss",
      ["notes"],
      new Set(["notes"]),
      (signal, onReadCursor) =>
        withSignal(client, signal, onReadCursor).collection("notes").get("x"),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(16);
    expect(pool.getSnapshot("miss")).toMatchObject({ status: "ok", data: undefined });
    expect(cursors).toEqual(["gen.0_0_00000000001"]);
    unsubscribe();
  });

  test('a read without since_cursor (an older server) starts the poll from cursor=""', async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/notes", () => readEnvelope([]));
    const cursors = recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const unsubscribe = pool.attach(
      "older",
      ["notes"],
      new Set(["notes"]),
      readNotes(client),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(12);
    expect(cursors).toEqual([""]);
    unsubscribe();
  });

  test('CursorExpired resumes from the refetch\'s since_cursor, not cursor=""', async () => {
    let reads = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/notes", () => {
      reads += 1;
      return readEnvelope([], `gen.0_0_0000000000${reads}`);
    });
    const cursors = recordSince(mock, (cursor) =>
      cursor === "gen.0_0_00000000001"
        ? Promise.resolve(sinceError("CursorExpired", 410, false))
        : sinceForever(),
    );
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribe = pool.attach(
        "expired",
        ["notes"],
        new Set(["notes"]),
        readNotes(client),
        vi.fn<() => void>(),
      );
      await waitMicrotasks(16);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads).toBe(2);
      expect(cursors).toEqual(["gen.0_0_00000000001", "gen.0_0_00000000002"]);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a query that read before the seed and saw another state runs again", async () => {
    // Two queries on one collection, both reading while the poll waits:
    // the first to finish seeds it. The other read a different state,
    // possibly an earlier one, so it runs again after the seed; one that
    // read the seed's state does not.
    const release = new Map<string, (response: Response) => void>();
    const reads: string[] = [];
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/notes", (req) => {
      const tag = new URL(req.url).searchParams.get("limit") ?? "all";
      reads.push(tag);
      if (reads.filter((r) => r === tag).length > 1) {
        return readEnvelope([tag], "gen.0_0_00000000009");
      }
      return new Promise<Response>((resolve) => {
        release.set(tag, resolve);
      });
    });
    const cursors = recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const scoped = (signal: AbortSignal, onReadCursor: (c: string, cursor: string) => void) =>
      withSignal(client, signal, onReadCursor).collection("notes");
    const unsubscribers = [
      pool.attach("all", ["notes"], new Set(["notes"]), readNotes(client), vi.fn<() => void>()),
      pool.attach(
        "one",
        ["notes"],
        new Set(["notes"]),
        (signal, onReadCursor) => scoped(signal, onReadCursor).limit(1).all(),
        vi.fn<() => void>(),
      ),
      pool.attach(
        "two",
        ["notes"],
        new Set(["notes"]),
        (signal, onReadCursor) => scoped(signal, onReadCursor).limit(2).all(),
        vi.fn<() => void>(),
      ),
    ];
    await waitMicrotasks(8);
    expect(reads).toEqual(["all", "1", "2"]);
    release.get("all")?.(readEnvelope(["all"], "gen.0_0_00000000004"));
    await waitMicrotasks(12);
    expect(cursors).toEqual(["gen.0_0_00000000004"]);
    release.get("1")?.(readEnvelope(["1"], "gen.0_0_00000000004"));
    release.get("2")?.(readEnvelope(["2"], "gen.0_0_00000000003"));
    await waitMicrotasks(16);
    expect(reads).toEqual(["all", "1", "2", "2"]);
    expect(pool.getSnapshot("two")).toMatchObject({ status: "ok", data: ["2"] });
    expect(cursors).toEqual(["gen.0_0_00000000004"]);
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });

  /** A `/v1/c/notes` handler whose n-th read waits for `release(n, response)`. */
  const heldReads = (mock: MockFetch) => {
    const pending: Array<(response: Response) => void> = [];
    mock.on(
      "GET",
      "/v1/c/notes",
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    return {
      count: () => pending.length,
      release: (n: number, response: Response) => pending[n]?.(response),
    };
  };

  test("a failed fetch does not seed while another fetch on the table may still", async () => {
    // B fails first. Seeding `""` then would wave A through unchecked: A
    // read earlier, so a change landing between A's read and the `""`
    // poll would never reach A.
    const mock = new MockFetch();
    const reads = heldReads(mock);
    const cursors = recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const unsubscribers = [
      pool.attach("a", ["notes"], new Set(["notes"]), readNotes(client), vi.fn<() => void>()),
      pool.attach(
        "b",
        ["notes"],
        new Set(["notes"]),
        () => Promise.reject(new BaerlyError("NetworkError", "b failed")),
        vi.fn<() => void>(),
      ),
    ];
    await waitMicrotasks(12);
    expect(pool.getSnapshot("b")).toMatchObject({ status: "error" });
    expect(cursors).toEqual([]);
    reads.release(0, readEnvelope([], "gen.0_0_00000000005"));
    await waitMicrotasks(12);
    expect(cursors).toEqual(["gen.0_0_00000000005"]);
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });

  test('a lone failed fetch still starts the poll from cursor=""', async () => {
    const mock = new MockFetch();
    const cursors = recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const unsubscribe = pool.attach(
      "lone",
      ["notes"],
      new Set(["notes"]),
      () => Promise.reject(new BaerlyError("NetworkError", "failed")),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(12);
    expect(cursors).toEqual([""]);
    unsubscribe();
  });

  test("unmounting while the poll waits for a seed, then remounting, seeds from the new read", async () => {
    const mock = new MockFetch();
    const reads = heldReads(mock);
    const cursors = recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    const first = pool.attach(
      "remount",
      ["notes"],
      new Set(["notes"]),
      readNotes(client),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(8);
    first();
    await waitMicrotasks(8);
    expect(cursors).toEqual([]);
    const second = pool.attach(
      "remount",
      ["notes"],
      new Set(["notes"]),
      readNotes(client),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(8);
    expect(reads.count()).toBe(2);
    // The unmounted fetch's late answer seeds nothing.
    reads.release(0, readEnvelope([], "gen.0_0_00000000001"));
    await waitMicrotasks(12);
    expect(cursors).toEqual([]);
    reads.release(1, readEnvelope([], "gen.0_0_00000000002"));
    await waitMicrotasks(12);
    expect(cursors).toEqual(["gen.0_0_00000000002"]);
    second();
  });

  test("refetch after a terminal poll error reseeds the revived poll from the refetch", async () => {
    let reads = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/notes", () => {
      reads += 1;
      return readEnvelope([], `gen.0_0_0000000000${reads}`);
    });
    const cursors = recordSince(mock, (cursor) =>
      cursor === "gen.0_0_00000000001"
        ? Promise.resolve(sinceError("Unauthorized", 401, false))
        : sinceForever(),
    );
    const client = makeClient(mock);
    const pool = poolFor(client);
    const unsubscribe = pool.attach(
      "revive",
      ["notes"],
      new Set(["notes"]),
      readNotes(client),
      vi.fn<() => void>(),
    );
    await waitMicrotasks(16);
    expect(pool.getSnapshot("revive")).toMatchObject({ status: "error" });
    pool.refetch("revive");
    await waitMicrotasks(16);
    expect(reads).toBe(2);
    expect(cursors).toEqual(["gen.0_0_00000000001", "gen.0_0_00000000002"]);
    unsubscribe();
  });

  test("a fetch from before CursorExpired does not seed the poll that follows", async () => {
    // "slow" is still reading when "fast" seeds the poll, and still when
    // that cursor expires. The recovery refetches both; the stale read's
    // late answer must not seed the new wait.
    const mock = new MockFetch();
    let slowReads = 0;
    let fastReads = 0;
    const releaseSlow: Array<(response: Response) => void> = [];
    mock.on("GET", "/v1/c/notes", (req) => {
      if (new URL(req.url).searchParams.get("limit") === "1") {
        slowReads += 1;
        return new Promise<Response>((resolve) => {
          releaseSlow.push(resolve);
        });
      }
      fastReads += 1;
      return readEnvelope([], `gen.0_0_0000000000${fastReads}`);
    });
    const cursors = recordSince(mock, (cursor) =>
      cursor === "gen.0_0_00000000001"
        ? Promise.resolve(sinceError("CursorExpired", 410, false))
        : sinceForever(),
    );
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const pool = poolFor(client);
      const unsubscribers = [
        pool.attach("fast", ["notes"], new Set(["notes"]), readNotes(client), vi.fn<() => void>()),
        pool.attach(
          "slow",
          ["notes"],
          new Set(["notes"]),
          (signal, onReadCursor) =>
            withSignal(client, signal, onReadCursor).collection("notes").limit(1).all(),
          vi.fn<() => void>(),
        ),
      ];
      await waitMicrotasks(16);
      expect(slowReads).toBe(2);
      expect(fastReads).toBe(2);
      releaseSlow[0]?.(readEnvelope([], "gen.0_0_00000000009"));
      await waitMicrotasks(16);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cursors).toEqual(["gen.0_0_00000000001", "gen.0_0_00000000002"]);
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test("a fetch's cursor sink stops collecting once the fetch settles", async () => {
    const mock = new MockFetch();
    mock.on("GET", "/v1/c/notes", () => readEnvelope([], "gen.0_0_00000000001"));
    recordSince(mock);
    const client = makeClient(mock);
    const pool = poolFor(client);
    let sink: ((collection: string, cursor: string) => void) | undefined;
    const unsubscribe = pool.attach(
      "sink",
      ["notes"],
      new Set(["notes"]),
      (signal, onReadCursor) => {
        sink = onReadCursor;
        return withSignal(client, signal, onReadCursor).collection("notes").all();
      },
      vi.fn<() => void>(),
    );
    await waitMicrotasks(12);
    expect(pool.getSnapshot("sink")).toMatchObject({ status: "ok" });
    // A scoped client the app kept goes on reporting reads; none of them
    // may be stored.
    const push = vi.spyOn(Array.prototype, "push");
    const set = vi.spyOn(Map.prototype, "set");
    try {
      for (let i = 0; i < 100; i += 1) {
        sink?.("notes", `gen.0_0_${String(i).padStart(11, "0")}`);
      }
      expect(push).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    } finally {
      push.mockRestore();
      set.mockRestore();
    }
    unsubscribe();
  });
});
