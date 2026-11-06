// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { BaerlyProvider } from "./provider.ts";
import { poolFor } from "./subscription-pool.ts";
import { useQuery } from "./use-query.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const pending = (retryAfter: number): Response =>
  json(
    { error: { code: "MaintenancePending", message: "busy", retriable: true, retryAfter } },
    503,
  );

const wrap =
  (client: ReturnType<typeof createBaerlyClient>) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(BaerlyProvider, { client }, children);

const installQuietPoll = (mock: MockFetch): void => {
  mock.on("GET", "/v1/since", () => new Promise<Response>(() => {}));
};

const flush = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("useQuery abort", () => {
  test("a superseded query whose GET keeps failing stops requesting at the abort", async () => {
    const mock = new MockFetch();
    installQuietPoll(mock);
    const calls: Array<string> = [];
    mock.on("GET", "/v1/c/notes", (req) => {
      calls.push(new URL(req.url).search);
      return new Response("bad gateway", { status: 502 });
    });
    mock.on("GET", "/v1/c/other", () => json({ data: [], _meta: {} }));
    vi.useFakeTimers();
    try {
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
      const { rerender, unmount } = renderHook(
        ({ which }: { which: string }) => useQuery((c) => c.collection(which).all(), [which]),
        { wrapper: wrap(client), initialProps: { which: "notes" } },
      );
      await flush();
      expect(calls).toHaveLength(1);

      rerender({ which: "other" });
      await flush();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(calls).toHaveLength(1);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  test("unmounting cancels a pending MaintenancePending retry wait", async () => {
    const mock = new MockFetch();
    installQuietPoll(mock);
    let calls = 0;
    mock.on("GET", "/v1/c/notes", () => {
      calls += 1;
      return pending(5);
    });
    vi.useFakeTimers();
    try {
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
      const { unmount } = renderHook(() => useQuery((c) => c.collection("notes").all(), []), {
        wrapper: wrap(client),
      });
      await flush();
      expect(calls).toBe(1);
      unmount();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(calls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an abort leaves no error state and the next query still loads", async () => {
    const mock = new MockFetch();
    installQuietPoll(mock);
    mock.on("GET", "/v1/c/notes", () => pending(5));
    mock.on("GET", "/v1/c/other", () => json({ data: [{ _id: "x" }], _meta: {} }));
    vi.useFakeTimers();
    try {
      const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
      const { result, rerender } = renderHook(
        ({ which }: { which: string }) => useQuery((c) => c.collection(which).all(), [which]),
        { wrapper: wrap(client), initialProps: { which: "notes" } },
      );
      await flush();
      rerender({ which: "other" });
      await flush();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(result.current.status).toBe("ok");
      expect(result.current.error).toBeUndefined();
      expect(result.current.data).toEqual([{ _id: "x" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subscription pool abort", () => {
  test("a shared fetch is aborted only when the last subscriber detaches", async () => {
    const mock = new MockFetch();
    installQuietPoll(mock);
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const pool = poolFor(client);
    const signals: Array<AbortSignal> = [];
    const fetcher = (signal: AbortSignal): Promise<unknown> => {
      signals.push(signal);
      return new Promise(() => {});
    };
    const detachA = pool.attach("sig", [], new Set(), fetcher, () => {});
    const detachB = pool.attach("sig", [], new Set(), fetcher, () => {});
    expect(signals).toHaveLength(1);
    detachA();
    expect(signals[0]?.aborted).toBe(false);
    detachB();
    expect(signals[0]?.aborted).toBe(true);
  });
});
