// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import type { JSONArraylessObject } from "@baerly/protocol";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import {
  BaerlyProvider,
  useDelete,
  useInsert,
  useReplace,
  useUpdate,
} from "./index.ts";

interface Ticket extends JSONArraylessObject {
  readonly _id: string;
  readonly title: string;
  readonly status: string;
}

// Non-GET responses ship raw bodies (no `data` envelope) per
// `request.ts` — see the status-code policy comment.
const rawJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const wrap = (client: ReturnType<typeof createBaerlyClient>) => {
  return ({ children }: { children: ReactNode }) =>
    createElement(BaerlyProvider, { client }, children);
};

describe("mutation hooks", () => {
  describe("useInsert", () => {
    test("issues POST and returns the assigned _id", async () => {
      const m = new MockFetch();
      const bodies: Array<{ doc: Partial<Ticket> }> = [];
      m.on("POST", "/v1/t/tickets", async (req) => {
        bodies.push((await req.json()) as { doc: Partial<Ticket> });
        return rawJson({ _id: "t1" }, 201);
      });
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
      const { result } = renderHook(() => useInsert<Ticket>({ table: "tickets" }), {
        wrapper: wrap(client),
      });

      expect(result.current.isPending).toBe(false);

      let inserted: { readonly _id: string } | undefined;
      await act(async () => {
        inserted = await result.current.mutate({ title: "hi", status: "open" });
      });

      expect(inserted).toEqual({ _id: "t1" });
      expect(bodies).toEqual([{ doc: { title: "hi", status: "open" } }]);
      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeUndefined();
    });

    test("surfaces server errors via the error field", async () => {
      const m = new MockFetch();
      m.on(
        "POST",
        "/v1/t/tickets",
        () =>
          new Response(JSON.stringify({ error: { code: "Internal", message: "boom" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
      const { result } = renderHook(() => useInsert<Ticket>({ table: "tickets" }), {
        wrapper: wrap(client),
      });

      await act(async () => {
        await expect(result.current.mutate({ title: "x", status: "open" })).rejects.toThrow(
          /boom|HTTP 500/,
        );
      });

      await waitFor(() => expect(result.current.error).toBeDefined());
      expect(result.current.isPending).toBe(false);

      act(() => result.current.reset());
      expect(result.current.error).toBeUndefined();
    });
  });

  describe("useUpdate", () => {
    test("issues PATCH /v1/t/:table/:id with the patch body", async () => {
      const m = new MockFetch();
      const seen: Array<{ url: string; body: unknown }> = [];
      m.on("PATCH", "/v1/t/tickets/t1", async (req) => {
        seen.push({ url: req.url, body: await req.json() });
        return rawJson({ modified: 1 });
      });
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
      const { result } = renderHook(() => useUpdate<Ticket>({ table: "tickets" }), {
        wrapper: wrap(client),
      });

      let res: { readonly modified: number } | undefined;
      await act(async () => {
        res = await result.current.mutate("t1", { status: "closed" });
      });

      expect(res).toEqual({ modified: 1 });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toEqual({ patch: { status: "closed" } });
    });
  });

  describe("useReplace", () => {
    test("issues PUT /v1/t/:table/:id with the whole document", async () => {
      const m = new MockFetch();
      const seen: Array<{ url: string; body: unknown }> = [];
      m.on("PUT", "/v1/t/tickets/t1", async (req) => {
        seen.push({ url: req.url, body: await req.json() });
        return rawJson({ modified: 1 });
      });
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
      const { result } = renderHook(() => useReplace<Ticket>({ table: "tickets" }), {
        wrapper: wrap(client),
      });

      await act(async () => {
        await result.current.mutate("t1", { _id: "t1", title: "v2", status: "open" });
      });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).toEqual({
        doc: { _id: "t1", title: "v2", status: "open" },
      });
    });
  });

  describe("useDelete", () => {
    test("issues DELETE and returns { deleted: 1 } on 204", async () => {
      const m = new MockFetch();
      m.on("DELETE", "/v1/t/tickets/t1", () => new Response(null, { status: 204 }));
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
      const { result } = renderHook(() => useDelete({ table: "tickets" }), {
        wrapper: wrap(client),
      });

      let res: { readonly deleted: number } | undefined;
      await act(async () => {
        res = await result.current.mutate("t1");
      });

      expect(res).toEqual({ deleted: 1 });
      expect(result.current.data).toEqual({ deleted: 1 });
    });

    test("returns { deleted: 0 } when the server 404s", async () => {
      const m = new MockFetch();
      m.on(
        "DELETE",
        "/v1/t/tickets/missing",
        () =>
          new Response(JSON.stringify({ error: { code: "NotFound", message: "no row" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
      const { result } = renderHook(() => useDelete({ table: "tickets" }), {
        wrapper: wrap(client),
      });

      let res: { readonly deleted: number } | undefined;
      await act(async () => {
        res = await result.current.mutate("missing");
      });

      expect(res).toEqual({ deleted: 0 });
      expect(result.current.error).toBeUndefined();
    });
  });

  test("calling mutate while a previous call is in flight aborts the previous request", async () => {
    const m = new MockFetch();
    const signals: AbortSignal[] = [];
    m.on("POST", "/v1/t/tickets", (req) => {
      const ix = signals.length;
      signals.push(req.signal);
      return new Promise<Response>((resolve, reject) => {
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        // Only the second call resolves.
        if (ix === 1) {
          resolve(rawJson({ _id: "second" }, 201));
        }
      });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result } = renderHook(() => useInsert<Ticket>({ table: "tickets" }), {
      wrapper: wrap(client),
    });

    let firstError: unknown;
    let firstPromise: Promise<unknown> | undefined;
    act(() => {
      firstPromise = result.current.mutate({ title: "first", status: "open" }).catch((error) => {
        firstError = error;
        return undefined;
      });
    });
    await waitFor(() => expect(signals.length).toBe(1));

    let secondInserted: { readonly _id: string } | undefined;
    await act(async () => {
      secondInserted = await result.current.mutate({ title: "second", status: "open" });
    });

    expect(secondInserted).toEqual({ _id: "second" });
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    await firstPromise;
    expect(firstError).toBeInstanceOf(Error);
  });

  test("unmount aborts the in-flight call", async () => {
    const m = new MockFetch();
    let signal: AbortSignal | undefined;
    m.on(
      "POST",
      "/v1/t/tickets",
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          signal = req.signal;
          req.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useInsert<Ticket>({ table: "tickets" }), {
      wrapper: wrap(client),
    });

    let firstError: unknown;
    let firstPromise: Promise<unknown> | undefined;
    act(() => {
      firstPromise = result.current.mutate({ title: "hi", status: "open" }).catch((error) => {
        firstError = error;
        return undefined;
      });
    });
    await waitFor(() => expect(signal).toBeDefined());

    unmount();
    expect(signal!.aborted).toBe(true);
    await firstPromise;
    expect(firstError).toBeInstanceOf(Error);
  });

  test("hooks throw when used outside <BaerlyProvider>", () => {
    expect(() => renderHook(() => useInsert<Ticket>({ table: "tickets" }))).toThrow(
      /BaerlyProvider/,
    );
    expect(() => renderHook(() => useUpdate<Ticket>({ table: "tickets" }))).toThrow(
      /BaerlyProvider/,
    );
    expect(() => renderHook(() => useReplace<Ticket>({ table: "tickets" }))).toThrow(
      /BaerlyProvider/,
    );
    expect(() => renderHook(() => useDelete({ table: "tickets" }))).toThrow(/BaerlyProvider/);
  });
});
