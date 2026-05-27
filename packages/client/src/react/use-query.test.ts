// @vitest-environment happy-dom
import { BaerlyError } from "@baerly/protocol";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { BaerlyProvider } from "./provider.ts";
import { useQuery, type UseQueryResult } from "./use-query.ts";

const okEnvelope = <T>(data: T) => ({
  data,
  _meta: { manifest_pointer: "none@0", fresh: true },
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
    mock.on("GET", "/v1/t/notes", () => new Promise<Response>(() => {}));
    const client = makeClient(mock);
    const { result } = renderHook(() => useQuery((c) => c.table("notes").all(), []), {
      wrapper: wrap(client),
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
  });

  test("transitions to { status: 'ok', data } when fetch resolves", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    mock.on("GET", "/v1/t/notes", () => jsonResponse(okEnvelope([{ _id: "a", body: "hi" }])));
    const client = makeClient(mock);
    const { result } = renderHook(
      () => useQuery((c) => c.table<{ _id: string; body: string }>("notes").all(), []),
      { wrapper: wrap(client) },
    );
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.data).toEqual([{ _id: "a", body: "hi" }]);
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
    mock.on("GET", "/v1/t/notes", () => {
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
    mock.on("GET", "/v1/t/notes/:id", () =>
      jsonResponse(okEnvelope({ _id: "n-1", body: "hello" })),
    );
    const client = makeClient(mock);
    let id: string | undefined = undefined;
    const { result, rerender } = renderHook(
      () => useQuery((c) => (id ? c.table("notes").get(id) : useQuery.skip), [id]),
      { wrapper: wrap(client) },
    );
    expect(result.current.status).toBe("skipped");
    id = "n-1";
    rerender();
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.data).toMatchObject({ _id: "n-1" });
  });
});

describe("useQuery — recorder error surface", () => {
  test("await on a recorder terminal surfaces as status: 'error' with code UseQueryAwaitedRecorder", async () => {
    const mock = new MockFetch();
    installSinceLongPoll(mock);
    mock.on("GET", "/v1/t/notes/:id", () => jsonResponse(okEnvelope({ _id: "x", body: "" })));
    const client = makeClient(mock);
    const { result } = renderHook(
      () =>
        useQuery(
          async (c) => {
            // Sequential await on a recorder terminal — the discovery
            // pass's .then call throws BaerlyError("UseQueryAwaitedRecorder").
            // The microtask rejection is pulled back into render via
            // useReducer/force-update.
            const note = (await c.table("notes").get("x")) as { _id: string };
            return c.table("comments").where({ noteId: note._id }).all();
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
          (c) => c.table("notes").insert({ body: "nope" }) as unknown as Promise<unknown>,
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
    mock.on("GET", "/v1/t/notes/:id", (req) => {
      listCount += 1;
      const id = req.url.split("/").pop() ?? "";
      return jsonResponse(okEnvelope({ _id: id, body: `body-${id}` }));
    });
    const client = makeClient(mock);
    let id = "a";
    const { result, rerender } = renderHook(() => useQuery((c) => c.table("notes").get(id), [id]), {
      wrapper: wrap(client),
    });
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
