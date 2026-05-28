/**
 * Tests for `createApp` — the Hono-app factory layered on top of
 * `createFetchHandler`. Verifies the public shape, the cascade
 * end-to-end via `app.fetch(new Request(...))`, and that the
 * kernel router's defence-in-depth body-size check surfaces the
 * 413 envelope through the cascade.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  MemoryStorage,
  type Verifier,
  createCurrentJson,
} from "@baerly/protocol";
import { Hono } from "hono/tiny";
import { describe, expect, test } from "vitest";
import { createApp } from "./app.ts";

const provision = async (storage: MemoryStorage, tenant: string, table: string): Promise<void> => {
  await createCurrentJson(storage, `app/t/tenant/${tenant}/manifests/${table}/current.json`, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "app-test", claimed_at: "" },
  });
};

describe("createApp", () => {
  test("returns a Hono instance with a fetch handler", () => {
    const storage = new MemoryStorage();
    const verifier: Verifier = async () => ({ tenantPrefix: "acme", identity: {} });
    const app = createApp({ app: "t", storage, verifier });
    expect(app).toBeInstanceOf(Hono);
    expect(typeof app.fetch).toBe("function");
  });

  test("cascade end-to-end: GET /v1/healthz returns {ok:true}", async () => {
    const storage = new MemoryStorage();
    const verifier: Verifier = async () => ({ tenantPrefix: "acme", identity: {} });
    const app = createApp({ app: "t", storage, verifier });

    const res = await app.fetch(new Request("http://localhost/v1/healthz"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  test("cascade end-to-end: GET /v1/c/:collection runs through the verifier + router", async () => {
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const app = createApp({ app: "t", storage, verifier });

    const res = await app.fetch(
      new Request("http://localhost/v1/c/c", {
        headers: { authorization: "Bearer dev" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("oversized content-length POST returns 413 via the kernel's defence-in-depth", async () => {
    // The cutover dropped the Node-side body-cap middleware (it
    // raced with `@hono/node-server`'s `incoming` reader). The
    // kernel router's own length check (`router.ts:464-501`)
    // surfaces 413 through the cascade's error envelope, matching
    // the cloudflare adapter's posture.
    const storage = new MemoryStorage();
    const tenant = "acme";
    await provision(storage, tenant, "c");
    const verifier: Verifier = async () => ({ tenantPrefix: tenant, identity: {} });
    const app = createApp({ app: "t", storage, verifier });

    // 1 MiB cap + 1 → 413. We send the body too so fetch() doesn't
    // complain about content-length mismatch; Node fetch will pad
    // to match the header value.
    const size = (1 << 20) + 1;
    const body = new Uint8Array(size);
    const res = await app.fetch(
      new Request("http://localhost/v1/c/c", {
        method: "POST",
        headers: {
          authorization: "Bearer dev",
          "content-type": "application/json",
          "content-length": String(size),
        },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("PayloadTooLarge");
  });
});
