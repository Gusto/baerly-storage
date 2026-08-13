// @vitest-environment happy-dom
import { BaerlyError } from "@baerly/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { BaerlyProvider } from "./provider.ts";
import { useQuery, type UseQueryResult } from "./use-query.ts";

const okEnvelope = <T>(data: T) => ({
  data,
  _meta: { manifest_pointer: "mock-cursor", fresh: true },
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const sinceForever = (): Response => {
  // Resolve never — emulate the long-poll holding the connection
  // open. The tests that care about subscription lifecycle abort
  // the controller via unmount.
  return null as unknown as Response;
};

const wrap =
  (client: ReturnType<typeof createBaerlyClient>) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(BaerlyProvider, { client }, children);

const makeClient = (mock: MockFetch) =>
  createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });

const installSinceLongPoll = (mock: MockFetch): void => {
  mock.on("GET", "/v1/since", () => new Promise<Response>(() => sinceForever()));
};

describe("useQuery — basic reads", () => {
  test("returns { status: 'loading', data: undefined } on first render", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    mock.on("GET", "/v1/c/notes", () => new Promise<Response>(() => {}));
    const client = makeClient(mock);
    const { result } = renderHook(() => useQuery((c) => c.collection("notes").all(), []), {
      wrapper: wrap(client),
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  test("transitions to { status: 'ok', data } when fetch resolves", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    mock.on("GET", "/v1/c/notes", () => jsonResponse(okEnvelope([{ _id: "a", body: "hi" }])));
    const client = makeClient(mock);
    const { result } = renderHook(() => useQuery((c) => c.collection("notes").all(), []), {
      wrapper: wrap(client),
    });
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.data).toEqual([{ _id: "a", body: "hi" }]);
  });

  test("refetch recovers a terminal live subscription without unmounting", async () => {
    let releasePoll: ((response: Response) => void) | undefined;
    let sinceCalls = 0;
    let listCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      if (sinceCalls > 2) {
        return new Promise<Response>(() => {});
      }
      return new Promise<Response>((resolve) => {
        releasePoll = resolve;
      });
    });
    mock.on("GET", "/v1/c/notes", () => {
      listCalls += 1;
      return jsonResponse(
        okEnvelope([
          {
            _id: listCalls === 1 ? "before-expiry" : `after-recovery-${listCalls}`,
            body: "still visible",
          },
        ]),
      );
    });
    vi.useFakeTimers();
    try {
      const client = makeClient(mock);
      const { result } = renderHook(() => useQuery((c) => c.collection("notes").all(), []), {
        wrapper: wrap(client),
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.status).toBe("ok");

      await act(async () => {
        releasePoll?.(
          jsonResponse(
            { error: { code: "Unauthorized", message: "expired", retriable: false } },
            401,
          ),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.status).toBe("error");
      expect(result.current.data).toEqual([{ _id: "before-expiry", body: "still visible" }]);
      expect(result.current.error).toMatchObject({ code: "Unauthorized", retriable: false });

      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(sinceCalls).toBe(1);

      await act(async () => {
        result.current.refetch();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.status).toBe("ok");
      expect(result.current.data).toEqual([{ _id: "after-recovery-2", body: "still visible" }]);
      expect(sinceCalls).toBe(2);
      expect(listCalls).toBe(2);

      await act(async () => {
        releasePoll?.(jsonResponse({ events: [{ lsn: "aaa_bbb_ccc" }], next_cursor: "cursor-1" }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.data).toEqual([{ _id: "after-recovery-3", body: "still visible" }]);
      expect(listCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useQuery.skip — deferred / conditional reads", () => {
  test("returning useQuery.skip yields { status: 'skipped' } and registers no subscription", async () => {
    const mock = new MockFetch();
    let sinceCalls = 0;
    let listCalls = 0;
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return new Promise<Response>(() => {});
    });
    mock.on("GET", "/v1/c/notes", () => {
      listCalls += 1;
      return jsonResponse(okEnvelope([]));
    });
    const client = makeClient(mock);
    const { result, unmount } = renderHook(() => useQuery(() => useQuery.skip, []), {
      wrapper: wrap(client),
    });
    expect(result.current.status).toBe("skipped");
    expect(result.current.data).toBeUndefined();
    // Wait one microtask cycle in case any subscription/fetch races.
    await Promise.resolve();
    await Promise.resolve();
    expect(sinceCalls).toBe(0);
    expect(listCalls).toBe(0);
    unmount();
  });

  test("useQuery.skip returns a stable reference across renders", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    const client = makeClient(mock);
    const { result, rerender } = renderHook(() => useQuery(() => useQuery.skip, []), {
      wrapper: wrap(client),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  test("flipping a deferred dependency triggers a fetch", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    mock.on("GET", "/v1/c/notes/:id", () =>
      jsonResponse(okEnvelope({ _id: "n-1", body: "hello" })),
    );
    const client = makeClient(mock);
    let id: string | undefined = undefined;
    const { result, rerender } = renderHook(
      () => useQuery((c) => (id ? c.collection("notes").get(id) : useQuery.skip), [id]),
      { wrapper: wrap(client) },
    );
    expect(result.current.status).toBe("skipped");
    id = "n-1";
    rerender();
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.data).toMatchObject({ _id: "n-1" });
  });

  test("refetch re-runs discovery for a skipped query with no dependency change", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    mock.on("GET", "/v1/c/notes/:id", () =>
      jsonResponse(okEnvelope({ _id: "n-1", body: "hello" })),
    );
    const client = makeClient(mock);
    // Deliberately absent from `deps`, so nothing else can re-render
    // the hook. Only refetch()'s non-"ok" branch — which force-updates
    // to re-run discovery rather than dispatching into the pool — can
    // move this off "skipped".
    let ready = false;
    const { result } = renderHook(
      () => useQuery((c) => (ready ? c.collection("notes").get("n-1") : useQuery.skip), []),
      { wrapper: wrap(client) },
    );
    expect(result.current.status).toBe("skipped");

    ready = true;
    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.data).toMatchObject({ _id: "n-1" });
  });
});

describe("useQuery — recorder error surface", () => {
  test("await on a recorder terminal surfaces as status: 'error' with code UseQueryAwaitedRecorder", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    mock.on("GET", "/v1/c/notes/:id", () => jsonResponse(okEnvelope({ _id: "x", body: "" })));
    const client = makeClient(mock);
    const { result } = renderHook(
      () =>
        useQuery(
          async (c) => {
            // Sequential await on a recorder terminal — the discovery
            // pass's .then call throws BaerlyError("UseQueryAwaitedRecorder").
            // The microtask rejection is pulled back into render via
            // useReducer/force-update.
            const note = (await c.collection("notes").get("x")) as { _id: string };
            return c.collection("comments").where({ noteId: note._id }).all();
          },
          ["x"],
        ),
      { wrapper: wrap(client) },
    );
    await waitFor(
      () => {
        expect(result.current.status).toBe("error");
      },
      { timeout: 2000 },
    );
    const r = result.current as Extract<UseQueryResult<unknown>, { status: "error" }>;
    expect(r.error).toBeInstanceOf(BaerlyError);
    expect((r.error as BaerlyError).code).toBe("UseQueryAwaitedRecorder");
  });

  test("write methods on the recorder throw UnexpectedWriteInQuery synchronously", () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    const client = makeClient(mock);
    const { result } = renderHook(
      () =>
        useQuery(
          (c) => c.collection("notes").insert({ body: "nope" }) as unknown as Promise<unknown>,
          [],
        ),
      { wrapper: wrap(client) },
    );
    expect(result.current.status).toBe("error");
    const r = result.current as Extract<UseQueryResult<unknown>, { status: "error" }>;
    expect(r.error).toBeInstanceOf(BaerlyError);
    expect((r.error as BaerlyError).code).toBe("UnexpectedWriteInQuery");
  });
});

describe("useQuery — deps-driven re-reads", () => {
  test("changing deps refetches; same deps reuses cache", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    let listCount = 0;
    mock.on("GET", "/v1/c/notes/:id", (req) => {
      listCount += 1;
      const id = req.url.split("/").pop() ?? "";
      return jsonResponse(okEnvelope({ _id: id, body: `body-${id}` }));
    });
    const client = makeClient(mock);
    let id = "a";
    const { result, rerender } = renderHook(
      () => useQuery((c) => c.collection("notes").get(id), [id]),
      {
        wrapper: wrap(client),
      },
    );
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(listCount).toBe(1);
    rerender();
    expect(listCount).toBe(1); // same deps → no extra fetch
    id = "b";
    rerender();
    await waitFor(() =>
      expect((result.current.data as { _id: string } | undefined)?._id).toBe("b"),
    );
    expect(listCount).toBe(2);
  });
});

describe("useQuery — non-live reads", () => {
  test("live: false performs the initial read without opening /v1/since", async () => {
    const mock = new MockFetch();
    let listCalls = 0;
    let sinceCalls = 0;
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return new Promise<Response>(() => {});
    });
    mock.on("GET", "/v1/c/notes", () => {
      listCalls += 1;
      return jsonResponse(okEnvelope([{ _id: "static" }]));
    });
    const client = makeClient(mock);
    const { result } = renderHook(
      () => useQuery((c) => c.collection("notes").all(), [], { live: false }),
      { wrapper: wrap(client) },
    );

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.data).toEqual([{ _id: "static" }]);
    expect(listCalls).toBe(1);
    expect(sinceCalls).toBe(0);
  });

  test("dependency changes re-run a non-live read", async () => {
    const mock = new MockFetch();
    let getCalls = 0;
    let sinceCalls = 0;
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return new Promise<Response>(() => {});
    });
    mock.on("GET", "/v1/c/notes/:id", (req) => {
      getCalls += 1;
      const id = req.url.split("/").pop() ?? "";
      return jsonResponse(okEnvelope({ _id: id }));
    });
    const client = makeClient(mock);
    let id = "a";
    const { result, rerender } = renderHook(
      () => useQuery((c) => c.collection("notes").get(id), [id], { live: false }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(result.current.data).toMatchObject({ _id: "a" }));

    id = "b";
    rerender();
    await waitFor(() => expect(result.current.data).toMatchObject({ _id: "b" }));
    expect(getCalls).toBe(2);
    expect(sinceCalls).toBe(0);
  });

  test("refetch is stable and explicitly refreshes a non-live query", async () => {
    const mock = new MockFetch();
    let listCalls = 0;
    mock.on("GET", "/v1/c/notes", () => {
      listCalls += 1;
      return jsonResponse(okEnvelope([{ _id: `read-${listCalls}` }]));
    });
    const client = makeClient(mock);
    const { result, rerender } = renderHook(
      () => useQuery((c) => c.collection("notes").all(), [], { live: false }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(result.current.data).toEqual([{ _id: "read-1" }]));
    const snapshot = result.current;
    const refetch = result.current.refetch;

    rerender();
    expect(result.current).toBe(snapshot);
    expect(result.current.refetch).toBe(refetch);
    act(() => refetch());
    expect(result.current.status).toBe("refreshing");
    expect(result.current.data).toEqual([{ _id: "read-1" }]);
    await waitFor(() => expect(result.current.data).toEqual([{ _id: "read-2" }]));
    expect(result.current.refetch).toBe(refetch);
  });

  test("a rejected refetch preserves the previous non-live data", async () => {
    const mock = new MockFetch();
    let listCalls = 0;
    let releaseRecovery: ((response: Response) => void) | undefined;
    mock.on("GET", "/v1/c/notes", () => {
      listCalls += 1;
      if (listCalls === 1) {
        return jsonResponse(okEnvelope([{ _id: "last-good" }]));
      }
      if (listCalls === 3) {
        return new Promise<Response>((resolve) => {
          releaseRecovery = resolve;
        });
      }
      return jsonResponse(
        { error: { code: "Unauthorized", message: "expired", retriable: false } },
        401,
      );
    });
    const client = makeClient(mock);
    const { result } = renderHook(
      () => useQuery((c) => c.collection("notes").all(), [], { live: false }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(result.current.status).toBe("ok"));

    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.data).toEqual([{ _id: "last-good" }]);
    expect(result.current.error).toMatchObject({ code: "Unauthorized" });

    act(() => result.current.refetch());
    expect(result.current.status).toBe("refreshing");
    expect(result.current.data).toEqual([{ _id: "last-good" }]);
    releaseRecovery?.(jsonResponse(okEnvelope([{ _id: "recovered" }])));
    await waitFor(() => expect(result.current.data).toEqual([{ _id: "recovered" }]));
  });

  test("live and non-live identities are isolated and live events do not invalidate non-live data", async () => {
    let releaseEvent: ((response: Response) => void) | undefined;
    let listCalls = 0;
    let sinceCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      if (sinceCalls === 1) {
        return new Promise<Response>((resolve) => {
          releaseEvent = resolve;
        });
      }
      return new Promise<Response>(() => {});
    });
    mock.on("GET", "/v1/c/notes", () => {
      listCalls += 1;
      return jsonResponse(okEnvelope([{ _id: `read-${listCalls}` }]));
    });
    const client = makeClient(mock);
    const { result } = renderHook(
      () => ({
        live: useQuery((c) => c.collection("notes").all(), []),
        nonLive: useQuery((c) => c.collection("notes").all(), [], { live: false }),
      }),
      { wrapper: wrap(client) },
    );
    await waitFor(() => {
      expect(result.current.live.status).toBe("ok");
      expect(result.current.nonLive.status).toBe("ok");
    });
    expect(listCalls).toBe(2);
    const nonLiveData = result.current.nonLive.data;

    releaseEvent?.(jsonResponse({ events: [{ lsn: "aaa_bbb_ccc" }], next_cursor: "cursor-1" }));
    await waitFor(() => expect(listCalls).toBe(3));
    expect(result.current.nonLive.data).toBe(nonLiveData);
    expect(result.current.nonLive.data).toEqual([{ _id: "read-2" }]);
  });

  test("switching live true to false and back stops and restarts polling", async () => {
    const pollSignals: AbortSignal[] = [];
    let listCalls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      pollSignals.push(req.signal);
      return new Promise<Response>((_, reject) => {
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    mock.on("GET", "/v1/c/notes", () => {
      listCalls += 1;
      return jsonResponse(okEnvelope([{ _id: `read-${listCalls}` }]));
    });
    const client = makeClient(mock);
    let live = true;
    const { result, rerender, unmount } = renderHook(
      () => useQuery((c) => c.collection("notes").all(), [], { live }),
      { wrapper: wrap(client) },
    );

    await waitFor(() => expect(result.current.data).toEqual([{ _id: "read-1" }]));
    expect(pollSignals).toHaveLength(1);
    expect(pollSignals[0]?.aborted).toBe(false);

    live = false;
    rerender();
    await waitFor(() => expect(result.current.data).toEqual([{ _id: "read-2" }]));
    const nonLiveSnapshot = result.current;
    expect(pollSignals).toHaveLength(1);
    expect(pollSignals[0]?.aborted).toBe(true);

    live = true;
    rerender();
    await waitFor(() => expect(result.current.data).toEqual([{ _id: "read-3" }]));
    expect(result.current).not.toBe(nonLiveSnapshot);
    expect(pollSignals).toHaveLength(2);
    expect(pollSignals[1]?.aborted).toBe(false);
    expect(listCalls).toBe(3);
    unmount();
  });

  test("the default mode remains live", async () => {
    const mock = new MockFetch();
    let sinceCalls = 0;
    mock.on("GET", "/v1/since", () => {
      sinceCalls += 1;
      return new Promise<Response>(() => {});
    });
    mock.on("GET", "/v1/c/notes", () => jsonResponse(okEnvelope([])));
    const client = makeClient(mock);
    const { result } = renderHook(() => useQuery((c) => c.collection("notes").all(), []), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(sinceCalls).toBe(1);
  });
});
