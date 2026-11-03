import {
  type BaerlyError,
  createCurrentJson,
  decodeJsonBytes,
  type LogEntry,
  MemoryStorage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { S3HttpStorage } from "../../packages/adapter-node/src/s3-http.ts";
import { Writer } from "../../packages/server/src/writer.ts";
import { logStateCurrentJson } from "../fixtures/log-state.ts";

const CURRENT_KEY = "app/test/tenant/t/manifests/tickets/current.json";
const LOG_KEY = "app/test/tenant/t/manifests/tickets/log/0.json";

describe("Writer fate across S3 adapter retries", () => {
  test.each(["lost-ack-then-denied", "missing-etag"] as const)(
    "%s adopts the durable own entry even without a visible NetworkError",
    async (fault) => {
      const bucket = new MemoryStorage();
      await createCurrentJson(bucket, CURRENT_KEY, logStateCurrentJson());
      let logPutAttempts = 0;
      const fakeFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const key = decodeURIComponent(new URL(request.url).pathname.slice("/b/".length));
        if (request.method === "GET") {
          const stored = await bucket.get(key);
          return stored === null
            ? new Response(null, { status: 404 })
            : new Response(stored.body as BodyInit, { headers: { ETag: stored.etag } });
        }
        if (request.method !== "PUT" || key !== LOG_KEY) {
          throw new Error(`unexpected ${request.method} ${key}`);
        }
        logPutAttempts++;
        if (logPutAttempts > 1) {
          return new Response(null, { status: 403 });
        }
        await bucket.put(key, new Uint8Array(await request.arrayBuffer()), { ifNoneMatch: "*" });
        if (fault === "lost-ack-then-denied") {
          throw new TypeError("durable create acknowledgement lost");
        }
        return new Response(null, { status: 200 });
      };
      const writer = new Writer({
        storage: new S3HttpStorage({
          endpoint: "https://example.invalid",
          bucket: "b",
          fetch: fakeFetch,
          retries: 1,
          backoffMs: 0,
        }),
        currentJsonKey: CURRENT_KEY,
      });
      await expect(
        writer.commit({ op: "I", collection: "tickets", docId: "one", body: { _id: "one" } }),
      ).resolves.toMatchObject({ entry: { seq: 0, doc_id: "one" } });
      // The adapter reports its post-retry 403 as NetworkError, so Writer
      // resends; that 403 follows an uncertain send and resolves by readback.
      expect(logPutAttempts).toBe(fault === "lost-ack-then-denied" ? 3 : 1);
    },
  );

  test.each(["unavailable", "malformed"] as const)(
    "an internal lost-ack retry ending in 412 and %s readback remains ambiguous",
    async (readback) => {
      const bucket = new MemoryStorage();
      await createCurrentJson(bucket, CURRENT_KEY, logStateCurrentJson());
      let logPutAttempts = 0;
      let unresolvedReadbacks = 0;
      const fakeFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const key = decodeURIComponent(new URL(request.url).pathname.slice("/b/".length));
        if (request.method === "GET") {
          if (key === LOG_KEY && logPutAttempts > 0) {
            unresolvedReadbacks++;
            if (readback === "unavailable") {
              throw new TypeError("occupant fetch unavailable");
            }
            return new Response("{broken-json", { status: 200, headers: { ETag: "corrupt" } });
          }
          const stored = await bucket.get(key);
          return stored === null
            ? new Response(null, { status: 404 })
            : new Response(stored.body as BodyInit, { headers: { ETag: stored.etag } });
        }
        if (request.method !== "PUT") {
          throw new Error(`unexpected ${request.method}`);
        }
        const body = new Uint8Array(await request.arrayBuffer());
        if (key === LOG_KEY) {
          logPutAttempts++;
          if (logPutAttempts === 1) {
            await bucket.put(key, body, { ifNoneMatch: "*" });
            throw new TypeError("durable create acknowledgement lost");
          }
        }
        try {
          const stored = await bucket.put(
            key,
            body,
            request.headers.get("If-None-Match") === "*" ? { ifNoneMatch: "*" } : {},
          );
          return new Response(null, { status: 200, headers: { ETag: stored.etag } });
        } catch (error) {
          if ((error as BaerlyError).code === "WriteConflict") {
            return new Response(null, { status: 412 });
          }
          throw error;
        }
      };
      const storage = new S3HttpStorage({
        endpoint: "https://example.invalid",
        bucket: "b",
        fetch: fakeFetch,
        retries: 1,
        backoffMs: 0,
      });
      const writer = new Writer({
        storage,
        currentJsonKey: CURRENT_KEY,
        options: { maxRetries: 1, initialBackoffMs: 0 },
      });
      const failure: unknown = await writer
        .commit({ op: "I", collection: "tickets", docId: "one", body: { _id: "one" } })
        .catch((error: unknown) => error);

      // Writer saw a single Storage.put reject with 412; the adapter's
      // hidden first HTTP attempt already committed the same entry.
      expect(logPutAttempts).toBe(2);
      // An unavailable readback is retried once on Writer's transient budget,
      // and each read spends the adapter's own retry.
      expect(unresolvedReadbacks).toBe(readback === "unavailable" ? 4 : 1);
      const durable = await bucket.get(LOG_KEY);
      expect(durable).not.toBeNull();
      expect(decodeJsonBytes<LogEntry>(durable!.body)).toMatchObject({
        seq: 0,
        doc_id: "one",
        after: { _id: "one" },
      });
      expect(failure).toMatchObject({ code: "AmbiguousCommit", retriable: false });
    },
  );
});

describe("Writer under S3 throttling", () => {
  test.each([
    [429, "", "NetworkError"],
    [503, "<Error><Code>SlowDown</Code></Error>", "NetworkError"],
    // A 503 that is not a documented throttle may have been applied.
    [503, "<Error><Code>ServiceUnavailable</Code></Error>", "AmbiguousCommit"],
  ] as const)("every log create answered %i %s surfaces %s", async (status, body, code) => {
    const bucket = new MemoryStorage();
    await createCurrentJson(bucket, CURRENT_KEY, logStateCurrentJson());
    let logPutAttempts = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const key = decodeURIComponent(new URL(request.url).pathname.slice("/b/".length));
      if (request.method === "GET") {
        const stored = await bucket.get(key);
        return stored === null
          ? new Response(null, { status: 404 })
          : new Response(stored.body as BodyInit, { headers: { ETag: stored.etag } });
      }
      if (request.method !== "PUT" || key !== LOG_KEY) {
        throw new Error(`unexpected ${request.method} ${key}`);
      }
      logPutAttempts++;
      return new Response(body, { status });
    };
    const writer = new Writer({
      storage: new S3HttpStorage({
        endpoint: "https://example.invalid",
        bucket: "b",
        fetch: fakeFetch,
        retries: 1,
        backoffMs: 0,
      }),
      currentJsonKey: CURRENT_KEY,
      options: { maxRetries: 1, initialBackoffMs: 0 },
    });
    await expect(
      writer.commit({ op: "I", collection: "tickets", docId: "one", body: { _id: "one" } }),
    ).rejects.toMatchObject({ code, retriable: code === "NetworkError" });
    // Two Writer sends, each spending the adapter's one internal retry.
    expect(logPutAttempts).toBe(4);
  });
});
