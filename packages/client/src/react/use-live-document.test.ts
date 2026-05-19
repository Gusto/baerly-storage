// @vitest-environment happy-dom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { JSONArraylessObject } from "@baerly/protocol";
import { createBaerlyClient } from "../client.ts";
import { MockFetch } from "../testing/index.ts";
import { useLiveDocument } from "./use-live-document.ts";

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

interface Ticket extends JSONArraylessObject {
  readonly _id: string;
  readonly title: string;
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

describe("useLiveDocument", () => {
  test("performs initial read and returns the row", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    m.on("GET", "/v1/t/tickets", () => okEnvelope([{ _id: "a", title: "hello" }]));
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveDocument<Ticket>(client, "tickets", "a"));

    await waitFor(() => {
      expect(result.current).toEqual({ status: "ok", row: { _id: "a", title: "hello" } });
    });

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("returns status=missing when the server has no match", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    m.on("GET", "/v1/t/tickets", () => okEnvelope([]));
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveDocument<Ticket>(client, "tickets", "x"));

    await waitFor(() => expect(result.current.status).toBe("missing"));

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("refetches when a matching event arrives, ignores events for other rows", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listCalls = 0;
    m.on("GET", "/v1/t/tickets", () => {
      listCalls += 1;
      if (listCalls === 1) {
        return okEnvelope([{ _id: "a", title: "v1" }]);
      }
      return okEnvelope([{ _id: "a", title: "v2" }]);
    });
    let sincePoll = 0;
    m.on("GET", "/v1/since", (req) => {
      sincePoll += 1;
      if (sincePoll === 1) {
        // First batch: an event for a DIFFERENT row. Must not refetch.
        return sinceResponse({
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
      if (sincePoll === 2) {
        // Second batch: an event for OUR row. Must refetch.
        return sinceResponse({
          events: [
            {
              lsn: "a_b_02",
              op: "U",
              collection: "tickets",
              doc_id: "a",
              schema_version: 0,
              session: "s",
              seq: 2,
              commit_ts: "",
            },
          ],
          next_cursor: "a_b_02",
        });
      }
      return hangSince(req);
    });

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { result, unmount } = renderHook(() => useLiveDocument<Ticket>(client, "tickets", "a"));

    await waitFor(() => {
      expect(result.current).toEqual({ status: "ok", row: { _id: "a", title: "v2" } });
    });
    expect(listCalls).toBe(2);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("idle /v1/since response does not refetch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    let listCalls = 0;
    m.on("GET", "/v1/t/tickets", () => {
      listCalls += 1;
      return okEnvelope([{ _id: "a", title: "v1" }]);
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
    const { result, unmount } = renderHook(() => useLiveDocument<Ticket>(client, "tickets", "a"));

    await waitFor(() => expect(result.current.status).toBe("ok"));
    await waitFor(() => expect(sincePoll).toBeGreaterThanOrEqual(2));
    expect(listCalls).toBe(1);

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });

  test("id change triggers a refetch", async () => {
    const { m, pendingSinceRejects, hangSince } = makeMock();
    const seenIds: string[] = [];
    m.on("GET", "/v1/t/tickets", (req) => {
      const url = new URL(req.url);
      const where = JSON.parse(url.searchParams.get("where") ?? "{}") as { _id?: string };
      seenIds.push(where._id ?? "");
      return okEnvelope([{ _id: where._id ?? "?", title: "x" }]);
    });
    m.on("GET", "/v1/since", hangSince);

    const client = createBaerlyClient({ baseUrl: "http://x", fetch: m.fetch });
    const { rerender, unmount } = renderHook(
      ({ id }: { id: string }) => useLiveDocument<Ticket>(client, "tickets", id),
      { initialProps: { id: "a" } },
    );

    await waitFor(() => expect(seenIds).toContain("a"));
    rerender({ id: "b" });
    await waitFor(() => expect(seenIds).toContain("b"));

    unmount();
    for (const r of pendingSinceRejects) {
      r(new Error("test teardown"));
    }
  });
});
