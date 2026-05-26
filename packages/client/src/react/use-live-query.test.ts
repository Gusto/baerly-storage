// @vitest-environment happy-dom

import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import type { DocumentData } from "@baerly/protocol";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { BaerlyProvider, useLiveQuery } from "./index.ts";

const okEnvelope = (data: unknown): Response =>
  new Response(JSON.stringify({ data, _meta: { manifest_pointer: "none@0", fresh: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const sinceResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

interface Ticket extends DocumentData {
  readonly _id: string;
  readonly title: string;
  readonly status: string;
}

const makeMock = () => {
  const m = new MockFetch();
  const pendingSinceRejects: Array<(e: unknown) => void> = [];
  const hangSince = (req: Request): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      pendingSinceRejects.push(reject);
      req.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  return { m, pendingSinceRejects, hangSince };
};

const wrap = (client: ReturnType<typeof createBaerlyClient>) => {
  return ({ children }: { children: ReactNode }) =>
    createElement(BaerlyProvider, { client }, children);
};

describe("useLiveQuery", () => {
  test("performs initial fetch and surfaces rows", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listCalls = 0;
    m.on("GET", "/v1/t/tickets", () => {
      listCalls += 1;
      return okEnvelope([{ _id: "a", title: "first" }]);
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveQuery<Ticket>({ table: "tickets" }), {
      wrapper: wrap(client),
    });

    await waitFor(() => {
      expect(result.current).toEqual({ status: "ok", rows: [{ _id: "a", title: "first" }] });
    });
    expect(listCalls).toBe(1);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("refetches when /v1/since returns a non-empty batch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listCalls = 0;
    m.on("GET", "/v1/t/tickets", () => {
      listCalls += 1;
      if (listCalls === 1) {
        return okEnvelope([{ _id: "a", title: "first" }]);
      }
      return okEnvelope([
        { _id: "a", title: "first" },
        { _id: "b", title: "second" },
      ]);
    });
    let sincePoll = 0;
    m.on("GET", "/v1/since", (req) => {
      sincePoll += 1;
      if (sincePoll === 1) {
        return sinceResponse({
          events: [
            {
              lsn: "a_b_01",
              op: "I",
              collection: "tickets",
              doc_id: "b",
              schema_version: 0,
              session: "s",
              seq: 1,
              commit_ts: "",
            },
          ],
          next_cursor: "a_b_01",
        });
      }
      return hangSince(req);
    });

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveQuery<Ticket>({ table: "tickets" }), {
      wrapper: wrap(client),
    });

    await waitFor(() => {
      expect(result.current.status).toBe("ok");
      if (result.current.status === "ok") {
        expect(result.current.rows).toHaveLength(2);
      }
    });
    expect(listCalls).toBe(2);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("idle /v1/since response (empty batch, same cursor) does not refetch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listCalls = 0;
    m.on("GET", "/v1/t/tickets", () => {
      listCalls += 1;
      return okEnvelope([{ _id: "a", title: "first" }]);
    });
    let sincePoll = 0;
    m.on("GET", "/v1/since", (req) => {
      sincePoll += 1;
      if (sincePoll === 1) {
        return sinceResponse({ events: [], next_cursor: "" });
      }
      return hangSince(req);
    });

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveQuery<Ticket>({ table: "tickets" }), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.status).toBe("ok"));
    await waitFor(() => expect(sincePoll).toBeGreaterThanOrEqual(2));
    expect(listCalls).toBe(1);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("surfaces fetch errors", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    m.on(
      "GET",
      "/v1/t/tickets",
      () =>
        new Response(JSON.stringify({ error: { code: "Internal", message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveQuery<Ticket>({ table: "tickets" }), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.status).toBe("error"));

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("predicate change triggers a refetch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    const observedWheres: string[] = [];
    m.on("GET", "/v1/t/tickets", (req) => {
      const url = new URL(req.url);
      observedWheres.push(url.searchParams.get("where") ?? "");
      return okEnvelope([]);
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { rerender, unmount } = renderHook(
      ({ status }: { status: string }) =>
        useLiveQuery<Ticket>({ table: "tickets", where: { status } }),
      { initialProps: { status: "open" }, wrapper: wrap(client) },
    );

    await waitFor(() => {
      expect(observedWheres).toContain(
        JSON.stringify({ clauses: [{ op: "eq", field: "status", value: "open" }] }),
      );
    });
    rerender({ status: "closed" });
    await waitFor(() => {
      expect(observedWheres).toContain(
        JSON.stringify({ clauses: [{ op: "eq", field: "status", value: "closed" }] }),
      );
    });

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("unmount aborts an in-flight list fetch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listSignal: AbortSignal | undefined;
    m.on(
      "GET",
      "/v1/t/tickets",
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          listSignal = req.signal;
          req.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveQuery<Ticket>({ table: "tickets" }), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(listSignal).toBeDefined());
    expect(listSignal!.aborted).toBe(false);

    unmount();
    expect(listSignal!.aborted).toBe(true);
    expect(result.current.status).toBe("loading");

    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("predicate change aborts the previous in-flight list fetch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    const seenSignals: AbortSignal[] = [];
    m.on("GET", "/v1/t/tickets", (req) => {
      const ix = seenSignals.length;
      seenSignals.push(req.signal);
      return new Promise<Response>((resolve, reject) => {
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        if (ix > 0) {
          resolve(okEnvelope([{ _id: "a", title: "ok", status: "closed" }]));
        }
      });
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { rerender, result, unmount } = renderHook(
      ({ status }: { status: string }) =>
        useLiveQuery<Ticket>({ table: "tickets", where: { status } }),
      { initialProps: { status: "open" }, wrapper: wrap(client) },
    );

    await waitFor(() => expect(seenSignals.length).toBe(1));
    rerender({ status: "closed" });
    await waitFor(() => expect(seenSignals.length).toBe(2));

    expect(seenSignals[0]!.aborted).toBe(true);
    expect(seenSignals[1]!.aborted).toBe(false);
    await waitFor(() => {
      expect(result.current.status).toBe("ok");
      if (result.current.status === "ok") {
        expect(result.current.rows).toHaveLength(1);
      }
    });

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("forwards order + consistency to /v1/t/:table", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    const observed: Array<{ order: string | null; consistency: string | null }> = [];
    m.on("GET", "/v1/t/tickets", (req) => {
      const url = new URL(req.url);
      observed.push({
        order: url.searchParams.get("order"),
        consistency: url.searchParams.get("consistency"),
      });
      return okEnvelope([]);
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(
      () =>
        useLiveQuery<Ticket>({
          table: "tickets",
          order: { _id: "desc" },
          consistency: "eventual",
        }),
      { wrapper: wrap(client) },
    );

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      order: JSON.stringify({ _id: "desc" }),
      consistency: "eventual",
    });

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("consistency change triggers a refetch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    const seen: string[] = [];
    m.on("GET", "/v1/t/tickets", (req) => {
      const url = new URL(req.url);
      seen.push(url.searchParams.get("consistency") ?? "");
      return okEnvelope([]);
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { rerender, result, unmount } = renderHook(
      ({ level }: { level: "eventual" | "strong" }) =>
        useLiveQuery<Ticket>({ table: "tickets", consistency: level }),
      { initialProps: { level: "eventual" }, wrapper: wrap(client) },
    );

    await waitFor(() => expect(result.current.status).toBe("ok"));
    rerender({ level: "strong" });
    await waitFor(() => expect(seen).toContain("strong"));
    expect(seen).toEqual(["eventual", "strong"]);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("inline order object does not churn refetches across renders", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listCalls = 0;
    m.on("GET", "/v1/t/tickets", () => {
      listCalls += 1;
      return okEnvelope([]);
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { rerender, result, unmount } = renderHook(
      // New `{ _id: "desc" }` literal every render — must NOT trigger a refetch.
      ({ tick: _tick }: { tick: number }) =>
        useLiveQuery<Ticket>({ table: "tickets", order: { _id: "desc" } }),
      { initialProps: { tick: 0 }, wrapper: wrap(client) },
    );

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(listCalls).toBe(1);

    rerender({ tick: 1 });
    rerender({ tick: 2 });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(listCalls).toBe(1);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("inline predicate object does not churn refetches across renders", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listCalls = 0;
    m.on("GET", "/v1/t/tickets", () => {
      listCalls += 1;
      return okEnvelope([]);
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { rerender, result, unmount } = renderHook(
      // New `{}` literal every render — must NOT trigger a refetch.
      ({ tick: _tick }: { tick: number }) => useLiveQuery<Ticket>({ table: "tickets", where: {} }),
      { initialProps: { tick: 0 }, wrapper: wrap(client) },
    );

    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(listCalls).toBe(1);

    rerender({ tick: 1 });
    rerender({ tick: 2 });
    rerender({ tick: 3 });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(listCalls).toBe(1);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });
});
