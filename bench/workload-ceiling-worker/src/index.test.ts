import { describe, expect, test } from "vitest";
import worker, { type WorkloadCeilingWorkerEnv } from "./index.ts";

// The env cast is safe on every path under test: the 401 guard returns
// before `env.BUCKET` is ever read, and the 400 path (decode failure)
// returns before it too — no real R2 binding is needed.
const env = (sharedSecret: string | undefined): WorkloadCeilingWorkerEnv =>
  ({ WORKLOAD_CEILING_SHARED_SECRET: sharedSecret }) as unknown as WorkloadCeilingWorkerEnv;

// Node's `Request` normalizes trailing HTTP whitespace off header values, so
// a literal `Authorization: Bearer ` (empty token) cannot be constructed
// through the real constructor — it collapses to `Bearer` (token `null`).
// The fail-open bug under test is specifically the RAW empty-token header
// reaching `constantTimeEqual("", <unset secret>)` as equal-empty-bytes, so
// these requests carry a hand-rolled headers view that preserves the exact
// bytes. Everything else the handler touches (`method`, `url`, `text`) is a
// plain value on the duck-typed object.
const postRun = (authorization: string, body = "not-json"): Request =>
  ({
    method: "POST",
    url: "https://study.example/run",
    headers: {
      get: (name: string): string | null => (name === "authorization" ? authorization : null),
    },
    text: () => Promise.resolve(body),
  }) as unknown as Request;

describe("POST /run authentication fails closed", () => {
  test("a missing secret rejects an empty bearer token", async () => {
    // The operator forgot `wrangler secret put`: the binding is absent, and
    // `constantTimeEqual("", undefined)` compares zero bytes to zero bytes —
    // equal. The handler must reject before that compare is reached.
    const response = await worker.fetch(postRun("Bearer "), env(undefined));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  test("a missing secret rejects a real-looking token", async () => {
    const response = await worker.fetch(postRun("Bearer real-looking-token"), env(undefined));
    expect(response.status).toBe(401);
  });

  test("a blank secret rejects even a matching blank token", async () => {
    const response = await worker.fetch(postRun("Bearer  "), env("  "));
    expect(response.status).toBe(401);
  });

  test("a set secret with the correct token still reaches request decoding", async () => {
    // Pins that the fail-closed guard did not overfire: correct secret +
    // token gets PAST auth and dies on the garbage body with 400, not 401.
    const response = await worker.fetch(
      postRun("Bearer real-secret", "garbage"),
      env("real-secret"),
    );
    expect(response.status).toBe(400);
  });
});
