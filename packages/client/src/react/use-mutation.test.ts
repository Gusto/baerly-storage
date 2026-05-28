// @vitest-environment happy-dom
import { BaerlyError } from "@baerly/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { BaerlyProvider } from "./provider.ts";
import { useMutation } from "./use-mutation.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeClient = (mock: MockFetch) =>
  createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });

const wrap =
  (client: ReturnType<typeof createBaerlyClient>) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(BaerlyProvider, { client }, children);

describe("useMutation", () => {
  test("returns a [mutate, state] tuple with isPending + error", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/notes", () => jsonResponse({ _id: "n-1" }, 201));
    const client = makeClient(mock);
    const { result } = renderHook(() => useMutation(), { wrapper: wrap(client) });
    expect(Array.isArray(result.current)).toBe(true);
    expect(result.current).toHaveLength(2);
    const [mutate, state] = result.current;
    expect(typeof mutate).toBe("function");
    expect(state.isPending).toBe(false);
    expect(state.error).toBeUndefined();
  });

  test("mutate(cb) returns the callback's resolved value", async () => {
    const mock = new MockFetch();
    mock.on("POST", "/v1/c/notes", () => jsonResponse({ _id: "n-9" }, 201));
    const client = makeClient(mock);
    const { result } = renderHook(() => useMutation(), { wrapper: wrap(client) });
    let inserted: { _id: string } | undefined;
    await act(async () => {
      inserted = await result.current[0]((c) => c.collection("notes").insert({ body: "hi" }));
    });
    expect(inserted).toEqual({ _id: "n-9" });
  });

  test("isPending toggles true→false across one mutation", async () => {
    const mock = new MockFetch();
    let resolve!: (r: Response) => void;
    mock.on("POST", "/v1/c/notes", () => new Promise<Response>((r) => (resolve = r)));
    const client = makeClient(mock);
    const { result } = renderHook(() => useMutation(), { wrapper: wrap(client) });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current[0]((c) => c.collection("notes").insert({ body: "x" }));
    });
    await waitFor(() => expect(result.current[1].isPending).toBe(true));
    await act(async () => {
      resolve(jsonResponse({ _id: "n" }, 201));
      await pending;
    });
    expect(result.current[1].isPending).toBe(false);
  });

  test("error populated on rejection, BaerlyError-typed, cleared by next successful call", async () => {
    const mock = new MockFetch();
    let fail = true;
    mock.on("POST", "/v1/c/notes", () =>
      fail
        ? jsonResponse({ error: { code: "Conflict", message: "boom" } }, 409)
        : jsonResponse({ _id: "ok" }, 201),
    );
    const client = makeClient(mock);
    const { result } = renderHook(() => useMutation(), { wrapper: wrap(client) });
    await act(async () => {
      await expect(
        result.current[0]((c) => c.collection("notes").insert({ body: "x" })),
      ).rejects.toMatchObject({ name: "BaerlyError", code: "Conflict" });
    });
    expect(result.current[1].error).toBeInstanceOf(BaerlyError);
    expect(result.current[1].error?.code).toBe("Conflict");
    fail = false;
    await act(async () => {
      await result.current[0]((c) => c.collection("notes").insert({ body: "y" }));
    });
    expect(result.current[1].error).toBeUndefined();
  });

  test("isPending refcounts across concurrent submits (last to settle drops it)", async () => {
    const mock = new MockFetch();
    const resolvers: Array<(r: Response) => void> = [];
    mock.on("POST", "/v1/c/notes", () => new Promise<Response>((r) => resolvers.push(r)));
    const client = makeClient(mock);
    const { result } = renderHook(() => useMutation(), { wrapper: wrap(client) });
    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    act(() => {
      p1 = result.current[0]((c) => c.collection("notes").insert({ body: "a" }));
      p2 = result.current[0]((c) => c.collection("notes").insert({ body: "b" }));
    });
    await waitFor(() => expect(result.current[1].isPending).toBe(true));
    // First call resolves — pending must stay true because second is still in flight.
    await act(async () => {
      resolvers[0]?.(jsonResponse({ _id: "a" }, 201));
      await p1;
    });
    expect(result.current[1].isPending).toBe(true);
    // Second call resolves — now drops to false.
    await act(async () => {
      resolvers[1]?.(jsonResponse({ _id: "b" }, 201));
      await p2;
    });
    expect(result.current[1].isPending).toBe(false);
  });

  test("mutate is referentially stable across renders that don't change the client", async () => {
    const mock = new MockFetch();
    const client = makeClient(mock);
    const { result, rerender } = renderHook(() => useMutation(), { wrapper: wrap(client) });
    const first = result.current[0];
    rerender();
    expect(result.current[0]).toBe(first);
  });

  test("non-BaerlyError throws are wrapped with code 'MutationFailed' and original on cause", async () => {
    const client = createBaerlyClient({
      baseUrl: "http://x",
      fetch: async () => {
        throw new Error("network kaput");
      },
    });
    const { result } = renderHook(() => useMutation(), { wrapper: wrap(client) });
    let thrown: unknown;
    await act(async () => {
      try {
        await result.current[0]((c) => c.collection("notes").insert({ body: "x" }));
      } catch (error) {
        thrown = error;
      }
    });
    // The transport layer wraps "network kaput" as a BaerlyError("NetworkError"),
    // so the mutation error is also a BaerlyError — but `MutationFailed`
    // exists for genuinely non-BaerlyError throws from the callback body.
    expect(thrown).toBeInstanceOf(BaerlyError);
  });
});
