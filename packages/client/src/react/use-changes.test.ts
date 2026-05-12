// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createBaerlyClient } from "../client";
import { MockFetch } from "../testing";
import { useChanges } from "./index";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const flush = async (ms = 50): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms));
};

describe("useChanges", () => {
  test("polls /v1/since and surfaces events", async () => {
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
      // After the first batch lands, hang the next poll so the hook
      // doesn't tight-loop us into OOM. The test unmounts before it
      // asserts the second poll lands; the unmount aborts this
      // request via the merged signal.
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
    const { result, unmount } = renderHook(() => useChanges(client, "tickets"));
    await act(async () => {
      await flush();
    });
    expect(result.current.events).toHaveLength(1);
    expect(result.current.cursor).toBe("a_b_01");
    unmount();
    for (const r of pendingRejects) r(new Error("test teardown"));
  });

  test("does not poll when enabled=false", async () => {
    let polls = 0;
    const mock = new MockFetch();
    mock.on("GET", "/v1/since", () => {
      polls += 1;
      return jsonResponse({ events: [], next_cursor: "" });
    });
    const client = createBaerlyClient({ baseUrl: "http://x", fetch: mock.fetch });
    const { result, unmount } = renderHook(() => useChanges(client, "tickets", { enabled: false }));
    await act(async () => {
      await flush();
    });
    expect(polls).toBe(0);
    expect(result.current.events).toEqual([]);
    unmount();
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
    const { unmount } = renderHook(() => useChanges(client, "tickets"));
    await act(async () => {
      await flush(10);
    });
    unmount();
    await act(async () => {
      await flush(10);
    });
    expect(abortedOnce).toBe(true);
    // Belt-and-braces: if some platform never wires fetch's signal
    // into the inner abort listener (it should, but worker pools
    // have surprised us before), reject the pending promise so the
    // vitest worker exits cleanly.
    pendingReject?.(new Error("test teardown"));
  });
});
