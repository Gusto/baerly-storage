// @vitest-environment happy-dom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { useInvalidationTick } from "./index.ts";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("useInvalidationTick", () => {
  test("advances when /v1/since returns a non-empty batch", async () => {
    const pendingRejects: Array<(e: unknown) => void> = [];
    let polls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      polls += 1;
      if (polls === 1) {
        return jsonResponse({
          events: [
            {
              lsn: "a_b_01",
              op: "I",
              collection: "tickets",
              doc_id: "x",
              schema_version: 0,
              session: "s",
              seq: 0,
              commit_ts: "",
            },
          ],
          next_cursor: "a_b_01",
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        pendingRejects.push(reject);
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { result, unmount } = renderHook(() => useInvalidationTick(client, "tickets"));
    expect(result.current).toBe(0);
    await waitFor(() => expect(result.current).toBe(1));
    unmount();
    for (const r of pendingRejects) {
      r(new Error("test teardown"));
    }
  });

  test("does not poll when enabled=false", async () => {
    let polls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      polls += 1;
      return jsonResponse({ events: [], next_cursor: "" });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { result, unmount } = renderHook(() =>
      useInvalidationTick(client, "tickets", { enabled: false }),
    );
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(polls).toBe(0);
    expect(result.current).toBe(0);
    unmount();
  });

  test("idle response (empty batch, same cursor) does not advance tick", async () => {
    const pendingRejects: Array<(e: unknown) => void> = [];
    let polls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      polls += 1;
      if (polls === 1) {
        return jsonResponse({
          events: [
            {
              lsn: "a_b_01",
              op: "I",
              collection: "tickets",
              doc_id: "x",
              schema_version: 0,
              session: "s",
              seq: 0,
              commit_ts: "",
            },
          ],
          next_cursor: "a_b_01",
        });
      }
      if (polls === 2) {
        return jsonResponse({ events: [], next_cursor: "a_b_01" });
      }
      return new Promise<Response>((_resolve, reject) => {
        pendingRejects.push(reject);
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { result, unmount } = renderHook(() => useInvalidationTick(client, "tickets"));
    await waitFor(() => expect(result.current).toBe(1));
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(3));
    expect(result.current).toBe(1);
    unmount();
    for (const r of pendingRejects) {
      r(new Error("test teardown"));
    }
  });

  test("matchEvent filters which batches advance the tick", async () => {
    const pendingRejects: Array<(e: unknown) => void> = [];
    const cursorsRequested: string[] = [];
    let polls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      polls += 1;
      const url = new URL(req.url);
      cursorsRequested.push(url.searchParams.get("cursor") ?? "");
      if (polls === 1) {
        return jsonResponse({
          events: [
            {
              lsn: "a_b_01",
              op: "I",
              collection: "tickets",
              doc_id: "other",
              schema_version: 0,
              session: "s",
              seq: 1,
              commit_ts: "",
            },
          ],
          next_cursor: "a_b_01",
        });
      }
      if (polls === 2) {
        return jsonResponse({
          events: [
            {
              lsn: "a_b_02",
              op: "U",
              collection: "tickets",
              doc_id: "target",
              schema_version: 0,
              session: "s",
              seq: 2,
              commit_ts: "",
            },
          ],
          next_cursor: "a_b_02",
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        pendingRejects.push(reject);
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { result, unmount } = renderHook(() =>
      useInvalidationTick(client, "tickets", {
        matchEvent: (e) => e.doc_id === "target",
      }),
    );
    // The "target" batch matches and bumps the tick to 1. The
    // "other" batch (poll #1) did not advance the tick, but it
    // DID advance the cursor — poll #2 carried cursor "a_b_01",
    // proving the unmatched branch still updates internal state.
    await waitFor(() => expect(result.current).toBe(1));
    expect(cursorsRequested[0]).toBe("");
    expect(cursorsRequested[1]).toBe("a_b_01");
    unmount();
    for (const r of pendingRejects) {
      r(new Error("test teardown"));
    }
  });

  test("cursor persists across enabled false→true toggle", async () => {
    const pendingRejects: Array<(e: unknown) => void> = [];
    const cursorsRequested: string[] = [];
    let polls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", (req) => {
      polls += 1;
      const url = new URL(req.url);
      cursorsRequested.push(url.searchParams.get("cursor") ?? "");
      if (polls === 1) {
        return jsonResponse({
          events: [
            {
              lsn: "a_b_01",
              op: "I",
              collection: "tickets",
              doc_id: "x",
              schema_version: 0,
              session: "s",
              seq: 1,
              commit_ts: "",
            },
          ],
          next_cursor: "a_b_01",
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        pendingRejects.push(reject);
        req.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { rerender, result, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useInvalidationTick(client, "tickets", { enabled }),
      { initialProps: { enabled: true } },
    );
    // First poll advances the cursor to "a_b_01" and bumps the tick.
    await waitFor(() => expect(result.current).toBe(1));
    expect(cursorsRequested[0]).toBe("");
    // Disable; the second poll (which was hung) aborts.
    rerender({ enabled: false });
    // Re-enable; the loop restarts.
    rerender({ enabled: true });
    // The next poll must use the preserved cursor, not the initial
    // empty-string. With the pre-fix loop-local `currentCursor =
    // since;` seed, this would have been "".
    await waitFor(() => expect(cursorsRequested.length).toBeGreaterThanOrEqual(3));
    expect(cursorsRequested[cursorsRequested.length - 1]).toBe("a_b_01");
    unmount();
    for (const r of pendingRejects) {
      r(new Error("test teardown"));
    }
  });

  test("aborts in-flight request on unmount", async () => {
    let abortedOnce = false;
    let pendingReject: ((e: unknown) => void) | undefined;
    const mock = new MockFetch();
    mock.on(
      "GET",
      "/v1/since",
      (req) =>
        new Promise<Response>((_resolve, reject) => {
          pendingReject = reject;
          req.signal.addEventListener(
            "abort",
            () => {
              abortedOnce = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { unmount } = renderHook(() => useInvalidationTick(client, "tickets"));
    await waitFor(() => expect(pendingReject).toBeDefined());
    unmount();
    await waitFor(() => expect(abortedOnce).toBe(true));
    pendingReject?.(new Error("test teardown"));
  });
});
